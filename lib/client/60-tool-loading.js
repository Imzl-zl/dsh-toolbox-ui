// ── 延迟加载参数（C2）────────────────────────────────────────────────────
//
// 面板是这三个数字**唯一的解释处**：数值本身没有意义，「这个数管什么、改大改小会怎样」才是
// 用户决定动不动它时要看的（证据见 .tasks/mcp-tool-search/TUNING-DECISIONS.md 的 F4/Q2/Q4）。
// 所以每个字段的标签旁有一个 ⓘ 标记，鼠标移上去用**大白话**说明它的作用——不摆"33%"、
// "schema 体积"这种行话：能看懂的人本来就会自己调，需要说明的正是看不懂的那批。
//
// 保存是**一次 RPC**：Host 把值写进 profile patch 的 `config.toolSearch`，然后在运行中的
// 进程里重装运行时（工具定义里的上限跟着变）。面板不自己拼配置，也不假设"写盘即生效"——
// patch 文件不会被热加载，这一点在 test/real-host-loader 里用真 loader 钉着。
//
// ⚠️ 表里存**中文原文**（= EN_DICT 的键），翻译发生在渲染点 t(field.label)：在这里写 t()
// 会把语言冻在 bundle 加载那一刻（i18n 用例里那组真机缺陷就是它）。
// 参数说明标记（ⓘ）：鼠标移上去用大白话说清这个数字管什么。
// 用**原生 `title`**而不是自绘 tooltip：面板里已经有浮层裁切、层级与主题三样要跟宿主同步的
// 东西，为一个说明再养一套不划算。同一段文字同时给 `aria-label` + `tabIndex`——读屏与键盘
// 也能拿到（触屏没有 hover，`title` 不出现，那条路只能靠 aria）。
const HintMarker = ({ text }) => h('span', {
  className: 'dsh-mcp-hint',
  title: text,
  'aria-label': text,
  tabIndex: 0,
}, h(Icon, { d: ICONS.info, size: 12 }));

// 说明一律一句话——那块地方小，`title` 该回答"这个数字管什么"，不是放一篇论文。
// ── 工具搜索（ToolSearch）：一个入口，两件事 ─────────────────────────────
//
// ① 工具：内置与其他插件的工具逐个选「常驻 / 按需」，默认常驻。
//    MCP 的启停与「延迟 / 全量」在左侧列表里，这里不重复。
// ② 搜索参数：一次返回几条、目录上限、已发现上限（原先单独的「延迟参数」并到了这里）。
/**
 * 目录上限开关打开时的**建议起点**，不是默认值：默认完全不限制（服务端
 * `DEFAULTS.maxCatalogChars = undefined`）。12,500 有实测依据——456 个延迟工具只列名字约
 * 11,690 字符，等于"花今天的钱"。它同时是输入框的 placeholder，两者必须是同一个数。
 */
const CATALOG_CHARS_SUGGESTION = 12500

const TOOL_SEARCH_CHOICES = [
  { id: 'resident', label: '常驻' },
  { id: 'deferred', label: '按需' },
]

