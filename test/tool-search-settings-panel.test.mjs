// C2 的**面板侧行为**：表单真的调那两个 RPC、把三个值按数字发出去、宿主的报错留在眼前。
//
// 为什么单独一组：C2 的其余证据都在宿主侧（schema / patch 落盘 / 真 loader 重装）。缺了这组，
// 面板可以只渲染出一个漂亮的表单而从不调用 RPC——所有宿主侧用例仍然全绿，而用户点了没反应。
// 手法与 detail-panes / skills-client 相同：假 React 的 __render 消化 setter 触发的重渲染。
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const clientSource = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const exportMarker = 'exports.inject = inject;'
const instrumentedClient = clientSource.replace(
  exportMarker,
  `${exportMarker}\nexports.__settingsPanel = { HintMarker, Toggle, ToolSearchSettingsModal, TOOL_SEARCH_SETTING_FIELDS };`,
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
const inputs = (tree) => collectAll(tree, (node) => node?.type === 'input')
const buttons = (tree) => collectAll(tree, (node) => node?.props?.onClick !== undefined && node?.type?.name === 'Btn')
const buttonByText = (tree, label) => buttons(tree).find((node) => node.props.children === label)
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

// 与生产一致：目录大小**没有默认值**（缺省 = 不限制），默认表里只有两个数。
const DEFAULTS = { maxResults: 10, maxDiscovered: 20 }

/**
 * `call` 的**真实契约**（lib/client.js 里那个包装器）：它**从不抛错**，而是把宿主的应答
 * 折成 `{ ok: true, ...value }` 或 `{ ok: false, error }`。夹具必须照抄这个形状——
 * 早期版本让它 throw，于是「保存失败」被面板当成成功处理（真机实测：文件一个字没写，
 * 界面却弹了"已保存"）。这正是「夹具照抄实现就证明不了实现」的又一例。
 */
function fakeCall({ settings = DEFAULTS, failFor = null } = {}) {
  const calls = []
  const call = async (method, payload) => {
    calls.push({ method, payload })
    if (failFor === method) return { ok: false, error: 'host rejected: maxResults 必须是安全整数' }
    if (method === 'toolSearchSettings') return { ok: true, settings, defaults: DEFAULTS, configKey: 'toolSearch' }
    return { ok: true, settings: payload.settings, defaults: DEFAULTS, configKey: 'toolSearch', changed: true, note: '已写入 profile 配置，当前会话立即生效' }
  }
  return { calls, call }
}

test('表单关闭时不渲染任何东西（面板里五个 modal 都常驻挂载）', () => {
  const { ToolSearchSettingsModal, __render } = loadInternals()
  const { call } = fakeCall()
  const tree = __render(ToolSearchSettingsModal, { open: false, onClose: () => {}, call, onSaved: () => {} })
  assert.equal(tree, null)
})

test('打开时读宿主参数：三项都按生效值填好，默认值也摆出来', async () => {
  const { ToolSearchSettingsModal, TOOL_SEARCH_SETTING_FIELDS, __render, __drainEffects } = loadInternals()
  const { calls, call } = fakeCall({ settings: { maxResults: 25, maxCatalogChars: 120, maxDiscovered: 30 } })
  __render(ToolSearchSettingsModal, { open: true, onClose: () => {}, call, onSaved: () => {} })
  __drainEffects()
  await flush()
  const tree = __render(ToolSearchSettingsModal, { open: true, onClose: () => {}, call, onSaved: () => {} })

  assert.deepEqual(calls.map((entry) => entry.method), ['toolSearchSettings'], '打开就必须问一次宿主')
  const fields = inputs(tree)
  assert.equal(fields.length, 3, '三个参数各一个输入框')
  assert.deepEqual(fields.map((node) => node.props.value), [25, 120, 30], '输入框初值是当前生效值')
  // 字段顺序跟清单一致（清单是面板顺序的唯一真源）。
  assert.deepEqual(fields.map((node) => node.props.placeholder), ['10', '12500', '20'], '占位符是默认值')
  for (const field of TOOL_SEARCH_SETTING_FIELDS) {
    assert.ok(allText(tree).includes(field.label), `缺少字段标签：${field.label}`)
  }
})

test('保存：按数字发三个值、成功即收起并回报宿主的原话', async () => {
  const { ToolSearchSettingsModal, __render, __drainEffects } = loadInternals()
  // 目录上限是开关项：先给它一个值，三项才都在场（这也是"用户真的开了"的形态）。
  const { calls, call } = fakeCall({ settings: { maxResults: 25, maxCatalogChars: 120, maxDiscovered: 30 } })
  const saved = []
  const closed = []
  __render(ToolSearchSettingsModal, { open: true, onClose: () => closed.push('close'), call, onSaved: (res) => saved.push(res) })
  __drainEffects()
  await flush()
  let tree = __render(ToolSearchSettingsModal, { open: true, onClose: () => {}, call, onSaved: (res) => saved.push(res) })

  // 用户把三项都改掉（输入框给的是字符串，保存时必须转成数字）。
  const fields = inputs(tree)
  fields[0].props.onChange({ target: { value: '8' } })
  fields[1].props.onChange({ target: { value: '50' } })
  fields[2].props.onChange({ target: { value: '12' } })
  tree = __render(ToolSearchSettingsModal, { open: true, onClose: () => {}, call, onSaved: (res) => saved.push(res) })

  buttonByText(tree, '保存').props.onClick()
  await flush()
  const update = calls.find((entry) => entry.method === 'updateToolSearchSettings')
  assert.ok(update, '保存必须调 updateToolSearchSettings')
  // 跨 realm：payload 是 bundle 那个 vm 上下文里造的对象，原型不同，deepStrictEqual 会以
  // "看起来一模一样却不等"失败。比 JSON 形状（数值本身才是这条断言要说的事）。
  assert.deepEqual(JSON.parse(JSON.stringify(update.payload)), { settings: { maxResults: 8, maxCatalogChars: 50, maxDiscovered: 12 } },
    '发出去的必须是数字，不是输入框里的字符串')
  assert.equal(saved.length, 1, '成功要回报给面板（刷新提示用它）')
  assert.match(saved[0].note, /立即生效/)
})

test('保存失败：宿主的报错显示在表单里，且不收起（错误不能闪一下就没了）', async () => {
  const { ToolSearchSettingsModal, __render, __drainEffects } = loadInternals()
  const { call } = fakeCall({ failFor: 'updateToolSearchSettings' })
  const saved = []
  const closed = []
  __render(ToolSearchSettingsModal, { open: true, onClose: () => closed.push('close'), call, onSaved: (res) => saved.push(res) })
  __drainEffects()
  await flush()
  let tree = __render(ToolSearchSettingsModal, { open: true, onClose: () => closed.push('close'), call, onSaved: (res) => saved.push(res) })

  buttonByText(tree, '保存').props.onClick()
  await flush()
  tree = __render(ToolSearchSettingsModal, { open: true, onClose: () => closed.push('close'), call, onSaved: (res) => saved.push(res) })
  assert.match(allText(tree), /host rejected: maxResults/, '宿主的原话必须显示出来，不能换成一句泛泛的失败')
  assert.equal(saved.length, 0, '失败不得走"成功"那条路')
  assert.deepEqual(closed, [], '失败不关表单')
})

test('每个字段都有 ⓘ 说明标记：移上去是大白话的"这个数管什么"，且不只 hover 一条路', async () => {
  // 用户要求（原话）：「最好有个提示标记那个，移动上去会说明是控制啥的，要普通人都能看懂」。
  // 所以这条钉三件事：三个字段各有标记、标记挂在**标签**里（不是在别处）、说明文字同时给
  // title 与 aria-label（触屏没有 hover、键盘用户拿不到 title），并且那段说明**不**铺在
  // 表单正文里（正文里是大白话标签 + 默认值，行话放不进视线）。
  const { HintMarker, ToolSearchSettingsModal, TOOL_SEARCH_SETTING_FIELDS, __render, __drainEffects } = loadInternals()
  const { call } = fakeCall()
  __render(ToolSearchSettingsModal, { open: true, onClose: () => {}, call, onSaved: () => {} })
  __drainEffects()
  await flush()
  const tree = __render(ToolSearchSettingsModal, { open: true, onClose: () => {}, call, onSaved: () => {} })

  // ① 每个字段的标签里**恰好一个**说明标记，且喂给它的是这个字段自己的 about。
  //    夹具的 h() 不会展开组件，所以节点 type 就是 HintMarker 本身。
  const labels = collectAll(tree, (node) => node?.type === 'label')
  assert.equal(labels.length, 3, '三个字段各一个标签')
  const markerTexts = labels.map((label) => {
    // 标签文字仍然在（标记是**加在**标签上，不是替换它）。
    assert.ok(allText(label).trim().length > 0, '标签必须有文字')
    const markers = collectAll(label, (node) => node?.type === HintMarker)
    assert.equal(markers.length, 1, `每个字段标签里恰好一个说明标记（实际 ${markers.length}）`)
    return markers[0].props.text
  })
  assert.deepEqual(
    [...markerTexts].sort(),
    // 跨 realm：TOOL_SEARCH_SETTING_FIELDS 来自 vm 上下文，直接 .map() 出来的数组原型不同，
    // deepStrictEqual 会以"看起来一模一样却不等"失败。先摊进本 realm 的数组。
    [...TOOL_SEARCH_SETTING_FIELDS].map((field) => field.about).sort(),
    '三个标记必须各自带上对应字段的说明文字（顺序与表一致）',
  )

  // ② 标记渲染出来的形状：原生 title（hover 可见）+ aria-label + 可 Tab（两条非 hover 路径）。
  const rendered = __render(HintMarker, { text: '这段说明' })
  assert.equal(rendered.props.className, 'dsh-mcp-hint')
  assert.equal(rendered.props.title, '这段说明', 'title 是 hover 那条路')
  assert.equal(rendered.props['aria-label'], '这段说明', 'aria-label 让读屏拿到同一段文字')
  assert.equal(rendered.props.tabIndex, 0, '可 Tab：键盘用户拿不到 title')

  // ③ 说明只走 tooltip：正文里不该再出现那三段长句（普通人看到的是标签 + 默认值）。
  const inline = collectAll(tree, (node) => typeof node?.props?.children === 'string'
    && TOOL_SEARCH_SETTING_FIELDS.some((field) => node.props.children === field.about))
  assert.deepEqual(inline, [], '说明文字不得铺在表单正文里')
})

test('读取失败（call 返回 ok:false）：显示宿主原话，且不渲染出半截表单', async () => {
  // 读失败时 `res.settings` 是 undefined；若照常进表单，`loaded.defaults[field.key]` 会直接抛
  // TypeError，整个面板跟着挂。所以这条与上面那条是同一类错误的两个方向。
  const { ToolSearchSettingsModal, __render, __drainEffects } = loadInternals()
  const { call } = fakeCall({ failFor: 'toolSearchSettings' })
  __render(ToolSearchSettingsModal, { open: true, onClose: () => {}, call, onSaved: () => {} })
  __drainEffects()
  await flush()
  const tree = __render(ToolSearchSettingsModal, { open: true, onClose: () => {}, call, onSaved: () => {} })
  assert.match(allText(tree), /host rejected/, '读不到参数时要把宿主原话摆出来')
  assert.deepEqual(inputs(tree), [], '读失败不得渲染出没有默认值的输入框（会直接崩）')
})

test('恢复默认：把值填回宿主给的默认值（不猜数字，用宿主返回的那份）', async () => {
  const { ToolSearchSettingsModal, Toggle, __render, __drainEffects } = loadInternals()
  const { call } = fakeCall({ settings: { maxResults: 25, maxCatalogChars: 120, maxDiscovered: 30 } })
  __render(ToolSearchSettingsModal, { open: true, onClose: () => {}, call, onSaved: () => {} })
  __drainEffects()
  await flush()
  let tree = __render(ToolSearchSettingsModal, { open: true, onClose: () => {}, call, onSaved: () => {} })
  buttonByText(tree, '恢复默认').props.onClick()
  tree = __render(ToolSearchSettingsModal, { open: true, onClose: () => {}, call, onSaved: () => {} })
  // 目录大小没有默认值 ⇒ 恢复默认 = 关掉上限（只留两个数字框），而不是填一个我们编的数。
  assert.deepEqual(inputs(tree).map((node) => node.props.value), [10, 20])
  assert.equal(collectAll(tree, (node) => node?.type === Toggle)[0].props.on, false, '恢复默认必须把目录上限关掉')
})

test('目录大小：默认不限制 —— 开关是关的、没有数字框、写明白"不限制"', async () => {
  const { ToolSearchSettingsModal, Toggle, __render, __drainEffects } = loadInternals()
  const { call } = fakeCall() // 宿主返回的 settings 里根本没有 maxCatalogChars
  __render(ToolSearchSettingsModal, { open: true, onClose: () => {}, call, onSaved: () => {} })
  __drainEffects()
  await flush()
  const tree = __render(ToolSearchSettingsModal, { open: true, onClose: () => {}, call, onSaved: () => {} })
  const toggles = collectAll(tree, (node) => node?.type === Toggle)
  assert.equal(toggles.length, 1, '只有目录大小这一项是开关（其余是数字）')
  assert.equal(toggles[0].props.on, false, '默认关 = 不限制')
  assert.equal(inputs(tree).length, 2, '关着的时候不出现目录上限的数字框')
  assert.ok(allText(tree).includes('不限制'), '缺省值要写"不限制"，不能把 undefined 摆出来')
})

test('目录大小：打开开关才发这个键，且预填建议起点（不让用户对着空框猜）', async () => {
  const { ToolSearchSettingsModal, Toggle, __render, __drainEffects } = loadInternals()
  const { calls, call } = fakeCall()
  __render(ToolSearchSettingsModal, { open: true, onClose: () => {}, call, onSaved: () => {} })
  __drainEffects()
  await flush()
  let tree = __render(ToolSearchSettingsModal, { open: true, onClose: () => {}, call, onSaved: () => {} })
  collectAll(tree, (node) => node?.type === Toggle)[0].props.onChange(true)
  tree = __render(ToolSearchSettingsModal, { open: true, onClose: () => {}, call, onSaved: () => {} })

  const fields = inputs(tree)
  assert.equal(fields.length, 3, '打开后才有第三个数字框')
  assert.equal(String(fields[1].props.value), '12500', '预填建议值（实测口径：456 工具约 11,690 字符）')

  buttonByText(tree, '保存').props.onClick()
  await flush()
  const update = calls.find((entry) => entry.method === 'updateToolSearchSettings')
  assert.equal(JSON.parse(JSON.stringify(update.payload)).settings.maxCatalogChars, 12500, '打开后保存必须带上这个键')
})

test('目录大小：清空数字框不会让控件消失，也不会在保存时悄悄撤掉上限', async () => {
  // 用户改数字的惯性动作是"先清空再输入"。若开关状态从文字推导，清空那一刻输入框会卸载、
  // 开关自己关掉；而清空后保存会把上限**无提示地**撤掉（独立复核用探针实测到这个后果）。
  const { ToolSearchSettingsModal, Toggle, __render, __drainEffects } = loadInternals()
  const { calls, call } = fakeCall({ settings: { maxResults: 10, maxCatalogChars: 120, maxDiscovered: 20 } })
  __render(ToolSearchSettingsModal, { open: true, onClose: () => {}, call, onSaved: () => {} })
  __drainEffects()
  await flush()
  let tree = __render(ToolSearchSettingsModal, { open: true, onClose: () => {}, call, onSaved: () => {} })
  assert.equal(collectAll(tree, (node) => node?.type === Toggle)[0].props.on, true, '宿主有值 ⇒ 开关是开的')

  // 清空输入框：控件必须还在，开关必须还开着（这是"开关是独立状态"的全部意义）。
  inputs(tree)[1].props.onChange({ target: { value: '' } })
  tree = __render(ToolSearchSettingsModal, { open: true, onClose: () => {}, call, onSaved: () => {} })
  assert.equal(inputs(tree).length, 3, '清空后输入框不得消失')
  assert.equal(collectAll(tree, (node) => node?.type === Toggle)[0].props.on, true, '清空不得把开关关掉')

  // 空值 + 开关开着时保存：必须**当场报错**且不发 RPC，而不是静默按"没设"处理。
  buttonByText(tree, '保存').props.onClick()
  await flush()
  assert.equal(calls.some((entry) => entry.method === 'updateToolSearchSettings'), false, '空值不得发出去')
  tree = __render(ToolSearchSettingsModal, { open: true, onClose: () => {}, call, onSaved: () => {} })
  assert.match(allText(tree), /目录上限需要一个正整数/, '要告诉用户怎么办（关掉开关或填数）')
})

test('目录大小：关掉开关 = 不发这个键（不限制），而不是发 0（一个都不列）', async () => {
  const { ToolSearchSettingsModal, Toggle, __render, __drainEffects } = loadInternals()
  const { calls, call } = fakeCall({ settings: { maxResults: 10, maxCatalogChars: 120, maxDiscovered: 20 } })
  __render(ToolSearchSettingsModal, { open: true, onClose: () => {}, call, onSaved: () => {} })
  __drainEffects()
  await flush()
  let tree = __render(ToolSearchSettingsModal, { open: true, onClose: () => {}, call, onSaved: () => {} })
  collectAll(tree, (node) => node?.type === Toggle)[0].props.onChange(false)
  tree = __render(ToolSearchSettingsModal, { open: true, onClose: () => {}, call, onSaved: () => {} })
  assert.equal(inputs(tree).length, 2, '关掉即刻收起数字框')

  buttonByText(tree, '保存').props.onClick()
  await flush()
  const update = calls.find((entry) => entry.method === 'updateToolSearchSettings')
  assert.equal('maxCatalogChars' in JSON.parse(JSON.stringify(update.payload)).settings, false,
    '关掉是"不写这个键"；0 的语义是"一个名字都不列"，与不限制相反')
})
