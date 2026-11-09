import test from 'node:test'
import assert from 'node:assert/strict'
import { McpManagerGateway } from '../lib/index.js'

// 回归（真机发现）：0.2.2 把 MCP 客户端的工具注册在**它自己的条目作用域**里，根的
// `tools.schemas()` 看不到。面板在没有存活会话时只读根视图 → MCP 工具整行缺失、
// 按需计数为 0，而策略其实已经要求延迟。真机表现：MCP 页写「全量」、工具页 36 常驻/0 按需，
// 同一进程里探针却拿到 `policy: deferred`。
test('工具加载面板：没有会话时也必须列出 MCP 条目作用域里的工具', async () => {
  const rootSchemas = [{ name: 'read', description: 'read a file', parameters: {} }]
  const scopedSchemas = [{ name: 'mcp__fixture__review_lookup', description: 'fixture lookup', parameters: {} }]
  const entry = {
    options: { id: 'mcp-fixture', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'fixture' } },
    disabled: false,
    // 0.2.2 的形状：条目自己的 fiber ctx 才看得到它注册的工具。
    fiber: { ctx: { tools: { schemas: () => scopedSchemas } } },
  }
  const ctx = {
    tools: { schemas: () => rootSchemas },
    loader: { entries: () => [entry] },
    get: () => undefined,
  }
  const self = {
    ctx,
    globalToolLoading: { mode: 'legacy', groups: { fixture: 'deferred' }, tools: {} },
    liveAgents: [],
    toolSearchRuntime: { settings: { toolName: 'tool_search' } },
    loadingPolicy: McpManagerGateway.prototype.loadingPolicy,
    collectAvailableTools: McpManagerGateway.prototype.collectAvailableTools,
  }

  const view = await McpManagerGateway.prototype.toolLoadingSettings.call(self)
  const row = view.tools.find((tool) => tool.name === 'mcp__fixture__review_lookup')
  assert.ok(row, '无会话时也必须列出 MCP 作用域里的工具（否则面板显示的实际状态与策略相反）')
  assert.equal(row.owner, 'fixture', '归属按 serverName 判定')
  assert.equal(row.kind, 'mcp')
  assert.equal(row.policy, 'deferred', '组级策略必须在该行上体现')
  assert.equal(row.reason, 'global-group')
  // 根视图里的工具照常列出（不是二选一）。
  assert.ok(view.tools.some((tool) => tool.name === 'read'))
})

// 回归（真机发现）：插件升级或桌面端先开会话时，agent 在插件挂载前就已经存在，
// `agent/created` 事件不会再补发。只靠插件自己的 liveAgents 会漏掉这个会话，
// 面板只剩根作用域的 5 个工具（文件 1 / MCP 资源 3 / 代码与工作区 1）。
// 必须从宿主 `ctx.agents.list()` 把已存在的会话补回来。
 test('工具加载面板：插件加载前已存在的会话必须从宿主 agent 注册表补进来', async () => {
  const agentSchemas = [
    { name: 'read', description: 'read a file', parameters: {} },
    { name: 'edit', description: 'edit a file', parameters: {} },
    { name: 'pwsh', description: 'run a command', parameters: {} },
  ]
  const agent = {
    ctx: { tools: { schemas: () => agentSchemas } },
    session: { header: { cwd: '/ws/a' } },
  }
  const rootSchemas = [
    { name: 'working_directory', description: 'cwd', parameters: {} },
    { name: 'list_mcp_resources', description: 'resources', parameters: {} },
  ]
  const ctx = {
    tools: { schemas: () => rootSchemas },
    agents: { list: () => [agent] },
    loader: { entries: () => [] },
    get: () => undefined,
  }
  const self = {
    ctx,
    globalToolLoading: { mode: 'legacy', groups: {}, tools: {} },
    liveAgents: [],
    toolSearchRuntime: { settings: { toolName: 'tool_search' } },
    loadingPolicy: McpManagerGateway.prototype.loadingPolicy,
    collectAvailableTools: McpManagerGateway.prototype.collectAvailableTools,
  }

  const view = await McpManagerGateway.prototype.toolLoadingSettings.call(self)
  const names = view.tools.map((tool) => tool.name)
  assert.ok(names.includes('read'), '已存在会话里的 read 必须出现')
  assert.ok(names.includes('edit'), '已存在会话里的 edit 必须出现')
  assert.ok(names.includes('pwsh'), '已存在会话里的 pwsh 必须出现')
  assert.ok(names.includes('working_directory'), '根作用域的工具照常保留')
})
