// ── 上下文观测面（「上下文」能力层）────────────────────────────────────────────
//
// 这一面只回答一个问题：**下一轮请求里，上下文被谁占着**。
//
// 数据全部来自宿主 `contextReport`（lib/context-report.js 组装），这里不做任何估算：
// 数字、分类、排序都是宿主给的；客户端只负责**排布**。
// 这条分工是刻意的——一旦客户端也开始算 token，面板里就会出现两个互相矛盾的数。
//
// ## 三条显示纪律
//
//   1. **总量与构成分开**：上面那个 `已用 / 上限` 是提供方报告的真值；treemap 是按这个真值
//      等比换算过的构成（同一构成内的比例不变，总量对得上）。换算系数会写在图注里。
//   2. **缺数就说缺**：宿主没挂 token-meter 时整面切成"按字符排布"，单位写"字符"，
//      不把字符数伪装成 token。
//   3. **不猜"当前会话"**：先读前端记的当前会话，读不到让宿主挑最近活跃的。
//
// ## 布局为什么是这个顺序
//
// 元素一多就容易乱，所以按"先总量、再构成、再细节"三层排，每层一个问题：
//   总量（多大 / 还剩多少）→ 构成（被谁占着）→ 工具（工具这块的细节）→ 明细（逐项）
//   → 轮次（时间维度）→ 搜索记录（过程）→ 脚注。
// 阅读顺序与问题的自然顺序一致，滚动时不会"跳回去找上下文"。

/**
 * 分类的固定顺序与中文标签。
 *
 * 顺序必须与宿主的 `CONTEXT_KINDS` 同序（`context-face.test.mjs` 有一条跨端断言钉住它）。
 * **文字只在客户端这一处**：宿主报告里没有 label/sublabel，只有 kind、工具名、计数、轮次。
 * 这是刻意的分工——宿主产出事实，客户端产出措辞（`t()` 在这里，也就只有这里能翻）。
 */
const CONTEXT_KIND_ORDER = ['system', 'tools', 'tool-result', 'attachment', 'conversation']

const CONTEXT_KIND_LABELS = {
  system: '系统提示词',
  tools: '工具定义',
  'tool-result': '工具结果',
  attachment: '附件',
  conversation: '会话内容',
}

/** 筛选器：全部 + 五类。标签从上面那张表推出来，不再手抄第三份。 */
const CONTEXT_FILTERS = [
  { id: 'all', label: '全部' },
  ...CONTEXT_KIND_ORDER.map((kind) => ({ id: kind, label: CONTEXT_KIND_LABELS[kind] })),
]

/**
 * 明细一次最多铺多少行、块图每列最多画几块。
 *
 * 长会话的条目是**按轮**增长的（真机一次会话 400+ 步），全铺出来就是上千个 DOM 行、
 * 上千条 1px 高的色带——既滚不动也读不出。折中：按大小取前 N 项（"最费上下文的是谁"
 * 本来就是这张表要回答的问题），剩下的合成一行/一块并**如实给出剩下的条数**。
 */
const DETAIL_ROW_LIMIT = 20
const CHART_ITEM_LIMIT = 6

/**
 * token 数的人类可读形式：`980` / `12.3K` / `1.2M`。
 *
 * 为什么不用 toLocaleString：中文语境下「324,112」读起来比「324K」慢，而这个面板要回答的
 * 是"还剩多少空间"，量级比精确位数重要。精确值放在 title 里（见 `exactTitle`）。
 */
const formatTokens = (value) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  if (abs >= 1000000) return (value / 1000000).toFixed(abs >= 10000000 ? 0 : 1) + 'M'
  if (abs >= 1000) {
    // 四舍五入后可能刚好到 1000（999,600 → "1000K"）：那不是 K 能表达的量级，进位成 M。
    const k = Math.round(value / 1000)
    if (Math.abs(k) >= 1000) return (value / 1000000).toFixed(1) + 'M'
    return String(k) + 'K'
  }
  return String(Math.round(value))
}

const exactTitle = (value, unit) => (typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString() + ' ' + unit : '')

const formatPercent = (ratio) => {
  if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return '—'
  const percent = ratio * 100
  if (percent > 0 && percent < 1) return '<1%'
  if (percent > 99.5 && percent < 100) return '99%+'
  return Math.round(percent) + '%'
}

/**
 * 块图**列内**的短标签。
 *
 * 列宽是按占比分列的，窄面板下小分类只剩四十来像素：那里放「系统提示词 / 工具定义」会被
 * 省略成「系统…」「工具…」——比短名字更难认。所以图里用短名，**图例、筛选器、明细仍用全名**
 * （它们有整行的宽度）。hover 的 title 也是全名。
 */
const CONTEXT_SHORT_LABELS = { system: '系统', tools: '工具', attachment: '附件', free: '剩余' }

/**
 * 条目的显示名与副标题。
 *
 * 宿主只给事实（kind / 工具名 / count / turn），措辞全部在这里：所以英文界面里不会有中文漏出。
 * 工具名是**标识符**，原样显示才对——它与模型看到的名字一致，翻译它反而让人对不上号。
 */
const contextItemLabel = (item) => {
  if (!item) return ''
  if (item.kind === 'free') return t('剩余空间')
  if (item.kind === 'rest') return t('其余 {count} 项', { count: item.count ?? 0 })
  if (item.kind === 'system') return t('系统提示词')
  if (item.kind === 'tools') return t('工具定义')
  // 「全部」视图里的会话内容是**一行合计**；逐轮只在「会话内容」筛选里出现。
  if (item.kind === 'conversation') return item.aggregate ? t('会话内容') : t('第 {turn} 轮', { turn: item.turn ?? 0 })
  if (item.kind === 'attachment') return t('附件')
  // 剩下的只有"按工具名合并的工具结果"：名字解析不到时说"未知工具"，不留一行空白。
  return String(item.label || '') || t('未知工具')
}

/** 块图里用的短名：只有分类级条目有短名，工具名与轮次照旧（它们本身就是短标识）。 */
const contextChartLabel = (item) => {
  const short = CONTEXT_SHORT_LABELS[item?.kind]
  return short ? t(short) : contextItemLabel(item)
}

/** 副标题：件数 / 条数这种**数量事实**，不是句子（"×37"读起来比"共 37 次调用"快）。 */
const contextItemSub = (item) => {
  if (!item) return null
  if (item.kind === 'tool-result' || item.kind === 'attachment') return '×' + (item.count ?? 0)
  if (item.kind === 'conversation') {
    return item.aggregate
      ? t('{count} 轮', { count: item.count ?? 0 })
      : t('{count} 条消息', { count: item.count ?? 0 })
  }
  if (item.kind === 'tools') return Number.isFinite(item.count) ? t('{count} 个工具的 schema', { count: item.count }) : null
  // 系统提示词的首行是内容本身（给读者一个"这条是什么"的抓手），宿主管它叫 preview。
  if (item.kind === 'system') return item.preview || null
  return null
}

