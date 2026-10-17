// 面板「外壳」（标题栏 / 第二行 / 通知条 / 详情操作栏 / 列表底栏）的不变量。
//
// 这一组的存在理由，全部来自**真机上看得见、而测试网里空着**的那几处：
//
//   1. MCP_CSS 是一个模板字符串。注释里出现一个反引号就会把它**提前截断**，
//      后面的 CSS 被当成 JS 解析；真机表现是「插件加载失败：mcp is not defined」
//      （`dsh-mcp-tabs` 被读成 `dsh` 减 `mcp` 减 `tabs`），而当时 480 个用例全绿——
//      因为所有 CSS 扫描器都是**文本**扫描，读到的仍然「是一段合法 CSS」。
//      这是本项目唯一一类「测试全绿、面板完全打不开」的缺陷，所以单独钉死。
//   2. 作用域条搬进第二行的 grid 之后，它从「撑满整行」变成「收缩到内容」，
//      里面的滚动条 clientWidth 只剩 47px，整条只剩一个「…8」按钮。
//      纯文本断言看不见宽度，只有真机 getComputedStyle/clientWidth 看得见，
//      所以这里钉住那条**给它剩余宽度**的规则本身。
//   3. 第二行（模式分段 + 作用域药丸 + 连接状态）只许有一个渲染者。曾经技能面自己
//      又画了一条 bar，于是标题栏上并排出现 MCP | 技能 | 管理 | 市场 四个标签。
//   4. 详情操作栏是**槽位**：[主行为] + [次要行为] + [⋯ 更多]。槽位数钉死，新增动作
//      才有唯一去处，头部才不会因为多一个按钮就换行。
//
// ⚠️ 假 React **不会展开子组件**：`h(Btn, …)` / `h(Notice, …)` / `h(actionBar 里的 ⋯)`
// 在树里只是 `{ type, props }`。所以凡是断言「某个组件画出来的东西」，要么读它的 props，
// 要么先确认它是不是普通元素——写错了会变成永远为真的空断言。
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const clientSource = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const exportMarker = 'exports.inject = inject;'
const instrumentedClient = clientSource.replace(
  exportMarker,
  `${exportMarker}
exports.__chrome = { McpTab, McpMarketView, SkillInstallModal, Btn, ServerList, ServerDetailPane, SkillsPanel, ServerDetail, SkillDetail, Notice, DropMenu, ICONS, mcpStatsText, skillStatsText, sortServers, sortSkills, skillScopeTabs, skillGroups, skillGroupKey, skillScopeOptions, skillTargetOptions, classifyHubError, catalogForScope, SORT_KEYS, deferAllState };`,
)
assert.notEqual(instrumentedClient, clientSource, 'client test export marker must stay current')

/** 两张样式表拼成的那一张（与 theme-contract 同一套提取口径）。 */
function extractPanelCss(source) {
  const pattern = /const ([A-Z][A-Z0-9_]*_CSS) = `([\s\S]*?)`;/g
  return [...source.matchAll(pattern)].map((match) => match[2]).join('\n')
}
const css = extractPanelCss(clientSource)

// ── 假 React（与 detail-panes / skills-client 同一手法）────────────────────
function loadClientInternals() {
  const stores = new Map()
  let current = null
  const react = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      const rest = props ?? {}
      const withChildren = children.length === 0
        ? rest
        : { ...rest, children: children.length === 1 ? children[0] : children }
      return { type, props: withChildren, children }
    },
    useCallback: (callback) => callback,
    useEffect(fn) { react.__effects.push(fn) },
    useMemo: (factory) => factory(),
    useRef: (value) => ({ current: value }),
    useState(initial) {
      const store = current
      const index = store.cursor
      store.cursor += 1
      if (index >= store.values.length) store.values[index] = typeof initial === 'function' ? initial() : initial
      const set = (next) => {
        const value = typeof next === 'function' ? next(store.values[index]) : next
        if (value !== store.values[index]) { store.values[index] = value; store.dirty = true }
      }
      return [store.values[index], set]
    },
    __effects: [],
    __render(Component, props) {
      let store = stores.get(Component)
      if (store === undefined) { store = { values: [], cursor: 0, dirty: false }; stores.set(Component, store) }
      let tree
      let guard = 0
      const previous = current
      current = store
      try {
        do {
          store.dirty = false
          store.cursor = 0
          tree = Component(props)
          guard += 1
        } while (store.dirty && guard < 50)
      } finally {
        current = previous
      }
      return tree
    },
  }
  let client
  vm.runInNewContext(instrumentedClient, {
    console,
    document: { querySelector: () => null, createElement: () => ({ dataset: {} }) },
    navigator: {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setInterval,
    setTimeout,
    clearInterval,
    clearTimeout,
    window: { __ModuleLoader__: { load(definition) { client = definition.factory(() => react) } } },
  })
  /** 跑掉挂起的首屏 useEffect，并让 async 的 setState 落地（否则断言在初始 state 上空转）。 */
  const settle = async () => {
    for (const effect of react.__effects.splice(0)) {
      await effect()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }
  // 面板里的定时器只用来做轮询与 toast 超时；测试里给一个不落地的替身就够了。
  const timer = { timeout: () => () => {}, interval: () => () => {}, dispose() {} }
  return { ...client.__chrome, __render: react.__render, __settle: settle, timer }
}

const collectAll = (tree, predicate, out = []) => {
  if (tree === null || tree === undefined || typeof tree !== 'object') return out
  if (Array.isArray(tree)) { for (const child of tree) collectAll(child, predicate, out); return out }
  if (predicate(tree)) out.push(tree)
  for (const child of tree.children ?? []) collectAll(child, predicate, out)
  return out
}
const classOf = (node) => String(node?.props?.className ?? '')
const hasClass = (node, cls) => classOf(node).split(/\s+/).includes(cls)
const byClass = (tree, cls) => collectAll(tree, (node) => hasClass(node, cls))
const ofType = (tree, Component) => collectAll(tree, (node) => node.type === Component)
const textOf = (node, out = []) => {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const child of node) textOf(child, out); return out }
  for (const child of node.children ?? []) textOf(child, out)
  return out
}

