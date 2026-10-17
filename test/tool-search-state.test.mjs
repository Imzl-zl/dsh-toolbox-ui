import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import {
  PROJECTION_KEY,
  createState,
  discover,
  discoveredFromMessages,
  discoveryProjection,
  evict,
  foldEvent,
  parseDiscoveredMeta,
  projectionBound,
  seed,
  sizeOf,
  touch,
  versionOf,
} from '../lib/tool-search-state.js'

// 发现集状态：LRU（`Map<name, tick>`，B7）+ 投影 fold（C4）。
// 这里的每个数字都能在 DECISIONS §2.1 的验算表里找到对应行；`evict` 的三步收敛
// 是"最多踢一半"这条上限唯一真正生效的场景，所以它必须被钉住。

const names = (prefix, count) => Array.from({ length: count }, (_, index) => `${prefix}${index}`)

test('discover: 新名字按顺序播种 tick，重复发现不改 tick', () => {
  const state = createState()
  assert.deepEqual(discover(state, ['a', 'b']), ['a', 'b'])
  assert.equal(sizeOf(state), 2)
  // 已有的名字再次出现不算新发现（execute 用它决定"本次新增了哪些"）。
  assert.deepEqual(discover(state, ['b', 'c']), ['c'])
  assert.equal(sizeOf(state), 3)
  // 同一次里重复的名字只算一次。
  assert.deepEqual(discover(state, ['d', 'd']), ['d'])
  assert.equal(sizeOf(state), 4)
})

test('touch: 只刷新已发现的，未发现的不被顺手加进去', () => {
  const state = createState()
  discover(state, ['a', 'b', 'c'])
  const before = versionOf(state)
  touch(state, 'a')
  touch(state, 'ghost')
  assert.equal(sizeOf(state), 3, 'touch 不得扩大发现集')
  assert.equal(versionOf(state), before, 'touch 不改成员，目录文本缓存键不该失效')
  // a 原本最旧；被 touch 之后 evict(2) 必须踢 b 而不是 a。
  assert.deepEqual(evict(state, 2), ['b'], '被 touch 过的名字必须活过淘汰')
  assert.deepEqual([...state.discovered.keys()].sort(), ['a', 'c'])
})

test('evict: DECISIONS §2.1 的收敛表（21→踢 1 / 31→踢 11 / 100→50→25→20）', () => {
  // 21 个、cap 20：deficit 1、k=10 → 踢 1（与旧 FIFO 行为相同）。
  const c21 = createState()
  discover(c21, names('t', 21))
  assert.equal(evict(c21, 20).length, 1)
  assert.equal(sizeOf(c21), 20)

  // 31 个、cap 20：deficit 11、k=15 → 踢 11（一步到 cap）。
  const c31 = createState()
  discover(c31, names('t', 31))
  assert.equal(evict(c31, 20).length, 11)
  assert.equal(sizeOf(c31), 20)

  // 100 个、cap 20：deficit(80) > 一半(50) → 一半上限真正生效，三步收敛。
  const c100 = createState()
  discover(c100, names('t', 100))
  assert.equal(evict(c100, 20).length, 50)
  assert.equal(sizeOf(c100), 50)
  assert.equal(evict(c100, 20).length, 25)
  assert.equal(sizeOf(c100), 25)
  assert.equal(evict(c100, 20).length, 5, '最后一步只需踢到 cap 为止，不许多踢')
  assert.equal(sizeOf(c100), 20)
  // 已在 cap 以内：不动，也不返名字。
  assert.deepEqual(evict(c100, 20), [])
})

test('evict: 刚发现的一批永远排在最新端（B8 播种的验收）', () => {
  // 一次 select: 8 个、之后再也不碰。纯 LRU 会把这批按"最近使用"一起排到最旧端并同时踢掉；
  // B8 在**发现时**就播种 lastUsed，所以它们一定比之前发现的更"新"——而且要比
  // 过去用过几次的旧工具还新（这才是"发现即播种"与"按插入序排队"的区别）。
  const state = createState()
  discover(state, names('old', 12))
  touch(state, 'old0')
  touch(state, 'old1')
  const batch = names('batch', 8)
  discover(state, batch)
  assert.equal(sizeOf(state), 20, '正好等于上限，不该淘汰')
  assert.deepEqual(evict(state, 20), [])

  discover(state, ['one-more'])
  const removed = evict(state, 20)
  assert.equal(removed.length, 1, 'deficit 1 → 只踢 1')
  // 最冷的是 old2：old0/old1 被用过（更新），batch 与 one-more 是刚发现的（更新）。
  assert.deepEqual(removed, ['old2'], '踢的是最冷的，不是刚发现的一批，也不是插入序最靠前的')
  for (const name of batch) assert.equal(state.discovered.has(name), true, `${name} 必须存活`)
})

