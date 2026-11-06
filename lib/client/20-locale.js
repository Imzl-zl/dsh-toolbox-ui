// ── 文案层（locale） ────────────────────────────────────────────────────
//
// 面板的每一句用户可见文案都走这里的 t()。两种语言：源码里的中文字面量是**基准**
// （zh），英文表是它的镜像（en）。
//
// 为什么用「中文字面量当 key」而不是另起一套符号键（'mcp.add.title' 之类）：
//   1. 改动面最小——650 处调用点不需要为取名字再想一遍，替换的是 t('中文') 而不是
//      t(KEY)，键与文案永远不可能对不上（符号键最容易出的错就是改文案忘了改键）。
//   2. 不会漏——哪天新增一句没进英文表，界面上直接显示中文原文，是**看得见的**缺口；
//      符号键漏了则显示 'mcp.some.key'，同样看得见，但中文原文至少还是可读的。
//   3. 拼接句（'已连接 · ' + refs + ' 个会话在用'）在中文里语序固定，英文里未必；
//      所以带参数的句子用 {n} 占位符写成**一条**键，而不是把碎片拼起来。
//
// ctx.locale 不在时会退化成恒等函数（语言包插件缺失、或宿主没挂 dsh-client-locale），
// 面板照常显示中文——**绝不因为翻译层缺席而白屏**。
const LOCALE_NS = 'dsh-toolbox-ui';

