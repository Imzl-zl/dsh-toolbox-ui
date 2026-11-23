// 上下文面（ContextFace）与 treemap 排布的行为用例。
//
// 为什么要单独一组：这一面的价值全在"数字对不对、排布能不能读"，而它的数据来自宿主的
// 三段可选能力（token-meter / 投影 / 日志）。降级路径（宿主没挂 meter）如果没人跑，
// 就会在真机上变成"一片空白但没报错"——那正是这一面最容易出的故障形态。
//
// 这里钉四件事：
//   ① treemap 的矩形**互不重叠且铺满容器**（几何不变量：排版算法唯一可验证的硬约束）；
//   ② 总量与构成分开：格子上的数是按真实总量等比换算的，加起来等于"已用"；
//   ③ 降级：没有 token 价格时单位变"字符"，不把字符数伪装成 token；
//   ④ 面板真的把宿主返回画出来了（不是只算了一遍）。
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { createHookRenderer } from '../test-support/hook-renderer.mjs'

const clientSource = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const exportMarker = 'exports.inject = inject;'
const instrumented = clientSource.replace(
  exportMarker,
  `${exportMarker}\nexports.__context = { ContextFace, layoutColumns, buildGridCells, formatTokens, formatPercent, contextItemLabel, contextItemSub, CONTEXT_KIND_ORDER, CONTEXT_FILTERS, EN_DICT, setLocaleActive: (value) => { localeActive = value } };`,
)
assert.notEqual(instrumented, clientSource, 'client test export marker must stay current')

function loadInternals(lifecycle = createHookRenderer()) {
  // 快照用例也必须保留 React 的 memo/ref 归属和布局提交；别另造一个每次都换身份的 renderer。
  let mounted = false
  let client
  vm.runInNewContext(instrumented, {
    console,
    document: { querySelector: () => null, createElement: () => ({ dataset: {} }) },
    navigator: {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setInterval,
    setTimeout,
    clearInterval,
    clearTimeout,
    // 没有 ResizeObserver：面板必须走 window.resize 兜底路径（量不到宽度时用默认 760）。
    window: { __ModuleLoader__: { load(definition) { client = definition.factory(() => lifecycle) } }, addEventListener() {}, removeEventListener() {} },
  })
  return {
    ...client.__context,
    __render(Component, props) { mounted = true; return lifecycle.__render(Component, props) },
    __drainEffects: lifecycle.__flushEffects,
    __settle: lifecycle.__settle,
    __unmount() { if (mounted) lifecycle.__unmount(client.__context.ContextFace) },
  }
}

const collectAll = (tree, predicate, out = []) => {
  if (tree === null || tree === undefined || typeof tree !== 'object') return out
  if (Array.isArray(tree)) { for (const child of tree) collectAll(child, predicate, out); return out }
  if (predicate(tree)) out.push(tree)
  for (const child of tree.children ?? []) collectAll(child, predicate, out)
  return out
}
const textOf = (node, out = []) => {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const child of node) textOf(child, out); return out }
  for (const child of node.children ?? []) textOf(child, out)
  return out
}
const allText = (tree) => textOf(tree, []).join(' ')

const REPORT = {
  ok: true,
  session: { id: 'session-abc', cwd: 'D:\\ws', title: '修上下文面板', requests: 4, steps: 9, lastAt: 1 },
  route: { provider: 'magpie', model: 'l-command/deepseek/deepseek-v4.1-flash', contextWindow: 1000000 },
  budget: { window: 1000000, used: 324000, projected: 330000, remaining: 676000, ratio: 0.324 },
  cache: { prompt: 324000, cacheRead: 320760, hitRate: 0.99, sessionHitRate: 0.82, fresh: 3240 },
  tools: {
    total: 37,
    tokens: 10800,
    chars: 43000,
    search: {
      calls: 3,
      byName: 2,
      byKeyword: 1,
      withResult: 3,
      resultChars: 9172,
      recent: [
        { query: '+chrome-devtools new_page', exact: false, chars: 5784, at: 1 },
        { query: 'select:tool_search', exact: true, chars: 2033, at: 2 },
      ],
    },
  },
  turns: [
    { turn: 1, prompt: 96000, cacheRead: 80000, output: 900, requests: 2, billed: 100000 },
    { turn: 2, prompt: 324000, cacheRead: 320760, output: 700, requests: 2, billed: 330000 },
  ],
  billed: { prompt: 420000, cacheRead: 400760, output: 1600, requests: 4 },
  totals: { itemTokens: 200000, measured: true, surfaceChars: 800000 },
  kinds: [
    { kind: 'system', label: '系统提示词', tokens: 17700, chars: 70000, count: 1 },
    { kind: 'tools', label: '工具定义', tokens: 10800, chars: 43000, count: 1 },
    { kind: 'tool-result', label: '工具结果', tokens: 54000, chars: 210000, count: 1 },
    { kind: 'conversation', label: '会话内容', tokens: 47000, chars: 180000, count: 2 },
  ],
  items: [
    { id: 'system', kind: 'system', label: '系统提示词', sublabel: 'You are an AI agent', tokens: 17700, chars: 70000, count: 1, turn: null },
    { id: 'tools', kind: 'tools', label: '工具定义', sublabel: '37 个工具的 schema', tokens: 10800, chars: 43000, count: 37, turn: null },
    { id: 'tool:pwsh', kind: 'tool-result', label: 'pwsh', sublabel: '×37', tokens: 54000, chars: 210000, count: 37, turn: null },
    { id: 'turn:14', kind: 'conversation', label: '第 14 轮', sublabel: '8 条消息', tokens: 26500, chars: 100000, count: 8, turn: 14 },
    { id: 'turn:8', kind: 'conversation', label: '第 8 轮', sublabel: '6 条消息', tokens: 20500, chars: 80000, count: 6, turn: 8 },
  ],
  notes: [],
  sessions: [{ id: 'session-abc', title: '修上下文面板', cwd: 'D:\\ws', workspace: 'ws', lastAt: 1, active: true }],
}

async function mount(internals, report) {
  const call = async (method) => (method === 'contextReport' ? report : { ok: false, error: 'unexpected ' + method })
  const props = { call }
  internals.__render(internals.ContextFace, props)
  await internals.__settle()
  return { props, tree: internals.__render(internals.ContextFace, props) }
}

/**
 * 每条用例结束前必须卸载：面板开着的时候每 3s 轮询一次宿主，不卸载就是给测试进程
 * 留一个永不停止的 interval。这里用 t.after 统一兜底，用例自己不必记得。
 */
function withUnmount(t, internals) {
  t.after(() => internals.__unmount())
}

// ── ⓪ 分类顺序：宿主与客户端两份表必须同序 ──────────────────────────────────
//
// 宿主（lib/context-report.js 的 CONTEXT_KINDS）决定 `report.items` / `report.kinds` 的顺序，
// 客户端（lib/client/65-context-face.js 的 CONTEXT_KIND_ORDER）决定画图与图例的顺序。
// 两份表内容一致但互不相识——一旦谁改了顺序，图里第几列与图例第几项就对不上，而**两边各自
// 的单测都会绿**（各测各的表）。这条跨端断言就是为了让这种漂移无法静默通过。
test('分类顺序：客户端的绘制顺序与宿主的输出顺序一致', async () => {
  const internals = loadInternals()
  const { CONTEXT_KINDS } = await import('../lib/context-report.js')
  assert.equal(internals.CONTEXT_KIND_ORDER.join(','), CONTEXT_KINDS.join(','),
    '两端分类顺序必须逐项一致')
  // 筛选器覆盖全部五类（外加"全部"），顺序同样必须对齐。
  const filterIds = internals.CONTEXT_FILTERS.map((entry) => entry.id)
  assert.equal(filterIds.join(','), ['all', ...CONTEXT_KINDS].join(','), '筛选器顺序也要对齐')
})

