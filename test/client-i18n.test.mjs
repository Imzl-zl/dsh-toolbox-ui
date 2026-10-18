import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

// ═══ 为什么需要这组用例 ════════════════════════════════════════════════════════
//
// 真机缺陷（用户报告）：「页签按钮还是中文」——切到 English 后，详情页签、排序菜单、
// 入口菜单、作用域标签仍是中文，而其它文案都正常。
//
// 根因不是漏翻，而是**求值时机**：这些文案住在一批**模块级常量表**里
// （ABILITY_TABS / SKILL_MODES / SORT_LABELS / ENTRY_LABELS / SCOPE_LABELS /
// SCOPE_LABEL_DETAILS）。写成 `label: t('技能')` 时，t() 在 **bundle 加载那一刻**就求值了，
// 而 active 语言要等 apply() 读到 locale 服务（并订阅后续切换）才知道。
// 于是这些表把语言**冻在加载时**，之后无论怎么切都不变——恰好是"页签还是中文"。
//
// 契约（这组用例钉的就是它）：**常量表只许存中文原文，t() 必须发生在渲染路径上**。
// 只钉行为不够——行为用例渲染不起来这些组件（测试替身的 hooks 是空实现），
// 所以这里两条腿走路：能跑的跑真行为，跑不了的钉源码形状。

const clientSource = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const exportMarker = 'exports.inject = inject;'
// 注意：这里**不能**把表名直接摊进对象字面量——要经由 apply 之外的作用域闭包拿。
// 这些常量都在模块作用域，而 localeActive/localeT 是模块级的 let，所以注入
// 「读表 + 改语言」的函数即可（写成箭头函数，求值发生在调用时而非加载时）。
const testSurface = [
  'ABILITY_TABS',
  'SKILL_MODES',
  'SORT_LABELS',
  'ENTRY_LABELS',
  'SCOPE_LABELS',
  'SCOPE_LABEL_DETAILS',
  'MCP_PRESETS',
  // C2 的参数表单表：标签与提示存中文原文，渲染点 t(field.label) / t(field.hint)。
  // 和 MCP_PRESETS 一样，源码扫描看不见 `t(字段)`，所以必须显式登记进可达集。
  'TOOL_SEARCH_SETTING_FIELDS',
  'EN_DICT',
  't',
  'preservedView',
  'PRESERVED_VALUE_LABEL',
  'fromFormValue',
  'contentLocale',
].join(', ')
const instrumented = clientSource.replace(
  exportMarker,
  `${exportMarker}\nexports.__i18n = {
  ${testSurface},
  setLocaleActiveForTest: (value) => { localeActive = value },
  setLocaleTForTest: (value) => { localeT = value },
  getLocaleActiveForTest: () => localeActive,
  ensureLocaleWired: () => ensureLocaleWired(),
};`,
)

assert.notEqual(instrumented, clientSource, 'client test export marker must stay current')

function loadInstrumented() {
  const react = {
    Fragment: Symbol('Fragment'),
    createElement() {},
    useCallback: (fn) => fn,
    useEffect() {},
    useMemo: (fn) => fn(),
    useRef: (value) => ({ current: value }),
    useState: (value) => [value, () => {}],
  }
  let client
  const context = {
    console,
    // apply() 会经 __injectCss 碰 document（querySelector/createElement/head），
    // 接线用例要跑完整的 apply，所以这里给齐最小面（与 client-lifecycle 的假 document 同形）。
    document: {
      addEventListener() {},
      removeEventListener() {},
      querySelector: () => null,
      createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
      head: { appendChild() {}, removeChild() {} },
    },
    navigator: {},
    setInterval,
    setTimeout,
    clearInterval,
    clearTimeout,
    window: {
      isSecureContext: false,
      __ModuleLoader__: {
        load(definition) {
          client = definition.factory((name) => {
            assert.equal(name, 'react')
            return react
          })
        },
      },
    },
  }
  vm.runInNewContext(instrumented, context)
  return client
}

function loadI18n() {
  return loadInstrumented().__i18n
}