/** 已知宿主内置工具的中文短名。未知工具只显示名字，不硬造翻译。 */
const BUILTIN_LABELS = {
  tool_search: '工具搜索入口',
  working_directory: '切换工作目录',
  read: '读取文件',
  write: '写入文件',
  edit: '编辑文件',
  glob: '查找文件',
  grep: '搜索文件内容',
  bash: '运行命令',
  pwsh: '运行命令',
  run_code: '运行代码',
  read_image: '查看图片',
  ask_user_question: '向用户提问',
  task: '任务列表',
  todo_write: '待办清单',
  web_search: '网页搜索',
  web_fetch: '抓取网页',
  list_mcp_resources: '列出 MCP 资源',
  list_mcp_resource_templates: '列出资源模板',
  read_mcp_resource: '读取 MCP 资源',
  skill: '加载技能',
  present: '交付文件',
  job_list: '列出后台任务',
  job_output: '读取任务输出',
  job_kill: '停止后台任务',
  send_message: '给 Agent 发消息',
  subagent: '委派子任务',
  subagent_fork: '带上下文委派',
  list_agents: '列出子 Agent',
  interrupt_agent: '中断子 Agent',
  workflow: '编排多 Agent',
  get_goal: '查看当前目标',
  create_goal: '创建持续目标',
  update_goal: '更新目标',
  exit_plan_mode: '退出计划模式',
  schedule_create: '创建定时提醒',
  schedule_list: '列出定时提醒',
  schedule_delete: '删除定时提醒',
  schedule_update: '修改定时提醒',
  list_pages: '列出浏览器页面',
  navigate_page: '打开网页',
  take_screenshot: '网页截图',
  take_snapshot: '读取页面结构',
  click: '点击页面元素',
  fill: '填写页面输入',
  hover: '悬停页面元素',
  press_key: '按下按键',
  evaluate_script: '在页面执行脚本',
  new_page: '新建浏览器页面',
  close_page: '关闭浏览器页面',
  resize_page: '调整页面尺寸',
  select_page: '切换浏览器页面',
  wait_for: '等待页面条件',
  list_console_messages: '读取控制台消息',
  list_network_requests: '读取网络请求',
  get_network_request: '查看单个网络请求',
  performance_start_trace: '开始性能录制',
  performance_stop_trace: '结束性能录制',
}

const toolLabel = (row) => (row.kind === 'builtin' && BUILTIN_LABELS[row.name]) || row.name

/**
 * 一个工具 = 一行：**宿主原名**（等宽，正常显示）+ 中文短名标记 + 策略下拉。
 *
 * 名字必须用宿主原名：`working_directory`、`job_output` 是可搜索、可与日志/文档对上号的
 * 唯一标识；把它换成中文标题后，用户在别处看到英文名就找不到对应行了。
 * 中文短名是**标记**（说明这行大概是什么工具），不是标题；未知工具没有标记，
 * 退回到宿主的 description 标记（ⓘ），不硬造翻译。
 */
/**
 * 一个工具 = 一行：宿主原名（等宽）+ 中文短名标记 + 常驻/按需。
 *
 * 这里没有第三态：工具页只管全局。内置与插件工具在所有项目里是同一批宿主工具，
 * 按项目再分一层只会让「换个项目就变回去」看起来像丢配置。MCP 服务器粒度的
 * 开关在 MCP 页面，不在这里重复。
 */
const toolLoadingRow = (row, draft, onChange, { saving = false } = {}) => {
  const alias = row.kind === 'builtin' ? BUILTIN_LABELS[row.name] : ''
  const policy = draft[row.name] || row.policy || 'resident'
  // 改动高亮：草稿值与已保存值不同 = 这张卡要进「保存」的承诺里。用户改完往下滚之前
  // 能在原地看到「这张卡不一样了」，而不是滚到底栏才发现改了几张。
  const changed = (row.policy || 'resident') !== policy
  return h('div', { className: 'dsh-mcp-tool-row' + (changed ? ' is-changed' : ''), key: row.name },
    h('div', { className: 'dsh-mcp-tool-info' },
      h('span', { className: 'dsh-mcp-tool-name', title: row.name }, row.name),
      alias ? h('span', { className: 'dsh-mcp-tool-alias' }, alias) : null,
      row.description ? h(HintMarker, { text: row.description }) : null,
    ),
    h('span', { className: 'dsh-mcp-tool-pick', role: 'group', 'aria-label': (alias || row.name) + ' · ' + t('加载方式') },
      ...TOOL_SEARCH_CHOICES.map((choice) => h('button', {
        key: choice.id,
        type: 'button',
        className: choice.id === 'resident' ? 'is-resident' : 'is-deferred',
        'aria-pressed': policy === choice.id,
        disabled: saving,
        onClick: () => onChange(row.name, choice.id),
      }, t(choice.label))),
    ),
    // 说明只作辨认线索：一行截断、全文留在 title。决定「加载方式」不需要读整段 schema 描述，
    // 铺开只会让 34 张卡高低不一（density 用例钉着双列网格，不齐整的双列比单列更乱）。
    row.description ? h('div', { className: 'dsh-mcp-tool-desc', title: row.description }, row.description) : null,
  )
}