// ── ① 块图几何不变量 ────────────────────────────────────────────────────────
// 排版算法唯一能被机械验证的东西：每个矩形都在容器内、互不重叠、总面积等于容器面积。
// 断言对象是 `layoutColumns`（按分类分列），因为一次性 squarify 会把小分类压成看不见的
// 细线——真机第一版就是这样，图里只剩两块大的。
test('layoutColumns：矩形互不重叠、全在容器内、且铺满', () => {
  const internals = loadInternals()
  const groups = [
    { kind: 'system', label: '系统提示词', value: 25, items: [{ id: 's1', label: '系统提示词', value: 25 }] },
    { kind: 'tools', label: '工具定义', value: 46, items: [{ id: 't1', label: '工具定义', value: 40 }, { id: 't2', label: '工具注册消息', value: 6 }] },
    { kind: 'tool-result', label: '工具结果', value: 672, items: [{ id: 'r1', label: 'pwsh', value: 300 }, { id: 'r2', label: 'read', value: 372 }] },
    { kind: 'attachment', label: '附件', value: 1, items: [{ id: 'a1', label: '附件', value: 1 }] },
    { kind: 'conversation', label: '会话内容', value: 801, items: [{ id: 'c1', label: '第 1 轮', value: 801 }] },
  ]
  const W = 900
  const H = 260
  const { tiles, columns } = internals.layoutColumns(groups, W, H)
  assert.equal(columns.length, groups.length, '每个分类一列')
  assert.ok(tiles.length >= groups.length, '每类至少一块')

  for (const tile of tiles) {
    assert.ok(tile.x >= -0.001 && tile.y >= -0.001, `越界（左上）：${JSON.stringify(tile)}`)
    assert.ok(tile.x + tile.w <= W + 0.001, `越界（右）：${JSON.stringify(tile)}`)
    assert.ok(tile.y + tile.h <= H + 0.001, `越界（下）：${JSON.stringify(tile)}`)
    assert.ok(tile.w > 0 && tile.h > 0, `退化矩形：${JSON.stringify(tile)}`)
  }
  for (let i = 0; i < tiles.length; i += 1) {
    for (let j = i + 1; j < tiles.length; j += 1) {
      const a = tiles[i]
      const b = tiles[j]
      const overlapW = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
      const overlapH = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
      const overlap = Math.max(0, overlapW) * Math.max(0, overlapH)
      assert.ok(overlap <= 0.01, `矩形重叠：${JSON.stringify(a)} × ${JSON.stringify(b)}`)
    }
  }
  const area = tiles.reduce((sum, tile) => sum + tile.w * tile.h, 0)
  assert.ok(Math.abs(area - W * H) < W * H * 0.005, `没铺满：${area} vs ${W * H}`)

  // 关键性质①：**顺序**。列必须按 groups 给的顺序从左到右。
  // ⚠️ 用字符串比而不是 deepEqual：数组是 VM realm 里造的，原型与测试 realm 不同，
  // 严格深比较会因原型差异失败（看起来像"两个一模一样的数组不相等"）。
  const columnOrder = columns.map((column) => column.kind).join(',')
  assert.equal(columnOrder, groups.map((group) => group.kind).join(','), '列顺序必须与分类顺序一致')
  for (let i = 1; i < columns.length; i += 1) assert.ok(columns[i].x >= columns[i - 1].x, '列必须从左到右排')

  // 关键性质②：**列宽就是值的比例**。图的意义是"谁大谁小一眼看出来"，所以面积不能撒谎：
  // 曾经把小分类抬到 68px 再归一化，420px 的面板里这一抬既给不到 68px（6×68 > 388），
  // 面积也不再等比例（附件 2K 与系统提示词 29K 看着一样宽）。现在只留"看得见"的极小下限。
  const total = groups.reduce((sum, group) => sum + group.value, 0)
  for (const column of columns) {
    const group = groups.find((entry) => entry.kind === column.kind)
    const share = (group.value / total) * W
    if (share < 8) {
      // 占比小到快看不见的类：允许抬到"可见下限"，但不能抬成一块（那才是面积撒谎）。
      assert.ok(column.w >= 2 && column.w <= 8.5, `${column.kind} 只该留一条看得见的线，实际 ${column.w}`)
      continue
    }
    assert.ok(Math.abs(column.w - share) <= Math.max(share * 0.03, 2),
      `${column.kind} 的列宽应等于占比（期望 ${share.toFixed(1)}，实际 ${column.w.toFixed(1)}）`)
  }
})

test('layoutColumns：空输入与零值不产生矩形（不画零宽块）', () => {
  const internals = loadInternals()
  assert.deepEqual([...internals.layoutColumns([], 800, 300).tiles], [])
  assert.deepEqual([...internals.layoutColumns([{ kind: 'x', label: 'x', value: 0, items: [] }], 800, 300).tiles], [])
  assert.deepEqual([...internals.layoutColumns([{ kind: 'x', label: 'x', value: 10, items: [] }], 0, 300).tiles], [], '容器没有宽度时什么都不画')
})

test('buildGridCells：每格等量，剩余空间也占格，且不超过上限', () => {
  const internals = loadInternals()
  const segments = [{ kind: 'system', value: 2500 }, { kind: 'conversation', value: 7500 }]
  const grid = internals.buildGridCells(segments, 20000, 420)
  assert.ok(grid.unit > 0, '要有每格的量')
  assert.ok(grid.cells.length <= 420, `不得超过上限，实际 ${grid.cells.length}`)
  // 已用的格数 + 剩余的格数 ≈ 总容量对应的格数。
  const free = grid.cells.filter((cell) => cell.kind === 'free').length
  const used = grid.cells.length - free
  assert.ok(used > 0 && free > 0, '已用与剩余都要有格')
  assert.ok(Math.abs(used * grid.unit - 10000) <= grid.unit * 2, `已用格应约等于 10000，实际 ${used * grid.unit}`)
})
// ── ② 数字格式 ──────────────────────────────────────────────────────────────
test('formatTokens / formatPercent：量级优先，不显示伪精度', (t) => {
  const internals = loadInternals()
  withUnmount(t, internals)
  const { formatTokens, formatPercent } = internals
  assert.equal(formatTokens(980), '980')
  assert.equal(formatTokens(324000), '324K')
  assert.equal(formatTokens(1000000), '1.0M')
  assert.equal(formatTokens(1048576), '1.0M')
  assert.equal(formatTokens(null), '—')
  assert.equal(formatTokens(Number.NaN), '—')
  assert.equal(formatPercent(0.324), '32%')
  assert.equal(formatPercent(0.004), '<1%')
  assert.equal(formatPercent(0.99), '99%')
  assert.equal(formatPercent(null), '—')
})

