// 工具页（第三个能力面）的面板侧行为。
//
// 四条要钉的约束，全部来自真实使用反馈：
//   ① 只有两态：常驻 / 按需。没有「继承」——工具页只管全局，没有上一层可跟随。
//   ② 不出现 MCP：服务器的启停与延迟在 MCP 页面，这里再列一遍就是同一件事两个入口。
//   ③ 没有作用域切换：内置与其他插件工具在每个项目里都是同一批宿主工具。
//   ④ 受保护的工具（搜索入口）不进列表；工具名用宿主原名，中文短名只做标记。
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const clientSource = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const exportMarker = 'exports.inject = inject;'
const instrumentedClient = clientSource.replace(
  exportMarker,
  `${exportMarker}\nexports.__settingsPanel = { HintMarker, Toggle, Btn, ToolLoadingModal };`,
)
assert.notEqual(instrumentedClient, clientSource, 'client test export marker must stay current')

function loadInternals() {
  const stores = new Map()
  let current = null
  const react = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      const rest = props ?? {}
      return {
        type,
        props: children.length === 0 ? rest : { ...rest, children: children.length === 1 ? children[0] : children },
        children,
      }
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
  return {
    ...client.__settingsPanel,
    __render: react.__render,
    __drainEffects() { for (const effect of react.__effects.splice(0)) effect() },
  }
}

