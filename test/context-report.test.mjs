// 上下文报告的组装（宿主侧纯函数）。
//
// 这一层是**唯一**把会话日志读成"谁占了多少"的地方，面板只是把它画出来。所以它必须
// 能在没有宿主的情况下被钉住：数字从哪来、缺数时给什么、总量与构成怎么分。
//
// 三条硬要求（都有上游依据，见 lib/context-report.js 顶部）：
//   ① 构成是估算、总量是真值——两者不得互相冒充；
//   ② 缺数一律 null，不写 0（0 是一个断言："这里什么都没有"）；
//   ③ 工具定义不在 surface 上，它的价格只能来自宿主投影，读不到就报 null。
import assert from 'node:assert/strict'
import test from 'node:test'

import { MAX_ITEMS_PER_KIND, TURN_HISTORY_LIMIT, buildContextReport, foldRequestContext, foldRequestHeader, foldSessionMeta, foldSurfaceEvents, foldTurnUsage } from '../lib/context-report.js'

/** 一段最小但形状真实的会话事件：一轮里一次系统消息 + 用户 + 一次工具调用与结果。 */
function sampleEvents() {
  return [
    { type: 'session', seq: 0, time: 1000, data: { id: 'session-x', cwd: 'D:\\ws' } },
    { type: 'turn/start', seq: 1, time: 1001, data: { turn: 1 } },
    { type: 'system/message', seq: 2, time: 1002, data: { turn: 1, step: 1, message: { role: 'system', content: [{ type: 'text', text: 'y'.repeat(400) }] } } },
    { type: 'user/message', seq: 3, time: 1003, data: { message: { role: 'user', content: [{ type: 'text', text: 'u'.repeat(80) }] } } },
    { type: 'request/header', seq: 4, time: 1004, data: { header: { config: { provider: 'p', model: 'm' }, tools: [{ name: 'a' }, { name: 'b' }] } } },
    { type: 'tool/call', seq: 5, time: 1005, data: { turn: 1, step: 1, callId: 'call_1', name: 'pwsh', arguments: '{"command":"ls"}' } },
    { type: 'tool/result', seq: 6, time: 1006, data: { turn: 1, step: 1, toolCallId: 'call_1', message: { role: 'tool', content: [{ type: 'text', text: 'r'.repeat(2000) }] } } },
    { type: 'assistant/message', seq: 7, time: 1007, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, usage: { inputTokens: 400, outputTokens: 50, totalTokens: 4100, cacheReadTokens: 3600 } } },
    { type: 'session/title', seq: 8, time: 1008, data: { title: '修面板' } },
    { type: 'turn/start', seq: 9, time: 1009, data: { turn: 2 } },
    { type: 'user/message', seq: 10, time: 1010, data: { message: { role: 'user', content: [{ type: 'text', text: 'u2'.repeat(40) }] } } },
    { type: 'assistant/message', seq: 11, time: 1011, data: { turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'ok2' }] }, usage: { inputTokens: 800, outputTokens: 60, totalTokens: 5200, cacheReadTokens: 4300 } } },
  ]
}

/** 与事件配套的 measure：surface 节点的价格由宿主给（这里模拟宿主的输出）。 */
function sampleMeasurement() {
  return {
    logRevision: 12,
    baseline: { kind: 'usage', tokens: 4000 },
    surfaceDeltaTokens: 0,
    totalTokens: 4000,
    surfaceTokens: 4000,
    nodes: [
      { seq: 2, tokens: 120, heuristicTokens: 120 },
      { seq: 3, tokens: 30, heuristicTokens: 30 },
      { seq: 6, tokens: 520, heuristicTokens: 520 },
      { seq: 7, tokens: 10, heuristicTokens: 10 },
      { seq: 10, tokens: 30, heuristicTokens: 30 },
      { seq: 11, tokens: 10, heuristicTokens: 10 },
    ],
  }
}

