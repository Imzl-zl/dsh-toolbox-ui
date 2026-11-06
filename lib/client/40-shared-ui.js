const MAX_TIMER_DELAY_MS = 2147483647;
const REDACTED_VALUE = '__DSH_MCP_REDACTED__';
/**
 * 表单里表示「这个字段没改，沿用原值」的**哨兵字符串**。
 *
 * ⚠️ 它**必须是中文原文、且与语言无关**，不能写成 t(...)：
 *   · 它是**数据**不是文案——`row.v === PRESERVED_VALUE_LABEL` 这类 `===` 判据有五处，
 *     `fromFormValue` 还靠它把值还原成 REDACTED_VALUE 再送回宿主；
 *   · 模块级 t() 又会在 apply() 拿到 locale 之前求值，把哨兵锁死成加载时的语言；
 *   · 一旦哨兵随语言变化，用户在英文界面下编辑一次表单，`===` 就不再成立——
 *     原本「保留原值」的字段会被当成用户**手输的字面量**写进配置，
 *     等于把凭据位置的占位符固化成真实配置（静默的数据损坏）。
 * 所以哨兵恒为中文，**显示**时才按语言换（见 PRESERVED_VIEW 与 toFormValue 的渲染侧）。
 */
const PRESERVED_VALUE_LABEL = '••••••（保留原值）';
/** 哨兵在输入框里的**显示**形态：按当前语言给，但绝不参与比较。 */
const preservedView = () => t(PRESERVED_VALUE_LABEL);
/**
 * 这个值是不是「保留原值」哨兵？**两种形态都算**：原文（来自宿主/初始 state）与
 * 当前语言的显示形态（用户在英文界面里碰过该字段后回写的）。
 * 判据统一走这里，别在别处直接 `=== PRESERVED_VALUE_LABEL`——那样英文界面下会漏判。
 */
const isPreservedValue = (value) => value === PRESERVED_VALUE_LABEL || value === preservedView();
const MASKED_VALUE = '••••••';
const toFormValue = (value) => value === REDACTED_VALUE ? PRESERVED_VALUE_LABEL : String(value || '');
/**
 * 表单值 → 送往宿主的取值：哨兵还原成 REDACTED_VALUE（表示「沿用原值」）。
 *
 * ⚠️ 必须同时认**哨兵原文**和它的**当前语言显示形态**：输入框显示的是 preservedView()，
 * 而用户一旦改动该字段，onChange 把「显示出来的那串」写回 state——英文界面下回写的
 * 就是英文标签。只认中文原文的话，那种回写会被当成用户手输的字面量写进配置。
 * 这里两种都还原成 REDACTED_VALUE（用户没改内容、只是碰了一下字段时，语义仍是"保留原值"）。
 */
const fromFormValue = (value) => (isPreservedValue(value) ? REDACTED_VALUE : value);
const displayValue = (value) => value === REDACTED_VALUE ? MASKED_VALUE : value;
function setOwn(target, key, value) {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
}

const Toggle = ({ on, disabled, onChange, title, label }) =>
  h('button', {
    type: 'button',
    role: 'switch',
    className: 'dsh-mcp-toggle',
    disabled,
    title,
    // 状态只走 aria-checked，不另设 class —— 与官方 ui-primitives/Switch 同一形状
    // （Switch.module.css 开头的注释：外观键于 aria-checked 而非并行 class，视觉状态
    // 就不会与辅助技术读到的状态不一致）。CSS 侧读 [aria-checked='true']。
    'aria-checked': on,
    'aria-label': label,
    onClick: (e) => { e.stopPropagation(); if (onChange) onChange(!on); },
  });

const Dot = ({ phase }) => {
  const cls = phase === 'connected' ? 'connected' : phase === 'failed' ? 'failed' : phase === 'loading' || phase === 'waiting' ? 'loading' : '';
  return h('span', { className: 'dsh-mcp-dot ' + cls });
};

const Badge = ({ cls, title, children }) => h('span', { className: 'dsh-mcp-badge ' + (cls || ''), title }, children);

