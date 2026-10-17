import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chooseToolName, inferMode, probeHost, warnOnce } from '../lib/tool-search-host.js'

// 宿主能力探测层：本插件对宿主的每一处依赖（两个 private、一个可选服务、一个可选快路径）
// 都在这里一次性问清楚，装完就不再探测。缺项**不抛错**，只记一次日志——
// 它们是"退化成今天的行为"，不是"装不上"。

const RECORD = []

/** ctx 替身：只做服务表，行为与 cordis 一致（`ctx.get` 缺服务返回 undefined，不抛）。 */
function fakeCtx({ services = {}, tools = {} } = {}) {
  const logged = []
  return {
    tools,
    logged,
    get(name) { return services[name] },
    logger: { warn: (message) => { logged.push(message); RECORD.push(message) }, error: () => {} },
  }
}

const fullTools = () => ({ get: () => undefined, schemas: () => [], modeFor: () => 'native', sdkSchemas: () => [] })
const fullServices = () => ({
  sessionProjections: { register: () => () => {}, stateOf: () => undefined },
  agents: { list: () => [] },
})

test('probeHost: 全都有 → 四项全 true', () => {
  const caps = probeHost(fakeCtx({ services: fullServices(), tools: fullTools() }))
  assert.deepEqual(caps, { modeFor: true, sdkSchemas: true, projections: true, agents: true })
})

test('probeHost: 缺 sdkSchemas → false 且只记一次日志（快路径缺席不该刷屏）', () => {
  const { sdkSchemas, ...without } = fullTools()
  const ctx = fakeCtx({ services: fullServices(), tools: without })
  assert.equal(probeHost(ctx).sdkSchemas, false)
  probeHost(ctx)
  probeHost(ctx)
  // sdkSchemas 是可选快路径：缺席只影响耗时（公开 API 逐工具 get），不影响正确性，
  // 所以它**不告警**——把它当缺项报出来会让每次装配都多一条无用日志。
  assert.deepEqual(ctx.logged, [])
})

test('probeHost: 缺 sessionProjections / modeFor → false 且各记一次', () => {
  const without = fakeCtx({ services: { agents: { list: () => [] } }, tools: { schemas: () => [] } })
  const caps = probeHost(without)
  assert.equal(caps.projections, false)
  assert.equal(caps.modeFor, false)
  assert.equal(caps.agents, true)
  // 同一 ctx 上重复探测不再刷屏，但两个缺项各有一条。
  probeHost(without)
  probeHost(without)
  assert.equal(without.logged.length, 2, `每个缺项一条，实际 ${without.logged.length}`)
  assert.ok(without.logged.some((line) => line.includes('sessionProjections')))
  assert.ok(without.logged.some((line) => line.includes('modeFor')))
})

test('probeHost: 服务存在但方法缺失也算缺项', () => {
  // "服务挂着"不等于"契约在"：投影要 register + stateOf 两件，只挂一半等于没有。
  const caps = probeHost(fakeCtx({ services: { sessionProjections: { register: () => () => {} } }, tools: fullTools() }))
  assert.equal(caps.projections, false)
})

test('warnOnce: 同一个键只记一次，不同键各记各的', () => {
  const ctx = fakeCtx()
  assert.equal(warnOnce(ctx, 'a', '首条'), true)
  assert.equal(warnOnce(ctx, 'a', '重复'), false)
  assert.equal(warnOnce(ctx, 'b', '另一条'), true)
  assert.deepEqual(ctx.logged, ['mcp-manager: 首条', 'mcp-manager: 另一条'])
})

test('chooseToolName: 首选可用就拿首选，不标记改名', () => {
  const tools = { get: (name) => (name === 'other' ? { name } : undefined) }
  assert.deepEqual(chooseToolName(tools, 'tool_search', ['deferred_tool_search']), { name: 'tool_search', renamed: false })
})

test('chooseToolName: 首选被占 → 次选 + 标记改名', () => {
  const tools = { get: (name) => (name === 'tool_search' ? { name } : undefined) }
  assert.deepEqual(chooseToolName(tools, 'tool_search', ['deferred_tool_search', 'mcp_tool_search']),
    { name: 'deferred_tool_search', renamed: true })
})

test('chooseToolName: 全被占 → 抛错（明确失败，不静默装一个坏名字）', () => {
  const tools = { get: () => ({ name: 'taken' }) }
  assert.throws(() => chooseToolName(tools, 'tool_search', ['deferred_tool_search']), /tool_search/)
})

test('chooseToolName: 宿主没有 get（无法预检）→ 保留首选并记一次', () => {
  // 预检是**前瞻性**护栏（G4）。拿不到 get 时不能凭空换名——猜一个名字会让模型看不到
  // 它记熟的入口；保留首选，让宿主在注册时按它自己的重名规则报错。
  const ctx = fakeCtx({ tools: { schemas: () => [] } })
  assert.deepEqual(chooseToolName(ctx.tools, 'tool_search', ['deferred_tool_search'], { ctx }), { name: 'tool_search', renamed: false })
  assert.equal(ctx.logged.length, 1)
})

test('inferMode: modeFor 缺席时的公开退化判据', () => {
  const managed = new Set(['mcp__a__x'])
  // 没有 run_code ⇒ 模型看的是函数清单 ⇒ native。
  assert.equal(inferMode([{ name: 'Read' }, { name: 'mcp__a__x' }], managed), 'native')
  // 只有 run_code ⇒ 工具面在 tools:sdk 手册里 ⇒ ptc。
  assert.equal(inferMode([{ name: 'run_code' }], managed), 'ptc')
  // run_code 与受管工具同时在 ⇒ both（两条投影都有效）。
  assert.equal(inferMode([{ name: 'run_code' }, { name: 'mcp__a__x' }], managed), 'both')
  // 空清单按 native，不猜。
  assert.equal(inferMode([], managed), 'native')
  assert.equal(inferMode(undefined, managed), 'native')
})