test('buildContextReport：工具结果按工具名合并，会话内容按轮合并', () => {
  const report = buildContextReport({
    session: { id: 'session-x', cwd: 'D:\\ws' },
    events: sampleEvents(),
    context: { provider: 'p', model: 'm', contextWindow: 1000 },
    header: { tools: [{ name: 'a' }, { name: 'b' }] },
    measurement: sampleMeasurement(),
    pressure: { pressureTokens: 900, projectedTokens: 950, contextWindow: 1000 },
    breakdown: { systemTokens: 120, toolsTokens: 77, messageTokens: 300 },
  })
  const byId = new Map(report.items.map((item) => [item.id, item]))
  assert.equal(byId.get('system').tokens, 120, '系统提示词直接取 surface 价格')
  assert.equal(byId.get('tools').tokens, 77, '工具定义的价格只能来自宿主投影')
  assert.equal(byId.get('tools').count, 2, '工具数量取请求头里的定义条数')
  assert.equal(byId.get('tool:pwsh').tokens, 520, '同名工具累加')
  assert.equal(byId.get('tool:pwsh').count, 1)
  // 注意 user/message 也算「会话内容」（它不是系统提示词、也不是工具结果）。
  // 第 1 轮 = user(seq 3, 30) + assistant(seq 7, 10)；第 2 轮 = user(10, 30) + assistant(11, 10)。
  assert.equal(byId.get('turn:1').tokens, 40)
  assert.equal(byId.get('turn:1').count, 2)
  assert.equal(byId.get('turn:2').tokens, 40)
  assert.equal(byId.get('turn:2').count, 2)
})

test('buildContextReport：总量取提供方真值，构成是另一笔账（不互相冒充）', () => {
  const report = buildContextReport({
    session: { id: 's' },
    events: sampleEvents(),
    context: { provider: 'p', model: 'm', contextWindow: 1000 },
    header: { tools: [{ name: 'a' }] },
    measurement: sampleMeasurement(),
    pressure: { pressureTokens: 900, projectedTokens: 950, contextWindow: 1000 },
    breakdown: { toolsTokens: 77 },
  })
  assert.equal(report.budget.used, 900, '总量必须是提供方报告的压力值')
  assert.equal(report.budget.window, 1000)
  assert.equal(report.budget.remaining, 100)
  assert.equal(report.budget.ratio, 0.9)
  assert.equal(report.budget.projected, 950, '下一个请求的预计规模单独摆')
  // 构成之和（120 + 77 + 520 + 40 + 40 = 797）≠ 总量（900）：这是**正常**的，构成是估算。
  // 若这里相等反而说明有人把估算拿去冒充真值了。
  assert.equal(report.totals.itemTokens, 120 + 77 + 520 + 40 + 40)
  assert.notEqual(report.totals.itemTokens, report.budget.used)
})

test('buildContextReport：没有 pressure 时退回最后一次请求的 usage', () => {
  const report = buildContextReport({
    session: { id: 's' },
    events: sampleEvents(),
    context: { provider: 'p', model: 'm', contextWindow: 1000 },
    measurement: sampleMeasurement(),
  })
  // 最后一轮：inputTokens 800 + cacheReadTokens 4300。
  assert.equal(report.budget.used, 5100)
  assert.equal(report.budget.projected, null, '没有 pressure 就没有预计值，不编一个')
  assert.equal(report.cache.cacheRead, 4300)
  assert.equal(report.cache.hitRate, 4300 / 5100)
})

