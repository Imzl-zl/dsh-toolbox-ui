// issue #8 的隔离进程验证（真宿主：cordis + dsh-tools + dsh-mcp-client + 真 stdio 子进程）。
// 用法：node .tmp-issue8/e2e-probe.mjs fixed|baseline
// 两个变体各起一个独立进程，互不共享模块状态；两边跑的是同一段探针，只换 workspace-runtime 的实现。
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

// 每个工具 ~3.3KB schema：与 issue 的「207 个工具、parameters 合计约 691KB」同量级。
const FIXTURE_SERVER = `
const count = Number(process.argv[2] || 207)
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
const props = () => {
  const properties = {}
  for (let i = 0; i < 9; i += 1) properties['p' + i] = { type: 'string', description: '参数 p' + i + '：用来把 schema 撑到与真实 MCP 工具相近的体积。' }
  return properties
}
const tools = []
for (let i = 0; i < count - 1; i += 1) tools.push({
  name: 'tool_' + String(i).padStart(3, '0'),
  description: 'fixture tool ' + i + '：一个用于验证项目 MCP 工具投射的占位工具。',
  inputSchema: { type: 'object', properties: props(), required: ['p0'] },
})
tools.push({ name: 'echo', description: 'Echo the given text back.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } })
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
    else if (message.method === 'tools/call') send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'echo:' + String(message.params.arguments?.text ?? '') }] } })
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
  const warnings = []
  ctx.logger.exporter({ colors: 0, levels: { default: 3 }, export: (m) => { warnings.push(m.args.map(String).join(' ')) } })
  ctx.provide('systemPrompt', { tools: () => {}, section: () => {}, getSectionOrder: () => 0 })
  await ctx.plugin(ToolRuntime)
  const tools = ctx.get('tools')
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
  return {
    ctx, tools, agents, warnings,
    createAgent(cwd) { return agents.create({ cwd }) },
    async cleanup() {
      for (const agentScope of agentScopes) { try { await agentScope.dispose() } catch { /* noop */ } }
      await ctx.fiber.dispose()
    },
  }
}

const ms = (value) => `${value.toFixed(2)} ms`
const root = await mkdtemp(join(tmpdir(), `dsh-issue8-${variant}-`))
const wsA = join(root, 'ws-a')
const wsB = join(root, 'ws-b')
const serverPath = join(root, 'fixture-server.mjs')
await mkdir(join(wsA, '.dsh'), { recursive: true })
await mkdir(join(wsB, '.dsh'), { recursive: true })
await writeFile(serverPath, FIXTURE_SERVER)
await writeFile(join(wsA, '.dsh', 'mcp.json'), JSON.stringify({
  mcpServers: { fixture: { command: process.execPath, args: [serverPath, String(TOOL_COUNT)] } },
}, null, 2))
await writeFile(join(wsB, '.dsh', 'mcp.json'), JSON.stringify({ mcpServers: {} }, null, 2))

const runtime = await import(runtimeUrl)
let host
const result = { variant, tools: TOOL_COUNT }
try {
  host = await createRealHost(wsA, runtime)
  let changeEvents = 0
  host.ctx.on('tools/change', () => { changeEvents += 1 })
  // 归因：register() 内部会同步跑完我们的 tools/change 监听器，所以这段耗时≈「工具注册 + 重算」。
  const proto = Object.getPrototypeOf(host.tools)
  const originalRegister = proto.register
  let registerCalls = 0
  let registerMs = 0
  proto.register = function (definition) {
    registerCalls += 1
    const started = performance.now()
    try { return originalRegister.call(this, definition) } finally { registerMs += performance.now() - started }
  }

  // M1：首个会话（连接从零建立 + 207 个工具逐个注册 → 触发风暴）
  let t0 = performance.now()
  const first = await host.createAgent(wsA)
  result.firstSessionMs = performance.now() - t0
  result.changeEventsDuringFirst = changeEvents
  result.registerCallsDuringFirst = registerCalls
  result.registerSyncMsDuringFirst = Number(registerMs.toFixed(1))
  const projected = await waitFor(() => host.tools.schemas(first.key).filter((s) => s.name.startsWith('mcp__fixture__')))
  result.projectedFirst = projected?.length ?? 0
  result.schemaBytes = Buffer.byteLength(JSON.stringify(host.tools.schemas(first.key)))

  // M2：连接已就绪后再开 7 个会话（稳态"新建会话"）
  const sessions = [first]
  const secondTimes = []
  for (let i = 0; i < 7; i += 1) {
    t0 = performance.now()
    sessions.push(await host.createAgent(wsA))
    secondTimes.push(performance.now() - t0)
  }
  result.followupSessionMs = secondTimes
  result.projectedPerSession = sessions.map((s) => host.tools.schemas(s.key).filter((x) => x.name.startsWith('mcp__fixture__')).length)

  // M3：一次全局工具变化（等价于任何 tools/change，8 个存活会话）
  // 修改后事件会被合并到一个微任务里执行，所以要把这一步也等完再计时。
  const changes = []
  for (let i = 0; i < 5; i += 1) {
    t0 = performance.now()
    await host.ctx.emit('tools/change')
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    changes.push(performance.now() - t0)
  }
  result.toolsChangeMs = changes.map((v) => Number(v.toFixed(2)))

  // M4：另一个没有项目 MCP 的工作区新建会话（issue 说的"任意工作区"）
  t0 = performance.now()
  await host.createAgent(wsB)
  result.otherWorkspaceSessionMs = performance.now() - t0

  // M5：面板轮询一次（项目连接视图）
  t0 = performance.now()
  await runtime.projectConnectionsView(host.ctx)
  result.panelViewMs = performance.now() - t0

  // 正确性：投射出来的工具必须能经真 stdio 子进程执行
  const def = host.tools.get('mcp__fixture__echo', first.key)
  result.hasExecutable = typeof def?.execute === 'function'
  const executed = await def.execute({ text: 'issue-8 ' + variant }, { signal: new AbortController().signal })
  result.executeText = executed?.content?.[0]?.text
  result.warnings = host.warnings.slice(0, 3)
} finally {
  if (host) await host.cleanup()
  await rm(root, { recursive: true, force: true })
}

console.log(JSON.stringify(result, null, 2))


