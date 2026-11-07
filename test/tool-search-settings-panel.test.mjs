// C2 的面板侧行为：搜索参数和统一工具加载面板必须真实读写两个 RPC，且失败留在面板。
//
// 宿主 schema、patch 落盘和真 loader 重装由 tool-search-settings.test / real-host-loader 覆盖；
// 这里保留浏览器侧的回归，验证用户真的能读到、修改、保存和放弃搜索参数。
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const clientSource = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const exportMarker = 'exports.inject = inject;'
const instrumentedClient = clientSource.replace(
  exportMarker,
  `${exportMarker}\nexports.__settingsPanel = { HintMarker, Toggle, Btn, ToolLoadingModal, SEARCH_PARAM_FIELDS };`,
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
const allText = (tree) => textOf(tree).join(' ')
const numericInputs = (tree) => collectAll(tree, (node) => node?.type === 'input' && node.props?.type === 'number')
const buttons = (tree, internals) => collectAll(tree, (node) => node?.type === internals.Btn && node.props?.onClick !== undefined)
const buttonByText = (tree, internals, label) => buttons(tree, internals).find((node) => node.props.children === label)
const primaryButton = (tree, internals) => buttons(tree, internals).find((node) => node.props.cls === 'primary')
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const DEFAULTS = { maxResults: 10, maxDiscovered: 20 }
const TOOLS = [
  { name: 'working_directory', owner: null, kind: 'builtin', description: 'Read the current working directory', protected: false, policy: 'resident', reason: 'default-resident' },
]

function fakeCall({ settings = DEFAULTS, failFor = null, tools = [], policy = { groups: {}, tools: {} } } = {}) {
  const calls = []
  let currentSettings = { ...settings }
  const call = async (method, payload) => {
    calls.push({ method, payload })
    if (failFor === method) return { ok: false, error: 'host rejected: maxResults 必须是安全整数' }
    if (method === 'toolLoadingSettings') return { ok: true, policy, tools, configKey: 'toolLoading' }
    if (method === 'toolSearchSettings') return { ok: true, settings: { ...currentSettings }, defaults: DEFAULTS, configKey: 'toolSearch' }
    if (method === 'updateToolLoadingSettings') return { ok: true, policy: payload.policy, configKey: 'toolLoading' }
    if (method === 'updateToolSearchSettings') {
      currentSettings = { ...payload.settings }
      return { ok: true, settings: { ...currentSettings }, defaults: DEFAULTS, configKey: 'toolSearch', changed: true }
    }
    return { ok: true }
  }
  return { calls, call }
}

async function openPanel(internals, call, props = {}) {
  const base = { open: true, inline: true, onClose: () => {}, call, onSaved: () => {}, ...props }
  internals.__render(internals.ToolLoadingModal, base)
  internals.__drainEffects()
  await flush()
  return { base, tree: internals.__render(internals.ToolLoadingModal, base) }
}

test('表单关闭时不渲染任何东西（统一工具加载面板也保持惰性）', () => {
  const internals = loadInternals()
  const { call } = fakeCall()
  assert.equal(internals.__render(internals.ToolLoadingModal, { open: false, onClose: () => {}, call, onSaved: () => {} }), null)
})

test('打开时同时读取工具策略与搜索参数，两个参数和目录上限按宿主值呈现', async () => {
  const internals = loadInternals()
  const { calls, call } = fakeCall({ settings: { maxResults: 25, maxDiscovered: 30, maxCatalogChars: 120 } })
  const { tree } = await openPanel(internals, call)
  assert.deepEqual(calls.slice(0, 2).map((entry) => entry.method), ['toolLoadingSettings', 'toolSearchSettings'])
  assert.deepEqual(numericInputs(tree).map((node) => node.props.value), [25, 30, 120])
  assert.ok(allText(tree).includes('一次最多返回几个'))
  assert.ok(allText(tree).includes('同时记住几个已发现的工具'))
  assert.ok(allText(tree).includes('限制目录大小'))
})

test('保存搜索参数时把输入框字符串转换为数字，并回读策略基线', async () => {
  const internals = loadInternals()
  const { calls, call } = fakeCall({ settings: { maxResults: 25, maxDiscovered: 30, maxCatalogChars: 120 } })
  const saved = []
  const { base, tree } = await openPanel(internals, call, { onSaved: (value) => saved.push(value) })
  const fields = numericInputs(tree)
  fields[0].props.onChange({ target: { value: '8' } })
  fields[1].props.onChange({ target: { value: '12' } })
  fields[2].props.onChange({ target: { value: '50' } })
  const changed = internals.__render(internals.ToolLoadingModal, base)
  await primaryButton(changed, internals).props.onClick()
  await flush()
  const update = calls.find((entry) => entry.method === 'updateToolSearchSettings')
  assert.ok(update)
  assert.deepEqual(JSON.parse(JSON.stringify(update.payload)), { settings: { maxResults: 8, maxDiscovered: 12, maxCatalogChars: 50 } })
  assert.ok(calls.some((entry) => entry.method === 'toolLoadingSettings'), '保存后必须回读工具策略')
  assert.equal(saved.length, 1)
})

test('保存失败时保留宿主原话，不回调成功分支，也不关闭面板', async () => {
  const internals = loadInternals()
  const { call } = fakeCall({ failFor: 'updateToolSearchSettings' })
  const saved = []
  const closed = []
  const { base, tree } = await openPanel(internals, call, { onClose: () => closed.push('close'), onSaved: (value) => saved.push(value) })
  numericInputs(tree)[0].props.onChange({ target: { value: '8' } })
  const changed = internals.__render(internals.ToolLoadingModal, base)
  await primaryButton(changed, internals).props.onClick()
  await flush()
  const after = internals.__render(internals.ToolLoadingModal, base)
  assert.match(allText(after), /host rejected: maxResults/)
  assert.equal(saved.length, 0)
  assert.deepEqual(closed, [])
})

test('搜索参数说明使用可访问的 HintMarker，且目录限制也有自己的说明', async () => {
  const internals = loadInternals()
  const { call } = fakeCall()
  const { tree } = await openPanel(internals, call)
  const labels = collectAll(tree, (node) => node?.type === 'label')
  assert.equal(labels.length, 2, '两个普通搜索参数各有一个 label')
  const markers = collectAll(tree, (node) => node?.type === internals.HintMarker)
  assert.equal(markers.length, 3, '两个数字参数加目录限制各有一个说明标记')
  const markerTexts = markers.map((node) => node.props.text)
  for (const field of internals.SEARCH_PARAM_FIELDS) assert.ok(markerTexts.includes(field.about))
  const rendered = internals.__render(internals.HintMarker, { text: '这段说明' })
  assert.equal(rendered.props.title, '这段说明')
  assert.equal(rendered.props['aria-label'], '这段说明')
  assert.equal(rendered.props.tabIndex, 0)
})

test('读取搜索参数失败时显示宿主原话，数字控件保持禁用而不崩溃', async () => {
  const internals = loadInternals()
  const { call } = fakeCall({ failFor: 'toolSearchSettings' })
  const { tree } = await openPanel(internals, call)
  assert.match(allText(tree), /host rejected: maxResults/)
  assert.ok(numericInputs(tree).length >= 2)
  assert.equal(numericInputs(tree).every((node) => node.props.disabled === true), true)
})

test('放弃修改会恢复已保存的搜索参数，并重新禁用保存按钮', async () => {
  const internals = loadInternals()
  const { call } = fakeCall()
  const { base, tree } = await openPanel(internals, call)
  numericInputs(tree)[0].props.onChange({ target: { value: '12' } })
  let changed = internals.__render(internals.ToolLoadingModal, base)
  const discard = buttonByText(changed, internals, '放弃修改')
  assert.ok(discard)
  discard.props.onClick()
  changed = internals.__render(internals.ToolLoadingModal, base)
  assert.equal(numericInputs(changed)[0].props.value, 10)
  assert.equal(primaryButton(changed, internals).props.disabled, true)
})

test('参数非法时先报错，工具策略和搜索参数都不能落盘', async () => {
  const internals = loadInternals()
  const { calls, call } = fakeCall({ tools: TOOLS })
  const { base, tree } = await openPanel(internals, call)
  const pick = collectAll(tree, (node) => node.props?.className === 'dsh-mcp-tool-pick')[0]
  assert.ok(pick)
  pick.children[1].props.onClick()
  numericInputs(tree)[0].props.onChange({ target: { value: '1.5' } })
  const changed = internals.__render(internals.ToolLoadingModal, base)
  await primaryButton(changed, internals).props.onClick()
  await flush()
  assert.equal(calls.some((entry) => entry.method === 'updateToolLoadingSettings'), false)
  assert.equal(calls.some((entry) => entry.method === 'updateToolSearchSettings'), false)
  assert.match(allText(internals.__render(internals.ToolLoadingModal, base)), /正整数/)
})

test('目录限制开关打开后显示输入框并预填建议起点，保存时才写入 maxCatalogChars', async () => {
  const internals = loadInternals()
  const { calls, call } = fakeCall()
  const { base, tree } = await openPanel(internals, call)
  const toggle = collectAll(tree, (node) => node?.type === internals.Toggle)[0]
  assert.equal(toggle.props.on, false)
  // 关着的时候输入框也在（置灰），所以打开前后控件数量不变——这是"不卸载"的直接证据。
  assert.equal(numericInputs(tree).length, 3)
  assert.equal(numericInputs(tree)[2].props.disabled, true)
  toggle.props.onChange(true)
  let changed = internals.__render(internals.ToolLoadingModal, base)
  assert.equal(numericInputs(changed).length, 3)
  assert.equal(numericInputs(changed)[2].props.disabled, false)
  // 打开时预填建议起点：用户不该对着空白框猜一个数，也不该在测试里替产品敲这个数。
  assert.equal(numericInputs(changed)[2].props.value, '12500')
  await primaryButton(changed, internals).props.onClick()
  await flush()
  const update = calls.find((entry) => entry.method === 'updateToolSearchSettings')
  assert.deepEqual(JSON.parse(JSON.stringify(update.payload)), {
    settings: { maxResults: 10, maxDiscovered: 20, maxCatalogChars: 12500 },
  })
})

test('目录限制打开后清空输入会保留控件并拒绝保存', async () => {
  const internals = loadInternals()
  const { calls, call } = fakeCall({ settings: { maxResults: 10, maxDiscovered: 20, maxCatalogChars: 120 } })
  const { base, tree } = await openPanel(internals, call)
  assert.equal(collectAll(tree, (node) => node?.type === internals.Toggle)[0].props.on, true)
  numericInputs(tree)[2].props.onChange({ target: { value: '' } })
  const changed = internals.__render(internals.ToolLoadingModal, base)
  assert.equal(numericInputs(changed).length, 3)
  await primaryButton(changed, internals).props.onClick()
  await flush()
  assert.equal(calls.some((entry) => entry.method === 'updateToolSearchSettings'), false)
  assert.match(allText(internals.__render(internals.ToolLoadingModal, base)), /目录上限需要一个正整数/)
})

test('关闭目录限制会移除 maxCatalogChars，而不是写入 0；输入框置灰保留', async () => {
  const internals = loadInternals()
  const { calls, call } = fakeCall({ settings: { maxResults: 10, maxDiscovered: 20, maxCatalogChars: 120 } })
  const { base, tree } = await openPanel(internals, call)
  collectAll(tree, (node) => node?.type === internals.Toggle)[0].props.onChange(false)
  const changed = internals.__render(internals.ToolLoadingModal, base)
  // 关掉是"可见、不可改、不生效"，不是把控件拿走：卸载会让表单跳一下，用户也看不出这一项原本是什么。
  assert.equal(numericInputs(changed).length, 3)
  assert.equal(numericInputs(changed)[2].props.disabled, true)
  await primaryButton(changed, internals).props.onClick()
  await flush()
  const update = calls.find((entry) => entry.method === 'updateToolSearchSettings')
  assert.ok(update)
  assert.equal('maxCatalogChars' in JSON.parse(JSON.stringify(update.payload)).settings, false)
})
