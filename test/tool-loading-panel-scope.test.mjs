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
