// R2 真宿主验证：生产形状宿主 + **真 mcp-client 连一个不存在的命令**造出真实挂载失败，
// 再用真 Remote 方法验证「删除 / 禁用之后，视图不再点名这个条目」。
//
// 为什么不能用夹具记账：R2 的缺陷是「记录表没有寿命」，只有真实的挂载失败路径才能证明
// 记录确实存在、而视图确实不再展示它。
//
// 用法（cwd = 仓库根，主树或隔离树均可）：node .tasks/review-1.11.1/repro/r2-real-host.mjs
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLoaderHost } from '../../../test-support/loader-host.mjs'
import { installAgentRuntime, workspaceMountErrorsView, workspaceRestrictErrorView } from '../../../lib/workspace-runtime.js'

const problems = []
const ok = (label, detail = '') => console.log(`✔ ${label}${detail ? ' — ' + detail : ''}`)
const bad = (label, detail) => { problems.push(`${label}: ${detail}`); console.log(`✘ ${label} — ${detail}`) }
const check = (label, condition, detail = '') => (condition ? ok(label, detail) : bad(label, detail))

const project = await mkdtemp(join(tmpdir(), 'r2-host-proj-'))
await mkdir(join(project, '.dsh'), { recursive: true })
// 真失败：这台机器上不存在这个可执行文件，官方 mcp-client 的 fiber 会自己拒绝。
await writeFile(join(project, '.dsh', 'mcp.json'), JSON.stringify({
  // failOnStartupError = 启动失败直接定论（不然它要等连接重试预算耗尽才记账）；
  // readyTimeoutMs 0 让「就绪等待」不占用这段时序。
  mcpServers: { ghost: { command: 'dsh-review-definitely-not-a-binary', failOnStartupError: true, readyTimeoutMs: 0 } },
  exclude: [],
}, null, 2))

const host = await createLoaderHost('[]\n')
host.ctx.provide('workspaceRegistry', { list: () => [{ path: project, title: 'proj' }] })
const RPC = (method, payload) => host.manager[method](payload)
const waitFor = async (predicate, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() > deadline) return undefined
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

try {
  // 项目 MCP 的挂载点是官方的 agent/created 串行监听器；真宿主里由 dsh-agent 派发。
  // 这里用一个真 cordis 子 ctx 当 agent 作用域，派发同一个事件——监听器里的代码路径完全相同。
  installAgentRuntime(host.ctx)
  const agentCtx = host.ctx.extend({})
  const agent = { id: 'r2-agent', ctx: agentCtx, session: { header: { cwd: project } } }
  host.ctx.emit('agent/created', { agent })

  const recorded = await waitFor(() => (workspaceMountErrorsView(project).length ? workspaceMountErrorsView(project) : undefined))
  check('真实挂载失败被记录', Boolean(recorded), recorded ? JSON.stringify(recorded).slice(0, 110) : '15s 内没有记录')

  const view = () => RPC('getWorkspaceView', { wsPath: project })
  const names = (rows) => rows.map((row) => row.serverName)
  check('视图点名该条目', (await view()).mountErrors.length === 1, `mountErrors=${JSON.stringify(names((await view()).mountErrors))}`)

  // 禁用：配置里还在，但挂载循环会跳过它 ⇒ 横幅不得再点名。
  await RPC('updateWorkspaceServer', { wsPath: project, spec: { name: 'ghost', transport: 'stdio', command: 'dsh-review-definitely-not-a-binary', failOnStartupError: true, readyTimeoutMs: 0, disabled: true } })
  const afterDisable = await view()
  check('禁用后视图不再点名', afterDisable.mountErrors.length === 0, JSON.stringify(afterDisable.mountErrors))
  check('记录仍在（读取端过滤，不是第二真相源）', workspaceMountErrorsView(project).length === 1)

  // 重新启用 → 真挂载再次失败 → 诊断回来（过滤器不是单向隐藏）。
  await RPC('updateWorkspaceServer', { wsPath: project, spec: { name: 'ghost', transport: 'stdio', command: 'dsh-review-definitely-not-a-binary', failOnStartupError: true, readyTimeoutMs: 0 } })
  await waitFor(() => (workspaceMountErrorsView(project).length ? true : undefined))
  check('重新启用后诊断回来', (await view()).mountErrors.length === 1)

  // 删除：条目不在了 ⇒ 视图不再点名，记录表仍不清。
  const removed = await RPC('removeWorkspaceServer', { wsPath: project, name: 'ghost' })
  const afterRemove = await view()
  check('删除后视图不再点名', afterRemove.mountErrors.length === 0, `${removed.persisted} / servers=${JSON.stringify(afterRemove.servers)} / mountErrors=${JSON.stringify(afterRemove.mountErrors)}`)
  check('删除不清表', workspaceMountErrorsView(project).length === 1)

  // 同类：restrictError 的 deny 指向的全局条目消失后不得再报。
  check('没有 restrict 记录时视图为 null', (await view()).restrictError === null && workspaceRestrictErrorView(project) === null)
} finally {
  await host.cleanup()
  await rm(project, { recursive: true, force: true })
}

assert.deepEqual(problems, [])
console.log('\n全部通过')
