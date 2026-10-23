// 上游契约探针（复核轮新增）：哨兵依赖的「每次 tools/list 同步都整批重建定义」到底是设计还是巧合？
// 这个探针不测本插件，测的是**已安装的 mcp-client**：真 stdio 子进程里发一条
// `notifications/tools/list_changed`，然后检查同名工具的定义对象是否**整批换新**。
// 上游若改成增量同步（保留未变工具的定义对象），这里会红 —— 那正是哨兵的盲点。
// 用法：node .tasks/issue-8-tool-view/probes/sentinel-contract-probe.mjs  （红 = 退出码 1）
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as scope from '@deepseek-ai/dsh-scope'

// 第一次 tools/list：2 个工具。发出 list_changed 之后：名字不变、描述变、并**新增**一个工具。
const SERVER = `
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
let version = 0
const toolsFor = (v) => [
  { name: 'echo', description: 'Echo the given text back. (v' + v + ')', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'stamp', description: 'Return a stamp. (v' + v + ')', inputSchema: { type: 'object', properties: {} } },
  ...(v > 0 ? [{ name: 'late', description: 'Appears only after list_changed.', inputSchema: { type: 'object', properties: {} } }] : []),
]
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    const message = JSON.parse(line)
    if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'fixture', version: '1.0.0' } } })
    else if (message.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: message.id, result: { tools: toolsFor(version) } })
      if (version === 0) {
        version = 1
        setTimeout(() => send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }), 300)
      }
    } else if (message.method === 'tools/call') send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'ok' }] } })
    else if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, result: {} })
  }
})
process.stdin.on('end', () => process.exit(0))
`

async function waitFor(predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() > deadline) return undefined
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const root = await mkdtemp(join(tmpdir(), 'dsh-sentinel-contract-'))
const ws = join(root, 'ws')
await mkdir(join(ws, '.dsh'), { recursive: true })
const serverPath = join(root, 'server.mjs')
await writeFile(serverPath, SERVER)
await writeFile(join(ws, '.dsh', 'mcp.json'), JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [serverPath] } } }, null, 2))

const ctx = new Context()
ctx.baseUrl = new URL('../../../', import.meta.url).href
await ctx.plugin(Loader)
ctx.provide('systemPrompt', { tools: () => {}, section: () => {}, getSectionOrder: () => 0 })
await ctx.plugin(ToolRuntime)
const tools = ctx.get('tools')
const agentScopes = []
const agents = {
  async create(options = {}) {
    const cwd = options.cwd ?? ws
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
    await ctx.serial(ctx, 'agent/created', { agent, source: 'startup' })
    return { key: created.key, scope: created.scope }
  },
  async resume(o) { return this.create(o) },
}
ctx.provide('agents', agents)
const runtime = await import('../../../lib/workspace-runtime.js')
runtime.installAgentRuntime(ctx)

const result = { probe: 'sentinel-contract', namesBefore: [], namesAfter: [], rebuilt: {}, newToolAppeared: null, ok: false }
try {
  let changes = 0
  ctx.on('tools/change', () => { changes += 1 })
  const session = await agents.create({ cwd: ws })
  const read = () => new Map([...tools.schemas(session.key)]
    .filter((s) => s.name.startsWith('mcp__fixture__'))
    .map((s) => [s.name, tools.get(s.name, session.key)]))
  const before = await waitFor(() => { const m = read(); return m.size >= 2 ? m : undefined })
  if (!before) throw new Error('首个 tools/list 没有投射出工具')
  result.namesBefore = [...before.keys()].sort()

  // 等子进程发 list_changed → mcp-client refreshTools → 整批重建
  const after = await waitFor(() => {
    const m = read()
    return m.size === 3 ? m : undefined
  })
  if (!after) throw new Error('list_changed 之后没有看到新增工具（上游行为变了？）')
  result.namesAfter = [...after.keys()].sort()
  result.newToolAppeared = after.has('mcp__fixture__late')
  for (const name of result.namesBefore) {
    result.rebuilt[name] = after.has(name) ? after.get(name) !== before.get(name) : 'gone'
  }
  result.changeEvents = changes
  // 判据：**每一个仍在的名字，定义对象都必须换新**（整批重建）。只要有一个还是旧对象，
  // 就说明上游变成了增量同步 —— 哨兵的「身份未变 ⇒ 工具集未变」随之失效。
  result.ok = result.newToolAppeared === true
    && Object.values(result.rebuilt).every((value) => value === true)
} finally {
  for (const s of agentScopes) { try { await s.dispose() } catch { /* noop */ } }
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
}

console.log(JSON.stringify(result, null, 2))
if (!result.ok) {
  console.error('\n✖ 契约不成立：mcp-client 没有在 re-sync 时整批重建定义。哨兵机制（见 ANALYSIS.md §5）需要重新设计。')
  process.exit(1)
}
console.log('\n✔ 契约成立：每次 tools/list 同步都整批重建定义对象，哨兵的「身份未变 ⇒ 工具集未变」成立。')