function collectAll(tree, predicate, out = []) {
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

async function openModal(internals, call, props = {}) {
  const base = { open: true, onClose: () => {}, call, onSaved: () => {}, ...props }
  internals.__render(internals.ToolLoadingModal, base)
  internals.__drainEffects()
  await new Promise((resolve) => setTimeout(resolve, 0))
  return internals.__render(internals.ToolLoadingModal, base)
}

const TOOLS = [
  { name: 'working_directory', owner: null, kind: 'builtin', description: 'Read the current working directory', protected: false, policy: 'resident', reason: 'default-resident' },
  { name: 'tool_search', owner: null, kind: 'builtin', description: 'Search deferred MCP tools', protected: true, policy: 'resident', reason: 'protected' },
  { name: 'mcp__alpha__a', owner: 'alpha', kind: 'mcp', description: 'Alpha: take a screenshot', protected: false, policy: 'deferred', reason: 'legacy-defer' },
  { name: 'mcp__alpha__b', owner: 'alpha', kind: 'mcp', description: 'Alpha: click', protected: false, policy: 'resident', reason: 'default-resident' },
]

const SETTINGS = {
  ok: true,
  policy: { groups: {}, tools: {} },
  tools: TOOLS,
  configKey: 'toolLoading',
}


test('工具加载面板：关闭时不渲染任何东西', () => {
  const internals = loadInternals()
  assert.equal(internals.__render(internals.ToolLoadingModal, { open: false, onClose: () => {}, call: async () => SETTINGS }), null)
})

test('工具加载面板：只有常驻/按需两态，没有继承、模式或全局开关', async () => {
  const internals = loadInternals()
  const tree = await openModal(internals, async (method) => (method === 'toolSearchSettings' ? { ok: true, settings: { maxResults: 10, maxDiscovered: 20 } } : SETTINGS), { inline: true })
  const text = allText(tree)
  assert.equal(text.includes('继承'), false, '工具页只管全局，没有上一层可继承')
  assert.equal(text.includes('跟随全局'), false, '不存在项目层，也就没有“跟随全局”')
  assert.equal(collectAll(tree, (node) => node.type === 'input' && node.props?.type === 'radio').length, 0, '没有模式单选')
  // 选择控件是行内的常驻/按需分段按钮，不是下拉：每行一对，选项文案各出现一次。
  assert.equal(collectAll(tree, (node) => node.type === 'select').length, 0, '工具页不再有下拉')
  const picks = collectAll(tree, (node) => node.props?.className === 'dsh-mcp-tool-pick')
  assert.ok(picks.length >= 1, '行内分段按钮存在')
  assert.deepEqual(picks[0].children.map((button) => button.children?.[0]), ['常驻', '按需'])
  assert.ok(picks[0].children.every((button) => typeof button.props?.['aria-pressed'] === 'boolean'),
    '两个选项都以 aria-pressed 表达选中态')
  assert.equal(collectAll(tree, (node) => node.type === internals.Toggle).length, 1, '唯一的开关是参数区的「限制目录大小」')
})

// 规格变更（真机发现）：这张表原来按 `kind === 'mcp'` 把 MCP 行整类排除，理由是"MCP 的开关在
// MCP 页面"。统一策略落地后这个前提不成立了：MCP 页那颗芯片读的是旧的服务器级 `defer`，
// 组级/单工具的延迟在那儿既看不见也改不了，于是被延迟的 MCP 工具在工具页消失、计数显示 0 按需，
// 而 MCP 页还说"全量"——两处都不报错，实际状态是错的。
// 新不变量：**这张表是每个工具实际加载策略的唯一展示面**（受保护项除外），计数从同一份 rows 派生。
test('工具加载面板：列出全部可设置工具（含 MCP），计数与行同源', async () => {
  const internals = loadInternals()
  const tree = await openModal(internals, async () => SETTINGS, { inline: true })
  const text = allText(tree)
  assert.ok(text.includes('working_directory'), '工具名按宿主原名显示')
  assert.ok(text.includes('切换工作目录'), '中文短名作为说明标记一并显示')
  assert.ok(text.includes('mcp__alpha__a'), 'MCP 工具必须出现在这张表里，否则它的真实策略没有展示面')
  assert.ok(text.includes('mcp__alpha__b'), '常驻的 MCP 工具同样要出现')
  assert.ok(text.includes('受保护'), '受保护的工具应有一句说明')
  // 可编辑行 = 带常驻/按需分段的行：working_directory + 两个 MCP 工具。
  const picks = collectAll(tree, (node) => node.props?.className === 'dsh-mcp-tool-pick')
  assert.equal(picks.length, 3, '可设置项 = 全部非受保护工具（内置 + MCP）')
  assert.equal(String(picks[0].props['aria-label'] ?? '').includes('tool_search'), false,
    '受保护的工具不能被编辑')
  // 计数从同一份 rows 派生：3 可设置 = 2 常驻 + 1 按需，另有 1 受保护。
  const numbers = collectAll(tree, (node) => node.props?.className === 'dsh-mcp-tool-stat-value').map((node) => String(node.props.children))
  assert.deepEqual(numbers, ['3', '2', '1', '1'], '概览条必须与列表同源：可设置/常驻/按需/受保护')
})

test('工具加载面板：保存只改全局逐工具选择，不接管 MCP 的开关', async () => {
  const internals = loadInternals()
  const sent = []
  const call = async (method, payload) => {
    if (method === 'toolLoadingSettings') return SETTINGS
    if (method === 'toolSearchSettings') return { ok: true, settings: { maxResults: 10, maxDiscovered: 20 } }
    sent.push([method, payload])
    return { ok: true, policy: SETTINGS.policy }
  }
  const base = { open: true, inline: true, onClose: () => {}, call, onSaved: () => {} }
  internals.__render(internals.ToolLoadingModal, base)
  internals.__drainEffects()
  await new Promise((resolve) => setTimeout(resolve, 0))
  let tree = internals.__render(internals.ToolLoadingModal, base)
  const pick = collectAll(tree, (node) => node.props?.className === 'dsh-mcp-tool-pick')[0]
  const deferredButton = collectAll(pick, (node) => node.type === 'button' && node.children?.[0] === '按需')[0]
  deferredButton.props.onClick()
  tree = internals.__render(internals.ToolLoadingModal, base)
  assert.ok(collectAll(tree, (node) => typeof node.props?.className === 'string' && node.props.className.includes('is-changed')).length >= 1,
    '改动行高亮，与底栏的改动计数互相印证')
  await collectAll(tree, (node) => node.props?.cls === 'primary')[0].props.onClick()
  assert.equal(sent.length, 1, '参数没改就只发一次工具策略写入')
  assert.equal(sent[0][0], 'updateToolLoadingSettings', '工具页永远写全局；项目层的接口不再有 UI 入口')
  assert.deepEqual(JSON.parse(JSON.stringify(sent[0][1])), { policy: { groups: {}, tools: { working_directory: 'deferred' } } })
  assert.equal(sent.some(([method]) => method.startsWith('setWorkspace')), false)
})

test('工具加载面板：只有工具列表进入滚动区，参数与概览固定在上方', async () => {
  const internals = loadInternals()
  const tree = await openModal(internals, async (method) => (method === 'toolSearchSettings' ? { ok: true, settings: { maxResults: 10, maxDiscovered: 20 } } : SETTINGS), { inline: true })
  const fixed = collectAll(tree, (node) => node.props?.className === 'dsh-mcp-tool-fixed')[0]
  const scroll = collectAll(tree, (node) => node.props?.className === 'dsh-mcp-tool-scroll')[0]
  assert.ok(fixed && scroll, '固定区与滚动区必须同时存在')
  assert.equal(collectAll(scroll, (node) => node.props?.className === 'dsh-mcp-tool-list').length, 1,
    '工具列表必须真的落在滚动区里，不能留在固定区把滚动容器挤成零高')
  assert.equal(collectAll(fixed, (node) => node.props?.className === 'dsh-mcp-tool-list').length, 0,
    '固定区不得再包含工具列表')
  assert.ok(collectAll(fixed, (node) => node.props?.className === 'dsh-mcp-tool-params').length === 1,
    '搜索参数固定在顶部')
  assert.ok(collectAll(fixed, (node) => node.props?.className === 'dsh-mcp-tool-overview').length === 1,
    '数量统计固定在顶部')
  const sections = collectAll(fixed, (node) => ['dsh-mcp-tool-params', 'dsh-mcp-tool-overview', 'dsh-mcp-tool-toolbar'].includes(node.props?.className))
  assert.deepEqual(sections.map((node) => node.props.className), ['dsh-mcp-tool-params', 'dsh-mcp-tool-overview', 'dsh-mcp-tool-toolbar'],
    '顺序来自用户要求：搜索参数在统计上方，筛选在统计下方')
})

test('工具加载面板：宿主报错留在表单里', async () => {
  const internals = loadInternals()
  const call = async (method) => (method === 'toolLoadingSettings' ? SETTINGS : { ok: false, error: 'mode 只能是 recommended / all-resident' })
  const tree = await openModal(internals, call, { inline: true })
  await collectAll(tree, (node) => node.props?.cls === 'primary')[0].props.onClick()
  const after = internals.__render(internals.ToolLoadingModal, { open: true, inline: true, onClose: () => {}, call, onSaved: () => {} })
  assert.ok(allText(after).includes('mode 只能是 recommended / all-resident'))
})

test('工具加载面板：全局页的搜索参数可编辑且与策略统一保存', async () => {
  const internals = loadInternals()
  const calls = []
  const call = async (method, payload) => {
    calls.push([method, payload])
    if (method === 'toolLoadingSettings') return SETTINGS
    if (method === 'toolSearchSettings') return { ok: true, settings: { maxResults: 10, maxDiscovered: 20 } }
    return { ok: true, settings: { maxResults: 12 }, policy: SETTINGS.policy }
  }
  const tree = await openModal(internals, call, { inline: true })
  const numberInputs = collectAll(tree, (node) => node.type === 'input' && node.props?.type === 'number')
  assert.ok(numberInputs.length > 0)
  assert.equal(numberInputs.every((input) => input.props.disabled === false), true, '全局页参数可编辑')
  numberInputs[0].props.onChange({ target: { value: '12' } })
  const after = internals.__render(internals.ToolLoadingModal, { open: true, inline: true, onClose: () => {}, call, onSaved: () => {} })
  // 统一保存按钮：只写发生改动的配置，参数与策略仍使用各自的 RPC。
  const saveBtn = collectAll(after, (node) => node.type === internals.Btn && node.props.cls === 'primary')[0]
  assert.ok(saveBtn, '保存按钮存在')
  assert.equal(saveBtn.props.disabled, false, '参数有改动时保存按钮可用')
  await saveBtn.props.onClick()
  assert.ok(calls.some(([method]) => method === 'updateToolSearchSettings'), '参数走自己的保存接口')
  assert.equal(calls.some(([method]) => method === 'updateToolLoadingSettings'), false, '策略未改动时不写')
})

test('工具加载面板：放弃修改同时恢复工具和搜索参数', async () => {
  const internals = loadInternals()
  const call = async (method) => method === 'toolSearchSettings'
    ? { ok: true, settings: { maxResults: 10, maxDiscovered: 20 } } : SETTINGS
  const props = { open: true, inline: true, call, onClose() {}, onSaved() {} }
  let tree = await openModal(internals, call, props)
  const input = collectAll(tree, (node) => node.type === 'input' && node.props.type === 'number')[0]
  input.props.onChange({ target: { value: '12' } })
  tree = internals.__render(internals.ToolLoadingModal, props)
  const discard = collectAll(tree, (node) => node.type === internals.Btn && node.props.children === '放弃修改')[0]
  assert.ok(discard, '只改参数也必须能放弃修改')
  discard.props.onClick()
  tree = internals.__render(internals.ToolLoadingModal, props)
  assert.equal(collectAll(tree, (node) => node.type === 'input' && node.props.type === 'number')[0].props.value, 10)
  assert.equal(collectAll(tree, (node) => node.type === internals.Btn && node.props.cls === 'primary')[0].props.disabled, true)
})

test('工具加载面板：参数无效时先报错，工具策略也不能先落盘', async () => {
  const internals = loadInternals()
  const writes = []
  const call = async (method, payload) => {
    if (method === 'toolLoadingSettings') return SETTINGS
    if (method === 'toolSearchSettings') return { ok: true, settings: { maxResults: 10, maxDiscovered: 20 } }
    writes.push([method, payload])
    return { ok: true, policy: SETTINGS.policy }
  }
  const props = { open: true, inline: true, call, onClose() {}, onSaved() {} }
  let tree = await openModal(internals, call, props)
  collectAll(tree, (node) => node.props?.className === 'dsh-mcp-tool-pick')[0].children[1].props.onClick()
  collectAll(tree, (node) => node.type === 'input' && node.props.type === 'number')[0].props.onChange({ target: { value: '1.5' } })
  tree = internals.__render(internals.ToolLoadingModal, props)
  await collectAll(tree, (node) => node.type === internals.Btn && node.props.cls === 'primary')[0].props.onClick()
  assert.equal(writes.length, 0, '所有本地输入先通过校验，再写任一配置')
  tree = internals.__render(internals.ToolLoadingModal, props)
  assert.match(allText(tree), /正整数/)
})
