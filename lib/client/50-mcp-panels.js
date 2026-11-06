// ── 列表底栏：统计与排序（纯函数）──────────────────────────────────────
//
// 为什么不写在组件里：这些推导（「几个启用」「几个失败」「排序后第一条是谁」）正是最容易
// 算错的部分，而组件内部的闭包在 node 里跑不起来，只能靠钉源码文本——那种测试证明不了
// 数字对不对。抽到模块作用域后可以直接以普通函数调用。
//
// 数字只统计**当前已取到的那一批行**（当前作用域），不跨作用域求和：外壳拿不到跨作用域的
// 全量（见 ABILITY_TABS 那边的注释），编一个总数比不显示更糟。

function countRows(rows, predicate) {
  let n = 0;
  for (const row of Array.isArray(rows) ? rows : []) if (predicate(row)) n += 1;
  return n;
}

/**
 * 一行的状态档位，只用于排序：有问题的排前面。
 *
 * 0 失败 / 1 连接中 / 2 正常 / 3 停用。与 Dot 的 phase 取值域一致（deriveMcpPhase），
 * 但**不是同一件事**：Dot 要的是一个颜色，排序要的是一个全序，所以这里把 unknowns 归到 3。
 */
function mcpStatusRank(row) {
  const s = row || {};
  if (s.mountFailed === true || s.scopeFailed === true) return 0;
  if (s.enabled === false) return 3;
  const status = s.status || s.phase || 'stopped';
  if (status === 'failed') return 0;
  if (status === 'loading' || status === 'waiting') return 1;
  if (status === 'connected') return 2;
  return 3;
}

const mcpStatsText = (rows) => {
  const list = Array.isArray(rows) ? rows : [];
  const on = countRows(list, (s) => s && s.enabled !== false);
  const bad = countRows(list, (s) => mcpStatusRank(s) === 0);
  return t('{total} 个服务 · {on} 启用{suffix}', { total: list.length, on, suffix: bad ? t(' · {count} 失败', { count: bad }) : '' });
};

const skillStatsText = (rows) => {
  const list = Array.isArray(rows) ? rows : [];
  const off = countRows(list, (r) => r && r.enabled === false);
  return t('{total} 个技能 · {on} 已启用{suffix}', { total: list.length, on: list.length - off, suffix: off ? t(' · {count} 已停用', { count: off }) : '' });
};

/**
 * 一键「全部延迟」的状态判定。
 *
 * `includeWorkspace` 决定**这次一键的范围**：全局作用域只数当前 profile 能改的全局行
 * （项目行的 defer 写在 <项目>/.dsh/mcp.json，不该被扫进来）；项目作用域打开它，
 * 于是一次翻转的就是这个项目自己的所有 MCP。两个作用域各一次写入、各写各的文件。
 */
const deferAllState = (rows, { includeWorkspace = false } = {}) => {
  const list = (Array.isArray(rows) ? rows : []).filter((s) => s && s.managed === true && (includeWorkspace || s.scope !== 'workspace'));
  const deferred = countRows(list, (s) => s.defer === true);
  return { total: list.length, deferred, all: list.length > 0 && deferred === list.length };
};

/**
 * 排序键。两个能力面共用同一套键名与同一份文案，切换能力层时排序按钮不用重新学。
 *
 * ⚠️ **没有「按作用域」**：两个面的列表本身已经按作用域切开了——MCP 面是作用域药丸
 * （每个列表里只可能有一种 scope），技能面是分组（组顺序由 skillGroups 的档位固定，
 * 与输入顺序无关）。所以按作用域排序**永远不可能改变任何可见的东西**。
 * 一个点了永远没反应的菜单项比没有这一项更糟：用户会以为排序坏了。
 */
const SORT_KEYS = ['default', 'name', 'status'];
// 同 SCOPE_LABELS：存中文原文，渲染时翻（模块级 t() 会把语言锁死在加载那一刻）。
const SORT_LABELS = { default: '默认顺序', name: '按名称', status: '按状态' };

/**
 * 稳定排序：同键的行保持**宿主返回的原始顺序**。
 *
 * 直接 `Array.prototype.sort` 在 V8 上现在也是稳定的，但这里显式带上下标，是因为比较
 * 函数里会出现大量 0（同一状态、同一作用域），依赖引擎实现等于把「列表顺序会不会突然
 * 变」交给运行时版本决定——而顺序突变在面板里看起来像「数据被改了」。
 */
function stableSort(rows, compare) {
  return (Array.isArray(rows) ? rows : [])
    .map((row, index) => ({ row, index }))
    .sort((a, b) => compare(a.row, b.row) || a.index - b.index)
    .map((item) => item.row);
}

const byName = (pick) => (a, b) => String(pick(a) || '').localeCompare(String(pick(b) || ''), 'zh-Hans-CN');

/** MCP 列表排序。键只有默认/名称/状态——作用域维度的理由见 SORT_KEYS 的注释。 */
function sortServers(rows, key) {
  if (key === 'name') return stableSort(rows, byName((s) => s.serverName));
  if (key === 'status') return stableSort(rows, (a, b) => mcpStatusRank(a) - mcpStatusRank(b));
  return Array.isArray(rows) ? rows : [];
}

/** 技能列表排序。已停用排在**前面**：那是需要你处理的那一批。 */
function sortSkills(rows, key) {
  if (key === 'name') return stableSort(rows, byName((r) => r.name));
  if (key === 'status') return stableSort(rows, (a, b) => Number(a.enabled === false ? 0 : 1) - Number(b.enabled === false ? 0 : 1));
  return Array.isArray(rows) ? rows : [];
}

const ServerList = ({ servers, total, selected, query, onQuery, onSelect, onToggle, onToggleDefer, busy, transportFilter, statusFilter, onTransportFilter, onStatusFilter, embedded, workspace, emptyHint, footer, toolbarAction }) => {
  const count = total === undefined ? servers.length : total;
  // 门分两道。控件本身（搜索 + 两个过滤 select）在条目少时藏起来，把高度让给列表——
  // 但**一键动作不跟着藏**：项目作用域是 embedded，而它恰恰是延迟开关的第二个写入口
  // （.dsh/mcp.json）。曾经整行共用一个门，项目 MCP ≤6 时「全部延迟」直接不渲染，
  // "唯一入口"在项目小列表下不存在。
  const showControls = !embedded || count > CONTROLS_THRESHOLD;
  const showToolbar = showControls || Boolean(toolbarAction);
  // mountFailed / scopeFailed / wsSub 现在在模块作用域（纯函数，可被测试直接调用）。
  // 项目 MCP 的 status 与全局同一个取值域（deriveMcpPhase）：connected / failed / loading /
  // stopped / disabled / unknown。状态点因此直接复用，不再需要为项目行特例。
  const dotPhase = (s) => (mountFailed(s) || scopeFailed(s) ? 'failed' : s.status || s.phase);
  const toggleLocked = (s) => busy || !s.managed || (s.scope !== 'workspace' && !s.enabled && s.phase !== 'stopped');
  return h('div', { className: 'dsh-mcp-side' + (embedded ? ' embedded' : '') },
    showControls ? h('div', { className: 'dsh-mcp-search' }, h(Icon, { d: ICONS.search }), h('input', { placeholder: t('搜索 MCP…'), value: query, onChange: (e) => onQuery(e.target.value) })) : null,
    showToolbar ? h('div', { className: 'dsh-mcp-filters' + (showControls ? '' : ' bare') },
      showControls ? h('select', { value: transportFilter, onChange: (e) => onTransportFilter(e.target.value), 'aria-label': t('按传输过滤') },
        h('option', { value: 'all' }, t('全部传输')),
        h('option', { value: 'http' }, 'HTTP'),
        h('option', { value: 'stdio' }, 'stdio'),
      ) : null,
      showControls ? h('select', { value: statusFilter, onChange: (e) => onStatusFilter(e.target.value), 'aria-label': t('按状态过滤') },
        h('option', { value: 'all' }, t('全部状态')),
        workspace ? null : h('option', { value: 'connected' }, t('已连接')),
        workspace ? null : h('option', { value: 'failed' }, t('失败')),
        h('option', { value: 'disabled' }, t('已禁用')),
      ) : null,
      // 全局动作（「全部延迟」）放在过滤器行右侧：这一行原本只有两个 select、右边大片空白，
      // 而它**必须**在列表第一屏可见——曾经它在列表底栏（footer），服务器一多就滚出视野，
      // 用户原话是「我都没注意到，差点以为没有这个功能」。
      // 主按钮 + 闪电图标，与底栏那个纯文字按钮的视觉重量差一个量级。
      toolbarAction ? h('button', {
        type: 'button',
        className: 'dsh-mcp-defer-all',
        disabled: toolbarAction.disabled === true,
        title: toolbarAction.title,
        onClick: toolbarAction.onClick,
      }, h(Icon, { d: ICONS.zap }), toolbarAction.label) : null,
    ) : null,
    h('div', { className: 'dsh-mcp-list' },
      servers.length === 0
        ? h('div', { className: 'dsh-mcp-empty-list' }, count === 0 && emptyHint ? emptyHint : t('没有匹配的 MCP'))
        : servers.map((s) =>
            h('div', { key: s.serverName, role: 'button', tabIndex: 0, 'aria-selected': selected === s.serverName, className: 'dsh-mcp-item' + (selected === s.serverName ? ' sel' : ''), onClick: () => onSelect(s.serverName), onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(s.serverName); } } },
              h('div', { className: 'dsh-mcp-item-main' },
                h('div', { className: 'dsh-mcp-item-name-row' },
                  h(Dot, { phase: dotPhase(s) }),
                  h('div', { className: 'dsh-mcp-item-name' }, s.serverName),
                ),
                h('div', { className: 'dsh-mcp-item-sub' },
                  h(Badge, { cls: s.transport === 'http' ? 't-http' : 't-stdio' }, s.transport === 'http' ? 'HTTP' : 'stdio'),
                  h('span', { className: 'dsh-mcp-item-meta' }, s.scope === 'workspace' ? wsSub(s) : t('{count} 工具', { count: s.toolCount })),
                  // 延迟开关：**两种状态都渲染**，点一下就地切换（不必进「编辑」框）。
                  // 不带 token 数：我们不知道用户装了什么 MCP，schema 大小差一个量级，任何
                  // 估算都给不出可用的数，而给了数用户就拿它做决定（主动误导）。
                  h(DeferChip, { on: (s.deferEffective ?? s.defer) === true, interactive: s.managed === true && !busy, onClick: () => onToggleDefer(s) }),
                  mountFailed(s) ? h(Badge, { cls: 's-err' }, t('挂载失败')) : null,
                  scopeFailed(s) ? h(Badge, { cls: 's-err' }, t('作用域故障')) : null,
                ),
              ),
              h(Toggle, { on: s.enabled, disabled: toggleLocked(s), label: s.serverName + (s.enabled ? t('：已启用') : t('：已禁用')), title: s.managed ? (s.enabled ? t('禁用') : t('启用')) : t('来自其他配置层，只读'), onChange: () => onToggle(s) }),
            ),
          ),
    ),
    // 底栏（统计 + 排序/刷新）由调用方给：同一张卡片在全局与项目两种布局下都要有底栏，
    // 但文案与可用动作不同（项目作用域没有连接态）。放在 .dsh-mcp-list 之后、卡片之内。
    footer || null,
  );
};

