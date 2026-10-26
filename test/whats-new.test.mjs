import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { WHATS_NEW } from '../lib/whats-new.js'

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const clientSource = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

// 这里比较的是本仓库自己的 `x.y.z` 版本号（预发布只在开发基线里出现，不进 WHATS_NEW）。
function compare(left, right) {
  const a = left.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const b = right.split('.').map((part) => Number.parseInt(part, 10) || 0)
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const delta = (a[i] || 0) - (b[i] || 0)
    if (delta !== 0) return delta
  }
  return 0
}

test('the newest whats-new entry matches the package version', () => {
  // 发布闸门：bump 了版本却没写「变了什么、在哪找」，本地就红。这条断言就是这次加这个
  // 提示的根因治理——新功能没人发现，通常不是提示做得不好，而是压根没写。
  assert.ok(WHATS_NEW.length > 0, 'WHATS_NEW 不能为空')
  assert.equal(WHATS_NEW[WHATS_NEW.length - 1].version, packageJson.version)
})

test('newest whats-new entry and its release notes describe the same things', async () => {
  // 发布闸门之二：`release.yml` 推 tag 时拿 `.github/release-notes/v<version>.md` 当 Release 正文，
  // 面板「更新提示」拿 WHATS_NEW——两处说的必须是同一件事。此前只测"文件存在"，于是可以把一条
  // 新说明追挂到**已发布**的版本下而不被发现（本轮真犯过，见 OPEN-ITEMS 的 O9 处置）。
  // 对账按**加粗小标题**：它是每条说明的语义锚点，改写措辞不影响，换一件事就会红。
  const newest = WHATS_NEW[WHATS_NEW.length - 1]
  const notes = await readFile(new URL(`../.github/release-notes/v${newest.version}.md`, import.meta.url), 'utf8')
  for (const item of newest.items) {
    const text = typeof item.text === 'string' ? item.text : item.text.zh
    const headline = text.match(/\*\*(.+?)\*\*/)?.[1]
    assert.ok(headline !== undefined, `条目缺加粗小标题，无法与 release notes 对账：${text.slice(0, 40)}`)
    assert.ok(notes.includes(headline), `release notes 缺少面板提示里的这条：「${headline}」`)
  }
})

test('whats-new entries are append-only, ordered and well formed', () => {
  const versions = WHATS_NEW.map((entry) => entry.version)
  assert.equal(new Set(versions).size, versions.length, '版本不能重复')
  // 客户端按数组顺序切片：把新版本插到前面会让升级者什么都看不到，所以顺序是语义。
  for (let i = 1; i < versions.length; i += 1) {
    assert.ok(compare(versions[i - 1], versions[i]) < 0, `${versions[i - 1]} 必须早于 ${versions[i]}`)
  }
  // 双语形状（DSH 的 LocalizedText：string | { en, ...locale }）：text / where 要么是
  // 非空字符串，要么 { zh, en } 两份都非空。英文缺席的条目在英文界面会回落中文——
  // 那是允许的（回落链），但**卷到一半**不允许：新条目必须双语齐全。
  const assertLocalized = (value, label) => {
    if (typeof value === 'string') {
      assert.ok(value.length > 0, `${label} 不能是空字符串`)
      return
    }
    assert.ok(value && typeof value === 'object', `${label} 必须是字符串或 { zh, en }`)
    assert.ok(typeof value.zh === 'string' && value.zh.length > 0, `${label} 缺中文`)
    assert.ok(typeof value.en === 'string' && value.en.length > 0, `${label} 缺英文`)
  }
  for (const entry of WHATS_NEW) {
    assert.ok(Array.isArray(entry.items) && entry.items.length > 0, `${entry.version} 没有任何条目`)
    for (const item of entry.items) {
      assertLocalized(item.text, `${entry.version} 有条目缺少文案`)
      if (item.where !== undefined) assertLocalized(item.where, `${entry.version} 的 where 不合法`)
    }
  }
})

test('the notice renders the entry copy in the active language', async () => {
  // 渲染点必须过 localized()：直接画 item.text 会让英文界面冒出 {zh,en} 对象或中文。
  // localized 的行为（中文默认、显式英文才出英文、缺席回落）由这条钉住。
  const { localized, setLocaleActiveForTest } = loadClientRule()
  setLocaleActiveForTest(null)
  assert.equal(localized('纯字符串'), '纯字符串')
  assert.equal(localized({ zh: '中文', en: 'English' }), '中文')
  assert.equal(localized({ en: 'only en' }), 'only en', '缺中文时回落英文')
  assert.equal(localized(undefined), '')
  setLocaleActiveForTest('en')
  assert.equal(localized({ zh: '中文', en: 'English' }), 'English')
  assert.equal(localized({ zh: '只有中文' }), '只有中文', '缺英文时回落中文')
  setLocaleActiveForTest('zh')
})

test('whatsNew RPC reports the running version and the source entries', async () => {
  // 宿主只转发：当前版本来自 package.json（唯一真源），条目来自 lib/whats-new.js（唯一真源）。
  const { McpManagerGateway } = await import('../lib/index.js')
  const result = await McpManagerGateway.prototype.whatsNew.call({ ctx: {} })
  assert.equal(result.current, packageJson.version)
  assert.deepEqual(result.entries, WHATS_NEW)
})

// 客户端判定是纯函数，但它在 bundle 里（组件无法在 node 里渲染），所以沿用
// client-behavior/client-entry 的注入手法：把纯函数挂到 __test 上直接调。
const exportMarker = 'exports.inject = inject;'
const instrumentedClient = clientSource.replace(
  exportMarker,
  `${exportMarker}\nexports.__whatsNew = { WHATS_NEW_SEEN_KEY, whatsNewFor, localized, setLocaleActiveForTest: (value) => { localeActive = value } };`,
)
assert.notEqual(instrumentedClient, clientSource, 'client test export marker must stay current')