test('evict: 返回被淘汰的名字，且淘汰后版本号前进（目录文本要重算）', () => {
  const state = createState()
  discover(state, ['a', 'b', 'c'])
  const before = versionOf(state)
  assert.deepEqual(evict(state, 2), ['a'])
  assert.notEqual(versionOf(state), before, '成员变了，目录文本缓存键必须变')
  assert.deepEqual([...state.discovered.keys()].sort(), ['b', 'c'])
})

test('seed: 按发现顺序播种，最旧的先被淘汰', () => {
  // 恢复时 lastUsed 按 SEED 顺序给（C4：不持久化 lastUsed，自愈靠用一次刷新）。
  const state = createState()
  seed(state, ['x', 'y', 'z'])
  assert.equal(sizeOf(state), 3)
  assert.deepEqual(evict(state, 2), ['x'], '播种顺序就是新旧顺序')
  // 播种后 tick 不能从 0 重新开始，否则新发现的会比恢复的还"旧"。
  discover(state, ['new'])
  assert.deepEqual(evict(state, 2), ['y'])
  assert.deepEqual([...state.discovered.keys()].sort(), ['new', 'z'])
})

test('versionOf: 只有成员变化才前进（touch 不算）', () => {
  const state = createState()
  const v0 = versionOf(state)
  discover(state, ['a'])
  const v1 = versionOf(state)
  assert.notEqual(v1, v0)
  discover(state, ['a'])
  assert.equal(versionOf(state), v1, '没有新名字就不算变化')
  touch(state, 'a')
  assert.equal(versionOf(state), v1, 'touch 不算成员变化')
})

// ── 投影 fold（C4 / F18–F20）──

const withProtocol = (value) => ({ protocol: 'dsh-tool-search/v1', ...value })

/** `tool/result` 的真实载荷形状（dsh-session types.d.ts:374）。 */
const toolResult = (value, { isError = false } = {}) => ({
  type: 'tool/result',
  seq: 1,
  time: 0,
  data: {
    turn: 0,
    step: 0,
    message: {
      role: 'tool',
      toolCallId: 'c1',
      isError,
      source: { kind: 'tool', callId: 'c1' },
      content: [{ type: 'text', text: JSON.stringify(value) }],
    },
  },
})

/** `tool/ptc-dispatch` 的真实载荷形状（dsh-tools types.d.ts:17 / :58）。 */
const ptcDispatch = (name, value, { isError = false } = {}) => ({
  type: 'tool/ptc-dispatch',
  seq: 2,
  time: 0,
  data: {
    parentCallId: 'p1',
    subCallId: 'p1:ptc:0',
    name,
    arguments: {},
    isError,
    content: [{ type: 'text', text: JSON.stringify(value) }],
  },
})

const OPTS = { toolName: 'tool_search', max: 100 }
const init = () => ({ discovered: [] })

test('foldEvent: native 的 tool/result 与 PTC 的 tool/ptc-dispatch 都识别', () => {
  // PTC 下搜索发生在程序内部，只留 tool/ptc-dispatch 事件（它不在 surface 事件集里，
  // 所以 deriveMessages 看不到它——这正是要用投影的原因，F18）。
  const fromNative = foldEvent(init(), toolResult(withProtocol({ allDiscoveredTools: ['mcp__a__x'] })), OPTS)
  assert.deepEqual(fromNative.discovered, ['mcp__a__x'])

  const fromPtc = foldEvent(init(), ptcDispatch('tool_search', withProtocol({ allDiscoveredTools: ['mcp__a__y'] })), OPTS)
  assert.deepEqual(fromPtc.discovered, ['mcp__a__y'])
})

test('foldEvent: 别人的工具结果、错误结果、别的 protocol 一律不认', () => {
  const state = init()
  assert.equal(foldEvent(state, ptcDispatch('other_tool', withProtocol({ allDiscoveredTools: ['x'] })), OPTS), state)
  assert.equal(foldEvent(state, toolResult(withProtocol({ allDiscoveredTools: ['x'] }), { isError: true })), state)
  assert.equal(foldEvent(state, ptcDispatch('tool_search', withProtocol({ allDiscoveredTools: ['x'] }), { isError: true }), OPTS), state)
  assert.equal(foldEvent(state, toolResult({ protocol: 'someone-else/v1', allDiscoveredTools: ['x'] })), state)
  assert.equal(foldEvent(state, toolResult('not json at all')), state)
  assert.equal(foldEvent(state, { type: 'assistant/message', seq: 3, time: 0, data: {} }), state)
})

