import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const clientSource = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const exportMarker = 'exports.inject = inject;'
const instrumentedClient = clientSource.replace(
  exportMarker,
  `${exportMarker}\nexports.__test = { MCP_CSS, MCP_PRESETS, ToolRow, WorkspaceCopyModal, clearRevealState, consumeRevision, copyText, copyPlanText, copyPlanKey, copyPlanReady, copyTargets, exportFileName, firstFailureReason, selectedSkillRow, skillIdentity, startVisibilityAwarePolling, wsSub };`,
)

assert.notEqual(instrumentedClient, clientSource, 'client test export marker must stay current')

function loadClientInternals(execCommand) {
  const bodyChildren = []
  const body = {
    appendChild(node) {
      bodyChildren.push(node)
      node.isConnected = true
    },
    removeChild(node) {
      const index = bodyChildren.indexOf(node)
      if (index >= 0) bodyChildren.splice(index, 1)
      node.isConnected = false
    },
  }
  const document = {
    body,
    execCommand,
    createElement(name) {
      assert.equal(name, 'textarea')
      return {
        style: {},
        value: '',
        isConnected: false,
        select() {},
        remove() {
          body.removeChild(this)
        },
      }
    },
  }
  const react = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children }
    },
    useCallback(callback) {
      return callback
    },
    useEffect() {},
    useMemo(factory) {
      return factory()
    },
    useRef(value) {
      return { current: value }
    },
    useState(value) {
      return [value, () => {}]
    },
  }
  let client
  const window = {
    isSecureContext: false,
    __ModuleLoader__: {
      load(definition) {
        client = definition.factory((name) => {
          assert.equal(name, 'react')
          return react
        })
      },
    },
  }
  vm.runInNewContext(instrumentedClient, {
    console,
    document,
    navigator: {},
    setInterval,
    setTimeout,
    clearInterval,
    clearTimeout,
    window,
  })
  return { bodyChildren, internals: client.__test }
}

test('reveal revision consumption ignores initial and unchanged values', () => {
  const { internals } = loadClientInternals(() => true)
  const ref = { current: '' }

  assert.equal(internals.consumeRevision(ref, undefined), false)
  assert.equal(ref.current, '')
  assert.equal(internals.consumeRevision(ref, 'profile-a'), false)
  assert.equal(ref.current, 'profile-a')
  assert.equal(internals.consumeRevision(ref, 'profile-a'), false)
  assert.equal(internals.consumeRevision(ref, 'profile-b'), true)
  assert.equal(ref.current, 'profile-b')
})

test('clearing reveal state invalidates pending loads and drops plaintext', () => {
  const { internals } = loadClientInternals(() => true)
  const generation = { current: 4 }
  const updates = []
  const busy = []

  internals.clearRevealState(generation, (value) => updates.push(value), (value) => busy.push(value))

  assert.equal(generation.current, 5)
  assert.equal(updates.length, 1)
  assert.deepEqual(Object.keys(updates[0]), [])
  assert.deepEqual(busy, [''])
})

test('clipboard fallback reports a false execCommand result as failure', async () => {
  const { bodyChildren, internals } = loadClientInternals(() => false)

  assert.equal(await internals.copyText('secret'), false)
  assert.equal(bodyChildren.length, 0)
})

test('clipboard fallback always removes its temporary plaintext textarea', async () => {
  const { bodyChildren, internals } = loadClientInternals(() => {
    throw new Error('clipboard blocked')
  })

  assert.equal(await internals.copyText('secret'), false)
  assert.equal(bodyChildren.length, 0)
})

test('time preset uses the official uvx package', () => {
  const { internals } = loadClientInternals(() => true)
  const preset = internals.MCP_PRESETS.find((item) => item.id === 'time')

  assert.equal(preset.command, 'uvx')
  assert.deepEqual(Array.from(preset.args), ['mcp-server-time'])
})

test('schema-less tools are static rows instead of inert keyboard buttons', () => {
  const { internals } = loadClientInternals(() => true)
  const row = internals.ToolRow({ tool: { name: 'plain', description: '', parameters: null } })
  const head = row.children[0]

  assert.equal(head.props.role, undefined)
  assert.equal(head.props.tabIndex, undefined)
  assert.equal(head.props.onClick, undefined)
  assert.equal(head.props.onKeyDown, undefined)
})

