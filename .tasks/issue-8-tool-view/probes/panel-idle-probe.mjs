// 一次性探针（review 用）：把「面板轮询一次」的代价从它前面那批事件的尾巴里分离出来。
// e2e-probe.mjs 的 panelViewMs 是在 8 次会话创建 + 5 次 tools/change 之后立刻测的，
// 基线变体那一刻事件循环里还压着 414×8 个未 await 的配置读取，所以那个数字测的是「排队的尾巴」，
// 不是「面板一次轮询」。这里先等事件循环空下来（setTimeout 0 ×2 + 100ms），再取 5 次最小值。
// 用法：node .tasks/issue-8-tool-view/probes/panel-idle-probe.mjs fixed|baseline
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as scope from '@deepseek-ai/dsh-scope'

const variant = process.argv[2] === 'baseline' ? 'baseline' : 'fixed'
const runtimeUrl = variant === 'baseline' ? '../../../lib/.baseline-workspace-runtime.mjs' : '../../../lib/workspace-runtime.js'
const TOOL_COUNT = 207
const SESSIONS = 8

const FIXTURE_SERVER = `
const count = Number(process.argv[2] || 207)
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
const props = () => {
  const properties = {}
  for (let i = 0; i < 9; i += 1) properties['p' + i] = { type: 'string', description: '参数 p' + i + '：用来把 schema 撑到与真实 MCP 工具相近的体积。' }
  return properties
}
const tools = []
for (let i = 0; i < count; i += 1) tools.push({
  name: 'tool_' + String(i).padStart(3, '0'),
  description: 'fixture tool ' + i + '：一个用于验证项目 MCP 工具投射的占位工具。',
  inputSchema: { type: 'object', properties: props(), required: ['p0'] },
})
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let index
  while ((index = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, index); buf = buf.slice(index + 1)
    if (!line.trim()) continue
    const message = JSON.parse(line)
    if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1.0.0' } } })
    else if (message.method === 'tools/list') send({ jsonrpc: '2.0', id: message.id, result: { tools } })
    else if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, result: {} })
  }
})
process.stdin.on('end', () => process.exit(0))
`

async function waitFor(predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() > deadline) return undefined
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function createRealHost(wsRoot, runtime) {
  const ctx = new Context()
  ctx.baseUrl = new URL('../../../', import.meta.url).href
  await ctx.plugin(Loader)
  ctx.logger.exporter({ colors: 0, levels: { default: 3 }, export: () => {} })
  ctx.provide('systemPrompt', { tools: () => {}, section: () => {}, getSectionOrder: () => 0 })
  await ctx.plugin(ToolRuntime)
  const agentScopes = []
  const agents = {
    async create(options = {}) {
      const cwd = options.cwd ?? wsRoot
      const created = {}
      const ready = new Promise((resolve) => { created.resolve = resolve })
      ctx.inject(['tools'], (toolCtx) => {
        created.key = { agent: agentScopes.length }
        created.scope = scope.createScope(toolCtx, created.key)
        agentScopes.push(created.scope)
        created.resolve(created.scope)
      })
      await ready
      const agent = { session: { header: { cwd } }, ctx: created.scope.ctx }
      const commit = await options.setup?.(created.scope.ctx, agent)
      commit?.commit?.()
      await ctx.serial(ctx, 'agent/created', { agent, source: 'startup' })
      return { key: created.key, scope: created.scope }
    },
    async resume(options = {}) { return this.create(options) },
  }
  ctx.provide('agents', agents)
  runtime.installAgentRuntime(ctx)
  return { ctx, agents, async cleanup() { for (const s of agentScopes) { try { await s.dispose() } catch { /* noop */ } } await ctx.fiber.dispose() } }
}

const root = await mkdtemp(join(tmpdir(), `dsh-panel-idle-${variant}-`))
const ws = join(root, 'ws')
await mkdir(join(ws, '.dsh'), { recursive: true })
const serverPath = join(root, 'fixture-server.mjs')
await writeFile(serverPath, FIXTURE_SERVER)
await writeFile(join(ws, '.dsh', 'mcp.json'), JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [serverPath, String(TOOL_COUNT)] } } }, null, 2))

const runtime = await import(runtimeUrl)
let host
const out = { variant, toolCount: 0 }
try {
  host = await createRealHost(ws, runtime)
  for (let i = 0; i < SESSIONS; i += 1) await host.agents.create({ cwd: ws })
  await waitFor(() => host.ctx.tools.schemas().length >= 0 && true)
  // 等事件循环彻底空下来：两轮宏任务 + 100ms，让所有未 await 的配置读取/重算跑完。
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 100))
  out.globalTools = host.ctx.tools.schemas().length
  const row = (await runtime.projectConnectionsView(host.ctx))[0]
  out.toolCount = row?.toolCount ?? 0
  const times = []
  for (let i = 0; i < 5; i += 1) {
    const started = performance.now()
    await runtime.projectConnectionsView(host.ctx)
    times.push(Number((performance.now() - started).toFixed(2)))
  }
  out.panelIdleMs = times
  out.panelIdleMin = Math.min(...times)
} finally {
  if (host) await host.cleanup()
  await rm(root, { recursive: true, force: true })
}
console.log(JSON.stringify(out, null, 2))