test('the locale tables hold Chinese source text, not a frozen translation', () => {
  const i18n = loadI18n()

  // 每一张表的取值都必须是**中文原文**（= EN_DICT 的键），而不是某种语言的译文。
  // 只要有人在建表时写回 t(...)，这里就会看到英文（因为加载时 localeActive 是 null，
  // 而 null 时 t() 返回中文……所以这里真正的判据是下面那条行为用例；
  // 这条负责钉住"表里的值确实是词典键"这个不变量）。
  const tableValues = [
    ...Object.values(i18n.SCOPE_LABELS),
    ...Object.values(i18n.SORT_LABELS),
    ...Object.values(i18n.ENTRY_LABELS),
    ...i18n.ABILITY_TABS.map((tab) => tab.label),
    ...i18n.SKILL_MODES.map((mode) => mode.label),
  ]
  for (const value of tableValues) {
    assert.equal(typeof value, 'string', `表里的标签必须是字符串：${String(value)}`)
  }
  // 「技能」「已安装」「发现市场」这三个是页签/模式层的可见文案，必须在词典里。
  for (const key of ['技能', '已安装', '发现市场']) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(i18n.EN_DICT, key),
      `词典缺少页签文案：${key}`,
    )
  }
})

test('switching the active locale flips every table-driven label', () => {
  const i18n = loadI18n()

  const render = (key) => i18n.t(key)

  // ① 中文（或没有 locale 服务）：原样中文
  i18n.setLocaleTForTest(null)
  i18n.setLocaleActiveForTest(null)
  assert.equal(render('技能'), '技能')
  assert.equal(render('已安装'), '已安装')

  // ② English：这些**表里的**文案必须跟着变
  i18n.setLocaleActiveForTest('en')
  assert.equal(render(i18n.ABILITY_TABS.find((tab) => tab.id === 'skills').label), 'Skills')
  assert.equal(render(i18n.SKILL_MODES.find((mode) => mode.id === 'manage').label), 'Installed')
  assert.equal(render(i18n.SKILL_MODES.find((mode) => mode.id === 'market').label), 'Market')
  assert.equal(render(i18n.SORT_LABELS.name), 'By name')
  assert.equal(render(i18n.SORT_LABELS.status), 'By status')
  assert.equal(render(i18n.SORT_LABELS.default), 'Default order')
  assert.equal(render(i18n.ENTRY_LABELS.fab), 'Floating button only')
  assert.equal(render(i18n.ENTRY_LABELS.sidebar), 'Sidebar entry only')
  assert.equal(render(i18n.ENTRY_LABELS.both), 'Floating button + sidebar entry')
  assert.equal(render(i18n.SCOPE_LABELS.custom), 'Custom directory')
  assert.equal(render(i18n.SCOPE_LABELS.bundled), 'Built-in (read-only)')
  assert.equal(render(i18n.SCOPE_LABELS['project-agents']), 'Project · .agents/skills')

  // ③ 再切回中文：必须回到中文（语言是**每次渲染读的**，不是一次性求值的）
  i18n.setLocaleActiveForTest('zh')
  assert.equal(render('技能'), '技能')
  assert.equal(render(i18n.SKILL_MODES.find((mode) => mode.id === 'market').label), '发现市场')
})

test('every label a table can produce is covered by the dictionary', () => {
  // 表里的值若不在词典里，界面就会漏出中文（t() 原样返回键）。
  // 例外是**刻意的**：路径片段与专有名词（'.dsh/skills'、'MCP'）本来就该原样显示。
  const i18n = loadI18n()
  const intentional = new Set(['.dsh/skills', '.agents/skills', 'MCP'])

  const reachable = [
    ...Object.values(i18n.SCOPE_LABELS),
    ...Object.values(i18n.SCOPE_LABEL_DETAILS),
    ...Object.values(i18n.SORT_LABELS),
    ...Object.values(i18n.ENTRY_LABELS),
    ...i18n.ABILITY_TABS.map((tab) => tab.label),
    ...i18n.SKILL_MODES.map((mode) => mode.label),
  ]

  const uncovered = reachable.filter(
    (key) => !Object.prototype.hasOwnProperty.call(i18n.EN_DICT, key) && !intentional.has(key),
  )
  assert.deepEqual(uncovered, [], '表里的这些文案没有英文，英文界面下会显示中文')
})

