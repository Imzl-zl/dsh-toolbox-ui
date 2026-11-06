#!/usr/bin/env node
// 双宿主矩阵：把本仓库的**源码**复制到一棵独立安装树里，装上指定的那一代 DSH 宿主包，
// 然后在它里面跑全量用例。CI 用两腿（0.2.1-rc.5 / 0.2.2-rc.1）分别验证两代宿主的契约。
//
// 为什么不在仓库自己的 node_modules 上换版本：
//   · `pnpm-lock.yaml` 被 `test/package-contract.test.mjs` 当作"开发基线"的唯一证据，
//     CI 里改一次版本就会把那条断言变成假的；
//   · 两腿必须能并行、互不影响，且**跑在真实安装出来的依赖树**上（junction 复用会掩盖解析问题）。
//
// 用法：
//   node scripts/host-matrix.mjs --host 0.2.1-rc.5
//   node scripts/host-matrix.mjs --host 0.2.2-rc.1 --dir D:/tmp/matrix-rc1 --no-install
//   node scripts/host-matrix.mjs --host 0.2.2-rc.1 --keep        # 保留安装树（排障用）
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// 两代宿主的依赖面（与 package.json 的 devDependencies 一一对应，只换版本）。
const HOSTS = {
  '0.2.1-rc.5': { cordis: '~4.0.5', loader: '~1.0.6', include: '1.0.10', stepToolset: '0' },
  '0.2.2-rc.1': { cordis: '~4.1.0', loader: '~1.1.0', include: '~1.1.0', stepToolset: '1' },
}
const HOST_PACKAGES = [
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-agent-loop',
  '@deepseek-ai/dsh-api-gateway',
  '@deepseek-ai/dsh-app-boot',
  '@deepseek-ai/dsh-atomic-write',
  '@deepseek-ai/dsh-mcp-client',
  '@deepseek-ai/dsh-scope',
  '@deepseek-ai/dsh-skill',
  '@deepseek-ai/dsh-skill-filesystem',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-typert-loader',
  '@deepseek-ai/dsh-typert-protocol',
]
// 只复制跑测试需要的东西。`node_modules` / `.git` 不复制（安装树自己装）。
const COPY = ['lib', 'test', 'scripts', 'docs', '.tasks', '.github', 'cordis.patch.yml', 'README.md', 'README.en.md', 'LICENSE']

function parseArgs(argv) {
  const args = { keep: false, install: true }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--keep') args.keep = true
    else if (token === '--no-install') args.install = false
    else if (token === '--host') args.host = argv[++index]
    else if (token === '--dir') args.dir = argv[++index]
    else if (token === '--cordis') args.cordis = argv[++index]
    else if (token === '--loader') args.loader = argv[++index]
    else if (token === '--include') args.include = argv[++index]
    else if (token === '--timeout') args.timeout = argv[++index]
    else throw new Error(`未知参数：${token}`)
  }
  return args
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32', ...options })
  if (result.error) throw result.error
  return result.status ?? 1
}

const args = parseArgs(process.argv.slice(2))
const host = args.host
if (!host) throw new Error('必须给 --host <版本>（例如 0.2.1-rc.5 或 0.2.2-rc.1）')
const preset = HOSTS[host]
if (!preset) throw new Error(`未知宿主版本 ${host}；已知：${Object.keys(HOSTS).join(' / ')}`)
const cordis = args.cordis ?? preset.cordis
const loader = args.loader ?? preset.loader
const include = args.include ?? preset.include
const dir = resolve(args.dir ?? join(tmpdir(), `dsh-host-matrix-${host.replaceAll('.', '_')}`))

console.log(JSON.stringify({ dir, host, cordis, loader, include, install: args.install }))
if (args.install) {
  await rm(dir, { recursive: true, force: true })
}
await mkdir(dir, { recursive: true })
for (const name of COPY) {
  await cp(join(ROOT, name), join(dir, name), { recursive: true, force: true })
}
// package.json：把开发基线的版本换成这一腿的目标版本（其余字段原样），并把 `files` 之外的东西
// 也带上——测试要读它来断言窗口与脚本。
const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
manifest.devDependencies = { ...manifest.devDependencies }
for (const name of HOST_PACKAGES) manifest.devDependencies[name] = host
manifest.devDependencies['@deepseek-ai/cordis'] = cordis
manifest.devDependencies['@deepseek-ai/cordis-plugin-loader'] = loader
manifest.devDependencies['@deepseek-ai/cordis-plugin-include'] = include
manifest.devDependencies = Object.fromEntries(Object.entries(manifest.devDependencies).sort(([left], [right]) => left.localeCompare(right)))
await writeFile(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
// pnpm 的供应链策略与仓库一致（不复制 lock：这一腿自己解一份）。
await cp(join(ROOT, 'pnpm-workspace.yaml'), join(dir, 'pnpm-workspace.yaml')).catch(() => {})

if (args.install) {
  const status = run('pnpm', ['install', '--no-frozen-lockfile'], { cwd: dir })
  if (status !== 0) {
    console.error(`✖ pnpm install 失败（退出码 ${status}）`)
    process.exit(status)
  }
}

const env = {
  ...process.env,
  // 这一腿断言的宿主代次：测试用它在**加载期**断言"跑到的确实是目标那一代"，
  // 而不是靠 skip 把另一代的用例跳过去（见 test/tool-search-real-host.test.mjs）。
  DSH_EXPECT_STEP_TOOLSET: preset.stepToolset,
  // package.json 的开发基线在这一腿里就是 host：让契约用例断言"它等于本腿目标"，
  // 而不是硬编码 0.2.1-rc.5（那样这一腿必红，只能靠跳过它变绿）。
  DSH_HOST_MATRIX_BASELINE: host,
  // 安装树里的宿主包是完整元包，lockfile 与"只声明自己用到的那些"不是一回事；
  // 这一条在矩阵腿里按已知容忍处理，但**原因写在报告里**（见 docs/design.md）。
  DSH_HOST_MATRIX: '1',
}
const timeout = args.timeout ? ['--test-timeout=' + args.timeout] : ['--test-timeout=60000']
const status = run(process.execPath, ['--test', ...timeout], { cwd: dir, env })
if (!args.keep && status === 0) {
  // 只有成功时才清理：失败留现场供排障（CI 的日志会指出 dir）。
  await rm(dir, { recursive: true, force: true }).catch(() => {})
}
process.exit(status)
