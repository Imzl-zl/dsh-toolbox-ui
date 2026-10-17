// 客户端技能组件（row 11）。
//
// 这一层的测试重点是**纯逻辑**：面板形状的推导、作用域候选项的派生、被遮蔽判定、
// 非法条目与禁用条目的合并。组件的 JSX 结构在 jsdom 里测不出多少真东西（渲染得出来
// 不等于对），所以可验证的价值集中在这些函数上——它们也正是最容易出错的地方。
//
// 三条来自 SPEC 的硬约束：
//   约束 12：UI **不得写死** skill 根路径。本机 ~/.dsh/skills(rank 400) 就不存在，
//            11 个技能全在 ~/.agents/skills(rank 500)，所以作用域候选项必须由**实际发现**
//            的 source 集合派生，且按 source 显示真实路径。
//   约束 13：每个工作区各调一次 list({cwd}) 再合并（宿主在传 cwd 时返回合并视图）。
//   D8：管理行按（名称 + 作用域）精确操作；新增「被遮蔽 / 非法条目」提示。
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const clientSource = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const exportMarker = 'exports.inject = inject;'
const instrumentedClient = clientSource.replace(
  exportMarker,
  `${exportMarker}\nexports.__skills = { SCOPE_LABELS, projectLabelOf, skillScopeLabel, skillGroups, skillGroupRank, skillTwinCounts, skillScopeOptions, skillRows, shadowedSkills, skillDiagnostics, skillDetailRequest, SkillsPanel, SkillRow, SkillGroupHeader, SkillDetail, SkillDetailPane, SkillInstallModal, McpTab, McpOverlay, panelVisibility, Toggle };`,
)

assert.notEqual(instrumentedClient, clientSource, 'client test export marker must stay current')