// 可见性按钮：与「启用」滑块刻意用不同控件——滑块表示启用状态，眼睛表示在本项目是否可见。
const EyeToggle = ({ hidden, disabled, onChange, label }) =>
  h('button', {
    type: 'button',
    className: 'dsh-mcp-eye' + (hidden ? ' off' : ''),
    disabled,
    'aria-pressed': !hidden,
    'aria-label': (hidden ? t('已屏蔽：') : t('可见：')) + label,
    title: hidden ? t('已在此项目屏蔽，点击恢复可见') : t('在此项目可见，点击屏蔽'),
    onClick: (e) => { e.stopPropagation(); onChange(!hidden); },
  }, h(Icon, { d: ICONS[hidden ? 'eyeOff' : 'eye'], size: 15 }));

// 延迟开关芯片：**状态即按钮**（两种状态都渲染、都可点）。
//
// 为什么改成这样：以前这里只是"开着的时候才出现的徽标"，想给某一台开延迟必须进「编辑」
// 弹框勾一下——而列表上看不出那个动作在哪（用户实测反馈："按钮确实藏得有点深"）。
//
// 为什么是**芯片**不是开关：右侧那颗 Toggle 是「启用/禁用」（关掉 = 该服务器不加载、工具
// 全没）。延迟只是"工具放不放常驻上下文"，两者外观一致会让人以为关掉延迟等于关掉服务器。
// 与眼睛（可见性）同一条教训：后果不同的控件必须长得不一样。
//
// 非本插件管理的条目（项目视图里出现的全局条目、外部 bundle 的条目）只展示不可点：
// 它们要改得去它自己的作用域，在这里改会变成"点了另一个文件"。
const DeferChip = ({ on, interactive, onClick }) => {
  const label = on ? t('延迟') : t('全量');
  const title = on
    ? t('该服务器的工具不常驻上下文：模型经 tool_search 按需搜索加载，命中后才进入工具列表。点击切回全量常驻。')
    : t('该服务器的工具每轮都常驻上下文。点击切到延迟加载：模型经 tool_search 按需搜索，命中后才进入工具列表。');
  // 闪电图标 = 延迟加载（与「全部延迟」主按钮同一个图标），两种状态都带：它标明"这是延迟开关"，
  // 而不是"现在延迟着"。状态由 `.sel`（accent 底 + accent 边框）+ 文案 + aria-pressed 表达。
  const icon = h(Icon, { d: ICONS.zap, size: 11 });
  if (!interactive) {
    return h('span', {
      className: 'dsh-mcp-chip sm ro' + (on ? ' sel' : ''),
      title: t('该服务器不属于本插件的配置，延迟开关要回到它自己的作用域里改'),
    }, icon, label);
  }
  return h('button', {
    type: 'button',
    className: 'dsh-mcp-chip sm' + (on ? ' sel' : ''),
    'aria-pressed': on,
    'aria-label': title,
    title,
    // 阻止冒泡：否则点芯片会顺带选中这一行（行本身是 role=button）。
    onClick: (e) => { e.stopPropagation(); onClick(); },
    onKeyDown: (e) => { e.stopPropagation(); },
  }, icon, label);
};

// 项目 tab 中的「全局 MCP（可屏蔽）」列表：配置只读，可点选查看详情，可切换本项目可见性。
// 搜索框置于滚动列表之外，避免随列表滚走。
const GlobalServerList = ({ servers, exclude, onToggleExclude, onSelect, selected, busy }) => {
  const [q, setQ] = useState('');
  const hidden = new Set(exclude || []);
  const query = (q || '').toLowerCase();
  const list = query ? servers.filter((s) => s.serverName.toLowerCase().includes(query)) : servers;
  return h(React2.Fragment, null,
    servers.length > CONTROLS_THRESHOLD ? h('div', { className: 'dsh-mcp-global-search' }, h(Icon, { d: ICONS.search }), h('input', { placeholder: t('搜索全局 MCP…'), value: q, onChange: (e) => setQ(e.target.value) })) : null,
    h('div', { className: 'dsh-mcp-global-list' },
      servers.length === 0
        ? h('div', { className: 'dsh-mcp-empty-list' }, t('没有全局 MCP'))
        : list.length === 0
          ? h('div', { className: 'dsh-mcp-empty-list' }, t('没有匹配的全局 MCP'))
          : list.map((s) => {
              const isHidden = hidden.has(s.serverName);
              return h('div', {
                key: s.serverName,
                role: 'button',
                tabIndex: 0,
                'aria-selected': selected === s.serverName,
                className: 'dsh-mcp-item' + (selected === s.serverName ? ' sel' : '') + (isHidden ? ' muted' : ''),
                onClick: () => onSelect(s.serverName),
                onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(s.serverName); } },
              },
                h('div', { className: 'dsh-mcp-item-main' },
                  h('div', { className: 'dsh-mcp-item-name-row' },
                    h(Dot, { phase: s.status || s.phase }),
                    h('div', { className: 'dsh-mcp-item-name' }, s.serverName),
                  ),
                  h('div', { className: 'dsh-mcp-item-sub' },
                    h(Badge, { cls: s.transport === 'http' ? 't-http' : 't-stdio' }, s.transport === 'http' ? 'HTTP' : 'stdio'),
                    h('span', { className: 'dsh-mcp-item-meta' }, t('{count} 工具', { count: s.toolCount })),
                    isHidden ? h(Badge, { cls: 's-off' }, t('已屏蔽')) : null,
                  ),
                ),
                // 眼睛 = 可见性，与项目 MCP 的启用滑块在语义与外观上都区分开。
                h(EyeToggle, { hidden: isHidden, disabled: busy, label: s.serverName, onChange: (next) => onToggleExclude(s.serverName, next) }),
              );
            }),
    ),
  );
};

/**
 * 详情页签的公共构造。MCP 面与技能面必须长得一样、行为一样，所以规则只写在这里。
 *
 * 刻意做成**普通函数而不是组件**：组件节点在假 React 树里不会被展开（测试收集到的
 * 只有 `{ type: DetailTab, props }`），于是「页签文案与计数正确」这类断言只能空转。
 * 直接返回元素则让两个能力面的页签在测试里都是可见的。
 */
const detailTab = (tab, onTab, id, label, count) => h('button', {
  key: id,
  type: 'button',
  role: 'tab',
  'aria-selected': tab === id,
  className: 'dsh-mcp-tab' + (tab === id ? ' sel' : ''),
  onClick: () => { if (onTab) onTab(id); },
}, label, count ? h('span', { className: 'dsh-mcp-tab-count' }, String(count)) : null);

/** 非当前页签的卡片不参与布局——只渲染当前页会让别处的文本断言失去意义，所以是隐藏而非卸载。 */
const detailPaneOff = (tab, id) => (tab === id ? '' : ' dsh-mcp-pane-off');

