import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'
import test from 'node:test'

const execFileAsync = promisify(execFile)
const projectRoot = new URL('..', import.meta.url)
const dshHostPackages = [
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-agent-loop',
  '@deepseek-ai/dsh-atomic-write',
  '@deepseek-ai/dsh-mcp-client',
  '@deepseek-ai/dsh-scope',
  '@deepseek-ai/dsh-skill',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-typert-protocol',
]
// 与 package-contract 的兼容窗口一致：只支持 0.2.x（ToolSearch 依赖 per-agent 呈现模式、
// `tools:sdk` 手册段与会话投影三样 0.2 才有的接口）。
const COMPAT_WINDOW = '>=0.2.0-rc.1 <0.3.0'

function tarString(buffer, offset, length) {
  const end = buffer.indexOf(0, offset)
  return buffer.subarray(offset, end < 0 || end > offset + length ? offset + length : end).toString('utf8')
}

function tarEntries(buffer) {
  const entries = []
  for (let offset = 0; offset + 512 <= buffer.length;) {
    const header = buffer.subarray(offset, offset + 512)
    const name = tarString(header, 0, 100)
    if (!name) break
    const prefix = tarString(header, 345, 155)
    const path = prefix ? `${prefix}/${name}` : name
    const size = Number.parseInt(tarString(header, 124, 12).trim() || '0', 8)
    const type = String.fromCharCode(header[156] || 0)
    const dataOffset = offset + 512
    entries.push({ path, type, data: buffer.subarray(dataOffset, dataOffset + size) })
    offset = dataOffset + Math.ceil(size / 512) * 512
  }
  return entries
}

async function npmPack(packDir) {
  const cwd = fileURLToPath(projectRoot)
  const args = ['pack', '--json', '--pack-destination', packDir]
  if (process.platform !== 'win32') return execFileAsync('npm', args, { cwd, windowsHide: true })
  return execFileAsync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'npm', ...args], { cwd, windowsHide: true })
}

async function linkPackage(nodeModules, name) {
  const source = await realpath(new URL(`../node_modules/${name}`, import.meta.url))
  const target = join(nodeModules, ...name.split('/'))
  await mkdir(dirname(target), { recursive: true })
  await symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir')
}

test('packed artifact resolves required DSH peers from the host fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mcp-artifact-'))
  try {
    const packDir = join(root, 'pack')
    await mkdir(packDir)
    const { stdout } = await npmPack(packDir)
    const [{ filename }] = JSON.parse(stdout)
    const archive = gunzipSync(await readFile(join(packDir, filename)))
    const entries = tarEntries(archive)
    const packageRoot = join(root, 'profiles', 'web', 'node_modules', 'dsh-toolbox-ui')

    for (const entry of entries) {
      if (entry.type !== '0' && entry.type !== '\0') continue
      assert.match(entry.path, /^package\//)
      const relativePath = entry.path.slice('package/'.length)
      assert.equal(isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes('..'), false)
      const target = join(packageRoot, relativePath)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, entry.data)
    }

    const packedManifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
    assert.equal(packedManifest.version, '1.8.3')
    for (const name of dshHostPackages) {
      assert.equal(packedManifest.dependencies?.[name], undefined)
      assert.equal(packedManifest.optionalDependencies?.[name], undefined)
      assert.equal(packedManifest.peerDependencies?.[name], COMPAT_WINDOW)
      assert.notEqual(packedManifest.peerDependenciesMeta?.[name]?.optional, true)
    }
    const packedText = entries
      .filter((entry) => /\.(?:js|json|md|ya?ml)$/.test(entry.path))
      .map((entry) => entry.data.toString('utf8'))
      .join('\n')
    assert.doesNotMatch(packedText, /(?:0\.1\.0-)?rc\.6/)

    // 发布体积：markdown 文档随包（使用者能读到设计与安装说明），但截图不随包。
    // npm 页面上的图片来自 raw.githubusercontent（实测 5/5 张图正常渲染），
    // 把 956KB 截图带进 tarball 属于白付。
    const paths = entries.map((entry) => entry.path)
    assert.equal(paths.some((path) => path.startsWith('package/docs/images/')), false, '截图不得随包发布')
    assert.ok(paths.includes('package/docs/design.md'), 'docs/design.md 应在包里')
    assert.ok(paths.includes('package/docs/installation.md'), 'docs/installation.md 应在包里')
    assert.ok(paths.includes('package/docs/json-import.md'), 'docs/json-import.md 应在包里')
    // 技能能力面的使用说明：装了插件的用户要能从包里读到它，而不是只能上网找。
    assert.ok(paths.includes('package/docs/skills.md'), 'docs/skills.md 应在包里')
    assert.ok(paths.includes('package/README.md') && paths.includes('package/README.en.md'), '两份 README 都应在包里')
    // scripts/ 与 test/ 是开发期的契约闸门（主题判据 + 令牌清单 + 全部用例），不随包发布：
    // 使用者装到的是预构建的 lib/，跑不到也用不上这些。反过来，plugin 的发布体积一旦混进
    // 它们，说明 files 字段被人放宽了，顺带会把开发期才需要的依赖关系带进用户环境。
    assert.equal(paths.some((path) => path.startsWith('package/scripts/')), false, 'scripts/ 不得随包发布')
    assert.equal(paths.some((path) => path.startsWith('package/test/')), false, 'test/ 不得随包发布')

    const profileModules = join(root, 'profiles', 'web', 'node_modules')
    const hostModules = join(root, 'profiles', 'node_modules')
    await linkPackage(profileModules, 'yaml')
    await linkPackage(profileModules, 'zod')
    // 与 yaml / zod 一样是插件自己声明的运行期依赖（Codex 的 config.toml 是 TOML）：
    // 打包产物必须能从 profile 的 node_modules 解析到它，否则插件加载即失败。
    await linkPackage(profileModules, 'smol-toml')
    for (const name of dshHostPackages) await linkPackage(hostModules, name)
    // 不在 dsh-* 命名空间（版本线不同），但同样从宿主机层解析：
    // reveal 用它把 `!!js` 配置节点求值成有效运行值。真实 DSH_HOME 的
    // profiles/node_modules 里带这个包，已实测确认。
    await linkPackage(hostModules, '@deepseek-ai/cordis-plugin-loader')

    const entry = await import(`${pathToFileURL(join(packageRoot, 'lib', 'index.js')).href}?artifact`)
    assert.equal(typeof entry.default, 'function')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