/**
 * 折叠指示器。全面板只有这一种：向下的 chevron，收起时转 -90°（指向右）。
 *
 * 曾经是三套写法——列表里的向下/向右三角**字符**、组头的常驻三角加 CSS 旋转、
 * 诊断组头的感叹号。同一个「能不能展开」在三处长得不一样，用户读不出哪一处可点。
 * 现在统一成一个图标 + 一个 `open` 布尔，旋转也只剩 .dsh-mcp-caret.closed 一条规则。
 *
 * 图标而不是字符：三角字符的基线、字号、字体回退各平台都不同（它是 U+25BE，
 * 命中不到任何字体约定），换台机器就换一副样子。
 */
const Caret = ({ open, cls }) => h('span', { className: 'dsh-mcp-caret' + (cls ? ' ' + cls : '') + (open ? '' : ' closed'), 'aria-hidden': true }, h(Icon, { d: ICONS.chev, size: 12 }));

/**
 * 通知条：面板里所有「非阻断、但你需要知道」的一句话都走这一张卡。
 *
 * 为什么统一：原先有四种写法各画一遍——更新条用 .dsh-mcp-upd（自己的边框色与按钮），
 * 让位提示用 .dsh-skills-banner，挂载/作用域失败用 .dsh-mcp-log（红/黄左边框块），
 * 降级提示还不存在。「同一件事长什么样」因此取决于它是谁写的。
 *
 * tone 只有四档，各自对应一个语义令牌：中性（无 tone，读配置失败之类的事实陈述）、
 * warn、err、info。图标按语义给（不是按 tone 给）——「更新」用 info 色调但配 up 图标。
 *
 * role='status'：warn/err 是异步出现的结果，读屏需要被念出来；info 不需要打断。
 */
const Notice = ({ tone, icon, title, children, actions }) => h('div', {
  className: 'dsh-mcp-notice' + (tone ? ' ' + tone : ''),
  role: tone === 'warn' || tone === 'err' ? 'status' : undefined,
},
  h(Icon, { d: ICONS[icon || 'info'], size: 18 }),
  h('div', { className: 'dsh-mcp-notice-body' },
    h('b', null, title),
    children ? h('span', null, children) : null,
  ),
  actions && actions.length ? h('div', { className: 'dsh-mcp-notice-actions' }, ...actions) : null,
);

const Icon = ({ d, size }) =>
  h('svg', { width: size || 13, height: size || 13, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }, h('path', { d }));

/**
 * 图标表。**全部路径都画在 `Icon` 的 16×16 viewBox 坐标系里**（Icon 的 viewBox 是
 * '0 0 16 16'，不做缩放），所以坐标一旦超出 0–16 就被 viewBox 裁掉、图标整个不可见。
 *
 * 曾经 edit / eye / eyeOff / copy 四条是照 24 单位的网格写的（edit 的 y 一直到 20），
 * 在 16 的盒子里等于画到框外——「编辑」按钮上那个图标一直是空的，而没有任何测试会红。
 * 统一到 16 网格是这条表的不变量：新增图标请照 16 画。
 */