/** 英文词典：键是源码里的中文字面量（含 {占位符}），值是英文。 */
const EN_DICT = {
  // —— 作用域与来源标签 ——
  '项目 · .dsh/skills': 'Project · .dsh/skills',
  '项目 · .agents/skills': 'Project · .agents/skills',
  '自定义目录': 'Custom directory',
  '全局 · .dsh/skills': 'Global · .dsh/skills',
  '全局 · .agents/skills': 'Global · .agents/skills',
  '内置（只读）': 'Built-in (read-only)',
  '项目': 'Project',
  '项目 {name}': 'Project {name}',
  // —— 通用 ——
  '全部': 'All',
  '全部作用域（{count}）': 'All scopes ({count})',
  '••••••（保留原值）': '•••••• (keep existing value)',
  '取消': 'Cancel',
  '关闭': 'Close',
  '保存': 'Save',
  '保存中…': 'Saving…',
  '添加': 'Add',
  '编辑': 'Edit',
  '移除': 'Remove',
  '启用': 'Enable',
  '停用': 'Disable',
  '重试': 'Retry',
  '重试中…': 'Retrying…',
  '刷新': 'Refresh',
  '刷新中…': 'Refreshing…',
  '加载中…': 'Loading…',
  '安装': 'Install',
  '安装中…': 'Installing…',
  '复制': 'Copy',
  '复制 JSON': 'Copy JSON',
  '复制失败': 'Copy failed',
  '已复制到剪贴板': 'Copied to clipboard',
  '已复制 JSON 到剪贴板': 'JSON copied to clipboard',
  '复制失败，请手动全选复制': 'Copy failed — select all and copy manually',
  '下载文件': 'Download file',
  '排序': 'Sort',
  '默认': 'Default',
  '默认顺序': 'Default order',
  '按名称': 'By name',
  '名称': 'Name',
  '按状态': 'By status',
  '状态': 'Status',
  '位置': 'Location',
  '来源': 'Source',
  '许可': 'License',
  '文档': 'Docs',
  '页面': 'Page',
  '概览': 'Overview',
  '工具': 'Tools',
  '诊断': 'Diagnostics',
  '技能正文': 'Skill body',
  '详情分区': 'Detail sections',
  '必填': 'Required',
  '可选': 'Optional',
  '可选值：{values}': 'Allowed values: {values}',
  '默认值：{value}': 'Default: {value}',
  '收起参数': 'Hide arguments',
  '查看参数': 'Show arguments',
  '收起原始 JSON': 'Hide raw JSON',
  '查看原始 JSON': 'Show raw JSON',
  // —— 页面骨架 ——
  '扩展中心': 'Extension Center',
  '工具箱': 'Toolbox',
  '工具箱面板': 'Toolbox panel',
  '工具箱面板（可拖拽移动）': 'Toolbox panel (drag to move)',
  '打开工具箱面板': 'Open the Toolbox panel',
  '能力层': 'Ability layer',
  '模式': 'Mode',
  '入口': 'Entry points',
  '入口显示：{mode}': 'Entry points: {mode}',
  '悬浮按钮 + 侧栏入口': 'Floating button + sidebar entry',
  '仅悬浮按钮': 'Floating button only',
  '仅侧栏入口': 'Sidebar entry only',
  '技能': 'Skills',
  '已安装': 'Installed',
  '发现市场': 'Market',
  // —— 连接与运行状态 ——
  '挂载失败': 'Mount failed',
  '作用域隔离失败': 'Scope isolation failed',
  '作用域故障': 'Scope fault',
  '已禁用': 'Disabled',
  '状态未知': 'Status unknown',
  '连接中…': 'Connecting…',
  '连接失败': 'Connection failed',
  '尚未建立连接（新会话自动挂载）': 'Not connected yet (mounted automatically by a new session)',
  '已连接': 'Connected',
  '已停止': 'Stopped',
  '失败': 'Failed',
  '已连接 · {refs} 个会话在用{tools}': 'Connected · in use by {refs} session(s){tools}',
  '已连接 · 当前无会话使用（连接保留，下次直接用）{tools}': 'Connected · no session using it (connection kept for next time){tools}',
  ' · {count} 工具': ' · {count} tool(s)',
  '{count} 工具': '{count} tool(s)',
  '{count} 个工具': '{count} tool(s)',
  '{count} 个会话共用': 'shared by {count} session(s)',
  '（宿主没有给出原因）': '(the Host gave no reason)',
  '宿主 MCP 读取失败': 'Could not read MCP from the Host',
  'skills 服务未就绪': 'skills service not ready',
  '宿主 skills 服务未就绪，技能面已降级': 'The Host skills service is not ready; the skills pane is degraded',
  '未取到 remote.skillsManager（{reason}）。技能面不可用，MCP 面不受影响。':
    'remote.skillsManager is unavailable ({reason}). The skills pane is unusable; the MCP pane is unaffected.',
  '原因未知': 'reason unknown',
  '排查': 'Troubleshoot',
  '检查宿主是否挂载并启用了 @deepseek-ai/dsh-skill': 'Check that the Host mounts and enables @deepseek-ai/dsh-skill',
  'MCP 配置读取失败': 'Could not read the MCP configuration',
  '加载失败': 'Loading failed',
  // —— 作用域与项目 ——
  '全局': 'Global',
  '全局（当前 profile）': 'Global (current profile)',
  '全局配置': 'Global configuration',
  '项目配置': 'Project configuration',
  '选择左侧的一个 MCP': 'Select an MCP on the left',
  '这里会显示它的连接配置、已注册的工具，以及连接失败时的诊断。':
    'Its connection settings, registered tools, and connection-failure diagnostics appear here.',
  '选择左侧的一个技能': 'Select a skill on the left',
  '这里会显示它的位置与调用权限、SKILL.md 正文，以及遮蔽或校验失败时的诊断。':
    'Its location, invocation permissions, SKILL.md body, and any shadowing or validation diagnostics appear here.',
  '没有匹配的 MCP': 'No matching MCP',
  '没有全局 MCP': 'No global MCP',
  '没有匹配的全局 MCP': 'No matching global MCP',
  '没有发现技能。检查宿主是否挂载了 dsh-skill 内置插件。':
    'No skills found. Check that the Host mounts the dsh-skill built-in plugin.',
  '没有匹配的技能': 'No matching skills',
  '搜索 MCP…': 'Search MCP…',
  '搜索全局 MCP…': 'Search global MCP…',
  '搜索技能…': 'Search skills…',
  '搜索服务、用途或提供方…': 'Search services, purposes, or providers…',
  '搜索 skillhub.cn（回车）': 'Search skillhub.cn (press Enter)',
  '搜索 MCP 服务': 'Search MCP services',
  '搜索技能': 'Search skills',
  '按分类浏览': 'Browse by category',
  '按传输过滤': 'Filter by transport',
  '按状态过滤': 'Filter by status',
  '排序方式': 'Sort order',
  '全部传输': 'All transports',
  '全部状态': 'All statuses',
  // —— MCP 列表操作 ——
  '添加 MCP': 'Add MCP',
  '添加项目 MCP': 'Add project MCP',
  '编辑 MCP': 'Edit MCP',
  '导入 MCP': 'Import MCP',
  '导入 MCP（{scope}）': 'Import MCP ({scope})',
  '导出项目 MCP': 'Export project MCP',
  '复制项目 MCP': 'Copy project MCP',
  '复制项目 MCP 到另一个工作区': 'Copy project MCP to another workspace',
  '导出': 'Export',
  '复制到…': 'Copy to…',
  '排序 MCP': 'Sort MCP',
  '排序技能': 'Sort skills',
  '更多操作': 'More actions',
  '刷新列表': 'Refresh list',
  '重连': 'Reconnect',
  '重连本项目共享连接（拆掉旧连接并按当前配置重建，不影响其他会话）':
    'Reconnect this project’s shared connection (tear down the old one and rebuild from the current config; other sessions are unaffected)',
  '导出本项目的 MCP 配置（JSON，可备份、跨机器迁移或分享）':
    'Export this project’s MCP configuration (JSON — back up, migrate across machines, or share)',
  '把本项目的 MCP 复制到另一个已注册的工作区':
    'Copy this project’s MCP into another registered workspace',

  // —— 第二批：由面板其余文案补全（见 README 的开发说明）——
  'npx 或 C:\\path\\to\\bin.exe': "npx or C:\\path\\to\\bin.exe",
  '.dsh/skills': ".dsh/skills",
  '.agents/skills': ".agents/skills",
  '项目 {name} · {detail}': "Project {name} · {detail}",
  'Filesystem · 本地文件读写': "Filesystem · Local file read/write",
  'Memory · 知识图谱记忆': "Memory · Knowledge graph memory",
  'Sequential Thinking · 分步推理': "Sequential Thinking · Step-by-step reasoning",
  'Time · 时区时间工具（需 uvx）': "Time · Time zone & time tools (requires uvx)",
  'Git · 版本控制（需 uvx）': "Git · Version control (requires uvx)",
  '目标工作区当前有 {count} 个 MCP': "Target workspace currently has {count} MCP servers",
  '新增：{names}': "Added: {names}",
  '、': ", ",
  // 裸拼接的中文标点也走词典：英文排版用 ASCII（': ' 带尾随空格；括号走 '（{name}）' 整句）。
  '：': ": ",
  '覆盖同名：{names}': "Overwrite same name: {names}",
  '跳过同名（保留目标原配置）：{names}': "Skip same name (keep target config): {names}",
  '没有要写入的条目': "No entries to write",
  '{total} 个服务 · {on} 启用{suffix}': "{total} servers · {on} enabled{suffix}",
  ' · {count} 失败': " · {count} failed",
  '{total} 个技能 · {on} 已启用{suffix}': "{total} skills · {on} enabled{suffix}",
  ' · {count} 已停用': " · {count} disabled",
  '：已启用': ": Enabled",
  '：已禁用': ": Disabled",
  '禁用': "Disable",
  '来自其他配置层，只读': "From another config layer, read-only",
  '已屏蔽：': "Blocked: ",
  '可见：': "Visible: ",
  '已在此项目屏蔽，点击恢复可见': "Blocked in this project, click to restore visibility",
  '在此项目可见，点击屏蔽': "Visible in this project, click to block",
  '已屏蔽': "Blocked",
  '复制 {label}': "Copy {label}",
  '隐藏 {label}': "Hide {label}",
  '显示 {label}': "Show {label}",
  '显示/隐藏 {label}': "Show/hide {label}",
  '此 MCP 由全局配置提供。要改它的连接配置，请切到「全局」标签页；在这里只能决定它对本项目是否可见。': "This MCP is provided by the global config. To change its connection settings, switch to the \"Global\" tab; here you can only decide whether it is visible to this project.",
  '以下项目也定义了同名 serverName：{names}。DSH 0.1.5 起各注册作用域可独立使用同名；更早的版本按全进程唯一判定，同名会导致其中一份启动失败。': "The following projects also define an MCP with the same serverName: {names}. Since DSH 0.1.5, each registration scope can use the same name independently; earlier versions required process-wide uniqueness, so a duplicate name caused one of them to fail to start.",
  '工具命名与其他 serverName 前缀重叠，无法可靠判断归属；请避免在 serverName 中使用双下划线。': "Tool names overlap with the prefixes of other serverNames, so ownership cannot be determined reliably; avoid using double underscores in serverName.",
  'serverName 同名冲突': "Duplicate serverName",
  '已在此项目屏蔽': "Blocked in this project",
  '在此项目可见': "Visible in this project",
  '来自 mcp-client 最近日志': "From recent mcp-client logs",
  '连接信息': "Connection info",
  '传输': "Transport",
  '命令': "Command",
  '参数': "Args",
  '工作目录': "Working directory",
  '是': "Yes",
  '否（补丁中 disabled: true）': "No (disabled: true in patch)",
  '配置来源': "Config source",
  '{base}，另有 {count} 条同名条目由其他配置层提供（{ids}）': "{base}, plus {count} other same-named entries from another config layer ({ids})",
  '同一 serverName 在 loader 里还有 {count} 条条目，由其他配置层提供（{items}）。mcp-client 在连接期按作用域判重，同名条目里只有一条能连上；本面板只能编辑/移除属于当前 profile 的那条。': "The same serverName also exists as {count} more loader entries owned by other config layers ({items}). mcp-client rejects duplicates per registration scope at connect time, so only one of them can connect; this panel can only edit/remove the entry owned by the current profile.",
  '（已禁用）': " (disabled)",
  '全局配置（在「全局」标签页可编辑）': "Global config (editable on the \"Global\" tab)",
  '项目配置 .dsh/mcp.json（可编辑，本项目会话共享一份连接）': "Project config .dsh/mcp.json (editable, sessions in this project share one connection)",
  '当前 Web profile（可编辑）': "Current Web profile (editable)",
  '其他 bundle / Agent（只读）': "Other bundles / Agents (read-only)",
  '调用超时': "Invocation timeout",
  '启动失败策略': "Startup failure policy",
  '阻止插件启动': "Block plugin startup",
  '记录错误并继续': "Log error and continue",
  '自动重连': "Auto-reconnect",
  '{min}–{max} ms，最多 {attempts} 次': "{min}–{max} ms, up to {attempts} attempts",
  '环境变量': "Env vars",
  '环境变量 {name}': "Env var {name}",
  '工具（{count}）': "Tools ({count})",
  '工具归属存在命名歧义': "Tool ownership is ambiguous",
  '尚无会话持有该项目连接，或连接尚未就绪': "No session holds a connection for this project yet, or the connection is not ready",
  '暂无工具': "No tools yet",
  '未检测到配置层冲突或工具归属歧义。': "No config layer conflicts or tool ownership ambiguity detected.",
  '请填写 MCP 名称': "Please enter an MCP name",
  '工具超时和最大尝试次数必须是正整数': "Tool timeout and max attempts must be positive integers",
  '重连延迟必须是有效正数且不超过 2147483647 ms': "Reconnect delay must be a valid positive number no greater than 2147483647 ms",
  '首次延迟不能大于最大延迟': "Initial delay cannot exceed max delay",
  '隐藏原值：': "Hide original value: ",
  '显示原值：': "Show original value: ",
  '从预设模板快速填充（可选，命令需本机 npx/uvx）': "Quick-fill from a preset template (optional, command requires local npx/uvx)",
  '选择预设模板': "Select preset template",
  '— 选择预设 —': "— Select preset —",
  'MCP 名称（唯一标识，不可改）': "MCP name (unique ID, cannot be changed)",
  '传输类型': "Transport type",
  'HTTP（远程）': "HTTP (remote)",
  'stdio（本地进程）': "stdio (local process)",
  '参数（每行一个，原样传给进程）': "Args (one per line, passed to the process as-is)",
  '工作目录 cwd（可选）': "Working directory cwd (optional)",
  'Headers（可选）': "Headers (optional)",
  '环境变量（可选，值写 !!js process.env.KEY 引用密钥）': "Env vars (optional, use !!js process.env.KEY as the value to reference a secret)",
  'Bearer … 或 !!js process.env.KEY': "Bearer … or !!js process.env.KEY",
  '删除此项': "Delete this entry",
  '删除 {name}': "Delete {name}",
  '配置项': "Config entries",
  '+ 添加': "+ Add",
  '运行策略': "Runtime policy",
  '工具调用超时（毫秒）': "Tool invocation timeout (ms)",
  '首次连接失败时阻止插件启动': "Block plugin startup on initial connection failure",
  // —— ToolSearch 延迟加载 ——
  '延迟加载工具（ToolSearch 按需搜索）': "Defer tool loading (on demand via ToolSearch)",
  '开启后该服务器的工具不再全量常驻上下文，模型按需通过 tool_search 搜索加载；调用一次多一个往返。适合工具数量多的服务器。': "When enabled, this server's tools no longer stay resident in context; the model loads them on demand via tool_search, at the cost of one extra round trip per discovery. Suited to servers with many tools.",
  '工具延迟加载': "Tool deferral",
  // 主按钮（过滤器行那一颗）：ToolSearch 上线时只加了中文——英文界面下**主按钮显示中文**，
  // 而当时 parity 只覆盖表驱动标签，调用点上的字面量没人核对。新增词条必须同时过
  // test/client-i18n.test.mjs 的"调用点 parity"（它同时守缺英文与死词条两个方向）。
  '全部延迟': "Defer all",
  '取消全部延迟': "Undefer all",
  '延迟': "Deferred",
  // 行内单台开关（两种状态都渲染、都可点）
  '全量': "Resident",
  '该服务器的工具不常驻上下文：模型经 tool_search 按需搜索加载，命中后才进入工具列表。点击切回全量常驻。': "This server's tools do not stay resident in context: the model loads them on demand via tool_search, and they enter the tool list only after a hit. Click to keep them fully resident again.",
  '该服务器的工具每轮都常驻上下文。点击切到延迟加载：模型经 tool_search 按需搜索，命中后才进入工具列表。': "This server's tools stay resident in context every turn. Click to defer them: the model loads them on demand via tool_search, and they enter the tool list only after a hit.",
  '该服务器不属于本插件的配置，延迟开关要回到它自己的作用域里改': "This server is not configured by this plugin; switch deferral where it is configured",
  '已把 {name} 切到延迟加载': "Deferred {name}",
  '已把 {name} 切回全量常驻': "{name} is fully resident again",
  '已开启（{count} 工具经 tool_search 按需加载）': "Enabled ({count} tools load on demand via tool_search)",
  '该服务器 {count} 个工具，将经 tool_search 按需加载': "This server has {count} tools, which will load on demand via tool_search",
  '关闭（工具全量常驻上下文）': "Disabled (all tool schemas stay resident in context)",
  '该服务器仅 {count} 个工具：延迟后按需加载，但每轮仍要付一段引导语，省下的空间可能不多': "This server has only {count} tools: deferral still loads them on demand, but every turn also pays a guidance paragraph, so the space saved may be small",
  '已开启全部延迟加载': "Deferral enabled for all MCP servers",
  '已关闭全部延迟加载': "Deferral disabled for all MCP servers",
  '把当前 Web profile 的所有 MCP 切到延迟加载（{count} 个）：模型经 tool_search 按需搜索，命中后才进工具列表': "Switch all {count} MCP servers in the current Web profile to deferred loading: the model searches on demand via tool_search, and tools enter the list only after a hit",
  '把当前 Web profile 的所有 MCP 切回全量常驻（{count} 个）': "Switch all {count} MCP servers in the current Web profile back to fully resident",
  '把该项目的所有 MCP 切到延迟加载（{count} 个）：模型经 tool_search 按需搜索，命中后才进工具列表': "Switch all {count} MCP servers in this project to deferred loading: the model searches on demand via tool_search, and tools enter the list only after a hit",
  '把该项目的所有 MCP 切回全量常驻（{count} 个）': "Switch all {count} MCP servers in this project back to fully resident",
  // —— C2：延迟加载参数表单 ——
  '一次最多返回几个': "Max tools per search",
  '限制目录大小': "Limit catalog size",
  '保存失败': "Failed to save",
  // —— 统一工具加载策略（表驱动文案走 localized()，这里只收 t() 的调用点）——
  '工具': "Tools",
  '受保护': "Protected",
  '加载方式': "Loading mode",

  '放弃修改': "Discard changes",
  '保存已完成，但重新读取失败：{error}': "Saved, but reloading failed: {error}",
  '已保存工具加载策略': "Tool loading policy saved",
  '搜索参数': "Search settings",
  '一次最多返回几个': "Results per search",
  '搜一次最多拿回几条。调小可能漏掉要用的那个，调大每次多占一点上下文。默认 10。': "How many results one search returns. Smaller may miss the tool; larger costs a little context. Default 10.",
  '同时记住几个已发现的工具': "Remembered tools",
  '模型搜索出来的工具同时保留几个，超了先淘汰最久没用过的。默认 20。': "How many searched tools stay loaded at once; the least recently used are dropped first. Default 20.",
  '限制目录大小': "Limit catalog size",
  '目录上限需要一个正整数': "The catalog limit needs a positive whole number.",
  // —— 工具加载页（第三个能力面）——
  '工具加载': "Tool loading",

  '可设置': "Configurable",
  '常驻': "Resident",
  '按需': "On demand",
  '内置与插件工具': "Built-in & plugin tools",
  '每轮都在上下文里': "In context every turn",
  '搜索命中后加载': "Loaded after a search hit",
  '受保护': "Protected",
  '已改 {count} 项': "{count} changed",
  '已改 {count} 项 + 参数': "{count} changed + settings",
  '参数已修改': "Settings changed",
  '未保存，保存后下一次请求生效': "Unsaved; applies to the next request after saving",

  '目录默认全部列出，只有工具特别多时才需要设上限。': "The catalog lists all tools by default; cap it only when there are very many.",
  '参数已保存': "Settings saved",
  '最多字符数': "Maximum characters",
  '按名称或用途搜索': "Search by name or purpose",
  '按加载策略筛选': "Filter by loading policy",
  '没有匹配的工具。': "No matching tools.",
  '正在读取…': "Loading…",
  '读取失败': "Failed to read",
  '正在读取…': "Loading…",
  '读取失败': "Failed to read",
  '默认': "Default",
  '断开后自动重连': "Auto-reconnect after disconnect",
  '首次延迟 ms': "Initial delay ms",
  '最大延迟 ms': "Max delay ms",
  '最大尝试次数': "Max attempts",
  '读取 MCP 目录失败': "Failed to read MCP directory",
  '移除失败：{name}': "Remove failed: {name}",
  '已移除 {names}': "Removed {names}",
  '安装 MCP 失败': "Failed to install MCP",
  '已配置': "Configured",
  '需密钥': "Needs secret",
  '需连接信息': "Needs connection info",
  '免密钥': "No secret needed",
  '全局已装': "Installed globally",
  '需填参数': "Needs args",
  '安装后需编辑，替换 {names}': "Edit after install, replace {names}",
  '密钥：{names}': "Secrets: {names}",
  '连接：{names}': "Connections: {names}",
  '已写入{scope}': "Written to {scope}",
  '本项目配置': "This project's config",
  '需先填参数': "Parameters required first",
  '全局已装 · 可加一份项目副本': "Installed globally · you can add a project copy",
  '可直接安装': "Ready to install",
  '打开官方文档': "Open official docs",
  'MCP 发现市场': "MCP discovery marketplace",
  '安装到': "Install to",
  '安装到哪个作用域': "Which scope to install to",
  '内置 MCP 目录': "Built-in MCP catalog",
  '正在读取目录…': "Reading catalog…",
  '{total} 个服务 · 已配置 {installed} 个 · 装入{scope}': "{total} services · {installed} configured · installing to {scope}",
  '本项目 {name}': "This project {name}",
  '未配置优先': "Unconfigured first",
  '只要免密钥': "Keyless only",
  '显示 {visible} / {total}': "Showing {visible} / {total}",
  '读取目录失败': "Failed to read catalog",
  '移除失败': "Failed to remove",
  '安装失败': "Failed to install",
  '没有匹配的服务，换个关键词或分类试试': "No matching services — try another keyword or category",
  '目录是空的': "The catalog is empty",
  '收录 ≠ 背书。': "Listing ≠ endorsement.",
  '内置目录只保证「命令与协议形态已核对」，不审查服务端行为。装上之前请确认来源可信——尤其是需要密钥或连接信息的那些。': "The built-in catalog only guarantees that the command and protocol shape have been verified; it does not audit server behavior. Before installing, make sure the source is trustworthy — especially for those that need keys or connection details.",
  '读取本机客户端配置失败': "Failed to read local client config",
  '这条配置里没有可导入的 MCP': "No importable MCP in this config",
  '预览失败': "Preview failed",
  'JSON 解析失败': "JSON parse failed",
  '导入失败': "Import failed",
  '替换会删除{scope}': "Replacing will delete {scope}",
  '该项目': "this project",
  '当前 Web profile': "Current Web profile",
  '{warning}中未出现在 JSON 里的 MCP。确认继续？': "MCP in {warning} that do not appear in the JSON. Continue anyway?",
  '{warning}中未出现在这份来源里的 MCP。确认继续？': "MCP in {warning} that do not appear in this source. Continue anyway?",
  '无': "None",
  '更新：{names}': "Update: {names}",
  '移除：{names}': "Remove: {names}",
  '提示：{warning}': "Note: {warning}",
  '项目级': "Project-level",
  '没检测到这个项目的项目级 MCP 配置（.mcp.json / .codex/config.toml / .pi/mcp.json / opencode.json 等），可在下面手动粘贴': "No project-level MCP config detected for this project (.mcp.json / .codex/config.toml / .pi/mcp.json / opencode.json, etc.) — you can paste it manually below",
  '没检测到本机客户端的全局 MCP 配置（~/.claude.json / ~/.codex/config.toml / ~/.config/opencode/opencode.json 等），可在下面手动粘贴': "No global MCP config detected for local clients (~/.claude.json / ~/.codex/config.toml / ~/.config/opencode/opencode.json, etc.) — you can paste it manually below",
  '导入 MCP{scope}': "Import MCP {scope}",
  '（{name}）': " ({name})",
  '从本机客户端导入{layer}配置（只读，不修改它们的文件）': "Import {layer} config from local clients (read-only, their files are not modified)",
  '正在扫描本机客户端配置…': "Scanning local client configs…",
  '{count} 个 MCP：{names}': "{count} MCP: {names}",
  '没有可导入的 MCP': "No importable MCP",
  '含需掩码字段：{names}（导入后在详情页可用眼睛查看）': "Contains fields to mask: {names} (after importing, view them on the details page with the eye icon)",
  '环境变量未设置：{names}（导入后该处会得到空值）': "Environment variables not set: {names} (after importing, those will be empty)",
  '{count} 条提示，导入时逐条列出': "{count} notes, listed one by one during import",
  '或粘贴 JSON：支持 Claude/Cursor/Cline/Roo 的 mcpServers、VS Code 的 servers，以及单个 MCP 对象': "Or paste JSON: supports Claude/Cursor/Cline/Roo mcpServers, VS Code servers, and a single MCP object",
  '合并（同名更新）': "Merge (update by name)",
  '替换该项目': "Replace this project",
  '替换当前 Profile': "Replace current profile",
  '取消选择来源': "Clear selected source",
  '导入中…': "Importing…",
  '确认从来源导入': "Confirm import from source",
  '解析中…': "Parsing…",
  '预览': "Preview",
  '确认导入': "Confirm import",
  '解析并预览': "Parse and preview",
  '导出失败': "Export failed",
  '已开始下载 {filename}': "Download started: {filename}",
  '下载失败：{error}（可改用「复制 JSON」）': "Download failed: {error} (you can use \"Copy JSON\" instead)",
  '导出项目 MCP{scope}': "Export project MCP {scope}",
  '正在读取项目配置…': "Reading project config…",
  '共 {count} 个 MCP{suffix}': "{count} MCP total{suffix}",
  '，含 exclude（{names}）': ", including exclude ({names})",
  '这是完整配置：字面写死的凭据（URL 里的 token、字面 header / env 值）会原样出现在这里，请按密钥对待。用 ${VAR} 引用的位置保持引用写法，不会被解析成明文。': "This is the complete config: hardcoded credentials (tokens in URLs, literal header / env values) appear here verbatim, so treat them as secrets. Places that reference ${VAR} keep the reference form and are not resolved to plaintext.",
  '格式与 .dsh/mcp.json 一致：可以直接放进目标工作区的 .dsh/mcp.json，或用「导入 MCP」粘贴回来（粘贴只读取 mcpServers，exclude 需要手动设）。': "The format matches .dsh/mcp.json: you can drop it straight into the target workspace's .dsh/mcp.json, or paste it back via \"Import MCP\" (pasting only reads mcpServers; exclude must be set manually).",
  '无法预览目标工作区': "Cannot preview the target workspace",
  '源：{source}。复制在宿主内完成，配置与凭据不会经过浏览器。': "Source: {source}. Copying happens inside the Host; config and credentials never pass through the browser.",
  '目标工作区': "Target workspace",
  '选择目标工作区…': "Select target workspace…",
  '{name}（{count} 个 MCP）{suffix}': "{name} ({count} MCP){suffix}",
  ' · 配置无效': " · invalid config",
  '没有其他已注册的工作区：先在 DSH 里打开另一个项目，它会出现在顶部标签页里。': "No other registered workspaces: open another project in DSH first and it will appear in the top tabs.",
  '要复制的 MCP（{selected}/{total}）': "MCP to copy ({selected}/{total})",
  '全不选': "Deselect all",
  '全选': "Select all",
  '目标已有同名条目时按下方选择处理': "When the target already has an entry with the same name, apply the choice below",
  '跳过目标同名': "Skip same-name in target",
  '覆盖目标同名': "Overwrite same-name in target",
  '写入结果预览': "Write result preview",
  '正在读取目标工作区配置…': "Reading target workspace config…",
  '选择已变化，正在按当前选择重算…': "Selection changed, recalculating for the current selection…",
  '等预览算出当前选择的结果': "Wait for the preview to compute the current selection",
  '复制中…': "Copying…",
  '已刷新项目 MCP，共 {count} 个': "Project MCP refreshed, {count} total",
  '已刷新，共 {count} 个 MCP': "Refreshed, {count} MCP total",
  '{method} 成功': "{method} succeeded",
  '{method} 失败': "{method} failed",
  '已启用 ': "Enabled ",
  '已禁用 ': "Disabled ",
  '已重连 {name}': "Reconnected {name}",
  '已请求重连 {name}': "Reconnect requested for {name}",
  '确认移除 MCP「{name}」？将从{scope}中删除。': "Remove MCP \"{name}\"? It will be deleted from {scope}.",
  '当前 Web profile 配置': "Current Web profile config",
  '已屏蔽 {name}，对运行中的会话立即生效': "Blocked {name}, effective immediately for running sessions",
  '已取消屏蔽 {name}，对运行中的会话立即生效': "Unblocked {name}, effective immediately for running sessions",
  '该 MCP 来自其他配置层，配置只读，无法查看具体值': "This MCP comes from another config layer; its config is read-only, so specific values can't be viewed",
  '读取配置失败': "Failed to read config",
  '已保存 {name}': "Saved {name}",
  '已添加 {name}': "Added {name}",
  '保存失败': "Save failed",
  '添加失败': "Add failed",
  '已导入 MCP': "MCP imported",
  '已安装所选 MCP': "Selected MCP installed",
  '已复制': "Copied",
  '调用失败': "Invocation failed",
  '（配置无效：{error}）': "(Invalid config: {error})",
  '技能服务未连接': "Skill service not connected",
  '{count} 个项目 MCP 未能挂载到会话': "{count} project MCPs could not be mounted to the session",
  '。首个原因：{reason}　点开对应条目查看每一条的具体错误。': ". First reason: {reason} Click the corresponding entry to see the specific error for each one.",
  '　本项目当前有 {count} 个会话在运行。': " This project currently has {count} running sessions.",
  '{count} 个项目 MCP 的工具无法隔离（会出现在所有项目的会话里）': "Tools of {count} project MCPs can't be isolated (they will appear in sessions of all projects)",
  '屏蔽未能写入会话作用域': "Blocking could not be written to session scope",
  '正在升级到 v{version}…': "Upgrading to v{version}…",
  '已升级到 v{version}，重启宿主后生效': "Upgraded to v{version}; takes effect after the Host restarts",
  '升级失败：{text}': "Upgrade failed: {text}",
  '本地链接安装，无法一键升级{suffix}': "Local link install, one-click upgrade unavailable{suffix}",
  '（当前 v{version}）': "(current v{version})",
  '新版本 v{version} 可用': "New version v{version} available",
  '宿主代码在进程内执行，不重启等于没升级。': "Host code runs in-process, so not restarting is the same as not upgrading.",
  '升级由官方 pluginManager 执行，装完需要重启宿主。': "The upgrade is performed by the official pluginManager; the Host must be restarted afterwards.",
  '升级由官方 pluginManager 执行，装完需要重启宿主': "The upgrade is performed by the official pluginManager; the Host must be restarted afterwards",
  '升级': "Upgrade",
  '看这次改了什么': "See what changed",
  '查看更新方式': "View update method",
  '本版本内不再提示': "Don't show again in this version",
  '写入当前 Web profile 的 MCP 配置，所有项目共享': "Write MCP config to the current Web profile, shared by all projects",
  '{path}（.dsh/mcp.json，只对该项目的会话生效）': "{path} (.dsh/mcp.json, effective only for this project's sessions)",
  '还没有项目 MCP。点上方「添加项目 MCP」，或去「发现市场」安装。': "No project MCP yet. Use \"Add project MCP\" above, or install one from \"Discover marketplace\".",
  '共享的全局 MCP': "Shared global MCP",
  '项目 MCP': "Project MCP",
  '此项目还没有 MCP': "This project has no MCP yet",
  'MCP 来源': "MCP source",
  '全局共享': "Shared global",
  '搜索参数需要正整数': "Search settings must be positive whole numbers",
  '已显示 {shown} / 共 {total} 条': "Showing {shown} of {total}",
  '正在连接 skills 服务…': "Connecting to the skills service…",
  '{visible}/{total} 可见': "{visible}/{total} visible",
  '新版本与当前 DSH 不兼容，未升级。': "The new version is incompatible with the current DSH; not upgraded.",
  '该包没有声明组合包，不能作为插件安装。': "This package does not declare a bundle package, so it cannot be installed as a plugin.",
  '版本号不合法，未升级。': "Invalid version number; not upgraded.",
  '无法确定要升级哪个包，未升级。': "Cannot determine which package to upgrade; not upgraded.",
  '在 profile 里找不到这个插件，未升级。': "This plugin was not found in the profile; not upgraded.",
  '宿主正在停止，未升级；请重启后再试。': "The Host is stopping; not upgraded. Please restart and try again.",
  '该包正在被使用，未升级。': "This package is in use; not upgraded.",
  '构建授权已过期，未升级；请重试。': "Build authorization has expired; not upgraded. Please try again.",
  '当前 profile 由应用托管，不允许在这里改动。': "The current profile is managed by the application and cannot be modified here.",
  '这一项无法被单独改动（随 DSH 提供）。': "This item cannot be modified individually (it ships with DSH).",
  '错误码 {code}': "Error code {code}",
  'pnpm 退出码 {code}': "pnpm exit code {code}",
  '升级失败（{bits}）：': "Upgrade failed ({bits}):",
  '，': ", ",
  '升级失败：': "Upgrade failed:",
  '升级失败（{bits}）。': "Upgrade failed ({bits}).",
  '升级失败。': "Upgrade failed.",
  '本次更新内容': "What's in this update",
  'v{version} 的更新': "What's new in v{version}",
  '这些变化你可能想知道': "These changes may be of interest",
  '知道了': "Got it",
  '已让位给另一个 MCP 管理插件': "Yielded to another MCP management plugin",
  '检测到 {name} 已挂载，本面板不再注册入口，以免两个面板互相遮挡、同时改写同一份配置。': "Detected that {name} is already mounted, so this panel no longer registers an entry, to avoid the two panels covering each other and both rewriting the same config.",
  '另一个 MCP 管理插件': "Another MCP management plugin",
  '卸载其中一个后重启 DSH 即可恢复。': "Uninstall one of them and restart DSH to restore.",
  '旧机制停用': "Legacy mechanism disabled",
  '已停用': "Disabled",
  '模型不会自动调用它': "The model will not invoke it automatically",
  '模型不用': "Not model-invocable",
  '你不能用 /名字 手动调用它': "You cannot invoke it manually with /name",
  '不可手调': "Not user-invocable",
  '模型只会收到「{scope}」那一份': "The model will only receive the \"{scope}\" copy",
  '被遮蔽': "Shadowed",
  '另有 {names}': "Plus {names}",
  '同名 {count} 份': "{count} with the same name",
  '：已停用': ": disabled",
  '内置技能只读': "Built-in skills are read-only",
  '面板没能定位这条技能的目录（技能目录可能是符号链接），因此读不到它的调用权限——文件本身可能是好的': "The panel could not locate this skill's directory (the skill directory may be a symlink), so its invocation permissions could not be read — the file itself may be fine",
  'SKILL.md 的 frontmatter 读不出来（宿主会跳过这条技能），无法判断它的调用权限': "The SKILL.md frontmatter cannot be read (the Host will skip this skill), so its invocation permissions cannot be determined",
  '（加载中…）': "(Loading…)",
  '读取失败': "Read failed",
  '宿主未返回原因': "Host returned no reason",
  '（无正文）': "(No body)",
  '内置只读': "Built-in, read-only",
  '已启用': "Enabled",
  '模型可调用': "Model-invocable",
  '模型不可调用': "Not model-invocable",
  '调用权限未知': "Invocation permission unknown",
  '用户不可调用': "Not user-invocable",
  '这是旧版启停机制（改名成 .disabled）留下的条目；恢复后请用新的停用方式': "This entry was left behind by the old enable/disable mechanism (renaming to .disabled); after restoring it, use the new way to disable it",
  '旧机制残留': "Legacy mechanism leftover",
  '删除技能': "Delete skill",
  '技能属性': "Skill properties",
  '（未报告）': "(Not reported)",
  '旧机制停用（SKILL.md.disabled）——点「启用」把它改回来': "Disabled by the old mechanism (SKILL.md.disabled) — click \"Enable\" to change it back",
  '已停用（disable-model-invocation: true + user-invocable: false）': "Disabled (disable-model-invocation: true + user-invocable: false)",
  '未知（读不到这个文件）': "Unknown (cannot read this file)",
  '模型自动调用': "Model auto-invocation",
  '{name}：允许模型自动调用': "{name}: allow model auto-invocation",
  '写入 SKILL.md 的 disable-model-invocation。宿主用文件监听盯技能根，改动约 0.25 秒就生效（实测中位数 246ms），不必重启': "Writes disable-model-invocation in SKILL.md. The Host watches the skill root with a file watcher, so changes take effect in about 0.25 seconds (measured median 246ms) — no restart needed",
  '允许': "Allow",
  '禁止': "Forbid",
  '未知': "Unknown",
  '用户可调用': "User-invocable",
  '{name}：允许用户手动调用': "{name}: allow manual user invocation",
  '写入 SKILL.md 的 user-invocable：关掉后你就不能用 /名字 手动调用它（模型仍可自动调用）。与上面那个一起关掉就是「已停用」': "Writes user-invocable in SKILL.md: turning it off means you can no longer invoke it manually with /name (the model can still auto-invoke it). Turning it off together with the one above makes it \"Disabled\"",
  '同名遮蔽': "Same-name shadowing",
  '实际生效': "Actually in effect",
  '来自 {scope}，模型只会收到那一份；本行是另一个作用域里的副本。': "Comes from {scope}; the model only receives that one. This row is the copy in another scope.",
  '未检测到跨作用域同名遮蔽，本份已进入模型目录。': "No cross-scope same-name shadowing detected; this copy is in the model catalog.",
  '安装 {name}': "Install {name}",
  '上游未提供许可信息': "Upstream provided no license information",
  '上游页面': "Upstream page",
  '外部源（skillhub.cn）': "External source (skillhub.cn)",
  '本插件未核验': "Not verified by this plugin",
  '只做来源披露，不做许可判定、不做安全审查': "Source disclosure only; no license determination and no security review",
  '发布方': "Publisher",
  '已认证{suffix}': "Verified{suffix}",
  '：{name}': ": {name}",
  '未提供认证信息': "No verification information provided",
  '安全扫描': "Security scan",
  '上游未提供扫描结论': "Upstream provided no scan conclusion",
  '运行前提': "Requirements",
  '需要 API Key': "API Key required",
  '不需要 API Key': "No API Key required",
  '它会带来什么': "What it brings",
  '进入模型上下文': "Enters the model context",
  '技能正文会作为指令注入会话': "The skill body is injected into the session as instructions",
  '可执行片段': "Executable content",
  '上游未提供清单，本插件未核验：正文可能引用 scripts/ 等可执行文件': "Upstream provided no manifest and this plugin did not verify it: the body may reference executables such as scripts/",
  '含 scripts/ 目录': "Contains a scripts/ directory",
  '无 scripts/ 目录': "No scripts/ directory",
  '工具权限': "Tool permissions",
  '上游未提供，本插件未核验': "Not provided by upstream, not verified by this plugin",
  '未声明': "Undeclared",
  '　安装时创建': " Created at install time",
  '没有可写入的技能目录': "No writable skill directory",
  '宿主报告的作用域都是只读的（例如只有内置技能）。装不了任何位置——先确认 DSH 的用户级技能目录存在且可写。': "Every scope reported by the Host is read-only (for example, only built-in skills). Nothing can be installed anywhere — first make sure the DSH user-level skill directory exists and is writable.",
  '我知道这是外部来源、本插件未做核验，愿意自行承担安装后的风险。': "I understand this is an external source that this plugin has not verified, and I accept the risk of installing it.",
  '先勾选上面的确认': "Check the confirmation above first",
  '确认并安装': "Confirm and install",
  '未知发布者': "Unknown publisher",
  '下载 {count}': "Download {count}",
  '（上游未提供说明）': "(No description provided by upstream)",
  '已认证': "Verified",
  '需 API Key': "API Key required",
  '本地已有同名技能': "A skill with the same name already exists locally",
  '来自 skillhub.cn': "From skillhub.cn",
  '在 skillhub.cn 上查看': "View on skillhub.cn",
  '搜索失败': "Search failed",
  '确认删除技能「{name}」？{target}会从磁盘移除，不可撤销。': "Delete skill \"{name}\"? {target} will be removed from disk and cannot be undone.",
  '整个目录（含 scripts/references）': "The entire directory (including scripts/references)",
  '该文件': "That file",
  '技能面板': "Skills panel",
  '技能发现市场': "Skill discovery marketplace",
  'skillhub.cn（外部源）': "skillhub.cn (external source)",
  '正在搜索…': "Searching…",
  '已显示 {shown} / 共 {total} 条 · 装入{scope}': "Showing {shown} of {total} · Install into {scope}",
  '当前宿主进程还没有外部源接口': "The current Host process does not yet have the external source interface",
  '面板已更新，但这个正在运行的宿主进程是在更新之前启动的，所以它不认识 skillHubSearch。重启宿主（dsh 进程）后即可使用。': "The panel has been updated, but this running Host process was started before the update, so it does not recognize skillHubSearch. Restart the Host (the dsh process) to use it.",
  '连接 skillhub.cn 失败': "Failed to connect to skillhub.cn",
  '没有匹配的外部技能。': "No matching external skills.",
  '加载更多失败': "Failed to load more",
  '加载更多': "Load more",
  '外部源，本插件未核验。': "External source, not verified by this plugin.",
  'skillhub.cn 上的技能由任何人发布，条目里没有许可信息；安装前会把上游给的发布方认证与安全扫描结论摆出来，但那不等于本插件的审查结论。收录 ≠ 背书。': "Skills on skillhub.cn are published by anyone, and listings carry no license information; before installation, the publisher verification and security scan conclusions provided by upstream are shown, but those are not this plugin's own review conclusions. Listed ≠ endorsed.",
  'MCP 市场服务未连接（面板仍可用）': "MCP marketplace service not connected (the panel still works)",
  '技能服务未连接（需要宿主挂载 dsh-skill）': "Skill service not connected (requires the Host to mount dsh-skill)",
}

