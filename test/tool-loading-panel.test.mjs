// 工具页（第三个能力面）的面板侧行为。
//
// 四条要钉的约束：
//   ① 逐工具三态：跟随来源（服务器/宿主默认/全局）/ 常驻 / 按需；“跟随”= 删覆盖键，可逆。
//   ② 内置工具按用途分组排前，MCP 按服务器分组排后；整台默认只读，写入口在 MCP 页芯片。
//   ③ 全局与项目作用域分别读写：项目只写自己的 toolLoading，搜索参数是全局配置。
//   ④ 受保护的工具（搜索入口）不进列表；工具名用宿主原名，中文短名只做标记。
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const clientSource = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const exportMarker = 'exports.inject = inject;'
const instrumentedClient = clientSource.replace(
  exportMarker,
  `${exportMarker}\nexports.__settingsPanel = { HintMarker, Toggle, Btn, ToolLoadingModal, BUILTIN_LABELS, BUILTIN_CATEGORY };`,
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

/** 展开一个分组（默认全部收起）：按组头文本找，点一下再重渲染。 */
function expandGroup(internals, props, label) {
  const tree = internals.__render(internals.ToolLoadingModal, props)
  const toggle = collectAll(tree, (node) => node.props?.className === 'dsh-mcp-tool-group-toggle')
    .find((node) => allText(node).includes(label))
  assert.ok(toggle, `找不到分组：${label}`)
  toggle.props.onClick()
  return internals.__render(internals.ToolLoadingModal, props)
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
  groups: [{ owner: 'alpha', configured: 'inherit', inherited: 'deferred' }],
  tools: TOOLS,
  configKey: 'toolLoading',
}


test('工具加载面板：关闭时不渲染任何东西', () => {
  const internals = loadInternals()
  assert.equal(internals.__render(internals.ToolLoadingModal, { open: false, onClose: () => {}, call: async () => SETTINGS }), null)
})

test('工具加载面板：逐工具三态（跟随来源/常驻/按需），组头只读显示整台默认', async () => {
  const internals = loadInternals()
  const call = async (method) => (method === 'toolSearchSettings' ? { ok: true, settings: { maxResults: 10, maxDiscovered: 20 } } : SETTINGS)
  const props = { open: true, inline: true, onClose: () => {}, call, onSaved: () => {} }
  let tree = await openModal(internals, call, props)
  const headers = allText(tree)
  assert.ok(headers.includes('MCP 服务器'), 'MCP 必须是一个独立的顶层分区，不能和内置混在一起')
  assert.ok(headers.includes('内置工具（按用途）'), '内置工具必须单独一个分区，并按用途再分组')
  assert.ok(headers.includes('文件'), '内置分区里必须有用途分类（文件/命令/网络…）')
  assert.equal(collectAll(tree, (node) => node.type === 'select').length, 0, '工具页不再有下拉')
  // 默认全部收起；展开“文件”后才看得到行内三态。
  tree = expandGroup(internals, props, '文件')
  const picks = collectAll(tree, (node) => typeof node.props?.className === 'string' && node.props.className.includes('dsh-mcp-tool-pick'))
  assert.ok(picks.length >= 1, '展开分类后必须有行内三态')
  const rowPick = picks.find((node) => String(node.props['aria-label'] || '').includes(' · 加载方式'))
  assert.ok(rowPick, '行内三态的分段控件存在')
  assert.deepEqual(rowPick.children.map((button) => button.children?.[0]), ['宿主默认（常驻）', '常驻', '按需'])
  assert.ok(rowPick.children.every((button) => typeof button.props?.['aria-pressed'] === 'boolean'),
    '三个选项都以 aria-pressed 表达选中态')
  // 整台默认只在组头上**只读**显示，写入口是 MCP 列表的芯片——这里没有第二个三态控件。
  assert.ok(allText(tree).includes('整台：按需（未单独设置）'), '组头要显示整台默认及其来源（未单独设置）')
  assert.equal(picks.filter((node) => String(node.props['aria-label'] || '').includes('整台默认')).length, 0,
    '工具页不得再出现整台默认的写入口')
})

// 规格变更（真机发现）：这张表原来按 `kind === 'mcp'` 把 MCP 行整类排除，理由是"MCP 的开关在
// MCP 页面"。统一策略落地后这个前提不成立了：MCP 页那颗芯片读的是旧的服务器级 `defer`，
// 组级/单工具的延迟在那儿既看不见也改不了，于是被延迟的 MCP 工具在工具页消失、计数显示 0 按需，
// 而 MCP 页还说"全量"——两处都不报错，实际状态是错的。
// 新不变量：**这张表是每个工具实际加载策略的唯一展示面**（受保护项除外），计数从同一份 rows 派生。
test('工具加载面板：列出全部可设置工具（含 MCP），计数与行同源', async () => {
  const internals = loadInternals()
  const call = async (method) => (method === 'toolSearchSettings' ? { ok: true, settings: { maxResults: 10, maxDiscovered: 20 } } : SETTINGS)
  const props = { open: true, inline: true, onClose: () => {}, call, onSaved: () => {} }
  let tree = await openModal(internals, call, props)
  // 默认全部收起；展开内置的“文件”和 MCP 的 alpha 后才看得到行。
  tree = expandGroup(internals, props, '文件')
  tree = expandGroup(internals, props, 'alpha')
  const text = allText(tree)
  assert.ok(text.includes('working_directory'), '工具名按宿主原名显示')
  assert.ok(text.includes('切换工作目录'), '中文短名作为说明标记一并显示')
  assert.ok(text.includes('mcp__alpha__a'), 'MCP 工具必须出现在这张表里，否则它的真实策略没有展示面')
  assert.ok(text.includes('mcp__alpha__b'), '常驻的 MCP 工具同样要出现')
  assert.ok(text.includes('受保护'), '受保护的工具应有一句说明')
  // 可编辑行 = 带三态分段的行：working_directory + 两个 MCP 工具。组头也有分段控件，不计入。
  const picks = collectAll(tree, (node) => typeof node.props?.className === 'string' && node.props.className.includes('dsh-mcp-tool-pick'))
    .filter((node) => String(node.props['aria-label'] || '').includes(' · 加载方式'))
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
  // 默认全部收起：先展开内置的“文件”分类才有行内三态。
  tree = expandGroup(internals, base, '文件')
  const pick = collectAll(tree, (node) => typeof node.props?.className === 'string' && node.props.className.includes('dsh-mcp-tool-pick'))
    .find((node) => String(node.props['aria-label'] || '').includes(' · 加载方式'))
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

test('工具加载面板：搜索参数固定在顶部可见，只有列表滚动', async () => {
  const internals = loadInternals()
  const call = async (method) => (method === 'toolSearchSettings' ? { ok: true, settings: { maxResults: 10, maxDiscovered: 20 } } : SETTINGS)
  const props = { open: true, inline: true, onClose: () => {}, call, onSaved: () => {} }
  const tree = await openModal(internals, call, props)
  const fixed = collectAll(tree, (node) => node.props?.className === 'dsh-mcp-tool-fixed')[0]
  const scroll = collectAll(tree, (node) => node.props?.className === 'dsh-mcp-tool-scroll')[0]
  assert.ok(fixed && scroll, '固定区与滚动区必须同时存在')
  assert.equal(collectAll(scroll, (node) => node.props?.className === 'dsh-mcp-tool-groups').length, 1,
    '工具分组必须真的落在滚动区里，不能留在固定区把滚动容器挤成零高')
  assert.equal(collectAll(fixed, (node) => node.props?.className === 'dsh-mcp-tool-groups').length, 0,
    '固定区不得再包含工具列表')
  // 搜索参数是 ToolSearch 的核心配置，用户明确要求放在最上面、默认可见。
  assert.equal(collectAll(fixed, (node) => node.props?.className === 'dsh-mcp-tool-params').length, 1,
    '搜索参数必须固定在顶部可见')
  assert.equal(collectAll(scroll, (node) => node.props?.className === 'dsh-mcp-tool-params').length, 0,
    '搜索参数不得藏进滚动区')
  const sections = collectAll(fixed, (node) => ['dsh-mcp-tool-params', 'dsh-mcp-tool-overview', 'dsh-mcp-tool-toolbar'].includes(node.props?.className))
  assert.deepEqual(sections.map((node) => node.props.className), ['dsh-mcp-tool-params', 'dsh-mcp-tool-overview', 'dsh-mcp-tool-toolbar'],
    '固定区顺序：搜索设置 → 概览 → 筛选')
})

test('工具加载面板：宿主报错留在表单里', async () => {
  const internals = loadInternals()
  const call = async (method) => {
    if (method === 'toolLoadingSettings') return SETTINGS
    if (method === 'toolSearchSettings') return { ok: true, settings: { maxResults: 10, maxDiscovered: 20 } }
    return { ok: false, error: 'mode 只能是 recommended / all-resident' }
  }
  const props = { open: true, inline: true, onClose: () => {}, call, onSaved: () => {} }
  let tree = await openModal(internals, call, props)
  // 先制造一个改动，否则保存按钮是禁用的；默认收起，先展开“文件”分类。
  tree = expandGroup(internals, props, '文件')
  const rowPick = collectAll(tree, (node) => typeof node.props?.className === 'string' && node.props.className.includes('dsh-mcp-tool-pick'))
    .find((node) => String(node.props['aria-label'] || '').includes(' · 加载方式'))
  collectAll(rowPick, (node) => node.type === 'button' && node.children?.[0] === '常驻')[0].props.onClick()
  tree = internals.__render(internals.ToolLoadingModal, props)
  await collectAll(tree, (node) => node.props?.cls === 'primary')[0].props.onClick()
  const after = internals.__render(internals.ToolLoadingModal, props)
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
  const props = { open: true, inline: true, onClose: () => {}, call, onSaved: () => {} }
  let tree = await openModal(internals, call, props)
  // 搜索参数固定在顶部、默认可见（不再折叠）。
  const numberInputs = collectAll(tree, (node) => node.type === 'input' && node.props?.type === 'number')
  assert.ok(numberInputs.length >= 3, '目录上限输入框即使开关关着也必须渲染（置灰保留，不卸载）')
  assert.equal(numberInputs.slice(0, 2).every((input) => input.props.disabled === false), true, '全局页参数可编辑')
  assert.equal(numberInputs[2].props.disabled, true, '目录上限开关默认关闭时该框置灰')
  numberInputs[0].props.onChange({ target: { value: '12' } })
  const after = internals.__render(internals.ToolLoadingModal, props)
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
  tree = expandGroup(internals, props, '文件')
  const rowPick = collectAll(tree, (node) => typeof node.props?.className === 'string' && node.props.className.includes('dsh-mcp-tool-pick'))
    .find((node) => String(node.props['aria-label'] || '').includes(' · 加载方式'))
  collectAll(rowPick, (node) => node.type === 'button' && node.children?.[0] === '常驻')[0].props.onClick()
  collectAll(tree, (node) => node.type === 'input' && node.props.type === 'number')[0].props.onChange({ target: { value: '1.5' } })
  tree = internals.__render(internals.ToolLoadingModal, props)
  await collectAll(tree, (node) => node.type === internals.Btn && node.props.cls === 'primary')[0].props.onClick()
  assert.equal(writes.length, 0, '所有本地输入先通过校验，再写任一配置')
  tree = internals.__render(internals.ToolLoadingModal, props)
  assert.match(allText(tree), /正整数/)
})

test('工具加载面板：组头只读显示整台默认，写入口只有 MCP 芯片', async () => {
  const internals = loadInternals()
  const call = async (method) => (method === 'toolSearchSettings' ? { ok: true, settings: { maxResults: 10, maxDiscovered: 20 } } : SETTINGS)
  const props = { open: true, inline: true, onClose: () => {}, call, onSaved: () => {} }
  const tree = await openModal(internals, call, props)
  // 页面上**不再**放“整台默认在 MCP 页改”那段小字（组头已经写着“整台：按需（未单独设置）”，
  // 重复）；下面两条才是这条用例真正要守的事。
  assert.equal(allText(tree).includes('整台默认在 MCP 页的芯片上改'), false, '重复的入口分工说明不得回来')
  assert.match(allText(tree), /整台：按需（未单独设置）/, '组头要显示整台默认及它从哪来')
  const groupPicks = collectAll(tree, (node) => String(node.props?.['aria-label'] || '').includes('整台默认'))
  assert.equal(groupPicks.length, 0, '工具页不提供整台默认的第二个写入口')
})

test('工具加载面板：逐工具「跟随」删掉覆盖键，而不是写一个和当前值相同的值', async () => {
  const internals = loadInternals()
  const sent = []
  const withOverride = {
    ...SETTINGS,
    policy: { groups: {}, tools: { 'mcp__alpha__a': 'deferred' } },
  }
  const call = async (method, payload) => {
    if (method === 'toolLoadingSettings') return withOverride
    if (method === 'toolSearchSettings') return { ok: true, settings: { maxResults: 10, maxDiscovered: 20 } }
    sent.push([method, payload])
    return { ok: true, policy: withOverride.policy }
  }
  const props = { open: true, inline: true, onClose: () => {}, call, onSaved: () => {} }
  let tree = await openModal(internals, call, props)
  const groupToggle = collectAll(tree, (node) => node.props?.className === 'dsh-mcp-tool-group-toggle')
    .find((node) => allText(node).includes('alpha'))
  groupToggle.props.onClick()
  tree = internals.__render(internals.ToolLoadingModal, props)
  const row = collectAll(tree, (node) => node.props?.className?.includes?.('dsh-mcp-tool-row') && allText(node).includes('mcp__alpha__a'))[0]
  assert.ok(row, '被覆盖的行必须渲染出来')
  const follow = collectAll(row, (node) => node.type === 'button' && String(node.children?.[0] || '').startsWith('跟随'))[0]
  follow.props.onClick()
  tree = internals.__render(internals.ToolLoadingModal, props)
  await collectAll(tree, (node) => node.type === internals.Btn && node.props.cls === 'primary')[0].props.onClick()
  assert.deepEqual(JSON.parse(JSON.stringify(sent[0][1].policy.tools)), {}, '「跟随」必须删键，三态才真的可逆')
})

test('工具加载面板：项目作用域读 workspaceToolLoading、保存走 setWorkspaceToolLoading', async () => {
  const internals = loadInternals()
  const calls = []
  const call = async (method, payload) => {
    calls.push([method, payload])
    if (method === 'workspaceToolLoading') return SETTINGS
    if (method === 'setWorkspaceToolLoading') return { ok: true, policy: SETTINGS.policy }
    if (method === 'toolSearchSettings') throw new Error('项目作用域不应读取全局搜索参数')
    return { ok: true }
  }
  const props = {
    open: true, inline: true, scope: '/ws/a', onScope: () => {}, call, onClose: () => {}, onSaved: () => {},
    scopes: [{ key: 'global', label: '全局' }, { key: '/ws/a', label: 'proj-a' }],
  }
  let tree = await openModal(internals, call, props)
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), ['workspaceToolLoading', { wsPath: '/ws/a' }], '读的是这个项目的策略')
  assert.equal(calls.some(([method]) => method === 'toolSearchSettings'), false, '搜索参数是全局设置，项目页不请求')
  assert.equal(collectAll(tree, (node) => node.props?.className === 'dsh-mcp-tool-params').length, 0, '项目页不显示全局搜索设置')
  assert.match(allText(tree), /搜索设置是全局配置/, '项目页要说明搜索设置去哪里改')
  // 组头只读；项目的逐工具覆盖在行里改。
  assert.match(allText(tree), /整台：按需/, '项目组头显示这个项目的整台默认')
  tree = expandGroup(internals, props, '文件')
  const rowPick = collectAll(tree, (node) => typeof node.props?.className === 'string' && node.props.className.includes('dsh-mcp-tool-pick'))
    .find((node) => String(node.props['aria-label'] || '').includes(' · 加载方式'))
  collectAll(rowPick, (node) => node.type === 'button' && node.children?.[0] === '按需')[0].props.onClick()
  tree = internals.__render(internals.ToolLoadingModal, props)
  await collectAll(tree, (node) => node.type === internals.Btn && node.props.cls === 'primary')[0].props.onClick()
  const write = calls.find(([method]) => method === 'setWorkspaceToolLoading')
  assert.ok(write, '保存必须走项目接口')
  assert.equal(write[1].wsPath, '/ws/a')
  assert.deepEqual(JSON.parse(JSON.stringify(write[1].policy.tools)), { working_directory: 'deferred' })
  assert.deepEqual(JSON.parse(JSON.stringify(write[1].policy.groups)), {}, '项目页不改整台默认（那在 MCP 页）')
})

test('工具加载面板：手写 mode=all-resident / 总开关时给横幅，但不提供 mode 控件', async () => {
  const internals = loadInternals()
  const resident = {
    ...SETTINGS,
    tools: SETTINGS.tools.map((row) => (row.protected ? row : { ...row, policy: 'resident', reason: 'mode-resident' })),
  }
  const call = async (method) => (method === 'toolSearchSettings' ? { ok: true, settings: { maxResults: 10, maxDiscovered: 20 } } : resident)
  const props = { open: true, inline: true, onClose: () => {}, call, onSaved: () => {} }
  const tree = await openModal(internals, call, props)
  assert.match(allText(tree), /整体方案为「全部常驻」/, '被手写方案压住时必须说明本页为何不生效')
  // mode 不是页面上的第三组设置：写入口只有配置文件；页面不提供“推荐/全部常驻”按钮。
  assert.equal(collectAll(tree, (node) => node?.type === 'button' && node.children?.[0] === '推荐（MCP 按需）').length, 0)
  assert.equal(collectAll(tree, (node) => node?.type === 'button' && node.children?.[0] === '全部常驻').length, 0)
})

test('内置分类表：每个已知内置都有且只有一个分类，MCP 工具名不在内置名单里', () => {
  const internals = loadInternals()
  const known = Object.keys(internals.BUILTIN_LABELS)
  const missing = known.filter((name) => !internals.BUILTIN_CATEGORY[name])
  assert.deepEqual(missing, [], '已知内置工具必须全部归类，否则会漏进“其他内置”')
  assert.equal(Object.values(internals.BUILTIN_CATEGORY).length, known.length, '一个名字只能属于一个分类')
  // 这些名字来自 MCP 服务器（chrome-devtools）或宿主源码里根本不存在；把它们当内置会
  // 给同名第三方工具贴错身份——分类宁可不到，也不能错。
  for (const name of ['navigate_page', 'take_screenshot', 'click', 'task', 'schedule_update', 'schedule_delete', 'tool_search']) {
    assert.equal(Object.hasOwn(internals.BUILTIN_LABELS, name), false, `${name} 不是宿主内置工具，不能进内置名单`)
  }
  // 抽查验证过的归属：读文件归“文件”，子代理归“子代理与团队”，lsp 归“代码与工作区”。
  assert.equal(internals.BUILTIN_CATEGORY.read, 'files')
  assert.equal(internals.BUILTIN_CATEGORY.subagent, 'agents')
  assert.equal(internals.BUILTIN_CATEGORY.lsp, 'code')
  assert.equal(internals.BUILTIN_CATEGORY.schedule_view, 'schedule')
})

// ── R13a：目录体检（面板侧）────────────────────────────────────────────────
//
// 为什么需要这一组：三个搜索参数改完之后**什么都看不到**。唯一已有的信号
// （"目录因 maxCatalogChars 未列出 N 个工具名"）走 ctx.logger.warn，只落在宿主进程日志里。
// 这一组钉住"面板真的把体检画出来了"，以及老宿主（没有 catalog 字段）的降级。
test('工具加载面板：目录状态不在这一页（观测归上下文页）', async () => {
  // 「目录体检」曾是工具页的一块折叠卡。它是**观测**（目录多大、有没有被截），不是配置，
  // 而插件已经有专门的观测页——用户的原话是"既然都有专门显示这个上下文的页面，那也应该
  // 显示这里吧"。现在它并进「上下文」页的工具卡，工具页只留配置。
  // 这条用例守的是"别再加回来"：两处显示同一份读数，就必然有一天对不上。
  const internals = loadInternals()
  const call = async (method) => (method === 'toolSearchSettings'
    ? { ok: true, settings: { maxResults: 10 }, catalog: { budget: 12500, deferredServers: ['alpha'], lastAssembly: { listed: 400, truncated: 56, total: 456, chars: 12881, budget: 12500 } } }
    : SETTINGS)
  const props = { open: true, inline: true, onClose: () => {}, call, onSaved: () => {} }
  const tree = await openModal(internals, call, props)
  const text = allText(tree)
  assert.equal(text.includes('目录体检'), false, '工具页不该再出现「目录体检」')
  assert.equal(collectAll(tree, (node) => typeof node.props?.className === 'string' && node.props.className.includes('tool-diag')).length, 0, '工具页不该再渲染体检卡')
})



// ── 批量与自定义分组（DESIGN §16/§18）──────────────────────────────────
// 这组用例钉的是"动作条作用于谁"：勾选优先、否则当前匹配集合；以及
// 「存为分组」把刚写的逐工具覆盖上提成组策略（否则组策略会被覆盖压住）。

const batchCall = (sent, settings = SETTINGS) => async (method, payload) => {
  if (method === 'toolSearchSettings') return { ok: true, settings: { maxResults: 10, maxDiscovered: 20 } }
  if (method === 'toolLoadingSettings' || method === 'workspaceToolLoading') return settings
  sent.push([method, payload])
  return { ok: true, policy: settings.policy, customGroups: payload?.customGroups ?? settings.customGroups ?? {} }
}

const findByText = (tree, text) => collectAll(tree, (node) => node.props?.children === text)[0]
const findInput = (tree, placeholder) => collectAll(tree, (node) => node.type === 'input' && node.props?.placeholder === placeholder)[0]

test('工具页批量：动作条作用于当前筛选结果，未建组也能用', async () => {
  const internals = loadInternals()
  const sent = []
  const call = batchCall(sent)
  const props = { open: true, inline: true, onClose: () => {}, call, onSaved: () => {} }
  let tree = await openModal(internals, call, props)
  // 没有筛选也没有勾选时不出现动作条（不做"全部工具一键"）。
  assert.equal(collectAll(tree, (node) => node.props?.className === 'dsh-mcp-tool-batch').length, 0)

  const search = findInput(tree, '按名称或用途搜索')
  search.props.onChange({ target: { value: 'mcp__alpha' } })
  tree = internals.__render(internals.ToolLoadingModal, props)
  const bar = collectAll(tree, (node) => node.props?.className === 'dsh-mcp-tool-batch')[0]
  assert.ok(bar, '有筛选时必须出现动作条')
  assert.match(allText(bar), /匹配 2 个/, '计数来自当前筛选结果')

  findByText(bar, '设为按需').props.onClick()
  tree = internals.__render(internals.ToolLoadingModal, props)
  await collectAll(tree, (node) => node.props?.cls === 'primary')[0].props.onClick()
  assert.equal(sent.length, 1)
  assert.equal(sent[0][0], 'updateToolLoadingSettings')
  assert.deepEqual(JSON.parse(JSON.stringify(sent[0][1].policy.tools)), {
    mcp__alpha__a: 'deferred',
    mcp__alpha__b: 'deferred',
  }, '只改匹配的两行')
  assert.equal(sent[0][1].customGroups, undefined, '没有建组就不该提交 customGroups')
})

test('工具页批量：有勾选时只改勾选集合，不是全量匹配', async () => {
  const internals = loadInternals()
  const sent = []
  const call = batchCall(sent)
  const props = { open: true, inline: true, onClose: () => {}, call, onSaved: () => {} }
  let tree = await openModal(internals, call, props)
  tree = expandGroup(internals, props, '文件')
  const box = collectAll(tree, (node) => node.type === 'input' && node.props?.className === 'dsh-mcp-tool-check')[0]
  assert.ok(box, '行内必须有复选框')
  box.props.onChange()
  tree = internals.__render(internals.ToolLoadingModal, props)
  const bar = collectAll(tree, (node) => node.props?.className === 'dsh-mcp-tool-batch')[0]
  assert.match(allText(bar), /已选 1 个 · 共匹配 3 个/, '勾选数 + 匹配数都要说清')

  findByText(bar, '设为按需').props.onClick()
  tree = internals.__render(internals.ToolLoadingModal, props)
  await collectAll(tree, (node) => node.props?.cls === 'primary')[0].props.onClick()
  assert.deepEqual(JSON.parse(JSON.stringify(sent[0][1].policy.tools)), { working_directory: 'deferred' })
})

test('工具页分组：存为分组把批量值上提为组策略，并删掉逐工具覆盖', async () => {
  const internals = loadInternals()
  const sent = []
  const call = batchCall(sent)
  const props = { open: true, inline: true, onClose: () => {}, call, onSaved: () => {} }
  let tree = await openModal(internals, call, props)
  const search = findInput(tree, '按名称或用途搜索')
  search.props.onChange({ target: { value: 'mcp__alpha' } })
  tree = internals.__render(internals.ToolLoadingModal, props)
  const bar = collectAll(tree, (node) => node.props?.className === 'dsh-mcp-tool-batch')[0]
  findByText(bar, '设为按需').props.onClick()
  tree = internals.__render(internals.ToolLoadingModal, props)

  findByText(collectAll(tree, (node) => node.props?.className === 'dsh-mcp-tool-batch')[0], '存为分组').props.onClick()
  tree = internals.__render(internals.ToolLoadingModal, props)
  const input = findInput(tree, '例如：表格工具')
  assert.ok(input, '存为分组要弹名称输入框')
  assert.equal(input.props.value, 'mcp__alpha', '组名预填当前搜索词')
  input.props.onChange({ target: { value: 'Alpha 组' } })
  tree = internals.__render(internals.ToolLoadingModal, props)
  findByText(tree, '确定').props.onClick()
  tree = internals.__render(internals.ToolLoadingModal, props)

  await collectAll(tree, (node) => node.props?.cls === 'primary')[0].props.onClick()
  const payload = JSON.parse(JSON.stringify(sent[0][1]))
  assert.deepEqual(payload.customGroups, {
    'Alpha 组': { policy: 'deferred', tools: ['mcp__alpha__a', 'mcp__alpha__b'] },
  }, '组策略上提，成员进组')
  assert.deepEqual(payload.policy.tools, {}, '逐工具覆盖被删掉，否则组策略会被压住')
})

test('工具页分组：项目作用域里分组只读，保存不带 customGroups', async () => {
  const internals = loadInternals()
  const sent = []
  const settings = {
    ...SETTINGS,
    customGroups: { 只读组: { policy: 'deferred', tools: ['working_directory'] } },
  }
  const call = batchCall(sent, settings)
  const props = { open: true, inline: true, onClose: () => {}, scope: 'proj-a', scopes: [{ id: 'global', label: '全局' }, { id: 'proj-a', label: '项目 A' }], onScope: () => {}, call, onSaved: () => {} }
  let tree = await openModal(internals, call, props)
  const create = findByText(tree, '+ 新建分组')
  assert.equal(create.props.disabled, true, '项目作用域不能建组（分组是全局的）')
  const headerPicks = collectAll(tree, (node) => String(node.props?.className || '').includes('dsh-mcp-tool-pick') && String(node.props['aria-label'] || '') === '整组加载方式')
  assert.ok(headerPicks.length >= 1, '自定义组头渲染出来')
  assert.ok(headerPicks[0].children.every((button) => button.props.disabled === true), '组级三态在项目里只读')

  tree = expandGroup(internals, props, '只读组')
  const pick = collectAll(tree, (node) => typeof node.props?.className === 'string' && node.props.className.includes('dsh-mcp-tool-pick'))
    .find((node) => String(node.props['aria-label'] || '').includes(' · 加载方式'))
  collectAll(pick, (node) => node.type === 'button' && node.children?.[0] === '常驻')[0].props.onClick()
  tree = internals.__render(internals.ToolLoadingModal, props)
  await collectAll(tree, (node) => node.props?.cls === 'primary')[0].props.onClick()
  assert.equal(sent[0][0], 'setWorkspaceToolLoading')
  assert.equal(sent[0][1].customGroups, undefined, '项目层不提交分组')
})

test('工具页分组：筛选后默认展开，但用户点折叠必须生效（不是点不动）', async () => {
  const internals = loadInternals()
  const call = batchCall([])
  const props = { open: true, inline: true, onClose: () => {}, call, onSaved: () => {} }
  let tree = await openModal(internals, call, props)
  // 选类型筛选「内置」：命中的「文件」组自动展开（否则筛选看起来没结果）
  findByText(tree, '内置').props.onClick()
  tree = internals.__render(internals.ToolLoadingModal, props)
  const openBefore = collectAll(tree, (node) => node.props?.className === 'dsh-mcp-tool-group open').map((node) => allText(node))
  assert.ok(openBefore.some((text) => text.includes('文件')), '筛选命中后应默认展开')
  // 再点一次分组头：必须能折叠。这条钉的是"筛选把折叠权抢走"那个缺陷。
  const toggle = collectAll(tree, (node) => node.props?.className === 'dsh-mcp-tool-group-toggle')
    .find((node) => allText(node).includes('文件'))
  toggle.props.onClick()
  tree = internals.__render(internals.ToolLoadingModal, props)
  const openAfter = collectAll(tree, (node) => node.props?.className === 'dsh-mcp-tool-group open').map((node) => allText(node))
  assert.equal(openAfter.some((text) => text.includes('文件')), false, '筛选态下点击折叠必须生效')
})

test('工具页：段落头可整体折叠（我的分组 / 内置 / MCP / 其他）', async () => {
  const internals = loadInternals()
  const call = batchCall([])
  const props = { open: true, inline: true, onClose: () => {}, call, onSaved: () => {} }
  let tree = await openModal(internals, call, props)
  // 默认展开：内置段里的「文件」组头在
  assert.ok(collectAll(tree, (node) => node.props?.className === 'dsh-mcp-tool-group-toggle')
    .some((node) => allText(node).includes('文件')), '默认展开')
  // 点段落头「内置工具（按用途）」→ 整段收起（里面的组头全部消失）
  const head = collectAll(tree, (node) => node.props?.className === 'dsh-mcp-tool-section-toggle')
    .find((node) => allText(node).includes('内置工具'))
  assert.ok(head, '段落头必须可点')
  head.props.onClick()
  tree = internals.__render(internals.ToolLoadingModal, props)
  assert.equal(collectAll(tree, (node) => node.props?.className === 'dsh-mcp-tool-group-toggle')
    .some((node) => allText(node).includes('文件')), false, '段落收起后组头应消失')
  // 段落头本身仍在（否则收不起来就再也点不回来）
  assert.ok(collectAll(tree, (node) => node.props?.className === 'dsh-mcp-tool-section-toggle')
    .some((node) => allText(node).includes('内置工具')), '段落头必须保留')
})