const ICONS = {
  search: 'M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM13.5 13.5L11 11',
  plus: 'M8 3v10M3 8h10',
  refresh: 'M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3',
  trash: 'M3 4h10M6.5 4V2.8a.8.8 0 0 1 .8-.8h1.4a.8.8 0 0 1 .8.8V4M4.5 4l.6 9a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-9M6.7 7v4.5M9.3 7v4.5',
  plug: 'M6 2v4M10 2v4M4.5 6h7V8a3.5 3.5 0 0 1-7 0zM8 11.5V14',
  // 面板图标：四格网格，比插头更贴近「管理面板」语义。
  panel: 'M2.5 2.5h4.3v4.3H2.5zM9.2 2.5h4.3v4.3H9.2zM2.5 9.2h4.3v4.3H2.5zM9.2 9.2h4.3v4.3H9.2z',
  x: 'M4 4l8 8M12 4l-8 8',
  edit: 'M11.6 2.4l2 2L6 12l-2.6.6L4 10zM10.2 3.8l2 2',
  eye: 'M1.2 8S3.6 4.2 8 4.2 14.8 8 14.8 8 12.4 11.8 8 11.8 1.2 8 1.2 8zM8 6.2a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6z',
  eyeOff: 'M2 2l12 12M6.2 4.5A6.6 6.6 0 0 1 8 4.2c4.4 0 6.8 3.8 6.8 3.8a9.4 9.4 0 0 1-1.9 2.4M9.8 11.5a6.6 6.6 0 0 1-1.8.3C3.6 11.8 1.2 8 1.2 8a9.6 9.6 0 0 1 1.9-2.4',
  copy: 'M5.5 5.5h6.2v6.2H5.5zM3 10.2V4.3h6',
  entry: 'M2.5 3.5h11v9h-11zM2.5 6.5h11M6.5 6.5v6',
  more: 'M3.2 8h.01M8 8h.01M12.8 8h.01',
  sort: 'M4.5 13V3.2M4.5 13L2.5 11M4.5 13l2-2M11.5 3v9.8M11.5 3l-2 2M11.5 3l2 2',
  check: 'M3 8.4l3.4 3.4L13 4.6',
  warn: 'M8 2.2l6 11.6H2zM8 6.4v3.4M8 11.6h.01',
  info: 'M8 1.6a6.4 6.4 0 1 0 0 12.8A6.4 6.4 0 0 0 8 1.6zM8 7.4v4M8 5.1h.01',
  shield: 'M8 1.8l5.2 2v4.3c0 3.3-2.2 5.4-5.2 6.1-3-.7-5.2-2.8-5.2-6.1V3.8z',
  up: 'M8 13.2V3M4.2 6.8L8 3l3.8 3.8',
  play: 'M5 3.2l7.6 4.8L5 12.8z',
  pause: 'M6 3.2v9.6M10 3.2v9.6',
  chev: 'M4.2 6.2L8 10l3.8-3.8',
  box: 'M8 1.6l5.4 2.9v6.2L8 13.6l-5.4-2.9V4.5zM2.6 4.5L8 7.4l5.4-2.9M8 7.4v6.2',
  // 闪电 = 按需加载（延迟）：工具不常驻，需要时才取。用于「全部延迟」主按钮。
  zap: 'M9 1.6L3.6 9.4h3.5L6.4 14.4l5.6-8H8.4z',
};

// ── 常用 MCP 预设模板（主流管理器常见的“浏览即添加”能力）────────────
// 预设只填充表单，不直接写入；命令依赖本机 npx / uvx，保存前请确认可用。
// ⚠️ 表里存**中文原文**（= EN_DICT 的键），翻译发生在渲染点（t(p.label)）：
// 在这里写 t() 会把语言冻在 bundle 加载那一刻，英文界面下整个下拉仍是中文。
const MCP_PRESETS = [
  { id: 'filesystem', serverName: 'filesystem', label: 'Filesystem · 本地文件读写', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/path/to/allowed/dir'] },
  { id: 'memory', serverName: 'memory', label: 'Memory · 知识图谱记忆', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
  { id: 'sequential-thinking', serverName: 'sequential-thinking', label: 'Sequential Thinking · 分步推理', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] },
  { id: 'time', serverName: 'time', label: 'Time · 时区时间工具（需 uvx）', transport: 'stdio', command: 'uvx', args: ['mcp-server-time'] },
  { id: 'git', serverName: 'git', label: 'Git · 版本控制（需 uvx）', transport: 'stdio', command: 'uvx', args: ['mcp-server-git'] },
];

// ── 工具参数 JSON Schema 的可读化渲染辅助 ────────────────────────────
function clearRevealState(generation, setValues, setBusy) {
  generation.current += 1;
  setValues({});
  setBusy?.('');
}
function consumeRevision(ref, next) {
  if (typeof next !== 'string') return false;
  const changed = ref.current !== '' && next !== ref.current;
  ref.current = next;
  return changed;
}
async function copyText(text) {
  let area;
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof window !== 'undefined' && window.isSecureContext) {
      await navigator.clipboard.writeText(String(text));
      return true;
    }
    area = document.createElement('textarea');
    area.value = String(text);
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    return document.execCommand('copy') === true;
  } catch {
    return false;
  } finally {
    area?.remove();
  }
}
function describeType(node) {
  if (!node || typeof node !== 'object') return 'any';
  if (Array.isArray(node.type)) return node.type.join(' | ');
  if (node.anyOf || node.oneOf) {
    const branches = node.anyOf || node.oneOf || [];
    return branches.map(describeType).filter((value, index, list) => list.indexOf(value) === index).join(' | ');
  }
  if (node.type === 'array') return node.items ? 'array<' + describeType(node.items) + '>' : 'array';
  return typeof node.type === 'string' ? node.type : 'any';
}
function enumText(node) {
  return node && Array.isArray(node.enum) ? node.enum.map((value) => JSON.stringify(value)).join(', ') : '';
}