const ServerDetail = ({ server, tools, onToggle, onReconnect, onEdit, onRemove, busy, onReveal, revealed, onCopy, excluded, onToggleExclude, emptyTitle, emptyActions, tab = 'overview', onTab }) => {
  if (!server)
    return h('div', { className: 'dsh-mcp-detail' }, h('div', { className: 'dsh-mcp-d-empty' },
      h('b', null, emptyTitle || t('选择左侧的一个 MCP')),
      emptyTitle ? null : h('span', null, t('这里会显示它的连接配置、已注册的工具，以及连接失败时的诊断。')),
      emptyActions ? h('div', { className: 'dsh-mcp-d-actions' }, ...emptyActions) : null));
  const env = server.env || {};
  const headers = server.headers || {};
  const envKeys = Object.keys(env);
  const headerKeys = Object.keys(headers);
  const revealId = (field, key) => server.serverName + ':' + field + (key !== undefined ? ':' + key : '');
  const revealedValue = (field, key) => {
    const r = revealed[revealId(field, key)];
    if (!r || r.value === undefined) return undefined;
    return Array.isArray(r.value) ? r.value.join(' ') : String(r.value);
  };
  // 项目 MCP 由会话挂载，管理面板不持有其连接：状态保持中性，除非它确实挂载失败过
  // （workspaceServerView 不产生 lastError，此处的 lastError 只会来自挂载失败）。
  const isWorkspace = server.scope === 'workspace';
  // 项目行的两类失败是两回事，由 Host 分开标记，不再用“lastError 存在”去反推：
  //   mountFailed  = 我们自己 setup 阶段挂不上（serverName 冲突/启动失败）
  //   status=failed = 连接已建但 mcp-client 报错/重连耗尽（工具被注销）
  //   scopeFailed  = 工具注册到了全局层而不是共享作用域层（dsh-scope 两份模块实例）
  const mountFailed = isWorkspace && server.mountFailed === true;
  const scopeFailed = isWorkspace && server.scopeFailed === true;
  // 在项目 tab 里查看的全局 MCP：配置属于全局作用域，此处只读，仅能切换本项目可见性。
  const isForeign = server.foreign === 'global';
  const status = mountFailed ? 'failed' : server.status || server.phase || 'stopped';
  const statusCls = server.enabled ? (status === 'connected' ? 's-on' : status === 'failed' ? 's-err' : '') : 's-off';
  const statusText = !server.enabled
    ? t('已禁用')
    : mountFailed
      ? t('挂载失败')
      : scopeFailed
        ? t('作用域隔离失败')
        : isWorkspace
          // 项目行的 status 与全局同一个取值域（deriveMcpPhase），只是文案不同。
          // 这里只说**连接**那一半事实（"在不在"）；"几个会话在用"由详情页的连接信息与列表行的
          // 副文案给出——两者刻意不合并，见 wsSub 的注释。
          // stopped 在项目语境里意为「这条共享连接尚未建立」（新会话挂载时才建）。
        ? (status === 'connected' ? t('已连接') : status === 'failed' ? t('连接失败') : status === 'unknown' ? t('状态未知') : status === 'loading' ? t('连接中…') : t('尚未建立连接（新会话自动挂载）'))
        : status === 'connected' ? t('已连接') : status === 'failed' ? t('连接失败') : status === 'unknown' ? t('状态未知') : status === 'loading' || status === 'waiting' ? t('连接中…') : t('已停止');
  const mut = (v) => {
    const visible = displayValue(v);
    return typeof visible === 'string' && visible.length > 90 ? visible.slice(0, 88) + '…' : visible;
  };
  const RevealBtn = ({ field, keyName, label, fallback }) => {
    // 眼睛（以及点开后的复制）只属于**被掩码的值**。明文值（如无凭据的 URL）本来就摆在眼前，
    // 给它配一个只会让人以为还藏了东西，而点下去其实什么也不变。
    const masked = fallback === REDACTED_VALUE;
    const state = revealed[revealId(field, keyName)];
    const shown = revealedValue(field, keyName) !== undefined ? revealedValue(field, keyName) : mut(fallback);
    const revealedNow = state?.value !== undefined;
    return h('span', { className: 'dsh-mcp-secret' },
      h('span', { className: 'dsh-mcp-secret-value', title: shown }, shown),
      revealedNow ? h('button', { type: 'button', className: 'dsh-mcp-secret-btn', title: t('复制 {label}', { label }), 'aria-label': t('复制 {label}', { label }), onClick: () => onCopy(shown) }, h(Icon, { d: ICONS.copy })) : null,
      masked ? h('button', { type: 'button', className: 'dsh-mcp-secret-btn', disabled: state?.pending, title: revealedNow ? t('隐藏 {label}', { label }) : t('显示 {label}', { label }), 'aria-label': t('显示/隐藏 {label}', { label }), onClick: () => onReveal(server, field, keyName) }, state?.pending ? '…' : h(Icon, { d: ICONS[revealedNow ? 'eyeOff' : 'eye'] })) : null,
    );
  };
  const RevealRow = ({ field, keyName, label }) =>
    h('div', { className: 'dsh-mcp-secret-row' },
      h('b', null, keyName),
      h(RevealBtn, { field, keyName, label, fallback: String(env[keyName] ?? headers[keyName] ?? '') }),
    );
  // 详情页签：只把**已经取到的**卡片分组，不新增任何取数。MCP 规范继续扩字段时，
  // 新卡片进对应页签即可，右侧不会变成一条无限长的下拉。
  //
  // 硬错误（server.lastError）刻意不进页签：它是「为什么这行是红的」的直接答案，
  // 藏到一次点击后面等于把诊断成本转嫁给最需要它的人。
  const diagBlocks = [
    isForeign ? h('div', { className: 'dsh-mcp-log warn' }, t('此 MCP 由全局配置提供。要改它的连接配置，请切到「全局」标签页；在这里只能决定它对本项目是否可见。')) : null,
    // 同名在 DSH 0.1.5 起是合法配置（官方按注册作用域隔离），所以只有这份连接真的失败时才
    // 把它摆成原因；成功时不刷屏，更不把一条好连接说成冲突。
    isWorkspace && server.duplicateOwners?.length && status === 'failed' ? h('div', { className: 'dsh-mcp-log warn' }, t('以下项目也定义了同名 serverName：{names}。DSH 0.1.5 起各注册作用域可独立使用同名；更早的版本按全进程唯一判定，同名会导致其中一份启动失败。', { names: server.duplicateOwners.join(t('、')) })) : null,
    // 全局层的同名条目：**说清是谁**，否则这一行看起来只是"坏了"，而用户没有任何线索。
    // 关键事实有两个——(1) 本行仍然可编辑（身份按 id，不按名字）；(2) 另一条不归本 profile，
    // 要改它得去它自己的配置层，删掉本行之后它通常要重启宿主才会重新尝试连接。
    server.duplicates?.length
      ? h('div', { className: 'dsh-mcp-log warn' },
        t('同一 serverName 在 loader 里还有 {count} 条条目，由其他配置层提供（{items}）。mcp-client 在连接期按作用域判重，同名条目里只有一条能连上；本面板只能编辑/移除属于当前 profile 的那条。', {
          count: server.duplicates.length,
          items: server.duplicates.map((other) => other.id + (other.disabled ? t('（已禁用）') : '')).join(t('、')),
        }))
      : null,
    server.toolCountAmbiguous ? h('div', { className: 'dsh-mcp-log warn' }, t('工具命名与其他 serverName 前缀重叠，无法可靠判断归属；请避免在 serverName 中使用双下划线。')) : null,
  ].filter(Boolean);
  const paneOff = (id) => detailPaneOff(tab, id);
  const tabBtn = (id, label, count) => detailTab(tab, onTab, id, label, count);
  return h('div', { className: 'dsh-mcp-detail' },
    h('div', { className: 'dsh-mcp-d-head' },
      h('div', { className: 'dsh-mcp-d-title' },
        h('div', { className: 'dsh-mcp-d-name' }, server.serverName),
        h('div', { className: 'dsh-mcp-d-meta' },
          h(Dot, { phase: status }),
          h(Badge, { cls: statusCls + ' dot' }, statusText),
          h(Badge, { cls: server.transport === 'http' ? 't-http' : 't-stdio' }, server.transport === 'http' ? 'HTTP' : 'stdio'),
          h(Badge, { cls: isWorkspace ? 'scope-ws' : '' }, isWorkspace ? t('项目配置') : t('全局配置')),
          isWorkspace ? null : h(Badge, null, t('{count} 个工具', { count: server.toolCount })),
          isWorkspace && server.refs > 0 ? h(Badge, null, t('{count} 个会话共用', { count: server.refs })) : null,
          isWorkspace && server.duplicateOwners?.length && status === 'failed' ? h(Badge, { cls: 's-err' }, t('serverName 同名冲突')) : null,
        ),
      ),
      // 操作栏槽位：[主行为] + [次要行为] + [⋯ 更多]。
      // 主行为 = 启停（最高频、也是唯一会改状态的动作）；「重连」与「移除」收进 ⋯，
      // 于是以后再加动作有确定去处，头部不会因此换行（真机窄屏下 6 个按钮要两行起步）。
      actionBar({
        primary: isForeign
          ? h(React2.Fragment, null,
              h('span', { className: 'dsh-mcp-d-scope-hint' }, excluded ? t('已在此项目屏蔽') : t('在此项目可见')),
              h(EyeToggle, { hidden: excluded, disabled: busy, label: server.serverName, onChange: (next) => onToggleExclude(server.serverName, next) }),
            )
          : h(Btn, {
            cls: 'primary',
            icon: server.enabled ? 'pause' : 'play',
            onClick: () => onToggle(server),
            disabled: busy || !server.managed,
            title: server.managed ? (server.enabled ? t('禁用') : t('启用')) : t('来自其他配置层，只读'),
            children: server.enabled ? t('停用') : t('启用'),
          }),
        secondary: isForeign ? null : h(Btn, { icon: 'edit', onClick: () => onEdit(server), disabled: busy || !server.managed, children: t('编辑') }),
        more: isForeign ? [] : [
          {
            key: 'reconnect',
            icon: 'refresh',
            label: t('重连'),
            title: isWorkspace ? t('重连本项目共享连接（拆掉旧连接并按当前配置重建，不影响其他会话）') : t('重连'),
            disabled: busy || !server.enabled || !server.managed,
            onSelect: () => onReconnect(server),
          },
          { key: 'sep', separator: true },
          { key: 'remove', icon: 'trash', label: t('移除'), danger: true, disabled: busy || !server.managed, onSelect: () => onRemove(server) },
        ],
      }),
    ),
    server.lastError ? h('div', { className: 'dsh-mcp-log', title: t('来自 mcp-client 最近日志') }, server.lastError) : null,
    h('div', { className: 'dsh-mcp-tabs', role: 'tablist', 'aria-label': t('详情分区') },
      tabBtn('overview', t('概览')),
      tabBtn('tools', t('工具'), tools.length),
      tabBtn('diag', t('诊断'), diagBlocks.length),
    ),
    h('div', { className: 'dsh-mcp-d-body' },
    h('div', { className: 'dsh-mcp-card' + paneOff('overview') },
      h('h4', null, t('连接信息')),
      h('div', { className: 'dsh-mcp-kv' },
        h('b', null, t('传输')), h('span', null, server.transport === 'http' ? 'Streamable HTTP' : 'stdio'),
        server.url ? h('b', null, 'URL') : null, server.url ? h(RevealBtn, { field: 'url', label: 'URL', fallback: server.url }) : null,
        server.command ? h('b', null, t('命令')) : null, server.command ? h('span', null, mut(server.command)) : null,
        server.args && server.args.length ? h('b', null, t('参数')) : null, server.args && server.args.length ? h(RevealBtn, { field: 'args', label: t('参数'), fallback: server.args.map(mut).join(' ') }) : null,
        server.cwd ? h('b', null, t('工作目录')) : null, server.cwd ? h('span', null, mut(server.cwd)) : null,
        h('b', null, t('启用')), h('span', null, server.enabled ? t('是') : t('否（补丁中 disabled: true）')),
        // 「可不可编辑」只看 managed（= 本 profile 有没有这一条），同名与否只是附加事实。
        // 原来 conflict 优先并写成「冲突，只读」，等于把"别人也有一条"读成"你的这条也锁了"。
        h('b', null, t('配置来源')), h('span', null,
          server.conflict
            ? t('{base}，另有 {count} 条同名条目由其他配置层提供（{ids}）', {
              base: isForeign ? t('全局配置（在「全局」标签页可编辑）') : isWorkspace ? t('项目配置 .dsh/mcp.json（可编辑，本项目会话共享一份连接）') : server.managed ? t('当前 Web profile（可编辑）') : t('其他 bundle / Agent（只读）'),
              count: Math.max(1, server.duplicates?.length ?? 0),
              ids: (server.duplicates ?? []).map((other) => other.id).join(t('、')) || t('未知'),
            })
            : isForeign ? t('全局配置（在「全局」标签页可编辑）') : isWorkspace ? t('项目配置 .dsh/mcp.json（可编辑，本项目会话共享一份连接）') : server.managed ? t('当前 Web profile（可编辑）') : t('其他 bundle / Agent（只读）')),
        server.toolCallTimeoutMs ? h('b', null, t('调用超时')) : null, server.toolCallTimeoutMs ? h('span', null, server.toolCallTimeoutMs + ' ms') : null,
        h('b', null, t('启动失败策略')), h('span', null, server.failOnStartupError ? t('阻止插件启动') : t('记录错误并继续')),
        h('b', null, t('工具延迟加载')), h('span', null, (server.deferEffective ?? server.defer)
          ? t('已开启（{count} 工具经 tool_search 按需加载）', { count: server.toolCount })
          : t('关闭（工具全量常驻上下文）')),
        server.reconnect ? h('b', null, t('自动重连')) : null, server.reconnect ? h('span', null, server.reconnect.enabled === false ? t('关闭') : t('{min}–{max} ms，最多 {attempts} 次', { min: server.reconnect.initialDelayMs || 500, max: server.reconnect.maxDelayMs || 30000, attempts: server.reconnect.maxAttempts || 10 })) : null,
        headerKeys.length ? h('b', null, 'Headers') : null, headerKeys.length ? h('div', { className: 'dsh-mcp-secret-list' }, headerKeys.map((k) => h(RevealRow, { key: k, field: 'headers', keyName: k, label: 'Header ' + k }))) : null,
        envKeys.length ? h('b', null, t('环境变量')) : null, envKeys.length ? h('div', { className: 'dsh-mcp-secret-list' }, envKeys.map((k) => h(RevealRow, { key: k, field: 'env', keyName: k, label: t('环境变量 {name}', { name: k }) }))) : null,
      ),
    ),
    h('div', { className: 'dsh-mcp-card' + paneOff('tools') },
      h('h4', null, t('工具（{count}）', { count: tools.length })),
      h('div', { className: 'dsh-mcp-tools' },
        tools.length === 0
          ? h('div', { className: 'dsh-mcp-empty-list' }, server.toolCountAmbiguous ? t('工具归属存在命名歧义') : server.scope === 'workspace' ? t('尚无会话持有该项目连接，或连接尚未就绪') : t('暂无工具'))
          : tools.map((t) => h(ToolRow, { key: t.name, tool: t })),
      ),
    ),
    h('div', { className: 'dsh-mcp-d-diag' + paneOff('diag') },
      diagBlocks.length
        ? diagBlocks
        : h('div', { className: 'dsh-mcp-d-note' }, t('未检测到配置层冲突或工具归属歧义。')),
    ),
    ),
  );
};

/**
 * 详情页签的状态宿主。
 *
 * 为什么要有这一层：ServerDetail / SkillDetail 都是**纯函数**——测试直接以普通函数
 * 调用它们来校验渲染出的文本，函数体里放 useState 会在那种调用下抛 "Invalid hook
 * call"。所以页签状态放在这个薄包装里，详情组件只收 tab / onTab：
 * 不给 props 时默认第一页，且所有页内容照样全部渲染、只用 class 关掉非当前的，
 * 于是「详情必须画出正文」这类断言在分页之后依然成立。
 */