/**
 * 渲染路径上**直接** `t('中文')` 的那些键。
 *
 * 为什么单独扫一遍：上面的 parity 只覆盖表驱动标签，而 ToolSearch 那批最显眼的文案
 * （主按钮「全部延迟」/「取消全部延迟」、详情行、开启前预告）全是调用点上的字面量——
 * 审查轮实测英文界面下主按钮显示中文，而当时 712 个用例全绿。表驱动与调用点两条路都要 parity。
 *
 * 注释行整体剔除：注释里提到 `t('全部延迟')` 是行文，不是调用点（本仓库注释极多，
 * 不剔的话一堆散文会被当成键）。
 *
 * 键要做一次转义还原：扫到的是**源码字面量**（`C:\\path`），而 EN_DICT 是求过值的对象
 * （`C:\path`）。这些文案里只出现 `\\` 一种转义，所以一条 replace 就够。
 */
function calledTranslationKeys() {
  const code = clientSource.split('\n').map((line) => line.replace(/^\s*\/\/.*$/, '')).join('\n')
  return new Set([...code.matchAll(/\bt\(\s*'([^']*)'\s*[,)]/g)].map((match) => match[1].replace(/\\\\/g, '\\')))
}

test('every t() call-site key has an English entry, and the dictionary has no dead keys', () => {
  const i18n = loadI18n()
  const intentional = new Set(['.dsh/skills', '.agents/skills', 'MCP'])
  const tabled = [
    ...Object.values(i18n.SCOPE_LABELS),
    ...Object.values(i18n.SCOPE_LABEL_DETAILS),
    ...Object.values(i18n.SORT_LABELS),
    ...Object.values(i18n.ENTRY_LABELS),
    ...i18n.ABILITY_TABS.map((tab) => tab.label),
    ...i18n.SKILL_MODES.map((mode) => mode.label),
    ...i18n.MCP_PRESETS.map((preset) => preset.label),
    // C2 的参数表单：三个字段各有一条标签与一段实测依据，都在渲染点过 t()。
    ...i18n.TOOL_SEARCH_SETTING_FIELDS.flatMap((field) => [field.label, field.hint]),
  ]
  const reachable = new Set([
    ...calledTranslationKeys(),
    ...tabled,
    // 经命名常量到达的键：哨兵是**数据**（五处 `===` 判据靠它），显示时才 t(PRESERVED_VALUE_LABEL)。
    // 源码扫描看不见 `t(常量)`，所以这里显式补上。
    i18n.PRESERVED_VALUE_LABEL,
  ])

  const uncovered = [...reachable].filter(
    (key) => !Object.prototype.hasOwnProperty.call(i18n.EN_DICT, key) && !intentional.has(key),
  )
  assert.deepEqual(uncovered, [], '这些在用文案没有英文，英文界面下会漏出中文')

  // 键存在还不够：还得真的译得动。判据用 `t(key) !== key`（不重抄译文——
  //  那会把测试变成实现的复读机）。路径片段与专有名词刻意恒等，已在 intentional 里。
  i18n.setLocaleActiveForTest('en')
  try {
    const untranslated = [...reachable].filter(
      (key) => !intentional.has(key) && Object.prototype.hasOwnProperty.call(i18n.EN_DICT, key) && i18n.t(key) === key,
    )
    assert.deepEqual(untranslated, [], '这些词条在英文界面下译不出东西（译文与中文原文相同）')
  } finally {
    i18n.setLocaleActiveForTest(null)
  }

  // 反方向同样要守：词典里没有调用点的词条是死词条。它们不会让任何测试变红，
  // 只会在下次"照着旧词条改文案"时把人引向一个已经不存在的字符串。
  const dead = Object.keys(i18n.EN_DICT).filter((key) => !reachable.has(key))
  assert.deepEqual(dead, [], '词典里这些词条没有任何调用点，是死词条')
})

test('preset templates store source text and translate only at the render site', () => {
  // 预设模板表（MCP_PRESETS）与页签表是同一类缺陷形态，别分开修：
  // 表里写 `label: t('Filesystem · 本地文件读写')` 时，t() 在 bundle 加载那一刻求值，
  // 而 localeActive 要等 apply() 接线才知道——语言被冻在加载时，英文界面下整个预设
  // 下拉显示中文（译文明明在词典里，却永远走不到）。
  // 契约与页签表一致：**表里存中文原文，渲染处 t(...)**。
  const i18n = loadI18n()
  assert.ok(Array.isArray(i18n.MCP_PRESETS) && i18n.MCP_PRESETS.length > 0, '找不到 MCP_PRESETS')

  // ① 表里的标签必须是词典键（中文原文），且英文在渲染点可达
  for (const preset of i18n.MCP_PRESETS) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(i18n.EN_DICT, preset.label),
      `预设标签不在词典里（英文界面会漏中文）：${preset.label}`,
    )
  }
  i18n.setLocaleActiveForTest('en')
  for (const preset of i18n.MCP_PRESETS) {
    assert.notEqual(i18n.t(preset.label), preset.label, `预设标签英文不可达：${preset.label}`)
  }
  i18n.setLocaleActiveForTest(null)

  // ② 表定义里不得求值 t()（值位置求值 = 冻在加载时）
  const tableStart = clientSource.indexOf('const MCP_PRESETS = [')
  assert.ok(tableStart > 0, '找不到 MCP_PRESETS 的定义')
  const tableBody = clientSource.slice(tableStart, clientSource.indexOf('\n]', tableStart))
  assert.doesNotMatch(tableBody, /\bt\(/, 'MCP_PRESETS 表里不得求值 t()：存中文原文，翻译放渲染点')

  // ③ 渲染点必须过 t()——这条是缺陷的精确闸门：直接画 p.label 就红
  assert.match(
    clientSource,
    /MCP_PRESETS\.map\(\(p\) => h\('option', \{ key: p\.id, value: p\.id \}, t\(p\.label\)\)\)/,
    '预设下拉的渲染点必须 t(p.label)：直接画 p.label 会让英文界面显示表里的中文原文',
  )
})

test('the shared segment control translates labels at render time', () => {
  // ⚠️ 这条是**行为缺陷的精确闸门**，别删。
  //
  // 真机缺陷的成因不是「表里写了 t()」——表里写不写 t() 都不致命：
  // 加载时 localeActive 是 null，t() 返回中文原文，渲染时再过一次 t() 照样能翻。
  // 致命的是**渲染路径上根本没有 t()**：seg() 直接渲染 item.label，于是表里是什么就画什么。
  // 所以判据必须钉在 seg 的渲染点上。
  const segStart = clientSource.indexOf('const seg = (items, active, onSelect, label)')
  assert.ok(segStart > 0, '找不到 seg() 的定义')
  const segBody = clientSource.slice(segStart, clientSource.indexOf('ABILITY_TABS.map', segStart))

  assert.match(
    segBody,
    /t\(item\.label\)/,
    'seg() 必须把 item.label 过 t()：能力层与模式层都靠这一个渲染点，'
      + '直接画 item.label 会让页签在任何语言下都停在表里的原文（真机缺陷）。',
  )
  assert.doesNotMatch(
    segBody,
    /^\s*item\.label,\s*$/m,
    'seg() 不得直接渲染未翻译的 item.label',
  )
})

test('no translation is evaluated at module scope', () => {
  // 形状闸：顶层**数据**声明（顶格 const/let/var）的初始区间里不得出现**值位置**的 t(...)。
  // 渲染路径上的 t() 都在函数体里，求值在调用时。
  //
  // ⚠️ 判据必须覆盖**多行声明**：预设表是
  //     const MCP_PRESETS = [
  //       { id: 'filesystem', label: t('Filesystem · 本地文件读写'), … },
  //     ]
  // t() 在续行里，只查首行会整表漏掉——预设下拉的缺陷正是这么漏进来的。
  // 顶层声明体用括号配平跟踪（首行开括号 → 深度回 0 收尾）。
  //
  // 两类区间**整体放行**（求值都在调用时，不是加载时）：
  //   ① 函数型顶层声明：const ToolRow = ({ tool }) => { … }、const f = function () { … }；
  //   ② 数据声明里嵌套的函数体：const MCP_CONTRIBUTION = { …, apply(ctx) { … } }。
  // 用「函数区深度标记」实现：见到 => 或 function 记下当前深度，深度掉回去之前不判。
  const isFunctionInitializer = (line) => {
    const eq = line.indexOf('=')
    if (eq < 0) return false
    return /^\s*(?:async\s+)?(?:function\b|\()/.test(line.slice(eq + 1))
      || /^\s*[A-Za-z_$][\w$]*\s*=>/.test(line.slice(eq + 1))
  }
  const isValuePositionT = (line) => {
    const re = /\bt\(/g
    let m
    while ((m = re.exec(line))) {
      const before = line.slice(0, m.index).trimEnd()
      if (before.endsWith('=>') || before.endsWith('return')) continue
      if (/\bfunction\b[^(]*$/.test(before)) continue
      if (/(?:[:=,[(+]|\breturn\s)$/.test(before)) return true
    }
    return false
  }
  const offenders = []
  let inSpan = false
  let isFnSpan = false
  let fnFloor = null
  let depth = 0
  clientSource.split('\n').forEach((line, index) => {
    if (!inSpan) {
      if (!/^(?:const|let|var)\s/.test(line)) return
      inSpan = true
      isFnSpan = isFunctionInitializer(line)
      fnFloor = null
      depth = 0
    } else if (!isFnSpan && fnFloor === null && /=>|\bfunction\b/.test(line)) {
      fnFloor = depth // 进入嵌套函数体：记下入口深度，掉出去之前不判
    }
    if (!isFnSpan && fnFloor === null && isValuePositionT(line)) {
      offenders.push(`${index + 1}: ${line.trim().slice(0, 110)}`)
    }
    for (const ch of line) {
      if (ch === '(' || ch === '[' || ch === '{') depth += 1
      else if (ch === ')' || ch === ']' || ch === '}') depth -= 1
    }
    if (fnFloor !== null && depth < fnFloor) fnFloor = null // 函数体结束，恢复判罚
    if (depth <= 0) inSpan = false
  })
  assert.deepEqual(
    offenders,
    [],
    '模块级不得求值 t()：那会把语言锁死在 bundle 加载那一刻（页签/预设停在中文的成因）。'
      + '请改成「表里存中文原文，在渲染处 t(item.label)」。',
  )
})

test('copy punctuation goes through the dictionary, and scope checks use data', () => {
  // ① 裸拼接的中文标点（'（' / '）' / '：' / join('、')）在英文界面会漏出全角字符：
  //    'Sort：Default order'、'Add MCP（MyProject）'、'serverA、serverB'。
  //    标点是文案的一部分，必须走词典（'：' → ': '、'（{name}）' → ' ({name})'、'、' → ', '）。
  //    括号一律用整句 '（{name}）'：中英语序不同，碎片拼接等于把语序写死在代码里。
  assert.doesNotMatch(
    clientSource,
    /\+ '（'|\+ '）'|\+ '：'|\.join\('、'\)/,
    '不得裸拼接中文标点：包一层 t()，括号用整句 t(\'（{name}）\')',
  )
  // ② 不得用**显示文案**当判据：scopeName !== t('全局') 依赖两边调同一个 t()，
  //    用户把工作区命名成「全局」就误判。判据用数据（scope !== 'global'）。
  assert.doesNotMatch(
    clientSource,
    /!== t\('全局'\)|=== t\('全局'\)/,
    '作用域判据必须用数据（scope !== \'global\'），不能比显示文案',
  )
  // ③ BCP 47 用连字符、部分宿主用下划线（en_US）：只切 '-' 会把 en_US 判成非英文。
  assert.match(clientSource, /split\(\/\[-_\]\/\)\[0\] === 'en'/, 'localeIsEnglish 必须同时认 en-US 与 en_US')
})

test('every slot registration passes its label as a thunk', () => {
  // 宿主的 SlotLabel 契约是 `string | (() => string)`，侧栏逐读条目时调
  // resolveSlotLabel 解析（且订阅 locale 变化重解，见 ui-sidebar 的
  // `ctx.locale.subscribe(syncPanels)`）。所以 label 必须是 thunk：
  // 写成求值好的 `label: t('工具箱')` 会把语言冻在插件加载那一刻——组件侧的文字
  // 靠 outlet 在语言切换时重渲染来刷新（scoped-slots 的 useLocaleRevision：
  // 「Every outlet re-renders on a locale switch」），而 slot label 没有第二次
  // 求值机会，只能靠 thunk。
  const registrations = clientSource.match(/ctx\.slots\.register\(\{[^}]*\}/g) ?? []
  assert.equal(registrations.length, 3, '应有三处 slot 注册（mcp-fab / mcp-handover / sidebar.footer.action）')
  for (const registration of registrations) {
    assert.match(
      registration,
      /label: \(\) => t\('/,
      `slot 注册的 label 必须是 thunk（() => t('…')）：${registration.slice(0, 80)}`,
    )
  }
})

/**
 * 忠实模拟宿主 LocaleRuntime 的**回落链**语义（deepseek-harness 的
 * packages/client/locale/src/client/index.ts）：目录里 zh 的 fallback 是 en，
 * fallbackChain 末尾还强制追加 FALLBACK_LOCALE='en'——所以中文模式的查找链是
 * ['zh','en']，zh 未命中就**落到 en**。
 *
 * 为什么必须模拟这条链：旧假 bind 在非 en 时原样返回键，于是「只注册 en 一份词典」
 * 这个真机缺陷（DSH 设中文 → 宿主按链落到我们的英文词典 → 整片面板英文）可以
 * 全绿通过。链不模拟，就等于没测宿主真正的解析行为。
 */
function createFakeLocale(initialActive = 'zh') {
  const catalog = new Map([['zh', { id: 'zh', fallback: 'en' }], ['en', { id: 'en' }]])
  const dicts = new Map() // ns → Map(locale → dict)
  const state = { active: initialActive }
  const calls = { register: [], bind: [], getLocale: 0, subscribe: [] }
  const chainOf = (start) => {
    const chain = []
    const seen = new Set()
    let current = catalog.get(start)
    while (current !== undefined && !seen.has(current.id)) {
      seen.add(current.id)
      chain.push(current.id)
      current = current.fallback === undefined ? undefined : catalog.get(current.fallback)
    }
    if (!seen.has('en')) chain.push('en')
    return chain
  }
  return {
    calls,
    switchTo(next) {
      state.active = next
      for (const fn of [...calls.subscribe]) fn()
    },
    service: {
      register(ns, localeOrDicts, dict) {
        const pairs = typeof localeOrDicts === 'string'
          ? [[localeOrDicts, dict]]
          : Object.entries(localeOrDicts)
        const perNs = dicts.get(ns) ?? new Map()
        for (const [locale, entries] of pairs) {
          if (perNs.has(locale)) throw new Error(`locale namespace "${ns}" already has locale "${locale}"`)
          perNs.set(locale, entries)
        }
        dicts.set(ns, perNs)
        calls.register.push([
          ns,
          typeof localeOrDicts === 'string' ? [localeOrDicts] : Object.keys(localeOrDicts),
          typeof localeOrDicts === 'string' ? dict : localeOrDicts,
        ])
        return () => {} // 源码契约：register 返回 idempotent disposer
      },
      bind(ns) {
        calls.bind.push(ns)
        return (key) => {
          for (const locale of chainOf(state.active)) {
            const value = dicts.get(ns)?.get(locale)?.[key]
            if (value !== undefined) return value
          }
          return key
        }
      },
      getLocale() {
        calls.getLocale += 1
        return { active: state.active, revision: 1 }
      },
      subscribe(fn) {
        calls.subscribe.push(fn)
        return () => {}
      },
    },
  }
}

test('apply() wires the locale service once, and Chinese stays Chinese', async () => {
  // 接线路径的覆盖 + **中文模式回归闸门**。按宿主 LocaleRuntime 源码契约造假
  // （见 createFakeLocale 的回落链），钉住六件事：
  //   ① register 收到**中英两份**词典——只注册 en 时，中文模式下宿主按 ['zh','en']
  //      链落到英文词典，整片面板变英文（真机事故：DSH 设中文，面板除了走数据的
  //      分类标签全是英文）。平台的 register 契约也要求双语平衡。
  //   ② 中文模式下 t() 返回中文原文（恒等命中，不落到英文）；
  //   ③ 切英文时 t() 返回英文，且 localeActive 跟着变（组件重渲染的根源：宿主每个
  //      outlet 都会在 locale revision 变化时重渲染）；
  //   ④ ctx.effect 的工厂返回**函数**——cordis 对非函数、非 null、又无 then/iterator
  //      的 effect 返回值抛 TypeError("Invalid effect")，会被 catch 静默吞掉、
  //      整段接线无声降级。register 返回 disposer 是源码契约，工厂必须传递它；
  //   ⑤ 宿主没有 locale 服务时整段跳过、t() 退化成恒等（没有语言服务 = 原文）；
  //   ⑥ 词典只注册一次（重复注册会被宿主拒绝）。
  const locale = createFakeLocale('zh')
  const effectReturns = []
  const makeCtx = (localeService) => ({
    remote: { async $mount() { return async () => {} } },
    slots: { inject() {} },
    get(name) { return name === 'locale' ? localeService : undefined },
    effect(factory) {
      const produced = factory()
      effectReturns.push(produced)
      return () => {}
    },
  })

  const client = loadInstrumented()
  const dispose = await client.apply(makeCtx(locale.service))
  try {
    // ① 中英两份，各只注册一次
    assert.equal(locale.calls.register.length, 1, '词典必须只注册一次（重复注册会被宿主拒绝）')
    assert.deepEqual(locale.calls.register[0].slice(0, 2), ['dsh-toolbox-ui', ['zh', 'en']])
    assert.equal(locale.calls.register[0][2].en, client.__i18n.EN_DICT, '英文必须是自带词典对象本身')
    assert.equal(locale.calls.register[0][2].zh['技能'], '技能', '中文那份是恒等词典（键即原文）')
    // ② 中文模式：恒等命中 → 中文（**只注册 en 的旧代码会在这里返回英文**）
    assert.equal(client.__i18n.getLocaleActiveForTest(), 'zh')
    assert.equal(client.__i18n.t('技能'), '技能', 'DSH 是中文时面板必须是中文——宿主的回落链会落到已注册的英文词典')
    // ③ 切英文
    locale.switchTo('en')
    assert.equal(client.__i18n.getLocaleActiveForTest(), 'en')
    assert.equal(client.__i18n.t('技能'), 'Skills')
    locale.switchTo('zh')
    assert.equal(client.__i18n.t('技能'), '技能')
    // ④ effect 工厂返回值必须是函数
    assert.ok(
      effectReturns.length >= 2 && effectReturns.every((value) => typeof value === 'function'),
      'locale 接线的 ctx.effect 工厂必须返回 disposer 函数',
    )
    // ⑤ 宿主没有 locale 服务：apply 照常完成，t() 恒等回中文
    const bare = loadInstrumented()
    const bareDispose = await bare.apply(makeCtx(undefined))
    try {
      assert.equal(bare.__i18n.getLocaleActiveForTest(), null)
      assert.equal(bare.__i18n.t('技能'), '技能')
    } finally {
      await bareDispose()
    }
  } finally {
    await dispose()
  }
})

test('a locale service that appears after apply() is picked up when the panel mounts', async () => {
  // 桌面壳的真机形态：locale 插件的 apply 要等原生桥（`__DSH_LOCALE__.read()` 是
  // 异步的），provide 晚于我们的 apply——ctx.get('locale') 当场是 null。真机表现：
  // 桌面版面板恒中文、在设置里切语言也不跟随（web 没有这座桥、同步 provide，
  // 所以 web 一直是好的）。不能改用 inject 声明依赖：宿主没有 locale 插件时
  // inject 会让 fiber 保持 inactive，整个面板直接不出现。所以 apply 探一次、
  // 面板挂载时重探。
  const late = createFakeLocale('zh')
  let available = null // 先没有，晚点到
  const effectReturns = []
  const ctx = {
    remote: { async $mount() { return async () => {} } },
    slots: { inject() {} },
    get(name) { return name === 'locale' ? available : undefined },
    effect(factory) {
      const produced = factory()
      effectReturns.push(produced)
      return () => {}
    },
  }

  const client = loadInstrumented()
  const dispose = await client.apply(ctx)
  try {
    // apply 时探不到：没接线、恒等中文
    assert.equal(late.calls.register.length, 0, '探不到服务时不得注册')
    assert.equal(client.__i18n.getLocaleActiveForTest(), null)
    assert.equal(client.__i18n.t('技能'), '技能')

    // 桌面壳的异步 provide 在面板挂载前完成
    available = late.service
    client.__i18n.ensureLocaleWired()

    assert.equal(late.calls.register.length, 1, '重探必须补上词典注册')
    assert.deepEqual(late.calls.bind, ['dsh-toolbox-ui'], '重探必须重新 bind')
    assert.equal(client.__i18n.getLocaleActiveForTest(), 'zh')
    assert.equal(client.__i18n.t('技能'), '技能')
    // 补接之后切语言也跟上了
    late.switchTo('en')
    assert.equal(client.__i18n.t('技能'), 'Skills')

    // 幂等：再次调用不会重复注册（宿主对重复 (ns, locale) 直接抛）
    client.__i18n.ensureLocaleWired()
    assert.equal(late.calls.register.length, 1, '补接必须幂等')
  } finally {
    await dispose()
  }
})

test('the preserved-value sentinel stays language-independent but renders translated', () => {
  const i18n = loadI18n()
  const sentinel = i18n.PRESERVED_VALUE_LABEL

  // 哨兵本身恒为中文原文：它是**数据**（要 `===` 比较、要还原成 REDACTED_VALUE 送回宿主），
  // 一旦随语言变化，英文界面下编辑一次表单就会把它当作用户手输的字面量写进配置。
  assert.equal(sentinel, '••••••（保留原值）')

  // 但**显示**形态要跟语言走。
  i18n.setLocaleActiveForTest('en')
  assert.equal(i18n.preservedView(), '•••••• (keep existing value)')
  // 并且两种形态都要能还原（用户碰过字段后 state 里可能是显示形态）。
  assert.equal(i18n.fromFormValue(sentinel), '__DSH_MCP_REDACTED__')
  assert.equal(i18n.fromFormValue(i18n.preservedView()), '__DSH_MCP_REDACTED__')
  // 真实用户输入不能被误判成哨兵。
  assert.equal(i18n.fromFormValue('sk-live-abc'), 'sk-live-abc')

  i18n.setLocaleActiveForTest('zh')
  assert.equal(i18n.preservedView(), '••••••（保留原值）')
})

test('market copy stays Chinese by default and only follows an explicit "en"', async () => {
  // 市场条目的文案来自上游的**两份字段**（description 是发布方原文、description_zh 是平台中文版）。
  // 约束（用户明确要求）：**中文默认不能变**。所以：
  //   · 不传 locale（老面板 / 中文界面）→ 与改前逐字节一致，仍优先 _zh；
  //   · 传 'en' → 才取发布方原文；
  //   · 缺字段时双向回落，绝不给出空文案。
  const { normalizeHubSkill, hubSkillDetail } = await import('../lib/skillhub.js')

  const both = { slug: 'x', name: 'N', description: 'English text', description_zh: '中文文本' }
  assert.equal(normalizeHubSkill(both).summary, '中文文本', '默认必须是中文（改前行为）')
  assert.equal(normalizeHubSkill(both, 'zh').summary, '中文文本')
  assert.equal(normalizeHubSkill(both, 'en').summary, 'English text')
  assert.equal(normalizeHubSkill(both, 'en-US').summary, 'English text', '带地区的 en 也算英文')

  // 只有中文（发布方本来就用中文写）：英文侧回落，不能变空
  assert.equal(normalizeHubSkill({ slug: 'y', description_zh: '只有中文' }, 'en').summary, '只有中文')
  // 只有原文：中文侧回落（改前就是靠 `||` 回落的，行为不变）
  assert.equal(normalizeHubSkill({ slug: 'z', description: 'only english' }).summary, 'only english')

  // 详情走同一条规则（summary / summary_zh）。
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ skill: { summary: 'English summary', summary_zh: '中文摘要' } }),
  })
  assert.equal((await hubSkillDetail('s', { fetch: fakeFetch })).summary, '中文摘要', '详情默认也是中文')
  assert.equal((await hubSkillDetail('s', { fetch: fakeFetch, locale: 'en' })).summary, 'English summary')
})

test('the client only sends a locale when it is English', () => {
  // 送给宿主的字段必须**只在英文时才出现**：缺省即中文优先，所以中文路径连字段都不带，
  // 这样「中文默认不变」在 wire 上就是显然的，而不是靠宿主那边的默认值兜。
  const i18n = loadI18n()
  assert.equal(typeof i18n.contentLocale, 'function', 'client 需要暴露 contentLocale()')

  i18n.setLocaleActiveForTest(null)
  assert.equal(i18n.contentLocale(), undefined, '没有 locale 服务 → 不带字段')
  i18n.setLocaleActiveForTest('zh')
  assert.equal(i18n.contentLocale(), undefined, '中文 → 不带字段')
  i18n.setLocaleActiveForTest('en')
  assert.equal(i18n.contentLocale(), 'en')
  i18n.setLocaleActiveForTest('en-GB')
  assert.equal(i18n.contentLocale(), 'en')
})