test('buildContextReport：容器与价格全缺时如实为空，不写 0', () => {
  const report = buildContextReport({
    session: { id: 's' },
    events: sampleEvents(),
    measurement: null,
    pressure: null,
    breakdown: null,
    context: undefined,
    header: undefined,
  })
  const tools = report.items.find((item) => item.id === 'tools')
  assert.equal(tools.tokens, null, '读不到工具价格就是 null，不能是 0')
  assert.equal(tools.count, null, '没有请求头就没有工具数量')
  assert.equal(report.budget.window, null)
  assert.equal(report.budget.ratio, null)
  assert.equal(report.totals.measured, false)
  // 不再产出"给用户看的解释"：缺数一律用 null 表达，由面板决定怎么呈现（破折号 / 单位"字符"）。
  // 早先每条降级原因都会写进 report.notes 再渲染在面板底部，用户称之为"废话"。
  assert.equal('notes' in report, false, '报告里不该再有 notes 字段')
})

test('buildContextReport：surface 节点没有价格时保持 null（不被 0 吃掉）', () => {
  const measurement = sampleMeasurement()
  // 让工具结果那一条没有价格（宿主在某些降级路径上会这样）。
  measurement.nodes = measurement.nodes.map((node) => (node.seq === 6 ? { seq: 6 } : node))
  const report = buildContextReport({ session: { id: 's' }, events: sampleEvents(), measurement })
  const tool = report.items.find((item) => item.id === 'tool:pwsh')
  assert.equal(tool.tokens, null, '缺价格的那一项必须是 null，而不是 0')
  assert.equal(tool.chars, 2000, '字符账仍然要在（用来核对"为什么这么大"）')
  assert.equal(report.totals.measured, false, '有一项缺价就不算完整计价')
})

test('foldTurnUsage：每轮取最后一次请求的提示词规模，同时给出计费口径', () => {
  const { turns, billed } = foldTurnUsage(sampleEvents())
  assert.deepEqual(turns.map((turn) => turn.turn), [1, 2])
  assert.equal(turns[0].prompt, 4000, '第 1 轮：input 400 + cacheRead 3600')
  assert.equal(turns[1].prompt, 5100)
  assert.equal(turns[1].requests, 1)
  // 计费口径是各次之和，与"上下文有多大"是两件事。
  assert.equal(billed.prompt, 9100)
  assert.equal(billed.requests, 2)
})

test('foldTurnUsage：同一轮多次请求取末次，不求和', () => {
  const events = [
    { type: 'assistant/message', time: 1, data: { turn: 1, usage: { inputTokens: 100, cacheReadTokens: 0, outputTokens: 10, totalTokens: 110 } } },
    { type: 'assistant/message', time: 2, data: { turn: 1, usage: { inputTokens: 300, cacheReadTokens: 200, outputTokens: 20, totalTokens: 520 } } },
  ]
  const { turns, billed } = foldTurnUsage(events)
  assert.equal(turns.length, 1)
  assert.equal(turns[0].prompt, 500, '取末次的 300+200')
  assert.equal(turns[0].requests, 2, '但要记下这一轮发了几次')
  assert.equal(billed.prompt, 600, '计费口径才是求和')
})

test('foldSessionMeta：标题取最后一个，请求数与步数如实计数', () => {
  const meta = foldSessionMeta(sampleEvents())
  assert.equal(meta.title, '修面板')
  assert.equal(meta.requests, 1)
  assert.equal(meta.steps, 0, '样本里没有 step/start，不编数')
  assert.equal(foldSessionMeta([]).title, null)
})