/** EN_DICT 里有没有这条键（中文原文 → 英文译文的查表存在性判断）。 */
const dictHas = (key) => Object.prototype.hasOwnProperty.call(EN_DICT, key);

/**
 * 中文「词典」：恒等映射（键就是中文原文本身）。
 *
 * 为什么必须注册它：宿主按 **active → fallback 链** 查命名空间，而英文是每条链的
 * 终点（`LocaleRuntime.fallbackChain` 末尾强制追加 `FALLBACK_LOCALE='en'`，
 * 见 deepseek-harness 的 packages/client/locale）。只注册 en 那一份时，中文模式下
 * 链是 ['zh','en']：zh 未命中 → **落到 en 命中** → 整片面板变英文（真机事故：
 * DSH 设中文，面板除了走数据的分类标签全是英文）。平台的 register 契约也要求
 * 双语平衡（"every shipped locale is required"）——单语言注册双语命名空间是违规用法。
 * 中文这份恒等，正是「我们的中文就是原文本身」的诚实表达。
 */
const ZH_DICT = Object.fromEntries(Object.keys(EN_DICT).map((key) => [key, key]));

/**
 * 把一个中文字面量渲染成**当前语言**的文案。
 *
 * 唯一判据是 locale 服务报的 active 语言：
 *   · active === 'en' 且 EN_DICT 有这条 → 英文；
 *   · 其他一律返回中文原文。
 *
 * ⚠️ 这里**刻意不做**「EN_DICT 无条件兜底」。曾经写成「locale 服务不在时也出英文」，
 * 结果是测试里（以真 bundle 渲染但不装 locale 服务）全部文案变英文、28 个断言中文的
 * 用例集体失败——而那 28 个断言是对的：**没有 locale 服务 = 没有语言切换能力 = 原文**。
 * 英文不是默认值，它是被显式选中的语言；把英文当兜底等于替用户改了他的语言设置。
 *
 * @param {string} zh - 源码里的中文字面量（带 {占位符} 时用 vars 填充）。
 * @param {object} [vars] - 占位符取值；未提供的占位符原样留在文案里（便于发现漏填）。
 * @returns {string}
 */
