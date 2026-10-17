// 手动验证脚本（**不进 node --test**）：同一个进程内，setDeferAll 之后是否立即生效，
// 无需重启进程。真 cordis Context + 真 SystemPrompt + 真 ToolRuntime + 真 dsh-scope
// + 真 mcp-client 连**真 serena**。
// 依赖：本机 `serena` 在 PATH 且可用（`serena --version`）。serena 冷启动 1-1.5 分钟，
// 所以不适合放进自动化测试；改了 defer 相关逻辑后手动跑一次即可：
//   node scripts/probe-live-defer.mjs
// 观测量：assemble 出来的 tools 里 mcp__* 的数量（遮罩生效=0，解除=28）。
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require_ = createRequire(import.meta.url)
const systemPromptUrl = new URL('../../dsh-system-prompt/lib/index.js', pathToFileURL(require_.resolve('@deepseek-ai/dsh-tools'))).href
const { default: SystemPrompt } = await import(systemPromptUrl)
const ToolRuntime = (await import('@deepseek-ai/dsh-tools')).default
const scopeMod = await import('@deepseek-ai/dsh-scope')
const { Context } = await import('@deepseek-ai/cordis')
const { McpManagerGateway } = await import('../lib/index.js')
const mcpClient = await import('@deepseek-ai/dsh-mcp-client')

const SERENA = { transport: 'stdio', serverName: 'serena', command: 'serena', args: ['start-mcp-server', '--context=agent', '--project-from-cwd'] }

const root = await mkdtemp(join(tmpdir(), 'dsh-e2e-'))
const patch = join(root, 'cordis.patch.yml')
await writeFile(patch, `- insert:
    - id: mcp-serena
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio
        serverName: serena
        command: serena
        args: [ 'start-mcp-server', '--context=agent', '--project-from-cwd' ]
        defer: true
`)

// 稳定引用的 loader 条目（真实 loader 就是持久对象）
const includeEntry = { options: { id: 'include', name: 'cordis:include', config: { path: pathToFileURL(patch).href } } }
const serenaEntry = { options: { id: 'mcp-serena', name: '@deepseek-ai/dsh-mcp-client', config: { ...SERENA, defer: true } } }

const ctx = new Context()
await ctx.plugin({
  name: 'host-stub',
  apply(inner) {
    inner.provide('loader', { entries: () => [includeEntry, serenaEntry] })
  },
})
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRuntime)
await ctx.plugin(McpManagerGateway, {})
// 真 mcp-client：真的去连 serena（冷启动约 1-1.5 分钟）
await ctx.plugin(mcpClient, { ...SERENA, defer: true })

const systemPrompt = ctx.get('systemPrompt')

// 建一个 agent 作用域（照 real-host 测试的姿势）
const agent = { id: 'a1', session: { deriveMessages: () => [] } }
await new Promise((resolve) => {
  ctx.inject(['tools'], (toolCtx) => {
    const scope = scopeMod.createScope(toolCtx, agent)
    agent.ctx = scope.ctx
    agent.scope = scope
    resolve()
  })
})

const countMcp = async () => {
  const asm = await systemPrompt.assemble({ agent, scope: agent, signal: new AbortController().signal })
  const names = (asm.tools ?? []).map((t) => t.name)
  return { total: names.length, mcp: names.filter((n) => n.startsWith('mcp__')).length, toolSearch: names.includes('tool_search') }
}
const toolNames = async () => {
  const asm = await systemPrompt.assemble({ agent, scope: agent, signal: new AbortController().signal })
  return (asm.tools ?? []).map((t) => t.name).filter((n) => n.startsWith('mcp__'))
}

console.log('serena 已连接（真 mcp-client）。开始同进程翻转 defer：\n')
console.log('初始(defer:true)        ->', JSON.stringify(await countMcp()))

const off = await ctx.get('mcpManager').setDeferAll({ defer: false })
console.log('setDeferAll({defer:false}) ->', JSON.stringify(off))
const afterOff = await countMcp()
console.log('  同进程 assemble        ->', JSON.stringify(afterOff))
const names = await toolNames()
console.log('  mcp__ 工具样例:', names.slice(0, 4).join(', '), '...')

const on = await ctx.get('mcpManager').setDeferAll({ defer: true })
console.log('\nsetDeferAll({defer:true})  ->', JSON.stringify(on))
const afterOn = await countMcp()
console.log('  同进程 assemble        ->', JSON.stringify(afterOn))

console.log('\n===== 判定 =====')
console.log('遮罩初始生效(mcp=0):', (await countMcp()).mcp === 0 ? 'PASS' : 'FAIL')
console.log('关闭后同进程立即解除(mcp>0):', afterOff.mcp > 0 ? 'PASS' : 'FAIL', `(${afterOff.mcp} 个)`)
console.log('重新开启后同进程立即遮罩(mcp=0):', afterOn.mcp === 0 ? 'PASS' : 'FAIL')
console.log('tool_search 始终在:', afterOff.toolSearch && afterOn.toolSearch ? 'PASS' : 'FAIL')

await agent.scope?.dispose()
await ctx.fiber.dispose()
await rm(root, { recursive: true, force: true })