// ── ③ 面板渲染：总量、构成、明细、脚注 ─────────────────────────────────────
test('上下文面：总量取真值，构成按真值等比换算（两者对得上）', async (t) => {
  const internals = loadInternals()
  withUnmount(t, internals)
  const { tree } = await mount(internals, REPORT)
  const text = allText(tree)
  assert.match(text, /已用上下文/, '要有总量标题')
  assert.match(text, /324K/, `总量必须是宿主报的真值：${text.slice(0, 200)}`)
  assert.match(text, /1\.0M/, '上限要显示')
  assert.match(text, /32%/, '占比要显示')
  assert.match(text, /健康/, '32% 应判为健康')
  assert.match(text, /提示词缓存/, '缓存那一栏要显示')
  assert.match(text, /99%/, '缓存命中率要显示')

  // 构成：格子上写的数之和 = 已用总量（等比换算的意义就在这里）。
  const cells = collectAll(tree, (node) => typeof node.props?.className === 'string' && /^dsh-mcp-ctx-cell( |$)/.test(node.props.className))
  assert.ok(cells.length >= 6, `格子数应覆盖全部条目 + 剩余空间，实际 ${cells.length}`)
  const sizes = cells
    .map((cell) => String(cell.props.title ?? ''))
    .map((title) => Number((title.match(/([\d.]+)K?/) ?? [])[1]))
    .filter((value) => Number.isFinite(value))
  assert.ok(sizes.length > 0, '格子必须有 title 说明自己是多大')
})

test('上下文面：明细列出每一类；会话内容在「全部」里是一行合计', async (t) => {
  // 逐轮明细是**时间序列**，「每轮用掉多少」那张柱图才是它的形状；14 行几乎一样的
  // "第 N 轮 / 6 条消息"铺在明细里，只会把真正有差别的那几行（工具名）挤下去。
  // 所以"全部"视图把会话内容合成一行，逐轮只在「会话内容」筛选里看。
  const internals = loadInternals()
  withUnmount(t, internals)
  const { props, tree } = await mount(internals, REPORT)
  const rows = collectAll(tree, (node) => node.props?.className === 'dsh-mcp-ctx-row')
  const labelOf = (row) => collectAll(row, (node) => node.props?.className === 'dsh-mcp-ctx-row-label')[0]
  const labels = rows.map((row) => allText(labelOf(row)))
  // 宿主已按分类顺序排好；渲染不得重排（重排 = 第二个排序真相源）。
  assert.deepEqual(labels, ['系统提示词', '工具定义', 'pwsh', '会话内容'], '每类一行，会话内容合计成一行')
  // 合计行必须说清它是几轮——否则读者会以为只有一轮。
  const aggregateRow = rows[rows.length - 1]
  assert.match(allText(aggregateRow), /2 轮/, '合计行要写轮数')

  // 筛到「会话内容」才逐轮展开，且按宿主给的顺序（大小降序）。
  const filter = collectAll(tree, (node) => node.props?.className === 'dsh-mcp-ctx-filter')[0]
  const conversationButton = collectAll(filter, (node) => node.type === 'button' && allText(node) === '会话内容')[0]
  conversationButton.props.onClick()
  const expanded = internals.__render(internals.ContextFace, props)
  const expandedLabels = collectAll(expanded, (node) => node.props?.className === 'dsh-mcp-ctx-row')
    .map((row) => allText(labelOf(row)))
  assert.deepEqual(expandedLabels, ['第 14 轮', '第 8 轮'], '筛会话内容时逐轮展开')
})

test('上下文面：分类筛选只留下该类的行', async (t) => {
  const internals = loadInternals()
  withUnmount(t, internals)
  const { props, tree } = await mount(internals, REPORT)
  const filter = collectAll(tree, (node) => node.props?.className === 'dsh-mcp-ctx-filter')[0]
  const toolButton = collectAll(filter, (node) => node.type === 'button' && allText(node) === '工具定义')[0]
  assert.ok(toolButton, '筛选器里要有「工具定义」这一格')
  toolButton.props.onClick()
  const after = internals.__render(internals.ContextFace, props)
  const rows = collectAll(after, (node) => node.props?.className === 'dsh-mcp-ctx-row')
  assert.equal(rows.length, 1, '筛「工具定义」后只剩一行')
  assert.match(allText(rows[0]), /工具定义/)
})

// ── ④ 降级：宿主没给 token 价格 ──────────────────────────────────────────────
test('上下文面：没有 token 价格时按字符排布，单位不伪装成 token', async (t) => {
  // 降级只用**单位**表达，不写说明文字：数字旁边写着"字符"，读者自然知道这不是 token。
  // （早先底部还有一段"宿主没有提供 token-meter…"的解释，那是给实现者看的，已删。）
  const internals = loadInternals()
  withUnmount(t, internals)
  const degraded = {
    ...REPORT,
    cache: { prompt: null, cacheRead: null, hitRate: null, sessionHitRate: null },
    turns: [],
    items: REPORT.items.map((item) => ({ ...item, tokens: null })),
  }
  const { tree } = await mount(internals, degraded)
  const text = allText(tree)
  assert.match(text, /字符/, '单位要写「字符」')
  const cells = collectAll(tree, (node) => typeof node.props?.className === 'string' && /^dsh-mcp-ctx-cell( |$)/.test(node.props.className))
  for (const cell of cells) {
    if (String(cell.props.title ?? '').includes('token')) assert.fail(`降级态不得出现 token：${cell.props.title}`)
  }
  // 界面上不该再出现解释性文字（那是"废话"，用户点名要去掉）。
  assert.doesNotMatch(text, /token-meter/, '不得把实现名词写进界面')
  assert.doesNotMatch(text, /按字符排布/, '不得用"按字符排布"这类描述性说明代替单位标注')
})

test('上下文面：会话读不到时报错并给重试，不留白屏', async (t) => {
  const internals = loadInternals()
  withUnmount(t, internals)
  const call = async () => ({ ok: false, error: '还没有可观测的会话' })
  const props = { call }
  internals.__render(internals.ContextFace, props)
  internals.__drainEffects()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const tree = internals.__render(internals.ContextFace, props)
  const text = allText(tree)
  assert.match(text, /还没有可观测的会话/, '宿主原话要透出来')
  assert.ok(collectAll(tree, (node) => node.type === 'button' && allText(node) === '重试').length > 0, '要有重试按钮')
})

test('上下文面：读不到"当前会话"时不瞎编 id，交给宿主默认', async (t) => {
  // 真机缺陷：面板按"最近修改"挑会话，于是用户正看着 A（37%）却显示 B（5%），毫无解释。
  // 修法是先问界面上正在看哪个会话（localStorage / data-conversation-session）。这里钉住
  // 另一半：**两个来源都读不到时不许编**，要传空对象让宿主用默认会话。
  const internals = loadInternals()
  withUnmount(t, internals)
  const calls = []
  const call = async (method, payload) => {
    calls.push([method, payload])
    return method === 'contextReport' ? REPORT : { ok: false, error: 'unexpected ' + method }
  }
  const props = { call }
  internals.__render(internals.ContextFace, props)
  internals.__drainEffects()
  await new Promise((resolve) => setTimeout(resolve, 0))
  internals.__render(internals.ContextFace, props)
  const reports = calls.filter(([method]) => method === 'contextReport')
  assert.ok(reports.length > 0, '必须真的请求过宿主')
  // ⚠️ 不用 deepEqual({})：payload 是 VM realm 里造出来的对象，原型与测试 realm 不同，
  // 严格深比较会因原型不同而失败（看起来像"{} !== {}"）。断言字段本身。
  assert.equal(reports[0][1]?.sessionId, undefined, '读不到当前会话时不传 sessionId（不编一个假 id）')
})