let localeT = null;
/** 当前 active 语言是否为英文。由 apply 接线时更新（见文件末尾）。
 *  BCP 47 用连字符、部分宿主/老配置用下划线（en_US），两种分隔符都切。 */
let localeActive = null;
const localeIsEnglish = () => typeof localeActive === 'string' && localeActive.toLowerCase().split(/[-_]/)[0] === 'en';
/**
 * 送给**宿主**的语言标记（市场条目的文案用）。英文界面给 'en'，其余一律给 undefined。
 *
 * 为什么给 undefined 而不是 'zh'：宿主那边 `pickLocalized` 的默认分支就是中文优先，
 * 不传字段 = 走默认 = 与改前逐字节一致。少传一个字段，老宿主、老面板、新面板三者
 * 的任何组合都不会改变中文用户看到的东西。
 */
const contentLocale = () => (localeIsEnglish() ? 'en' : undefined);

/**
 * 从目录条目里取一条**随语言变**的文案（label / summary / access / vendor）。
 *
 * 目录是随插件发下来的静态数据，每条只有中文原文 + 可选的 `*En` 字段
 * （由 scripts/build-catalog.mjs 从英文副本生成）。所以这里不是 t() 那种「查词典」，
 * 而是「同一份数据里挑一种写法」。
 *
 * ⚠️ 中文（默认）返回**原字段**，与改前逐字节一致——英文副本缺席时也是这条路。
 * 英文侧缺字段就回落中文，绝不返回空串（宁可显示中文，也不要一张空卡片）。
 *
 * @param {object} item - MCP_CATALOG 的一项。
 * @param {string} field - 字段基名（label / summary / access / vendor）。
 * @returns {string}
 */
