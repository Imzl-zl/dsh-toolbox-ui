import test from 'node:test'
import assert from 'node:assert/strict'
import { McpManagerGateway } from '../lib/index.js'

// 回归：MCP 页那颗「全量/延迟」芯片原来读旧的服务器级 `defer`，统一策略下的组级/单工具设置
// 在它那里完全不可见——用户把整组设为按需，芯片还写"全量"。`deferStateOf` 是它的唯一数据源。
//
// 它现在故意返回**两个不同的东西**：
//   · deferConfigured —— 组级默认（项目组 > 全局组 > 旧 defer > 模式），芯片显示这个；
//   · deferEffective  —— 该服务器工具的实际分布（resident/deferred/mixed），详情页显示这个。
// 两者混用就会出现“芯片写着全量、实际还有一半按需”或“点了没反应”。
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

test('deferStateOf：组级 deferred → 芯片显示延迟，实际分布也是延迟', () => {
  const self = selfWith([
    { name: 'mcp__fixture__review_lookup', description: 'x', parameters: {} },
    { name: 'mcp__fixture__other', description: 'y', parameters: {} },
    { name: 'read', description: 'z', parameters: {} },
  ])
  const state = McpManagerGateway.prototype.deferStateOf.call(self, 'fixture')
  assert.equal(state.deferConfigured, 'deferred', '组级默认必须是延迟')
  assert.equal(state.deferEffective, 'deferred', '整组都是 deferred 时，实际分布必须是延迟')
  assert.equal(state.deferredCount, 2)
  assert.equal(state.toolCountForDefer, 2, '只统计该服务器名下的工具，不能把内置工具算进来')
  assert.equal(state.deferOverrides, 0)
})

test('deferStateOf：一个工具被显式改回 resident → 组级默认不变，实际分布变混合', () => {
  const self = selfWith([
    { name: 'mcp__fixture__review_lookup', description: 'x', parameters: {} },
    { name: 'mcp__fixture__other', description: 'y', parameters: {} },
  ])
  self.globalToolLoading = { mode: 'legacy', groups: { fixture: 'deferred' }, tools: { 'mcp__fixture__review_lookup': 'resident' } }
  const state = McpManagerGateway.prototype.deferStateOf.call(self, 'fixture')
  // 芯片是组级控件：它显示“整台默认延迟”，点它改的也是这一层；逐工具例外由 deferOverrides 表达。
  assert.equal(state.deferConfigured, 'deferred')
  assert.equal(state.deferEffective, 'mixed', '一个常驻、一个按需时实际分布是混合')
  assert.equal(state.deferredCount, 1)
  assert.equal(state.deferOverrides, 1, '单独设置的条数要能显示在芯片旁边')
})

test('deferStateOf：服务器没有可见工具时不下发 deferEffective，只报配置值与 0 工具', () => {
  const self = selfWith([{ name: 'read', description: 'z', parameters: {} }])
  const state = McpManagerGateway.prototype.deferStateOf.call(self, 'fixture')
  assert.equal(Object.hasOwn(state, 'deferEffective'), false, '还没连上不能谎报“全量”')
  assert.equal(state.deferConfigured, 'deferred')
  assert.equal(state.deferredCount, 0)
  assert.equal(state.toolCountForDefer, 0)
})

test('deferStateOf：旧 defer=false 在组级之前只作为输入，不覆盖组级设置', () => {
  const self = selfWith([{ name: 'mcp__fixture__a', description: 'x', parameters: {} }])
  self.globalToolLoading = { mode: 'legacy', groups: { fixture: 'deferred' }, tools: {} }
  const state = McpManagerGateway.prototype.deferStateOf.call(self, 'fixture', { legacyDefer: false })
  assert.equal(state.deferConfigured, 'deferred', '组级优先于旧 defer')
})

test('deferStateOf：全部常驻方案 / 总开关会标记锁定，面板据此禁用开关', () => {
  const self = selfWith([{ name: 'mcp__fixture__a', description: 'x', parameters: {} }])
  self.globalToolLoading = { mode: 'all-resident', groups: { fixture: 'deferred' }, tools: {} }
  const locked = McpManagerGateway.prototype.deferStateOf.call(self, 'fixture')
  assert.equal(locked.deferLocked, 'all-resident')
  assert.equal(locked.deferEffective, 'resident', '方案压过组级覆盖')
  const previous = process.env.DSH_MCP_TOOL_SEARCH
  process.env.DSH_MCP_TOOL_SEARCH = 'off'
  try {
    const off = McpManagerGateway.prototype.deferStateOf.call(self, 'fixture')
    assert.equal(off.deferLocked, 'master-switch')
  } finally {
    if (previous === undefined) delete process.env.DSH_MCP_TOOL_SEARCH
    else process.env.DSH_MCP_TOOL_SEARCH = previous
  }
})

// 接线守卫：芯片读组级默认、详情读实际分布，服务器行由同一份策略派生。
test('接线：芯片读 deferConfigured，详情读 deferEffective，服务器行由同一份策略派生', async () => {
  const { readFile } = await import('node:fs/promises')
  const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(client, /\(s\.deferConfigured \?\? \(s\.defer === true \? 'deferred' : 'resident'\)\) === 'deferred'/, '芯片必须读组级默认')
  assert.match(client, /server\.deferEffective === 'mixed'/, '详情文案必须读实际分布')
  assert.match(client, /s\.deferOverrides/, '芯片旁边必须把逐工具例外摆出来')
  const server = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(server, /Object\.assign\(row, deferStateOf\(name, \{ legacyDefer \}\)\)/, '服务器行必须由 deferStateOf 填充')
})