/**
 * 把一类条目压到 `limit` 个：前 `limit - 1` 大项 + 一块"其余"。
 *
 * 只在**真的超了**的时候出现；没超时返回原数组，界面上不会多出一块"其余 0 项"。
 * `items` 已按大小降序（宿主排好的），这里不改顺序。
 *
 * @param {{id: string, value: number}[]} items
 * @param {number} limit
 * @returns {{items: object[], rest: {id: string, kind: string, value: number, count: number}|null}}
 */
const capItems = (items, limit) => {
  const list = Array.isArray(items) ? items : []
  if (limit <= 0 || list.length <= limit) return { items: list, rest: null }
  const head = list.slice(0, limit - 1)
  const tail = list.slice(limit - 1)
  return {
    items: head,
    rest: {
      id: 'rest',
      kind: 'rest',
      value: tail.reduce((sum, item) => sum + (Number.isFinite(item.value) ? item.value : 0), 0),
      count: tail.length,
    },
  }
}

/**
 * 按**分类分列**的块图。
 *
 * 为什么不是一次性 squarify 全局条目：分类顺序固定之后，小分类（附件常常只有几百字符）
 * 会被大分类挤成一条看不见的细线——真机第一版就是这样，图里只剩"工具结果"和"会话内容"
 * 两块大的，另外三类全在左侧 20px 里。
 *
 * ## 列宽按真实占比，只留一条"看得见"的下限
 *
 * 曾经把小分类抬到 68px 再归一化。真机宽度（悬浮面板 420px、六列）下这一步数学上给不到
 * 68px（6×68 > 388），归一化又把它收回去——于是小分类既没拿到可见宽度，面积也不再等比例：
 * 附件 2K 与系统提示词 29K 看起来一样宽，工具定义 36K 看起来是工具结果 442K 的三分之一。
 * 一张面积不按值的图，比没有图更糟（这正是这个面板一直想避免的"假精确"）。
 *
 * 所以：**列宽 = 真实占比**，只给细到看不见的类一个与容器成比例的极小下限
 * （宽度的 1.2%，夹在 2~8px），让"有这一类"能看出来；具体多大请读图例与明细。
 * 窄列放不下标签，也不硬塞——图例就是那张对照表。
 *
 * @param {{kind: string, label: string, value: number, items: {id: string, label: string, value: number, title?: string}[]}[]} groups
 *   已经按固定分类顺序排好
 * @param {number} width
 * @param {number} height
 * @returns {{tiles: {key: string, kind: string, label: string, value: number, x: number, y: number, w: number, h: number}[], columns: {kind: string, x: number, w: number}[]}}
 */
function layoutColumns(groups, width, height) {
  const list = (Array.isArray(groups) ? groups : []).filter((group) => Number.isFinite(group.value) && group.value > 0)
  if (list.length === 0 || !(width > 0) || !(height > 0)) return { tiles: [], columns: [] }
  const total = list.reduce((sum, group) => sum + group.value, 0)
  if (!(total > 0)) return { tiles: [], columns: [] }
  // 可见下限：只为"别让一个真实存在的类变成 0 像素"，不是"给它一个体面的宽度"。
  const floor = Math.min(8, Math.max(2, width * 0.012))
  const wanted = list.map((group) => Math.max(floor, (group.value / total) * width))
  const wantedSum = wanted.reduce((sum, value) => sum + value, 0)
  const scale = wantedSum > 0 ? width / wantedSum : 0
  const tiles = []
  const columns = []
  let x = 0
  list.forEach((group, index) => {
    const w = Math.max(1, wanted[index] * scale)
    // 列内条目按大小降序铺满该列（一列里通常只有 1~3 个条目，竖排比再次 squarify 更好读）。
    const items = (Array.isArray(group.items) ? group.items : []).filter((item) => Number.isFinite(item.value) && item.value > 0)
    const itemSum = items.reduce((sum, item) => sum + item.value, 0)
    if (items.length === 0) {
      tiles.push({ key: 'col:' + group.kind, kind: group.kind, label: group.label, value: group.value, x, y: 0, w, h: height })
    } else if (itemSum <= 0) {
      tiles.push({ key: 'col:' + group.kind, kind: group.kind, label: group.label, value: group.value, x, y: 0, w, h: height })
    } else {
      let y = 0
      items.forEach((item, itemIndex) => {
        // 最后一块吃掉舍入误差，避免底部留一条缝。
        const tileHeight = itemIndex === items.length - 1 ? height - y : (item.value / itemSum) * height
        tiles.push({ key: 'item:' + item.id, kind: group.kind, label: item.label, title: item.title, value: item.value, x, y, w, h: Math.max(1, tileHeight) })
        y += tileHeight
      })
    }
    columns.push({ kind: group.kind, x, w })
    x += w
  })
  return { tiles, columns }
}

/**
 * 网格视图：把一个值切成若干个等量方块（参考"格子墙"那种读法）。
 *
 * 与块图的分工：块图回答"谁大谁小"，网格回答"一共多少个格子、填了多少"——
 * 后者对"还剩多少"的直觉更强（空格子看得见）。每格代表固定量（自动取整），
 * 所以格子数随用量增长，超过上限就按比例放大每格的量（并在图注里说明）。
 *
 * @param {{kind: string, value: number}[]} segments 按分类顺序的用量
 * @param {number} capacity 总容量（与 segments 同单位）
 * @param {number} maxCells 最多画多少格（防止 100 万 token 画出 500 格×N 卡住浏览器）
 * @returns {{cells: {kind: string, value: number}[], unit: number, capped: boolean}}
 */
function buildGridCells(segments, capacity, maxCells) {
  const used = segments.reduce((sum, segment) => sum + Math.max(0, segment.value), 0)
  const span = Math.max(used, Number.isFinite(capacity) ? capacity : 0)
  if (!(span > 0) || !(maxCells > 0)) return { cells: [], unit: 0, capped: false }
  let unit = Math.ceil(span / maxCells)
  // 取一个"整"的单位，读起来舒服（2K、5K、10K…），也让格子边界稳定。
  const nice = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000]
  const scaled = nice.find((step) => step >= unit) ?? unit
  unit = scaled
  const cells = []
  let capped = false
  let budget = maxCells
  for (const segment of segments) {
    if (segment.value <= 0) continue
    const count = Math.max(1, Math.round(segment.value / unit))
    for (let index = 0; index < count && budget > 0; index += 1) {
      cells.push({ kind: segment.kind, value: unit })
      budget -= 1
    }
    if (budget === 0) { capped = true; break }
  }
  // 剩余空间也画成格子（暗格），这样"填满度"一眼可见。
  const capacityCells = Number.isFinite(capacity) ? Math.round(capacity / unit) : cells.length
  while (cells.length < capacityCells && budget > 0) {
    cells.push({ kind: 'free', value: unit })
    budget -= 1
  }
  if (cells.length < capacityCells) capped = true
  return { cells, unit, capped }
}

// 较老的宿主可能不提供连接代次；仍按选择、call 与布局生命周期隔离。
const NO_CONTEXT_GENERATION = { getSnapshot: () => undefined, subscribe: () => () => {} }