function pickCatalogText(item, field) {
  const zh = item?.[field]
  if (!localeIsEnglish()) return zh ?? '';
  const en = item?.[`${field}En`]
  return (typeof en === 'string' && en.trim() !== '') ? en : (zh ?? '');
}

function t(zh, vars) {
  let out = zh;
  // 宿主词典优先：它登记了这条就用它（语言包可以覆盖本 bundle 自带的译法）。
  if (localeT) {
    const hit = localeT(zh);
    // 语言包没登记这条键时 bind() 返回键本身——那不代表「翻译成中文」，
    // 而是「这条没翻」，此时才轮到自带表。
    if (typeof hit === 'string' && hit !== zh) out = hit;
  }
  // 自带表只在 active 明确是英文时生效。**不能**当成无条件兜底：
  // 没有 locale 服务 = 没有语言切换能力 = 原文（中文），英文必须是被显式选中的语言。
  if (out === zh && localeIsEnglish() && dictHas(zh)) out = EN_DICT[zh];
  if (vars === undefined) return out;
  return out.replace(/\{(\w+)\}/g, (whole, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole);
}

/**
 * 取一条**本地化内容值**的当前语言文本。DSH 的 LocalizedText 形状：
 * `string | { en, ...locale }`（见宿主 `@deepseek-ai/dsh-package-manifest`，
 * 它配 resolveText 的回落链解析包文案）。这里中文是基准：显式英文才出英文，
 * 英文缺席回落中文——与 t() 同一把尺（没有语言服务 = 原文）。
 *
 * 使用者是**数据**（whats-new 的条目），不是界面文案：那些走 t() + EN_DICT。
 * @param {string|{zh?:string,en?:string}|undefined} value - 本地化内容值。
 * @returns {string}
 */
function localized(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  return localeIsEnglish() ? (value.en ?? value.zh ?? '') : (value.zh ?? value.en ?? '');
}