// ═══ ① 样式常量不得被提前截断 ═══════════════════════════════════════════════
test('样式常量的模板字符串不得被注释里的反引号提前截断', () => {
  // 事故现场：把 `.dsh-mcp-tabs` 这类类名**用反引号包起来**写进 CSS 注释之后，
  // MCP_CSS 在那一行就结束了，剩下的 CSS 变成 JS 表达式，
  // 真机 = 「dsh-toolbox-ui: import failed: mcp is not defined」，面板整个打不开。
  // 计数法最贴近真实解析：从一个常量的开引号到下一个常量的声明之间，
  // 只允许有**一个**反引号（它自己的收尾）。
  const segments = [
    ['MCP_CSS', 'const MCP_CSS = `', 'const SKILLS_CSS = '],
    ['SKILLS_CSS', 'const SKILLS_CSS = `', 'const h = React2.createElement;'],
  ]
  for (const [name, open, next] of segments) {
    const from = clientSource.indexOf(open)
    const to = clientSource.indexOf(next, from + open.length)
    assert.ok(from >= 0 && to > from, `找不到 ${name} 的正文范围`)
    const body = clientSource.slice(from + open.length, to)
    assert.equal((body.match(/`/g) ?? []).length, 1,
      `${name} 的正文里出现了反引号：模板字符串会提前结束，后面的 CSS 会被当成 JS 解析`
      + '（真机表现是插件加载失败，而不是某个样式没生效）')
  }
})

// ═══ ② 第二行只由外壳渲染 ═══════════════════════════════════════════════════
test('第二行（模式分段 / 作用域药丸 / 连接状态）只有一个渲染者', () => {
  assert.equal((clientSource.match(/className: 'dsh-mcp-sub'/g) ?? []).length, 1,
    '第二行的容器只能出现一次——两个渲染者就是「两套 UI」的来源')
  const skillsStart = clientSource.indexOf('const SkillsPanel = ')
  const skillsEnd = clientSource.indexOf('const McpOverlay = ')
  assert.ok(skillsStart > 0 && skillsEnd > skillsStart, '找不到 SkillsPanel 的范围')
  const skillsPanel = clientSource.slice(skillsStart, skillsEnd)
  // dsh-mcp-chips 不在名单里：技能面的**市场**也用这对药丸（分类），那是市场视图的一部分，
  // 与第二行的作用域药丸不是同一处。这里禁的是第二行本身。
  for (const cls of ['dsh-mcp-sub', 'dsh-mcp-sub-scope', 'dsh-mcp-seg', 'dsh-mcp-runtime']) {
    assert.equal(skillsPanel.includes(cls), false,
      `技能面不得再自己画 ${cls}（能力层与模式层都归外壳）`)
  }
  // 模式层只有一份定义，两个能力面读同一份、放在同一个位置。
  assert.equal((clientSource.match(/const SKILL_MODES = \[/g) ?? []).length, 1)
  assert.match(clientSource, /seg\(SKILL_MODES, mode, setMode, t\('模式'\)\)/)
})

test('作用域条在第二行里必须吃掉中间那一列的剩余宽度', () => {
  // 事故现场：.dsh-mcp-tabs-wrap 自己是 flex:none（它原本是**列**容器的直接子元素，靠
  // stretch 撑满），搬进第二行的 grid 之后收缩到内容宽度，里面的滚动条 clientWidth
  // 只剩 47px——真机上整条只剩一个「…8」按钮，作用域一个都点不到。
  assert.match(css, /\.dsh-mcp-sub-scope \.dsh-mcp-tabs-wrap\{flex:1 1 auto;min-width:0\}/,
    '作用域条必须显式撑满第二行的中间列，否则会塌成一个省略号按钮')
})

// ═══ ③ 详情操作栏是槽位 ═════════════════════════════════════════════════════
test('MCP 详情操作栏是 [主行为]+[次要行为]+[⋯ 更多] 三个槽位', () => {
  const internals = loadClientInternals()
  const server = { serverName: 'everything', managed: true, enabled: true, status: 'connected', transport: 'stdio', scope: 'global', toolCount: 3, env: {}, headers: {} }
  const tree = internals.ServerDetail({
    server, tools: [], onToggle() {}, onReconnect() {}, onEdit() {}, onRemove() {},
    busy: false, onReveal() {}, revealed: {}, onCopy() {},
  })
  const actions = byClass(tree, 'dsh-mcp-d-actions')
  assert.equal(actions.length, 1, '详情头部要有唯一的操作栏')
  const slots = actions[0].children.filter(Boolean)
  assert.equal(slots.length, 3, `操作栏必须是三个槽位（主 / 次 / ⋯），实际 ${slots.length}`)
  assert.match(String(slots[0].props.cls ?? ''), /primary/, '第一个槽位是主行为（填实按钮）')
  assert.equal(slots[2].type, internals.DropMenu, '最后一个槽位是 ⋯ 菜单——新增动作的唯一去处')
  assert.equal(slots[2].props.icon, 'more')
  // 启停从「滑块」改成主行为按钮：详情头里同时出现滑块与按钮就是同一动作两个控件。
  assert.equal(collectAll(actions[0], (node) => String(node.type?.name ?? '') === 'Toggle').length, 0,
    '详情操作栏里不该再有启停滑块（列表行保留滑块）')
})

test('技能详情操作栏同样走槽位，且只读时主行为禁用', () => {
  const internals = loadClientInternals()
  const row = { name: 'zhanggui', root: '/home/u/.agents/skills/zhanggui', source: 'user-agents', scope: 'global', enabled: true, writable: false, modelInvocable: true, userInvocable: true, description: 'd' }
  const tree = internals.SkillDetail({ row, shadowedBy: null, body: { status: 'ok', text: 'x' }, busy: false, onRetry() {}, onToggle() {}, onRemove() {} })
  const slots = byClass(tree, 'dsh-mcp-d-actions')[0].children.filter(Boolean)
  assert.equal(slots.length, 2, '技能面是 [主行为] + [⋯]（次要槽位按契约空着）')
  assert.match(String(slots[0].props.cls ?? ''), /primary/)
  assert.equal(slots[0].props.disabled, true, '内置只读：主行为必须禁用')
  assert.equal(slots[1].type, internals.DropMenu)
})

// ═══ ④ 通知条统一 + 技能服务降级 ════════════════════════════════════════════
const renderMcpTab = async (internals, callSkills) => {
  const callMcp = async () => ({ ok: true, servers: [], revealRevision: '' })
  const props = { call: callMcp, callSkills, timer: internals.timer, pluginManager: null, floating: true, onClose() {} }
  internals.__render(internals.McpTab, props)
  await internals.__settle()
  return { tree: internals.__render(internals.McpTab, props), props }
}

test('技能服务不可用时给出降级通知，且 MCP 面照常渲染', async () => {
  const internals = loadClientInternals()
  const { tree } = await renderMcpTab(internals, async () => ({ ok: false, error: '技能服务未连接（需要宿主挂载 dsh-skill）' }))

  const notices = ofType(tree, internals.Notice)
  const degraded = notices.filter((node) => String(node.props.title ?? '').includes('skills 服务未就绪'))
  assert.equal(degraded.length, 1, 'callSkills 返回 {ok:false} 时必须有一条降级通知')
  assert.equal(degraded[0].props.tone, 'err', '降级是三色通知卡里的 err 档')
  assert.match(String(degraded[0].props.children), /技能服务未连接/, '原因要就地写出来，不能只说「不可用」')
  // SPEC 约束 16：技能面只是不可用，**不能连累 MCP 面**。
  assert.equal(byClass(tree, 'dsh-mcp-body').length, 1, 'MCP 面的主体必须照常渲染')
  assert.equal(ofType(tree, internals.ServerList).length, 1, 'MCP 面的列表要挂上')
  assert.equal(ofType(tree, internals.ServerDetailPane).length, 1, 'MCP 面的详情要挂上')
})

// 与 client-behavior 那条同名用例的分工：那条钉 `firstFailureReason` 这个纯函数本身，这条钉**接线**
// ——横幅真的把原因画出来（假 React 不展开子组件，所以只能读 Notice 的 props）。少了这一条，
// 「改了 helper 却忘了接到两处横幅上」会一路全绿。
const renderWorkspaceTab = async (internals, view, wsPath = '/tmp/ws-a') => {
  const callMcp = async (method) => {
    if (method === 'getWorkspaceView') return { ok: true, servers: [], global: [], exclude: [], revision: 'r1', ...view }
    if (method === 'listWorkspaces') return { ok: true, workspaces: [{ path: wsPath, name: 'ws-a', serverCount: 0 }] }
    return { ok: true, servers: [], revealRevision: '' }
  }
  const props = { call: callMcp, callSkills: async () => ({ ok: true, skills: [] }), timer: internals.timer, pluginManager: null, floating: true, onClose() {} }
  internals.__render(internals.McpTab, props)
  await internals.__settle()
  // 两条横幅都只在**项目**作用域渲染，而作用域是面板内部状态：像用户那样点一下作用域药丸，
  // 否则断言会在全局作用域上静默空过（找不到横幅这件事必须先被排除）。
  const tree = internals.__render(internals.McpTab, props)
  const tabs = collectAll(tree, (node) => Array.isArray(node?.props?.tabs) && node.props.tabs.some((tab) => tab.key === wsPath))[0]
  assert.ok(tabs, '找不到作用域药丸，无法切到项目作用域')
  tabs.props.onSelect(wsPath)
  internals.__render(internals.McpTab, props)
  await internals.__settle()
  return internals.__render(internals.McpTab, props)
}

test('失败横幅把首条原因画出来（挂载失败与工具无法隔离共用同一句话）', async () => {
  const internals = loadClientInternals()
  // 原因来自 Host：官方 fiber 拒绝的原文（同名占用时还带「和谁同名」与根因）。面板只负责把它摆到
  // 横幅上——只列 serverName 等于把真因留给用户自己逐条点开。
  const official = 'mcp-client: serverName "exa" is already in use by another mcp-client instance'
  const tree = await renderWorkspaceTab(internals, {
    liveAgents: 2,
    mountErrors: [
      { serverName: 'exa', error: official },
      { serverName: 'db', error: '配置里的 ${VAR} 求值为空' },
    ],
    scopeErrors: [{ serverName: 'solo', error: '这批工具对所有项目的会话都可见（echo）：安装里 @deepseek-ai/dsh-scope 有多份模块实例' }],
  })
  const noticeOf = (key) => ofType(tree, internals.Notice).find((node) => node.props.key === key)

  const mount = noticeOf('mount-failed')
  assert.ok(mount, '挂载失败必须有横幅')
  assert.match(String(mount.props.title), /2 个项目 MCP 未能挂载到会话/)
  assert.match(String(mount.props.children), /^exa、db。首个原因：/,
    `横幅正文必须以「名字 + 首个原因」开头，实际 ${JSON.stringify(mount.props.children)}`)
  assert.match(String(mount.props.children), /is already in use/, '首条原因的原文要摆出来')
  assert.equal(String(mount.props.children).includes('${VAR}'), false, '其余各条的原因在详情里给全文')
  assert.match(String(mount.props.children), /2 个会话在运行/, '并发会话数仍作为上下文带出')

  const scope = noticeOf('scope-failed')
  assert.ok(scope, '工具无法隔离必须有横幅')
  // 说清**后果**：这批工具在所有项目的会话里可见——否则用户会去查这一个 server 的 MCP 配置。
  assert.match(String(scope.props.title), /无法隔离（会出现在所有项目的会话里）/)
  assert.match(String(scope.props.children), /^solo。首个原因：/)
  assert.match(String(scope.props.children), /@deepseek-ai\/dsh-scope 有多份模块实例/)

  // 宿主确实没给出原因时，横幅也必须说清这一点，而不是画成一句空话。
  // （用新的面板实例：每个实例的组件身份不同，跨实例找节点会找到空集。）
  const bare = loadClientInternals()
  const emptyTree = await renderWorkspaceTab(bare, {
    mountErrors: [{ serverName: 'exa', error: '   ' }],
  })
  const empty = ofType(emptyTree, bare.Notice).find((node) => node.props.key === 'mount-failed')
  assert.ok(empty, '挂载失败必须有横幅')
  assert.match(String(empty.props.children), /首个原因：（宿主没有给出原因）/)
})

test('能力层计数：技能数由面板回传（skills + disabled 之和），MCP 面不显示数字', async () => {
  const internals = loadClientInternals()
  // 宿主只回**一个**数组：停用不再是「在另一个数组里」，而是行上的派生态（enabled）。
  const callSkills = async (method) => (method === 'market'
    ? { ok: true, skills: [], categoryOrder: [], categoryLabels: {} }
    : { ok: true, skills: [{ name: 'a' }, { name: 'b' }, { name: 'c', enabled: false }] })
  const first = await renderMcpTab(internals, callSkills)
  assert.deepEqual(
    ofType(first.tree, internals.Notice).filter((node) => String(node.props.title ?? '').includes('skills 服务未就绪')),
    [],
    '服务正常时不该摆一条降级通知',
  )
  // MCP 面**不显示数字**：跨作用域总数外壳拿不到，编一个比不显示更糟。
  const abilitySeg = byClass(first.tree, 'dsh-mcp-seg')[0]
  const items = abilitySeg.children.filter(Boolean)
  assert.equal(byClass(items[0], 'dsh-mcp-seg-count').length, 0, 'MCP 面不显示数字')
  assert.equal(byClass(items[1], 'dsh-mcp-seg-count').length, 0, '技能数还没拿到时不显示数字')

  // 面板先把计数算出来并回传（这一步单独验，因为假 React 不展开子组件，
  // 面板内部的 useEffect 不会在外壳那棵树里被跑到）。
  const summaries = []
  internals.__render(internals.SkillsPanel, { call: callSkills, workspaces: [], onSummary: (info) => summaries.push(info) })
  await internals.__settle()
  assert.equal(summaries.length > 0, true, 'SkillsPanel 必须把结果回传给外壳')
  const last = summaries[summaries.length - 1]
  assert.equal(last.state, 'ready')
  assert.equal(last.count, 3, '计数就是行数（已停用的技能也是技能：面板里看得见、也点得动）')
  assert.equal(last.scopeTabs[0].count, 3, '作用域药丸「全部」的数字来自同一批行')

  // 回传之后外壳要把它显示出来（这一步验的是接线：onSummary → 能力层计数）。
  // 先切到技能面，外壳树里才会挂上 SkillsPanel。
  items[1].props.onClick()
  const skillTree = internals.__render(internals.McpTab, first.props)
  const panelEl = ofType(skillTree, internals.SkillsPanel)[0]
  assert.ok(panelEl, '切到技能面之后外壳必须挂上 SkillsPanel')
  panelEl.props.onSummary(last)
  const after = byClass(internals.__render(internals.McpTab, first.props), 'dsh-mcp-seg')[0].children.filter(Boolean)
  const count = byClass(after[1], 'dsh-mcp-seg-count')
  assert.equal(count.length, 1, '技能数拿到之后要显示出来')
  assert.equal(String(count[0].props.children), '3')
  assert.equal(byClass(after[0], 'dsh-mcp-seg-count').length, 0, 'MCP 面永远不显示数字')
})

test('技能服务不可用时面板回传「降级 + 无计数」', async () => {
  const internals = loadClientInternals()
  const summaries = []
  internals.__render(internals.SkillsPanel, {
    call: async () => ({ ok: false, error: '技能服务未连接（需要宿主挂载 dsh-skill）' }),
    workspaces: [],
    onSummary: (info) => summaries.push(info),
  })
  await internals.__settle()
  const last = summaries[summaries.length - 1]
  assert.equal(last.state, 'down')
  assert.equal(last.count, null, '取不到就不给数字（宁可不显示）')
  assert.match(last.error, /技能服务未连接/)
  assert.deepEqual([...last.scopeTabs], [], '服务不可用时不该凭空造作用域药丸')
})

// ═══ ⑤ 列表底栏：统计与排序是纯函数 ═════════════════════════════════════════
test('底栏统计文本只数真实行，且区分启用与失败', () => {
  const internals = loadClientInternals()
  const { mcpStatsText, skillStatsText } = internals
  assert.equal(mcpStatsText([]), '0 个服务 · 0 启用')
  assert.equal(skillStatsText([]), '0 个技能 · 0 已启用')
  assert.equal(
    mcpStatsText([
      { enabled: true, status: 'connected' },
      { enabled: true, status: 'failed' },
      { enabled: false, status: 'stopped' },
    ]),
    '3 个服务 · 2 启用 · 1 失败',
  )
  // 挂载失败与作用域故障都算「失败」，即使 status 还是 connected——
  // 那一行的工具根本没注册上，按 connected 数会把问题藏起来。
  assert.match(mcpStatsText([{ enabled: true, status: 'connected', mountFailed: true }]), /1 失败/)
  assert.match(mcpStatsText([{ enabled: true, status: 'connected', scopeFailed: true }]), /1 失败/)
  assert.equal(
    skillStatsText([{ enabled: true }, { enabled: false }, { enabled: false }]),
    '3 个技能 · 1 已启用 · 2 已停用',
  )
  // 没有失败项时不写「· 0 失败」：多余的字会把底栏挤窄（侧栏只有 288px）。
  assert.equal(mcpStatsText([{ enabled: true, status: 'connected' }]), '1 个服务 · 1 启用')
})

// ═══ ⑤b 一键「全部延迟」的状态判定是纯函数 ═════════════════════════════════════
// ⚠️ 逐字段断言而不用 deepEqual：client 跑在 vm realm 里，它造出的对象字面量的
// Object.prototype 与测试主 realm 的不是同一个，deepStrictEqual 会以
// "same structure but are not reference-equal" 失败（返回字符串的纯函数没这个问题）。
test('deferAllState 只数当前 profile 可改的全局服务器', () => {
  const { deferAllState } = loadClientInternals()
  const fields = (value) => [value.total, value.deferred, value.all]

  // 空列表：没有可改对象，all=false 让按钮禁用，而不是显示成一个可点的「全部开启」。
  assert.deepEqual(fields(deferAllState([])), [0, 0, false])

  // 只数 managed 的全局行。项目行（scope==='workspace'）与只读行（其他 bundle/agent）
  // 都不该被一键扫到——它们不写在当前 profile 的 patch 里，改了会静默失败。
  assert.deepEqual(
    fields(deferAllState([
      { serverName: 'a', managed: true, defer: true },
      { serverName: 'b', managed: true, defer: false },
      { serverName: 'ws', managed: true, scope: 'workspace', defer: false },
      { serverName: 'ro', managed: false, defer: false },
    ])),
    [2, 1, false],
  )

  // 全部已开 → all=true，按钮转成「全部关闭」。
  assert.deepEqual(
    fields(deferAllState([
      { serverName: 'a', managed: true, defer: true },
      { serverName: 'b', managed: true, defer: true },
    ])),
    [2, 2, true],
  )

  // 一个都没开 → all=false，按钮是「全部开启」。
  assert.equal(deferAllState([{ serverName: 'a', managed: true }]).all, false)
  // 非数组不炸（rows 可能来自还没加载完的响应）。
  assert.deepEqual(fields(deferAllState(undefined)), [0, 0, false])

  // 项目作用域：includeWorkspace 打开后，项目行进入统计——否则按钮永远禁用，
  // 项目级一键延迟就成了死按钮。
  assert.deepEqual(
    fields(deferAllState([
      { serverName: 'ws1', managed: true, scope: 'workspace', defer: false },
      { serverName: 'ws2', managed: true, scope: 'workspace', defer: true },
    ], { includeWorkspace: true })),
    [2, 1, false],
  )
  // 默认（全局作用域）仍然不数项目行。
  assert.deepEqual(
    fields(deferAllState([{ serverName: 'ws1', managed: true, scope: 'workspace', defer: false }])),
    [0, 0, false],
  )
})

test('分类药丸行必须换行，不得把溢出藏起来', () => {
  // 真机实测：分类多到十个时，横滚 + `scrollbar-width:none` 让最后一个药丸被切在
  // 右边缘（「文件与…」），而滚动条是隐藏的——用户没有任何线索知道那一行还能滚，
  // 只看到「没处理好」。条目数固定且有限，换行是唯一不需要交互的出口。
  const rule = /\.dsh-mcp-chips\{([^}]*)\}/.exec(css)
  assert.ok(rule, '找不到 .dsh-mcp-chips 规则')
  assert.match(rule[1], /flex-wrap:wrap/, '药丸行必须换行')
  assert.doesNotMatch(rule[1], /overflow-x:auto/, '药丸行不得横滚（隐藏滚动条 = 溢出错觉）')
  assert.doesNotMatch(rule[1], /scrollbar-width:none/, '不得再藏滚动条')
  assert.equal(clientSource.includes('.dsh-mcp-chips::-webkit-scrollbar'), false,
    '横滚条样式应已删除')
})

test('市场给出明确的安装位置选择，候选来自实际工作区', () => {
  // 用户的原话：「安装的时候安装位置…你也应该给用户一点选择吧？感觉差点细节」。
  // 第一版把「装到哪」只写进脚注的一行小字（装入全局配置），而按「安装」之前根本改不了它。
  const internals = loadClientInternals()
  const picked = []
  const options = [
    { key: 'global', label: '全局（当前 profile）', title: '所有项目共享' },
    { key: 'D:\\w\\one', label: '项目 one' },
    { key: 'D:\\w\\two', label: '项目 two' },
  ]
  const tree = internals.__render(internals.McpMarketView, {
    call: async () => ({ ok: true, builtins: [] }),
    busy: false,
    setBusy() {},
    onInstalled() {},
    scope: 'global',
    scopeName: '全局',
    scopeOptions: options,
    onScope: (value) => picked.push(value),
    knownNames: [],
  })
  const select = collectAll(tree, (node) => node.type === 'select' && node.props['aria-label'] === '安装到哪个作用域')[0]
  assert.ok(select, '市场里必须有「安装到」下拉（安装前就能改落盘位置）')
  assert.equal(select.props.value, 'global', '选中值就是当前作用域')
  assert.deepEqual(
    collectAll(select, (node) => node.type === 'option').map((node) => node.props.children),
    ['全局（当前 profile）', '项目 one', '项目 two'],
    '候选必须逐个列出（含每个工作区），不写死',
  )
  select.props.onChange({ target: { value: 'D:\\w\\one' } })
  assert.deepEqual(picked, ['D:\\w\\one'], '改选要真的写回作用域')
  // 接线：它必须写回**药丸那一份** state，否则市场改了、已安装模式还是旧值（两个真值）。
  assert.match(clientSource, /onScope: switchScope/, '「安装到」必须与作用域药丸共用 switchScope')
  assert.match(clientSource, /const scopeChoices = useMemo/, '候选由工作区列表派生')
})

test('项目作用域下的「已配置」只看这个项目自己，不沿用全局标记', () => {
  // 真机实测出来的：切到项目作用域后，全局装过的 Exa/Firecrawl 显示成
  // 「已写入本项目配置」+「移除」，而那个项目一条配置都没有（药丸写着 0 个 MCP）。
  // 根因是这里原来只**补** true、从不改成 false——Host 的目录是按全局 effective 标的。
  const internals = loadClientInternals()
  const { catalogForScope } = internals
  const catalog = [
    { id: 'exa', name: 'exa', installed: true },        // 全局装过
    { id: 'fetch', name: 'fetch', installed: false },   // 谁都没装
  ]

  const globalView = catalogForScope(catalog, { isWorkspace: false, knownNames: [] })
  assert.equal(globalView[0].installed, true, '全局作用域：Host 报什么就是什么')

  const projectView = catalogForScope(catalog, { isWorkspace: true, knownNames: [] })
  assert.equal(projectView[0].installed, false, '本项目没装 → 不能说「已配置」')
  assert.equal(projectView[0].globallyInstalled, true, '但要如实标出「全局已装」')
  assert.equal(projectView[1].installed, false)
  assert.equal(projectView[1].globallyInstalled, false)

  const projectInstalled = catalogForScope(catalog, { isWorkspace: true, knownNames: [{ serverName: 'exa' }] })
  assert.equal(projectInstalled[0].installed, true, '本项目装了就是装了')
  assert.deepEqual([...projectInstalled[0].installedAs], ['exa'], '移除要按本项目的名字定位')
  // 输入不能被改写（面板里同一份目录会被两种作用域各用一次）。
  assert.equal(catalog[0].installed, true, 'catalogForScope 不得原地改输入')
})

test('市场目录的重载键必须包含作用域与当前的 serverName 集合', () => {
  // 真机实测的两条同源缺陷：只看「是不是项目」的话
  //   · 全局 ↔ 项目：切过去那一帧 `servers` 还是上一作用域的 → 全局装过的算成本项目已配置；
  //   · 项目 ↔ 项目：isWorkspace 不变 → 目录根本不重载。
  assert.match(clientSource, /const knownNamesKey = \(Array\.isArray\(knownNames\)/,
    '必须把名字集合压成稳定键')
  assert.match(clientSource, /\}, \[call, isWorkspace, knownNames, knownNamesKey\]\)/,
    'loadCatalog 的依赖要含作用域与名字集合')
  assert.doesNotMatch(clientSource, /knownNamesRef/, '旧的 ref 写法会读到上一个作用域的名字')
})

test('安装目标只列可写位置，且默认不是只读的内置目录', () => {
  // 真机实测出来的：安装弹窗的候选是「内置（只读）／全局 · .agents/skills／项目 X · .agents/skills」，
  // 而**只读的内置目录排在第一个、并且是默认选中**——importSkill 不传 writable 时宿主按可写处理，
  // 于是「安装」会直接往内置目录里写。根因：宿主在每一行上标了 writable，客户端把它丢了。
  const internals = loadClientInternals()
  const rows = [
    { name: 'a', source: 'bundled', scope: 'global', root: 'C:/app/skills', writable: false },
    { name: 'b', source: 'user-agents', scope: 'global', root: 'C:/u/.agents/skills', writable: true },
    { name: 'c', source: 'user-dsh', scope: 'global', root: 'C:/u/.dsh/skills', writable: true },
    { name: 'd', source: 'project-agents', scope: 'project', cwd: 'D:/w/one', root: 'D:/w/one/.agents/skills', writable: true },
  ]
  const options = internals.skillScopeOptions(rows)
  const bySource = Object.fromEntries([...options].map((o) => [o.source, o]))
  assert.equal(bySource.bundled.writable, false, 'writable 必须一路带到候选上')
  assert.equal(bySource['user-agents'].writable, true)

  // 排序：先按「全局 / 项目」分组（用户级是默认视角），组内按宿主 rank。
  // 按字母序会得到 bundled 排第一（'b' < 'u'）——那正是默认目标变成只读目录的原因。
  assert.deepEqual([...options].map((o) => o.source),
    ['user-dsh', 'user-agents', 'bundled', 'project-agents'],
    '全局组在前、组内按 rank；bundled 属 global 档所以留在全局组里')
  // 只读的内置在全局组里排最后本来就不该被选中，而它更不该出现在安装目标里——
  // 下面这条才是真正决定用户看到什么的那一步。
  const targets = [...options].filter((o) => o.writable !== false)
  assert.deepEqual(targets.map((o) => o.source), ['user-dsh', 'user-agents', 'project-agents'])
  assert.equal(targets[0].source, 'user-dsh', '默认目标是 DSH 原生的用户级目录（rank 最小）')
  // 接线：弹窗与确认安装都只吃这份可写清单。
  assert.match(clientSource, /const installTargets = scopeOptions\.filter\(\(option\) => option\.writable !== false\)/)
  assert.match(clientSource, /scopeOptions: installTargets/)
  assert.match(clientSource, /setScope\(installTargets\[0\]\?\.id \|\| ''\)/)
})

test('安装目标优先用宿主报的全部位置，老宿主退回发现集', () => {
  // skillTargets 是新方法：它列的才是「可以装到哪里」（含还没建的）；拿不到时
  // 必须退回原来的发现集，而不是把「安装到」变成空的。
  const internals = loadClientInternals()
  const discovered = [{ source: 'user-agents', label: '全局 · .agents/skills', scope: 'global', root: 'C:/u/.agents/skills', writable: true }]

  // ① 宿主给了全部位置：用它的（含 exists:false 的，并标 pending）
  const hostTargets = [
    { source: 'bundled', root: 'C:/app/skills', scope: 'global', writable: false, exists: true },
    { source: 'user-agents', root: 'C:/u/.agents/skills', scope: 'global', writable: true, exists: true },
    { source: 'user-dsh', root: 'C:/u/.dsh/skills', scope: 'global', writable: true, exists: false },
    { source: 'project-agents', root: 'D:/w/one/.agents/skills', scope: 'project', writable: true, exists: false, projectPath: 'D:/w/one' },
  ]
  const options = internals.skillTargetOptions(hostTargets, discovered)
  // 全局组在前（组内按 rank），项目组在后。bundled 属 global 档所以留在全局组里，
  // 但它只读、会被 installTargets 过滤掉，所以不影响弹窗里看到的顺序与默认项。
  assert.deepEqual([...options].map((o) => o.source), ['user-dsh', 'user-agents', 'bundled', 'project-agents'],
    '全局在前、项目在后；还没建的位置照样在里面')
  const bySource = Object.fromEntries([...options].map((o) => [o.source, o]))
  assert.equal(bySource['user-dsh'].pending, true, '还没建的要标出来（安装时创建）')
  assert.equal(bySource['user-dsh'].exists, false)
  assert.equal(bySource['user-agents'].pending, false)
  assert.equal(bySource['user-dsh'].label, '全局 · .dsh/skills', '标签复用 SCOPE_LABELS，不另起一份文案')
  assert.equal(bySource['project-agents'].label, '项目 one · .agents/skills', '项目位置要带项目名')
  assert.equal(bySource.bundled.writable, false)

  // ② 老宿主（方法不存在 → 空数组）：退回发现集，界面不会空
  assert.deepEqual([...internals.skillTargetOptions([], discovered)].map((o) => o.source), ['user-agents'])
  assert.deepEqual([...internals.skillTargetOptions(undefined, discovered)].map((o) => o.source), ['user-agents'])
  // ③ 两边都没有：空数组（弹窗会显示「没有可写入的技能目录」而不是假选项）
  assert.deepEqual([...internals.skillTargetOptions([], [])], [])
})

test('外部源（skillhub.cn）：安装走同一套落点，但闸门换成披露 + 显式确认', () => {
  // 上游没有 license 字段 —— 所以外部源**不能**走许可判定（假装能判就是编），
  // 改成：把上游真有的东西（发布方认证、安全扫描结论、要不要 key）摆出来，
  // 并要求一次显式确认。落点仍然是同一套「安装到」（这是直连上游的意义所在）。
  const internals = loadClientInternals()
  const entry = { source: 'skillhub', slug: 'tencent-docs', name: '腾讯文档 TENCENT DOCS', requiresApiKey: true, pageUrl: 'https://skillhub.cn/skills/tencent-docs' }
  const scopeOptions = [{ source: 'user-dsh', label: '全局 · .dsh/skills', scope: 'global', root: 'C:/u/.dsh/skills', writable: true, exists: false, pending: true }]

  // ① 披露信息还没到位：也要能开，并如实说「未提供」，不能崩
  const bare = internals.__render(internals.SkillInstallModal, { entry, scopeOptions, scope: 'user-dsh', onScope() {}, onClose() {}, onConfirm() {}, busy: false, external: { pageUrl: entry.pageUrl, publisher: null, security: null, requiresApiKey: true } })
  const bareText = textOf(bare).join(' | ')
  assert.match(bareText, /外部源/, '外部源要有专门的披露块')
  assert.match(bareText, /本插件未核验/, '要说清本插件**没做什么**')
  assert.match(bareText, /上游未提供/, '缺信息时如实说未提供，不编')
  assert.match(bareText, /不需要?要 API Key|需要 API Key/, '要不要 key 是上游给的事实，要显示')
  // 外部源没有许可 → 不该出现许可闸门那套文案
  assert.doesNotMatch(bareText, /许可受限/)
  assert.doesNotMatch(bareText, /我已阅读该许可/)

  // ② 详情到位：认证主体与安全扫描结论都要摆出来
  const full = internals.__render(internals.SkillInstallModal, {
    entry, scopeOptions, scope: 'user-dsh', onScope() {}, onClose() {}, onConfirm() {}, busy: false,
    external: {
      pageUrl: entry.pageUrl,
      publisher: { name: '腾讯文档团队', verified: true, certifiedName: '腾讯科技（深圳）有限公司' },
      security: { keen: { status: 'benign', statusText: '安全，无风险' }, sanbu: { status: 'benign', statusText: '安全，无风险' } },
      requiresApiKey: true,
    },
  })
  const fullText = textOf(full).join(' | ')
  assert.match(fullText, /腾讯科技（深圳）有限公司/, '认证主体才是「谁背的书」')
  assert.match(fullText, /安全，无风险/)
  assert.match(fullText, /外部来源/, '确认句要说清是外部来源')

  // ③ 确认前不给装；勾上才给装（复用内置目录那套 ack 机制，只是句子不同）
  const confirmBtn = () => {
    const modal = collectAll(full, (node) => node.type === internals.Btn || node.type === 'button').at(-1)
    return modal
  }
  assert.equal(confirmBtn().props.disabled, true, '未勾选确认时安装不可点')

  // ④ 接线：外部源调 skillHubInstall；落点只送**引用**（source + root + projectPath），
  // 确认（acknowledged）也必须在 wire 上——UI 的勾选框只是它的界面。
  // 调用助手名不钉（技能面的写动作统一走 act，见 lib/client.js 里 act 的说明）：这里钉的是
  // 「入口只有一个」+ wire 上的字段，与助手叫什么无关。
  assert.match(clientSource, /await (?:call|act)\('skillHubInstall', \{/)
  assert.match(clientSource, /source: option\.source,/)
  assert.match(clientSource, /projectPath: option\.projectPath,/)
  assert.match(clientSource, /acknowledged: true,/, '确认必须上 wire，不能只留在客户端')
  assert.match(clientSource, /installTargets\.find\(\(item\) => item\.id === scope\)/,
    '落点必须按安装目标身份解析，不能按 source 取首个')
  // 市场只剩 skillhub.cn 一条来源，所以安装只走 skillHubInstall，不存在第二条「假装能装」的路。
  // 原来这里钉的是「内置精选不得出现 type:'market'」——那条路已经整条删掉了（没有可固定的
  // commit，抓默认分支不可复现），现在钉的是**不再有任何别的安装入口**。
  assert.equal((clientSource.match(/await (?:call|act)\('skillHubInstall'/g) ?? []).length, 1,
    '安装只能有一个入口：skillHubInstall')
  // 落点是**同一份** installTargets，两个能力面不各建一套
  assert.equal((clientSource.match(/scopeOptions: installTargets/g) ?? []).length, 1)
})

test('外部源的两类失败必须分开说：宿主没这接口 ≠ 上游挂了', () => {
  // 真机事故：新版面板跑在**更新前启动的宿主进程**上，skillHubSearch 这个 endpoint
  // 根本不存在，wire 直接 404。第一版把它显示成「skillhub.cn 不可用」——
  // 上游一次都没被访问过，用户会去查网络，而真正要做的是重启宿主。
  const internals = loadClientInternals()
  const { classifyHubError } = internals
  // 判据取自真机抓到的 wire 原文（两条标记都是网关用词）
  const observed = 'client api: skillsManager/skillHubSearch failed: transport failure for /api/skillsManager/skillHubSearch: HTTP 404'
  assert.equal(classifyHubError(observed), 'missing')
  assert.equal(classifyHubError('连接 skillhub.cn 失败：请求超时'), 'upstream')
  assert.equal(classifyHubError('skillhub.cn 返回 HTTP 500'), 'upstream', '上游自己 500 是上游的问题')
  assert.equal(classifyHubError(''), 'upstream', '拿不准时按上游处理（不假装是宿主没装）')

  // 接线：分类结果决定文案与处置。市场只剩 skillhub 一条来源之后，「宿主没这个接口」不再
  // 有「返回内置精选」这条退路——那反而更要说清楚该怎么办（重启宿主），否则用户面对的是
  // 一个没有任何可用来源的空市场。
  assert.match(clientSource, /hub\.kind === 'missing'/)
  assert.match(clientSource, /当前宿主进程还没有外部源接口/)
  assert.match(clientSource, /重启宿主（dsh 进程）后即可使用/)
  assert.match(clientSource, /连接 skillhub\.cn 失败/)
})

test('底栏统计必须跟着看得见的那一批行走', () => {
  // 真机实测出来的：作用域药丸筛出 12 行，底栏却还写着全量的「25 个技能 · 25 已启用」。
  // 底栏就贴在列表下面，两个数字对不上读起来像 bug；作用域的总量由药丸自己带着。
  // 这里钉的是**接线**（统计的输入是 filtered / visibleRows，不是 servers / rows），
  // 纯函数本身由上一条用例覆盖。
  assert.match(clientSource, /const mcpListFooter = h\(ListFooter, \{\n\s*text: mcpStatsText\(filtered\)/)
  assert.match(clientSource, /h\(ListFooter, \{\n\s*text: skillStatsText\(visibleRows\)/)
  assert.doesNotMatch(clientSource, /mcpStatsText\(servers\)/, '底栏不得统计全量 MCP')
  assert.doesNotMatch(clientSource, /skillStatsText\(rows\)/, '底栏不得统计全量技能')
})

test('一键「全部延迟」两个作用域都能用，且各写各的文件', () => {
  // 曾经「批量」因为缺 RPC 被明确否决（ListFooter 的注释记着）。一键全部不是多选：
  // 它是单一语义 + 服务端一次改写，所以现在做。多选**仍然没做**。
  assert.match(clientSource, /setDeferAll\(/)
  // 计数取当前作用域的**全量**行：Host 的 setDeferAll 改的就是 patch/项目配置里的全部
  // managed 条目。按 filtered 算的话，一有筛选，title 写「所有 MCP（N 个）」而完成后
  // toast 写「已把 M 个服务器…」——同一次交互两个数，用户不知道该信哪个。
  // （底栏统计仍然跟 filtered 走，那是另一件事：它描述的是屏幕上看得见的那批行。）
  assert.match(clientSource, /deferAllState\(servers, scope === 'global' \? \{\} : \{ includeWorkspace: true \}\)/)
  assert.doesNotMatch(clientSource, /deferAllState\(filtered/, '一键延迟的计数不得跟筛选后的行走')
  // 两个作用域都要接线，且载荷不同：全局改 profile patch，项目改 .dsh/mcp.json。
  assert.match(clientSource, /inWorkspace \? \{ wsPath: scope, defer: next \} : \{ defer: next \}/,
    '项目作用域必须带 wsPath，否则会写错文件')
  // 项目作用域必须打开 includeWorkspace，否则项目行全被滤掉、按钮永远禁用。
  assert.match(clientSource, /includeWorkspace: true/)
  // 按钮不得常驻可点：没有可改对象时必须禁用，否则点一下返回 changed:0 而界面毫无变化。
  assert.match(clientSource, /deferAll\.total === 0 \|\| busy/)
})

test('排序键覆盖三种口径，且同键保持宿主返回的原始顺序', () => {
  const internals = loadClientInternals()
  const { sortServers, sortSkills, SORT_KEYS } = internals
  // ⚠️ 全部经 `[...]` 转成本地数组：vm 里的数组是**另一个 realm** 的 Array，
  // deepStrictEqual 会连原型一起比，跨 realm 即使内容相同也会红。
  assert.deepEqual([...SORT_KEYS], ['default', 'name', 'status'])
  // 没有「按作用域」：MCP 面按作用域药丸切开、技能面按组切开，每个列表里只可能有一种
  // 作用域，那个键永远改不动任何可见的东西。真机点过才看出来的。
  assert.equal(SORT_KEYS.includes('scope'), false, '排序键里不得有作用域这一档')

  const servers = [
    { serverName: 'zeta', enabled: true, status: 'connected', scope: 'global' },
    { serverName: 'alpha', enabled: true, status: 'failed', scope: 'workspace' },
    { serverName: 'mid', enabled: false, status: 'stopped', scope: 'global' },
  ]
  const names = (rows) => [...rows].map((s) => s.serverName)
  assert.deepEqual(names(sortServers(servers, 'default')), ['zeta', 'alpha', 'mid'],
    '默认顺序必须原样返回（不重排）')
  assert.deepEqual(names(sortServers(servers, 'name')), ['alpha', 'mid', 'zeta'])
  assert.deepEqual(names(sortServers(servers, 'status')), ['alpha', 'zeta', 'mid'],
    '有问题的排最前，停用排最后')
  assert.deepEqual(names(sortServers(servers, 'scope')), ['zeta', 'alpha', 'mid'],
    '未知键必须是「原样返回」，不能悄悄换一种排法')

  const stable = [
    { serverName: 'b', enabled: true, status: 'connected' },
    { serverName: 'a', enabled: true, status: 'connected' },
  ]
  assert.deepEqual(names(sortServers(stable, 'status')), ['b', 'a'],
    '状态相同的行必须保持原顺序（顺序突变看起来像「数据被改了」）')

  const skills = [
    { name: 'zhanggui', enabled: true, source: 'user-agents', scope: 'global' },
    { name: 'docx', enabled: false, source: 'project-agents', scope: 'project', cwd: '/w/a' },
  ]
  const skillNames = (rows) => [...rows].map((r) => r.name)
  assert.deepEqual(skillNames(sortSkills(skills, 'status')), ['docx', 'zhanggui'],
    '已停用的排前面——那是需要你处理的那一批')
  assert.deepEqual(skillNames(sortSkills(skills, 'name')), ['docx', 'zhanggui'])
})

// ═══ ⑥ 作用域药丸与列表分组同源 ═════════════════════════════════════════════
test('作用域药丸的计数与它筛出来的行数一定相等', () => {
  const internals = loadClientInternals()
  const { skillScopeTabs, skillGroups, skillGroupKey } = internals
  const rows = [
    { name: 'a', source: 'user-agents', scope: 'global' },
    { name: 'b', source: 'user-agents', scope: 'global' },
    { name: 'c', source: 'project-agents', scope: 'project', cwd: '/w/one' },
    { name: 'd', source: 'project-agents', scope: 'project', cwd: '/w/two' },
    { name: 'e', source: 'bundled', scope: 'global' },
  ]
  const tabs = skillScopeTabs(rows)
  assert.equal(tabs[0].key, 'all')
  assert.equal(tabs[0].count, rows.length)
  // 药丸的 key 必须是分组身份本身：各算一份的话，药丸点了筛不出行，
  // 而界面上看不出哪里错（高亮正常、列表空着）。
  assert.deepEqual(tabs.slice(1).map((tab) => tab.key), skillGroups(rows).map((group) => group.key))
  for (const tab of tabs.slice(1)) {
    const matched = rows.filter((row) => skillGroupKey(row) === tab.key)
    assert.equal(matched.length, tab.count,
      `药丸「${tab.label}」写着 ${tab.count}，实际筛出 ${matched.length} 行`)
  }
  // 两个项目即使 source 相同也必须各占一个药丸（否则点了会筛出两个项目的技能）。
  assert.equal(tabs.filter((tab) => tab.label.includes('项目')).length, 2)
})

// ═══ ⑦ 图标：全部画在 16×16 里，且不再用字符 ═══════════════════════════════
test('每个图标路径都落在 Icon 的 16×16 viewBox 内', () => {
  // 事故现场：edit / eye / copy 三条是照 24 单位的网格写的（edit 的 y 一直到 20），
  // 而 Icon 的 viewBox 是 '0 0 16 16' 且不做缩放——坐标出框等于那个图标**整个不可见**，
  // 「编辑」按钮上一直是空的，没有任何用例会红。
  const { ICONS } = loadClientInternals()
  const names = Object.keys(ICONS)
  assert.ok(names.length >= 20, `图标表只有 ${names.length} 条，像是被删空了`)
  for (const [name, d] of Object.entries(ICONS)) {
    assert.equal(typeof d, 'string')
    assert.ok(d.length > 0, `ICONS.${name} 是空的`)
    for (const token of d.match(/\d+(?:\.\d+)?/g) ?? []) {
      assert.ok(Number(token) <= 16,
        `ICONS.${name} 的坐标 ${token} 超出了 16×16 的 viewBox（出框的图标整个看不见）`)
    }
  }
})

test('面板不再用字符充当图标', () => {
  // 三套折叠指示器（向下/向右的三角字符、常驻三角 + CSS 旋转、感叹号）、
  // 删除键上的乘号、两处警示三角，都换成了 Icon。
  // 字符的基线、字号与字体回退各平台不同，换台机器就换一副样子。
  for (const literal of ["'▾'", "'▸'", "'✕'", "'⚠"]) {
    assert.equal(clientSource.includes(literal), false,
      `渲染代码里还留着字符图标 ${literal}——统一走 Icon + ICONS`)
  }
})

// ═══ ⑧ 死样式与旧类名的棘轮 ═════════════════════════════════════════════════
test('被替换掉的类名不得回流', () => {
  // 每一条都是这次改版**删掉**的：市场浮层、技能面私有原语、更新条自有样式、
  // 让位条自有样式。
  const prefixes = [
    'dsh-mcp-upd',
    'dsh-skills-banner',
    'dsh-skills-card',
    'dsh-skills-mode',
    'dsh-skills-tag',
    'dsh-skills-grid',
    'dsh-skills-bar',
    'dsh-skills-search',
    'dsh-mcp-builtin-',
    'dsh-mcp-market-grid',
    'dsh-mcp-market-chips',
    'dsh-mcp-market-search',
    'dsh-mcp-market-stat',
  ]
  for (const prefix of prefixes) {
    assert.equal(clientSource.includes(`className: '${prefix}`), false, `${prefix} 不应再被渲染`)
  }
  assert.equal(clientSource.includes('BuiltinInstallModal'), false, '市场已改为内联视图，浮层组件应已删除')
  assert.equal(clientSource.includes("'dsh-mcp-modal dsh-mcp-market'"), false, '市场不得回退成浮层')
})

test('市场卡片不再与详情卡片撞同一个类名', () => {
  // 撞名的代价是真实的：市场那条 `.dsh-mcp-card{display:flex}` 曾经把
  // `.dsh-mcp-pane-off{display:none}` 压掉，三个页签同时显示。
  assert.match(clientSource, /className: 'dsh-mcp-mcard' \+ \(item\.installed/)
  assert.match(clientSource, /className: 'dsh-mcp-mcard' \+ \(installed/)
  // 详情/表单里的内容卡仍叫 .dsh-mcp-card：4 处（两个详情各两页）。
  assert.equal((clientSource.match(/className: 'dsh-mcp-card' \+ paneOff/g) ?? []).length, 4,
    '详情内容卡的数量变了——确认不是市场卡片借用了这个名字')
})

test('市场的搜索是「提交才打上游」：草稿与已提交关键字必须分开', () => {
  // ⚠️ 这条抓的是一个**真实缺陷**（2026-10-10 真机 + 依赖链证实）：
  //   症状：在搜索框里每敲一个字就发一次 skillHubSearch（宿主侧打到 skillhub.cn）。
  //   根因：`searchHub` 是 useCallback，依赖里含 `query`（输入框直接绑的那份状态），
  //         而挂载副作用是 `useEffect([call, searchHub])` —— 击键改 query ⇒ searchHub 换身份
  //         ⇒ effect 重跑 ⇒ 发请求。与代码注释和文档都写着的「显式触发（回车 / 切分类）」相反。
  //   修法：草稿（marketDraft）与已提交关键字（hubKeyword）分开；卸载依赖上只留后者；
  //         顺带把管理面筛选词（query）与市场草稿也分开——它们本来就是两个搜索框。
  //
  // 为什么这里是**文本守卫**而不是行为断言：本仓库的两套假 React 都不模拟
  // useCallback 的 memo 与 useEffect 的依赖比较（`useCallback: (cb) => cb`），
  // 所以「击键不重发」在 CI 里表达不出来。行为证据是真机 wire：修前敲 3 个字 = 3 次请求，
  // 修后敲 3 个字 = 0 次、回车 = 1 次（见提交说明）。这里的形状是那条行为在源码上的投影。
  assert.match(clientSource, /const \[marketDraft, setMarketDraft\] = useState\(''\)/, '市场关键字要有草稿态')
  assert.match(clientSource, /const \[hubKeyword, setHubKeyword\] = useState\(''\)/, '市场关键字要有已提交态')
  // 正向：依赖里只准有已提交的关键字。
  assert.match(clientSource, /\}, \[call, hubCategory, hubKeyword\]\);/, 'searchHub 必须依赖已提交的关键字')
  // 反向（这条才是回归闸）：依赖里不得再出现草稿或管理面筛选词。
  assert.doesNotMatch(clientSource, /\}, \[call, hubCategory, (?:query|marketDraft)\]\);/,
    'searchHub 不得依赖草稿/筛选词——那会让每次击键都打一次上游')
  // 输入框：改草稿、回车才提交；不得再直接绑 query 或直接调 searchHub。
  assert.match(clientSource, /onChange: \(event\) => setMarketDraft\(event\.target\.value\)/)
  assert.match(clientSource, /onKeyDown: \(event\) => \{ if \(event\.key === 'Enter'\) setHubKeyword\(marketDraft\); \}/)
  assert.doesNotMatch(clientSource, /value: query,\n\s+placeholder: '搜索 skillhub\.cn/,
    '市场搜索框不得再绑管理面的筛选词')
  // 分类接口只该有一个调用点，且必须带 locale（上游分类中英两份，按语言挑）
  // 并随语言版本重取——不传 locale 英文界面下分类行就是中文。
  assert.equal((clientSource.match(/await call\('skillHubCategories', \{ locale: contentLocale\(\) \}\)/g) ?? []).length, 1,
    '分类调用必须带 locale，且只有一个调用点')
  assert.equal((clientSource.match(/await call\('skillHubCategories'/g) ?? []).length, 1,
    '分类接口只该有一个调用点：塞进搜索的 effect 里会每搜一次多打一次分类接口')
  assert.equal((clientSource.match(/void searchHub\(\);/g) ?? []).length, 1,
    'searchHub 的直接调用点只应有挂载/依赖变化那一处（重试按钮用 onClick 传函数）')
})