// 标签页估算宽度：用于溢出折叠（中文按 15px、ASCII 按 8px 粗估，含 padding）。
function estimateTabWidth(label, hasCount) {
  let width = 0;
  for (const ch of label) width += ch.charCodeAt(0) > 255 ? 15 : 8;
  return width + 26 + (hasCount ? 26 : 0);
}
// 与 `.dsh-mcp-tab-pop{min-width:170px}` 同源：锚点夹取要用它算「弹层还能放多左」。
const POPOVER_MIN_WIDTH = 170;

// 作用域标签页：全局固定首位；项目超出宽度时折叠为「…N」弹出层。
const ScopeTabs = ({ tabs, active, onSelect }) => {
  const rootRef = useRef(null);
  const barRef = useRef(null);
  const moreRef = useRef(null);
  const [barWidth, setBarWidth] = useState(0);
  const [moreOpen, setMoreOpen] = useState(false);
  // 弹层要贴着「…N」按钮，而不是贴标签条右边缘：标签条右侧常留有大段空白
  // （估算宽度偏保守，可见标签提前截断），贴右边缘会让弹层离点击处很远。
  const [moreRight, setMoreRight] = useState(0);
  const syncMoreAnchor = useCallback(() => {
    const wrap = rootRef.current;
    const btn = moreRef.current;
    if (!wrap || !btn) return;
    // 对齐到按钮右边缘；但窄屏上按钮可能很靠左，若右对齐会让 170px 的弹层从左边溢出，
    // 因此夹取到「弹层仍能完整落在标签条内」的范围（170 与 CSS 的 min-width 一致）。
    const gap = Math.round(wrap.getBoundingClientRect().right - btn.getBoundingClientRect().right);
    const maxRight = Math.max(0, Math.round(wrap.clientWidth) - POPOVER_MIN_WIDTH);
    setMoreRight(Math.min(Math.max(0, gap), maxRight));
  }, []);
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    if (typeof ResizeObserver === 'undefined') { setBarWidth(el.clientWidth); return; }
    const update = () => setBarWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => { setMoreOpen(false); }, [active]);
  useEffect(() => {
    if (moreOpen) syncMoreAnchor();
  }, [moreOpen, barWidth, tabs, syncMoreAnchor]);
  useEffect(() => {
    if (!moreOpen) return;
    const close = (e) => { if (!rootRef.current || !rootRef.current.contains(e.target)) setMoreOpen(false); };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [moreOpen]);
  const visibleCount = useMemo(() => {
    if (!barWidth || tabs.length === 0) return tabs.length;
    let acc = 0;
    let count = 0;
    for (let i = 0; i < tabs.length; i += 1) {
      const w = estimateTabWidth(tabs[i].label, tabs[i].count !== undefined) + 8;
      if (acc + w > barWidth) break;
      acc += w;
      count += 1;
    }
    if (count >= tabs.length) return tabs.length;
    // 有溢出时至少保留一个 tab，并为「…N」预留宽度。
    const moreWidth = 58;
    while (count > 1 && acc + moreWidth > barWidth) {
      count -= 1;
      acc -= estimateTabWidth(tabs[count].label, tabs[count].count !== undefined) + 8;
    }
    return count;
  }, [tabs, barWidth]);
  const hidden = visibleCount < tabs.length ? tabs.slice(visibleCount) : [];
  const visible = visibleCount < tabs.length ? tabs.slice(0, visibleCount) : tabs;
  // 弹层必须挂在滚动容器之外：.dsh-mcp-tabs 是 overflow-x:auto 的裁剪盒，
  // 放在里面（哪怕 position:absolute）会被整块裁掉，标签一多就再也点不到隐藏项目。
  // `right` 由 moreRight 给到「…N」按钮的右边缘，弹层因此贴住触发它的按钮。
  const popover = moreOpen && hidden.length
    ? h('div', { className: 'dsh-mcp-tab-pop', style: { right: moreRight + 'px' }, onClick: (e) => e.stopPropagation() },
        hidden.map((tab) =>
          h('div', { key: tab.key, role: 'tab', 'aria-selected': active === tab.key, className: 'dsh-mcp-tab' + (active === tab.key ? ' sel' : ''), onClick: () => { setMoreOpen(false); onSelect(tab.key); }, title: tab.title || tab.label },
            tab.label,
            tab.count !== undefined ? h('span', { className: 'dsh-mcp-tab-count' }, tab.count) : null,
          ),
        ),
      )
    : null;
  return h('div', { className: 'dsh-mcp-tabs-wrap', ref: rootRef },
    h('div', { className: 'dsh-mcp-tabs', ref: barRef },
      visible.map((tab) =>
        h('div', { key: tab.key, role: 'tab', 'aria-selected': active === tab.key, className: 'dsh-mcp-tab' + (active === tab.key ? ' sel' : ''), onClick: () => onSelect(tab.key), title: tab.title || tab.label },
          tab.label,
          tab.count !== undefined ? h('span', { className: 'dsh-mcp-tab-count' }, tab.count) : null,
        ),
      ),
      hidden.length ? h('div', { key: '__more__', ref: moreRef, role: 'tab', 'aria-expanded': moreOpen, className: 'dsh-mcp-tab more' + (moreOpen ? ' open' : ''), onClick: (e) => { e.stopPropagation(); syncMoreAnchor(); setMoreOpen((value) => !value); } }, h('b', null, '…'), hidden.length) : null,
    ),
    popover,
  );
};
function flattenParameters(schema) {
  if (!schema || typeof schema !== 'object') return { required: [], properties: [] };
  const required = Array.isArray(schema.required) ? schema.required : [];
  const props = schema.properties;
  if (!props || typeof props !== 'object') return { required, properties: [] };
  const requiredSet = new Set(required);
  const properties = Object.keys(props).map((name) => {
    const node = props[name] && typeof props[name] === 'object' ? props[name] : {};
    return {
      name,
      type: describeType(node),
      description: node.description || '',
      required: requiredSet.has(name),
      hasDefault: Object.prototype.hasOwnProperty.call(node, 'default'),
      default: node.default,
      enumText: enumText(node),
    };
  });
  return { required, properties };
}
const ToolRow = ({ tool }) => {
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState(false);
  const hasSchema = !!tool.parameters && typeof tool.parameters === 'object';
  const { properties } = hasSchema ? flattenParameters(tool.parameters) : { properties: [] };
  const toggle = () => setOpen((value) => !value);
  const headProps = hasSchema ? {
    className: 'dsh-mcp-tool-head interactive',
    role: 'button',
    tabIndex: 0,
    'aria-expanded': open,
    title: open ? t('收起参数') : t('查看参数'),
    onClick: toggle,
    onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } },
  } : { className: 'dsh-mcp-tool-head' };
  return h('div', { className: 'dsh-mcp-tool' },
    h('div', headProps,
      h('span', { className: 'dsh-mcp-tool-name', title: tool.name }, tool.name),
      h('span', { className: 'dsh-mcp-tool-desc', title: tool.description }, tool.description || ''),
      hasSchema ? h(Caret, { open }) : null,
    ),
    open && hasSchema ? h('div', { className: 'dsh-mcp-tool-body' },
      properties.length ? h('div', { className: 'dsh-mcp-params' },
        properties.map((p) => h('div', { key: p.name, className: 'dsh-mcp-param' },
          h('div', { className: 'dsh-mcp-param-head' },
            h('code', { className: 'dsh-mcp-param-name' }, p.name),
            p.required ? h('span', { className: 'dsh-mcp-req' }, t('必填')) : h('span', { className: 'dsh-mcp-opt' }, t('可选')),
            h('span', { className: 'dsh-mcp-param-type' }, p.type),
          ),
          p.description ? h('div', { className: 'dsh-mcp-param-desc' }, p.description) : null,
          p.enumText ? h('div', { className: 'dsh-mcp-param-enum' }, t('可选值：{values}', { values: p.enumText })) : null,
          p.hasDefault ? h('div', { className: 'dsh-mcp-param-enum' }, t('默认值：{value}', { value: JSON.stringify(p.default) })) : null,
        )),
      ) : null,
      h('button', { type: 'button', className: 'dsh-mcp-tool-rawbtn', onClick: () => setRaw((value) => !value) }, raw ? t('收起原始 JSON') : t('查看原始 JSON')),
      raw ? h('pre', { className: 'dsh-mcp-json' }, JSON.stringify(tool.parameters, null, 2)) : null,
    ) : null,
  );
};