test('narrow connection details stack grids and allow long secret keys to wrap', () => {
  const { internals } = loadClientInternals(() => true)

  assert.match(internals.MCP_CSS, /@media \(max-width:480px\)\{[^]*?\.dsh-mcp-kv\{grid-template-columns:1fr;/)
  assert.match(internals.MCP_CSS, /\.dsh-mcp-secret-row b\{[^}]*overflow-wrap:anywhere/)
})

// 「源工作区不会出现在自己的目标列表里」这条不变量现在住在纯函数里，所以能直接断言；
// 写在组件闭包里就只能靠钉源码文本，而那种测试证明不了行为。
test('copy targets exclude the current workspace and entries without a path', () => {
  const { internals } = loadClientInternals(() => true)
  const workspaces = [
    { path: 'C:/proj-a', name: 'proj-a' },
    { path: 'C:/proj-b', name: 'proj-b' },
    { name: 'no-path-yet' },
  ]

  // Array.from 是必须的：函数在 vm realm 里跑，返回的数组原型不是本 realm 的 Array.prototype，
  // 而 deepEqual 会比原型（同文件的 MCP_PRESETS 断言出于同样原因用了它）。
  assert.deepEqual(Array.from(internals.copyTargets(workspaces, 'C:/proj-a').map((ws) => ws.name)), ['proj-b'])
  assert.deepEqual(Array.from(internals.copyTargets(undefined, 'C:/proj-a')), [])
})

test('export file name stays a single safe file name', () => {
  const { internals } = loadClientInternals(() => true)

  assert.equal(internals.exportFileName('proj-a'), 'proj-a-mcp.json')
  // 工作区名来自目录名，可能带分隔符或 Windows 非法字符：落成一个文件名，别让它变成路径。
  assert.equal(internals.exportFileName('a/b:c*d?e"f<g>h|i j'), 'a-b-c-d-e-f-g-h-i-j-mcp.json')
  assert.equal(internals.exportFileName(''), 'workspace-mcp.json')
})

// 组件能不能真的渲染出来，是「没有其他工作区」这条边界唯一能自动验证的地方：
// 一个空下拉框会让用户以为面板坏了，所以这里断言提示文案真的在渲染结果里。
function collectText(node, out) {
  if (typeof node === 'string') { out.push(node); return out }
  if (!node || typeof node !== 'object') return out
  const children = node.children
  if (Array.isArray(children)) for (const child of children) collectText(child, out)
  return out
}

test('the copy dialog explains an empty target list instead of rendering an empty picker', () => {
  const { internals } = loadClientInternals(() => true)
  const { WorkspaceCopyModal } = internals
  const props = {
    open: true,
    onClose() {},
    call: async () => ({ ok: true }),
    busy: false,
    setBusy() {},
    onCopied() {},
    from: 'C:/proj-a',
    fromName: 'proj-a',
    servers: [{ serverName: 'demo', transport: 'stdio' }],
    workspaces: [{ path: 'C:/proj-a', name: 'proj-a' }],
  }

  const alone = collectText(WorkspaceCopyModal(props), [])
  assert.ok(alone.some((text) => text.includes('没有其他已注册的工作区')), '只有一个工作区时必须说清原因')

  const withTarget = collectText(WorkspaceCopyModal({ ...props, workspaces: [...props.workspaces, { path: 'C:/proj-b', name: 'proj-b', serverCount: 2 }] }), [])
  assert.ok(withTarget.some((text) => text.includes('选择目标工作区…')), '有目标时要给出可选的目标')
  assert.ok(!withTarget.some((text) => text.includes('没有其他已注册的工作区')))
})

// 「手上这份预览还是不是当前选择的结论」以前住在组件 state 里，只能靠钉源码文本；抽成纯函数后
// 它才被真正断言——而这条判定正是"预览说跳过、实际却覆盖"能不能发生的唯一开关。
test('a copy preview is only trusted for the exact selection it was computed from', () => {
  const { internals } = loadClientInternals(() => true)

  // 还没选目标：不存在"当前计划"。
  assert.equal(internals.copyPlanKey({ from: 'C:/a', to: '', names: ['x'], overwrite: false }), '')
  assert.equal(internals.copyPlanReady('', { key: '', plan: { added: [] } }), false)

  const base = { from: 'C:/a', to: 'C:/b', names: ['x', 'y'], overwrite: false }
  const key = internals.copyPlanKey(base)
  assert.ok(key)
  // 同一份输入必须给出同一个键，否则每次渲染都会重新请求预览。
  assert.equal(internals.copyPlanKey({ ...base, names: ['x', 'y'] }), key)
  // 三个输入里任何一个变了，旧计划就不再是当前选择的结论。
  for (const changed of [{ ...base, to: 'C:/c' }, { ...base, names: ['x'] }, { ...base, overwrite: true }]) {
    assert.notEqual(internals.copyPlanKey(changed), key, `输入变化必须换键：${JSON.stringify(changed)}`)
  }

  const preview = { key, plan: { targetCount: 1, added: ['x'], updated: [], skipped: [] }, error: '' }
  assert.equal(internals.copyPlanReady(key, preview), true)
  assert.equal(internals.copyPlanReady(internals.copyPlanKey({ ...base, overwrite: true }), preview), false, '换过选择后不能再按确认')
  assert.equal(internals.copyPlanReady(key, { key, plan: null, error: '目标工作区配置无效：…' }), false, '预览失败时不能按确认')
  assert.equal(internals.copyPlanReady('', null), false, '没有目标时不能按确认')
})

// 字段标题那条规则曾经用后代选择器：特异性 (0,1,1) 压过 `.dsh-mcp-check-row` 的 (0,1,0)，复选框行
// 被变成 display:block，gap 失效、传输类型不再右对齐（真实浏览器实测：复选框与名字、名字与类型
// 两段间距都成 0px，类型标签离行右边缘 439px）。所以标题只作用于字段自己的标题，嵌套行才保得住布局。
test('field captions stay child-scoped so nested label rows keep their own layout', () => {
  const { internals } = loadClientInternals(() => true)

  assert.match(internals.MCP_CSS, /\.dsh-mcp-field>label\{display:block/)
  assert.doesNotMatch(internals.MCP_CSS, /\.dsh-mcp-field label\{/)
  // 被压掉的那两条：行自己的 flex+间距，以及靠 margin-left:auto 右对齐的传输标签。
  assert.match(internals.MCP_CSS, /\.dsh-mcp-check-row\{display:flex;align-items:center;gap:8px/)
  assert.match(internals.MCP_CSS, /\.dsh-mcp-check-meta\{margin-left:auto/)
})

test('copy preview text spells out what will be added, overwritten and skipped', () => {
  const { internals } = loadClientInternals(() => true)

  const text = internals.copyPlanText({ targetCount: 3, added: ['alpha'], updated: ['beta'], skipped: ['gamma'] })
  assert.match(text, /目标工作区当前有 3 个 MCP/)
  assert.match(text, /新增：alpha/)
  assert.match(text, /覆盖同名：beta/)
  // 「跳过」必须说清后果：目标那一条会保留原配置，而不是被静默改写。
  assert.match(text, /跳过同名（保留目标原配置）：gamma/)
  assert.match(internals.copyPlanText({ targetCount: 0, added: [], updated: [], skipped: [] }), /没有要写入的条目/)
})

test('source navigation and project actions occupy separate rows without decorative title dividers', () => {
  const { internals } = loadClientInternals(() => true)
  assert.match(internals.MCP_CSS, /\.dsh-mcp-source-tabs\{[^}]*flex:none/)
  assert.match(internals.MCP_CSS, /\.dsh-mcp-section-actions\{[^}]*justify-content:flex-end/)
  assert.doesNotMatch(clientSource, /dsh-mcp-section-fill|dsh-mcp-section-title::after/)
})

test('polling pauses while the tab is hidden and refreshes on return', () => {
  const { internals } = loadClientInternals(() => true)
  const { startVisibilityAwarePolling } = internals
  let ticks = 0
  const listeners = {}
  const doc = {
    visibilityState: 'visible',
    addEventListener(name, fn) { listeners[name] = fn },
    removeEventListener(name) { delete listeners[name] },
  }
  let intervalFn = null
  let intervalDisposed = false
  const timer = { interval(fn) { intervalFn = fn; return () => { intervalDisposed = true } } }

  const dispose = startVisibilityAwarePolling(doc, timer, 5000, () => { ticks += 1 })

  intervalFn()
  assert.equal(ticks, 1, '可见时正常轮询')

  doc.visibilityState = 'hidden'
  intervalFn()
  intervalFn()
  assert.equal(ticks, 1, '不可见时不应拉取')

  doc.visibilityState = 'visible'
  listeners.visibilitychange()
  assert.equal(ticks, 2, '恢复可见应立即补一次，避免看到陈旧数据')

  dispose()
  assert.equal(intervalDisposed, true)
  assert.equal(listeners.visibilitychange, undefined, '监听器必须解绑')
})

// 项目行的文案把**两个独立事实**分开说：连接在不在、几个会话在用。
// 旧实现把两者压成一句「待会话挂载」，用户读成"还没连上/排队中"，而事实常常是
// "连接在、只是当前没会话用" —— 这条测试就是钉住这个区分。
test('project row wording separates connection state from projection scope', () => {
  const { internals } = loadClientInternals(() => true)
  const { wsSub } = internals
  const base = { status: 'connected', refs: 0, toolCount: 41 }

  // 连接在、没人用：必须说清"连接保留"，而不是含糊的"待挂载"。
  assert.equal(wsSub(base), '已连接 · 当前无会话使用（连接保留，下次直接用） · 41 工具')
  assert.equal(wsSub({ ...base, refs: 2 }), '已连接 · 2 个会话在用 · 41 工具')

  // 连接不在、以及各类失败，各自可辨（不再互相冒充）。
  assert.equal(wsSub({ status: 'stopped', refs: 0 }), '尚未建立连接（新会话自动挂载）')
  assert.equal(wsSub({ status: 'loading' }), '连接中…')
  assert.equal(wsSub({ status: 'failed' }), '连接失败')
  assert.equal(wsSub({ status: 'failed', mountFailed: true }), '挂载失败')
  assert.equal(wsSub({ status: 'connected', scopeFailed: true }), '作用域隔离失败')
  assert.equal(wsSub({ status: 'disabled' }), '已禁用')
  assert.equal(wsSub({ status: 'unknown' }), '状态未知')

  // 任何分支都不得回到那句被误解的合成文案。
  for (const row of [base, { ...base, refs: 3 }, { status: 'failed' }, { status: 'stopped' }]) {
    assert.doesNotMatch(wsSub(row), /待会话挂载/)
  }
})

test('mount failure banner carries the reason instead of names only', () => {
  const { internals } = loadClientInternals(() => true)
  const { firstFailureReason } = internals

  // 原因来自 Host（官方 fiber 拒绝的原文 + 同名者 + 根因），面板只负责把它摆到横幅上：
  // 用户拿着横幅提问时，最需要的恰恰是这句话——只列 serverName 等于把线索留给用户自己逐条点开。
  assert.equal(firstFailureReason({ serverName: 'exa', error: 'mcp-client: serverName "exa" is already in use' }),
    'mcp-client: serverName "exa" is already in use')
  assert.equal(firstFailureReason({ serverName: 'exa', error: '  ' }), '（宿主没有给出原因）')
  assert.equal(firstFailureReason(undefined), '（宿主没有给出原因）')
})

test('the skill row key is the identity the host dedupes by', () => {
  const { internals } = loadClientInternals(() => true)
  const { skillIdentity } = internals

  // 行 key = `source \0 cwd \0 name`，宿主侧（lib/skills-registry.js 的 skillRowKey）用**同一个
  // 元组**保证「一个身份一行」。两边一旦漂移，去重就失效、重复 key 回归——而 React 在**生产版
  // 不报警告**，表现只是那一行被重复渲染、徽章挂错行（2026-10-11 真机踩过）。
  // 所以两边各钉一条**同一字面量**的用例：改一边就红。
  assert.equal(skillIdentity({ source: 'user-agents', name: 'zhanggui' }), 'user-agents\u0000\u0000zhanggui',
    '元组变了就要同时改宿主侧的 skillRowKey')
  assert.equal(skillIdentity({ source: 'project-agents', cwd: 'D:/ws', name: 'proj-a' }), 'project-agents\u0000D:/ws\u0000proj-a')
})

test('the selected skill row is derived from the current rows, never held', () => {
  const { internals } = loadClientInternals(() => true)
  const { selectedSkillRow } = internals

  // 真机缺陷（2026-10-11）：选中存的是**行对象**，列表重新取数后详情仍渲染那个旧对象——
  // 刚在面板里停用一个技能时，详情还写着旧状态（磁盘上那个文件的两个字段已经改了），
  // 点「刷新」也不变，只有重新选中那一行才对。派生之后没有旧对象可留。
  const key = 'user-dsh\u0000\u0000dsh-only'
  const stale = { key, name: 'dsh-only', enabled: true }
  const fresh = { key, name: 'dsh-only', enabled: false }
  assert.equal(selectedSkillRow([fresh], key), fresh, '同一身份必须拿到当前那一行（refresh 不是重新选中）')
  assert.equal(selectedSkillRow([fresh], key).enabled, false, '状态要跟着列表走')
  assert.notEqual(selectedSkillRow([fresh], key), stale)
  // 选中项从列表里消失（被删掉 / 换了作用域）→ null，详情回空态而不是继续渲染旧行。
  assert.equal(selectedSkillRow([], key), null)
  assert.equal(selectedSkillRow(null, key), null)
})
