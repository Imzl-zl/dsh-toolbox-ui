// ── 工具加载页 ───────────────────────────────────────────────────────────
//
// 这一页只有一个问题：**每个工具下一轮要不要占上下文**。它由三层配置决定（见
// lib/tool-loading-policy.js）：整体方案 mode、服务器组 groups、逐工具 tools。
// 页面按**使用路径**组织，不按“配置的存储位置”组织：
//
//   ① 内置按用途分类（文件 / 命令与终端 / 网络 / …）排在最前：MCP 的整台默认在 MCP 页的
//      芯片上管，来工具页通常是给内置工具做逐工具配置；
//   ② 服务器组（MCP）排第二：组头**只读**显示「整台默认」，写入口在 MCP 页；行里处理逐工具例外；
//   ③ 名单外的插件工具单列。宿主没有 provenance 接口，无法可靠区分新内置与第三方，不猜；
//   ④ 受保护项（tool_search / run_code）：只读，不进可设置列表。
//
// 面板是**全局 + 项目**两种作用域：项目的覆盖写在 .dsh/mcp.json 的 toolLoading，
// 与全局同形；行里的「跟随全局」在项目里表示删掉项目键，回落到全局。
//
// ⚠️ 表里存**中文原文**（= EN_DICT 的键），翻译发生在渲染点 t(field.label)：在这里写 t()
// 会把语言冻在 bundle 加载那一刻（i18n 用例里那组真机缺陷就是它）。
const HintMarker = ({ text }) => h('span', {
  className: 'dsh-mcp-hint',
  title: text,
  'aria-label': text,
  tabIndex: 0,
}, h(Icon, { d: ICONS.info, size: 12 }));

/**
 * 目录上限开关打开时的**建议起点**，不是默认值：默认完全不限制（服务端
 * `DEFAULTS.maxCatalogChars = undefined`）。12,500 有实测依据——456 个延迟工具只列名字约
 * 11,690 字符，等于"花今天的钱"。它同时是输入框的 placeholder，两者必须是同一个数。
 */
const CATALOG_CHARS_SUGGESTION = 12500

/** 逐工具三态。`inherit` 用**删掉覆盖键**表达（与配置模型一致，不发明第三取值）。 */
const TOOL_POLICY_CHOICES = [
  { id: 'inherit' },
  { id: 'resident', label: '常驻' },
  { id: 'deferred', label: '按需' },
]

/** 面板侧的成员索引：与宿主 `groupMembershipOf` 同一条规则（先出现者胜）。 */
const groupMembershipOf = (groups) => {
  const membership = new Map()
  for (const [name, entry] of Object.entries(groups || {})) {
    for (const tool of entry?.tools ?? []) if (!membership.has(tool)) membership.set(tool, name)
  }
  return membership
}

/** 分组草稿的等价比：键顺序也算（顺序即显示顺序）。 */
const sameGroups = (left, right) => JSON.stringify(left || {}) === JSON.stringify(right || {})

/** 把工具从所有组里摘掉，再放进目标组（移动语义）。返回新对象，不改入参。 */
const moveToolsIntoGroup = (groups, target, toolNames) => {
  const moving = new Set(toolNames)
  const next = {}
  for (const [name, entry] of Object.entries(groups || {})) {
    next[name] = { ...entry, tools: (entry.tools || []).filter((tool) => !moving.has(tool)) }
  }
  if (target === null) return next
  next[target] = { ...(next[target] || {}), tools: [...(next[target]?.tools || []), ...toolNames] }
  return next
}

/** 组策略缺席时行内要跟的那一层：宿主已经把 `inheritedPolicy` 算成"去掉逐工具覆盖后的值"，
 *  所以有组策略时它必然是组值；这里只决定文案说的是"跟谁"。 */
const followSourceOf = (row, groupName, groups) => {
  if (groupName && groups?.[groupName]?.policy) return { key: 'group', name: groupName }
  return { key: row.kind === 'mcp' ? 'server' : 'host' }
}

// 整体方案（mode）**没有 UI**：它只由配置文件/部署决定，页面只在被它压住时给横幅。
// 两个写入口保持清晰：MCP 页芯片 → 整台默认（groups）；工具页每行 → 逐工具（tools）。

/**
 * 已知**宿主内置工具**的中文短名。
 *
 * 名单只收能在宿主源码里找到定义的第一方工具（`deepseek-harness` 的 `packages` 下各 `tool-*` 包）：
 * 断言的依据是定义处，不是“看着像内置”。曾经这里混进过 chrome-devtools 的 MCP 工具名
 * （`navigate_page` / `take_screenshot` …）和宿主里不存在的 `task`、`schedule_update`，
 * 后果是名字相同的第三方工具会被贴上“内置”标签、分进内置分类——比不分类更糟。
 *
 * 名单外的非 MCP 工具一律进「其他插件与未识别工具」：宿主没有 provenance 接口，
 * 猜错会改掉别人的工具身份，所以不猜。
 */
const BUILTIN_LABELS = {
  // 文件
  working_directory: '切换工作目录',
  read: '读取文件',
  write: '写入文件',
  edit: '编辑文件',
  read_image: '查看图片',
  apply_patch: '应用补丁',
  str_replace_editor: '结构化编辑',
  glob: '查找文件',
  grep: '搜索文件内容',
  // 命令
  bash: '运行命令',
  pwsh: '运行命令',
  terminal_open: '打开终端',
  terminal_send: '向终端发送',
  terminal_read: '读取终端',
  terminal_signal: '发送终端信号',
  terminal_close: '关闭终端',
  terminal_list: '列出终端',
  // 网络
  web_search: '网页搜索',
  web_fetch: '抓取网页',
  // MCP 资源
  list_mcp_resources: '列出 MCP 资源',
  list_mcp_resource_templates: '列出资源模板',
  read_mcp_resource: '读取 MCP 资源',
  // 任务与后台
  todo_write: '待办清单',
  get_goal: '查看当前目标',
  create_goal: '创建持续目标',
  update_goal: '更新目标',
  exit_plan_mode: '退出计划模式',
  job_list: '列出后台任务',
  job_output: '读取任务输出',
  job_kill: '停止后台任务',
  // 子代理与团队
  subagent: '委派子任务',
  subagent_fork: '带上下文委派',
  list_subagent_models: '列出子代理模型',
  send_message: '给子代理发消息',
  list_agents: '列出子代理',
  interrupt_agent: '中断子代理',
  wait_agent: '等待子代理',
  workflow: '编排多代理',
  team_task_create: '创建团队任务',
  team_task_get: '查看团队任务',
  team_task_list: '列出团队任务',
  team_task_update: '更新团队任务',
  // 技能与交互
  skill: '加载技能',
  ask_user_question: '向用户提问',
  present: '交付文件',
  // 定时
  schedule_create: '创建定时任务',
  schedule_list: '列出定时任务',
  schedule_view: '查看定时任务',
  schedule_edit: '编辑定时任务',
  // 代码与工作区
  lsp: '代码导航',
  create_worktree: '创建工作树',
  load_workspace_dependencies: '加载工作区依赖',
  // 宿主与插件
  plugin_manager: '管理插件',
  plugin_market: '插件市场',
  cordis_inspect_list: '列出 Cordis 条目',
  cordis_inspect_query: '查询 Cordis 条目',
  // 其他
  run_code: '运行代码',
  session_search: '搜索会话',
  session_trace: '追踪会话',
  session_event_read: '读取会话事件',
  session_event_search: '搜索会话事件',
  session_event_trace: '追踪会话事件',
  ralph: '循环任务',
}