test('buildContextReport：条目按**分类固定顺序**输出，分类内按大小降序', () => {
  // 真机反馈："剩余的为啥显示在左边啊，有点反直觉"——那是纯按面积降序的必然结果。
  // 现在按分类固定顺序输出（system → tools → tool-result → attachment → conversation），
  // 图里第几块与图例第几项永远对得上；分类**内部**仍按大小降序，所以每类里最大的在最前。
  const report = buildContextReport({
    session: { id: 's' },
    events: sampleEvents(),
    measurement: sampleMeasurement(),
    breakdown: { toolsTokens: 77 },
  })
  const order = ['system', 'tools', 'tool-result', 'attachment', 'conversation']
  const kindsInOrder = report.items.map((item) => item.kind)
  const expectedOrder = kindsInOrder.slice().sort((left, right) => order.indexOf(left) - order.indexOf(right))
  assert.deepEqual(kindsInOrder, expectedOrder, '条目的分类顺序必须是固定顺序')

  // 分类内按大小降序。
  for (const kind of order) {
    const sizes = report.items.filter((item) => item.kind === kind).map((item) => item.tokens ?? item.chars ?? 0)
    const sorted = sizes.slice().sort((left, right) => right - left)
    assert.deepEqual(sizes, sorted, `${kind} 类内部必须按大小降序`)
  }
  // 分类合计的顺序同样固定，图例直接消费它。
  assert.deepEqual(report.kinds.map((entry) => entry.kind), report.kinds.map((entry) => entry.kind).slice().sort((left, right) => order.indexOf(left) - order.indexOf(right)))
})

// ── 磁盘会话：没有 tokenMeter 也要能画出构成 ─────────────────────────────────
//
// 真机缺陷（本轮修的就是它）：历史会话不在活存储里，只能读磁盘。没有 Session 对象就
// 没有节点价格，而最初的实现只在"有节点价格"时才构造条目——于是磁盘会话的 treemap
// 只剩「工具定义」一块（截图里就是两块：工具定义 + 剩余空间），等于没画。
// 现在退回**按事件折 surface + 按字符度量**，构成至少是完整的。
test('没有节点价格时按事件折出构成，且不编任何 token 数', () => {
  const report = buildContextReport({
    session: { id: 'disk-session' },
    events: sampleEvents(),
    // 磁盘会话的输入：context/header 都从事件折，measurement 缺席。
    context: foldRequestContext(sampleEvents()),
    header: foldRequestHeader(sampleEvents()),
    measurement: null,
  })
  const kinds = new Set(report.items.map((item) => item.kind))
  assert.ok(kinds.has('system'), '系统提示词必须出现（否则构成不完整）')
  assert.ok(kinds.has('tool-result'), '工具结果必须出现')
  assert.ok(kinds.has('conversation'), '会话内容必须出现')
  assert.ok(kinds.has('tools'), '工具定义也要在（它的价格未知但不该消失）')
  // 一条都不能有 token：没有价格就是 null，不能凭空造数。
  for (const item of report.items) {
    if (item.kind === 'tools') continue
    assert.equal(item.tokens, null, `${item.id} 不该有 token 数`)
    assert.ok(item.chars > 0, `${item.id} 必须有字符账`)
  }
  assert.equal(report.totals.measured, false, '没有价格时 measured 必须是 false')
  // 总量仍然来自日志里的真实 usage（那是提供方报的，不是估算）。
  assert.equal(report.budget.used, 5100)
})

test('磁盘会话：从事件折出路由与工具定义（两条路同一形状）', () => {
  // sampleEvents 里有 request/header 但没有 request/context（前者每次请求都写，后者只在
  // 路由解析完成时写）。这里各自喂最小的事件集合，避免把"折取"与"样本完整性"混在一起。
  const header = foldRequestHeader(sampleEvents())
  assert.equal(header.tools.length, 2)
  const context = foldRequestContext([
    { type: 'request/context', seq: 90, data: { provider: 'p', model: 'm', contextWindow: 1000 } },
  ])
  assert.equal(context.provider, 'p')
  assert.equal(context.contextWindow, 1000)
  // 折不到时返回 undefined（不是空对象），让下游用同一套缺省逻辑。
  assert.equal(foldRequestContext([]), undefined)
  assert.equal(foldRequestHeader([]), undefined)
})