test('foldEvent: 没有新名字时返回**同一个引用**（注册表按引用变化通知）', () => {
  // 宿主文档：未关心的新事件必须返回同一引用，否则每次事件都会产生下游工作。
  const first = foldEvent(init(), toolResult(withProtocol({ allDiscoveredTools: ['a'] })), OPTS)
  assert.equal(foldEvent(first, toolResult(withProtocol({ allDiscoveredTools: ['a'] })), OPTS), first)
  assert.equal(foldEvent(first, toolResult(withProtocol({ discoveredTools: ['a'] })), OPTS), first, '换字段名同样不重复')
  // 新增才换引用。
  const next = foldEvent(first, toolResult(withProtocol({ allDiscoveredTools: ['a', 'b'] })), OPTS)
  assert.notEqual(next, first)
  assert.deepEqual(next.discovered, ['a', 'b'])
})

test('foldEvent: 结果按 max 从旧到新剪枝（状态必须有界）', () => {
  const opts = { toolName: 'tool_search', max: 3 }
  let state = init()
  for (const name of ['a', 'b', 'c', 'd', 'e']) {
    state = foldEvent(state, toolResult(withProtocol({ allDiscoveredTools: [name] })), opts)
  }
  assert.deepEqual(state.discovered, ['c', 'd', 'e'], '只留最新的 max 个，旧的先丢')
  // 一次事件里塞进超过 max 的名字同样被剪。
  const bulk = foldEvent(init(), toolResult(withProtocol({ allDiscoveredTools: ['1', '2', '3', '4'] })), opts)
  assert.deepEqual(bulk.discovered, ['2', '3', '4'])
})

test('foldEvent: apply 恒返回状态对象（写成 undefined 会把状态设成 undefined）', () => {
  const projection = discoveryProjection({ z, toolName: 'tool_search', max: 100 })
  for (const event of [
    { type: 'turn/start', seq: 1, time: 0, data: {} },
    toolResult('garbage'),
    { type: 'tool/ptc-dispatch', seq: 2, time: 0 },
    null,
  ]) {
    const out = projection.apply(projection.init({}, 0), event)
    assert.equal(typeof out, 'object')
    assert.ok(out !== null, 'apply 不得返回 null')
    assert.ok(Array.isArray(out.discovered), 'apply 返回值必须带 discovered 数组')
  }
})

test('discoveryProjection: 定义面符合宿主契约，状态是纯 JSON', () => {
  const projection = discoveryProjection({ z, toolName: 'tool_search', max: 100 })
  assert.equal(projection.key, PROJECTION_KEY)
  assert.equal(projection.stateVersion, 1)
  assert.equal(projection.wire, undefined, '内部投影不暴露给客户端（无 wire 重载）')
  assert.equal(typeof projection.init, 'function')
  assert.equal(typeof projection.apply, 'function')
  // stateSchema 是宿主的两处校验入口：从持久化行恢复时 parse 一次。
  assert.deepEqual(projection.stateSchema.parse({ discovered: ['a'] }), { discovered: ['a'] })
  assert.throws(() => projection.stateSchema.parse({ discovered: 'nope' }))
  // 空日志的初始状态必须是可 JSON 往返的（宿主按纯 JSON 持久化）。
  const state = projection.init({}, 0)
  assert.deepEqual(JSON.parse(JSON.stringify(state)), state)
})

test('projectionBound: 有界剪枝的上限公式', () => {
  // max(maxDiscovered*4, 100)：常态由默认 20 决定 → 100；调大到 40 → 160。
  assert.equal(projectionBound(20), 100)
  assert.equal(projectionBound(40), 160)
  assert.equal(projectionBound(1), 100, '下限 100：太小的上限会让恢复集比运行集还小')
})

test('parseDiscoveredMeta / discoveredFromMessages: 迁到 state 模块后行为不变', () => {
  // 这两个是"发现集长什么样"的定义，与 fold 同住一个模块（协议 + 解析器 + fold 必须同步）。
  assert.deepEqual(parseDiscoveredMeta(withProtocol({ allDiscoveredTools: ['x'] })), ['x'])
  assert.equal(parseDiscoveredMeta({ protocol: 'other/v1' }), undefined)
  const messages = [{
    role: 'tool',
    isError: false,
    content: [{ type: 'text', text: JSON.stringify(withProtocol({ discoveredTools: ['mcp__a__x'] })) }],
  }]
  assert.deepEqual([...discoveredFromMessages(messages)], ['mcp__a__x'])
})