function loadClientRule() {
  const react = {
    Fragment: Symbol('Fragment'),
    createElement() {},
    useCallback() {},
    useEffect() {},
    useMemo: (factory) => factory(),
    useRef: (value) => ({ current: value }),
    useState: (value) => [value, () => {}],
  }
  let client
  vm.runInNewContext(instrumentedClient, {
    console,
    document: { addEventListener() {}, removeEventListener() {} },
    navigator: {},
    setInterval,
    setTimeout,
    clearInterval,
    clearTimeout,
    window: {
      __ModuleLoader__: {
        load(definition) {
          client = definition.factory((name) => {
            assert.equal(name, 'react')
            return react
          })
        },
      },
    },
  })
  return client.__whatsNew
}

// 跨 realm 的数组不能直接 deepStrictEqual（原型不同），所以比对版本文本。
const versionsOf = (entries) => Array.from(entries, (entry) => entry.version).join(',')

test('the update notice reports what changed since the last confirmed version', () => {
  const { whatsNewFor } = loadClientRule()
  const entries = [
    { version: '1.0.0', items: [{ text: 'a' }] },
    { version: '1.1.0', items: [{ text: 'b' }] },
    { version: '1.2.0', items: [{ text: 'c' }] },
  ]
  assert.equal(versionsOf(whatsNewFor('1.2.0', '1.2.0', entries)), '', '同一版本不重复提示')
  assert.equal(versionsOf(whatsNewFor('1.2.0', '1.1.0', entries)), '1.2.0')
  // 跨版本升级不漏：中间跳过的版本一起报。
  assert.equal(versionsOf(whatsNewFor('1.2.0', '1.0.0', entries)), '1.1.0,1.2.0')
})

test('an unrecorded or unrecognised last-seen version reports only the current release', () => {
  const { whatsNewFor } = loadClientRule()
  const entries = [
    { version: '1.0.0', items: [{ text: 'a' }] },
    { version: '1.1.0', items: [{ text: 'b' }] },
  ]
  // 新装，以及"从还没有这个提示功能的版本升上来"——两者分不出来，而后者正是要覆盖的人，
  // 所以只报当前这一条：不满屏倒历史，也不会漏掉这次到底变了什么。
  assert.equal(versionsOf(whatsNewFor('1.1.0', null, entries)), '1.1.0')
  assert.equal(versionsOf(whatsNewFor('1.1.0', '0.9.0', entries)), '1.1.0')
  // 降级（记录比当前新）：不报历史，函数也不崩。
  assert.equal(versionsOf(whatsNewFor('1.1.0', '9.9.9', entries)), '1.1.0')
  // 当前版本没有条目时也不崩：发布闸门（上一组断言）会拦住这种状况，这里只要求函数安全 ——
  // 它仍然报出「上次那版之后我们知道的全部」，宁可多报一条也不静默吞掉。
  assert.equal(versionsOf(whatsNewFor('2.0.0', '1.0.0', entries)), '1.1.0')
  assert.equal(versionsOf(whatsNewFor('2.0.0', null, entries)), '')
  assert.equal(versionsOf(whatsNewFor(undefined, '1.0.0', entries)), '')
  assert.equal(versionsOf(whatsNewFor('1.1.0', '1.0.0', [])), '')
})

test('the notice is decided by the pure rule and only recorded when dismissed', () => {
  // 组件渲染不了，所以接线只能钉源码。落盘时机是关键：在「显示时」落盘会把用户没看到的
  // 提示直接吞掉（下次不再提示），只有「确认关闭」才代表看过了。
  assert.match(clientSource, /call\('whatsNew'\)/)
  assert.match(clientSource, /whatsNewFor\(res\.current, seen, res\.entries\)/)
  assert.match(clientSource, /localStorage\.getItem\(WHATS_NEW_SEEN_KEY\)/)
  assert.match(clientSource, /localStorage\.setItem\(WHATS_NEW_SEEN_KEY, notice\.current\)/)
})

test('the notice is triggered by opening the panel, not by loading the page', () => {
  // 它是面板的弹层：和添加 MCP / 导入 JSON 挂在同一处，由面板挂载/卸载决定生死。
  // 挂到 shell.overlay 那个座位上（页面加载就挂载）会变成升级后首次启动被弹框挡住，
  // 而且提示的本来就是面板里多出来的东西，在面板里说才用得上。
  assert.match(clientSource, /h\(JsonImportModal,[\s\S]{0,400}?h\(WhatsNewModal, \{ call \}\)/)
  assert.match(clientSource, /const WhatsNewModal = \(\{ call \}\) =>/)
  assert.doesNotMatch(clientSource, /seats[\s\S]{0,200}WhatsNewModal/)
})

test('the notice renders entry copy through localized(), never the raw value', () => {
  // 条目是 { zh, en } 数据：直接画 item.text 会让英文界面冒出对象或中文。
  // 判据钉在渲染点上（函数行为由上面那条钉，这里钉「渲染点真的用了它」）。
  assert.match(clientSource, /localized\(item\.text\)/, 'WhatsNewModal 必须过 localized(item.text)')
  assert.match(clientSource, /localized\(item\.where\)/, 'WhatsNewModal 必须过 localized(item.where)')
  assert.doesNotMatch(clientSource, /item\.text,\s*\n/, '不得直接渲染 item.text')
})