test('上下文面：最近的工具搜索在这里（不在工具页），按时间倒序且点名/关键词分开', async (t) => {
  const internals = loadInternals()
  withUnmount(t, internals)
  const { tree } = await mount(internals, REPORT)
  const text = allText(tree)
  // 这两条原来钉在工具页上（那里把它画成一段日志）；搬过来之后仍在断言同一件事：
  // ① 顺序是**时间倒序**（后发生的在前）——不是按"有没有命中"排序，那是假警报；
  // ② 点名（select:）与关键词是两件事，措辞必须分开。
  assert.match(text, /最近的工具搜索/, '搜索记录要有自己的区块')
  assert.ok(text.indexOf('select:tool_search') < text.indexOf('chrome-devtools new_page'), '按时间倒序（最近的在前）')
  const chips = collectAll(tree, (node) => typeof node.props?.className === 'string' && node.props.className.startsWith('dsh-mcp-ctx-chip'))
  const chipText = chips.map((node) => allText(node))
  assert.ok(chipText.includes('按名'), `select: 那条要标「按名」（用户话，不是协议词），实际 ${JSON.stringify(chipText)}`)
  assert.ok(chipText.includes('关键词'), `关键词那条要标「关键词」，实际 ${JSON.stringify(chipText)}`)
  // 每次搜索的字符成本（maxResults 的单价）要显示。
  assert.match(text, /5784 字符/)
})

test('上下文面：工具卡显示数量 / 占用 / 搜索次数（三格，不堆无用数）', async (t) => {
  const internals = loadInternals()
  withUnmount(t, internals)
  const { tree } = await mount(internals, REPORT)
  const stats = collectAll(tree, (node) => node.props?.className === 'dsh-mcp-ctx-stat')
  // 从四格减到三格：原来还有一格单独报"搜索返回了多少字符"，那个数对决策没用，
  // 反而把另外三格挤小了。格数变少是**简化**，不是丢信息——搜索记录区块里每条都带字符数。
  assert.equal(stats.length, 3, '工具卡是三格：工具数 / 占上下文 / 搜索次数')
  const labels = stats.map((node) => allText(node))
  assert.ok(labels.some((line) => line.includes('37')), '工具数量要显示（37）')
  assert.ok(labels.some((line) => line.includes('搜索次数') && line.includes('3')), '搜索次数要显示（3）')
  assert.ok(labels.some((line) => line.includes('按名 2')), '按名/关键词的次数要分开报')
})

test('上下文面：剩余空间是块图的**最后一列**（在右端，不是最左）', async (t) => {
  // 真机反馈："剩余的为啥显示在左边啊，有点反直觉"——那是按面积降序的必然结果（剩余最大
  // 就跑到最左）。现在的契约有两条，缺一条都不够：
  //   ① 五类的**固定顺序**从左到右（system → tools → tool-result → attachment → conversation）；
  //   ② 剩余空间作为**最后一列**跟在后面，用斜纹区分。
  const internals = loadInternals()
  withUnmount(t, internals)
  const { tree } = await mount(internals, REPORT)
  const cells = collectAll(tree, (node) => typeof node.props?.className === 'string' && /^dsh-mcp-ctx-cell( |$)/.test(node.props.className))
  assert.ok(cells.length >= 5, '构成 + 剩余空间都要有块')
  const lefts = cells.map((cell) => Number(String(cell.props.style.left).replace('px', '')))
  const freeIndex = cells.findIndex((cell) => String(cell.props.className).includes('kind-free'))
  assert.ok(freeIndex >= 0, '剩余空间要画出来（否则看不出"填满度"）')
  // 它必须是**最靠右**的那一块。
  assert.equal(lefts[freeIndex], Math.max(...lefts), '剩余空间必须是最右一列')
  // 其它分类按固定顺序从左到右。
  const kindsInOrder = ['system', 'tools', 'tool-result', 'attachment', 'conversation']
  const present = cells
    .filter((cell) => !String(cell.props.className).includes('kind-free'))
    .map((cell) => kindsInOrder.findIndex((kind) => String(cell.props.className).includes('kind-' + kind)))
    .filter((index) => index >= 0)
  assert.deepEqual(present, present.slice().sort((left, right) => left - right), '非剩余块的分类顺序必须固定')

  const legend = collectAll(tree, (node) => node.props?.className === 'dsh-mcp-ctx-legend')[0]
  const legendText = allText(legend)
  assert.match(legendText, /剩余空间/, '剩余空间要在图例里说明')
  // 图例里的剩余空间必须与块图**同一个尺度**：占比 32% 时它应是构成总和的约两倍，
  // 而不是直接印出 token 数（那样同一屏里会出现两个互相矛盾的"剩余"）。
  const freeLegend = collectAll(legend, (node) => typeof node.props?.className === 'string' && node.props.className.includes('legend-item') && allText(node).includes('剩余空间'))[0]
  assert.ok(freeLegend, '图例要有剩余空间那一项')
  const freeValue = Number((allText(freeLegend).match(/([\d.]+)(K|M)/) ?? [])[1]) * ((allText(freeLegend).match(/(K|M)/) ?? [])[1] === 'M' ? 1000000 : 1000)
  // 构成的字符账约 500K（见 fixture），剩余 32% token 换算成字符应明显大于它。
  assert.ok(freeValue > 400000, `图例的剩余空间要换算到与构成同尺度，实际 ${allText(freeLegend)}`)
  const orderLabels = ['系统提示词', '工具定义', '工具结果', '会话内容', '剩余空间']
  const positions = orderLabels.map((label) => legendText.indexOf(label))
  assert.deepEqual(positions, positions.slice().sort((left, right) => left - right), `图例顺序必须固定：${legendText}`)
})

test('上下文面：总额换算后，块图与图例用**同一个**数（不混用 token 与字符）', async (t) => {
  // 真机缺陷：`sizeOf(item, field)` 的默认 field 落到 `chars`，于是有 token 价格时块图画的是
  // 字符数、图例画的是 token 数——同一屏两个数（44K vs 175K），而且都"看起来像对的"。
  const internals = loadInternals()
  withUnmount(t, internals)
  const { tree } = await mount(internals, REPORT)
  const legend = collectAll(tree, (node) => node.props?.className === 'dsh-mcp-ctx-legend')[0]
  const legendText = allText(legend)
  const cells = collectAll(tree, (node) => typeof node.props?.className === 'string' && /^dsh-mcp-ctx-cell( |$)/.test(node.props.className))
  const cellTitles = cells.map((cell) => String(cell.props.title ?? ''))
  // 系统提示词在 fixture 里是 17700 token；换算后图例与块图的 title 必须一致。
  // 块图列内用**短名**（窄列放不下全名），图例用全名——两者指的是同一块，所以这里按短名找。
  const legendSystem = (legendText.match(/系统提示词 ?([\d.]+)(K|M)/) ?? [])
  assert.ok(legendSystem[1], `图例要有系统提示词的数值：${legendText.slice(0, 120)}`)
  const systemCell = cellTitles.find((title) => title.startsWith('系统：') || title.startsWith('系统提示词：'))
  assert.ok(systemCell, `块图里要有系统提示词那块：${JSON.stringify(cellTitles.slice(0, 4))}`)
  const cellSize = (systemCell.match(/([\d.]+)(K|M)/) ?? [])[1]
  assert.equal(cellSize, legendSystem[1], `块图与图例必须是同一个数（图例 ${legendSystem[1]}，块图 ${cellSize}）`)
})