test('foldSurfaceEvents：收四类 surface 事件，user 消息按其后那条 assistant 的轮次归属', () => {
  const surface = foldSurfaceEvents(sampleEvents())
  // 分类只有五类里参与 surface 的这几种（user/assistant 都是 conversation）。
  assert.deepEqual(surface.map((entry) => entry.kind), ['system', 'conversation', 'tool-result', 'conversation', 'conversation', 'conversation'])
  // 第 1 轮的 user（seq 3）与第 1 轮的 assistant（seq 7）都要归到 turn 1。
  assert.deepEqual(surface.filter((entry) => entry.kind === 'conversation').map((entry) => entry.turn), [1, 1, 2, 2])
})

// ── 真实日志形状回归 ─────────────────────────────────────────────────────────
//
// 下面三条全部来自**真机会话日志**的实测形状，不是手搓的夹具。它们各自对应一次
// 真机缺陷：夹具写得像实现、实现写得像夹具，于是单测全绿而面板上是错的。

test('真实形状：tool/result 的 callId 在 data.message 里（顶层没有）', () => {
  // 真机日志原样（字段位置就是缺陷所在）：data 只有 turn/step/message/meta，
  // callId 在 message 上。曾经读顶层 → 447 个工具结果全部成了"未知工具"。
  const events = [
    { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
    { type: 'tool/call', seq: 2, time: 2, data: { turn: 1, step: 1, callId: 'call_abc', name: 'pwsh', arguments: '{}' } },
    {
      type: 'tool/result',
      seq: 3,
      time: 3,
      data: {
        turn: 1,
        step: 1,
        message: { role: 'tool', source: { kind: 'tool', callId: 'call_abc' }, toolCallId: 'call_abc', content: [{ type: 'text', text: 'x'.repeat(100) }] },
        meta: {},
      },
    },
  ]
  const report = buildContextReport({ session: { id: 's' }, events, measurement: null })
  const tool = report.items.find((item) => item.kind === 'tool-result')
  assert.equal(tool.label, 'pwsh', `工具结果必须匹配到名字，实际 ${tool.label}`)
  assert.equal(tool.count, 1)
  assert.ok(tool.chars > 0)
})

test('真实形状：user/message 不带 turn，按其后那条 assistant 的 turn 归属', () => {
  // 真机：fork/恢复过的会话只有一条 turn/start（turn=1），而 assistant/message 的 turn
  // 已经到了 15。只信 turn/start 会把所有用户消息塞进第 1 轮。
  const events = [
    { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: 2, data: { message: { role: 'user', content: [{ type: 'text', text: '第一轮的问题' }] } } },
    { type: 'assistant/message', seq: 3, time: 3, data: { turn: 1, step: 1, message: { role: 'assistant', content: [] }, usage: { inputTokens: 100, outputTokens: 1, totalTokens: 101, cacheReadTokens: 0 } } },
    { type: 'user/message', seq: 4, time: 4, data: { message: { role: 'user', content: [{ type: 'text', text: '第十五轮的问题' }] } } },
    { type: 'assistant/message', seq: 5, time: 5, data: { turn: 15, step: 1, message: { role: 'assistant', content: [] }, usage: { inputTokens: 200, outputTokens: 1, totalTokens: 201, cacheReadTokens: 0 } } },
  ]
  const report = buildContextReport({ session: { id: 's' }, events, measurement: null })
  const turns = report.items.filter((item) => item.kind === 'conversation').map((item) => item.turn).sort((left, right) => left - right)
  assert.deepEqual(turns, [1, 15], `用户消息要归到各自那一轮，实际 ${JSON.stringify(turns)}`)
  const turn15 = report.items.find((item) => item.turn === 15)
  assert.equal(turn15.count, 2, '第 15 轮含用户消息 + assistant 消息')
})

test('真实形状：system/message 多次改写取最后一条；developer/message 要累加', () => {
  // 真机：5 条 system/message（提示词被改写多次）+ 4 条 developer/message。
  // 前者只有最后一条生效；后者条数不定、要累加。混用一个累加器会让后者覆盖前者。
  const events = [
    { type: 'system/message', seq: 1, time: 1, data: { message: { role: 'system', content: [{ type: 'text', text: 'OLD PROMPT' }] } } },
    { type: 'system/message', seq: 2, time: 2, data: { message: { role: 'system', content: [{ type: 'text', text: 'NEW PROMPT' }] } } },
    { type: 'developer/message', seq: 3, time: 3, data: { message: { role: 'developer', content: [{ type: 'text', text: 'rule one' }] } } },
    { type: 'developer/message', seq: 4, time: 4, data: { message: { role: 'developer', content: [{ type: 'text', text: 'rule two' }] } } },
  ]
  const report = buildContextReport({ session: { id: 's' }, events, measurement: null })
  const system = report.items.find((item) => item.id === 'system')
  assert.ok(system, '系统提示词必须在')
  assert.equal(system.preview, 'NEW PROMPT', '只有最后一条 system/message 生效（preview 是它的首行）')
  assert.equal(system.chars, 'NEW PROMPT'.length, '不得把旧提示词也算进去')
  // 分类合计也必须只算最后一条：真机上图例曾是 120K、明细 24.7K，两个数自相矛盾。
  const systemKind = report.kinds.find((entry) => entry.kind === 'system')
  assert.equal(systemKind.chars, 'NEW PROMPT'.length, '图例的系统提示词合计也必须只算生效的那条')
})

test('真实形状：developer/message 并入「工具定义」，不单列成用户看不懂的一条', () => {
  // 真机日志里 `developer/message` 的 `source.kind` 是 `tool-registry`——它是工具注册表的
  // 说明消息。**不单列**：用户不需要知道"宿主管这叫注册消息"，他只关心"工具这一块总共占多少"。
  // 早期版本把它列成独立一条「工具注册消息」，等于把同一个答案拆成两半还多了一个术语。
  const base = [
    { type: 'request/header', seq: 1, time: 1, data: { header: { tools: [{ name: 'a' }] } } },
  ]
  const withRegistry = [
    ...base,
    { type: 'developer/message', seq: 3, time: 3, data: { message: { role: 'developer', content: [{ type: 'text', text: 'x'.repeat(100) }] } } },
  ]
  const without = buildContextReport({ session: { id: 's' }, events: base, measurement: null })
  const withIt = buildContextReport({ session: { id: 's' }, events: withRegistry, measurement: null })
  const toolItem = (report) => report.items.find((item) => item.id === 'tools')
  assert.ok(toolItem(without), '工具定义那一行要在')
  assert.equal(withIt.items.filter((item) => item.kind === 'tools').length, 1, 'tools 类只有一行')
  assert.ok(toolItem(withIt).chars > toolItem(without).chars, '注册消息的字符要并进工具定义')
})

// ── 真实日志形状回归（续）──────────────────────────────────────────────────────
//
// 下面两条是**两条独立的真机缺陷**，都只在真实日志上才暴露：
//   ① `user/message` 的 data **直接就是消息**（没有 `.message` 包装），只读 `data.message`
//      会让 28 条用户消息一条都进不了构成；
//   ② `user/message` 不带 turn 字段，轮次只能靠"其后那条 assistant"或 `turn/start` 游标。

test('真实形状：user/message 的 data 直接是消息（没有 message 包装）', () => {
  const events = [
    { type: 'turn/start', seq: 1, time: 1, data: { turn: 3 } },
    // 真机形状：content/role/source 直接挂在 data 上。
    { type: 'user/message', seq: 2, time: 2, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'x'.repeat(400) }] } },
    { type: 'assistant/message', seq: 3, time: 3, data: { turn: 3, step: 1, message: { role: 'assistant', content: [] }, usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11, cacheReadTokens: 0 } } },
  ]
  for (const measurement of [null, { surfaceTokens: 10, nodes: [{ seq: 2, tokens: 100 }, { seq: 3, tokens: 5 }] }]) {
    const report = buildContextReport({ session: { id: 's' }, events, measurement })
    const turn3 = report.items.find((item) => item.id === 'turn:3')
    assert.ok(turn3, `用户消息必须计入构成（measurement=${measurement ? '有' : '无'}）`)
    assert.equal(turn3.count, 2, '用户消息与 assistant 都在这一轮')
    // 400 字符的正文必须真的进账，不能被当成空消息丢掉。
    assert.ok(turn3.chars >= 400, `用户消息的正文要计入字符账，实际 ${turn3.chars}`)
  }
})