const ServerDetailPane = (props) => {
  const [tab, setTab] = useState('overview');
  // 换一台 server 就回到概览：上一台的页签选择对新的一台没有意义。
  const key = props.server ? props.server.serverName + ':' + (props.server.scope || '') : '';
  useEffect(() => { setTab('overview'); }, [key]);
  return h(ServerDetail, { ...props, tab, onTab: setTab });
};

const AddEditModal = ({ open, onClose, onSubmit, busy, initial, onRevealValue, revealEpoch, scope, scopeName }) => {
  const [name, setName] = useState('');
  const [transport, setTransport] = useState('http');
  const [url, setUrl] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [cwd, setCwd] = useState('');
  const [toolCallTimeoutMs, setToolCallTimeoutMs] = useState('60000');
  const [failOnStartupError, setFailOnStartupError] = useState(false);
  const [deferTools, setDeferTools] = useState(false);
  const [reconnectEnabled, setReconnectEnabled] = useState(true);
  const [initialDelayMs, setInitialDelayMs] = useState('500');
  const [maxDelayMs, setMaxDelayMs] = useState('30000');
  const [maxAttempts, setMaxAttempts] = useState('10');
  const [headers, setHeaders] = useState([{ k: '', v: '' }]);
  const [envs, setEnvs] = useState([{ k: '', v: '' }]);
  const [error, setError] = useState('');
  const [revealBusy, setRevealBusy] = useState('');
  const [editRevealed, setEditRevealed] = useState({});
  const editRevealGeneration = useRef(0);
  const editing = !!initial;
  const applyPreset = (id) => {
    const preset = MCP_PRESETS.find((p) => p.id === id);
    if (!preset) return;
    setName(preset.serverName);
    setTransport(preset.transport);
    setUrl('');
    setCommand(preset.command || '');
    setArgs((preset.args || []).join('\n'));
    setCwd('');
    setHeaders([{ k: '', v: '' }]);
    setEnvs([{ k: '', v: '' }]);
    setError('');
  };
  useEffect(() => {
    clearRevealState(editRevealGeneration, setEditRevealed, setRevealBusy);
  }, [revealEpoch]);
  useEffect(() => {
    editRevealGeneration.current += 1;
    if (!open) return;
    if (initial) {
      setName(initial.serverName);
      setTransport(initial.transport === 'http' ? 'http' : 'stdio');
      setUrl(toFormValue(initial.url || ''));
      setCommand(initial.command || '');
      setArgs(Array.isArray(initial.args) ? initial.args.map(toFormValue).join('\n') : '');
      setCwd(initial.cwd || '');
      setToolCallTimeoutMs(String(initial.toolCallTimeoutMs || 60000));
      setFailOnStartupError(initial.failOnStartupError === true);
      setDeferTools(initial.defer === true);
      setReconnectEnabled(initial.reconnect?.enabled !== false);
      setInitialDelayMs(String(initial.reconnect?.initialDelayMs || 500));
      setMaxDelayMs(String(initial.reconnect?.maxDelayMs || 30000));
      setMaxAttempts(String(initial.reconnect?.maxAttempts || 10));
      const hd = Object.keys(initial.headers || {}).map((k) => ({ k, originalKey: k, v: toFormValue(initial.headers[k]) }));
      setHeaders(hd.length ? hd : [{ k: '', v: '' }]);
      const ev = Object.keys(initial.env || {}).map((k) => ({ k, originalKey: k, v: toFormValue(initial.env[k]) }));
      setEnvs(ev.length ? ev : [{ k: '', v: '' }]);
    } else {
      setName(''); setTransport('http'); setUrl(''); setCommand(''); setArgs(''); setCwd('');
      setToolCallTimeoutMs('60000'); setFailOnStartupError(false); setReconnectEnabled(true);
      setInitialDelayMs('500'); setMaxDelayMs('30000'); setMaxAttempts('10');
      setHeaders([{ k: '', v: '' }]); setEnvs([{ k: '', v: '' }]);
    }
    setError('');
    setRevealBusy('');
    setEditRevealed({});
  }, [open, initial]);
  if (!open) return null;
  const kv = (rows, setRows, i, field, v) => {
    const next = rows.slice();
    const row = { ...next[i], [field]: v };
    if (field === 'k' && isPreservedValue(row.v) && v !== row.originalKey) row.v = '';
    next[i] = row;
    setRows(next);
  };
  const addRow = (rows, setRows) => setRows([...rows, { k: '', v: '' }]);
  const delRow = (rows, setRows, i) => setRows(rows.filter((_, x) => x !== i));
  const editRevealId = (field, key) => (initial?.serverName || 'new') + ':' + field + (key !== undefined ? ':' + key : '');
  const formatRevealedValue = (value) => Array.isArray(value)
    ? value.join('\n')
    : value && typeof value === 'object'
      ? Object.entries(value).map(([key, item]) => `${key}=${typeof item === 'object' ? JSON.stringify(item) : String(item)}`).join('\n')
      : String(value ?? '');
  // 输入框里显示的哨兵要按语言给（英文界面下不该冒出中文「保留原值」），但**只换显示**：
  // 值本身仍是 PRESERVED_VALUE_LABEL，提交时 fromFormValue 才认得出它。见哨兵的注释。
  const visibleEditValue = (field, key, fallback) => {
    const shown = Object.hasOwn(editRevealed, editRevealId(field, key)) ? editRevealed[editRevealId(field, key)] : fallback;
    return isPreservedValue(shown) ? preservedView() : shown;
  };
  const hideEditReveal = (field, key) => setEditRevealed((prev) => {
    const next = { ...prev };
    delete next[editRevealId(field, key)];
    return next;
  });
  const toggleEditReveal = async (field, key) => {
    if (!editing || !initial) return;
    const id = editRevealId(field, key);
    if (Object.hasOwn(editRevealed, id)) { hideEditReveal(field, key); return; }
    const generation = editRevealGeneration.current;
    setRevealBusy(id); setError('');
    try {
      const value = await onRevealValue(initial, field, key);
      if (generation !== editRevealGeneration.current) return;
      setEditRevealed((prev) => ({ ...prev, [id]: formatRevealedValue(value) }));
    } catch (e) {
      if (generation !== editRevealGeneration.current) return;
      setError(String(e?.message || e));
    } finally {
      if (generation === editRevealGeneration.current) setRevealBusy('');
    }
  };
  const submit = () => {
    const n = (name || '').trim();
    if (!n) return setError(t('请填写 MCP 名称'));
    const spec = { name: n, transport };
    if (transport === 'http') {
      spec.url = fromFormValue(url.trim());
      const hd = {};
      headers.forEach((r) => { if (r.k.trim()) setOwn(hd, r.k.trim(), fromFormValue(r.v)); });
      if (Object.keys(hd).length) spec.headers = hd;
    } else {
      spec.command = command.trim();
      const parts = args.split(/\r?\n/).map((s) => fromFormValue(s.trim())).filter(Boolean);
      if (parts.length) spec.args = parts;
      if (cwd.trim()) spec.cwd = cwd.trim();
      const ev = {};
      envs.forEach((r) => { if (r.k.trim()) setOwn(ev, r.k.trim(), fromFormValue(r.v)); });
      if (Object.keys(ev).length) spec.env = ev;
    }
    const timeout = Number(toolCallTimeoutMs);
    const initialDelay = Number(initialDelayMs);
    const maxDelay = Number(maxDelayMs);
    const attempts = Number(maxAttempts);
    if (!Number.isSafeInteger(timeout) || timeout <= 0 || !Number.isSafeInteger(attempts) || attempts <= 0) return setError(t('工具超时和最大尝试次数必须是正整数'));
    if (!Number.isFinite(initialDelay) || initialDelay <= 0 || initialDelay > MAX_TIMER_DELAY_MS || !Number.isFinite(maxDelay) || maxDelay <= 0 || maxDelay > MAX_TIMER_DELAY_MS) return setError(t('重连延迟必须是有效正数且不超过 2147483647 ms'));
    if (initialDelay > maxDelay) return setError(t('首次延迟不能大于最大延迟'));
    spec.toolCallTimeoutMs = timeout;
    spec.failOnStartupError = failOnStartupError;
    // 表单显式渲染的字段直接赋值；defer 关掉时写 false（updateEntry 对 false 原样落盘，
    // 不会留下 true 残影）。
    spec.defer = deferTools;
    spec.reconnect = { enabled: reconnectEnabled, initialDelayMs: initialDelay, maxDelayMs: maxDelay, maxAttempts: attempts };
    // 表单只拥有它显式渲染的字段，而提交是**重建** spec 而不是增量修改 —— 所以其余字段必须原样
    // 带回去，否则"编辑一次"就把它们抹掉：`disabled`（会让一个被禁用的 server 被悄悄启用）以及
    // 项目级的两个预算旋钮（表单不渲染它们，但配置文件里可能有）。
    if (initial) {
      if (initial.enabled === false) spec.disabled = true;
      for (const key of ['idleTimeoutMs', 'readyTimeoutMs']) if (initial[key] !== undefined) spec[key] = initial[key];
    }
    onSubmit(spec, setError);
  };
  const kvRows = transport === 'http' ? headers : envs;
  const setKvRows = transport === 'http' ? setHeaders : setEnvs;
  const revealIcon = (id, label, onClick) => {
    const shown = Object.hasOwn(editRevealed, id);
    return h('button', { type: 'button', className: 'dsh-mcp-btn dsh-mcp-inline-icon', disabled: revealBusy === id, title: (shown ? t('隐藏原值：') : t('显示原值：')) + label, 'aria-label': (shown ? t('隐藏原值：') : t('显示原值：')) + label, onClick }, revealBusy === id ? '…' : h(Icon, { d: ICONS[shown ? 'eyeOff' : 'eye'] }));
  };
  return h('div', { className: 'dsh-mcp-overlay', onClick: (e) => e.target === e.currentTarget && onClose() },
    h(Dialog, { label: editing ? t('编辑 MCP') : t('添加 MCP'), onClose },
      h('h3', null, (editing ? t('编辑 MCP') : t('添加 MCP')) + (scope !== 'global' && scopeName ? t('（{name}）', { name: scopeName }) : '')),
      !editing ? h('div', { className: 'dsh-mcp-field' },
        h('label', null, t('从预设模板快速填充（可选，命令需本机 npx/uvx）')),
        h('select', { value: '', onChange: (e) => applyPreset(e.target.value), 'aria-label': t('选择预设模板') },
          h('option', { value: '' }, t('— 选择预设 —')),
          MCP_PRESETS.map((p) => h('option', { key: p.id, value: p.id }, t(p.label))),
        ),
      ) : null,
      h('div', { className: 'dsh-mcp-field' },
        h('label', null, t('MCP 名称（唯一标识，不可改）')),
        h('input', { value: name, disabled: editing, onChange: (e) => setName(e.target.value), placeholder: 'my-server' }),
      ),
      h('div', { className: 'dsh-mcp-field' },
        h('label', null, t('传输类型')),
        h('div', { className: 'dsh-mcp-radio-row' },
          h('label', { className: transport === 'http' ? 'sel' : '' }, h('input', { type: 'radio', checked: transport === 'http', onChange: () => setTransport('http') }), t('HTTP（远程）')),
          h('label', { className: transport === 'stdio' ? 'sel' : '' }, h('input', { type: 'radio', checked: transport === 'stdio', onChange: () => setTransport('stdio') }), t('stdio（本地进程）')),
        ),
      ),
      transport === 'http'
        ? h('div', { className: 'dsh-mcp-field' },
            h('label', null, 'URL'),
            h('div', { className: 'dsh-mcp-input-action' },
              h('input', { value: visibleEditValue('url', undefined, url), onChange: (e) => { hideEditReveal('url'); setUrl(e.target.value); }, placeholder: 'https://example.com/mcp' }),
              editing && isPreservedValue(url) ? revealIcon('url', 'URL', () => toggleEditReveal('url')) : null,
            ),
          )
        : h('div', null,
            h('div', { className: 'dsh-mcp-field' }, h('label', null, t('命令')), h('input', { value: command, onChange: (e) => setCommand(e.target.value), placeholder: t('npx 或 C:\\path\\to\\bin.exe') })),
            h('div', { className: 'dsh-mcp-field' },
              h('label', null, t('参数（每行一个，原样传给进程）')),
              h('div', { className: 'dsh-mcp-input-action' },
                h('textarea', { rows: 4, value: visibleEditValue('args', undefined, args), onChange: (e) => { hideEditReveal('args'); setArgs(e.target.value); }, placeholder: '-y\nmcp-server@latest' }),
                editing && isPreservedValue(args) ? revealIcon('args', t('参数'), () => toggleEditReveal('args')) : null,
              ),
            ),
            h('div', { className: 'dsh-mcp-field' }, h('label', null, t('工作目录 cwd（可选）')), h('input', { value: cwd, onChange: (e) => setCwd(e.target.value), placeholder: 'C:\\path\\to\\workspace' })),
          ),
      h('div', { className: 'dsh-mcp-field' },
        h('label', null, transport === 'http' ? t('Headers（可选）') : t('环境变量（可选，值写 !!js process.env.KEY 引用密钥）')),
        kvRows.map((row, i) => {
          const field = transport === 'http' ? 'headers' : 'env';
          const originalKey = row.originalKey || row.k;
          const id = editRevealId(field, originalKey);
          return h('div', { key: i, className: 'dsh-mcp-kv-edit' },
            h('input', { placeholder: transport === 'http' ? 'Authorization' : 'API_KEY', value: row.k, onChange: (e) => { hideEditReveal(field, originalKey); kv(kvRows, setKvRows, i, 'k', e.target.value); } }),
            h('input', { placeholder: transport === 'http' ? t('Bearer … 或 !!js process.env.KEY') : 'value', value: visibleEditValue(field, originalKey, row.v), onChange: (e) => { hideEditReveal(field, originalKey); kv(kvRows, setKvRows, i, 'v', e.target.value); } }),
            h('div', { className: 'dsh-mcp-kv-row-actions' },
              editing && isPreservedValue(row.v) ? revealIcon(id, row.k, () => toggleEditReveal(field, originalKey)) : null,
              h('button', { type: 'button', className: 'dsh-mcp-kv-del', onClick: () => delRow(kvRows, setKvRows, i), title: t('删除此项'), 'aria-label': t('删除 {name}', { name: row.k || t('配置项') }) }, h(Icon, { d: ICONS.x })),
            ),
          );
        }),
        h('div', { className: 'dsh-mcp-kv-add' }, h(Btn, { onClick: () => addRow(kvRows, setKvRows), children: t('+ 添加') })),
      ),
      h('div', { className: 'dsh-mcp-card dsh-mcp-advanced' },
        h('h4', null, t('运行策略')),
        h('div', { className: 'dsh-mcp-field' }, h('label', null, t('工具调用超时（毫秒）')), h('input', { type: 'number', min: 1, value: toolCallTimeoutMs, onChange: (e) => setToolCallTimeoutMs(e.target.value) })),
        h('label', { className: 'dsh-mcp-check' }, h('input', { type: 'checkbox', checked: failOnStartupError, onChange: (e) => setFailOnStartupError(e.target.checked) }), t('首次连接失败时阻止插件启动')),
        h('label', { className: 'dsh-mcp-check', title: t('开启后该服务器的工具不再全量常驻上下文，模型按需通过 tool_search 搜索加载；调用一次多一个往返。适合工具数量多的服务器。') }, h('input', { type: 'checkbox', checked: deferTools, onChange: (e) => setDeferTools(e.target.checked) }), t('延迟加载工具（ToolSearch 按需搜索）')),
        // 开启前预告：只给**真实数据**——工具数。不再提任何门槛：两道门槛（per-server ≤10、
        // 会话级 <15）在第十轮整个删掉了（官方没有这两道，且它们制造"勾了没生效"的断层）。
        // 刻意不给"能省多少 token"：我们不知道用户装了什么 MCP，schema 大小差一个量级，
        // 估算数字的精确感是假的，而用户会拿它做决定。
        // 唯一保留的诚实记账：小服务器延迟之后每轮仍要付一段引导语，"省字"可能是负的
        // （DECISIONS §9.1 的补记）——这句话必须写在这里，因为开关就在这一行。
        editing && initial.toolCount !== undefined
          ? h('div', { className: 'dsh-mcp-d-note' }, initial.toolCount <= 10
            ? t('该服务器仅 {count} 个工具：延迟后按需加载，但每轮仍要付一段引导语，省下的空间可能不多', { count: initial.toolCount })
            : t('该服务器 {count} 个工具，将经 tool_search 按需加载', { count: initial.toolCount }))
          : null,
        h('label', { className: 'dsh-mcp-check' }, h('input', { type: 'checkbox', checked: reconnectEnabled, onChange: (e) => setReconnectEnabled(e.target.checked) }), t('断开后自动重连')),
        h('div', { className: 'dsh-mcp-number-grid' },
          h('div', { className: 'dsh-mcp-field' }, h('label', null, t('首次延迟 ms')), h('input', { type: 'number', min: 1, step: 'any', value: initialDelayMs, onChange: (e) => setInitialDelayMs(e.target.value) })),
          h('div', { className: 'dsh-mcp-field' }, h('label', null, t('最大延迟 ms')), h('input', { type: 'number', min: 1, step: 'any', value: maxDelayMs, onChange: (e) => setMaxDelayMs(e.target.value) })),
          h('div', { className: 'dsh-mcp-field' }, h('label', null, t('最大尝试次数')), h('input', { type: 'number', min: 1, value: maxAttempts, onChange: (e) => setMaxAttempts(e.target.value) })),
        ),
      ),
      error ? h('div', { className: 'dsh-mcp-d-err' }, error) : null,
      h('div', { className: 'dsh-mcp-modal-actions' },
        h(Btn, { onClick: onClose, children: t('取消') }),
        h(Btn, { cls: 'primary', onClick: submit, disabled: busy, children: busy ? t('保存中…') : (editing ? t('保存') : t('添加')) }),
      ),
    ),
  );
};