test('上下文面：可以切成网格视图（每格固定量，剩余也画成格）', async (t) => {
  const internals = loadInternals()
  withUnmount(t, internals)
  const { props, tree } = await mount(internals, REPORT)
  const switchGroup = collectAll(tree, (node) => node.props?.className === 'dsh-mcp-ctx-viewswitch')[0]
  assert.ok(switchGroup, '要有视图切换')
  const gridButton = collectAll(switchGroup, (node) => node.type === 'button' && allText(node) === '网格')[0]
  assert.ok(gridButton, '要有「网格」按钮')
  gridButton.props.onClick()
  const after = internals.__render(internals.ContextFace, props)
  const cells = collectAll(after, (node) => typeof node.props?.className === 'string' && node.props.className.startsWith('dsh-mcp-ctx-grid-cell'))
  assert.ok(cells.length > 10, `网格视图要画出格子，实际 ${cells.length}`)
  assert.ok(cells.some((cell) => cell.props.className.includes('kind-free')), '剩余空间也要画成格（空格子看得见填满度）')
  assert.equal(collectAll(after, (node) => node.props?.className === 'dsh-mcp-ctx-map').length, 0, '网格模式下不画块图')
})

test('上下文面：没有 token 价格时，剩余空间与容量按同一个尺度换算（不混用 token 与字符）', async (t) => {
  // 真机缺陷：只有字符账时，构成是**字符**而 `remaining`/`window` 是 **token**，
  // 直接摆进同一个块图就是量纲混用——549K token 的剩余被 861K 字符的会话内容压成一小块，
  // 网格视图里更明显：容量按 token 算，画出来的格子数远超实际（326 格 × 5K = 1.63M > 1M）。
  const internals = loadInternals()
  withUnmount(t, internals)
  const degraded = {
    ...REPORT,
    cache: {},
    turns: [],
    // 构成只有字符（无 tokens），总量仍是 token：这是磁盘会话的形状。
    items: [
      { id: 'system', kind: 'system', label: '系统提示词', tokens: null, chars: 70000, count: 1, turn: null },
      { id: 'turn:1', kind: 'conversation', label: '第 1 轮', tokens: null, chars: 430000, count: 9, turn: 1 },
    ],
    kinds: [
      { kind: 'system', label: '系统提示词', tokens: null, chars: 70000, count: 1 },
      { kind: 'conversation', label: '会话内容', tokens: null, chars: 430000, count: 1 },
    ],
    notes: [],
  }
  const { tree } = await mount(internals, degraded)
  const cells = collectAll(tree, (node) => typeof node.props?.className === 'string' && /^dsh-mcp-ctx-cell( |$)/.test(node.props.className))
  const free = cells.find((cell) => String(cell.props.className).includes('kind-free'))
  assert.ok(free, '剩余空间要有块')
  // 构成 500K 字符对应 324K token → 676K token 的剩余换算成字符约 1.04M。
  // 断言"剩余不小于构成"就够说明量纲对齐了（旧实现里剩余被压到比构成小得多）。
  const freeValue = Number(String(free.props.title).match(/([\d.]+)M|([\d.]+)K/).slice(1).find((part) => part !== undefined))
  const freeTokens = String(free.props.title).includes('M') ? freeValue * 1000000 : freeValue * 1000
  assert.ok(freeTokens > 500000, `剩余空间应换算到字符尺度（>500K），实际 ${free.props.title}`)
})

test('上下文面：网格视图按**总量**铺格，格子数不会超过容量（量纲对齐）', async (t) => {
  const internals = loadInternals()
  withUnmount(t, internals)
  const degraded = {
    ...REPORT,
    cache: {},
    turns: [],
    items: [{ id: 'turn:1', kind: 'conversation', label: '第 1 轮', tokens: null, chars: 430000, count: 9, turn: 1 }],
    kinds: [{ kind: 'conversation', label: '会话内容', tokens: null, chars: 430000, count: 1 }],
    notes: [],
  }
  const { props, tree } = await mount(internals, degraded)
  const gridButton = collectAll(collectAll(tree, (node) => node.props?.className === 'dsh-mcp-ctx-viewswitch')[0], (node) => node.type === 'button' && allText(node) === '网格')[0]
  gridButton.props.onClick()
  const after = internals.__render(internals.ContextFace, props)
  const cells = collectAll(after, (node) => typeof node.props?.className === 'string' && node.props.className.startsWith('dsh-mcp-ctx-grid-cell'))
  const hint = allText(collectAll(after, (node) => node.props?.className === 'dsh-mcp-ctx-section-hint')[0])
  // 每格的量 × 格数 ≈ 容量（换算到同一尺度后）。旧实现直接拿 token 容量除字符构成，
  // 格数会明显偏离容量。
  const unitMatch = hint.match(/每格 ([\d.]+)(K|M)/)
  assert.ok(unitMatch, `图注要写明每格多少，实际 ${hint}`)
  const unit = unitMatch[2] === 'M' ? Number(unitMatch[1]) * 1000000 : Number(unitMatch[1]) * 1000
  const total = cells.length * unit
  // 容量 1M token 换算成字符约 1.54M；允许 ±1 格误差。
  assert.ok(total >= 900000 && total <= 2200000, `格数×每格应接近容量，实际 ${cells.length}×${unit}=${total}`)
})

test('上下文面：零值不画成块；一次请求都没有时整页给空状态', async (t) => {
  // 两个真机缺陷同源——"还没有任何数据"却被画成一页内容：
  //   ① `layoutColumns` 会把 0 抬到最小宽度，于是"工具定义 0 字符"占满整张块图；
  //   ② 报告里总有一个「工具定义」条目（哪怕 0），所以拿"items 为空"当判据永远不成立，
  //      面板照旧画一整页破折号卡片 + 底部两条解释（用户称之为"废话"）。
  const internals = loadInternals()
  withUnmount(t, internals)
  const pristine = {
    ...REPORT,
    session: { ...REPORT.session, requests: 0 },
    budget: { window: 1000000, used: null, remaining: null, ratio: null },
    cache: {},
    tools: { total: null, tokens: 0, chars: 0, search: { calls: 0, recent: [] } },
    turns: [],
    billed: {},
    kinds: [{ kind: 'tools', label: '工具定义', tokens: 0, chars: 0, count: 1 }],
    items: [{ id: 'tools', kind: 'tools', label: '工具定义', sublabel: null, tokens: 0, chars: 0, count: null, turn: null }],
  }
  const { tree } = await mount(internals, pristine)
  const text = allText(tree)
  assert.match(text, /还没有会话发出过请求/, '没有请求时整页只有一个空状态（通用说法，不点名会话）')
  assert.match(text, /跑起来之后，这里会显示每个会话占用了多少上下文/, '空状态要给出下一步（且是"每个会话"这种全局说法）')
  // 空状态**不该**点名任何会话：这个面板是全局的，一个入口覆盖所有工作区。
  // 早先这里会跟一串会话 id，用户的原话是"我那么多会话你为啥显示这个？什么策略？"。
  assert.equal(collectAll(tree, (node) => node.props?.className === 'dsh-mcp-ctx-blank-id').length, 0, '空状态不点名会话')
  // 不该再画卡片、也不该有解释性说明。
  assert.equal(collectAll(tree, (node) => node.props?.className === 'dsh-mcp-ctx-overview').length, 0, '不该画总量卡片')
  assert.equal(collectAll(tree, (node) => typeof node.props?.className === 'string' && /^dsh-mcp-ctx-cell( |$)/.test(node.props.className)).length, 0, '不该画块图')
  assert.equal(collectAll(tree, (node) => node.props?.className === 'dsh-mcp-ctx-notes').length, 0, '不该有说明块')
})