/**
 * 「上下文」能力面。
 *
 * 轮询而不是订阅：读的是一份**派生快照**（日志 → 价格 → 汇总），宿主没有为它开事件；
 * 3s 一次、只在面板开着时跑。
 */
const ContextFace = ({ call, connectionGeneration = NO_CONTEXT_GENERATION }) => {
  const [snapshot, setSnapshot] = useState(null)
  const [failure, setFailure] = useState(null)
  const [loadingSource, setLoadingSource] = useState(null)
  const [filter, setFilter] = useState('all')
  const [view, setView] = useState('treemap')
  // null = 总览（单会话时直接显示详情）；有值 = 用户明确选择的会话。
  const [selection, setSelection] = useState(() => ({ targetId: null }))
  const { targetId } = selection
  const selected = useRef(selection)
  const active = useRef(null)
  const [box, setBox] = useState({ w: 0, h: 288 })
  const boxRef = useRef(null)
  const generation = useSyncExternalStore(connectionGeneration.subscribe, connectionGeneration.getSnapshot)
  const selectTarget = useCallback((targetId) => {
    const next = { targetId }
    selected.current = next
    setSelection(next)
  }, [])

  // Note: 完成顺序与 loading 归属必须分开 — .agents/notes/implemented/2026-11-20-p1-commit-scope-ownership.md
  const source = useMemo(() => ({ selection, call, connectionGeneration, generation }), [selection, call, connectionGeneration, generation])
  useLayoutEffect(() => {
    // 真实 React 提交新树后，被动 cleanup 可能还在排队；卸载也在 layout 清掉归属。
    const owner = { source, issued: 0, committed: 0 }
    active.current = owner
    return () => { if (active.current === owner) active.current = null }
  }, [source])

  const load = useCallback(async (origin) => {
    const owner = active.current
    if (owner?.source !== origin) return
    const inScope = () => active.current === owner && selected.current === origin.selection
      && Object.is(origin.generation, origin.connectionGeneration.getSnapshot())
    if (!inScope()) return
    const sequence = ++owner.issued
    const commitResult = () => {
      // 同源结果按已完成序号推进，不让慢于轮询间隔的 RPC 一直饿死。
      if (!inScope() || sequence < owner.committed) return false
      owner.committed = sequence
      return true
    }
    setLoadingSource(origin)
    const wanted = origin.selection.targetId
    try {
      const result = await origin.call('contextReport', wanted ? { sessionId: wanted } : {})
      if (!commitResult()) return
      if (!result || result.ok === false) {
        setFailure({ source: origin, message: (result && result.error) || t('上下文读取失败') })
        return
      }
      setFailure(null)
      // 宿主找不到已选会话时会回退到最近活跃会话；该报告只可用来恢复总览。
      const overviewOnly = wanted && result.session && result.session.id !== wanted
      setSnapshot({ source: origin, value: result, overviewOnly })
      if (overviewOnly) selectTarget(null)
    } catch (error) {
      if (commitResult()) setFailure({ source: origin, message: (error && error.message) || t('上下文读取失败') })
    } finally {
      if (inScope() && sequence === owner.issued) setLoadingSource(null)
    }
  }, [selectTarget])

  useEffect(() => {
    let alive = true
    load(source)
    const interval = setInterval(() => { if (alive) load(source) }, 3000)
    return () => { alive = false; clearInterval(interval) }
  }, [load, source])

  const report = snapshot?.source === source && !snapshot.overviewOnly ? snapshot.value : null
  const error = failure?.source === source ? failure.message : ''
  const loading = loadingSource === source
  // 返回多会话总览时只保留同一连接的列表摘要，绝不把上一选择的详情当成当前报告。
  const previous = snapshot?.source
  const sameConnection = previous?.call === call && previous?.connectionGeneration === connectionGeneration && Object.is(previous?.generation, generation)
  const overviewSessions = targetId === null && sameConnection && Array.isArray(snapshot.value.sessions) ? snapshot.value.sessions : []
  const showAllSessions = overviewSessions.length > 1
  const back = targetId !== null
    ? h('button', { type: 'button', className: 'dsh-mcp-ctx-back', onClick: () => selectTarget(null) }, t('← 全部会话'))
    : null
  const pendingBar = back ? h('div', { className: 'dsh-mcp-ctx-sessions' }, back) : null

  // 宽度量容器（treemap / 网格都按真实像素排布），量不到就按面板宽度估。
  useEffect(() => {
    const el = boxRef.current
    if (!el) return undefined
    const measure = () => setBox({ w: el.clientWidth || 0, h: 288 })
    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [report, view])

  // ── 多会话：先给"全部会话"总览 ────────────────────────────────────────────
  //
  // 同时跑多个工作区是常态（用户原话："我使用的时候都是好几个工作区，好几个会话同时的"），
  // 所以多会话时不该把人锁在一个会话的详情里、再让他去顶部找芯片切换。先给一屏总览：
  // 每个会话一行，带用量条，谁快满了、谁正在生成一眼看出。点进去才看详情。
  // 单会话用户的路径不变——直接进详情，不经过这一屏。
  if (showAllSessions) {
    return h('div', { className: 'dsh-mcp-ctx' },
      h('div', { className: 'dsh-mcp-ctx-all-head' },
        h('div', { className: 'dsh-mcp-ctx-all-title' }, t('{count} 个会话正在运行', { count: overviewSessions.length })),
        loading ? h('span', { className: 'dsh-mcp-ctx-foot-live' }, t('更新中')) : null,
      ),
      h('div', { className: 'dsh-mcp-ctx-all' },
        ...overviewSessions.map((entry) => {
          const percent = typeof entry.ratio === 'number' ? Math.min(100, Math.max(0.5, entry.ratio * 100)) : 0
          const tone = typeof entry.ratio !== 'number' ? '' : entry.ratio >= 0.8 ? ' err' : entry.ratio >= 0.5 ? ' warn' : ' ok'
          return h('button', {
            key: 'all:' + entry.id,
            type: 'button',
            className: 'dsh-mcp-ctx-allrow' + (entry.running ? ' running' : ''),
            title: entry.cwd || entry.id,
            onClick: () => selectTarget(entry.id),
          },
            h('div', { className: 'dsh-mcp-ctx-allrow-top' },
              entry.workspace ? h('span', { className: 'dsh-mcp-ctx-session-ws' }, entry.workspace) : null,
              h('span', { className: 'dsh-mcp-ctx-allrow-title' }, entry.title || String(entry.id).slice(0, 16)),
              entry.running ? h('span', { className: 'dsh-mcp-ctx-allrow-live' }, t('生成中')) : null,
            ),
            h('div', { className: 'dsh-mcp-ctx-meter thin' },
              h('span', { className: 'dsh-mcp-ctx-meter-fill' + tone, style: { width: percent + '%' } })),
            h('div', { className: 'dsh-mcp-ctx-allrow-meta' },
              // 纯数字拼装，没有中文可翻——不走 t()（给同形译文建词条会被死键检查判掉）。
              typeof entry.used === 'number'
                ? `${formatTokens(entry.used)} / ${formatTokens(entry.window)} · ${formatPercent(entry.ratio)}`
                : t('还没有数据'),
              typeof entry.requests === 'number' && entry.requests > 0 ? t(' · {count} 次请求', { count: entry.requests }) : null,
            ),
          )
        }),
      ),
    )
  }

  if (error && report === null) {
    return h('div', { className: 'dsh-mcp-ctx' },
      pendingBar,
      h('div', { className: 'dsh-mcp-d-err', role: 'alert' }, error),
      h('button', { type: 'button', className: 'dsh-mcp-btn sm', onClick: () => load(source) }, t('重试')),
    )
  }
  if (report === null) {
    return h('div', { className: 'dsh-mcp-ctx' }, pendingBar, h('div', { className: 'dsh-mcp-ctx-empty' }, t('正在读取上下文…')))
  }
  const items = Array.isArray(report.items) ? report.items : []
  const budget = report.budget || {}
  const cache = report.cache || {}
  const billed = report.billed || { prompt: 0, requests: 0 }
  const toolInfo = report.tools || {}
  const search = toolInfo.search || { calls: 0, byName: 0, byKeyword: 0, recent: [] }
  const session = report.session || {}
  const route = report.route || {}
  const sessions = Array.isArray(report.sessions) ? report.sessions : []
  const used = budget.used
  const windowTokens = budget.window

  if (report.empty === true || !report.session) {
    // 空状态就是空的：**通用**提示，不指向任何会话。
    //
    // 这个面板是全局的——一个入口覆盖所有工作区与所有会话，所以"现在没有会话在运行"
    // 本身就是完整的事实。早先这里写"这个会话没在运行"并跟一串会话 id，是在暗示
    // "面板属于某个会话"，与它的定位相反；用户的原话是"我那么多会话你为啥显示这个"。
    return h('div', { className: 'dsh-mcp-ctx' },
      pendingBar,
      h('div', { className: 'dsh-mcp-ctx-blank' },
        h('div', { className: 'dsh-mcp-ctx-blank-title' }, t('现在没有会话在运行')),
        h('div', { className: 'dsh-mcp-ctx-blank-note' }, t('跑起来之后，这里会显示每个会话占用了多少上下文。')),
      ),
    )
  }
  // 会话活着、但**一次请求都还没发过**：也没有任何东西可画。此时不要画一堆"—"卡片再在底部
  // 解释一遍为什么是空的——那就是用户说的"废话"。一个空状态说清"发消息就会有了"即可。
  //
  // ⚠️ 判据用 `session.requests`，不能用"items 为空"：报告里总有一个「工具定义」条目（哪怕
  // 值是 0），所以 items 永远非空——真机上这条判断就是这么失效的，面板照旧画出一整页破折号。
  if (Number(session.requests ?? 0) === 0 && typeof used !== 'number') {
    // 保持**通用说法**（"还没有会话发出过请求"），不点名具体会话：这个面板是全局的，一个入口
    // 覆盖所有工作区；早先这里跟一串会话 id，用户的原话是"我那么多会话你为啥显示这个？"。
    return h('div', { className: 'dsh-mcp-ctx' },
      pendingBar,
      h('div', { className: 'dsh-mcp-ctx-blank' },
        h('div', { className: 'dsh-mcp-ctx-blank-title' }, t('还没有会话发出过请求')),
        h('div', { className: 'dsh-mcp-ctx-blank-note' }, t('跑起来之后，这里会显示每个会话占用了多少上下文。')),
      ),
    )
  }
  // ⚠️ 不要叫 window：那是浏览器全局，同名会让 ResizeObserver 兜底路径读错东西。
  const ratio = budget.ratio
  // 单位：宿主给了至少一个价格就按 token 排布，否则整面退化成"字符"。
  // 'token' 中英同形，所以**不过 t()**——给同形译文建词典条目会被死键检查判掉。
  const priced = items.some((item) => typeof item.tokens === 'number')
  const unit = priced ? 'token' : t('字符')
  const valueOf = (item) => (priced ? item.tokens : item.chars)
  // 分母取宿主给的 `totals.itemTokens`（**封顶前**的全量和），不拿手里这些条目现加：
  // 宿主每类最多带 24 条，自己加出来的和会偏小，于是换算系数把缺口摊到剩下的条目上——
  // 数字变大、还"加得起来"。这正是这个面板反复要避免的那种假精确。
  const carried = items.reduce((sum, item) => sum + (Number.isFinite(valueOf(item)) ? valueOf(item) : 0), 0)
  const sumOfItems = priced && Number.isFinite(report.totals?.itemTokens) && report.totals.itemTokens > 0
    ? report.totals.itemTokens
    : carried
  // 等比换算：把估算构成放大/缩小到**真实总量**（构成内比例不变，各处数字加起来对得上）。
  //
  // ⚠️ 只在**每一类都有价格**（宿主 `totals.measured`）时才换算。缺了某一类的价格时，剩下
  // 几类会被按 `used/已量总和` 放大——看起来仍然铺满、仍然"对得上总量"，实际每个数都偏大，
  // 而偏大的幅度正是缺失的那一类所占的份额（工具定义常见 10~20%）。这是把"未知"算成"零"
  // 的一种变体，且它伪装成完整。此时宁可不换算：数字是估算原值，缺口留在图上。
  const measured = report.totals?.measured === true
  const factor = priced && measured && typeof used === 'number' && sumOfItems > 0 ? used / sumOfItems : 1
  /**
   * 一个条目在**当前尺度**下的大小。
   *
   * ⚠️ 字段必须按 `priced` 选，**不能靠调用方记得传**：曾经写成 `sizeOf(item, field)` 且
   * 默认 `field` 落到 `chars`，于是有 token 价格时块图与明细显示的全是字符数
   * （真机：图例 44K、格子 175K，同一屏两个数）。这类"可选参数默认值错"只有对比两处
   * 数字才看得出来，所以这里不给参数。
   */
  const sizeOf = (item) => {
    const raw = priced ? item.tokens : item.chars
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0
    return Math.max(1, Math.round(raw * factor))
  }
  const remaining = typeof budget.remaining === 'number' ? budget.remaining : null
  // ⚠️ **剩余空间与容量的单位必须跟着构成走**。构成在"有价格"时是 token、在只有字符账时是字符，
  // 而 `remaining` / `budget.window` 永远是 token。直接摆进同一个块图就是量纲混用
  // （真机：549K token 的剩余被 861K 字符的会话内容压成一小块）。
  // 换算口径：used 个 token 对应 sumOfItems 个字符，所以 1 个 token ≈ sumOfItems/used 个字符。
  const charPerToken = !priced && typeof used === 'number' && used > 0 && sumOfItems > 0 ? sumOfItems / used : 1
  const toDisplay = (tokenValue) => (typeof tokenValue !== 'number' || !Number.isFinite(tokenValue)
    ? null
    : priced ? tokenValue : Math.round(tokenValue * charPerToken))
  const remainingDisplay = toDisplay(remaining)
  const capacityDisplay = toDisplay(typeof windowTokens === 'number' ? windowTokens : null)
  const health = typeof ratio !== 'number' ? '' : ratio >= 0.8 ? ' err' : ratio >= 0.5 ? ' warn' : ' ok'
  const healthLabel = typeof ratio !== 'number' ? t('未知') : ratio >= 0.8 ? t('接近上限') : ratio >= 0.5 ? t('偏高') : t('健康')
  const avgRequest = billed.requests > 0 && typeof used === 'number' ? billed.prompt / billed.requests : null
  const room = remaining !== null && avgRequest !== null && avgRequest > 0 ? Math.floor(remaining / avgRequest) : null

  // ── 构成：按**分类固定顺序**聚合（不按面积），分类内按大小降序 ──────────────
  //
  // 每列最多 `CHART_ITEM_LIMIT` 块：长会话的「会话内容」是按轮的（真机 400+ 轮），全画出来
  // 就是几百条 1px 高的色带，既看不见也点不到。取最大的几项 + 一块"其余"，饼图/块图都是
  // 这个读法；剩下的条数写在那一块上，不悄悄丢。
  //
  // 这里的排序与宿主"分类内按大小降序"同向且同序（缩放系数是常数，不改变大小关系），
  // 只是为了决定**折叠哪几项**——不是第二个排序真相源（明细列表那边就不排，见 ⑥）。
  const chartItemsOf = (own, kind, folded, kindValue) => {
    const mapped = own
      .map((item) => ({ id: item.id, label: contextChartLabel(item), value: sizeOf(item) }))
      .sort((left, right) => right.value - left.value)
    const { items: head, rest } = capItems(mapped, CHART_ITEM_LIMIT)
    const hidden = (rest ? rest.count : 0) + (Number.isFinite(folded) ? folded : 0)
    if (hidden === 0) return head
    // 折叠块在窄列里放不下"其余 N 项"（实测被省略成「其…」），所以块里只写 `+N`，
    // 展开的说法放进 title。
    //
    // 它的大小 = **这一类总量 − 已画出的那些**：宿主折叠掉的那 N 条没有单条大小，但它们的
    // 合计是已知的（分类合计）。用"手里这些的和"当块值会让那一截在列里显得比实际小得多。
    const headSum = head.reduce((sum, item) => sum + item.value, 0)
    const restValue = Number.isFinite(kindValue) ? Math.max(1, Math.round(kindValue) - headSum) : (rest ? rest.value : 1)
    return [...head, {
      id: 'rest:' + kind,
      label: '+' + hidden,
      title: t('其余 {count} 项', { count: hidden }),
      value: restValue,
    }]
  }
  const kindDeclared = (kind) => (Array.isArray(report.kinds) ? report.kinds : []).find((entry) => entry.kind === kind) || null
  // 宿主每类最多带 `MAX_ITEMS_PER_KIND` 条，没带过来的条数在 `folded` 里——"其余 N 项"要把
  // 这两笔加起来，否则长会话会被报少一大截（"其余 3 项"其实是 1403 项）。
  const foldedOf = (kind) => {
    const declared = kindDeclared(kind)
    return declared && Number.isFinite(declared.folded) ? declared.folded : 0
  }
  const kindTotals = new Map()
  for (const kind of CONTEXT_KIND_ORDER) {
    const own = items.filter((item) => item.kind === kind)
    if (own.length === 0) continue
    // 分类合计优先取宿主给的 kinds（唯一真源），没有再按条目求和。
    const declared = kindDeclared(kind)
    const tokens = declared && Number.isFinite(declared.tokens) ? declared.tokens : own.reduce((sum, item) => sum + (Number.isFinite(item.tokens) ? item.tokens : 0), 0)
    const chars = declared && Number.isFinite(declared.chars) ? declared.chars : own.reduce((sum, item) => sum + (Number.isFinite(item.chars) ? item.chars : 0), 0)
    const value = priced ? tokens : chars
    kindTotals.set(kind, {
      kind,
      label: CONTEXT_KIND_LABELS[kind] || kind,
      value: Number.isFinite(value) ? value * factor : 0,
      count: own.length,
      items: chartItemsOf(own, kind, foldedOf(kind), Number.isFinite(value) ? value * factor : 0),
    })
  }
  // 只画**有量**的分类。值为 0 的类不是"谁占着"，画出来只会多一条没有意义的边
  // （早先按面积全局排布时更糟：0 会被抬成占满屏幕的一整块，比不画还误导）。
  const segments = CONTEXT_KIND_ORDER
    .map((kind) => kindTotals.get(kind))
    .filter(Boolean)
    .filter((segment) => segment.value > 0)

  const layout = layoutColumns(
    [
      ...segments.map((segment) => ({ ...segment, value: Math.max(1, Math.round(segment.value)) })),
      // 剩余空间作为**最后一列**（不是第一列）。真机反馈说"剩余的显示在左边有点反直觉"——
      // 那是按面积降序的必然结果。分类固定顺序 + 剩余放尾部，读者从左往右看的是
      // "谁占着"，最右边那列才是"还剩多少"，与进度条的直觉一致。
      ...(remainingDisplay !== null && remainingDisplay > 0
        ? [{
          kind: 'free',
          label: t('剩余空间'),
          value: remainingDisplay,
          items: [{ id: 'free', label: t('剩余'), value: remainingDisplay }],
        }]
        : []),
    ],
    box.w || 760,
    box.h || 288,
  )
  const grid = buildGridCells(
    segments.map((segment) => ({ kind: segment.kind, value: Math.max(1, Math.round(segment.value)) })),
    capacityDisplay,
    420,
  )

  const legend = segments.length === 0 && remainingDisplay === null ? null : h('div', { className: 'dsh-mcp-ctx-legend' },
    ...segments.map((segment) => h('span', { key: 'legend:' + segment.kind, className: 'dsh-mcp-ctx-legend-item', title: exactTitle(Math.round(segment.value), unit) },
      h('span', { className: 'dsh-mcp-ctx-dot kind-' + segment.kind }),
      h('span', { className: 'dsh-mcp-ctx-legend-label' }, t(segment.label)),
      h('span', { className: 'dsh-mcp-ctx-legend-size' }, formatTokens(segment.value) + ' ' + unit),
    )),
    remainingDisplay !== null ? h('span', { className: 'dsh-mcp-ctx-legend-item free', title: exactTitle(remaining, 'token') },
      h('span', { className: 'dsh-mcp-ctx-dot kind-free' }),
      h('span', { className: 'dsh-mcp-ctx-legend-label' }, t('剩余空间')),
      h('span', { className: 'dsh-mcp-ctx-legend-size' }, formatTokens(remainingDisplay) + ' ' + unit),
    ) : null,
  )

  // ── 顶部：总览 + 缓存 ────────────────────────────────────────────────────
  const overview = h('div', { className: 'dsh-mcp-ctx-overview' },
    h('div', { className: 'dsh-mcp-ctx-card wide' },
      h('div', { className: 'dsh-mcp-ctx-card-label' }, t('已用上下文'), h('span', { className: 'dsh-mcp-ctx-badge' + health }, healthLabel)),
      h('div', { className: 'dsh-mcp-ctx-card-value' },
        // 还没发出过请求时没有"已用"这个数：只放一个破折号，不画成「— / 1.0M token」——
        // 那样读起来像"用量正好是 0"，而真实情况是"还不知道"。
        used === null
          ? h('b', null, '—')
          : h(React2.Fragment, null,
            h('b', null, formatTokens(used)),
            h('span', { className: 'dsh-mcp-ctx-card-sep' }, '/'),
            h('span', { className: 'dsh-mcp-ctx-card-cap' }, formatTokens(windowTokens)),
            h('span', { className: 'dsh-mcp-ctx-card-unit' }, 'token'),
          ),
      ),
      h('div', { className: 'dsh-mcp-ctx-card-note' },
        // 没有 ratio 就**什么都不写**：卡片上那个破折号已经把"没有这个数"说完了，
        // 再补一句"还没发出过请求"在"发过请求但提供方没回用量"时还是**假的**。
        typeof ratio === 'number'
          ? t('已用 {percent} · 还剩 {free}', { percent: formatPercent(ratio), free: formatTokens(remaining) })
          : null,
        room === null ? null : t(' · 大约还能发 {count} 条', { count: room }),
      ),
      typeof ratio === 'number'
        ? h('div', { className: 'dsh-mcp-ctx-meter', role: 'img', 'aria-label': t('已用上下文 {percent}', { percent: formatPercent(ratio) }) },
          h('span', { className: 'dsh-mcp-ctx-meter-fill' + health, style: { width: Math.min(100, Math.max(0.5, ratio * 100)) + '%' } }))
        : null,
    ),
    h('div', { className: 'dsh-mcp-ctx-card' },
      h('div', { className: 'dsh-mcp-ctx-card-label' }, t('提示词缓存')),
      h('div', { className: 'dsh-mcp-ctx-card-value sm' }, formatPercent(cache.hitRate), h('span', { className: 'dsh-mcp-ctx-card-unit' }, t('命中'))),
      h('div', { className: 'dsh-mcp-ctx-card-note' },
        // 命中率已经是主角（上面那个大数字），这里只补**要全额付费的那部分**。
        // 曾经写"616K 来自缓存 · 39K 新增"：一半是上面那个百分比已经说完的事，而且在窄面板
        // 里正好挤出换行（"新增"被拆到第二行）。一个事实只说一次。
        typeof cache.fresh === 'number'
          ? t('新增 {fresh}', { fresh: formatTokens(cache.fresh) })
          : t('整场 {percent}', { percent: formatPercent(cache.sessionHitRate) }),
      ),
      // 没有命中率就不画这条进度条：0.5% 宽的空条读起来是"命中 0%"，而真实情况是"不知道"。
      // 上面那个大数字已经写着破折号，这里留白就够（与左边"已用上下文"同一条纪律）。
      typeof cache.hitRate === 'number'
        ? h('div', { className: 'dsh-mcp-ctx-meter thin' },
          h('span', { className: 'dsh-mcp-ctx-meter-fill ok', style: { width: Math.min(100, Math.max(0.5, cache.hitRate * 100)) + '%' } }))
        : null,
    ),
  )

  // ── 构成：视图切换 + 两种画法 ─────────────────────────────────────────────
  const viewSwitch = h('div', { className: 'dsh-mcp-ctx-viewswitch', role: 'group', 'aria-label': t('构成视图') },
    ...[['treemap', t('块图')], ['grid', t('网格')]].map(([id, label]) => h('button', {
      key: 'view:' + id,
      type: 'button',
      'aria-pressed': view === id,
      className: view === id ? 'sel' : '',
      onClick: () => setView(id),
    }, label)),
  )

  // 图表对读屏是噪声：每个色块只是一个数字，而它要说的事在图例里**已经是文字**了
  // （分类名 + 数值），明细里还有逐项数字。所以整块 aria-hidden，别让读屏逐块念。
  const treemap = h('div', { className: 'dsh-mcp-ctx-map', ref: boxRef, 'aria-hidden': 'true', style: { height: (box.h || 288) + 'px' } },
    layout.tiles.length === 0
      ? h('div', { className: 'dsh-mcp-ctx-empty' }, t('还没有可排布的上下文内容'))
      : layout.tiles.map((tile) => {
        // 标签要**宽**也要**高**：列宽现在按真实占比分，小分类只有几像素，放标签只会得到
        // 一条被裁掉的色带。放不下就不放——图例就是那张对照表，悬停的 title 也带全名。
        const hasLabel = tile.h >= 38 && tile.w >= 44
        const hasSize = tile.h >= 38 && tile.w >= 58
        return h('div', {
          key: tile.key,
          className: 'dsh-mcp-ctx-cell kind-' + tile.kind + (tile.kind === 'free' ? ' free' : ''),
          style: { left: tile.x + 'px', top: tile.y + 'px', width: tile.w + 'px', height: tile.h + 'px' },
          title: t('{label}：{size} {unit}', { label: tile.title ?? tile.label, size: formatTokens(tile.value), unit }),
        },
          hasLabel ? h('span', { className: 'dsh-mcp-ctx-cell-label' }, tile.label) : null,
          hasSize ? h('span', { className: 'dsh-mcp-ctx-cell-size' }, formatTokens(tile.value)) : null,
          !hasLabel && tile.w >= 40 && tile.h >= 18 ? h('span', { className: 'dsh-mcp-ctx-cell-size only' }, formatTokens(tile.value)) : null,
        )
      }),
  )

  const gridView = h('div', { className: 'dsh-mcp-ctx-grid' + (grid.capped ? ' capped' : ''), ref: boxRef, 'aria-hidden': 'true' },
    ...grid.cells.map((cell, index) => h('span', {
      key: 'cell:' + index,
      className: 'dsh-mcp-ctx-grid-cell kind-' + cell.kind,
      title: cell.kind === 'free' ? t('剩余空间') : t(CONTEXT_KIND_LABELS[cell.kind] || cell.kind),
    })),
  )

  const composition = h('section', { className: 'dsh-mcp-ctx-section' },
    h('div', { className: 'dsh-mcp-ctx-section-head' },
      h('h4', { className: 'dsh-mcp-ctx-section-title' }, t('上下文被谁占着')),
      h('div', { className: 'dsh-mcp-ctx-section-tools' },
        h('span', { className: 'dsh-mcp-ctx-section-hint' },
          view === 'grid'
            ? (grid.unit > 0 ? t('每格 {size}，共 {count} 格', { size: formatTokens(grid.unit), count: grid.cells.length }) : t('没有可画的内容'))
            : null),
        viewSwitch,
      ),
    ),
    view === 'treemap' ? treemap : gridView,
    legend,
  )

  // ── 工具：数量 / 占比 / 搜索 ──────────────────────────────────────────────
  //
  // 三格：工具数（多少）、占上下文（多大一块）、搜索次数（找过几次）。原来还有一格
  // 「搜索结果」单独报字符数——那个数对决策没有用；「占上下文」原来一格数字加一条占比条，
  // 两处说同一件事，现在合成一格：值就是占比，副标题给绝对量。
  const statTile = (label, value, note) => h('div', { className: 'dsh-mcp-ctx-stat', key: 'stat:' + label },
    h('span', { className: 'dsh-mcp-ctx-stat-value' }, value),
    h('span', { className: 'dsh-mcp-ctx-stat-label' }, label),
    note ? h('span', { className: 'dsh-mcp-ctx-stat-note' }, note) : null,
  )
  // ⚠️ 有 token 价格时**不能**拿字符数乘换算系数：那个系数是 token→token 的刻度，
  // 乘到字符上得到的是一个既不是字符也不是 token 的数（降级态里最容易出现的量纲混用）。
  const toolTokens = Number.isFinite(toolInfo.tokens)
    ? toolInfo.tokens * factor
    : (priced ? null : (Number.isFinite(toolInfo.chars) ? toolInfo.chars : null))
  const toolShare = Number.isFinite(toolTokens) && Number.isFinite(used) && used > 0 ? toolTokens / used : null
  // 目录状态一行（原「目录体检」）：多少台 MCP 的工具不随每轮发送、那份目录本身多大、
  // 有没有被上限截掉。只用**人话**，不出现"预算 / 延迟 / revision"这类实现词。
  const catalog = report.catalog || null
  const assembly = catalog?.lastAssembly ?? null
  const deferred = Array.isArray(catalog?.deferredServers) ? catalog.deferredServers : []
  const catalogParts = []
  if (deferred.length > 0) {
    // 「的工具」不是啰嗦：`names` 在超过三台时以"等 N 台"结尾，用「的」才能直接接上，
    // 写成"台 按需搜索"会多出一个看起来像错字空格。
    catalogParts.push(t('{names} 的工具按需搜索', { names: deferred.slice(0, 3).join(t('、')) + (deferred.length > 3 ? t(' 等 {count} 台', { count: deferred.length }) : '') }))
  }
  if (assembly && Number.isFinite(assembly.chars)) {
    // 行首那个「目录」标签已经说明了这是什么，这里不再重复一次"目录"。
    catalogParts.push(t('{chars} 字符／轮', { chars: Math.round(assembly.chars) }))
  }
  // 只在**被截断**时说；没截断就什么都不说——"没有截断"是一句没人需要的信息。
  if (assembly && Number.isFinite(assembly.truncated) && assembly.truncated > 0) {
    catalogParts.push(t('截掉 {count} 个', { count: assembly.truncated }))
  }
  const catalogLine = catalogParts.length === 0 ? null : h('div', { className: 'dsh-mcp-ctx-catalog' + (assembly && assembly.truncated > 0 ? ' warn' : '') },
    h('span', { className: 'dsh-mcp-ctx-catalog-label' }, t('目录')),
    h('span', { className: 'dsh-mcp-ctx-catalog-text' }, catalogParts.join(' · ')),
    assembly && assembly.truncated > 0
      // 给**下一步**，不解释机制：去哪里、改哪个名字，都用「工具」页上那个设置的原名
      // （那里叫「限制目录大小」，这里叫「目录上限」的话就是同一个东西的两个名字）。
      ? h('span', { className: 'dsh-mcp-ctx-catalog-hint' }, t('截掉的只能靠关键词碰运气；到「工具」页把「限制目录大小」调大就能全部列出。'))
      : null,
  )
  const toolsSection = h('section', { className: 'dsh-mcp-ctx-section' },
    h('div', { className: 'dsh-mcp-ctx-section-head' },
      h('h4', { className: 'dsh-mcp-ctx-section-title' }, t('工具')),
    ),
    h('div', { className: 'dsh-mcp-ctx-stats' },
      statTile(t('工具数'), toolInfo.total === null || toolInfo.total === undefined ? '—' : String(toolInfo.total), null),
      statTile(
        t('占上下文'),
        formatPercent(toolShare),
        Number.isFinite(toolTokens) ? formatTokens(toolTokens) + ' ' + unit : '—',
      ),
      statTile(t('搜索次数'), String(search.calls ?? 0), t('按名 {byName} · 关键词 {byKeyword}', { byName: search.byName ?? 0, byKeyword: search.byKeyword ?? 0 })),
    ),
    // 工具目录的状态（原来在工具页叫「目录体检」）：读者在这里已经知道"工具占多少"，
    // 紧接着回答"那份目录本身有多大、有没有被上限截掉"。放在这一卡里，不另开一块。
    catalogLine,
  )

  // ── 明细 ────────────────────────────────────────────────────────────────
  //
  // 会话内容在「全部」视图里**合成一行**（"会话内容 · 14 轮"）：逐轮明细是时间序列，下面的
  // 「每轮用掉多少」已经画得更好；把 14 行几乎一样的"第 N 轮 / 6 条消息"铺在这里，只会把
  // 真正有差别的那几行（工具名）挤下去。点「会话内容」筛选时再看逐轮。
  const conversationDeclared = kindDeclared('conversation')
  const conversationItems = items.filter((item) => item.kind === 'conversation')
  const conversationRow = conversationDeclared && conversationItems.length > 0
    ? {
      id: 'kind:conversation',
      kind: 'conversation',
      aggregate: true,
      // 值取宿主的分类合计（真的那才是全量，手里的条目可能被宿主的 24 条上限截过）。
      tokens: conversationDeclared.tokens,
      chars: conversationDeclared.chars,
      count: conversationDeclared.count,
      turn: null,
    }
    : null
  const withoutConversation = items.filter((item) => item.kind !== 'conversation')
  const filteredItems = filter === 'all'
    ? [...withoutConversation, ...(conversationRow ? [conversationRow] : [])]
    : items.filter((item) => item.kind === filter)
  const shownItems = filteredItems.slice(0, DETAIL_ROW_LIMIT)
  // 被折叠的 = 自己截掉的 + 宿主没随报告带过来的。只算自己那部分会把长会话报少一大截。
  const foldedInView = filter === 'all'
    ? CONTEXT_KIND_ORDER.filter((kind) => kind !== 'conversation').reduce((sum, kind) => sum + foldedOf(kind), 0)
    : foldedOf(filter)
  const restRows = filteredItems.length - shownItems.length + foldedInView
  const maxSize = shownItems.reduce((max, item) => Math.max(max, sizeOf(item)), 0) || 1
  const list = h('section', { className: 'dsh-mcp-ctx-section' },
    h('div', { className: 'dsh-mcp-ctx-section-head' },
      h('h4', { className: 'dsh-mcp-ctx-section-title' }, t('明细')),
      h('div', { className: 'dsh-mcp-ctx-filter', role: 'group', 'aria-label': t('按分类筛选') },
        ...CONTEXT_FILTERS.map((entry) => h('button', {
          key: 'filter:' + entry.id,
          type: 'button',
          'aria-pressed': filter === entry.id,
          className: filter === entry.id ? 'sel' : '',
          onClick: () => setFilter(entry.id),
        }, t(entry.label))),
      ),
    ),
    filteredItems.length === 0
      ? h('div', { className: 'dsh-mcp-ctx-empty' }, t('这一类还没有内容'))
      : h('div', { className: 'dsh-mcp-ctx-rows' },
        ...shownItems.map((item) => h('div', { className: 'dsh-mcp-ctx-row', key: 'row:' + item.id },
          h('span', { className: 'dsh-mcp-ctx-dot kind-' + item.kind }),
          // title 给系统提示词的首行之类放不进一行的内容；副标题是数量，不是句子。
          h('span', { className: 'dsh-mcp-ctx-row-label', title: contextItemSub(item) || '' }, contextItemLabel(item)),
          contextItemSub(item) ? h('span', { className: 'dsh-mcp-ctx-row-sub' }, contextItemSub(item)) : null,
          h('span', { className: 'dsh-mcp-ctx-row-bar' },
            h('span', { className: 'dsh-mcp-ctx-row-fill kind-' + item.kind, style: { width: Math.max(1, Math.round((sizeOf(item) / maxSize) * 100)) + '%' } })),
          h('span', { className: 'dsh-mcp-ctx-row-size', title: exactTitle(valueOf(item), unit) }, formatTokens(sizeOf(item))),
        )),
        restRows > 0 ? h('div', { className: 'dsh-mcp-ctx-more' }, t('其余 {count} 项', { count: restRows })) : null,
      ),
  )

  // ── 各轮规模 ─────────────────────────────────────────────────────────────
  const turns = Array.isArray(report.turns) ? report.turns : []
  const maxTurn = turns.reduce((max, turn) => Math.max(max, turn.prompt || 0), 0) || 1
  const turnsBlock = turns.length === 0 ? null : h('section', { className: 'dsh-mcp-ctx-section' },
    h('div', { className: 'dsh-mcp-ctx-section-head' },
      h('h4', { className: 'dsh-mcp-ctx-section-title' }, t('每轮用掉多少')),
    ),
    h('div', { className: 'dsh-mcp-ctx-turn-bars' },
      ...turns.slice(-60).map((turn) => h('span', {
        key: 'turn:' + turn.turn,
        className: 'dsh-mcp-ctx-turn-bar',
        title: t('第 {turn} 轮：{size} token（缓存命中 {cache}）', { turn: turn.turn, size: turn.prompt, cache: formatPercent(turn.prompt > 0 ? turn.cacheRead / turn.prompt : null) }),
      }, h('span', { className: 'dsh-mcp-ctx-turn-fill', style: { height: Math.max(4, Math.round((turn.prompt / maxTurn) * 100)) + '%' } }))),
    ),
  )

  // ── 最近的搜索（从工具页搬来：它本来就在讲"上下文里发生了什么"）────────────
  //
  // 一次都没搜过就**整块不画**：工具卡里"搜索次数 0"已经把这件事说完了，
  // 再留一个空区块加一句"这个会话还没搜过工具"只是往页面上贴废话。
  const recent = Array.isArray(search.recent) ? search.recent : []
  const searchBlock = recent.length === 0 ? null : h('section', { className: 'dsh-mcp-ctx-section' },
    h('div', { className: 'dsh-mcp-ctx-section-head' },
      h('h4', { className: 'dsh-mcp-ctx-section-title' }, t('最近的工具搜索')),
    ),
    h('div', { className: 'dsh-mcp-ctx-rows' },
      ...recent.slice().reverse().map((entry, index) => h('div', { className: 'dsh-mcp-ctx-row search', key: 'search:' + index },
        h('span', { className: 'dsh-mcp-ctx-chip' + (entry.exact ? ' exact' : '') }, entry.exact ? t('按名') : t('关键词')),
        h('span', { className: 'dsh-mcp-ctx-row-label', title: entry.query }, entry.query || t('（空）')),
        typeof entry.chars === 'number' ? h('span', { className: 'dsh-mcp-ctx-row-size' }, t('{chars} 字符', { chars: entry.chars })) : null,
      )),
    ),
  )

  // 数据是哪一刻的：面板读的是**最近一次请求**的快照，正在跑的这一轮还没进去。
  // 不标注的话，用户看到数字不变会以为面板坏了（参考产品也都在这里标一句）。
  const freshness = session.running
    ? t('这是上一轮的读数，本轮还在生成')
    : t('这是最近一轮的读数')
  // 脚注只说"这一份数字是什么"，不再重复顶部的会话名——同一个名字一行里出现两次，
  // 读者会以为下面那行是另一个东西。左边留给**模型**：上限是跟模型走的，换了模型就换了尺子。
  const footer = h('div', { className: 'dsh-mcp-ctx-foot' },
    route.model
      ? h('span', { className: 'dsh-mcp-ctx-foot-model', title: [route.provider, route.model].filter(Boolean).join(' · ') }, route.model)
      : null,
    h('span', { className: 'dsh-mcp-ctx-foot-meta' },
      // 轮询失败时这份数字是**旧的**，而这恰恰是最容易被当成"现在的"的时候：说一句，不做成弹窗。
      error ? h('span', { className: 'dsh-mcp-ctx-foot-err', role: 'status' }, t('读取失败，正在重试')) : null,
      error ? null : h('span', { className: 'dsh-mcp-ctx-foot-fresh' + (session.running ? ' busy' : '') }, freshness),
      t('{turns} 轮', { turns: Number.isFinite(report.turnTotal) ? report.turnTotal : turns.length }),
      loading && !error ? h('span', { className: 'dsh-mcp-ctx-foot-live' }, t('更新中')) : null,
    ),
  )

  // 详情页顶部：多会话时给一条"← 全部会话"的返回；单会话时只显示"你在看哪个"（不可点）。
  //
  // 早先是把会话画成一排芯片（点一下切换）。那是"列表 → 详情"的拙劣替代：芯片里只有名字，
  // 看不出谁快满了、谁在生成，而且会话一多就挤成两行。现在多会话先给总览列表（见上面），
  // 进来之后再从这里回去。
  //
  // 工作区名取宿主给的 `sessions[].workspace`，**不在这里切 cwd**：Windows 路径有 `\` 与 `/`
  // 两种分隔符，宿主切一次、这里再切一次就是两个真相源（同一个路径可能显示成两个名字）。
  // `active` 也是宿主算的（"这份报告讲的是哪个会话"）：客户端比 id 就是又算一遍。
  const currentEntry = sessions.find((entry) => entry.active === true) || null
  const workspace = currentEntry && typeof currentEntry.workspace === 'string' ? currentEntry.workspace : null
  const sessionChip = h('span', { className: 'dsh-mcp-ctx-session current' },
    workspace ? h('span', { className: 'dsh-mcp-ctx-session-ws', title: session.cwd || '' }, workspace) : null,
    h('span', { className: 'dsh-mcp-ctx-session-title' }, session.title || (session.id ? String(session.id).slice(0, 20) : t('未知会话'))),
  )
  const sessionBar = sessions.length > 1
    ? h('div', { className: 'dsh-mcp-ctx-sessions' }, back, sessionChip)
    : h('div', { className: 'dsh-mcp-ctx-sessions' },
      h('span', { className: 'dsh-mcp-ctx-sessions-label' }, t('会话')),
      sessionChip,
    )

  return h('div', { className: 'dsh-mcp-ctx' },
    sessionBar,
    overview,
    composition,
    toolsSection,
    list,
    turnsBlock,
    searchBlock,
    footer,
  )
}