/** 搜索参数三项：与原来的「延迟参数」同一套字段与校验，只是搬进同一个弹窗。 */
const SEARCH_PARAM_FIELDS = [
  { key: 'maxResults', label: '一次最多返回几个', about: '搜一次最多拿回几条。调小可能漏掉要用的那个，调大每次多占一点上下文。默认 10。' },
  { key: 'maxDiscovered', label: '同时记住几个已发现的工具', about: '模型搜索出来的工具同时保留几个，超了先淘汰最久没用过的。默认 20。' },
]

const ToolLoadingModal = ({ open, onClose, call, onSaved, inline = false }) => {
  const [loaded, setLoaded] = useState(null)
  const [toolDraft, setToolDraft] = useState({})
  const [params, setParams] = useState({})
  const [savedParams, setSavedParams] = useState({})
  const [limitOn, setLimitOn] = useState(false)
  const [error, setError] = useState('')
  const [searchError, setSearchError] = useState('')
  const [searchLoaded, setSearchLoaded] = useState(false)
  const [searchSaved, setSearchSaved] = useState(false)
  // 保存后显示**宿主原话**（`note`）：它区分"已写入并立即生效"与"已写入，重启后生效"。
  // 写死一句"参数已保存"就把这个区别盖掉了，而那正是 persisted/live 契约要说的事。
  const [savedNotice, setSavedNotice] = useState('')
  const [saving, setSaving] = useState(false)
  const [toolQuery, setToolQuery] = useState('')
  const [toolFilter, setToolFilter] = useState('all')
  const readPolicy = () => call('toolLoadingSettings')
  useEffect(() => {
    if (!open) return undefined
    let cancelled = false
    setLoaded(null)
    setError('')
    setSearchError('')
    setSearchLoaded(false)
    setSearchSaved(false)
    setParams({})
    setLimitOn(false)
    setSavedParams({})
    ;(async () => {
      try {
        const [res, search] = await Promise.all([readPolicy(), call('toolSearchSettings')])
        if (cancelled) return
        if (!res?.ok) throw new Error(res?.error || t('读取失败'))
        setToolDraft({ ...(res.policy?.tools || {}) })
        setLoaded(res)
        if (search?.ok && search.settings) {
          setSearchLoaded(true)
          setParams({ ...search.settings })
          setSavedParams({ ...search.settings })
          setLimitOn(search.settings.maxCatalogChars !== undefined)
        } else {
          setSearchError(search?.error || t('读取失败'))
        }
      } catch (e) {
        if (!cancelled) setError(String(e?.message || e))
      }
    })()
    return () => { cancelled = true }
  }, [open, call])
  if (!open) return null
  const entriesKey = (tools) => JSON.stringify(Object.entries(tools || {}).sort(([a], [b]) => a.localeCompare(b)))
  const dirty = loaded !== null && entriesKey(toolDraft) !== entriesKey(loaded.policy?.tools)
  const paramKey = (value, limited) => JSON.stringify([
    ...SEARCH_PARAM_FIELDS.map((field) => String(value[field.key] ?? '')),
    limited ? String(value.maxCatalogChars ?? '') : null,
  ])
  const paramsChanged = searchLoaded && paramKey(params, limitOn) !== paramKey(savedParams, savedParams.maxCatalogChars !== undefined)
  const setTool = (name, value) => setToolDraft((prev) => {
    const next = { ...prev }
    const original = loaded?.tools?.find((row) => row.name === name)
    if (value === original?.policy && !Object.hasOwn(loaded.policy?.tools || {}, name)) delete next[name]
    else next[name] = value
    return next
  })
  const discard = () => {
    setToolDraft({ ...(loaded.policy?.tools || {}) })
    setParams({ ...savedParams })
    setLimitOn(savedParams.maxCatalogChars !== undefined)
    setError('')
    setSearchSaved(false)
  }
  const submit = async () => {
    if (saving || loaded === null || (inline && !dirty && !paramsChanged)) return
    setSaving(true)
    // 本次保存要显示的那句话（宿主原话优先）。同一个值既给面板内联提示，也给上层 flash，
    // 两处显示同一句话——否则面板说"重启后生效"、外面弹"已保存"，等于自己拆自己的台。
    let notice = ''
    setError('')
    setSearchError('')
    try {
      // 全部输入先校验，避免无效参数使工具策略先落盘。
      const settings = {}
      if (paramsChanged) {
        for (const field of SEARCH_PARAM_FIELDS) {
          const raw = String(params[field.key] ?? '').trim()
          if (raw === '') continue
          const value = Number(raw)
          if (!Number.isSafeInteger(value) || value < 1) throw new Error(t('搜索参数需要正整数'))
          settings[field.key] = value
        }
        if (limitOn) {
          const value = Number(String(params.maxCatalogChars ?? '').trim())
          if (!Number.isSafeInteger(value) || value < 1) throw new Error(t('目录上限需要一个正整数'))
          settings.maxCatalogChars = value
        }
      }
      // 两个配置使用各自 RPC。每项成功后立即确认该项的基线，后项失败仍保留已保存事实。
      if (dirty) {
        const policy = { ...loaded.policy, groups: { ...(loaded.policy?.groups || {}) }, tools: { ...toolDraft } }
        if (policy.mode === 'legacy') delete policy.mode
        const res = await call('updateToolLoadingSettings', { policy })
        if (!res?.ok) throw new Error(res?.error || t('保存失败'))
        notice = res.note || ''
        setSavedNotice(notice)
        const savedPolicy = res.policy || policy
        setLoaded({ ...loaded, policy: savedPolicy,
          tools: (loaded.tools || []).map((row) => ({ ...row, policy: savedPolicy.tools?.[row.name] || row.policy })) })
        setToolDraft({ ...(savedPolicy.tools || {}) })
      }
      if (paramsChanged) {
        const res = await call('updateToolSearchSettings', { settings })
        if (!res?.ok) throw new Error(res?.error || t('保存失败'))
        const saved = { ...(res.settings || settings) }
        setParams(saved)
        setSavedParams(saved)
        setLimitOn(saved.maxCatalogChars !== undefined)
        setSearchSaved(true)
        if (res.note) { notice = res.note; setSavedNotice(res.note) }
      }
      // ③ 回读策略（参数保存后服务端可能规范化）
      const fresh = await readPolicy()
      if (!fresh?.ok) throw new Error(t('保存已完成，但重新读取失败：{error}', { error: fresh?.error || t('读取失败') }))
      setToolDraft({ ...(fresh.policy?.tools || {}) })
      setLoaded(fresh)
      onSaved?.(fresh, notice || undefined)
    } catch (e) {
      setError(String(e?.message || e))
    } finally {
      setSaving(false)
    }
  }
  const setParam = (key, value) => {
    if (!searchLoaded) return
    setParams((prev) => ({ ...prev, [key]: value }))
    setSearchSaved(false)
  }
  // 单一数据源：这一页只认 `toolLoadingSettings().tools` 这一份行数据。
  // 曾经这里把 `kind === 'mcp'` 的行整类排除（"MCP 去 MCP 页管"），可是 MCP 页那个开关读的是
  // 旧的服务器级 `defer`，统一策略下的组级/单工具设置在那儿看不见——于是被延迟的 MCP 工具
  // 在工具页被丢掉、在 MCP 页显示"全量"，两边都说没事。现在 MCP 行照样进这张表，
  // 计数也从同一份 rows 派生，不再"概览数一套、列表数另一套"。
  const manageable = (loaded?.tools || []).filter((row) => row.protected !== true)
  const policyOf = (row) => toolDraft[row.name] || row.policy || 'resident'
  const residentCount = manageable.filter((row) => policyOf(row) === 'resident').length
  const deferredCount = manageable.length - residentCount
  const changedCount = manageable.filter((row) => (row.policy || 'resident') !== policyOf(row)).length
  const protectedTools = (loaded?.tools || []).filter((row) => row.protected === true)
  const needle = toolQuery.trim().toLowerCase()
  const visibleTools = manageable.filter((row) => (toolFilter === 'all' || policyOf(row) === toolFilter)
    && (!needle || [row.name, toolLabel(row), row.description || ''].join(' ').toLowerCase().includes(needle)))
  // 搜索参数提到顶部：它们是「工具怎么加载」的另一半，不是高级选项。
  // 一个保存动作，只调用实际发生改动的配置接口。
  const parameters = h('section', { className: 'dsh-mcp-tool-params' },
    h('div', { className: 'dsh-mcp-tool-params-head' },
      h('h4', { className: 'dsh-mcp-tool-params-title' }, t('搜索参数')),
    ),
    h('div', { className: 'dsh-mcp-tool-params-grid' },
      ...SEARCH_PARAM_FIELDS.map((field) => h('label', { className: 'dsh-mcp-tool-param', key: field.key },
        h('span', { className: 'dsh-mcp-tool-param-label' }, t(field.label), h(HintMarker, { text: t(field.about) })),
        h('input', { type: 'number', min: 1, step: 1, disabled: !searchLoaded || saving,
          value: params[field.key] ?? '', onChange: (e) => setParam(field.key, e.target.value) }),
      )),
      h('div', { className: 'dsh-mcp-tool-param' },
        h('span', { className: 'dsh-mcp-tool-param-label' }, t('限制目录大小'), h(HintMarker, { text: t('目录默认全部列出，只有工具特别多时才需要设上限。') })),
        h('div', { className: 'dsh-mcp-tool-param-inline' },
          h(Toggle, { on: limitOn, disabled: !searchLoaded || saving, label: t('限制目录大小'), onChange: (next) => {
            if (!searchLoaded) return
            setLimitOn(next)
            // 打开时只在**空**的情况下预填建议起点：别覆盖用户已经填过的数。
            if (next && String(params.maxCatalogChars ?? '').trim() === '') setParam('maxCatalogChars', String(CATALOG_CHARS_SUGGESTION))
            setSearchSaved(false)
          } }),
          // 关掉时**置灰保留**，不卸载：主流语义是"可见、不可改、不生效"。卸载会让表单跳一下，
          // 用户也看不出这一项原本是什么。`disabled` 表达"不生效"，保存时仍**不发**这个键。
          h('input', { type: 'number', min: 1, step: 1, disabled: !limitOn || !searchLoaded || saving,
            value: params.maxCatalogChars ?? '', placeholder: String(CATALOG_CHARS_SUGGESTION),
            'aria-label': t('最多字符数'), onChange: (e) => setParam('maxCatalogChars', e.target.value) }),
        ),
      ),
    ),
    searchError ? h('div', { className: 'dsh-mcp-d-err' }, searchError) : null,
    searchSaved ? h('p', { role: 'status', className: 'dsh-mcp-tool-param-saved' }, savedNotice || t('参数已保存')) : null,
  )
  // 概览条的一格：圆点与数字给「现在是什么局面」一个 3 秒答案。数值全来自与列表
  // 同源的那份数据（other / protectedTools / changedCount），不另问宿主——两个来源
  // 各数各的，迟早出现「概览说 34、列表数出 33」这种自己对不上自己的笑话。
  const stat = (mark, value, label, note) => h('div', { className: 'dsh-mcp-tool-stat' },
    h('span', { className: 'dsh-mcp-tool-stat-mark' + (mark ? ' ' + mark : '') }),
    h('span', { className: 'dsh-mcp-tool-stat-value' }, String(value)),
    h('span', { className: 'dsh-mcp-tool-stat-copy' },
      h('span', { className: 'dsh-mcp-tool-stat-label' }, label),
      note ? h('span', { className: 'dsh-mcp-tool-stat-note' }, note) : null,
    ),
  )
  const hero = h('div', { className: 'dsh-mcp-tool-hero' }, h('div', { className: 'dsh-mcp-tool-hero-copy' },
    h('h3', { className: 'dsh-mcp-tool-title' }, t('工具加载')),
  ))
  const overview = loaded === null ? null : h('div', { className: 'dsh-mcp-tool-overview' },
    stat('', manageable.length, t('可设置'), t('内置与插件工具')),
    stat('resident', residentCount, t('常驻'), t('每轮都在上下文里')),
    stat('deferred', deferredCount, t('按需'), t('搜索命中后加载')),
    stat('protected', protectedTools.length, t('受保护'), protectedTools.map((row) => row.name).join(' / ')),
  )
  const toolbar = h('div', { className: 'dsh-mcp-tool-toolbar' },
    h('div', { className: 'dsh-mcp-search' }, h(Icon, { d: ICONS.search }), h('input', { value: toolQuery,
      placeholder: t('按名称或用途搜索'), 'aria-label': t('按名称或用途搜索'), onChange: (e) => setToolQuery(e.target.value) })),
    h('div', { className: 'dsh-mcp-tool-filter', role: 'group', 'aria-label': t('按加载策略筛选') },
      ...[{ id: 'all', label: '全部' }, ...TOOL_SEARCH_CHOICES].map((choice) => h('button', {
        key: choice.id, type: 'button', 'aria-pressed': toolFilter === choice.id, onClick: () => setToolFilter(choice.id),
      }, t(choice.label))),
    ),
  )
  const list = loaded === null ? null : visibleTools.length ? h('div', { className: 'dsh-mcp-tool-list' }, ...visibleTools.map((row) => toolLoadingRow(row, toolDraft, setTool, { saving })))
    : h('div', { className: 'dsh-mcp-source-detail' }, t('没有匹配的工具。'))
  const fixed = [
    inline ? null : hero,
    error ? h('div', { className: 'dsh-mcp-d-err', role: 'alert' }, error) : null,
    loaded === null ? (error ? null : h('div', { className: 'dsh-mcp-source-detail' }, t('正在读取…')))
      : h(React2.Fragment, null, parameters, overview, toolbar),
  ]
  const content = [...fixed, list]
  if (inline) return h('div', { className: 'dsh-mcp-tool-loading-page' },
    h('div', { className: 'dsh-mcp-tool-fixed' }, ...fixed),
    h('div', { className: 'dsh-mcp-tool-scroll' }, list),
    h('div', { className: 'dsh-mcp-tool-save' },
      h('span', { className: 'dsh-mcp-tool-save-hint' },
        (dirty || paramsChanged) ? h('span', { className: 'dsh-mcp-tool-save-dirty' },
          dirty && paramsChanged ? t('已改 {count} 项 + 参数', { count: changedCount })
            : dirty ? t('已改 {count} 项', { count: changedCount })
            : t('参数已修改')) : null,
        (dirty || paramsChanged) ? t('未保存，保存后下一次请求生效') : null),
      h('span', { className: 'dsh-mcp-tool-save-spacer' }),
      h('span', { className: 'dsh-mcp-tool-save-actions' },
        (dirty || paramsChanged) ? h(Btn, { onClick: discard, disabled: saving, children: t('放弃修改') }) : null,
        loaded ? h(Btn, { cls: 'primary', onClick: submit, disabled: saving || (!dirty && !paramsChanged), children: saving ? t('保存中…') : t('保存') }) : null,
      ),
    ),
  )
  return h('div', { className: 'dsh-mcp-overlay', onClick: (e) => e.target === e.currentTarget && onClose?.() },
    h(Dialog, { label: t('工具加载'), onClose }, ...content),
  )
}

