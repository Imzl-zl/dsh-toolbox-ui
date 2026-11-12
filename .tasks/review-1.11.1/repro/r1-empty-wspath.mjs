// R1 复现：空 wsPath 在 Windows 上解析成宿主进程 cwd，写路径的守卫不触发。
//
// 用法：在**隔离工作树根目录**执行
//   node <repo>/.tasks/review-1.11.1/repro/r1-empty-wspath.mjs
// 期望（修复前）：
//   canonicalWorkspacePath("") => <cwd>
//   RPC result                 => "applied"
//   wrote cwd/.dsh/mcp.json?   => true
// 期望（修复后）：
//   RPC threw                  => 缺少 workspace 路径
//   wrote cwd/.dsh/mcp.json?   => false
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const cwd = process.cwd()
const lib = (name) => import(pathToFileURL(join(cwd, 'lib', name)).href)

const { canonicalWorkspacePath } = await lib('workspace-runtime.js')
const { McpManagerGateway } = await lib('index.js')

// 最小宿主替身：profile patch 定位靠 include 条目，工作区注册表让它认得 cwd。
const root = await mkdtemp(join(tmpdir(), 'r1-fixture-'))
const rootConfig = join(root, 'cordis.yml')
await writeFile(rootConfig, '[]\n')
await writeFile(join(root, 'cordis.patch.yml'), '[]\n')
const ctx = {
  loader: { entries: () => [{ options: { id: 'include', name: 'cordis:include', config: { path: pathToFileURL(rootConfig).href } } }] },
  tools: { schemas: () => [] },
  logger: { warn() {}, error() {}, info() {} },
  get: (name) => (name === 'workspaceRegistry' ? { list: () => [{ path: cwd }] } : undefined),
}

const target = join(cwd, '.dsh', 'mcp.json')
if (existsSync(target)) {
  console.log('跳过：cwd 已有 .dsh/mcp.json（避免误删用户文件）')
  process.exit(0)
}

console.log('canonicalWorkspacePath("") =>', JSON.stringify(canonicalWorkspacePath('')))
console.log('cwd                        =>', JSON.stringify(cwd))

try {
  const result = await McpManagerGateway.prototype.addWorkspaceServer.call(
    { ctx },
    { wsPath: '', spec: { name: 'review-probe', transport: 'stdio', command: 'node' } },
  )
  console.log('RPC result                 =>', JSON.stringify(result?.persisted ?? result).slice(0, 120))
} catch (error) {
  console.log('RPC threw                  =>', error.message)
} finally {
  const wrote = existsSync(target)
  console.log('wrote cwd/.dsh/mcp.json?   =>', wrote)
  if (wrote) {
    console.log('content                    =>', readFileSync(target, 'utf8').replace(/\s+/g, ' ').slice(0, 160))
    rmSync(join(cwd, '.dsh'), { recursive: true, force: true })
  }
  rmSync(root, { recursive: true, force: true })
}