const toolLabel = (row) => (row.kind === 'builtin' && BUILTIN_LABELS[row.name]) || row.name

/**
 * 已知宿主内置工具的用途分类。
 *
 * 分类按**工具做什么**，不按包名：文件读写归“文件”，终端与命令归“命令”，
 * 子代理/团队/消息归“子代理与团队”，插件与 Cordis 检查归“宿主与插件”。
 * 名单外的名字不进任何内置分类。
 */
const BUILTIN_CATEGORY_GROUPS = [
  { id: 'files', label: '文件', names: ['working_directory', 'read', 'write', 'edit', 'read_image', 'apply_patch', 'str_replace_editor', 'glob', 'grep'] },
  { id: 'shell', label: '命令与终端', names: ['bash', 'pwsh', 'terminal_open', 'terminal_send', 'terminal_read', 'terminal_signal', 'terminal_close', 'terminal_list'] },
  { id: 'web', label: '网络', names: ['web_search', 'web_fetch'] },
  { id: 'mcp-resources', label: 'MCP 资源', names: ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'] },
  { id: 'tasks', label: '任务与后台', names: ['todo_write', 'get_goal', 'create_goal', 'update_goal', 'exit_plan_mode', 'job_list', 'job_output', 'job_kill'] },
  {
    id: 'agents',
    label: '子代理与团队',
    names: ['subagent', 'subagent_fork', 'list_subagent_models', 'send_message', 'list_agents', 'interrupt_agent',
      'wait_agent', 'workflow', 'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update'],
  },
  { id: 'interaction', label: '技能与交互', names: ['skill', 'ask_user_question', 'present'] },
  { id: 'schedule', label: '定时', names: ['schedule_create', 'schedule_list', 'schedule_view', 'schedule_edit'] },
  { id: 'code', label: '代码与工作区', names: ['lsp', 'create_worktree', 'load_workspace_dependencies'] },
  { id: 'host', label: '宿主与插件', names: ['plugin_manager', 'plugin_market', 'cordis_inspect_list', 'cordis_inspect_query'] },
  { id: 'misc', label: '其他内置', names: ['run_code', 'session_search', 'session_trace', 'session_event_read', 'session_event_search', 'session_event_trace', 'ralph'] },
]
const BUILTIN_CATEGORY = Object.fromEntries(
  BUILTIN_CATEGORY_GROUPS.flatMap((group) => group.names.map((name) => [name, group.id])),
)
const BUILTIN_CATEGORY_LABELS = Object.fromEntries(BUILTIN_CATEGORY_GROUPS.map((group) => [group.id, group.label]))
const BUILTIN_CATEGORY_ORDER = BUILTIN_CATEGORY_GROUPS.map((group) => group.id)

/** 顶层分区：内置 / MCP / 其他。类型筛选就是按它过滤。
 *
 * 顺序是**使用路径**，不是数据量：MCP 的整台默认在 MCP 页的芯片上管，来工具页主要是给内置工具
 * 做逐工具配置；MCP 服务器组留在后面（只用来处理某台服务器的逐工具例外）。
 */
const TOOL_SECTION_ORDER = ['builtin', 'mcp', 'other']
const sectionLabel = (section) => (section === 'mcp'
  ? t('MCP 服务器')
  : section === 'builtin' ? t('内置工具（按用途）') : t('其他插件与未识别'))

/**
 * 按“用户会去哪儿找”分组：MCP 按服务器、其余合成一组、归属有歧义的 MCP 单列。
 *
 * 不按 kind 只分两类：`kind` 只有 mcp/builtin 两值，而 builtin 里混着宿主内置与其他插件的
 * 工具（宿主没有 provenance 接口，分不出来）。把它们分开显示就是编一个我们没有的信息。
 *
 * 排序用 **code-unit** 而不是 localeCompare：排序结果必须与面板外的日志/配置对得上，
 * 而 localeCompare 依赖 ICU 与区域，同一份数据在不同机器上会给出不同顺序。
 */
const toolGroups = (rows) => {
  const map = new Map()
  for (const row of rows) {
    let key
    let section
    let owner = null
    let category = null
    let label = null
    if (row.kind === 'mcp') {
      key = row.owner ? 'mcp:' + row.owner : 'mcp:'
      section = 'mcp'
      owner = row.owner || null
    } else if (Object.hasOwn(BUILTIN_LABELS, row.name)) {
      category = BUILTIN_CATEGORY[row.name] || 'misc'
      key = 'builtin:' + category
      section = 'builtin'
      label = BUILTIN_CATEGORY_LABELS[category]
    } else {
      key = 'plugin'
      section = 'other'
    }
    let group = map.get(key)
    if (group === undefined) {
      group = { key, section, owner, category, label, rows: [] }
      map.set(key, group)
    }
    group.rows.push(row)
  }
  for (const group of map.values()) {
    group.rows.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  }
  return [...map.values()].sort((left, right) => {
    const bySection = TOOL_SECTION_ORDER.indexOf(left.section) - TOOL_SECTION_ORDER.indexOf(right.section)
    if (bySection !== 0) return bySection
    if (left.section === 'builtin') {
      return BUILTIN_CATEGORY_ORDER.indexOf(left.category) - BUILTIN_CATEGORY_ORDER.indexOf(right.category)
    }
    if (left.section === 'mcp') {
      // 归属不明的 MCP 工具放**最后**：它不是一个服务器，放在第一行会把正常的服务器组挤下去。
      const byOwned = (left.owner ? 0 : 1) - (right.owner ? 0 : 1)
      if (byOwned !== 0) return byOwned
      const a = left.owner || ''
      const b = right.owner || ''
      return a < b ? -1 : a > b ? 1 : 0
    }
    return 0
  })
}

const groupLabel = (group) => (group.section === 'mcp'
  ? (group.owner || t('未归属'))
  : group.section === 'other' ? t('未分组') : t(group.label))

/** 组的“跟随值”：没有组级键时模型实际会用的值。服务端下发；老宿主按方案兜底。 */
const groupInherited = (loaded, owner) => {
  if (owner === null) return 'resident' // 非 MCP（内置/插件）不受 mode=recommended 影响
  const state = (loaded?.groups || []).find((group) => group.owner === owner)
  if (state?.inherited === 'deferred' || state?.inherited === 'resident') return state.inherited
  return loaded?.policy?.mode === 'recommended' ? 'deferred' : 'resident'
}

/**
 * 一个工具 = 一行：宿主原名（等宽）+ 中文短名 + 三态。
 *
 * 名字必须是宿主原名：`working_directory`、`job_output` 是可搜索、可与日志/文档对上号的
 * 唯一标识；换成中文标题后，用户在别处看到英文名就找不到对应行。
 * “继承项”必须写清**跟谁**、**当前是什么**：只写“跟随”，用户既不知道上一层是谁，也不知道
 * 选它会发生什么。服务器行写「跟随服务器」，内置工具写「宿主默认」，项目里的覆盖写「跟随全局」。
 */
const toolLoadingRow = (row, draft, saved, onChange, { saving, inherited, followLabel, checked = false, onToggle = null }) => {
  const alias = row.kind === 'builtin' ? BUILTIN_LABELS[row.name] : ''
  const explicit = Object.hasOwn(draft, row.name)
  const policy = explicit ? draft[row.name] : (row.policy || 'resident')
  const savedExplicit = Object.hasOwn(saved || {}, row.name)
  const changed = explicit !== savedExplicit || (explicit && draft[row.name] !== saved[row.name])
  const inheritedText = inherited === 'deferred' ? t('按需') : t('常驻')
  // “跟随”必须说清**跟谁**、**当前是什么**：只写“跟随”，用户既不知道上一层是谁，也不知道
  // 选它会发生什么。服务器行跟服务器默认，内置工具跟宿主默认，项目里的覆盖跟全局。
  const inheritLabel = t('{source}（{value}）', { source: followLabel, value: inheritedText })
  return h('div', { className: 'dsh-mcp-tool-row' + (changed ? ' is-changed' : '') + (explicit ? ' is-overridden' : '') + (checked ? ' is-selected' : ''), key: row.name },
    // 一行两列：名字/说明在左，三态在右。三态不另起一行——那会让 700 多行时每张卡多占
    // 一整行，而“这行是什么工具”和“它怎么加载”本就是同一眼的判断。
    h('div', { className: 'dsh-mcp-tool-head' },
      onToggle ? h('input', {
        type: 'checkbox',
        className: 'dsh-mcp-tool-check',
        checked,
        disabled: saving,
        'aria-label': t('选择 {name}', { name: alias || row.name }),
        onClick: (e) => e.stopPropagation(),
        onChange: () => onToggle(row.name),
      }) : null,
      h('div', { className: 'dsh-mcp-tool-info' },
        h('span', { className: 'dsh-mcp-tool-name', title: row.name }, row.name),
        alias ? h('span', { className: 'dsh-mcp-tool-alias' }, alias) : null,
        explicit ? h('span', { className: 'dsh-mcp-tool-override', title: t('不跟随上一级设置') }, t('单独设置')) : null,
        row.description ? h(HintMarker, { text: row.description }) : null,
      ),
      h('span', { className: 'dsh-mcp-tool-pick', role: 'group', 'aria-label': (alias || row.name) + ' · ' + t('加载方式') },
        ...TOOL_POLICY_CHOICES.map((choice) => h('button', {
          key: choice.id,
          type: 'button',
          className: choice.id === 'resident' ? 'is-resident' : choice.id === 'deferred' ? 'is-deferred' : 'is-inherit',
          'aria-pressed': choice.id === 'inherit' ? !explicit : (explicit && policy === choice.id),
          title: choice.id === 'inherit' ? t('不单独设置这个工具：使用上一级的决定（当前：{value}）', { value: inheritedText }) : undefined,
          disabled: saving,
          onClick: () => onChange(row.name, choice.id),
        }, choice.id === 'inherit' ? inheritLabel : t(choice.label))),
      ),
    ),
    // 说明只作辨认线索：一行截断、全文留在 title。决定加载方式不需要读整段 schema 描述，
    // 铺开只会让卡片高低不一（density 用例钉着双列网格，不齐整的双列比单列更乱）。
    row.description ? h('div', { className: 'dsh-mcp-tool-desc', title: row.description }, row.description) : null,
  )
}

/** 搜索参数三项：与原来的「延迟参数」同一套字段与校验，只是收进了可折叠的「搜索设置」。 */
/**
 * 目录体检 → 一句人话（R13a）。
 *
 * 为什么是纯函数：这是"参数对你机器上实际库存是否合理"的唯一读数，而它最容易写错的地方
 * 是**把未知说成 0**（"还没组装过" vs "组装了但没截断"）。纯函数能在 node 里直接钉住这两者。
 *
 * @param {{ budget?: number|null, deferredServers?: string[], globalToolCount?: number|null, lastAssembly?: object|null }} facts
 * @returns {string}
 */
/**
 * 最近搜索 → 逐条人话（R13b）。
 *
 * ⚠️ 这里**刻意不把"无命中"标成缺陷**。目录完整时，模型照目录抄名字用 `select:` 必然命中，
 * 所以"无命中"几乎只发生在它抄错名字——那不是插件的问题。只有在**目录被预算截断**时，
 * "无命中"才值得怀疑（那些工具的名字它不知道，只能靠关键词猜）。是不是这种情况，由
 * `catalogFactsText` 里那句"被砍掉 N 个"来讲，不在这里重复判断。
 *
 * 所以：按时间倒序（最近的在前），无命中只给一个中性标记，不排序、不上色。
 *
 * 每条都带 `payloadChars`：那是**本次搜索的上下文成本**，也就是 `maxResults` 的单价。
 * 没有这个数，"调大一档值不值"还是只能猜。
 *
 * 纯函数是因为它要能真跑：客户端在本仓库跑不了 hook 行为，但字符串拼装可以。
 */
const recentSearchesText = (searches) => (Array.isArray(searches) ? searches : [])
  .slice()
  .reverse()
  .map((entry) => {
    const returned = Array.isArray(entry?.returned) ? entry.returned : []
    const missing = Array.isArray(entry?.missing) ? entry.missing : []
    const parts = [String(entry?.query ?? '')]
    if (returned.length === 0) parts.push(missing.length ? t('（点名未找到：{names}）', { names: missing.join(t('、')) }) : t('（无命中）'))
    else parts.push(t('→ {count} 条', { count: returned.length }))
    if (typeof entry?.payloadChars === 'number') parts.push(t('{chars} 字符', { chars: entry.payloadChars }))
    return parts.join('  ')
  });

const catalogFactsText = (facts) => {
  const deferred = Array.isArray(facts?.deferredServers) ? facts.deferredServers : []
  // 预算值的两种写法自带单位：不限制时写“不限制”，设了才写“N 字符”。
  // 原来写成 `{budget} 字符`，于是未设预算时读作“目录预算 不限制 字符”（真机截图看出来的）。
  const budget = facts?.budget === null || facts?.budget === undefined
    ? t('不限制')
    : t('{chars} 字符', { chars: facts.budget })
  const head = t('延迟服务器 {count} 台（{names}）· 目录预算 {budget}', {
    count: deferred.length,
    names: deferred.length ? deferred.join(t('、')) : t('无'),
    budget,
  })
  const assembly = facts?.lastAssembly
  if (!assembly) return head + '\n' + t('还没有组装过目录：等第一次模型请求之后，这里会显示上次实际列出了多少、被预算砍掉多少。')
  // ⚠️ 报**字符数**而不是"列了几个名字"。ToolSearch 存在的意义是省上下文，所以
  // 目录段的字符数是这个取舍的唯一读数（实测 735 工具：不限制 37,403 字符、12,500 预算 12,886）。
  // 名字长短不等，只报个数会让人以为"多列 100 个没什么"。
  const chars = typeof assembly.chars === 'number' ? assembly.chars : null
  // ⚠️ `total` 是「**待发现**的延迟工具数」，不是「全部延迟工具」：
  // 目录段只列还没被发现的（filterCatalog），已发现的工具不再重复列出。
  // 写成"共 N 个名字"会让用户以为机器上只有 N 个工具——那是错的。
  const lines = [
    t('上次组装（revision {revision}）：待发现 {total} 个工具名，目录列出 {listed} 个（已发现的工具不再重复列出）', {
      revision: String(assembly.revision ?? '').slice(0, 8),
      listed: assembly.listed,
      total: assembly.total,
    }),
  ]
  if (chars !== null) {
    lines.push(t('这段目录占 {chars} 字符——每一轮请求都要付。', { chars }))
  }
  // ⚠️ 截断的代价**不是**"少几个字"，而是"那批工具从精确点名退化成关键词盲猜"：
  // 名字不在目录里 ⇒ 模型既不能用 `select:` 精确取，也不知道该搜什么词，
  // 而关键词要命中就得工具**描述**里恰好有那个词（BM25 是词法匹配，没有同义词）。
  // 所以这句话必须把机制讲清，不能写成"仍能被搜到"——那会让人以为没代价。
  if (assembly.truncated > 0) {
    lines.push(t('被砍掉的 {truncated} 个工具：模型不知道它们的名字，不能用 select: 精确取，只能靠关键词碰；关键词要命中，得工具描述里恰好有那个词。这不是"少列几个字"，而是那批工具从"点名可取"退化成"猜词"。', { truncated: assembly.truncated }))
  }
  return head + '\n' + lines.join('\n')
};

const SEARCH_PARAM_FIELDS = [
  { key: 'maxResults', label: '一次最多返回几个', about: '搜一次最多拿回几条。调小可能漏掉要用的那个，调大每次多占一点上下文。默认 10。' },
  { key: 'maxDiscovered', label: '同时记住几个已发现的工具', about: '模型搜索出来的工具同时保留几个，超了先淘汰最久没用过的。默认 20。' },
]

const ToolLoadingModal = ({ open, onClose, call, onSaved, inline = false, scopes = null, scope = 'global', onScope = null, focus = null, onFocusConsumed = null }) => {
  const [loaded, setLoaded] = useState(null)
  const [toolDraft, setToolDraft] = useState({})
  const [params, setParams] = useState({})
  const [savedParams, setSavedParams] = useState({})
  const [limitOn, setLimitOn] = useState(false)
  const [error, setError] = useState('')
  const [searchError, setSearchError] = useState('')
  const [searchLoaded, setSearchLoaded] = useState(false)
  // R13a：目录体检（预算 / 延迟服务器 / 工具池 / 上次组装的实际截断）。
  // 它是 toolSearchSettings 返回的**附加字段**，不是新方法——参数改完到底有没有效果，
  // 以前只能去宿主进程日志里找那条 warn，面板完全看不见。
  const [catalogFacts, setCatalogFacts] = useState(null)
  const [searchSaved, setSearchSaved] = useState(false)
  // 保存后显示**宿主原话**（`note`）：它区分"已写入并立即生效"与"已写入，重启后生效"。
  const [savedNotice, setSavedNotice] = useState('')
  const [saving, setSaving] = useState(false)
  const [toolQuery, setToolQuery] = useState('')
  const [toolFilter, setToolFilter] = useState('all')
  const [toolType, setToolType] = useState('all')
  // 折叠状态：只记用户显式拨过的组；所有组（MCP 与内置分类）默认收起。
  const [openGroups, setOpenGroups] = useState({})
  // 筛选态下用户显式折叠的组。筛选变化时清空——"筛选默认展开、但别抢走折叠权"，
  // 之前这里是 `filtering ? true : …`，于是选了类型筛选后所有组都点不动（实测复现）。
  const [collapsedFiltered, setCollapsedFiltered] = useState({})
  const [focusOwner, setFocusOwner] = useState(null)
  // ── 自定义分组与批量（DESIGN §16/§18）──────────────────────────────────
  // 分组、勾选、撤销全部是**草稿**：与逐工具三态进同一个保存条，唯一的落盘点仍是一次保存。
  const [groupDraft, setGroupDraft] = useState({})
  const [selected, setSelected] = useState({})
  // 只保留最近一次批量前的快照：撤销一步足够，多级撤销会让"放弃修改"变成第三种语义。
  const [lastBulk, setLastBulk] = useState(null)
  // { mode: 'create' | 'save' | 'rename', value, error, target? }
  const [groupPrompt, setGroupPrompt] = useState(null)
  const [groupDelete, setGroupDelete] = useState(null)
  // 筛选一变就重新展开：否则用户上次折叠的组会一直藏着，看着像"筛选没结果"。
  useEffect(() => { setCollapsedFiltered({}) }, [toolQuery, toolFilter, toolType])
  const inWorkspace = typeof scope === 'string' && scope !== '' && scope !== 'global'
  const readPolicy = () => (inWorkspace ? call('workspaceToolLoading', { wsPath: scope }) : call('toolLoadingSettings'))
  const savePolicy = (policy, customGroups) => (inWorkspace
    ? call('setWorkspaceToolLoading', { wsPath: scope, policy })
    : call('updateToolLoadingSettings', customGroups === undefined ? { policy } : { policy, customGroups }))

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
    setToolDraft({})
    setFocusOwner(null)
    setGroupDraft({})
    setSelected({})
    setLastBulk(null)
    setGroupPrompt(null)
    setGroupDelete(null)
    ;(async () => {
      try {
        // 搜索参数是插件全局配置（不是项目配置）：项目作用域下不显示、也不请求。
        const [res, search] = await Promise.all([readPolicy(), inWorkspace ? Promise.resolve(null) : call('toolSearchSettings')])
        if (cancelled) return
        if (!res?.ok) throw new Error(res?.error || t('读取失败'))
        setToolDraft({ ...(res.policy?.tools || {}) })
        setGroupDraft({ ...(res.customGroups || {}) })
        setLoaded(res)
        if (search?.ok && search.settings) {
          setSearchLoaded(true)
          setCatalogFacts(search.catalog ?? null)
          setParams({ ...search.settings })
          setSavedParams({ ...search.settings })
          setLimitOn(search.settings.maxCatalogChars !== undefined)
        } else if (!inWorkspace) {
          setSearchError(search?.error || t('读取失败'))
        }
      } catch (e) {
        if (!cancelled) setError(String(e?.message || e))
      }
    })()
    return () => { cancelled = true }
  }, [open, call, scope])

  // 深链：从 MCP 详情的「工具」页签切过来时，只显示那台服务器并把它展开。
  // 只消费一次（consume 后上层清空 focus），否则用户手动切走再回来会被再次定位。
  useEffect(() => {
    if (!open || !focus || loaded === null) return
    if (focus.scope && focus.scope !== scope) return
    setFocusOwner(focus.name)
    setToolQuery('')
    setToolFilter('all')
    setToolType('all')
    setOpenGroups((prev) => ({ ...prev, ['mcp:' + focus.name]: true }))
    onFocusConsumed?.()
  }, [open, focus, loaded, scope])

  if (!open) return null
  const savedTools = loaded?.policy?.tools || {}
  const savedGroups = loaded?.customGroups || {}
  const entriesKey = (value) => JSON.stringify(Object.entries(value || {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  const groupsDirty = !sameGroups(groupDraft, savedGroups)
  const dirty = loaded !== null && (entriesKey(toolDraft) !== entriesKey(savedTools) || groupsDirty)
  const paramKey = (value, limited) => JSON.stringify([
    ...SEARCH_PARAM_FIELDS.map((field) => String(value[field.key] ?? '')),
    limited ? String(value.maxCatalogChars ?? '') : null,
  ])
  const paramsChanged = !inWorkspace && searchLoaded && paramKey(params, limitOn) !== paramKey(savedParams, savedParams.maxCatalogChars !== undefined)
  const setTool = (name, value) => setToolDraft((prev) => {
    const next = { ...prev }
    if (value === 'inherit') delete next[name]
    else next[name] = value
    return next
  })
  const discard = () => {
    setToolDraft({ ...savedTools })
    setGroupDraft({ ...savedGroups })
    setSelected({})
    setLastBulk(null)
    setParams({ ...savedParams })
    setLimitOn(savedParams.maxCatalogChars !== undefined)
    setError('')
    setSearchSaved(false)
  }
  const submit = async () => {
    if (saving || loaded === null || (inline && !dirty && !paramsChanged)) return
    setSaving(true)
    let notice = ''
    setError('')
    setSearchError('')
    try {
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
      if (dirty) {
        // tools 与 mode/groups（MCP 服务器组）原样保留；自定义分组是**另一个兄弟键**，
        // 只有全局作用域能写，项目页签只读。
        // mode: legacy 用删键表达，否则写侧校验会拒。
        const policy = { ...loaded.policy, tools: { ...toolDraft } }
        if (policy.mode === 'legacy') delete policy.mode
        const res = await savePolicy(policy, inWorkspace || !groupsDirty ? undefined : groupDraft)
        if (!res?.ok) throw new Error(res?.error || t('保存失败'))
        notice = res.note || ''
        setSavedNotice(notice)
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
      // 回读当前作用域（参数保存后服务端可能规范化；策略也可能被合并）
      const fresh = await readPolicy()
      if (!fresh?.ok) throw new Error(t('保存已完成，但重新读取失败：{error}', { error: fresh?.error || t('读取失败') }))
      setToolDraft({ ...(fresh.policy?.tools || {}) })
      setGroupDraft({ ...(fresh.customGroups || {}) })
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
  // 单一数据源：这一页只认 `toolLoadingSettings()` / `workspaceToolLoading()` 的 tools 行。
  // 计数、分组、覆盖数全部从同一份 rows 派生，不再“概览数一套、列表数另一套”。
  const manageable = (loaded?.tools || []).filter((row) => row.protected !== true)
  const policyOf = (row) => (Object.hasOwn(toolDraft, row.name) ? toolDraft[row.name] : (row.policy || 'resident'))
  const residentCount = manageable.filter((row) => policyOf(row) === 'resident').length
  const deferredCount = manageable.length - residentCount
  const overrideOf = (row) => Object.hasOwn(toolDraft, row.name)
  const changedCount = manageable.filter((row) => {
    const explicit = Object.hasOwn(toolDraft, row.name)
    return explicit !== Object.hasOwn(savedTools, row.name) || (explicit && toolDraft[row.name] !== savedTools[row.name])
  }).length
  const protectedTools = (loaded?.tools || []).filter((row) => row.protected === true)
  const needle = toolQuery.trim().toLowerCase()
  const searching = needle !== ''
  // 任何筛选命中都要展开命中的组（DESIGN §14.4-3）：否则"匹配 26 个"和眼前三个组头对不上。
  const filtering = searching || toolFilter !== 'all' || toolType !== 'all'
  const rowMatches = (row) => (!needle || [row.name, toolLabel(row), row.description || ''].join(' ').toLowerCase().includes(needle))
    && (toolFilter === 'all' || (toolFilter === 'overridden' ? overrideOf(row) : policyOf(row) === toolFilter))
  // 分组草稿 → 成员索引。**一个工具只出现一处**：被分走的行从系统分组里退出显示。
  const membership = groupMembershipOf(groupDraft)
  const ungrouped = manageable.filter((row) => !membership.has(row.name))
  const groups = toolGroups(ungrouped)
  const allSystemGroups = new Map(toolGroups(manageable).map((group) => [group.key, group]))
  const customGroups = Object.entries(groupDraft).map(([name, entry]) => {
    const allRows = manageable.filter((row) => membership.get(row.name) === name)
    return { key: 'custom:' + name, section: 'custom', name, policy: entry?.policy, allRows, rows: allRows.filter(rowMatches) }
  })
  const showCustomSection = toolType === 'all' || toolType === 'custom'
  const visibleCustom = showCustomSection
    ? customGroups
      .filter((group) => focusOwner === null)
      .filter((group) => group.rows.length > 0 || (!searching && toolFilter === 'all'))
    : []
  const visibleGroups = groups
    .filter((group) => toolType === 'all' || group.section === toolType)
    .filter((group) => (focusOwner === null || group.owner === focusOwner))
    .map((group) => ({ ...group, allRows: group.rows, rows: group.rows.filter(rowMatches) }))
    .filter((group) => group.rows.length > 0 || (focusOwner === null && !searching && toolFilter === 'all'))
  // 系统组头据此说"这 N 个在自定义分组里"：少了的工具要有去处，不能凭空消失。
  const movedOf = (group) => {
    const all = allSystemGroups.get(group.key)
    return all ? all.rows.filter((row) => membership.has(row.name)).length : 0
  }
  // 批量作用对象：勾选优先，否则当前匹配集合；两者都没有时不渲染动作条。
  const selectedRows = manageable.filter((row) => selected[row.name])
  const matchedRows = manageable.filter(rowMatches)
  const batchRows = selectedRows.length ? selectedRows : matchedRows
  const showBatch = loaded !== null && (selectedRows.length > 0 || filtering)
  const batchLabel = selectedRows.length
    ? t('已选 {count} 个 · 共匹配 {total} 个', { count: selectedRows.length, total: matchedRows.length })
    : t('匹配 {count} 个', { count: matchedRows.length })
  // 默认全部收起：MCP 与内置分类都是。首屏只留分区/组头（各带工具数与策略摘要），
  // 搜一次或点一下才展开。曾经 MCP 收起、内置展开，结果 34 个内置行把首屏铺满，
  // “按用途分类”在视觉上等于没做。
  const groupOpen = (group) => {
    if (collapsedFiltered[group.key]) return false
    if (filtering && group.rows.length > 0) return true
    return openGroups[group.key] ?? false
  }
  const toggleGroup = (group) => {
    const open = groupOpen(group)
    if (filtering && group.rows.length > 0) {
      setCollapsedFiltered((prev) => {
        const next = { ...prev }
        if (open) next[group.key] = true
        else delete next[group.key]
        return next
      })
      return
    }
    setOpenGroups((prev) => ({ ...prev, [group.key]: !open }))
  }
  const summaryOf = (group) => {
    const rows = group.allRows || group.rows
    const resident = rows.filter((row) => policyOf(row) === 'resident').length
    const deferred = rows.length - resident
    const policyText = resident === rows.length
      ? t('全部常驻')
      : deferred === rows.length ? t('全部按需') : t('{resident} 常驻 / {deferred} 按需', { resident, deferred })
    const overrides = rows.filter(overrideOf).length
    return overrides > 0 ? t('{policy} · {count} 个单独设置', { policy: policyText, count: overrides }) : policyText
  }

  // ── 批量与分组动作（全部只改草稿；保存条仍是唯一落盘点）────────────────
  const toggleSelect = (name) => setSelected((prev) => {
    const next = { ...prev }
    if (next[name]) delete next[name]
    else next[name] = true
    return next
  })
  const selectRows = (rows) => setSelected((prev) => {
    const next = { ...prev }
    const every = rows.length > 0 && rows.every((row) => next[row.name])
    for (const row of rows) {
      if (every) delete next[row.name]
      else next[row.name] = true
    }
    return next
  })
  // 一步一次撤销：快照只在批量动作前取一份，整页仍有「放弃修改」。
  const setMany = (value) => {
    if (!batchRows.length) return
    setLastBulk({ draft: { ...toolDraft }, groups: { ...groupDraft } })
    setToolDraft((prev) => {
      const next = { ...prev }
      for (const row of batchRows) {
        if (value === 'inherit') delete next[row.name]
        else next[row.name] = value
      }
      return next
    })
  }
  const undoBulk = () => {
    if (!lastBulk) return
    setToolDraft(lastBulk.draft)
    setGroupDraft(lastBulk.groups)
    setLastBulk(null)
  }
  const setGroupPolicy = (name, value) => setGroupDraft((prev) => {
    const next = { ...prev, [name]: { ...(prev[name] || { tools: [] }) } }
    if (value === 'inherit') delete next[name].policy
    else next[name].policy = value
    return next
  })
  // 移动语义：从原组移除，再进目标组。一个工具只在一个组里。
  const joinGroup = (target) => {
    const names = batchRows.map((row) => row.name)
    if (!names.length || !target) return
    setGroupDraft((prev) => moveToolsIntoGroup(prev, target, names))
    setSelected({})
  }
  const deleteGroup = (name) => {
    setGroupDraft((prev) => {
      const next = { ...prev }
      delete next[name]
      return next
    })
    setGroupDelete(null)
  }
  const openCreate = () => setGroupPrompt({ mode: 'create', value: '', error: '', target: '' })
  const openSaveAs = () => setGroupPrompt({
    mode: 'save',
    value: toolQuery.trim() || (toolType === 'other' ? t('其他工具') : ''),
    error: '',
    target: '',
  })
  const openRename = (name) => setGroupPrompt({ mode: 'rename', value: name, error: '', target: name })
  const submitPrompt = () => {
    const prompt = groupPrompt
    if (!prompt) return
    const name = String(prompt.value || '').trim()
    const fail = (error) => setGroupPrompt({ ...prompt, error })
    if (name === '') return fail(t('组名不能为空'))
    if (prompt.mode === 'rename') {
      if (name !== prompt.target && Object.hasOwn(groupDraft, name)) return fail(t('组名已存在'))
      setGroupDraft((prev) => {
        const next = {}
        for (const [key, entry] of Object.entries(prev)) next[key === prompt.target ? name : key] = entry
        return next
      })
      setOpenGroups((prev) => ({ ...prev, ['custom:' + name]: true }))
      setGroupPrompt(null)
      return
    }
    if (Object.hasOwn(groupDraft, name)) return fail(t('组名已存在'))
    const names = prompt.mode === 'save' ? batchRows.map((row) => row.name) : []
    // 刚批量设成同一个显式值时，把它**上提**为组策略并删掉逐工具覆盖：
    // 否则组策略会被这些覆盖压住，组头点了没反应（DESIGN §13.2-2）。
    let promoted
    if (prompt.mode === 'save' && names.length) {
      const values = new Set(names.map((tool) => toolDraft[tool]))
      const [only] = values
      if (values.size === 1 && (only === 'resident' || only === 'deferred')) promoted = only
    }
    setGroupDraft((prev) => {
      const next = moveToolsIntoGroup(prev, name, names)
      next[name] = { ...(next[name] || { tools: [] }) }
      if (promoted) next[name].policy = promoted
      return next
    })
    if (promoted) {
      setToolDraft((prev) => {
        const next = { ...prev }
        for (const tool of names) delete next[tool]
        return next
      })
    }
    setOpenGroups((prev) => ({ ...prev, ['custom:' + name]: true }))
    setSelected({})
    setGroupPrompt(null)
  }
  // 概览条：一格回答一个“现在是什么局面”。数值全部与列表同源。
  const stat = (mark, value, label, note) => h('div', { className: 'dsh-mcp-tool-stat', title: note || label },
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
  const scopeBar = inline && scopes && scopes.length > 1
    ? h('div', { className: 'dsh-mcp-tool-scope' },
      h('span', { className: 'dsh-mcp-tool-scope-label' }, t('作用域')),
      h(ScopeTabs, { tabs: scopes, active: scope, onSelect: (next) => onScope?.(next) }),
    )
    : null
  const overview = loaded === null ? null : h('div', { className: 'dsh-mcp-tool-overview' },
    stat('', manageable.length, t('可设置'), t('按服务器 / 用途分组')),
    stat('resident', residentCount, t('常驻'), t('每轮都在上下文里')),
    stat('deferred', deferredCount, t('按需'), t('搜索命中后加载')),
    stat('protected', protectedTools.length, t('受保护'), protectedTools.map((row) => row.name).join(' / ')),
  )
  const toolbar = h('div', { className: 'dsh-mcp-tool-toolbar' },
    h('div', { className: 'dsh-mcp-search' }, h(Icon, { d: ICONS.search }), h('input', { value: toolQuery,
      placeholder: t('按名称或用途搜索'), 'aria-label': t('按名称或用途搜索'), onChange: (e) => setToolQuery(e.target.value) })),
    h('div', { className: 'dsh-mcp-tool-filters' },
      // 类型是**视图筛选**，不是策略：MCP 与内置工具在策略上本来就分开（组级 vs 逐工具），
      // 这个筛选只回答“我现在只想看哪一类”。切类型时清掉「只看这台」，否则内置页会被
      // 一个服务器名过滤成空列表。
      h('span', { className: 'dsh-mcp-tool-filter-label' }, t('类型')),
      h('div', { className: 'dsh-mcp-tool-filter', role: 'group', 'aria-label': t('按类型筛选') },
        ...[['all', t('全部')], ['custom', t('我的分组')], ['builtin', t('内置')], ['mcp', t('MCP')], ['other', t('其他')]].map(([id, label]) => h('button', {
          key: id, type: 'button', 'aria-pressed': toolType === id, onClick: () => { setToolType(id); if (id !== 'all') setFocusOwner(null) },
        }, label)),
      ),
      h('span', { className: 'dsh-mcp-tool-filter-label' }, t('加载方式')),
      h('div', { className: 'dsh-mcp-tool-filter', role: 'group', 'aria-label': t('按加载策略筛选') },
        ...[['all', t('全部')], ['resident', t('常驻')], ['deferred', t('按需')], ['overridden', t('有覆盖')]].map(([id, label]) => h('button', {
          key: id, type: 'button', 'aria-pressed': toolFilter === id, onClick: () => setToolFilter(id),
        }, label)),
      ),
    ),
  )
  // 这一页**不写**整台默认（groups）：整台默认只有一个入口——MCP 列表的芯片。
  // 页面只显示它，并在被整体方案压住时给横幅，避免同一件事在三个地方各有一个开关。
  const banner = loaded?.masterSwitch === 'off'
    ? h('div', { className: 'dsh-mcp-tool-banner', role: 'status' }, t('ToolSearch 总开关（DSH_MCP_TOOL_SEARCH=off）生效中：所有工具常驻，本页设置暂不生效；关掉开关后设置会恢复。'))
    : manageable.some((row) => row.reason === 'mode-resident')
      ? h('div', { className: 'dsh-mcp-tool-banner', role: 'status' }, t('整体方案为「全部常驻」（配置里写的）：本页的逐工具设置会保留，但此刻不生效。'))
      : null
  const focusBar = focusOwner === null ? null : h('div', { className: 'dsh-mcp-tool-focus' },
    h('span', null, t('只看 {name}', { name: focusOwner })),
    h('button', { type: 'button', className: 'dsh-mcp-btn sm ghost', onClick: () => setFocusOwner(null) }, t('显示全部')),
  )
  // 搜索参数是 ToolSearch 的**核心配置**（一次返回几条、目录多大、已发现集能留多久），
  // 因此固定在页面顶部、默认可见，不折叠、不塞到列表末尾。
  const parameters = h('section', { className: 'dsh-mcp-tool-params' },
    h('h4', { className: 'dsh-mcp-tool-params-title' }, t('搜索设置')),
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
            if (next && String(params.maxCatalogChars ?? '').trim() === '') setParam('maxCatalogChars', String(CATALOG_CHARS_SUGGESTION))
            setSearchSaved(false)
          } }),
          h('input', { type: 'number', min: 1, step: 1, disabled: !limitOn || !searchLoaded || saving,
            value: params.maxCatalogChars ?? '', placeholder: String(CATALOG_CHARS_SUGGESTION),
            'aria-label': t('最多字符数'), onChange: (e) => setParam('maxCatalogChars', e.target.value) }),
        ),
      ),
    ),
    // 目录体检单独成块（**不塞进参数网格**）：它是一段会读的文字，挤在 1/3 列里既难读，
    // 也会把三个参数挤成两行。三个数各自回答一个问题：延迟服务器（谁在按需加载）、
    // 上次组装的 listed/truncated（预算够不够）。null 时**如实说“还没组装过”**，不编 0。
    catalogFacts ? h('div', { className: 'dsh-mcp-tool-facts' },
      h('div', { className: 'dsh-mcp-tool-params-note' }, catalogFactsText(catalogFacts)),
      // R13b：模型真实搜过什么。按时间倒序（最近的在前）——**不按“有没有命中”排序**：
      // 目录完整时 `select:` 照抄名字必然命中，“无命中”几乎只说明它抄错了名字，不是缺陷信号。
      // 这里显示的文字**不进模型上下文**——execute 的返回没有被改过。
      recentSearchesText(catalogFacts.recentSearches).length
        ? h('div', { className: 'dsh-mcp-tool-params-note' },
          t('最近的搜索（按时间倒序）'),
          ...recentSearchesText(catalogFacts.recentSearches).map((line, index) => h('div', { key: String(index) }, line)))
        : h('div', { className: 'dsh-mcp-tool-params-note' }, t('还没有搜索记录：模型调用 tool_search 之后这里会有。')),
    ) : null,
    searchError ? h('div', { className: 'dsh-mcp-d-err' }, searchError) : null,
    searchSaved ? h('p', { role: 'status', className: 'dsh-mcp-tool-param-saved' }, savedNotice || t('参数已保存')) : null,
  )
  const sectionHead = (key, label, extra = null) => h('div', { className: 'dsh-mcp-tool-section-head', key },
    h('h4', null, label),
    extra,
  )
  const checkAll = (rows) => {
    const allChecked = rows.length > 0 && rows.every((row) => selected[row.name])
    const someChecked = rows.some((row) => selected[row.name])
    return h('input', {
      type: 'checkbox',
      className: 'dsh-mcp-tool-check',
      checked: allChecked,
      disabled: saving,
      'aria-label': t('选择这一组的全部工具'),
      ref: (el) => { if (el) el.indeterminate = !allChecked && someChecked },
      onChange: () => selectRows(rows),
    })
  }
  const customGroupNode = (group) => {
    const open = groupOpen(group)
    const follow = group.policy === undefined
    const followLabel = t('跟随宿主默认')
    return h('section', { className: 'dsh-mcp-tool-group' + (open ? ' open' : ''), key: group.key },
      h('div', { className: 'dsh-mcp-tool-group-head' },
        checkAll(group.allRows),
        h('button', { type: 'button', className: 'dsh-mcp-tool-group-toggle', 'aria-expanded': open, onClick: () => toggleGroup(group) },
          h(Caret, { open }),
          h('span', { className: 'dsh-mcp-tool-group-name' }, group.name),
          h('span', { className: 'dsh-mcp-tool-group-count' }, String(group.allRows.length)),
          h('span', { className: 'dsh-mcp-tool-group-summary' }, summaryOf(group)),
        ),
        h('span', { className: 'dsh-mcp-tool-pick', role: 'group', 'aria-label': t('整组加载方式') },
          ...TOOL_POLICY_CHOICES.map((choice) => h('button', {
            key: choice.id,
            type: 'button',
            className: choice.id === 'resident' ? 'is-resident' : choice.id === 'deferred' ? 'is-deferred' : 'is-inherit',
            'aria-pressed': choice.id === 'inherit' ? follow : (!follow && group.policy === choice.id),
            title: choice.id === 'inherit' ? t('不单独设置这个分组：成员跟随宿主默认') : undefined,
            disabled: saving || inWorkspace,
            onClick: () => setGroupPolicy(group.name, choice.id),
          }, choice.id === 'inherit' ? followLabel : t(choice.label))),
        ),
        h(DropMenu, {
          label: '⋯',
          title: t('分组操作'),
          cls: 'sm',
          disabled: inWorkspace || saving,
          items: [
            { key: 'rename', label: t('重命名'), onSelect: () => openRename(group.name) },
            {
              key: 'add',
              label: t('把选中的 {count} 个加进来', { count: batchRows.length }),
              disabled: !batchRows.length,
              onSelect: () => joinGroup(group.name),
            },
            { key: 'delete', label: t('删除分组'), danger: true, onSelect: () => setGroupDelete(group.name) },
          ],
        }),
      ),
      open ? h('div', { className: 'dsh-mcp-tool-list' },
        group.rows.length
          ? group.rows.map((row) => toolLoadingRow(row, toolDraft, savedTools, setTool, {
            saving,
            inherited: row.inheritedPolicy || 'resident',
            followLabel: group.policy ? t('跟随分组「{name}」', { name: group.name }) : (row.kind === 'mcp' ? t('跟随服务器') : t('宿主默认')),
            checked: !!selected[row.name],
            onToggle: toggleSelect,
          }))
          : h('div', { className: 'dsh-mcp-tool-empty' }, t('还没有工具：勾选上面的工具后点「加入分组」')),
        !group.allRows.length && batchRows.length
          ? h('button', { type: 'button', className: 'dsh-mcp-btn sm', onClick: () => joinGroup(group.name) },
            t('加入选中的 {count} 个', { count: batchRows.length }))
          : null,
      ) : null,
    )
  }
  const groupNode = (group) => {
    const open = groupOpen(group)
    const groupState = group.owner ? (loaded?.groups || []).find((item) => item.owner === group.owner) : null
    // 整台默认的**唯一写入口**在 MCP 列表芯片；这里只读展示，并说清它从哪来。
    const serverDefault = groupState
      ? { value: groupState.configured === 'inherit' ? groupState.inherited : groupState.configured, follow: groupState.configured === 'inherit' }
      : (group.owner ? { value: group.allRows?.[0]?.inheritedPolicy || 'resident', follow: true } : null)
    const defaultText = serverDefault
      ? t('整台：{value}{follow}', { value: serverDefault.value === 'deferred' ? t('按需') : t('常驻'), follow: serverDefault.follow ? t('（未单独设置）') : '' })
      : null
    const moved = movedOf(group)
    return h('section', { className: 'dsh-mcp-tool-group' + (open ? ' open' : ''), key: group.key },
      h('div', { className: 'dsh-mcp-tool-group-head' },
        checkAll(group.allRows),
        h('button', { type: 'button', className: 'dsh-mcp-tool-group-toggle', 'aria-expanded': open, onClick: () => toggleGroup(group) },
          h(Caret, { open }),
          h('span', { className: 'dsh-mcp-tool-group-name' }, groupLabel(group)),
          h('span', { className: 'dsh-mcp-tool-group-count' }, String(group.allRows.length)),
          h('span', { className: 'dsh-mcp-tool-group-summary' }, summaryOf(group)),
        ),
        moved > 0 ? h('span', { className: 'dsh-mcp-tool-group-moved', title: t('这些工具已归入自定义分组，去「我的分组」里管理') },
          t('{count} 个在自定义分组里', { count: moved })) : null,
        defaultText ? h('span', { className: 'dsh-mcp-tool-group-default', title: t('整台默认在 MCP 列表的芯片上改；这里只显示结果') }, defaultText) : null,
        group.owner && focusOwner === null ? h('button', { type: 'button', className: 'dsh-mcp-tool-group-only', onClick: (e) => { e.stopPropagation(); setFocusOwner(group.owner) } }, t('只看这台')) : null,
      ),
      open ? h('div', { className: 'dsh-mcp-tool-list' },
        ...group.rows.map((row) => toolLoadingRow(row, toolDraft, savedTools, setTool, {
          saving,
          inherited: row.inheritedPolicy || groupInherited(loaded, group.owner),
          followLabel: inWorkspace ? t('跟随全局') : row.kind === 'mcp' ? t('跟随服务器') : t('宿主默认'),
          checked: !!selected[row.name],
          onToggle: toggleSelect,
        })),
      ) : null,
    )
  }
  const showList = manageable.length > 0
  const systemNodes = (() => {
    const nodes = []
    let lastSection = null
    for (const group of visibleGroups) {
      if (group.section !== lastSection) {
        lastSection = group.section
        nodes.push(sectionHead('section:' + group.section, sectionLabel(group.section)))
      }
      nodes.push(groupNode(group))
    }
    return nodes
  })()
  const list = loaded === null
    ? (error ? null : h('div', { className: 'dsh-mcp-source-detail' }, t('正在读取…')))
    : !showList
      ? h('div', { className: 'dsh-mcp-source-detail' }, t('没有可设置的工具。'))
      : (visibleCustom.length || visibleGroups.length || showCustomSection)
        ? h('div', { className: 'dsh-mcp-tool-groups' },
          showCustomSection
            ? sectionHead('section:custom', t('我的分组'),
              h('span', { className: 'dsh-mcp-tool-section-actions' },
                inWorkspace ? h('span', { className: 'dsh-mcp-tool-group-default' }, t('分组是全局的；切到「全局」作用域里改')) : null,
                h('button', { type: 'button', className: 'dsh-mcp-btn sm ghost', disabled: saving || inWorkspace, onClick: openCreate }, t('+ 新建分组'))))
            : null,
          ...visibleCustom.map(customGroupNode),
          ...systemNodes,
        )
        : h('div', { className: 'dsh-mcp-source-detail' }, t('没有匹配的工具。'))
  // 动作条：只在"已经缩小了范围"时出现（有勾选或有筛选）。不做"全部工具一键"——
  // 那和策略层拒绝"非 MCP 全局开关"是同一条理由：没有明确意图的批量等于误伤。
  const batchBar = showBatch ? h('div', { className: 'dsh-mcp-tool-batch', role: 'toolbar', 'aria-label': t('批量设置') },
    h('span', { className: 'dsh-mcp-tool-batch-count' }, batchRows.length ? batchLabel : t('没有匹配的工具')),
    h('span', { className: 'dsh-mcp-tool-batch-actions' },
      h(Btn, { cls: 'sm', disabled: saving || !batchRows.length, onClick: () => setMany('resident'), children: t('设为常驻') }),
      h(Btn, { cls: 'sm', disabled: saving || !batchRows.length, onClick: () => setMany('deferred'), children: t('设为按需') }),
      h(Btn, { cls: 'sm ghost', disabled: saving || !batchRows.length, onClick: () => setMany('inherit'), children: t('跟随') }),
      h('select', {
        className: 'dsh-mcp-tool-join',
        value: '',
        disabled: saving || !batchRows.length,
        'aria-label': t('加入分组'),
        onChange: (e) => {
          const value = e.target.value
          if (value === '__new__') openSaveAs()
          else if (value !== '') joinGroup(value)
        },
      },
      h('option', { value: '' }, t('加入分组…')),
      ...Object.keys(groupDraft).map((name) => h('option', { key: name, value: name }, name)),
      h('option', { value: '__new__' }, t('新建分组…'))),
      h(Btn, { cls: 'sm', disabled: saving || !batchRows.length, onClick: openSaveAs, children: t('存为分组') }),
      lastBulk ? h(Btn, { cls: 'sm ghost', onClick: undoBulk, children: t('撤销这一步') }) : null,
      selectedRows.length ? h(Btn, { cls: 'sm ghost', onClick: () => setSelected({}), children: t('清空选择') }) : null,
    ),
  ) : null
  const promptDialog = groupPrompt ? h('div', { className: 'dsh-mcp-overlay', onClick: (e) => e.target === e.currentTarget && setGroupPrompt(null) },
    h(Dialog, { label: groupPrompt.mode === 'rename' ? t('重命名分组') : t('新建分组'), onClose: () => setGroupPrompt(null) },
    h('div', { className: 'dsh-mcp-field' },
      h('label', null, t('分组名称')),
      h('input', {
        value: groupPrompt.value,
        maxLength: 40,
        autoFocus: true,
        placeholder: t('例如：表格工具'),
        onChange: (e) => setGroupPrompt({ ...groupPrompt, value: e.target.value, error: '' }),
        onKeyDown: (e) => { if (e.key === 'Enter') submitPrompt() },
      }),
    ),
    groupPrompt.error ? h('div', { className: 'dsh-mcp-d-err', role: 'alert' }, groupPrompt.error) : null,
    h('div', { className: 'dsh-mcp-modal-actions' },
      h(Btn, { onClick: () => setGroupPrompt(null), children: t('取消') }),
      h(Btn, { cls: 'primary', onClick: submitPrompt, children: t('确定') }),
    )),
  ) : null
  const deleteDialog = groupDelete ? h('div', { className: 'dsh-mcp-overlay', onClick: (e) => e.target === e.currentTarget && setGroupDelete(null) },
    h(Dialog, { label: t('删除分组'), onClose: () => setGroupDelete(null) },
      h('p', null, t('{count} 个工具将回到「未分组」并跟随宿主默认；它们自己的逐工具设置不受影响。', {
        count: (groupDraft[groupDelete]?.tools || []).length,
      })),
      h('div', { className: 'dsh-mcp-modal-actions' },
        h(Btn, { onClick: () => setGroupDelete(null), children: t('取消') }),
        h(Btn, { cls: 'primary', onClick: () => deleteGroup(groupDelete), children: t('删除') }),
      )),
  ) : null
  const fixed = [
    inline ? null : hero,
    error ? h('div', { className: 'dsh-mcp-d-err', role: 'alert' }, error) : null,
    scopeBar,
    loaded === null ? null : h(React2.Fragment, null, banner,
      inWorkspace
        ? h('div', { className: 'dsh-mcp-tool-hint' }, t('搜索设置是全局配置；切到「全局」作用域里改。'))
        : parameters,
      overview, toolbar, batchBar, focusBar),
  ]
  // 只有列表进入滚动区：搜索参数、概览、筛选、动作条固定在顶部。
  const scroll = [list]
  if (inline) return h('div', { className: 'dsh-mcp-tool-loading-page' },
    h('div', { className: 'dsh-mcp-tool-fixed' }, ...fixed),
    h('div', { className: 'dsh-mcp-tool-scroll' }, ...scroll),
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
    promptDialog,
    deleteDialog,
  )
  return h('div', { className: 'dsh-mcp-overlay', onClick: (e) => e.target === e.currentTarget && onClose?.() },
    h(Dialog, { label: t('工具加载'), onClose }, ...fixed, ...scroll, promptDialog, deleteDialog),
  )
}