const Btn = ({ cls, icon, onClick, disabled, title, children }) =>
  h('button', { type: 'button', className: 'dsh-mcp-btn' + (cls ? ' ' + cls : ''), onClick, disabled, title }, icon ? h(Icon, { d: ICONS[icon] }) : null, children);

/**
 * 下拉菜单：详情操作栏的「⋯ 更多」、以及列表底栏的排序都用它。
 *
 * ⚠️ 必须是**组件**（唯一带 hooks 的那一层）。ServerDetail / SkillDetail 是纯函数——
 * 测试直接以普通函数调用它们，函数体里放 useState 会抛 "Invalid hook call"。所以开合状态
 * 封在这里，详情那两个函数只负责把 items 摆好。
 *
 * 行用原生 <button>，状态走 aria-pressed（与面板里那个眼睛开关、入口菜单同一惯用法）：
 * role=menuitemradio 要配一整套方向键 / Home / Esc / roving tabindex 的键盘行为，
 * 不实现就等于这个菜单对键盘用户不存在，还多了一句假声明。
 */
const DropMenu = ({ label, icon, iconOnly, title, items, disabled, cls }) => {
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (!boxRef.current || !boxRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [open]);
  // 菜单内容变了（换了一台服务器、换了一个作用域）就收起来：留着上一次的条目会点错东西。
  const signature = (items || []).map((item) => item.key).join('|');
  useEffect(() => { setOpen(false); }, [signature]);
  const rows = (items || []).filter(Boolean);
  return h('div', { className: 'dsh-mcp-dd' + (cls ? ' ' + cls : ''), ref: boxRef },
    h(Btn, {
      cls: (iconOnly ? 'icon ' : '') + (open ? 'sel' : ''),
      icon,
      disabled,
      title: title || label,
      onClick: (e) => { e.stopPropagation(); setOpen((value) => !value); },
      children: iconOnly ? null : label,
    }),
    open && rows.length
      ? h('div', { className: 'dsh-mcp-dd-pop', role: 'group', 'aria-label': title || label },
        rows.map((item) => (item.separator
          ? h('div', { key: item.key, className: 'dsh-mcp-dd-sep' })
          : h(Btn, {
            key: item.key,
            icon: item.icon,
            cls: (item.danger ? 'danger' : '') + (item.on ? ' sel' : ''),
            disabled: item.disabled,
            title: item.title,
            onClick: () => { setOpen(false); item.onSelect(); },
            children: item.label,
          }))),
      )
      : null,
  );
};

