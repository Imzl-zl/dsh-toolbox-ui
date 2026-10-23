// 模型侧冒烟：把「会话里投射出来的工具 schema」原样交给模型，用模型返回的实参调真 MCP 工具。
// 端点与 key 走环境变量，不落盘：LIGHTVELA_BASE（默认 https://token.lightvela.ai/v1）、LIGHTVELA_KEY。
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as scope from '@deepseek-ai/dsh-scope'

const BASE = (process.env.LIGHTVELA_BASE || 'https://token.lightvela.ai/v1').replace(/\/$/, '')
const KEY = process.env.LIGHTVELA_KEY
if (!KEY) throw new Error('缺少 LIGHTVELA_KEY')

const SERVER = `
const tools = [{ name: 'echo', description: 'Echo the given text back.', inputSchema: { type: 'object', properties: { text: { type: 'string', description: '要原样回显的文本' } }, required: ['text'] } }]
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    const message = JSON.parse(line)
    if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1.0.0' } } })
    else if (message.method === 'tools/list') send({ jsonrpc: '2.0', id: message.id, result: { tools } })
    else if (message.method === 'tools/call') send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'fixture-says:' + String(message.params.arguments?.text ?? '') }] } })
    else if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, result: {} })
  }
})
process.stdin.on('end', () => process.exit(0))
`

const root = await mkdtemp(join(tmpdir(), 'dsh-llm-smoke-'))
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

try {
  const session = await agents.create({ cwd: ws })
  // 等到投射完成
  const deadline = Date.now() + 20_000
  let projected = []
  while (Date.now() < deadline) {
    projected = tools.schemas(session.key).filter((s) => s.name.startsWith('mcp__fixture__'))
    if (projected.length) break
    await new Promise((r) => setTimeout(r, 20))
  }
  if (!projected.length) throw new Error('工具没有投射进会话')
  // 模型看到的就是这一份 schema（name/description/parameters），与宿主喂给模型的一致。
  const toolSchema = projected[0]
  console.log('会话内工具 schema:', JSON.stringify(toolSchema))

  const body = {
    model: process.env.LIGHTVELA_MODEL || 'auto',
    messages: [{ role: 'user', content: '请调用 echo 工具，把文本 "issue-8 冒烟" 原样回显。只调用工具，不要解释。' }],
    tools: [{ type: 'function', function: { name: toolSchema.name, description: toolSchema.description, parameters: toolSchema.parameters } }],
    tool_choice: 'auto',
    temperature: 0,
  }
  const response = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`模型端点 ${response.status}: ${text.slice(0, 400)}`)
  const payload = JSON.parse(text)
  const message = payload.choices?.[0]?.message
  const call = message?.tool_calls?.[0]
  console.log('模型返回 tool_call:', JSON.stringify(call ?? null))
  if (!call) throw new Error('模型没有发起工具调用')

  // 用模型给的实参调用**真实投射出来的**工具（真 stdio 子进程）
  const definition = tools.get(call.function.name, session.key)
  const args = JSON.parse(call.function.arguments || '{}')
  const result = await definition.execute(args, { signal: new AbortController().signal })
  const reply = result?.content?.[0]?.text
  console.log('真 MCP 工具执行结果:', reply)

  // 把工具结果回灌给模型，确认这一圈闭环
  const second = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: body.model,
      messages: [
        ...body.messages,
        { role: 'assistant', content: message.content ?? null, tool_calls: message.tool_calls },
        { role: 'tool', tool_call_id: call.id, content: String(reply) },
      ],
      temperature: 0,
    }),
  })
  const secondPayload = await second.json()
  console.log('模型最终回复:', secondPayload.choices?.[0]?.message?.content)
  console.log(JSON.stringify({
    ok: true,
    model: payload.model,
    tool: call.function.name,
    args,
    toolResult: reply,
    finalAnswer: secondPayload.choices?.[0]?.message?.content,
  }, null, 2))
} finally {
  for (const s of agentScopes) { try { await s.dispose() } catch { /* noop */ } }
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
}