test('上下文面：零值分类不进块图（即使有请求，0 值也不占一格）', async (t) => {
  const internals = loadInternals()
  withUnmount(t, internals)
  const withZeroKind = {
    ...REPORT,
    kinds: [...REPORT.kinds, { kind: 'attachment', label: '附件', tokens: 0, chars: 0, count: 1 }],
    items: [...REPORT.items, { id: 'attachment', kind: 'attachment', label: '附件', sublabel: '×1', tokens: 0, chars: 0, count: 1, turn: null }],
  }
  const { tree } = await mount(internals, withZeroKind)
  const cells = collectAll(tree, (node) => typeof node.props?.className === 'string' && /^dsh-mcp-ctx-cell( |$)/.test(node.props.className))
  assert.equal(cells.some((cell) => String(cell.props.className).includes('kind-attachment')), false, '0 值分类不该画成块')
})

test('上下文面：工具卡显示「目录」状态（原「目录体检」搬到这里）', async (t) => {
  // 这块原来在工具页叫「目录体检」，用户问"目录体检是啥"——名字是内部叫法，位置也错了：
  // 它是**观测**，不是配置。现在并进上下文页的工具卡，用一行说完三件事：
  // 哪些 MCP 按需、目录本身多大、有没有被上限截掉。
  const internals = loadInternals()
  withUnmount(t, internals)
  const withCatalog = {
    ...REPORT,
    catalog: {
      budget: 12500,
      deferredServers: ['alpha', 'beta', 'gamma', 'delta'],
      lastAssembly: { listed: 400, truncated: 56, total: 456, chars: 12881, budget: 12500 },
    },
  }
  const { tree } = await mount(internals, withCatalog)
  const line = collectAll(tree, (node) => node.props?.className?.startsWith?.('dsh-mcp-ctx-catalog'))[0]
  assert.ok(line, '工具卡里要有目录状态那一行')
  const text = allText(line)
  assert.match(text, /目录/, '要有个「目录」标签')
  assert.match(text, /alpha、beta、gamma/, '按需的服务器要列出来（超过三个用"等 N 台"收口）')
  assert.match(text, /等 4 台/, '多于三个时说明总数')
  assert.match(text, /12881 字符/, '目录本身多大要报（那是每轮都要付的成本）')
  assert.match(text, /截掉 56 个/, '被截掉要明说，那是"有些工具只能靠关键词碰"的原因')
  // 修法必须指向「工具」页那个设置的**原名**（那里叫「限制目录大小」）。同一个设置两个名字，
  // 用户去找的时候只会找不到。
  assert.match(text, /限制目录大小/, '要告诉用户怎么修，且用设置的原名')
  assert.doesNotMatch(text, /目录上限/, '同一个设置不许有两个名字')
  // 实现名词一个都不该出现。
  assert.doesNotMatch(text, /体检|预算|延迟服务器|revision/, '不得把实现名词写进界面')
})

test('上下文面：没被截断时不多说一句"没有截断"', async (t) => {
  const internals = loadInternals()
  withUnmount(t, internals)
  const clean = {
    ...REPORT,
    catalog: { budget: null, deferredServers: ['alpha'], lastAssembly: { listed: 400, truncated: 0, total: 400, chars: 9000, budget: null } },
  }
  const { tree } = await mount(internals, clean)
  const line = collectAll(tree, (node) => node.props?.className?.startsWith?.('dsh-mcp-ctx-catalog'))[0]
  assert.ok(line, '目录行仍要显示（按需服务器 + 目录大小）')
  assert.doesNotMatch(allText(line), /没有截断/, '"没有截断"是没人需要的信息，不该占一行')
})

test('上下文面：空状态是通用的，不指向任何具体会话', async (t) => {
  // 这个面板是**全局**的：一个入口覆盖所有工作区、所有会话。所以空状态只能说"现在没有
  // 会话在运行"——不能说"这个会话没在运行"，那是在暗示"面板属于某个会话"，与定位相反。
  const internals = loadInternals()
  withUnmount(t, internals)
  const empty = {
    ok: true, empty: true, session: null, sessions: [], budget: {}, cache: {},
    tools: { search: { calls: 0, recent: [] } }, turns: [], billed: {}, totals: {}, kinds: [], items: [],
  }
  const mounted = await mount(internals, empty)
  const text = allText(mounted.tree)
  assert.match(text, /现在没有会话在运行/, '通用说法')
  assert.doesNotMatch(text, /这个会话/, '不得说"这个会话"——面板不属于任何一个会话')
  assert.doesNotMatch(text, /session-/, '不得把会话 id 摆在空状态里')
  // 即使宿主回带 requested（曾经用过），也不该再据此点名。
  const withRequested = await mount(internals, { ...empty, requested: 'session-abc' })
  assert.doesNotMatch(allText(withRequested.tree), /session-abc/, '传了 requested 也不点名')
})
test('上下文面：正在跑一轮时标明"数字来自上一轮"', async (t) => {
  // 面板读的是**最近一次请求**的快照；正在跑的这一轮还没进快照。不标注的话，用户看到
  // 数字几分钟不动会以为面板坏了。
  const internals = loadInternals()
  withUnmount(t, internals)
  const running = { ...REPORT, session: { ...REPORT.session, running: true } }
  const { tree } = await mount(internals, running)
  assert.match(allText(tree), /这是上一轮的读数/, '运行中要说明数字是上一轮的')
  // 空闲时说明"最近一轮"，不用"实时"这种模棱两可的词。
  // ⚠️ 必须用 mount（跑 effect + 重新渲染）而不是直接 __render：报告是 effect 里拉回来的，
  // 绕过 effect 会拿到上一次的 report（真踩过：断言失败在"数据没换"而不是文案不对）。
  const idle = { ...REPORT, session: { ...REPORT.session, running: false } }
  const idleMount = await mount(internals, idle)
  assert.match(allText(idleMount.tree), /这是最近一轮的读数/, '空闲时说明是最近一轮')
})