// 「MCP 市场」：目录的浏览与安装入口。
//
// 与旧的「内置 MCP」对话框的区别是它成了**主要入口**：搜索框是主操作，分类 chips 让用户
// 按用途找而不是按名字找，卡片直接可装，不再需要先勾选再确认。多选保留着——批量装同一类
// （比如把搜索类一次装齐）仍然比一个个点快。
//
// 数据来自 Host 的 builtins RPC，**分类标签也在那里**：这个文件是预构建 bundle，不 import
// Host 模块，所以 lib/mcp-catalog.js 的常量在这里读不到——Host 已把 categoryLabel 带在每条
// 目上。分类的**顺序**取目录里的首次出现序，而生成器已按 CATEGORY_ORDER 重排了目录，所以这里
// 取到的就是产品定的顺序；客户端不再维护一份顺序表：否则加一个分类要记得改两个文件。
/**
 * MCP 发现市场 —— **内联视图**，不再是浮层。
 *
 * 为什么改：从前它是个 1080×820 的弹窗（.dsh-mcp-modal.dsh-mcp-market），而技能面的市场
 * 是内联的。同一个「发现市场」在两个能力面里是两种形态、两个入口（一个按钮弹窗、
 * 一个模式切换），用户得分别学一遍。现在两边都是第二行「发现市场」模式下的内联网格，
 * 共用同一批原语（.dsh-mcp-chips / .dsh-mcp-grid / .dsh-mcp-mcard）。
 *
 * 逐条安装，不做多选批量：多选那套（全选 / 安装选中）与技能面、与原型都不一致，
 * 而且它把一个「看见就能装」的动作变成了「先勾再确认」两步。
 */
/**
 * 把目录条目对齐到**当前作用域**的「已配置」语义。
 *
 * 为什么必须有这一步：Host 的目录是按**全局 effective 配置**标 `installed` 的，
 * 而面板有全局与项目两种作用域。第一版只在项目作用域里**补** true、从不改成 false，
 * 于是切到某个项目后：全局装过的服务被显示成「已写入本项目配置」并给一个「移除」按钮
 * （那个项目其实一条配置都没有，按钮点下去只会报错）——真机上就是这么表现的：
 * 药丸写着 0 个 MCP，市场里却有 11 个「已配置」。
 *
 * 两种作用域的含义本来就不同，所以这里明确二分：
 *   全局：Host 报什么就是什么（就是当前 profile 的配置）。
 *   项目：**只有该项目自己的配置算数**；全局装过但本项目没有的，标成
 *         `globallyInstalled` 让卡片说清楚「全局已装，可以再装一份项目副本」，
 *         而不是假装它已经在这个项目里。
 *
 * 纯函数：目录映射是「同一份数据在两种作用域下两种含义」这类最容易错的地方，
 * 抽出来才能直接断言，而不是只在真机上看一眼。
 */
function catalogForScope(items, { isWorkspace, knownNames } = {}) {
  const list = Array.isArray(items) ? items : [];
  if (!isWorkspace) return list;
  const names = new Set((Array.isArray(knownNames) ? knownNames : [])
    .map((entry) => entry?.serverName)
    .filter((name) => typeof name === 'string' && name !== ''));
  return list.map((item) => (names.has(item.name)
    ? { ...item, installed: true, installedAs: [item.name], globallyInstalled: item.installed === true }
    // installed:false 是**判定**，不是「不知道」：本项目确实没有这一条。
    : { ...item, installed: false, installedAs: undefined, globallyInstalled: item.installed === true }));
}

/**
 * 安装目标：优先用宿主报的**全部**位置（`skillTargets`，含还没建的），
 * 拿不到就退回「实际发现」的候选。
 *
 * 为什么要两条路：`skillTargets` 是新方法，老宿主没有它——那时 `call` 返回 `{ok:false}`，
 * 面板必须退回原来的行为（只列已经在用的位置），而不是把「安装到」变成空的。
 * 为什么新方法才是正解：观察 ≠ 能力。「`~/.dsh/skills` 里还没有技能」不代表不能往里装，
 * 而按发现派生的候选永远列不出这种位置（用户的原话：「用户没有选择的权力？」）。
 *
 * @param {object[]} targets - 宿主 skillTargets 的结果（{source, root, scope, writable, exists, projectPath}）。
 * @param {object[]} discovered - skillScopeOptions(rows) 的退路。
 * @returns {{ source, label, scope, root, writable, exists, pending }[]}
 */
/**
 * 安装目标的**唯一身份**：`source + root`。
 *
 * ⚠️ 不能只用 `source`：两个工作区都会有 `project-agents`。只按 source 做 key/查找，会让
 * 两个单选项撞同一个 key、同一个选中值，而且 `find` 取首个 → 用户以为选的是项目 B，
 * 实际写进项目 A（或 `installTargets[0]` 那个默认）。宿主本来就是按 `source\0root`
 * 去重的（skills-registry.js 的 skillTargetsView），面板必须用同一套身份。
 */
const installTargetId = (option) => `${option?.source || ''}\u0000${option?.root || ''}`