/**
 * 列表底栏：统计文本 + 排序/刷新图标组。
 *
 * 原型的「批量」缺一个 RPC（多选启停要 Host 支持一次改多条），所以那一版**不做**——
 * 与其画一个点了没反应的按钮，不如让它缺席。这个判断至今成立：**多选仍然没有做**。
 *
 * 这里曾经还有一个 `action` 槽位，docstring 写着它是给「全部延迟」用的。实际它从来只有一个
 * 真渲染处：列表的过滤器行（ServerList 的 toolbarAction，第一屏可见），两个 ListFooter
 * 调用点都不传 action——于是槽位与它的四条 CSS 全是死代码，而 docstring 还在指示下一个
 * 人往底栏加第二个入口（与「唯一入口在过滤器行」自相矛盾）。已删。
 */
const ListFooter = ({ text, sortKey, onSort, onRefresh, refreshing, sortTitle }) => h('div', { className: 'dsh-mcp-side-foot' },
  h('span', { className: 'dsh-mcp-foot-text' }, text),
  h('span', { className: 'dsh-mcp-foot-spacer' }),
  onSort ? h(DropMenu, {
    icon: 'sort',
    iconOnly: true,
    cls: 'dsh-mcp-foot-dd',
    title: (sortTitle || t('排序')) + t('：') + t(SORT_LABELS[sortKey || 'default']),
    items: SORT_KEYS.map((key) => ({
      key,
      label: t(SORT_LABELS[key]),
      on: (sortKey || 'default') === key,
      onSelect: () => onSort(key),
    })),
  }) : null,
  h('button', {
    type: 'button',
    className: 'dsh-mcp-foot-btn',
    'aria-label': t('刷新列表'),
    title: t('刷新'),
    disabled: !!refreshing,
    onClick: onRefresh,
  }, h(Icon, { d: ICONS.refresh })),
);