/** 造一份假 React，直接调用组件（沿用 client-behavior 的手法）。 */
function loadClientInternals() {
  // useState 的值**跨重渲染保留**，setter 置脏标记；`__render` 反复渲染到不再置脏为止。
  // 这是唯一能走到「靠内部 state 切换的分支」的办法：直接调一次组件函数只能看到初始 state，
  // 而技能面（ability === 'skills'）正好挂在这样一个 state 后面——本文件要测的第二个真机
  // 缺陷就在那个分支里，够不着它就等于没测。
  // ⚠️ state 必须**按组件分槽**：McpOverlay 与 McpTab 各有自己的 useState 序列，
  // 共用一个数组会让槽位错位（表现为 servers 忽然不是数组）。
  const stores = new Map()
  let current = null
  const react = {
    Fragment: Symbol('Fragment'),
    // ⚠️ children 必须同时写进 props（children.length === 1 时取单值）——这是 JSX 编译
    // 的真实形状：真 React 里 <Badge cls="x">text</Badge> 编译成
    // createElement(Badge, { cls: 'x', children: 'text' })，**children 在 props 里**。
    // 之前只放进 rest，凡是「从 props 解构 children」的函数组件（Badge/Btn…）在这个
    // 假 React 下拿到的都是 undefined——测试收集到的文本树因此残缺，变异验证
    // （行内塞回作用域 badge）没有变红，绿灯是假的。
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
    /** 渲染到稳定：setter 触发的重渲染会在这里被反复消化。 */
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
  const window = {
    __ModuleLoader__: {
      load(definition) {
        client = definition.factory(() => react)
      },
    },
  }
  vm.runInNewContext(instrumentedClient, {
    console,
    document: { querySelector: () => null, createElement: () => ({ dataset: {} }) },
    navigator: {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    // 删除是破坏性动作，组件里用裸 `confirm`（与 MCP 面的 onRemove 同一约定）；
    // 沙箱里必须有它，否则那条路径在被调用时会 ReferenceError（等于测不到）。
    confirm: () => true,
    setInterval,
    setTimeout,
    clearInterval,
    clearTimeout,
    window,
  })
  return { ...client.__skills, __render: react.__render, __effects: react.__effects, __expand: (tree) => expandComponents(tree, react) }
}

/**
 * 跑掉挂起的首屏 useEffect 并等状态落地。
 *
 * 为什么需要：SkillsPanel 的数据在 `useEffect(() => { void load() })` 里加载，而 `load` 是
 * async——effect 本身同步返回，`setRows` 要等 promise 兑现。只 `await effect()` 不够，
 * 必须再让出一个宏任务，否则重渲染时 rows 仍是空数组，列表断言会在空列表上「通过」（假绿）。
 */
async function flushEffects(internals) {
  for (const effect of internals.__effects.splice(0)) {
    await effect()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

/** 深度优先找第一个满足谓词的节点（假 React 树就是 { type, props, children }）。 */
function findNode(tree, predicate) {
  return collectAll(tree, predicate)[0]
}

/** 收集**全部**满足谓词的节点（断言「有几个组头」这类计数时需要）。 */
function collectAll(tree, predicate, out = []) {
  if (tree === null || tree === undefined || typeof tree !== 'object') return out
  if (Array.isArray(tree)) {
    for (const child of tree) collectAll(child, predicate, out)
    return out
  }
  if (predicate(tree)) out.push(tree)
  for (const child of tree.children ?? []) collectAll(child, predicate, out)
  return out
}

/**
 * 递归展开函数组件，得到一棵**真实的元素树**。
 *
 * 为什么需要它：假 React 的 `createElement(Component, …)` 只产出 `{ type: Component, props }`，
 * 组件体不会被执行——于是「SkillsPanel 内部到底渲染了什么」在树里根本看不见。
 * 前面几条接线用例只需要看 props（够用），但「两个能力面是否共用同一套布局原语」
 * 必须看到**展开后的元素**，否则断言只能在表层空转。
 *
 * @param {object} tree - 假 React 树（可含函数组件节点）。
 * @param {object} react - 提供 __render 的假 React。
 * @param {number} depth - 剩余展开层数（防止组件互相引用导致无限递归）。
 * @returns {object} 元素已展开的树（函数组件被替换为它渲染出的元素）。
 */
function expandComponents(tree, react, depth = 6) {
  if (depth <= 0 || tree === null || tree === undefined || typeof tree !== 'object') return tree
  if (Array.isArray(tree)) return tree.map((child) => expandComponents(child, react, depth))
  const { type, props } = tree
  if (typeof type === 'function') {
    // 组件体内可能再调 useState/useMemo，必须走 __render 才能拿到正确 state 槽位。
    const rendered = react.__render(type, props)
    return expandComponents(rendered, react, depth - 1)
  }
  return { ...tree, children: expandComponents(tree.children, react, depth) }
}

/** 收集一棵假 React 树里出现过的字符串（含 props 值），用于断言「界面上真的显示了什么」。 */
function textOf(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const child of node) textOf(child, out); return out }
  if (typeof node === 'object') {
    for (const value of Object.values(node.props ?? {})) {
      if (typeof value === 'string' || typeof value === 'number') out.push(String(value))
    }
    for (const child of node.children ?? []) textOf(child, out)
  }
  return out
}

// ⚠️ 跨 realm 注意：被测代码跑在 vm.runInNewContext 里，它返回的数组来自**另一个 realm**，
// 原型不同，assert.deepEqual（strict 下是 deepStrictEqual）会以
// "Values have same structure but are not reference-equal" 失败——那是**测试写法**问题，
// 不是实现问题。既有用例（client-behavior.test.mjs 的 `Array.from(preset.args)`）已经
// 用同一手法绕开，这里沿用：比较前先 Array.from 归一化。
const list = (value) => Array.from(value);

const skill = (over = {}) => ({
  name: 'zhanggui',
  description: '端到端拥有一个开发请求',
  modelInvocable: true,
  userInvocable: true,
  // 定位的另一半：根 + 条目（磁盘条目名，可能与 name 不同）+ 形态。
  entry: 'zhanggui',
  kind: 'bundle',
  source: 'user-agents',
  scope: 'global',
  root: '/home/u/.agents/skills',
  path: '/home/u/.agents/skills/zhanggui/SKILL.md',
  ...over,
})

/**
 * skillsManager 实际暴露的方法（与 lib/index.js 的 @Remote 声明对应）。
 *
 * 刻意**不叫** `remove`：客户端适配器（dsh-api-gateway）自己就有同名原型方法，
 * `ctx.remote.$mount` 会把重名的 endpoint 直接拒掉——真机上表现为整页 boot 失败。
 * 见 lib/typert.js 的说明与 test/client-admission.test.mjs。
 */
const SKILLS_METHODS = new Set([
  'list', 'detail', 'setEnabled', 'setModelInvocable', 'removeSkill', 'importSkill',
  'skillTargets', 'skillHubSearch', 'skillHubDetail', 'skillHubCategories', 'skillHubInstall',
  'conflictingManager',
])

/**
 * 用「useEffect 立即执行」的假 React 挂载 SkillsPanel，返回它发出的 RPC 调用。
 *
 * 这是本文件唯一能覆盖**组件接线**的手段：纯函数用例看不到「面板调了哪个方法」，
 * 而调错服务的方法不会抛错、只会静默返回 {ok:false}（表现为界面上少一块数据）。
 */
function mountSkillsPanel({ onCall }) {
  const react = {
    Fragment: Symbol('Fragment'),
    // children 同样必须合进 props（见上面 loadClientInternals 里那条注释——JSX 的真实形状）。
    createElement: (type, props, ...children) => {
      const rest = props ?? {}
      const withChildren = children.length === 0
        ? rest
        : { ...rest, children: children.length === 1 ? children[0] : children }
      return { type, props: withChildren, children }
    },
    useCallback: (callback) => callback,
    // 立即执行：首次挂载的加载逻辑都写在 useEffect 里，不跑就等于没挂载。
    useEffect: (fn) => { react.__effects.push(fn) },
    useMemo: (factory) => factory(),
    useRef: (value) => ({ current: value }),
    useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
    __effects: [],
  }
  let client
  vm.runInNewContext(instrumentedClient, {
    console,
    document: { querySelector: () => null, createElement: () => ({ dataset: {} }) },
    navigator: {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    // 删除是破坏性动作，组件里用裸 `confirm`（与 MCP 面的 onRemove 同一约定）；
    // 沙箱里必须有它，否则那条路径在被调用时会 ReferenceError（等于测不到）。
    confirm: () => true,
    setInterval, setTimeout, clearInterval, clearTimeout,
    window: { __ModuleLoader__: { load(definition) { client = definition.factory(() => react) } } },
  })
  const call = async (method, args) => {
    const result = await onCall(method, args)
    return result ?? { ok: true }
  }
  const tree = client.__skills.SkillsPanel({ call, onClose() {}, floating: true })
  return { tree, effects: react.__effects, call }
}

test('the panel only calls RPC methods the skills service actually has', async () => {
  // ⚠️ 这条抓的是一个**真实缺陷**，而本文件的纯函数用例结构上测不到它：
  // SkillsPanel 的 `call` 是 callSkills（打到 skillsManager），但它却调了
  // `listWorkspaces` —— 那个方法只在 **mcpManager** 上。callSkills 遇到未定义方法时
  // 返回 { ok: false }，于是**项目作用域的技能永远不出现**：不报错、只是静默少数据。
  const called = []
  const { effects } = mountSkillsPanel({
    onCall: async (method) => {
      called.push(method)
      return SKILLS_METHODS.has(method) ? { ok: true, skills: [], disabled: [] } : { ok: false, error: '未连接' }
    },
  })
  for (const effect of effects) await effect()

  assert.ok(called.length > 0, '首次挂载应发出 RPC（否则这条用例是空转）')
  const wrong = called.filter((method) => !SKILLS_METHODS.has(method))
  assert.deepEqual(wrong, [],
    `面板通过 callSkills 调了 skillsManager 上不存在的方法：${wrong.join(', ')}——`
    + '它会静默返回 {ok:false}，表现为「项目级技能永远不出现」而没有任何报错')
})

test('源码里每一处 callSkills(…) 都指向真实存在的方法', () => {
  // ⚠️ 上一条只覆盖 SkillsPanel 里**跑到**的那些调用；这条覆盖**整个客户端源码**的字面量。
  //
  // 为什么必须补：2026-10-10 删掉内置精选目录（`skillsManager/market` 端点随之删除）时，
  // 外壳里那处「技能服务可用性探针」还在调 `callSkills('market')`——端点没了，它必然拿到
  // {ok:false}，于是面板先把技能面标成「服务未连接」，并触发一串连锁重渲染。
  // 真机 wire 证据：那一版在搜索框里敲 3 个字之后，`skillsManager/list` + `skillTargets` +
  // `mcpManager/list` + `listWorkspaces` 开始以约每秒一轮的速度**无限重发**（4 秒 +3 轮）；
  // 修掉探针后同样敲 3 个字，delta = 0。上一条用例看不见它：探针住在 McpTab，而那条只挂
  // SkillsPanel。所以这里退一步做**源码扫描**——它正好能抓住"删了端点但漏了调用点"这类漏网。
  const called = [...clientSource.matchAll(/callSkills\('([A-Za-z0-9_]+)'/g)].map((match) => match[1])
  assert.ok(called.length > 0, '源码里应能扫到 callSkills 调用（否则这条用例是空转）')
  const missing = [...new Set(called.filter((method) => !SKILLS_METHODS.has(method)))]
  assert.deepEqual(missing, [],
    `客户端源码调了 skillsManager 上不存在的方法：${missing.join(', ')}——`
    + '端点被删但调用点留着时，它会静默返回 {ok:false} 并让面板误报「服务未连接」')
})

test('the manage list actually draws the skill data it was given', async () => {
  // 「数据拿到了但没画出来」是组件最常见的失败，而纯函数用例全绿也发现不了。
  // ⚠️ 不能靠「渲染 SkillsPanel 再看树」来测：假 useState 不会重渲染，
  // 挂载时树里是**初始空状态**——那样断言只会得到「容器在」，等于没测数据。
  // 所以直接渲染**承载数据的子组件**并断言内容：
  const internals = loadClientInternals()
  const row = skill({ name: 'zhanggui' })
  // 列表行要画出技能名与调用权限——作用域由组头承载（见分组用例）。
  const rowTree = textOf(internals.SkillRow({ row, selected: false, onSelect() {}, shadowedBy: null, twins: undefined })).join(' | ')
  assert.match(rowTree, /zhanggui/, '列表行必须画出技能名')

  // 被遮蔽的行要显示提示（这是管理面板相对模型目录的独有价值）。
  const shadowedTree = textOf(internals.SkillRow({ row, selected: false, onSelect() {}, shadowedBy: skill({ source: 'project-agents', cwd: '/p' }), twins: undefined })).join(' | ')
  assert.match(shadowedTree, /被遮蔽/, '被遮蔽的行必须标出来')

  // 详情要画出根目录与调用权限——用户排查「为什么不生效」就靠这些。
  const detailTree = textOf(internals.SkillDetail({
    row, shadowedBy: null, body: { status: 'ok', text: '正文内容' }, busy: false, onRetry() {}, onToggle() {}, onRemove() {},
  })).join(' | ')
  assert.match(detailTree, /\/home\/u\/\.agents\/skills/, '详情必须画出真实根目录')
  assert.match(detailTree, /正文内容/, '详情必须画出技能正文')
})

test('a failed body read renders as a failure, never as an endless spinner', async () => {
  // ⚠️ 用户看到的「有的加载半天啥意思」就是这条：正文状态原本是个字符串，
  // 表达不了「失败」，于是 `content || '（加载中…）'` 把失败渲染成了等待。
  const internals = loadClientInternals()
  const errorTree = textOf(internals.SkillDetail({
    row: skill(), shadowedBy: null, body: { status: 'error', text: '找不到技能：wewrite' },
    busy: false, onRetry() {}, onToggle() {}, onRemove() {},
  })).join(' | ')
  assert.match(errorTree, /找不到技能：wewrite/, '失败必须把宿主原话显示出来')
  assert.doesNotMatch(errorTree, /加载中/, '失败态不得再出现「加载中」——那是把错误伪装成等待')
  assert.match(errorTree, /重试/, '失败态要给重试入口')

  // 反过来：只有真的在加载才允许出现「加载中」。
  const loadingTree = textOf(internals.SkillDetail({
    row: skill(), shadowedBy: null, body: { status: 'loading' },
    busy: false, onRetry() {}, onToggle() {}, onRemove() {},
  })).join(' | ')
  assert.match(loadingTree, /加载中/, 'loading 态才该显示加载中')
})

test('detail is asked with the full row reference, so the exact root and disk entry are read', () => {
  // ⚠️ 真机缺陷（第一版）：detail 只传 name → 宿主按 rank 返回**生效者**，
  // 点「被遮蔽」那一行看到的是别人的正文；只传 name 时项目级技能还查不到
  // （宿主不传 cwd 只扫用户级/bundled 根）。现在送整条引用。
  //
  // ⚠️ 而且必须带 **entry + kind**（磁盘条目与形态），不能只带 name：宿主允许磁盘条目名与
  // frontmatter 的 `name` 不一致（实测 `dir-name/SKILL.md` 里写 `name: dir-alias` 照收），
  // 而服务端要按磁盘上的真实位置定位。少了它们，那类技能在面板里所有操作都会失败。
  const internals = loadClientInternals()
  const projectRow = skill({ source: 'project-agents', scope: 'project', cwd: 'C:\\Users\\u\\Desktop\\公众号', root: 'C:\\Users\\u\\Desktop\\公众号\\.agents\\skills' })
  assert.deepEqual(
    list(Object.keys(internals.skillDetailRequest(projectRow)).sort()),
    ['entry', 'kind', 'name', 'projectPath', 'root', 'source'],
    '必须送整条引用（多送无益、少送会读错根或定位不到条目）',
  )
  const request = internals.skillDetailRequest(projectRow)
  assert.equal(request.source, 'project-agents')
  assert.equal(request.root, 'C:\\Users\\u\\Desktop\\公众号\\.agents\\skills', '必须带这一行自己的根')
  assert.equal(request.projectPath, 'C:\\Users\\u\\Desktop\\公众号')
  // 条目与形态也必须在：它们是定位的另一半（根 + 条目 = 一个确定的位置）。
  assert.equal(request.entry, projectRow.entry)
  assert.equal(request.kind, projectRow.kind)
})

test('scope labels name the project, not just the scope kind', () => {
  // 用户的原话：「你分项目和全局，但是没说哪个项目啊？」
  // 多工作区下每行都写着「项目 · .agents/skills」是没法区分的；行数据上一直有 cwd，
  // 只是从没被用上。
  const internals = loadClientInternals()
  const row = skill({ source: 'project-agents', scope: 'project', cwd: 'C:\\Users\\u\\Desktop\\公众号', root: 'C:\\Users\\u\\Desktop\\公众号\\.agents\\skills' })
  const label = internals.skillScopeLabel(row)
  assert.match(label, /^项目 公众号 · /, `标签要带项目名，实际：${label}`)
  assert.match(label, /\.agents\/skills/, '仍要说清是哪一级 source')

  // 全局与内置不带项目名（它们没有 cwd，也不该有）。
  assert.equal(internals.skillScopeLabel(skill({ source: 'user-agents' })), '全局 · .agents/skills')
  assert.equal(internals.skillScopeLabel(skill({ source: 'bundled' })), '内置（只读）')

  // 项目行缺 cwd 时退回不带名字，不能拼出「项目 undefined · …」。
  assert.equal(internals.skillScopeLabel(skill({ source: 'project-dsh', cwd: undefined })), '项目 · .dsh/skills')

  // 安装弹窗的作用域候选同样要带项目名。
  const option = list(internals.skillScopeOptions([row]))[0]
  assert.match(option.label, /公众号/, '安装弹窗的作用域候选要带项目名')
})

test('显示层增强的 RPC 抛错时不得逃逸成 Uncaught (in promise)', async () => {
  // 真机 console 实测（stack 经 prepareInvocation）：技能面里两个"取不到就用缺省"的
  // effect 只处理了 `result.ok === false`，RPC **抛错**（宿主没这个 endpoint / 传输失败）
  // 时那个 async IIFE 直接 reject → `Uncaught (in promise)`。注释承诺的缺省对抛错那条路
  // 根本不成立。这两个都是纯显示层增强，缺了只影响展示，不该把面板带下去。
  const internals = loadClientInternals()
  const unhandled = []
  const onUnhandled = (reason) => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  try {
    const called = []
    internals.__effects.length = 0
    internals.__render(internals.SkillsPanel, {
      call: async (method) => {
        called.push(method)
        if (method === 'skillHubCategories' || method === 'skillTargets') throw new Error(`transport failure for ${method}`)
        return { ok: true, skills: [], disabled: [] }
      },
      workspaces: [],
      onClose() {},
      floating: true,
    })
    await flushEffects(internals)
    // rejection 是在 effect 同步返回之后的下一个 tick 冒出来的，所以要多等一个宏任务。
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.ok(called.includes('skillHubCategories'), '用例前提：市场分类的 effect 必须真的跑过')
    assert.ok(called.includes('skillTargets'), '用例前提：安装目标的 effect 必须真的跑过')
    assert.deepEqual(unhandled.map((reason) => String(reason?.message ?? reason)), [],
      '显示层增强的 RPC 抛错必须被显式吞掉（缺省值就是调用方的初始 state）')
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

test('the managed list carries scope in group headers, never again in row badges', async () => {
  // ⚠️ 设计约束（从「行内画出」升级而来）：一条作用域标签是「哪一级 × 哪个项目」两维，
  // 压进 139px 的原生 select 或行内 badge 都必然被裁（Windows Chrome 的 option 面板
  // 宽度等于 select 自身、不换行）。所以作用域由**组头**承载，行内不得再挂它。
  const internals = loadClientInternals()
  const projectRow = skill({ name: 'wewrite', source: 'project-agents', scope: 'project', cwd: 'C:\\Users\\u\\Desktop\\公众号', root: 'C:\\Users\\u\\Desktop\\公众号\\.agents\\skills' })
  const globalRow = skill({ name: 'zhanggui', source: 'user-agents', scope: 'global' })
  const callSkills = async (method) => {
    return { ok: true, skills: [projectRow, globalRow], disabled: [] }
  }
  internals.__effects.length = 0
  internals.__render(internals.SkillsPanel, { call: callSkills, workspaces: [], onClose() {}, floating: true })
  await flushEffects(internals)
  const tree = internals.__expand(internals.__render(internals.SkillsPanel, { call: callSkills, workspaces: [], onClose() {}, floating: true }))

  // 组头：整行宽，能放下「项目 公众号 · .agents/skills」。
  const groupHeads = collectAll(tree, (node) => typeof node.props?.className === 'string' && node.props.className.split(' ').includes('dsh-skills-group'))
  assert.equal(groupHeads.length, 2, `两个作用域要出两个组头，实际 ${groupHeads.length}`)
  const groupText = groupHeads.map((head) => textOf(head).join(' | ')).join(' | ')
  assert.match(groupText, /项目 公众号 · \.agents\/skills/, '组头要带项目名')
  assert.match(groupText, /全局 · \.agents\/skills/, '组头要带全局作用域')

  // 行内不得再出现作用域标签（防止将来又把长路径塞回去）。
  const rowTexts = collectAll(tree, (node) => typeof node.props?.className === 'string' && node.props.className.includes('dsh-mcp-item-sub'))
    .map((sub) => textOf(sub).join(' | '))
  for (const text of rowTexts) {
    assert.doesNotMatch(text, /全局 · |项目 公众号/, `行内不得再画作用域标签，实际：${text}`)
  }

  // 次序：全局在前、项目在后、内置垫底（原先 bundled 按字母序置顶）。
  assert.ok(groupText.indexOf('全局') < groupText.indexOf('项目 公众号'), '全局组要排在项目组之前')
})

test('grouping makes the project part of the group identity and sorts bundled last', () => {
  // 两个项目都有 project-agents：只按 source 分组会把两个项目的技能混进同一组。
  const internals = loadClientInternals()
  const rows = [
    skill({ name: 'a', source: 'bundled', scope: 'global' }),
    skill({ name: 'b', source: 'project-agents', scope: 'project', cwd: 'C:\\p\\easyStory', root: 'C:\\p\\easyStory\\.agents\\skills' }),
    skill({ name: 'c', source: 'project-agents', scope: 'project', cwd: 'C:\\q\\easyStory', root: 'C:\\q\\easyStory\\.agents\\skills' }),
    skill({ name: 'd', source: 'user-agents', scope: 'global' }),
  ]
  const groups = list(internals.skillGroups(rows))
  assert.equal(groups.length, 4, `两个同 source 的项目必须是两组，实际 ${groups.length}`)

  const labels = groups.map((group) => group.label)
  const at = (needle) => labels.findIndex((label) => label.includes(needle))
  assert.ok(at('全局') !== -1 && at('全局') < at('项目'), '全局在前')
  assert.equal(at('内置'), labels.length - 1, '内置（只读）垫底——原先按 source 字母序它置顶')

  // 分组在**过滤之后**这件事由调用方保证；这里只验证组内行归属正确。
  // 两个项目刻意同名（都叫 easyStory）：仍是**两组**（组身份含 cwd），只按 cwd 区分——
  // 这正是「同名项目靠 title 与详情页兜底」的场景，也钉住「只按 source 分组会混」那半句。
  const easyStory = groups.filter((group) => group.source === 'project-agents')
  assert.equal(easyStory.length, 2, '同名项目仍是两组')
  const byCwd = new Map(easyStory.map((group) => [group.cwd, list(group.rows.map((row) => row.name))]))
  assert.deepEqual(byCwd.get('C:\\p\\easyStory'), ['b'])
  assert.deepEqual(byCwd.get('C:\\q\\easyStory'), ['c'])
})

test('same-name rows across scopes report their twins and the shadow winner', () => {
  // 分组之后同名跨作用域第一次「看得见」：同一个名字落在两个组里就是遮蔽的现场。
  // 原先只有一个「被遮蔽」badge，用户知道有问题但找不到另一份在哪。
  const internals = loadClientInternals()
  const winner = skill({ name: 'wewrite', source: 'user-agents', scope: 'global' })
  const loser = skill({ name: 'wewrite', source: 'project-agents', scope: 'project', cwd: 'C:\\p\\easyStory' })
  // ⚠️ 输入契约：twin 表按 `row.key` 索引，而行必须先过 skillRows() 才有稳定的 key
  // （key = 名称+作用域+来源，是 React 列表与这份表的共同键）。面板里 rows 正是这么来的。
  const [winnerRow, loserRow] = list(internals.skillRows([winner, loser]))
  const counts = internals.skillTwinCounts([winnerRow, loserRow])
  assert.equal(counts.get(loserRow.key).total, 2, '同名要标出总份数')
  assert.match(counts.get(loserRow.key).others[0], /全局/, '要说出另一份在哪')

  // 无同名的行不进表。
  const solo = skillRows(internals, [skill({ name: 'solo' })])[0]
  assert.equal(internals.skillTwinCounts([winnerRow, solo]).has(solo.key), false, '无同名不给 badge')

  // 行渲染：被遮蔽的行要说出生效者，未遮蔽的同名行标份数。
  const loserTree = textOf(internals.SkillRow({ row: loserRow, selected: false, onSelect() {}, shadowedBy: winnerRow, twins: counts.get(loserRow.key) })).join(' | ')
  assert.match(loserTree, /被遮蔽/, '被遮蔽要标出来')
  assert.match(loserTree, /全局/, '要说出生效的那份在哪')

  const winnerTree = textOf(internals.SkillRow({ row: winnerRow, selected: false, onSelect() {}, shadowedBy: null, twins: counts.get(winnerRow.key) })).join(' | ')
  assert.match(winnerTree, /同名 2 份/, '生效的那份也要知道另有副本')
})

/** 过 skillRows（加稳定 key）的便捷写法：跨 realm 返回值用 list() 归一化。 */
function skillRows(internals, rows) {
  return list(internals.skillRows(rows))
}

test('the install modal serves the external source only, and always demands an acknowledgement', () => {
  // 市场只剩 skillhub.cn 一条来源，所以这个弹窗就是唯一的安装入口。
  // 上游条目没有许可字段：能做且该做的只有披露 + 显式确认。
  const internals = loadClientInternals()
  const entry = { name: 'convert', slug: 'convert', summary: 'x', source: 'skillhub', pageUrl: 'https://skillhub.cn/skills/convert' }
  const props = {
    entry,
    scopeOptions: [{ id: 'user-agents\u0000/r', source: 'user-agents', label: '全局', root: '/r', writable: true }],
    scope: 'user-agents\u0000/r',
    onScope() {}, onClose() {}, onConfirm() {}, busy: false,
    external: {
      pageUrl: entry.pageUrl,
      publisher: { name: '某公司', verified: true, certifiedName: '某公司' },
      security: { keen: { status: 'pass', statusText: '安全，无风险' } },
      requiresApiKey: false,
    },
  }

  const tree = internals.__render(internals.SkillInstallModal, props)
  const texts = textOf(tree).join(' | ')
  assert.match(texts, /本插件未核验/, '外部源必须写明本插件未核验')
  assert.match(texts, /我知道这是外部来源/, '必须有一次显式确认')
  assert.match(texts, /某公司/, '发布方认证要摆出来')
  const confirm = findNode(tree, (node) => node.props?.cls === 'primary')
  assert.ok(confirm, '弹窗要有主操作按钮')
  assert.equal(confirm.props.disabled, true, '未勾选时安装按钮必须不可点')
  assert.match(texts, /确认并安装/, '按钮文案要说清这是确认动作')

  // ⚠️ 真机抓到的反例（外部证据，不是推演）：装 skillhub.cn 的 dev-expert 时，弹框写着
  // 「无 scripts/ 目录」，而落盘出来的技能**带 scripts/ 与 hooks/*.py**。
  // 根因：上游条目没有 scripts / allowedTools 字段（normalizeHubSkill 拿不到），
  // 所以 entry.scripts 恒为 undefined，三元表达式的 else 分支把「没核验」渲染成了「没有」。
  // 这个弹框是市场现在**唯一**的安装路径，把未核验说成事实是它最不该犯的错——所以钉住：
  // 对外部源不得出现「无 scripts/ 目录」，且必须写明未提供 + 未核验。
  assert.doesNotMatch(texts, /无 scripts\/ 目录/, '外部源不得断言"无 scripts/ 目录"（上游不给该字段）')
  assert.match(texts, /上游未提供清单，本插件未核验/, '可执行片段必须如实写"上游未提供"')

  // 市场只剩 skillhub.cn 之后，市场里不存在「许可受限但能被勾选装进去」的条目——
  // 那种条目连来源都没有了（卡片层 SkillCard 已整条删除）。
  // 弹窗自身不提供第二条旁路：未勾选时主操作不可点（上面已断）。
})

test('「删除技能」走的是 removeSkill，不是启停开关', async () => {
  // 首版把 onRemove 也传成 toggleRow：点「删除技能」只会把技能**停用**（还报成功），
  // 而真正的 removeSkill RPC 全仓没有调用点。这条用例钉住两件事：两个回调不是同一个
  // 动作，且删除动作送的是 removeSkill + 目标引用（source/root，不送 writable）。
  const internals = loadClientInternals()
  const calls = []
  const row = { name: 'wewrite', description: 'x', source: 'user-agents', scope: 'global', root: '/root', kind: 'bundle', enabled: true, key: 'global:user-agents:wewrite' }
  const tree = internals.__render(internals.SkillsPanel, {
    call: async (method, payload) => {
      calls.push({ method, payload })
      return method === 'list' ? { ok: true, skills: [row], disabled: [] } : { ok: true }
    },
    workspaces: [],
    mode: 'manage',
    scopeFilter: 'all',
    onScopeFilter() {},
    sortKey: 'default',
    onSort() {},
  })
  const pane = findNode(tree, (node) => node.type === internals.SkillDetailPane)
  assert.ok(pane, '管理模式要画出右栏详情面板')
  assert.notEqual(pane.props.onRemove, pane.props.onToggle, '删除与启停必须是两个不同的动作')
  await pane.props.onRemove(row)
  const removed = calls.filter((entry) => entry.method === 'removeSkill')
  assert.equal(removed.length, 1, '删除必须调用 removeSkill')
  // 逐字段比对（载荷对象来自 vm 沙箱，跨 realm 的 deepEqual 会因为原型不同而失败）
  const payload = removed[0].payload
  assert.equal(payload.name, 'wewrite')
  assert.equal(payload.source, 'user-agents')
  assert.equal(payload.root, '/root')
  assert.equal(payload.projectPath, undefined)
  assert.equal('writable' in payload, false, 'wire 上不再有 writable：可写与否由服务端判定')
})

// ── 「模型自动调用」开关（issue #5）────────────────────────────────────────
//
// 用户要的是「快速修改 skill 的 disable-model-invocation」：不必去翻 SKILL.md。面板本来就**显示**
// 这个状态（列表徽章 + 详情属性行），缺的是**写**。两条必须成立：开关接到 RPC 上，且它显示的
// 状态与文件一致（行的权限由宿主从磁盘解析，见 lib/skills-registry.js 的 invocationOf）。

test('the model-invocation switch flips both ways and is disabled when it cannot know', () => {
  const internals = loadClientInternals()
  const requests = []
  const row = {
    name: 'zhanggui', description: '演示', source: 'user-agents', scope: 'global', root: '/root',
    modelInvocable: true, userInvocable: true,
  }
  const detail = (over) => internals.__expand(internals.SkillDetail({
    row: { ...row, ...over },
    shadowedBy: null,
    body: { status: 'ok', text: '正文' },
    busy: false,
    onRetry() {}, onToggle() {}, onRemove() {},
    onModelInvocable: (target, next) => requests.push([target.name, next]),
  }))
  const switchOf = (tree) => findNode(tree, (node) => node.props?.role === 'switch')

  const on = switchOf(detail({}))
  assert.ok(on, '详情页必须给出这个开关——它就是「不必手工改 SKILL.md」的全部价值')
  assert.equal(on.props['aria-checked'], true, '模型可调用时开关是开的')
  assert.equal(on.props.disabled, false)
  on.props.onClick({ stopPropagation() {} })
  assert.deepEqual(requests, [['zhanggui', false]], '点一下应请求「禁止模型自动调用」')

  requests.length = 0
  const off = switchOf(detail({ modelInvocable: false }))
  assert.equal(off.props['aria-checked'], false)
  off.props.onClick({ stopPropagation() {} })
  assert.deepEqual(requests, [['zhanggui', true]], '再点一下应请求「允许」——两个方向都要有')

  // 内置技能只读：服务端也会拒，但界面不该给出一个做不到的动作。
  assert.equal(switchOf(detail({ writable: false })).props.disabled, true, '内置只读')
  // frontmatter 读不出来（宿主会整条跳过它）：当前值未知，不能让用户在一个假状态上点。
  const unknown = detail({ modelInvocable: null })
  assert.equal(switchOf(unknown).props.disabled, true, '读不出权限时不可点')
  assert.match(textOf(unknown).join(' '), /未知/, '并且要说清是「未知」，不能显示成一个确定的值')
})

test('the list row badges BOTH invocation faces, because either one can be off', () => {
  // ⚠️ 这条来自**看 UI 预览**时发现的缺口：列表行原来只标模型面
  // （`enabled === false ? 已停用 : modelInvocable === false ? 仅用户可调用 : null`），
  // 于是「仅模型可调用」（用户面关着）在列表上**看不出任何异常**——用户点进去才发现
  // 自己没法用 /名字 调用它。两个面既然各自可关，列表就得各说一句。
  const internals = loadClientInternals()
  const base = {
    name: 'zhanggui', description: '演示', entry: 'zhanggui', kind: 'bundle',
    root: '/u/.agents/skills', source: 'user-agents', scope: 'global', writable: true,
    modelInvocable: true, userInvocable: true, enabled: true,
  }
  const subOf = (over) => {
    const tree = internals.__expand(internals.SkillRow({
      row: { ...base, ...over }, selected: false, onSelect() {}, onToggle() {},
      busy: false, shadowedBy: null, twins: null,
    }))
    return textOf(tree).join(' ')
  }

  // 四档各自的列表文案：能用的那一面不该出徽章，关掉的那面必须出。
  assert.doesNotMatch(subOf({}), /模型不用|不可手调/, '两个面都开着时不该有任何限制徽章')
  assert.match(subOf({ modelInvocable: false }), /模型不用/, '模型面关掉要说出来')
  assert.doesNotMatch(subOf({ modelInvocable: false }), /不可手调/, '用户面还开着就不该说它不能手调')
  assert.match(subOf({ userInvocable: false }), /不可手调/, '用户面关掉要说出来（这条以前是缺口）')
  assert.doesNotMatch(subOf({ userInvocable: false }), /模型不用/, '模型面还开着就不该说它不用')

  // 停用是更强的结论：只说「已停用」，不再重复两个面的限制（否则一行挤三个徽章）。
  const parked = subOf({ modelInvocable: false, userInvocable: false, enabled: false })
  assert.match(parked, /已停用/)
  assert.doesNotMatch(parked, /模型不用|不可手调/, '停用时说「已停用」就够了，不重复两个面')

  // 旧机制残留要能被认出来（它的「停用」在文件名里）
  assert.match(subOf({ modelInvocable: false, userInvocable: false, enabled: false, migrated: true }), /旧机制停用/)
})

test('the diagnostics row shows the state, never the raw root path (it overflows the sidebar)', async () => {
  // ⚠️ 真机发现的缺陷（起隔离 DSH 实例点出来的）：诊断行原来在副标题里塞了**整条根路径**，
  // 而那串路径在侧栏 185px 的单元格里溢出（实测 scrollWidth 237 > clientWidth 185），
  // 且 `.dsh-mcp-item-sub` **没有** ellipsis（只有 .dsh-mcp-item-name 有），
  // 于是那行被硬裁成「已」后面什么都没有——用户看到半截字，以为渲染坏了。
  //
  // ⚠️⚠️ 这条用例第一版**测错了对象**：它渲染 SkillRow，而诊断组是**内联在 SkillsPanel 里
  // 手写的**（不走 SkillRow），于是把根路径塞回去也不会有任何用例变红（变异验证当场发现）。
  // 所以必须渲染**真的 SkillsPanel**，让它自己产出诊断行。
  const internals = loadClientInternals()
  const longRoot = 'C:\\Users\\zhanglu\\AppData\\Local\\Temp\\dsh-uitest-agents\\skills'
  // 一条**旧机制残留**：它既进「已停用」也进「需要注意」两组，正是真机上溢出的那一行。
  const parked = {
    name: 'legacy-parked', description: '', entry: 'legacy-parked', kind: 'bundle',
    source: 'user-agents', scope: 'global', writable: true, root: longRoot,
    modelInvocable: false, userInvocable: false, enabled: false, migrated: true,
  }
  const call = async (method) => (method === 'list'
    ? { ok: true, skills: [parked] }
    : { ok: true, targets: [], skills: [], total: 0, labels: {} })
  const panelTree = internals.__render(internals.SkillsPanel, {
    call, workspaces: [], onSummary() {}, flash() {},
  })
  await flushEffects(internals)
  const tree = internals.__expand(internals.__render(internals.SkillsPanel, {
    call, workspaces: [], onSummary() {}, flash() {},
  }))

  const subs = []
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (node.props?.className === 'dsh-mcp-item-sub') subs.push(node)
    walk(node.props?.children)
    walk(node.children)
  }
  walk(tree)
  assert.ok(subs.length > 0, '必须先渲染出至少一个 .dsh-mcp-item-sub（否则这条用例是空转）')

  for (const sub of subs) {
    const text = textOf(sub).join(' ')
    assert.doesNotMatch(text, /C:\\Users|AppData|dsh-uitest-agents/,
      `副标题里不得出现根路径——它会在 185px 的侧栏里溢出并被硬裁（真机实测）。实际：${text}`)
  }
  // 状态本身照常说（残留与普通停用要能区分）
  assert.match(textOf(tree).join(' '), /旧机制停用/, '状态要说出来')
})

test('the user-invocable face has its OWN switch, wired to its own action', () => {
  // ⚠️ 这条补的是变异测试找到的缺口：原来 `switchOf` 只取**第一个** switch，于是第二个
  // （用户面）**完全没有被测**——把它接回 onModelInvocable 也不会有任何用例变红。
  //
  // 为什么第二个开关必须存在：宿主支持**两个**调用面，而「停用」只是「两个都关」这一种组合。
  // 只给模型面一个开关的话，用户在面板里拨不回「仅手动可调用」那一档（只能去编辑文件）。
  const internals = loadClientInternals()
  const calls = []
  const row = {
    name: 'zhanggui', description: '演示', entry: 'zhanggui', kind: 'bundle',
    root: '/u/.agents/skills', source: 'user-agents', scope: 'global', writable: true,
    modelInvocable: true, userInvocable: false,
  }
  const detail = (over) => internals.__expand(internals.SkillDetail({
    row: { ...row, ...over },
    shadowedBy: null,
    body: { status: 'ok', text: '正文' },
    busy: false,
    onRetry() {}, onToggle() {}, onRemove() {},
    onModelInvocable: (target, next) => calls.push(['model', target.name, next]),
    onUserInvocable: (target, next) => calls.push(['user', target.name, next]),
  }))
  /** 两个调用面的开关（顺序 = 详情页里的顺序：先模型面、后用户面）。 */
  const switches = (tree) => {
    const found = []
    findNode(tree, (node) => { if (node.props?.role === 'switch') found.push(node); return false })
    return found
  }

  const both = switches(detail({}))
  assert.equal(both.length, 2, `两个调用面各要有一个开关，实际 ${both.length} 个`)
  // 状态各自如实反映（这里刻意一开一关，好把「两个开关都显示同一个值」这种错抓出来）
  assert.equal(both[0].props['aria-checked'], true, '模型面：文件里是允许')
  assert.equal(both[1].props['aria-checked'], false, '用户面：文件里是禁止')

  // ⚠️ 关键：点第一个只能动模型面、点第二个只能动用户面（接错方法就红）
  both[0].props.onClick({ stopPropagation() {} })
  assert.deepEqual(calls, [['model', 'zhanggui', false]], '点模型面开关必须只请求模型面')
  calls.length = 0
  both[1].props.onClick({ stopPropagation() {} })
  assert.deepEqual(calls, [['user', 'zhanggui', true]], '点用户面开关必须只请求用户面（接错方法就是这里红）')

  // 文案要说清两个面的差别，否则用户不知道为什么要有两个开关
  assert.match(textOf(detail({})).join(' '), /模型自动调用/, '模型面要有标签')
  assert.match(textOf(detail({})).join(' '), /用户可调用/, '用户面要有标签')

  // 两个面都读不出来时，两个开关都必须禁用（不能让人在假状态上点）
  const unknown = switches(detail({ modelInvocable: null, userInvocable: null }))
  assert.equal(unknown.every((node) => node.props.disabled === true), true, '读不出权限时两个开关都不可点')
  // 内置只读同理
  const readonly = switches(detail({ writable: false }))
  assert.equal(readonly.every((node) => node.props.disabled === true), true, '内置只读时两个开关都不可点')
})

test('「调用权限未知」说的是**真实原因**，不能一律冤枉 frontmatter', () => {
  // ⚠️ 真机报告（issue #5）：技能目录是符号链接时那一行显示「调用权限未知」，悬浮提示写着
  // 「SKILL.md 的 frontmatter 读不出来（宿主会跳过这条技能）」——而文件完全合法、宿主也
  // 照常加载，坏的只是面板的根定位。用户照这句去查 frontmatter 只会白费功夫。
  // 原因必须分开说：根没定位到 ≠ 文件读不出来。
  const internals = loadClientInternals()
  const row = {
    name: 'linked-skill', description: 'x', source: 'user-agents', scope: 'global',
    enabled: true, modelInvocable: null, userInvocable: null, writable: true,
  }
  const detail = (over) => internals.__expand(internals.SkillDetail({
    row: { ...row, ...over },
    shadowedBy: null, body: { status: 'ok', text: '正文' }, busy: false,
    onRetry() {}, onToggle() {}, onRemove() {}, onModelInvocable() {},
  }))
  // textOf 会把 props 里的字符串（含 title）一起收进来，所以悬浮提示也在断言范围内。
  const unlocated = textOf(detail({})).join(' ');
  assert.match(unlocated, /符号链接/, '根没定位到时要指向定位问题，而不是让人去查 frontmatter');
  assert.doesNotMatch(unlocated, /frontmatter 读不出来/, '不能把定位失败说成 frontmatter 的问题');

  // 有 root 但读不到（文件被删/搬走）：这时才轮到 frontmatter/文件那一类说法。
  assert.match(textOf(detail({ root: '/u/.agents/skills' })).join(' '), /frontmatter/,
    '有根却读不到时，说的才是文件本身');
})

test('the panel wires the model-invocation switch to setModelInvocable with the row reference', async () => {
  const internals = loadClientInternals()
  const calls = []
  const row = { name: 'zhanggui', description: 'x', source: 'user-agents', scope: 'global', root: '/root', kind: 'bundle', enabled: true }
  const tree = internals.__render(internals.SkillsPanel, {
    call: async (method, payload) => {
      calls.push({ method, payload })
      return method === 'list' ? { ok: true, skills: [row], disabled: [] } : { ok: true }
    },
    workspaces: [], mode: 'manage', scopeFilter: 'all', onScopeFilter() {}, sortKey: 'default', onSort() {},
  })
  const pane = findNode(tree, (node) => node.type === internals.SkillDetailPane)
  assert.ok(pane, '管理模式要画出右栏详情面板')
  assert.equal(typeof pane.props.onModelInvocable, 'function', '权限开关必须接到一个动作上')
  assert.notEqual(pane.props.onModelInvocable, pane.props.onToggle, '调用权限与启停是两个不同的动作')

  await pane.props.onModelInvocable(row, false)
  const writes = calls.filter((entry) => entry.method === 'setModelInvocable')
  assert.equal(writes.length, 1, '开关必须调用 setModelInvocable')
  const payload = writes[0].payload
  assert.equal(payload.name, 'zhanggui')
  assert.equal(payload.source, 'user-agents')
  assert.equal(payload.root, '/root')
  assert.equal(payload.modelInvocable, false)
  assert.equal('writable' in payload, false, 'wire 上不再有 writable：可写与否由服务端判定')
})

test('a refused write says why instead of looking like a dead switch', async () => {
  // 改写规则会拒绝某些形状，而宿主给的是**具体原因**（「这个字段的值跨了多行，请手工修改」这类）。
  // 丢掉它就只剩「点了没反应」——而 docs/skills.md 与发布稿承诺的正是「面板会拒绝并说明原因，
  // 让你手工改」。技能面的行动作此前一律吞掉 {ok:false}，所以这条钉的是「失败必须说出来」。
  const internals = loadClientInternals()
  const flashes = []
  const row = { name: 'zhanggui', description: 'x', source: 'user-agents', scope: 'global', root: '/root', kind: 'bundle', enabled: true }
  const tree = internals.__render(internals.SkillsPanel, {
    call: async (method) => (method === 'list'
      ? { ok: true, skills: [row], disabled: [] }
      : { ok: false, error: '无法改写 disable-model-invocation：这个字段的值跨了多行，请手工修改' }),
    workspaces: [], mode: 'manage', scopeFilter: 'all', onScopeFilter() {}, sortKey: 'default', onSort() {},
    flash: (msg, kind) => flashes.push([msg, kind]),
  })
  const pane = findNode(tree, (node) => node.type === internals.SkillDetailPane)
  assert.ok(pane, '前提：管理模式要画出右栏详情面板')
  await pane.props.onModelInvocable(row, false)

  assert.equal(flashes.length, 1, '被拒绝时必须给用户一条消息（0 条 = 开关看起来是坏的）')
  assert.match(flashes[0][0], /跨了多行|手工修改/, '要把宿主的原话给出去，否则用户不知道该改哪里')
  assert.equal(flashes[0][1], 'err', '失败要用失败的语气，不能报成成功提示')
})

test('scope options are derived from the sources actually found, never hardcoded', () => {
  // SPEC 约束 12：本机 ~/.dsh/skills(rank 400) 一度不存在、技能全在 ~/.agents/skills(rank 500)。
  // 若候选项写死一份「全局/项目」清单，用户会看到一个空的作用域，或看不到自己技能真正所在的
  // 那一级。所以候选项必须由**实际返回的 source 集合**派生。
  const internals = loadClientInternals()

  // 只发现 user-agents 时，就只有这一个候选项——不得凭空出现 user-dsh。
  const onlyAgents = internals.skillScopeOptions([skill({ source: 'user-agents' })])
  assert.deepEqual(list(onlyAgents).map((option) => option.source), ['user-agents'])
  assert.equal(onlyAgents[0].label.length > 0, true, '候选项要有可读标签')

  // 发现两个来源时都出现，且全局排在项目之前。
  const mixed = internals.skillScopeOptions([
    skill({ source: 'project-dsh', scope: 'project' }),
    skill({ source: 'user-agents' }),
  ])
  assert.deepEqual(list(mixed).map((option) => option.source), ['user-agents', 'project-dsh'])
  // 真实路径必须带出来（约束 12：按 source 显示其真实路径，不得假设某一级存在）。
  const projectOption = list(mixed).find((option) => option.source === 'project-dsh')
  assert.equal(projectOption.root, '/home/u/.agents/skills', '候选项要带真实根路径')
})

test('scope options carry a human label for every source the host can report', () => {
  // 宿主一共六级 source（SPEC 约束 2）。少一个标签就会在界面上显示成英文 key。
  const internals = loadClientInternals()
  for (const source of ['project-dsh', 'project-agents', 'custom', 'user-dsh', 'user-agents', 'bundled']) {
    const options = internals.skillScopeOptions([skill({ source })])
    assert.equal(options.length, 1, source + ' 应产生一个候选项')
    assert.equal(typeof options[0].label, 'string')
    assert.ok(options[0].label.length > 0, source + ' 缺可读标签')
    assert.doesNotMatch(options[0].label, /^[a-z-]+$/, source + ' 的标签看着还是英文 key：' + options[0].label)
  }
})

test('rows are keyed by name plus scope, not by name alone', () => {
  // SPEC 约束 D8：管理行按（名称 + 作用域）精确操作。同名跨作用域是**合法配置**，
  // 按名字去重会让用户只能看到一个副本，而启停/删除是精确作用到某一个根的。
  const internals = loadClientInternals()
  const rows = internals.skillRows([
    skill({ source: 'user-agents', root: '/u/.agents/skills' }),
    skill({ source: 'project-dsh', scope: 'project', root: '/p/.dsh/skills' }),
  ])
  assert.equal(rows.length, 2, '同名跨作用域必须各占一行')
  // 每行都要有稳定的 key（React 列表用），且两行不同。
  assert.equal(new Set(rows.map((row) => row.key)).size, 2, '两行的 key 必须不同')
})

test('shadowed entries are reported relative to the model-visible catalog', () => {
  // 「被遮蔽」提示是管理面板相对模型可见目录的独有价值：DSH 按 rank 裁决同名技能谁生效，
  // 被遮蔽的那份**模型收不到**，但用户确实装了它。必须能指出来，否则用户会以为改的是
  // 生效的那份。
  //
  // ⚠️ 方向由 **rank** 决定，不是数组位置：项目级(100/200) 优先于用户级(400/500)。
  // 这条用例原先断言 user-agents 遮蔽 project-agents——那是把缺陷写成了期望（真机报告
  // 指出方向相反，已复现）。所以这里刻意把 rank 更大的一份放在**前面**：按位置算会得到
  // 错的答案，按 rank 算才对。
  const internals = loadClientInternals()
  const rows = [
    skill({ source: 'user-agents', root: '/u/.agents/skills' }),
    skill({ source: 'project-dsh', scope: 'project', root: '/p/.dsh/skills' }),
  ]
  const shadowed = internals.shadowedSkills(rows)
  // 两个同名条目里恰有一个被遮蔽（不是两个、也不是零个）。
  assert.equal(shadowed.length, 1, '同名条目里应恰有一份被遮蔽')
  assert.equal(shadowed[0].name, 'zhanggui')
  // 被遮蔽的那份必须能指出**谁**遮蔽了它，否则用户不知道去看哪一行。
  assert.equal(shadowed[0].shadowedBy.source, 'project-dsh',
    '生效者是 rank 更小的那份（项目级 100 胜用户级 500），与它在数组里的位置无关')
  assert.equal(shadowed[0].source, 'user-agents', '被遮蔽的是 rank 更大的那份')
  assert.notEqual(shadowed[0].source, shadowed[0].shadowedBy.source)

  // 名字唯一时没有任何遮蔽。
  assert.equal(internals.shadowedSkills([skill()]).length, 0)

  // 已停用的行不参与：两个调用面都关掉了，模型和用户都看不到它，说它遮蔽/被遮蔽都是假的。
  const parked = { ...skill({ source: 'project-agents', scope: 'project' }), enabled: false }
  assert.equal(internals.shadowedSkills([skill(), parked]).length, 0,
    '已停用的行不该参与遮蔽判定（它根本没进模型目录）')
})

test('diagnostics are derived from the merged rows, so disabled skills actually show up', () => {
  // ⚠️ 首版这个函数收三个数组（disabled/illegal/blocked），而宿主只有一个 disabled 通道、
  // 调用方为了避免重复又把它清空 → 函数**恒返回空**，整块诊断 UI 是死的，而这条用例只测
  // 纯函数、看不见这件事（典型的假绿）。现在判据是行自己的 `enabled === false`。
  const internals = loadClientInternals()
  const merged = [
    { name: 'wewrite', source: 'user-agents', cwd: undefined, enabled: true, key: 'k1' },
    { name: 'hidden', source: 'user-agents', cwd: undefined, enabled: false, root: '/u/.agents/skills', key: 'k2' },
  ]
  const result = internals.skillDiagnostics(merged)
  assert.equal(result.length, 1, '只有已停用的行进诊断，正常行不进（避免噪音）')
  assert.equal(result[0].name, 'hidden')
  assert.equal(result[0].kind, 'disabled')
  assert.equal(result[0].root, '/u/.agents/skills', '诊断行要带上根，用户才知道它在哪一级')
  // 空输入不该凭空造条目（也钉住「不再有 illegal/blocked 那两个没有生产者的通道」）。
  // 注意逐字段/length 断言：返回值来自 vm 沙箱，跨 realm 的 deepEqual 会因原型不同而失败。
  assert.equal(internals.skillDiagnostics([]).length, 0)
  assert.equal(internals.skillDiagnostics(undefined).length, 0)
})

test('the skills pane receives a working call, all the way from the mount to the panel', () => {
  // ⚠️ 这条抓的是**第二个真机缺陷**（与「面板打不开」是两回事）：
  //   症状：面板能打开、MCP/技能 两个标签都在，但技能列表恒为「没有发现技能」。
  //   根因：`callSkills` 在 apply() 里被注入给 McpOverlay，但 McpOverlay 的**解构**漏了它
  //         （`({ call, timer, pluginManager })`），转发给 McpTab 时自然也没有；
  //         于是 McpTab 传给 SkillsPanel 的 `props.callSkills` 是 undefined，
  //         SkillsPanel 首次加载 `call('list', …)` 抛 `TypeError: call is not a function`。
  //   为什么既有用例抓不到：SkillsPanel 的用例**自己造了一个 call** 直接传进去，
  //         所以「上游有没有把 call 传下来」这段接线从来没有被验证过——
  //         典型的「每一段都测了，段与段之间没测」。
  //   真实代价：RPC 完全正常（宿主确实返回 12 个技能），面板却一个字都不显示，
  //         而且抛的是未捕获 promise，除控制台外毫无提示。
  const internals = loadClientInternals()

  const callMcp = async () => ({ ok: true, servers: [], revealRevision: '' })
  const callSkills = async () => ({ ok: true, skills: [], disabled: [] })

  // 面板必须处于打开状态，McpOverlay 才会渲染 McpTab 子树。
  internals.panelVisibility.set(true)
  const overlayTree = internals.__render(internals.McpOverlay, { call: callMcp, callSkills, timer: null, pluginManager: null })
  const tab = findNode(overlayTree, (node) => node.type === internals.McpTab)
  assert.ok(tab, '面板打开时 McpOverlay 必须渲染 McpTab（否则下面全是空转）')
  assert.equal(tab.props.callSkills, callSkills,
    'McpOverlay 必须把 callSkills 原样转发给 McpTab——漏掉它技能列表就永远是空的')

  // 切到技能面。ability 是 McpTab 内部 state；单击技能标签把 setter 置脏，
  // 再渲染一轮就会走 skills 分支——这正是真机上用户点「技能」时发生的事。
  const tabTree = internals.__render(internals.McpTab, tab.props)
  assert.ok(findNode(tabTree, (node) => node.type === internals.SkillsPanel) === undefined,
    '默认停在 MCP 面（还没点技能标签），此时不该有 SkillsPanel')

  const skillTab = findNode(tabTree, (node) => node?.props?.role === 'tab' && (node.children ?? []).includes('技能'))
  assert.ok(skillTab, '能力层必须有「技能」标签')
  skillTab.props.onClick()

  const skillsTree = internals.__render(internals.McpTab, tab.props)
  const panel = findNode(skillsTree, (node) => node.type === internals.SkillsPanel)
  assert.ok(panel, '点「技能」后必须渲染 SkillsPanel')
  assert.equal(typeof panel.props.call, 'function',
    'SkillsPanel 必须拿到可调用的 call；undefined 会让首次加载抛 TypeError，列表恒空')
  assert.notEqual(panel.props.call, callMcp,
    'SkillsPanel 的 call 必须打 skillsManager，不能复用 MCP 的 call（会静默少数据）')
})

test('both ability panes render inside the same floating shell', () => {
  // ⚠️ 这条抓的是**第三个真机缺陷**（视觉上最刺眼的一个）：
  //   症状：技能面板没有背景，页面其它内容（例如「设置 → 插件」）**直接透过来**糊成一片。
  //   根因：`.dsh-mcp-wrap` 只负责列布局与内边距——背景、圆角、阴影、遮罩、z-index
  //         全部来自 `.dsh-mcp-panel-overlay` / `.dsh-mcp-panel` 这两层外壳。
  //         MCP 面走了 `if (floating) return <overlay><panel>…`，而技能面在更上面
  //         **提前 return 了一个裸的 .dsh-mcp-wrap**，于是它被当成页面里的普通 div。
  //   为什么既有用例抓不到：所有断言都只看「数据/接线对不对」，没有一条看**外壳**。
  //         而真实代价恰恰是外壳：面板内容全在，却因为叠在正文上没有背景而不可读。
  //
  // 这条用例断言两个能力面的**出口结构一致**：都必须是
  // `.dsh-mcp-panel-overlay > .dsh-mcp-panel > .dsh-mcp-wrap`。
  const internals = loadClientInternals()
  const callMcp = async () => ({ ok: true, servers: [], revealRevision: '' })
  const callSkills = async () => ({ ok: true, skills: [], disabled: [] })
  const props = { call: callMcp, callSkills, timer: null, pluginManager: null, floating: true, onClose() {} }

  const hasShell = (tree) => {
    const overlay = findNode(tree, (node) => node?.props?.className === 'dsh-mcp-panel-overlay')
    if (overlay === undefined) return { overlay: false }
    const panel = findNode(overlay.children, (node) => node?.props?.className === 'dsh-mcp-panel')
    return { overlay: true, panel: panel !== undefined, wrap: panel !== undefined && findNode(panel.children, (node) => node?.props?.className === 'dsh-mcp-wrap') !== undefined }
  }

  // MCP 面（默认状态）。
  const mcpShell = hasShell(internals.__render(internals.McpTab, props))
  assert.deepEqual(mcpShell, { overlay: true, panel: true, wrap: true }, 'MCP 面必须包在悬浮外壳里')

  // 技能面：点「技能」标签后必须得到**同一个**外壳，而不是裸的 .dsh-mcp-wrap。
  internals.panelVisibility.set(true)
  const tabTree = internals.__render(internals.McpTab, props)
  const skillTab = findNode(tabTree, (node) => node?.props?.role === 'tab' && (node.children ?? []).includes('技能'))
  assert.ok(skillTab, '能力层必须有「技能」标签')
  skillTab.props.onClick()

  const skillsTree = internals.__render(internals.McpTab, props)
  assert.ok(findNode(skillsTree, (node) => node.type === internals.SkillsPanel), '技能面必须渲染 SkillsPanel')
  assert.deepEqual(hasShell(skillsTree), { overlay: true, panel: true, wrap: true },
    '技能面必须和 MCP 面用同一套悬浮外壳（裸返回 .dsh-mcp-wrap 会让面板没有背景、正文透过来）')
})

test('the ability layer is rendered once, by the shell, not again inside the skills pane', async () => {
  // ⚠️ 这条抓的是**第四个真机缺陷**：用户看到「两套 UI」——标题栏上并排出现
  //   `MCP | 技能 | 管理 | 市场`，其实那是**两个组件各自画的标签拼在一起**：
  //     · 外壳 McpTab 画能力层（MCP / 技能）——真正管切换的那一套
  //     · SkillsPanel 又画了一遍能力层，**外加**自己的模式层（管理 / 市场）
  //   而且内层那个「技能」是**死按钮**（它只对 mcp 转发 switched，点自己没有任何效果），
  //   用户点它会以为界面坏了。
  //   根因不是样式，是**同一个概念有了两个渲染者**——修法是让能力层只归外壳。
  const internals = loadClientInternals()
  const callMcp = async () => ({ ok: true, servers: [], revealRevision: '' })
  const callSkills = async () => ({ ok: true, skills: [], disabled: [] })
  const props = { call: callMcp, callSkills, timer: null, pluginManager: null, floating: true, onClose() {} }

  internals.panelVisibility.set(true)
  const tabTree = internals.__render(internals.McpTab, props)
  const skillTab = findNode(tabTree, (node) => node?.props?.role === 'tab' && (node.children ?? []).includes('技能'))
  assert.ok(skillTab, '能力层必须有「技能」标签')
  skillTab.props.onClick()
  const skillsTree = internals.__render(internals.McpTab, props)

  const labels = (tree) => {
    const out = []
    const visit = (node) => {
      if (!node || typeof node !== 'object') return
      if (Array.isArray(node)) { node.forEach(visit); return }
      const cls = typeof node.props?.className === 'string' ? node.props.className : ''
      // 子视图切换走 ScopeTabs（.dsh-mcp-tab）。两种形态都要认：
      //   · 展开前：组件节点上带 props.tabs（ScopeTabs 在无容器宽度时只渲染可见子集，
      //     从渲染结果读会漏，所以优先读定义）
      //   · 展开后：组件已被替换成它渲染出的 .dsh-mcp-tab 元素
      if (Array.isArray(node.props?.tabs)) for (const tab of node.props.tabs) out.push(tab.label)
      if (cls.includes('dsh-mcp-tab')) {
        const text = (node.children ?? []).filter((c) => typeof c === 'string').join('')
        if (text) out.push(text)
      }
      // 能力层与模式层都是分段控件里的普通按钮（.dsh-mcp-seg > .dsh-mcp-btn），
      // 标签是按钮的**字符串子节点**（计数是旁边一个元素，不参与）。两者都由外壳渲染，
      // 所以都在外壳这棵树上被收集到——收集口径按按钮走，不按容器走。
      if (cls.split(' ').includes('dsh-mcp-btn')) out.push((node.children ?? []).filter((c) => typeof c === 'string').join(''))
      visit(node.children)
    }
    visit(tree)
    return out
  }

  // 外壳这一层：能力层（MCP / 技能）与模式层（已安装 / 发现市场）各出现**一次**。
  // 注意假 React 不会展开子组件，所以 SkillsPanel 内部不在这棵树里——它单独验（下面一段）。
  const shellLabels = labels(skillsTree)
  assert.equal(shellLabels.filter((l) => l === '技能').length, 1,
    `「技能」只能由外壳渲染一次，实际 ${shellLabels.filter((l) => l === '技能').length} 次：${JSON.stringify(shellLabels)}`)
  assert.equal(shellLabels.filter((l) => l === 'MCP').length, 1,
    `「MCP」只能由外壳渲染一次，实际 ${shellLabels.filter((l) => l === 'MCP').length} 次（面板内不得再画一遍能力层）`)
  assert.deepEqual(shellLabels.filter((l) => l === '已安装' || l === '发现市场').sort(), ['发现市场', '已安装'],
    `模式层也必须由外壳渲染、且各一次，实际：${JSON.stringify(shellLabels)}`)

  // 技能面板这一层：**两层标签都不许有**。这是用户看到的「两套 UI」的根源——
  // 标题栏上并排出现 MCP | 技能 | 管理 | 市场，其中「技能」还是死按钮。
  // 现在能力层与模式层都只归外壳，面板只负责「技能面这具身体」。
  // 这里必须展开组件——否则 SkillsPanel 内部的内容在树里根本看不见，断言会空转。
  const panel = findNode(skillsTree, (node) => node.type === internals.SkillsPanel)
  const panelProps = { ...panel.props }
  // 首屏数据在 useEffect 里加载：先渲染并跑掉 effect，再重渲染，否则 rows 为空、
  // 列表行不出现，断言会在空列表上「通过」——那是假绿。
  internals.__effects.length = 0
  internals.__render(internals.SkillsPanel, panelProps)
  await flushEffects(internals)
  const panelTree = internals.__expand(internals.__render(internals.SkillsPanel, panelProps))
  const panelLabels = labels(panelTree)
  assert.deepEqual(panelLabels.filter((l) => ['技能', 'MCP', '已安装', '发现市场'].includes(l)), [],
    `技能面板内不得再画能力层或模式层（这就是「两套 UI」的来源），实际：${JSON.stringify(panelLabels)}`)
})

test('the header pins the close button outside the action column on both panes', async () => {
  // 用户的原话：「切换之后这个位置来回换位置，我感觉体验不好」。
  // 根因：关闭按钮原本住在 .dsh-mcp-head-actions 里，而那一列是 flex-end——
  // MCP 面 6 个按钮、技能面只有能力层 tab，一切面「关闭」就横移几百像素。
  // 现在标题栏是三列 grid：标题 | 操作区 | 关闭。关闭必须是 head 的**直接子元素**，
  // 且不得嵌在操作区里（嵌回去就会重新跟着按钮数量漂）。
  const internals = loadClientInternals()
  const callMcp = async () => ({ ok: true, servers: [], revealRevision: '' })
  const callSkills = async () => ({ ok: true, skills: [], disabled: [] })
  const props = { call: callMcp, callSkills, timer: null, pluginManager: null, floating: true, onClose() {} }

  const checkHead = (tree, pane) => {
    const head = findNode(tree, (node) => node?.props?.className === 'dsh-mcp-head')
    assert.ok(head, `${pane} 必须有 .dsh-mcp-head`)
    const kids = (head.children ?? []).filter(Boolean)
    const actions = kids.find((node) => node?.props?.className === 'dsh-mcp-head-actions')
    assert.ok(actions, `${pane} 标题栏要有操作区列`)
    const actionText = textOf(actions).join(' ')
    assert.ok(!actionText.includes('关闭'), `${pane} 的「关闭」不得留在操作区里（那会让它跟着按钮数量漂移）`)
    const close = kids.find((node) => textOf(node).join(' ').includes('关闭'))
    assert.ok(close, `${pane} 的「关闭」必须是标题栏的直接子元素`)
    assert.equal(kids.indexOf(close), kids.length - 1, `${pane} 的「关闭」要钉在最后一列`)
  }

  checkHead(internals.__render(internals.McpTab, props), 'MCP 面')

  internals.panelVisibility.set(true)
  const tabTree = internals.__render(internals.McpTab, props)
  const skillTab = findNode(tabTree, (node) => node?.props?.role === 'tab' && (node.children ?? []).includes('技能'))
  skillTab.props.onClick()
  checkHead(internals.__render(internals.McpTab, props), '技能面')
})

test('both ability panes share the same layout primitives, so switching does not relayout', async () => {
  // ⚠️ 这条抓的是用户明确指出的**交互一致性问题**：
  //   「切换应该切换的是功能，UI 布局啥的应该一样啊，你这样用户一切换换一套操作逻辑」
  //   原先技能面自己另起了一套布局（.dsh-skills-bar / -body / -list / -detail），
  //   MCP 面用的是 .dsh-mcp-head / -body / -side / -detail。结果一按「技能」，
  //   标题栏、切换器位置、左右栏容器、列表行样式**全部换掉**——控件位置和操作路径都变了。
  //
  // 现在两个能力面共用同一批布局原语。这条用例把「共用」钉住：
  // 技能面（管理模式）必须出现 .dsh-mcp-body / .dsh-mcp-side / .dsh-mcp-detail，
  // 且不得再出现自己那套 .dsh-skills-body / -list / -detail。
  const internals = loadClientInternals()
  const callSkills = async (method) => {
    return { ok: true, skills: [{ name: 'zhanggui', description: 'd', source: 'user-agents', scope: 'global', root: '/r', writable: true }], disabled: [] }
  }
  // 先渲染一次并**跑掉首屏 useEffect**（列表数据在 effect 里加载），再重渲染——
  // 否则 rows 还是空的，行级原语（.dsh-mcp-item）根本不会出现，断言会空转。
  internals.__effects.length = 0
  internals.__render(internals.SkillsPanel, { call: callSkills, workspaces: [], onClose() {}, floating: true })
  await flushEffects(internals)
  const tree = internals.__expand(internals.__render(internals.SkillsPanel, { call: callSkills, workspaces: [], onClose() {}, floating: true }))

  const classes = new Set()
  const visit = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(visit); return }
    if (typeof node.props?.className === 'string') for (const c of node.props.className.split(' ')) if (c) classes.add(c)
    visit(node.children)
  }
  visit(tree)

  for (const shared of ['dsh-mcp-body', 'dsh-mcp-side', 'dsh-mcp-detail', 'dsh-mcp-search', 'dsh-mcp-list', 'dsh-mcp-item']) {
    assert.ok(classes.has(shared), `技能面必须复用 MCP 的布局原语 ${shared}（否则切换能力层会整体换一套布局）`)
  }
  for (const private_ of ['dsh-skills-body', 'dsh-skills-list', 'dsh-skills-detail']) {
    assert.ok(!classes.has(private_), `技能面不得再保留自己的布局容器 ${private_}（两套布局正是「换一套操作逻辑」的来源）`)
  }
})

// ═══ 市场分页：上游有 19 万条，只取首页就是「数字与实物不符」═════════════════
// 真机实测 api.skillhub.cn（2026-10）：无关键词浏览 total=192936，且深页有货
// （page=2000 仍返回 48 条）。但面板的 searchHub 从不发 page 参数，于是永远停在第 1 页；
// 计数区同时把上游 total 渲染成「192936 条结果」——数字本身是真的，可用户在面板里
// 永远到不了另外 192888 条，看到的就是「显示 19 万、其实根本没有」。这一组把翻页钉住：
// 请求带 page 与 pageSize 上限、加载下一页追加且去重、换词重置、到头就不发。
const hubSkill = (slug, over = {}) => ({
  source: 'skillhub', slug, name: '技能-' + slug, summary: '', owner: '发布者',
  downloads: 1, stars: 0, installs: 0, verified: false, requiresApiKey: false,
  version: '1.0.0', pageUrl: 'https://skillhub.cn/skills/' + slug, ...over,
})

/** 市场（skillhub.cn 源）的假服务：按请求的页码发预设好的技能，total 由用例给。 */
function hubService({ total, pages }) {
  const searches = []
  const call = async (method, args) => {
    if (method === 'skillHubSearch') {
      searches.push(args)
      return { ok: true, total, skills: pages[(args?.page ?? 1) - 1] ?? [] }
    }
    if (method === 'skillHubCategories') return { ok: true, labels: {} }
    return { ok: true, skills: [] }
  }
  return { call, searches }
}

const hubCards = (tree) => collectAll(tree, (node) => typeof node?.props?.className === 'string'
  && node.props.className.split(' ').includes('dsh-mcp-mcard'))
const hubMoreBtn = (tree) => collectAll(tree, (node) => typeof node.props?.onClick === 'function'
  && textOf(node).join('').includes('加载更多'))[0]

test('市场搜索请求带 page 与 pageSize 上限：上游 19 万条，只取首页就是数字与实物不符', async () => {
  const internals = loadClientInternals()
  const { call, searches } = hubService({ total: 192936, pages: [[hubSkill('a')]] })
  const props = { call, workspaces: [], mode: 'market' }
  internals.__effects.length = 0
  internals.__render(internals.SkillsPanel, props)
  await flushEffects(internals)

  assert.equal(searches.length, 1, '挂载应发一次搜索')
  assert.equal(searches[0].page, 1, '请求必须显式带页码——不发 page 就永远停在上游第 1 页')
  assert.equal(searches[0].pageSize, 100, 'pageSize 用满上游上限 100：19 万条按 48 一页要翻 4019 页')
  // 计数必须说清「已显示 / 共」：只写总数，就是 19 万条结果旁边只摆 48 张卡。
  const tree = internals.__expand(internals.__render(internals.SkillsPanel, props))
  assert.ok(textOf(tree).some((text) => text.includes('已显示 1 / 共 192936 条')),
    `计数文案要与实物一致，实际：${JSON.stringify(textOf(tree).filter((t) => t.includes('条')))}`)
})

test('上游同一页内就会返回重复 slug：条目按 slug 全局去重，React key 不撞车', async () => {
  // 真机证据（2026-10 隔离宿主实测）：api.skillhub.cn 第 1 页（pageSize=100,
  // sortBy=downloads）返回 100 条、只有 88 个不同 slug——agent-browser / anti-fraud
  // 各出现 3 次（同一技能被不同发布者重复发布）。只按「跨页」去重挡不住页内重复：
  // 重复 key 进 React 后 reconciliation 错乱，真机表现是 297 张卡 vs 计数 285、
  // 卡片越滚越多、搜索像没生效。所以去重必须是全局的（跨页 + 页内）。
  const internals = loadClientInternals()
  const { call } = hubService({ total: 500, pages: [[hubSkill('a'), hubSkill('b'), hubSkill('a')]] })
  const props = { call, workspaces: [], mode: 'market' }
  internals.__effects.length = 0
  internals.__render(internals.SkillsPanel, props)
  await flushEffects(internals)
  const tree = internals.__expand(internals.__render(internals.SkillsPanel, props))
  assert.equal(hubCards(tree).length, 2, '首页内部的重复 slug 也要去重')
  assert.ok(textOf(tree).some((text) => text.includes('已显示 2 / 共 500 条')),
    '计数必须与去重后的实物一致')
})

test('加载更多：page 递增、追加渲染、按 slug 去重', async () => {
  const internals = loadClientInternals()
  const { call, searches } = hubService({
    total: 3,
    pages: [
      [hubSkill('s1')],
      // 第 2 页掺两种重复：s1 是跨页重复（第 1 页已有）、s2 在页内出现两次。
      // 上游按下载量排序，两次请求之间排名会漂，同一页内也有重复发布者。
      [hubSkill('s2'), hubSkill('s1'), hubSkill('s2')],
    ],
  })
  const props = { call, workspaces: [], mode: 'market' }
  internals.__effects.length = 0
  internals.__render(internals.SkillsPanel, props)
  await flushEffects(internals)

  const first = internals.__expand(internals.__render(internals.SkillsPanel, props))
  assert.equal(hubCards(first).length, 1, '第 1 页只渲染 1 张卡')
  const more = hubMoreBtn(first)
  assert.ok(more, '还有更多时市场底部要有「加载更多」入口（滚动到底自动加载的兜底，也是沙箱里唯一可测的路径）')
  more.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))

  const second = internals.__expand(internals.__render(internals.SkillsPanel, props))
  assert.deepEqual(searches.map((search) => search.page), [1, 2], '第二次搜索必须带 page=2')
  assert.equal(hubCards(second).length, 2, '第 2 页追加渲染；掺进来的第 1 页 slug 必须去重（否则卡片重复、React key 撞车）')
})

test('换关键字重置回第 1 页：新结果整体替换，不叠加旧页', async () => {
  const internals = loadClientInternals()
  const { call, searches } = hubService({
    total: 5,
    pages: [[hubSkill('s1')], [hubSkill('s2'), hubSkill('s3')], [hubSkill('never')]],
  })
  const props = { call, workspaces: [], mode: 'market' }
  internals.__effects.length = 0
  internals.__render(internals.SkillsPanel, props)
  await flushEffects(internals)

  let tree = internals.__expand(internals.__render(internals.SkillsPanel, props))
  assert.ok(hubMoreBtn(tree), '先加载一页「更多」需要市场底部有加载更多入口')
  hubMoreBtn(tree).props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  tree = internals.__expand(internals.__render(internals.SkillsPanel, props))
  assert.equal(hubCards(tree).length, 3, '追加后应有 3 张卡')

  // 提交新关键字（草稿 → 回车）：搜索必须重置到第 1 页并整体替换。
  const findInput = (t) => collectAll(t, (node) => node.props?.placeholder === '搜索 skillhub.cn（回车）')[0]
  findInput(tree).props.onChange({ target: { value: 'pdf' } })
  // 假 React 不自动重渲染：击键后补一次渲染，回车闭包拿到的才是新草稿
  // （真 React 里每次击键都重渲染，这一步是隐含的）。
  findInput(internals.__render(internals.SkillsPanel, props)).props.onKeyDown({ key: 'Enter' })
  // 清空积压的 effect 再重渲染：假 React 不比较依赖，每次渲染都会把全部 effect
  // 重新入队；不清就会把前几轮渲染攒下的 searchHub 一起跑掉（真 React 靠依赖比较
  // 只会跑新关键字的那一次）。
  internals.__effects.length = 0
  internals.__render(internals.SkillsPanel, props)
  await flushEffects(internals)
  tree = internals.__expand(internals.__render(internals.SkillsPanel, props))

  assert.deepEqual(searches.map((search) => search.page), [1, 2, 1], '换关键字后必须重新从第 1 页搜')
  assert.equal(searches[2].keyword, 'pdf', '提交的关键字要带到请求里')
  assert.equal(hubCards(tree).length, 1, '新搜索结果整体替换，旧页数据不得残留')
})

test('加载更多失败：保留已加载页面，错误与重试落在结果区', async () => {
  // 追加失败是翻页引入的新失败面：首屏失败的摆法（错误替换整个结果区）照搬过来，
  // 一次上游抖动就会把用户已翻的几百张卡全部清空——比原来的 bug 更难用。
  const internals = loadClientInternals()
  const call = async (method, args) => {
    if (method === 'skillHubSearch') {
      if (args.page === 2) return { ok: false, error: '连接 skillhub.cn 失败：请求超时' }
      return { ok: true, total: 5, skills: [hubSkill('s' + args.page)] }
    }
    if (method === 'skillHubCategories') return { ok: true, labels: {} }
    return { ok: true, skills: [] }
  }
  const props = { call, workspaces: [], mode: 'market' }
  internals.__effects.length = 0
  internals.__render(internals.SkillsPanel, props)
  await flushEffects(internals)

  const first = internals.__expand(internals.__render(internals.SkillsPanel, props))
  hubMoreBtn(first).props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const tree = internals.__expand(internals.__render(internals.SkillsPanel, props))

  assert.equal(hubCards(tree).length, 1, '加载更多失败不得清空已加载的页面')
  const failure = collectAll(tree, (node) => textOf(node).join('').includes('加载更多失败'))[0]
  assert.ok(failure, '失败要可见，且说清是「加载更多」这一步失败')
  assert.ok(textOf(tree).some((text) => text.includes('连接 skillhub.cn 失败：请求超时')),
    '上游给的错误原文要摆出来（用户要靠它判断下一步）')
})

test('到底之后不再发请求：没有更多时不给加载更多入口', async () => {
  const internals = loadClientInternals()
  const { call, searches } = hubService({ total: 2, pages: [[hubSkill('s1'), hubSkill('s2')]] })
  const props = { call, workspaces: [], mode: 'market' }
  internals.__effects.length = 0
  internals.__render(internals.SkillsPanel, props)
  await flushEffects(internals)
  const tree = internals.__expand(internals.__render(internals.SkillsPanel, props))

  assert.equal(hubCards(tree).length, 2)
  assert.equal(hubMoreBtn(tree), undefined, 'items 已达 total 时不得再给「加载更多」入口')
  assert.equal(searches.length, 1, '没有更多时不得再发请求')
  assert.ok(textOf(tree).some((text) => text.includes('已显示 2 / 共 2 条')),
    `计数文案要与实物一致，实际：${JSON.stringify(textOf(tree).filter((t) => t.includes('条')))}`)
})