function skillTargetOptions(targets, discovered) {
  const host = (Array.isArray(targets) ? targets : []).filter((target) => typeof target?.source === 'string' && typeof target?.root === 'string')
  if (host.length === 0) return Array.isArray(discovered) ? discovered : []
  return host
    // 标签复用同一套（SCOPE_LABELS + 项目名），不另起一份文案。
    // projectPath 是原始工作区路径，用来补出「项目 easyStory」里的名字。
    .map((target) => ({
      id: installTargetId(target),
      source: target.source,
      label: skillScopeLabel({ source: target.source, cwd: target.projectPath }),
      scope: target.scope === 'project' ? 'project' : 'global',
      root: target.root,
      // wire 上的目标引用（source + root + projectPath）：服务端拿自己算出的目标集合核对。
      projectPath: target.projectPath,
      // 只用于**过滤**掉只读位置（服务端仍会独立判定一次，不接受载荷里的 writable）。
      writable: target.writable !== false,
      // exists=false：目录还没建。**照样可装**（宿主 importSkill 会 mkdir -p），
      // 但要在选项里说清楚，别让人以为选了个坏位置。
      exists: target.exists !== false,
      pending: target.exists === false,
    }))
    // 展示顺序：**全局在前、项目在后**（用户级是默认视角，与作用域药丸同一套语义），
    // 组内按宿主 rank。这是**面板的**呈现顺序，与宿主返回的顺序（纯 rank）故意不同：
    // host 的 rank 是「谁被优先采纳」，不是「用户先看到谁」。
    .sort((left, right) => {
      if (left.scope !== right.scope) return left.scope === 'global' ? -1 : 1
      return sourceRank(left.source) - sourceRank(right.source)
    })
}

/**
 * 区分「宿主没提供这个接口」与「上游失败」。
 *
 * 为什么必须分开：新版面板在老宿主进程上跑时，`skillHubSearch` 这个 endpoint 根本不存在，
 * wire 直接 404。把它显示成「skillhub.cn 不可用」是**误报**——上游一次都没被访问过，
 * 用户会去查网络/上游，而真正要做的是重启宿主加载新版插件。
 *
 * 判据取自 wire 的实际形状（真机抓到过）：
 *   client api: skillsManager/skillHubSearch failed: transport failure for
 *   /api/skillsManager/skillHubSearch: HTTP 404
 * 也就是「transport failure」/「HTTP 404」这两个网关用词。这里没有更好的办法：
 * 网关不暴露能力自省（没有 methods() 之类的公开面），所以只能按这两个标记分类。
 * 分类错了最坏只是措辞不对（两条路径都不会假装成功）。
 *
 * @param {string} message - callSkills 返回的 error 原文。
 * @returns {'missing' | 'upstream'}
 */
function classifyHubError(message) {
  const text = String(message || '');
  return /transport failure|HTTP 404/i.test(text) ? 'missing' : 'upstream';
}

const McpMarketView = ({ call, busy, setBusy, onInstalled, scope, scopeName, scopeOptions, onScope, knownNames }) => {
  const isWorkspace = scope !== 'global' && scope !== undefined;
  const loadGeneration = useRef(0);
  const [catalog, setCatalog] = useState([]);
  const [loading, setLoading] = useState(false);
  // 错误卡片带**来源**而不是一句通用标题：这个面板里三种动作（读目录 / 安装 / 移除）都会往这里
  // 写，一律写成「读取目录失败」时，一次移除失败看起来像目录坏了（真机就是这么误导的），
  // 旁边那个「重试」其实只是重新读一次目录，跟用户想重试的那件事也不是同一件。
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [sort, setSort] = useState('default');
  const [onlyKeyless, setOnlyKeyless] = useState(false);

  // ⚠️ 目录的重载键必须是「作用域 + 该作用域当前的 serverName 集合」，不能只是「是不是项目」。
  // 真机实测两处都错在这一条上：
  //   1) 全局 ↔ 项目：`servers` 是**异步**到的。切过去的那一帧目录已经重载、而名字还是上一
  //      个作用域的，于是全局装过的条目被算成「本项目已配置」（实测显示「已配置 9 个」
  //      并给 9 个「移除」按钮，而那个项目一条配置都没有）。
  //   2) 项目 ↔ 项目：isWorkspace 不变 → loadCatalog 身份不变 → **目录根本不重载**，
  //      卡片停在上一个项目的已配置状态。
  // 把名字集合压成一个字符串进依赖，两处一起解决：名字到位后自动重算一次，
  // 而字符串相同就不会因为数组换了引用而空转。
  const knownNamesKey = (Array.isArray(knownNames) ? knownNames : [])
    .map((server) => server?.serverName)
    .filter((name) => typeof name === 'string' && name !== '')
    .sort()
    .join('|');

  const loadCatalog = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setLoading(true); setError('');
    try {
      const res = await call('builtins');
      if (!res?.ok) throw new Error(res?.error || t('读取 MCP 目录失败'));
      if (generation !== loadGeneration.current) return;
      // 项目作用域：「已配置」必须以**这个项目自己的配置**为准，不能用 Host 那份
      // 全局 effective 的标记（理由与后果见 catalogForScope 的注释）。
      setCatalog(catalogForScope(res.builtins, { isWorkspace, knownNames }));
    } catch (e) {
      if (generation === loadGeneration.current) setError({ title: t('读取目录失败'), message: String(e?.message || e) });
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, [call, isWorkspace, knownNames, knownNamesKey]);
  // 挂载即加载（市场模式才渲染这个组件），换作用域重新加载一遍：已配置状态是按作用域算的。
  useEffect(() => {
    setCatalog([]); setError(null);
    loadCatalog();
  }, [loadCatalog]);

  // 分类按目录里的首次出现顺序排列；标签取条目自带的 categoryLabel。
  const categoryCounts = new Map();
  for (const item of catalog) {
    const key = item.category || 'other';
    const entry = categoryCounts.get(key) || { label: pickCatalogText(item, 'categoryLabel') || key, count: 0 };
    entry.count += 1;
    categoryCounts.set(key, entry);
  }
  const categories = [...categoryCounts.keys()];

  // 「需不需要密钥」是用户最先要判断的事之一：免密的可以立刻装来试，要 Key 的得先申请。
  const needsKey = (item) => Array.isArray(item.envKeys) && item.envKeys.length > 0;
  // 连接参数（Redis 的 HOST/PORT、ClickHouse 的 HOST/USER）不是密钥，但同样要用户先准备，
  // 所以「只要免密钥」这个筛选项把它们也排除掉——否则 Redis 会被当成装上就能用。
  const needsConfig = (item) => Array.isArray(item.configKeys) && item.configKeys.length > 0;
  // 参数里含 <占位符>：装完要去编辑里替换，否则拿占位符当真实路径启动。
  // 占位符提示按语言挑：英文副本译了 args 里的占位符（生成器派生 placeholdersEn），
  // 没译就回落中文——宁可显示中文，也不要指着 `<仓库路径>` 让英文用户猜。
  const needsArgs = (item) => Array.isArray(item.placeholders) && item.placeholders.length > 0;
  const itemPlaceholders = (item) => (localeIsEnglish() && Array.isArray(item.placeholdersEn) && item.placeholdersEn.length ? item.placeholdersEn : item.placeholders) || [];
  const readyToRun = (item) => !needsKey(item) && !needsConfig(item) && !needsArgs(item);

  const filtered = catalog.filter((item) => {
    if (category !== 'all' && (item.category || 'other') !== category) return false;
    if (onlyKeyless && !readyToRun(item)) return false;
    if (!query.trim()) return true;
    // 两种语言都进搜索域：英文界面下用户可能按中文名找，反之亦然。
    const haystack = [item.label, item.labelEn, item.id, item.name, item.summary, item.summaryEn, item.vendor, item.vendorEn, item.access, item.accessEn]
      .filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(query.trim().toLowerCase());
  });
  const visible = sort === 'installed'
    ? [...filtered].sort((a, b) => Number(a.installed || false) - Number(b.installed || false))
    : sort === 'name'
      ? [...filtered].sort((a, b) => String(a.label).localeCompare(String(b.label), 'zh-Hans-CN'))
      : filtered;

  const remove = async (item) => {
    setBusy(true); setError(null);
    try {
      // Host 的移除是单数 RPC、按 serverName 定位。一条目录项可能以多个名字装过（用户改过名），
      // 所以逐个移除；任一失败都如实报出来——静默跳过会让「移除」看着成功、实际留下半条配置。
      const names = item.installedAs && item.installedAs.length ? item.installedAs : [item.name];
      const notes = [];
      for (const name of names) {
        // 两个方法的 wire 形状**不同**，不能照着写成一个对象：
        //   removeWorkspaceServer 收一个 payload（wire `payload`），传对象；
        //   removeServer 收**标量 name**（wire `name`），传字符串。
        // 客户端代理按位置把实参映射到 `parameters[i].wire`（dsh-api-gateway 的
        // ClientRemote.invoke），所以 `removeServer({ name })` 到宿主就是 `{ name: { name } }`，
        // 被 name 的 String codec 拦下——真机报 `wire field "name" failed boundary validation`，
        // 「移除」永远失败（而面板把这条错误显示成「读取目录失败」，更像目录坏了）。
        const res = isWorkspace
          ? await call('removeWorkspaceServer', { wsPath: scope, name })
          : await call('removeServer', name);
        if (!res?.ok) throw new Error(res?.error || t('移除失败：{name}', { name }));
        // 宿主那句 note 里带着「还剩下几条同名条目、要重启宿主才会重连」——直接覆盖成
        // 「已移除 xxx」会把这唯一的线索丢掉，用户随后仍然看到失败日志，只会以为没删掉。
        if (typeof res.note === 'string' && res.note.trim() !== '') notes.push(res.note);
      }
      onInstalled({ note: notes.length ? notes.join('；') : t('已移除 {names}', { names: names.join(t('、')) }) });
      await loadCatalog();
    } catch (e) {
      setError({ title: t('移除失败'), message: String(e?.message || e) });
    } finally {
      setBusy(false);
    }
  };
  const install = async (ids) => {
    if (!ids || !ids.length) return;
    setBusy(true); setError(null);
    try {
      const res = isWorkspace
        ? await call('installWorkspaceBuiltins', { wsPath: scope, ids })
        : await call('installBuiltins', { ids });
      if (!res?.ok) throw new Error(res?.error || t('安装 MCP 失败'));
      onInstalled(res);
      await loadCatalog();
    } catch (e) {
      setError({ title: t('安装失败'), message: String(e?.message || e) });
    } finally {
      setBusy(false);
    }
  };

  const installedCount = catalog.filter((item) => item.installed).length;
  const cardOf = (item) => {
    const http = item.transport === 'streamable-http';
    // 与技能面的市场卡片同一个原语（.dsh-mcp-mcard）：
    //   左边一个图标块 / 名字 + 来源 / 一句说明 / 标签 / 底栏（统计 + 动作）。
    return h('div', {
      key: item.id,
      className: 'dsh-mcp-mcard' + (item.installed ? ' installed' : ''),
    },
      h('div', { className: 'dsh-mcp-mcard-top' },
        h('div', { className: 'dsh-mcp-mcard-icon' }, h(Icon, { d: ICONS[item.installed ? 'check' : 'box'], size: 16 })),
        h('div', { className: 'dsh-mcp-mcard-main' },
          h('div', { className: 'dsh-mcp-mcard-name' }, pickCatalogText(item, 'label')),
          h('div', { className: 'dsh-mcp-mcard-meta' },
            item.vendor ? h('span', null, pickCatalogText(item, 'vendor')) : null,
            h('span', null, http ? 'streamable-http' : 'stdio'),
          ),
        ),
      ),
      h('div', { className: 'dsh-mcp-mcard-desc', title: pickCatalogText(item, 'summary') }, pickCatalogText(item, 'summary')),
      h('div', { className: 'dsh-mcp-mcard-tags' },
        item.categoryLabel ? h(Badge, null, pickCatalogText(item, 'categoryLabel')) : null,
        item.installed
          ? h(Badge, { cls: 's-on' }, t('已配置'))
          : (needsKey(item)
            ? h(Badge, null, t('需密钥'))
            : needsConfig(item)
              // 连接参数与密钥分开说：Redis / ClickHouse 是本机服务，标成「需密钥」会让人
              // 以为要去申请账号。
              ? h(Badge, null, t('需连接信息'))
              : h(Badge, { cls: 's-off' }, t('免密钥'))),
        // 项目作用域下：全局装过、但这个项目没有。说清楚而不是假装它已在这个项目里——
        // 装一份项目副本是完全合理的动作，用户需要知道「全局那份还在」。
        !item.installed && item.globallyInstalled ? h(Badge, { cls: 's-lock' }, t('全局已装')) : null,
        // 含 <占位符> 的条目（如 filesystem 的「允许访问的目录」）装完**不能直接用**：
        // 拿占位符当真实参数启动一定失败。这里如实标出来，别让用户以为装完就好了。
        needsArgs(item) ? h(Badge, { cls: 's-err' }, t('需填参数')) : null,
      ),
      h('div', { className: 'dsh-mcp-mcard-access' }, pickCatalogText(item, 'access')),
      needsArgs(item)
        ? h('div', { className: 'dsh-mcp-mcard-note' }, t('安装后需编辑，替换 {names}', { names: itemPlaceholders(item).join(t('、')) }))
        : null,
      // 把要填的变量名直接写出来。只说「需密钥」等于没说——用户知道要申请，却不知道
      // 填进哪个名字（ClickHouse 要 4 个变量，Redis 要 HOST/PORT）。
      needsKey(item) || needsConfig(item)
        ? h('div', { className: 'dsh-mcp-mcard-vars' },
            needsKey(item) ? h('span', null, t('密钥：{names}', { names: item.envKeys.join(t('、')) })) : null,
            needsConfig(item) ? h('span', null, t('连接：{names}', { names: item.configKeys.join(t('、')) })) : null,
          )
        : null,
      h('div', { className: 'dsh-mcp-mcard-foot' },
        h('span', { className: 'dsh-mcp-mcard-stat' + (needsArgs(item) ? ' err' : '') },
          item.installed
            ? t('已写入{scope}', { scope: isWorkspace ? t('本项目配置') : t('全局配置') })
            : (needsArgs(item)
              ? t('需先填参数')
              : (!item.installed && item.globallyInstalled ? t('全局已装 · 可加一份项目副本') : t('可直接安装')))),
        h('div', { className: 'dsh-mcp-mcard-actions' },
          item.installed
            ? h(Btn, { cls: 'danger sm', disabled: busy, onClick: () => remove(item), children: t('移除') })
            : h(Btn, { cls: 'primary sm', disabled: busy, onClick: () => install([item.id]), children: t('安装') }),
          item.homepage
            ? h('a', {
              className: 'dsh-mcp-btn sm',
              href: item.homepage,
              target: '_blank',
              rel: 'noreferrer',
              title: t('打开官方文档'),
              children: t('文档'),
            })
            : null,
        ),
      ),
    );
  };

  return h('div', { className: 'dsh-mcp-market-view', role: 'region', 'aria-label': t('MCP 发现市场') },
    h('div', { className: 'dsh-mcp-market-toolbar' },
      h('div', { className: 'dsh-mcp-market-head' },
        h('div', { className: 'dsh-mcp-chips', role: 'tablist', 'aria-label': t('按分类浏览') },
          h('button', {
            type: 'button', role: 'tab', 'aria-selected': category === 'all',
            className: 'dsh-mcp-chip' + (category === 'all' ? ' sel' : ''),
            onClick: () => setCategory('all'),
          }, t('全部'), h('span', { className: 'dsh-mcp-chip-count' }, catalog.length)),
          categories.map((key) => h('button', {
            key, type: 'button', role: 'tab', 'aria-selected': category === key,
            className: 'dsh-mcp-chip' + (category === key ? ' sel' : ''),
            onClick: () => setCategory(key),
          }, categoryCounts.get(key).label, h('span', { className: 'dsh-mcp-chip-count' }, categoryCounts.get(key).count))),
        ),
        h('div', { className: 'dsh-mcp-market-tools' },
          h('div', { className: 'dsh-mcp-search' },
            h(Icon, { d: ICONS.search }),
            h('input', {
              type: 'search',
              placeholder: t('搜索服务、用途或提供方…'),
              value: query,
              'aria-label': t('搜索 MCP 服务'),
              onChange: (e) => setQuery(e.target.value),
            }),
          ),
          // 「安装到」：市场模式下**唯一**的作用域入口（已安装模式用药丸，两者写同一份 state）。
          // 原型有这一项，第一版漏了——结果是「装到哪」只在脚注里用一行小字说，
          // 而用户真正需要的是在按「安装」之前能改它。
          h('label', { className: 'dsh-mcp-market-scope' },
            h('span', null, t('安装到')),
            h('select', {
              value: scope,
              'aria-label': t('安装到哪个作用域'),
              onChange: (e) => onScope(e.target.value),
            },
              ...scopeOptions.map((option) => h('option', { key: option.key, value: option.key, title: option.title }, option.label)),
            ),
          ),
        ),
      ),
    ),
    // 目录说明：装到哪里是这一屏最要紧的事实（写错作用域等于装了个用不上的服务）。
    h('div', { className: 'dsh-mcp-market-section' },
      h('b', null, t('内置 MCP 目录')),
      h('span', null, loading
        ? t('正在读取目录…')
        : t('{total} 个服务 · 已配置 {installed} 个 · 装入{scope}', { total: catalog.length, installed: installedCount, scope: isWorkspace ? t('本项目 {name}', { name: scopeName }) : t('全局配置') })),
    ),
    h('div', { className: 'dsh-mcp-market-filters' },
      h('label', null, t('排序'),
        h('select', { value: sort, onChange: (e) => setSort(e.target.value), 'aria-label': t('排序方式') },
          h('option', { value: 'default' }, t('默认')),
          h('option', { value: 'installed' }, t('未配置优先')),
          h('option', { value: 'name' }, t('名称')),
        ),
      ),
      h('label', null,
        h('input', { type: 'checkbox', checked: onlyKeyless, onChange: (e) => setOnlyKeyless(e.target.checked) }),
        t('只要免密钥'),
      ),
      h('span', null, t('显示 {visible} / {total}', { visible: visible.length, total: catalog.length })),
    ),
    h('div', { className: 'dsh-mcp-grid' },
      error
        ? h(Notice, {
          tone: 'err', icon: 'warn', title: error.title, children: error.message,
          actions: [h(Btn, { key: 'retry', cls: 'sm', disabled: loading || busy, onClick: loadCatalog, children: loading ? t('重试中…') : t('重试') })],
        })
        : null,
      !error && !loading && !visible.length
        ? h('div', { className: 'dsh-mcp-market-empty' }, catalog.length ? t('没有匹配的服务，换个关键词或分类试试') : t('目录是空的'))
        : null,
      visible.map(cardOf),
    ),
    h('div', { className: 'dsh-skills-note' },
      h('b', null, t('收录 ≠ 背书。')),
      t('内置目录只保证「命令与协议形态已核对」，不审查服务端行为。装上之前请确认来源可信——尤其是需要密钥或连接信息的那些。'),
    ),
  );
};