/**
 * 详情头部的操作栏槽位：**[主行为] + [次要行为] + [⋯ 更多]**。
 *
 * 为什么是槽位而不是「把按钮排一排」：头部是一行，按钮一多它就开始换行、把标题挤扁
 * （MCP 面曾经 6 个按钮，窄屏下两行起步）。定死位置之后，新增的动作有唯一去处——⋯，
 * 于是「加功能」不再等于「头部变高」。
 *
 * 普通函数而不是组件：调用方 ServerDetail / SkillDetail 必须是纯函数（测试直接调用），
 * 里面放不下 hooks。⋯ 的开合状态封在 DropMenu 里。
 */
const actionBar = ({ primary, secondary, more }) => h('div', { className: 'dsh-mcp-d-actions' },
  primary || null,
  secondary || null,
  more && more.length ? h(DropMenu, { icon: 'more', iconOnly: true, cls: 'dsh-mcp-d-more', title: t('更多操作'), items: more }) : null,
);

// 面板里所有 .dsh-mcp-modal 对话框的唯一外壳——**只渲染弹层本体**，遮罩留在调用点（有两个对话框
// 在忙碌时整块不可关闭，那是各调用点自己的可见性语义；遮罩多套一层就会嵌套出两个 overlay）。
// 存在的理由是**一条实测过的故障**：焦点不吸进对话框，按一次 Esc 会冒泡到面板自己的 Esc 处理器，
// 把面板和对话框一起关掉（侧栏入口形态下则是按了没反应）。以前这条规矩靠五个调用点各写一遍五行
// prop 来维持，于是它只可能被下一个忘了写的人破坏——焦点契约因此放在这里：调用点无从遗漏，
// 也没有第二份要同步的实现（`test/package-contract.test.mjs` 数着渲染站点）。
// 面板本体（dsh-mcp-panel）与「更新内容」卡片走的是各自的焦点策略（panelRef / boxRef + 文档级
// keydown），刻意不套这一层：它们的关闭语义与弹窗不同。
// onClose 传 null 表示这一刻不可关闭（例如市场正在安装），Escape 不生效——与旧行为一致。
const Dialog = ({ label, cls, onClose, children }) => {
  const dialogRef = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    dialogRef.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  const nodes = (Array.isArray(children) ? children.flat(Infinity) : [children]).filter((node) => node != null && node !== false);
  const heading = nodes[0]?.type === 'h3' ? nodes.shift() : h('h3', null, label);
  const actions = nodes.at(-1)?.props?.className === 'dsh-mcp-modal-actions' ? nodes.pop() : null;
  return h('div', {
    ref: dialogRef, className: 'dsh-mcp-modal' + (cls ? ' ' + cls : ''), role: 'dialog', 'aria-modal': true, 'aria-label': label, tabIndex: -1,
    onKeyDown: (e) => {
      if (e.key === 'Escape' && onClose) { e.stopPropagation(); onClose(); return; }
      if (e.key !== 'Tab') return;
      const items = Array.from(dialogRef.current?.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]') || [])
        .filter((node) => node.getClientRects().length > 0);
      if (!items.length) { e.preventDefault(); return; }
      const first = items[0], last = items.at(-1);
      if (e.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    },
  },
    h('div', { className: 'dsh-mcp-modal-head' }, heading,
      h(Btn, { cls: 'icon ghost', title: t('关闭'), onClick: onClose }, h(Icon, { d: ICONS.x }))),
    h('div', { className: 'dsh-mcp-modal-body' }, ...nodes),
    actions,
  );
};

// 服务器列表。embedded=true 时作为项目 tab 的分区内容渲染：去掉自身卡片外框，
// 并在条目较少时隐藏搜索/过滤（否则控件会挤占本就有限的列表高度）。
const CONTROLS_THRESHOLD = 6;
// 项目行的两个事实判定与文案：**放在模块作用域**，因为它是纯函数 —— 抽出来才能被真正测到
// （组件内部的闭包在 node 里跑不起来，只能靠钉源码文本，那种测试证明不了文案对不对）。
//   link  —— 这条连接在不在（"没人用"不等于"没连上"：连接按空闲策略保留）；
//   scope —— 投射范围（几个会话正在用它）。
// 旧文案把两者压成一句「待会话挂载」，读起来像"还没连上/排队中"，而事实是"连接在、只是当前没会话用"。
const mountFailed = (s) => s.mountFailed === true;
// 作用域故障是第三类失败：连接可能完全正常，但工具不在共享作用域层（两个 dsh-scope 模块实例）。
// Host 已在行上标好 scopeFailed 与具体原因，这里只负责不要把它显示成「连接失败」。
const scopeFailed = (s) => s.scopeFailed === true;
const wsSub = (s) => {
  if (mountFailed(s)) return t('挂载失败');
  if (scopeFailed(s)) return t('作用域隔离失败');
  if (s.status === 'disabled') return t('已禁用');
  if (s.status === 'unknown') return t('状态未知');
  if (s.status === 'loading') return t('连接中…');
  if (s.status === 'failed') return t('连接失败');
  if (s.status !== 'connected') return t('尚未建立连接（新会话自动挂载）');
  const refs = typeof s.refs === 'number' ? s.refs : 0;
  // 工具数后缀是**整句的一部分**，拼进同一条键里：中文说「…会话在用 · 3 工具」，
  // 英文说「…session(s) · 3 tool(s)」——把碎片分两处拼会把语序写死在代码里。
  const tools = typeof s.toolCount === 'number' ? t(' · {count} 工具', { count: s.toolCount }) : '';
  return refs > 0
    ? t('已连接 · {refs} 个会话在用{tools}', { refs, tools })
    : t('已连接 · 当前无会话使用（连接保留，下次直接用）{tools}', { tools });
};

// 跨工作区复制的目标候选 = 除当前工作区之外的所有已注册工作区。抽成纯函数是为了能脱离 React
// 断言（面板组件在 node 里渲染不起来：测试替身的 hooks 是空实现，见 client-entry.test.mjs），
// 也为了让「不会把自己列为目标」这条不变量只写一遍。
const copyTargets = (workspaces, from) => (workspaces || []).filter((ws) => ws && ws.path && ws.path !== from);
// 两条失败横幅（挂载失败、工具无法隔离）共用的那句话：把**第一条原因**摆到横幅上。只列
// serverName 等于把真因留在每行详情里等用户自己找，而用户拿着横幅去提问时最需要的恰恰是它；
// 同一条事实（Host 记的 error 文本）只在这里成形，两处横幅都读它。
const firstFailureReason = (entry) => String(entry?.error ?? '').trim() || t('（宿主没有给出原因）');
// 预览文案：把「这次会新增 / 覆盖 / 跳过什么」逐条说清。抽成纯函数是为了能在 node 里直接断言
// ——组件在测试环境只跑首帧，异步预览那段逻辑靠它才测得到。
const copyPlanText = (plan) => {
  const lines = [t('目标工作区当前有 {count} 个 MCP', { count: plan.targetCount })];
  if (plan.added.length) lines.push(t('新增：{names}', { names: plan.added.join(t('、')) }));
  if (plan.updated.length) lines.push(t('覆盖同名：{names}', { names: plan.updated.join(t('、')) }));
  if (plan.skipped.length) lines.push(t('跳过同名（保留目标原配置）：{names}', { names: plan.skipped.join(t('、')) }));
  if (!plan.added.length && !plan.updated.length && !plan.skipped.length) lines.push(t('没有要写入的条目'));
  return lines.join('\n');
};
// 预览只对"算出它的那份输入"负责。把输入压成一个可比较的键，界面据此判断手上这份计划还是不是
// 当前选择的结论——抽成纯函数是为了能在 node 里断言（同 copyTargets/copyPlanText）。没有目标时
// 返回空串：那种状态下不存在"当前计划"。
const copyPlanKey = ({ from, to, names, overwrite } = {}) => (to
  ? JSON.stringify({ from: from || '', to, names: names || [], overwrite: overwrite === true })
  : '');
// 确认按钮的准入条件：当前选择必须已有一份**成功**的计划。少了这条，用户就能在"新预览还在路上"
// 的窗口里按旧结论落一份新结果——"预览说跳过、实际却覆盖"正是这么发生的（Host 侧那份同源不变量
// 拦不住客户端的这个时间差）。这条不变量只用这一个表达式表达，别在别处再判一次。
const copyPlanReady = (key, preview) => Boolean(key) && preview?.key === key && Boolean(preview?.plan);
// 兜底文件名与 .dsh/mcp.json 同名，用户拿到就能直接放进目标工作区。
const exportFileName = (name) => String(name || 'workspace').replace(/[\\/:*?"<>|\s]+/g, '-') + '-mcp.json';