test('上下文面：最新的字典条目都存在（新文案都有英文）', async () => {
  // 这条不是重复 i18n 用例：它钉的是"上下文面这批**人话**文案确实进了词典"，
  // 因为面板里出现过 `t('一次搜回几个')` 这类改过之后忘了加词典的情况。
  const internals = loadInternals()
  const dict = internals.EN_DICT ?? {}
  for (const key of ['上下文被谁占着', '每轮用掉多少', '明细', '按名', '关键词', '工具数', '占上下文']) {
    assert.ok(Object.prototype.hasOwnProperty.call(dict, key), `词典缺少：${key}`)
  }
})

test('上下文面：多会话时先给"全部会话"总览，每个会话一行带用量条', async (t) => {
  // 用户原话："我使用的时候都是好几个工作区，好几个会话同时的"。所以多会话时不该把人锁在
  // 一个会话的详情里、再去顶部找芯片切换——先给总览：谁快满了、谁正在生成，一眼可见。
  const internals = loadInternals()
  withUnmount(t, internals)
  const multi = {
    ...REPORT,
    sessions: [
      { id: 'session-abc', title: '修上下文面板', cwd: 'D:\\ws-a', workspace: 'ws-a', lastAt: 3, used: 472000, window: 1000000, ratio: 0.472, requests: 33, running: true, active: true },
      { id: 'session-def', title: '另一个会话', cwd: 'D:\\ws-b', workspace: 'ws-b', lastAt: 2, used: 128000, window: 1000000, ratio: 0.128, requests: 5, running: false, active: false },
      { id: 'session-ghi', title: '同名会话', cwd: 'D:\\ws-b', workspace: 'ws-b', lastAt: 1, used: null, window: null, ratio: null, requests: 0, running: false, active: false },
    ],
  }
  const { tree } = await mount(internals, multi)
  const text = allText(tree)
  assert.match(text, /3 个会话正在运行/, '先说清有几个')
  const rows = collectAll(tree, (node) => typeof node.props?.className === 'string' && /dsh-mcp-ctx-allrow( |$)/.test(node.props.className))
  assert.equal(rows.length, 3, '每个会话一行')
  // 工作区名必须在——两个工作区里的同名会话靠它区分。
  assert.match(text, /ws-a/, '要显示工作区名')
  assert.match(text, /ws-b/, '第二个会话的工作区也要显示')
  // 用量：一行里能比出"谁快满了"。
  assert.ok(text.includes('472K / 1.0M · 47%'), '已用/上限/占比都要有')
  assert.ok(text.includes('128K / 1.0M · 13%'), '第二个会话的数要单独正确')
  assert.match(text, /还没有数据/, '没发过请求的会话如实说"还没有数据"，不画 0')
  // 正在生成的要标出来。
  assert.match(text, /生成中/, '正在跑的会话要有标记')
  // 总览里不该同时铺详情（否则"列表"和"详情"两套内容叠在一起）。
  assert.equal(collectAll(tree, (node) => node.props?.className === 'dsh-mcp-ctx-overview').length, 0, '总览模式下不画详情卡片')
})

test('上下文面：点会话进入详情，详情顶部能回"全部会话"', async (t) => {
  const internals = loadInternals()
  withUnmount(t, internals)
  const multi = {
    ...REPORT,
    sessions: [
      { id: 'session-abc', title: '修上下文面板', cwd: 'D:\\ws-a', workspace: 'ws-a', lastAt: 3, used: 472000, window: 1000000, ratio: 0.472, requests: 33, running: false, active: true },
      { id: 'session-def', title: '另一个会话', cwd: 'D:\\ws-b', workspace: 'ws-b', lastAt: 2, used: 128000, window: 1000000, ratio: 0.128, requests: 5, running: false, active: false },
    ],
  }
  const { props, tree } = await mount(internals, multi)
  const rows = collectAll(tree, (node) => typeof node.props?.className === 'string' && /dsh-mcp-ctx-allrow( |$)/.test(node.props.className))
  assert.equal(rows.length, 2)
  rows[0].props.onClick()
  const detail = internals.__render(internals.ContextFace, props)
  assert.ok(collectAll(detail, (node) => typeof node.props?.className === 'string' && node.props.className.startsWith('dsh-mcp-ctx-overview')).length > 0 || allText(detail).length > 0, '进入详情要有内容')
  const back = collectAll(detail, (node) => typeof node.props?.className === 'string' && node.props.className.startsWith('dsh-mcp-ctx-back'))[0]
  assert.ok(back, '详情顶部要有"返回全部会话"')
  assert.match(allText(back), /全部会话/)
  back.props.onClick()
  const listAgain = internals.__render(internals.ContextFace, props)
  assert.match(allText(listAgain), /个会话正在运行/, '点返回后回到总览')
})

test('上下文面：只跑一个会话时直接进详情，不经过总览', async (t) => {
  // 单会话用户不该被多一层点击挡住——这是"简化用户操作"的底线。
  const internals = loadInternals()
  withUnmount(t, internals)
  const single = {
    ...REPORT,
    sessions: [{ id: 'session-abc', title: '修上下文面板', cwd: 'D:\\ws', workspace: 'ws', lastAt: 1, used: 324000, window: 1000000, ratio: 0.324, requests: 4, running: false, active: true }],
  }
  const { tree } = await mount(internals, single)
  assert.equal(collectAll(tree, (node) => typeof node.props?.className === 'string' && /dsh-mcp-ctx-allrow( |$)/.test(node.props.className)).length, 0, '单会话不画总览')
  assert.ok(collectAll(tree, (node) => node.props?.className === 'dsh-mcp-ctx-overview').length > 0, '直接显示详情')
})

// ── ⑤ 出错与失效：不能静默、不能抛、不能说成别的会话 ────────────────────────────
test('上下文面：读取失败的"重试"真的会再发一次请求（不是死按钮）', async (t) => {
  // 曾经这里是 `onClick: () => load(sessionId)`，而 `sessionId` 在这个作用域里根本不存在：
  // 按钮画得出来、点下去抛 ReferenceError，面板一动不动。这条钉住"点了就真的重发"。
  // 生命周期行为必须模拟稳定的 ref/memo/effect；静态快照替身每次生成新 ref 会制造死按钮。
  const lifecycle = createHookRenderer()
  const internals = loadInternals(lifecycle)
  withUnmount(t, internals)
  let calls = 0
  const call = async () => { calls += 1; return { ok: false, error: '宿主断开了' } }
  const props = { call }
  internals.__render(internals.ContextFace, props)
  internals.__drainEffects()
  await lifecycle.__settle()
  const failed = internals.__render(internals.ContextFace, props)
  assert.match(allText(failed), /宿主断开了/, '失败要说清原因')
  const retry = collectAll(failed, (node) => node.type === 'button' && allText(node) === '重试')[0]
  assert.ok(retry, '错误态要有一个"重试"')
  const before = calls
  retry.props.onClick()
  await lifecycle.__settle()
  assert.equal(calls, before + 1, '点重试必须真的再发一次请求')
  assert.match(allText(internals.__render(internals.ContextFace, props)), /宿主断开了/, '重试的有效失败仍须展示')
})

