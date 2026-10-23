// 验证「用作用域继承替代工具投射」是否真的成立（全部只用宿主公开原语）：
// createScope / bindScopeParent / tools.register / tools.restrict / tools.view / tools.schemas
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { bindScopeParent, createScope, scopeParentOf } from '@deepseek-ai/dsh-scope'

const ctx = new Context()
ctx.baseUrl = new URL('../../../', import.meta.url).href
await ctx.plugin(Loader)
ctx.provide('systemPrompt', { tools: () => {}, section: () => {}, getSectionOrder: () => 0 })
await ctx.plugin(ToolRuntime)
const tools = ctx.get('tools')

const toolCtx = {}
ctx.inject(['tools'], (c) => { toolCtx.ref = c })
await new Promise((r) => setTimeout(r, 10))
const base = toolCtx.ref

const def = (name) => ({ name, description: name, parameters: { type: 'object', properties: {} }, execute: async () => ({ content: [{ type: 'text', text: name }] }), output: { schema: {}, render: () => [] } })

// 1) 项目连接作用域（今天的共享连接层）
const projectKey = { project: 'ws-a' }
const project = createScope(base, projectKey)
project.ctx.tools.register(def('mcp__fixture__a'))
project.ctx.tools.register(def('mcp__fixture__b'))
console.log('项目层工具:', project.ctx.tools.schemas(projectKey).map((s) => s.name))

// 2) 会话作用域 + 绑定父级（今天不存在这一步）
const agentKey = { agent: 1 }
const agent = createScope(base, agentKey)
console.log('绑定前 parent =', scopeParentOf(agentKey))
const binding = bindScopeParent(agentKey, projectKey)
console.log('绑定后 parent =', JSON.stringify(scopeParentOf(agentKey)))
console.log('会话继承到的工具:', agent.ctx.tools.schemas(agentKey).map((s) => s.name))

// 3) exclude：用 restrict 过滤**继承来的**工具（工具在祖先层，不是自己的 own 层）
try {
  const disposer = agent.ctx.tools.restrict({ deny: ['mcp__fixture__b'] })
  console.log('restrict(继承名) 成功；过滤后会话可见:', agent.ctx.tools.schemas(agentKey).map((s) => s.name))
  console.log('  项目层本身不受影响:', project.ctx.tools.schemas(projectKey).map((s) => s.name))
  console.log('  全局层不受影响:', tools.schemas().map((s) => s.name))
  disposer()
  console.log('  撤销 restrict 后:', agent.ctx.tools.schemas(agentKey).map((s) => s.name))
} catch (error) {
  console.log('restrict(继承名) 抛错:', error?.message ?? error)
}

// 4) 第二个会话共享同一份定义（不复制）
const agentKey2 = { agent: 2 }
const agent2 = createScope(base, agentKey2)
bindScopeParent(agentKey2, projectKey)
const visible = (key) => [...tools.view(key).visible.entries()].filter(([n]) => n.startsWith('mcp__fixture__'))
const [first, second] = [visible(agentKey), visible(agentKey2)]
console.log('两个会话看到的是同一批对象:', first.length === 2 && first.every(([n, d]) => d === second.find(([m]) => m === n)?.[1]))

// 5) 连接重载：新作用域 + rebind，已绑定的会话跟过去
const reloadedKey = { project: 'ws-a-reloaded' }
const reloaded = createScope(base, reloadedKey)
reloaded.ctx.tools.register(def('mcp__fixture__a'))
reloaded.ctx.tools.register(def('mcp__fixture__b'))
reloaded.ctx.tools.register(def('mcp__fixture__c'))
binding.rebind(reloadedKey)
console.log('rebind 后会话可见:', agent.ctx.tools.schemas(agentKey).map((s) => s.name))
console.log('rebind 后第二个会话可见:', agent2.ctx.tools.schemas(agentKey2).map((s) => s.name))

// 6) 重复绑定会怎样（真实宿主给子代理绑过父级时就是这个形状）
try {
  bindScopeParent(agentKey, projectKey)
  console.log('重复绑定: 允许')
} catch (error) {
  console.log('重复绑定: 抛错 →', error?.message ?? error)
}