test('真实形状：user/message 没有 turn 字段时按其后的 assistant 归属', () => {
  const events = [
    { type: 'turn/start', seq: 1, time: 1, data: { turn: 7 } },
    { type: 'user/message', seq: 2, time: 2, data: { message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } } },
    { type: 'assistant/message', seq: 3, time: 3, data: { turn: 7, step: 1, message: { role: 'assistant', content: [] }, usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11, cacheReadTokens: 0 } } },
  ]
  // 有价格与无价格两条路都要给出同一个轮次——那正是"轮次解析只有一处"的意义。
  for (const measurement of [null, { surfaceTokens: 10, nodes: [{ seq: 2, tokens: 5 }, { seq: 3, tokens: 5 }] }]) {
    const report = buildContextReport({ session: { id: 's' }, events, measurement })
    const turn7 = report.items.find((item) => item.id === 'turn:7')
    assert.ok(turn7, `用户消息必须归到第 7 轮（measurement=${measurement ? '有' : '无'}）`)
    assert.equal(turn7.count, 2, '用户消息与 assistant 消息都在这一轮')
  }
})

// ── 数据层不产出界面文案 ───────────────────────────────────────────────────────
//
// 这条守的是**分层**，不是某个具体字符串：报告是数据，措辞归客户端（`t()` 只在那里）。
// 宿主曾经拼过 `'×' + count`、`count + ' 条消息'`、`'未知工具'`、`'第 N 轮'`——中文界面看不出
// 问题，切成 English 后这几处原样漏中文，而两边单测各自都绿（一边断言字符串、一边断言 DOM）。
// 判据：这里出去的中文，客户端再也翻不了。
test('报告只带事实：条目里没有 label / sublabel 这类界面文案（工具名除外）', () => {
  const report = buildContextReport({
    session: { id: 's' },
    events: sampleEvents(),
    header: { tools: [{ name: 'a' }, { name: 'b' }] },
    measurement: sampleMeasurement(),
    breakdown: { toolsTokens: 77 },
  })
  for (const item of report.items) {
    assert.equal('sublabel' in item, false, `${item.id} 不该带 sublabel（措辞归客户端）`)
    if (item.kind === 'tool-result') continue
    assert.equal('label' in item, false, `${item.id}（${item.kind}）不该带 label`)
    assert.equal('preview' in item, item.kind === 'system', `${item.id} 只有系统提示词可以带 preview（首行是内容）`)
  }
  for (const kind of report.kinds) {
    assert.equal('label' in kind, false, `分类合计 ${kind.kind} 不该带 label`)
  }
  // 工具名是**标识符**（模型看到的就是它），必须原样保留——翻译它反而让人对不上号。
  const tool = report.items.find((item) => item.kind === 'tool-result')
  assert.equal(tool.label, 'pwsh', '工具名必须原样带出来')
})

