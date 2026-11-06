import test from 'node:test'
import assert from 'node:assert/strict'
import { McpManagerGateway } from '../lib/index.js'

// 回归：MCP 页那颗「全量/延迟」芯片原来读旧的服务器级 `defer`，统一策略下的组级/单工具设置
// 在它那里完全不可见——用户把整组设为按需，芯片还写"全量"。`deferStateOf` 是它的唯一数据源。
function selfWith(tools) {
  return {
    ctx: { tools: { schemas: () => tools }, loader: { entries: () => [{ options: { id: 'mcp-fixture', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'fixture' } }, disabled: false }] }, get: () => undefined },
    globalToolLoading: { mode: 'legacy', groups: { fixture: 'deferred' }, tools: {} },
    liveAgents: [],
    toolSearchRuntime: { settings: { toolName: 'tool_search' } },
    loadingPolicy: McpManagerGateway.prototype.loadingPolicy,
    collectAvailableTools() { return this.ctx.tools.schemas() },
  }
}

test('deferStateOf：组级 deferred → 芯片必须显示延迟（不是旧 defer 字段）', () => {
  const self = selfWith([
    { name: 'mcp__fixture__review_lookup', description: 'x', parameters: {} },
    { name: 'mcp__fixture__other', description: 'y', parameters: {} },
    { name: 'read', description: 'z', parameters: {} },
  ])
  const state = McpManagerGateway.prototype.deferStateOf.call(self, 'fixture')
  assert.equal(state.deferEffective, true, '整组都是 deferred 时，服务器级芯片必须是"延迟"')
  assert.equal(state.deferredCount, 2)
  assert.equal(state.toolCountForDefer, 2, '只统计该服务器名下的工具，不能把内置工具算进来')
})

test('deferStateOf：一个工具被显式改回 resident → 芯片如实显示不全是延迟', () => {
  const self = selfWith([{ name: 'mcp__fixture__review_lookup', description: 'x', parameters: {} }])
  self.globalToolLoading = { mode: 'legacy', groups: { fixture: 'deferred' }, tools: { 'mcp__fixture__review_lookup': 'resident' } }
  const state = McpManagerGateway.prototype.deferStateOf.call(self, 'fixture')
  assert.equal(state.deferEffective, false, '单工具覆盖后就不能再说整台服务器是延迟')
  assert.equal(state.deferredCount, 0)
})

test('deferStateOf：服务器没有可见工具时明确返回 false，不编造状态', () => {
  const self = selfWith([{ name: 'read', description: 'z', parameters: {} }])
  const state = McpManagerGateway.prototype.deferStateOf.call(self, 'fixture')
  assert.deepEqual(state, { deferEffective: false, deferredCount: 0, toolCountForDefer: 0 })
})


// 接线守卫：芯片与详情必须优先读 `deferEffective`（统一策略的结论），旧 `defer` 只作兜底。
test('接线：MCP 页芯片与详情优先读 deferEffective，服务器行由同一份策略派生', async () => {
  const { readFile } = await import('node:fs/promises')
  const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(client, /on:\s*\(s\.deferEffective \?\? s\.defer\) === true/, '芯片必须优先读 deferEffective')
  assert.match(client, /\(server\.deferEffective \?\? server\.defer\)/, '详情文案必须与芯片同源')
  const server = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(server, /Object\.assign\(row, deferStateOf\(name\)\)/, '服务器行必须由 deferStateOf 填充')
})