const sourceImportNames = (row) => (row.entries || []).filter((entry) => !entry.error).map((entry) => entry.name);
// 只在界面上提示「这条来源带了会被掩码的字段」。具体值一律留在 Host：Host 只给字段名。
const sourceMaskedFields = (row) => [...new Set((row.entries || []).flatMap((entry) => entry.maskedFields || []))];
// 环境变量名不算秘密（值才是），但缺值会让导入后的那个位置变成空字符串，得先说。
const sourceMissingEnv = (row) => [...new Set((row.entries || []).flatMap((entry) => entry.missingEnv || []))];

const JsonImportModal = ({ open, onClose, call, busy, setBusy, onImported, scope, scopeName }) => {
  const isWorkspace = scope !== 'global' && scope !== undefined;
  const [text, setText] = useState('');
  const [mode, setMode] = useState('merge');
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [sources, setSources] = useState([]);
  const [sourcesLoading, setSourcesLoading] = useState(false);
  const [sourcesError, setSourcesError] = useState('');
  const [source, setSource] = useState(null);
  const [sourcePreview, setSourcePreview] = useState(null);
  const clearSource = () => { setSource(null); setSourcePreview(null); };
  // 项目标签同时决定「扫哪些项目级来源」与「写到哪个项目」，与粘贴路径的分工一致。
  // 注意：这个对象每次渲染都是新的，**不能**进 useCallback 的依赖——那会让 loadSources
  // 每渲染换一次身份、扫描无限重跑。loadSources 里按 isWorkspace/scope 原值重建一份。
  const scopePayload = isWorkspace ? { wsPath: scope } : {};
  const loadSources = useCallback(async () => {
    setSourcesLoading(true); setSourcesError('');
    try {
      const res = await call('scanImportSources', isWorkspace ? { wsPath: scope } : {});
      if (!res?.ok) throw new Error(res?.error || t('读取本机客户端配置失败'));
      setSources(res.sources || []);
    } catch (e) { setSourcesError(String(e?.message || e)); }
    finally { setSourcesLoading(false); }
  }, [call, isWorkspace, scope]);
  useEffect(() => { if (open) { setPreview(null); setError(''); } }, [open]);
  useEffect(() => {
    if (!open) { setSources([]); setSourcesError(''); clearSource(); return; }
    loadSources();
  }, [open, loadSources]);
  if (!open) return null;
  // 选中来源后，来源导入优先于粘贴内容：两者不会同时在生效状态。
  const pickSource = async (row) => {
    const names = sourceImportNames(row);
    if (row.error || !names.length) { setError(row.error || t('这条配置里没有可导入的 MCP')); return; }
    setBusy(true); setError(''); setPreview(null); clearSource();
    try {
      const res = await call('previewImportSource', { sourceId: row.sourceId, scope: row.scope, names, ...scopePayload });
      if (!res?.ok) throw new Error(res?.error || t('预览失败'));
      setSource(row); setSourcePreview(res);
    } catch (e) { setError(String(e?.message || e)); }
    finally { setBusy(false); }
  };
  const runPreview = async () => {
    setBusy(true); setError(''); clearSource();
    try {
      const res = isWorkspace
        ? await call('previewWorkspaceImport', { wsPath: scope, json: text, mode })
        : await call('previewImport', { json: text, mode });
      if (!res?.ok) throw new Error(res?.error || t('JSON 解析失败'));
      setPreview(res);
    } catch (e) { setError(String(e?.message || e)); }
    finally { setBusy(false); }
  };
  // 两条导入流程（粘贴 / 本机来源）只有「确认文案」与「调哪个 RPC」不同：把
  // 确认 → busy → RPC → 报错或收尾的骨架收在一处，避免两处各写一遍、改一处漏一处。
  const submitImport = async (confirmMessage, run) => {
    if (confirmMessage && !confirm(confirmMessage)) return;
    setBusy(true); setError('');
    try {
      const res = await run();
      if (!res?.ok) throw new Error(res?.error || t('导入失败'));
      onImported(res);
      onClose();
    } catch (e) { setError(String(e?.message || e)); }
    finally { setBusy(false); }
  };
  const replaceWarning = t('替换会删除{scope}', { scope: isWorkspace ? t('该项目') : t('当前 Web profile') });
  const applyImport = async () => {
    if (!preview) return runPreview();
    // 同名冲突不再让整批失败：Host 会跳过那几条并在预览的提示里写明，用户按需处理。
    return submitImport(
      mode === 'replace' ? t('{warning}中未出现在 JSON 里的 MCP。确认继续？', { warning: replaceWarning }) : '',
      () => (isWorkspace
        ? call('importWorkspaceJson', { wsPath: scope, json: text, mode })
        : call('importJson', { json: text, mode })),
    );
  };
  const applySourceImport = async () => {
    if (!source || !sourcePreview) return;
    return submitImport(
      mode === 'replace' ? t('{warning}中未出现在这份来源里的 MCP。确认继续？', { warning: replaceWarning }) : '',
      // 送出的是来源标识 + 条目名 + 预览时的内容指纹；路径与凭据都留在 Host 重算。
      () => call('importSource', {
        sourceId: source.sourceId,
        scope: source.scope,
        names: sourceImportNames(source),
        mode,
        contentHash: sourcePreview.contentHash,
        ...scopePayload,
      }),
    );
  };
  const activePreview = sourcePreview?.preview || preview;
  const summary = activePreview ? [
    t('新增：{names}', { names: activePreview.added?.join(', ') || t('无') }),
    t('更新：{names}', { names: activePreview.updated?.join(', ') || t('无') }),
    mode === 'replace' ? t('移除：{names}', { names: activePreview.removed?.join(', ') || t('无') }) : null,
    // 被跳过的同名条目（其他配置层占用、或来源里重名）由 Host 放进 warnings，这里只渲染一处，
    // 免得同一件事既显示"冲突"又显示"提示"。
    ...(activePreview.warnings || []).map((warning) => t('提示：{warning}', { warning })),
  ].filter(Boolean).join('\n') : '';
  // 来源列表已按当前层过滤（Host 侧保证）：全局标签只有全局来源，项目标签只有该项目的来源，
  // 所以行上不需要「（项目）」后缀，也不再需要用户自己判断「这一行会导到哪儿去」。
  const layerLabel = isWorkspace ? t('项目级') : t('全局');
  const layerHint = isWorkspace
    ? t('没检测到这个项目的项目级 MCP 配置（.mcp.json / .codex/config.toml / .pi/mcp.json / opencode.json 等），可在下面手动粘贴')
    : t('没检测到本机客户端的全局 MCP 配置（~/.claude.json / ~/.codex/config.toml / ~/.config/opencode/opencode.json 等），可在下面手动粘贴');
  return h('div', { className: 'dsh-mcp-overlay', onClick: (e) => e.target === e.currentTarget && onClose() },
    h(Dialog, { label: t('导入 MCP'), onClose },
      h('h3', null, t('导入 MCP{scope}', { scope: isWorkspace && scopeName ? t('（{name}）', { name: scopeName }) : '' })),
      h('div', { className: 'dsh-mcp-field dsh-mcp-source-box' },
        h('label', null, t('从本机客户端导入{layer}配置（只读，不修改它们的文件）', { layer: layerLabel })),
        sourcesLoading ? h('div', { className: 'dsh-mcp-source-detail' }, t('正在扫描本机客户端配置…')) : null,
        sourcesError ? h('div', { className: 'dsh-mcp-d-err' }, sourcesError) : null,
        !sourcesLoading && !sourcesError && !sources.length
          ? h('div', { className: 'dsh-mcp-source-detail' }, layerHint)
          : null,
        sources.length ? h('div', { className: 'dsh-mcp-source-list' }, sources.map((row) => {
          const names = sourceImportNames(row);
          const masked = sourceMaskedFields(row);
          const missingEnv = sourceMissingEnv(row);
          const detail = row.error || (names.length ? t('{count} 个 MCP：{names}', { count: names.length, names: names.join(', ') }) : t('没有可导入的 MCP'));
          return h('button', {
            key: row.key,
            type: 'button',
            className: 'dsh-mcp-source-row' + (source?.key === row.key ? ' sel' : ''),
            disabled: busy || !!row.error || !names.length,
            title: row.displayPath,
            onClick: () => pickSource(row),
          },
            h('span', { className: 'dsh-mcp-source-head' },
              h('span', { className: 'dsh-mcp-source-name' }, row.label),
              h('code', { className: 'dsh-mcp-source-path' }, row.displayPath),
            ),
            h('span', { className: 'dsh-mcp-source-detail' }, detail),
            masked.length ? h('span', { className: 'dsh-mcp-source-note' }, t('含需掩码字段：{names}（导入后在详情页可用眼睛查看）', { names: masked.join(t('、')) })) : null,
            missingEnv.length ? h('span', { className: 'dsh-mcp-source-warn' }, t('环境变量未设置：{names}（导入后该处会得到空值）', { names: missingEnv.join(t('、')) })) : null,
            row.warnings?.length ? h('span', { className: 'dsh-mcp-source-warn' }, t('{count} 条提示，导入时逐条列出', { count: row.warnings.length })) : null,
          );
        })) : null,
      ),
      h('div', { className: 'dsh-mcp-field' },
        h('label', null, t('或粘贴 JSON：支持 Claude/Cursor/Cline/Roo 的 mcpServers、VS Code 的 servers，以及单个 MCP 对象')),
        h('textarea', { className: 'dsh-mcp-import-json', value: text, onChange: (e) => { setText(e.target.value); setPreview(null); clearSource(); }, placeholder: '{\n  "mcpServers": {\n    "example": { "command": "npx", "args": ["-y", "example-mcp"] }\n  }\n}' }),
      ),
      h('div', { className: 'dsh-mcp-radio-row' },
        h('label', { className: mode === 'merge' ? 'sel' : '' }, h('input', { type: 'radio', checked: mode === 'merge', onChange: () => { setMode('merge'); setPreview(null); } }), t('合并（同名更新）')),
        h('label', { className: mode === 'replace' ? 'sel' : '' }, h('input', { type: 'radio', checked: mode === 'replace', onChange: () => { setMode('replace'); setPreview(null); } }), isWorkspace ? t('替换该项目') : t('替换当前 Profile')),
      ),
      summary ? h('div', { className: 'dsh-mcp-card dsh-mcp-import-preview' }, summary) : null,
      error ? h('div', { className: 'dsh-mcp-d-err' }, error) : null,
      h('div', { className: 'dsh-mcp-modal-actions' },
        h(Btn, { onClick: onClose, children: t('取消') }),
        source ? h(Btn, { onClick: () => { clearSource(); setError(''); }, disabled: busy, children: t('取消选择来源') }) : null,
        source
          ? h(Btn, { cls: 'primary', onClick: applySourceImport, disabled: busy || !sourcePreview, children: busy ? t('导入中…') : t('确认从来源导入') })
          : h(Btn, { onClick: runPreview, disabled: busy || !text.trim(), children: busy ? t('解析中…') : t('预览') }),
        source ? null : h(Btn, { cls: 'primary', onClick: applyImport, disabled: busy || !text.trim(), children: preview ? t('确认导入') : t('解析并预览') }),
      ),
    ),
  );
};