test('报告：解析不到工具名时 label 为 null，由客户端说"未知工具"', () => {
  // 真机踩过：callId 读错层级时 447 条工具结果全变成同一行「未知工具」，而那个字符串是
  // 宿主写死的中文。现在宿主只说"我不知道名字"，措辞交给客户端。
  const events = [
    { type: 'tool/result', seq: 1, time: 1, data: { message: { role: 'tool', content: [{ type: 'text', text: 'x' }] } } },
  ]
  const report = buildContextReport({ session: { id: 's' }, events, measurement: null })
  const item = report.items.find((entry) => entry.kind === 'tool-result')
  assert.ok(item, '没名字的工具结果仍要计入构成')
  assert.equal(item.label, null, '名字未知就是 null，不写一句中文')
})

// ── 轮询成本：报告不能随会话长度线性长大 ───────────────────────────────────────
//
// 这一面每 3 秒走一次 wire。真机 1500 轮的会话，不封顶时一份报告是 **287KB**
// （items 1504 条 + turns 1500 条），也就是开着面板约 95KB/s、外加每 3 秒一次 JSON 解析。
// 所以宿主侧封顶，客户端侧只负责把"被折叠多少"如实说出来。
function longSession(turns) {
  const events = []
  let seq = 0
  const push = (type, data) => events.push({ seq: seq++, time: seq, type, data })
  push('request/context', { provider: 'p', model: 'm', contextWindow: 100000 })
  for (let turn = 1; turn <= turns; turn += 1) {
    push('turn/start', { turn })
    push('user/message', { role: 'user', content: [{ type: 'text', text: 'q'.repeat(40) }] })
    push('assistant/message', { turn, message: { role: 'assistant', content: [{ type: 'text', text: 'a'.repeat(40) }] }, usage: { inputTokens: 1000 + turn, cacheReadTokens: 0, outputTokens: 10, totalTokens: 1010 } })
    push('turn/end', { turn })
  }
  return events
}