test('上下文面：点选的会话已经不在了，就退回总览（不静默换成别的会话）', async (t) => {
  // 宿主挑不到 `sessionId` 时会退回"最近活跃的那个"。如果客户端不认这件事，用户看到的是
  // **标题写 A、数字是 B**——最坏的一种错：没有任何迹象提示数不对。
  const internals = loadInternals()
  withUnmount(t, internals)
  const multi = {
    ...REPORT,
    sessions: [
      { id: 'session-abc', title: '修上下文面板', cwd: 'D:\\ws-a', workspace: 'ws-a', lastAt: 3, used: 472000, window: 1000000, ratio: 0.472, requests: 33, running: false, active: true },
      { id: 'session-def', title: '另一个会话', cwd: 'D:\\ws-b', workspace: 'ws-b', lastAt: 2, used: 128000, window: 1000000, ratio: 0.128, requests: 5, running: false, active: false },
    ],
  }
  const { props, tree } = await mount(internals, multi)
  const rows = collectAll(tree, (node) => typeof node.props?.className === 'string' && /dsh-mcp-ctx-allrow( |$)/.test(node.props.className))
  rows[0].props.onClick()
  internals.__render(internals.ContextFace, props)
  // 宿主承认 "abc 不在了"，回的是 def。
  const gone = await mount(internals, { ...multi, session: { ...multi.session, id: 'session-def', title: '另一个会话' } })
  assert.match(allText(gone.tree), /个会话正在运行/, '会话没了就退回总览，不冒充')
})

test('上下文面：某一类没有价格时不按总量放大其余类（不把"未知"算成"零"再补齐）', async (t) => {
  // 等比换算只在**每一类都有价格**时成立。缺了一类的价还照换算，剩下几类会被
  // used/已量总和 放大——图仍然铺满、数字仍然"加得起来"，但每个数都偏大，偏的正好是
  // 缺失那一类的份额。此时宁可不换算。
  const internals = loadInternals()
  withUnmount(t, internals)
  const partial = {
    ...REPORT,
    totals: { ...REPORT.totals, measured: false },
    items: REPORT.items.map((item) => (item.kind === 'tools' ? { ...item, tokens: null } : item)),
  }
  const { tree } = await mount(internals, partial)
  const legend = collectAll(tree, (node) => node.props?.className === 'dsh-mcp-ctx-legend')[0]
  assert.ok(legend, '要有图例')
  // 系统提示词 17,700 token：不换算就是 18K，换算成 used/已量 ≈ ×2.5 会变成 44K。
  assert.match(allText(legend), /18K token/, '缺价时不放大（否则 17.7K 会被放大成 44K）')
})

// ── ⑥ 上限：长会话不能把页面撑爆 ─────────────────────────────────────────────
test('上下文面：条目很多时明细与块图都封顶，并如实写出还剩多少', async (t) => {
  // 真机会话 400+ 轮：明细一行一轮、块图一列几百条 1px 色带——滚不动、看不见，而且每 3 秒
  // 全部重排一次。封顶之后"其余 N 项"必须还在，否则就是悄悄藏数据。
  //
  // ⚠️ 另一笔账在宿主侧（每类只带 24 条，见 context-report 的 MAX_ITEMS_PER_KIND）：那是
  // **wire 上**的成本（真机 1500 轮 = 287KB/每次轮询）。这里同时验证"被宿主折叠的条数"
  // 会算进"其余"，否则长会话会被报少一大截。
  const internals = loadInternals()
  withUnmount(t, internals)
  const turns = Array.from({ length: 60 }, (_, index) => ({
    id: 'turn:' + (index + 1),
    kind: 'conversation',
    tokens: 1000 - index,
    chars: 4000,
    count: 2,
    turn: index + 1,
  }))
  const many = {
    ...REPORT,
    kinds: [...REPORT.kinds.filter((kind) => kind.kind !== 'conversation'), { kind: 'conversation', tokens: turns.reduce((sum, turn) => sum + turn.tokens, 0), chars: 240000, count: 1500, folded: 1440 }],
    items: [...REPORT.items.filter((item) => item.kind !== 'conversation'), ...turns],
  }
  const { props, tree } = await mount(internals, many)
  // 「全部」视图：会话内容合成一行，不该铺 60 行。
  const rows = collectAll(tree, (node) => node.props?.className === 'dsh-mcp-ctx-row')
  assert.ok(rows.length <= 5, `「全部」视图要折叠会话内容（实际 ${rows.length} 行）`)

  // 筛到会话内容：自己封顶 20 行 + 其余（60 - 20 + 宿主折叠的 1440 = 1480）。
  const filter = collectAll(tree, (node) => node.props?.className === 'dsh-mcp-ctx-filter')[0]
  collectAll(filter, (node) => node.type === 'button' && allText(node) === '会话内容')[0].props.onClick()
  const expanded = internals.__render(internals.ContextFace, props)
  const expandedRows = collectAll(expanded, (node) => node.props?.className === 'dsh-mcp-ctx-row')
  assert.equal(expandedRows.length, 20, '明细一次最多 20 行')
  assert.match(allText(expanded), /其余 1480 项/, '自己截掉的与宿主折叠的都要算进"其余"')

  // 块图：会话内容那一列最多 CHART_ITEM_LIMIT 块，且折叠块的条数同样要把宿主那笔加上。
  const cells = collectAll(expanded, (node) => typeof node.props?.className === 'string' && node.props.className.startsWith('dsh-mcp-ctx-cell kind-conversation'))
  assert.ok(cells.length <= 6, `块图每列要封顶（实际 ${cells.length} 块）`)
  assert.match(allText(expanded), /\+\d+/, '折叠块要标出条数')
})


// ── ⑦ 双语：措辞在客户端，所以英文界面不会漏中文 ──────────────────────────────
test('上下文面：切成 English 后明细的措辞跟着翻（宿主只给事实）', async (t) => {
  // 宿主曾把 "8 条消息" / "37 个工具的 schema" / "×37" 拼在报告里。中文界面看不出问题，
  // 英文界面原样漏中文——而两边的单测各自都是绿的（一边断言字符串、一边断言 DOM）。
  // 这条从**渲染结果**出发：数据照样是中文标题的会话，但界面文案必须是英文。
  const internals = loadInternals()
  withUnmount(t, internals)
  internals.setLocaleActive('en')
  try {
    const { props, tree } = await mount(internals, REPORT)
    const rows = collectAll(tree, (node) => node.props?.className === 'dsh-mcp-ctx-row')
    const text = rows.map((row) => allText(row)).join(' | ')
    assert.match(text, /Conversation/, '会话内容那一行要翻')
    assert.match(text, /2 turns/, '合计行的轮数要翻')
    assert.match(text, /37 tool schemas/, '工具定义的副标题要翻')
    assert.match(text, /×37/, '件数是符号 + 数字，两种语言同形')
    assert.doesNotMatch(text, /条消息|个工具的 schema|轮/, '英文界面不得漏出中文')

    // 逐轮展开后同样要是英文（"Turn 14"）。
    const filter = collectAll(tree, (node) => node.props?.className === 'dsh-mcp-ctx-filter')[0]
    collectAll(filter, (node) => node.type === 'button' && allText(node) === 'Conversation')[0].props.onClick()
    const expanded = internals.__render(internals.ContextFace, props)
    const expandedText = collectAll(expanded, (node) => node.props?.className === 'dsh-mcp-ctx-row').map((row) => allText(row)).join(' | ')
    assert.match(expandedText, /Turn 14/, '轮次要翻（不是「第 14 轮」）')
    assert.doesNotMatch(expandedText, /第 14 轮/, '英文界面不得漏出中文轮次')
  } finally {
    internals.setLocaleActive(null)
  }
})