// ── 导出项目配置 ─────────────────────────────────────────────────────────
// 只读快照，写入目标不在这里发生：拿到 JSON 的用户可以自己决定放进哪个工作区、或备份起来。
// 与「复制到…」的分工：这个功能把配置**给你**（可跨机器、可分享、可存档），凭据因此会经过浏览器；
// 同机搬运不需要这一点，用复制即可（那条路凭据不出 Host）。
const WorkspaceExportModal = ({ open, onClose, call, scope, scopeName }) => {
  const [state, setState] = useState({ phase: 'loading' });
  const [note, setNote] = useState('');
  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setState({ phase: 'loading' });
    setNote('');
    (async () => {
      try {
        const res = await call('exportWorkspaceJson', { wsPath: scope });
        if (cancelled) return;
        if (!res?.ok) throw new Error(res?.error || t('导出失败'));
        setState({ phase: 'ready', data: res });
      } catch (e) {
        if (!cancelled) setState({ phase: 'error', error: String(e?.message || e) });
      }
    })();
    return () => { cancelled = true; };
  }, [open, call, scope]);
  if (!open) return null;
  const data = state.phase === 'ready' ? state.data : null;
  // excluded 可能缺席（HMR 期间新旧代次短暂重叠）：只读它自己的字段，不让一次 undefined
  // 把整个面板打崩——面板崩了用户连重载都点不到。
  const excluded = data && Array.isArray(data.excluded) ? data.excluded : [];
  const json = data ? data.json : '';
  const download = () => {
    const filename = exportFileName(data.name);
    try {
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      setNote(t('已开始下载 {filename}', { filename }));
    } catch (e) {
      setNote(t('下载失败：{error}（可改用「复制 JSON」）', { error: String(e?.message || e) }));
    }
  };
  return h('div', { className: 'dsh-mcp-overlay', onClick: (e) => e.target === e.currentTarget && onClose() },
    h(Dialog, { label: t('导出项目 MCP'), onClose },
      h('h3', null, t('导出项目 MCP{scope}', { scope: scope !== 'global' && scopeName ? t('（{name}）', { name: scopeName }) : '' })),
      state.phase === 'loading' ? h('div', { className: 'dsh-mcp-source-detail' }, t('正在读取项目配置…')) : null,
      state.phase === 'error' ? h('div', { className: 'dsh-mcp-d-err' }, state.error) : null,
      data ? h(React2.Fragment, null,
        h('div', { className: 'dsh-mcp-field' },
          h('label', null, t('共 {count} 个 MCP{suffix}', { count: data.count, suffix: excluded.length ? t('，含 exclude（{names}）', { names: excluded.join(t('、')) }) : '' })),
          h('textarea', { className: 'dsh-mcp-import-json', readOnly: true, value: json, onFocus: (e) => e.target.select() }),
        ),
        h('div', { className: 'dsh-mcp-log warn' }, t('这是完整配置：字面写死的凭据（URL 里的 token、字面 header / env 值）会原样出现在这里，请按密钥对待。用 ${VAR} 引用的位置保持引用写法，不会被解析成明文。')),
        h('div', { className: 'dsh-mcp-source-detail' }, t('格式与 .dsh/mcp.json 一致：可以直接放进目标工作区的 .dsh/mcp.json，或用「导入 MCP」粘贴回来（粘贴只读取 mcpServers，exclude 需要手动设）。')),
      ) : null,
      note ? h('div', { className: 'dsh-mcp-source-detail' }, note) : null,
      h('div', { className: 'dsh-mcp-modal-actions' },
        h(Btn, { onClick: onClose, children: t('关闭') }),
        data ? h(Btn, { onClick: () => copyText(json).then((ok) => setNote(ok ? t('已复制 JSON 到剪贴板') : t('复制失败，请手动全选复制'))), children: t('复制 JSON') }) : null,
        data ? h(Btn, { cls: 'primary', onClick: download, children: t('下载文件') }) : null,
      ),
    ),
  );
};

