// R1 真宿主验证：在隔离工作树里起一个**生产形状**的宿主进程
//（真 cordis Context + 真 Loader + 官方 mountRootInclude 挂的根 Include + 真 ToolRuntime +
//  真 McpManagerGateway 插件实例），通过 ctx.get('mcpManager') 调**宿主注册的那批 Remote 方法**。
//
// 这不等于"再跑一遍单元测试"：单元测试里 gateway 是手搭的 { ctx }，这里是插件在真 Loader 里
// 装配出来的服务对象；typert 的 wire 分发调用的正是同一个对象上的方法。
//
// 用法（cwd = 仓库根，主树或隔离树均可）：node .tasks/review-1.11.1/repro/r1-real-host.mjs
import assert from 'node:assert/strict'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLoaderHost } from '../../../test-support/loader-host.mjs'

const problems = []
const ok = (label, detail = '') => console.log(`✔ ${label}${detail ? ' — ' + detail : ''}`)
const bad = (label, detail) => { problems.push(`${label}: ${detail}`); console.log(`✘ ${label} — ${detail}`) }

// 「解析成宿主进程 cwd」只有在 cwd 是真实存在且可写的目录时才看得出危害。把进程 cwd 换到
// 一个空临时目录：修复前的代码会在这里写出 .dsh/mcp.json，而仓库一个字节都不会被碰。
const hostCwd = await mkdtemp(join(tmpdir(), 'r1-host-cwd-'))
const previousCwd = process.cwd()
process.chdir(hostCwd)
const cwdReal = realpathSync(process.cwd())

const project = await mkdtemp(join(tmpdir(), 'r1-host-proj-'))
await mkdir(project, { recursive: true })
const host = await createLoaderHost('[]\n')
// 真宿主的 workspaceRegistry 是官方 workspace 服务提供的；这里用同样形状的登记表
// （官方 Workspace.path 契约就是 canonical 绝对路径）。不登记 cwd 的话，修复前的调用会被
// "目标未注册"拦住，就看不出「写进了宿主 cwd」这件事。
host.ctx.provide('workspaceRegistry', { list: () => [{ path: cwdReal, title: 'host-cwd' }, { path: project, title: 'proj' }] })

const RPC = (method, payload) => host.manager[method](payload)
const expectReject = async (label, call, pattern) => {
  try {
    const value = await call()
    bad(label, `没有被拒绝，返回 ${JSON.stringify(value).slice(0, 120)}`)
  } catch (error) {
    if (pattern.test(error.message)) ok(label, error.message)
    else bad(label, `错误消息不符：${error.message}`)
  }
}

try {
  console.log(`宿主 cwd = ${cwdReal}`)
  console.log(`真实服务对象 = ${host.manager.constructor.name}\n`)

  // 1) 空 / 空白 / 相对 wsPath：写入口必须先抛，且不得在宿主 cwd 落盘。
  await expectReject('addWorkspaceServer wsPath:""', () => RPC('addWorkspaceServer', {
    wsPath: '', spec: { name: 'r1-probe', transport: 'stdio', command: process.execPath, args: ['--version'] },
  }), /缺少 workspace 路径/)
  await expectReject('addWorkspaceServer wsPath:"   "', () => RPC('addWorkspaceServer', {
    wsPath: '   ', spec: { name: 'r1-probe', transport: 'stdio', command: process.execPath, args: ['--version'] },
  }), /缺少 workspace 路径/)
  await expectReject('addWorkspaceServer wsPath:"relative/proj"', () => RPC('addWorkspaceServer', {
    wsPath: 'relative/proj', spec: { name: 'r1-probe', transport: 'stdio', command: process.execPath, args: ['--version'] },
  }), /必须是绝对路径/)

  // 2) 原本**完全没有守卫**的三个入口（正是这条缺陷漏得最狠的地方）。
  await expectReject('previewWorkspaceImport wsPath:""', () => RPC('previewWorkspaceImport', { wsPath: '', json: { mcpServers: {} } }), /缺少 workspace 路径/)
  await expectReject('importWorkspaceJson wsPath:""', () => RPC('importWorkspaceJson', { wsPath: '', json: { mcpServers: { x: { command: 'node' } } } }), /缺少 workspace 路径/)
  await expectReject('revealWorkspaceServer wsPath:""', () => RPC('revealWorkspaceServer', { wsPath: '', name: 'x', field: 'args' }), /缺少 workspace 路径/)

  // 3) 读入口与只做注册校验的入口。
  await expectReject('getWorkspaceView wsPath:""', () => RPC('getWorkspaceView', { wsPath: '' }), /缺少 workspace 路径/)
  await expectReject('exportWorkspaceJson wsPath:""', () => RPC('exportWorkspaceJson', { wsPath: '' }), /缺少 workspace 路径/)
  await expectReject('workspaceToolLoading wsPath:""', () => RPC('workspaceToolLoading', { wsPath: '' }), /缺少 workspace 路径/)

  const leftovers = existsSync(join(cwdReal, '.dsh'))
  if (leftovers) bad('宿主 cwd 未被污染', `${join(cwdReal, '.dsh')} 存在：${await readdir(join(cwdReal, '.dsh'))}`)
  else ok('宿主 cwd 未被污染', '没有 .dsh/')

  // 4) 正控：真宿主上正常路径必须逐字不变（写盘 → 读回 → 面板视图）。
  const added = await RPC('addWorkspaceServer', {
    wsPath: project, spec: { name: 'r1-live', transport: 'stdio', command: process.execPath, args: ['--version'] },
  })
  const written = JSON.parse(await readFile(join(project, '.dsh', 'mcp.json'), 'utf8'))
  if (added.persisted === 'applied' && written.mcpServers?.['r1-live']) ok('正控 addWorkspaceServer(真实项目)', `${added.persisted} / 盘上 ${Object.keys(written.mcpServers)}`)
  else bad('正控 addWorkspaceServer(真实项目)', JSON.stringify({ added, written }))

  const view = await RPC('getWorkspaceView', { wsPath: project })
  if (view.servers.length === 1 && view.servers[0].serverName === 'r1-live' && view.path === realpathSync(project)) {
    ok('正控 getWorkspaceView(真实项目)', `servers=[${view.servers.map((s) => s.serverName)}]`)
  } else bad('正控 getWorkspaceView(真实项目)', JSON.stringify(view).slice(0, 200))

  const exported = await RPC('exportWorkspaceJson', { wsPath: project })
  if (JSON.parse(exported.json).mcpServers?.['r1-live']) ok('正控 exportWorkspaceJson', `count=${exported.count}`)
  else bad('正控 exportWorkspaceJson', exported.json)

  // 5) 「不传 wsPath = 全局族」的既有语义不能被这次收紧密封掉。
  const globalDefer = await RPC('setDeferAll', { defer: false })
  if (globalDefer && typeof globalDefer === 'object') ok('setDeferAll 不传 wsPath 仍走全局分支', JSON.stringify(globalDefer).slice(0, 90))
  else bad('setDeferAll 不传 wsPath 仍走全局分支', JSON.stringify(globalDefer))
} finally {
  await host.cleanup()
  process.chdir(previousCwd)
  await rm(hostCwd, { recursive: true, force: true })
  await rm(project, { recursive: true, force: true })
}

console.log(`\n${problems.length === 0 ? '全部通过' : `${problems.length} 项失败`}`)
if (problems.length) process.exitCode = 1