test('报告：明细每类封顶，被折叠的条数与**全量**合计都如实上报', () => {
  const events = longSession(60)
  const report = buildContextReport({ session: { id: 's' }, events, context: { contextWindow: 100000 }, pressure: { pressureTokens: 5000, contextWindow: 100000 } })
  const conversationItems = report.items.filter((item) => item.kind === 'conversation')
  assert.equal(conversationItems.length, MAX_ITEMS_PER_KIND, `每类最多带 ${MAX_ITEMS_PER_KIND} 条（wire 成本）`)
  const kind = report.kinds.find((entry) => entry.kind === 'conversation')
  assert.equal(kind.count, 60, '真实条数必须是 60，不因封顶而变小')
  assert.equal(kind.folded, 60 - MAX_ITEMS_PER_KIND, '被折叠的条数要单独报，客户端据此写"其余 N 项"')
  // 封顶只影响 `items`，不影响任何合计：`surfaceChars` / `itemTokens` 必须是全量，
  // 否则客户端把估算换算到真实总量时，会用封顶后的和当分母，把缺口摊到剩下的条目上。
  const kindChars = report.kinds.reduce((sum, entry) => sum + (entry.chars ?? 0), 0)
  assert.equal(report.totals.surfaceChars, kindChars, '全量字符合计与分类合计必须一致（封顶前）')
  const carriedChars = report.items.reduce((sum, item) => sum + (item.chars ?? 0), 0)
  assert.ok(report.totals.surfaceChars > carriedChars, '合计必须**大于**随报告带过来的那些（否则就是在按封顶后的账算）')
})

test('报告：逐轮用量只带最近 120 轮，总数另给 turnTotal', () => {
  const report = buildContextReport({ session: { id: 's' }, events: longSession(200), context: { contextWindow: 100000 } })
  assert.equal(report.turns.length, TURN_HISTORY_LIMIT, '逐轮明细要封顶（面板只画最近 60 根柱）')
  assert.equal(report.turnTotal, 200, '总轮数单独报，脚注的"N 轮"读它')
  assert.equal(report.turns[report.turns.length - 1].turn, 200, '保留的是**最近**那一段')
  assert.equal(report.turns[0].turn, 200 - TURN_HISTORY_LIMIT + 1)
  // 封顶不能影响"最近一轮"的读数：总量仍取最后一轮的提示词规模。
  assert.equal(report.budget.used, 1200, 'used 仍来自第 200 轮（inputTokens 1000 + turn）')
})

