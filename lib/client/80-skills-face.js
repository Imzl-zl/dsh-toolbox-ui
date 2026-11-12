// ── 技能能力面：管理（左列表 + 右详情）与市场（卡片网格）──────────────────
// 复用既有原子（Toggle / Badge / Btn / Icon / 空状态 / toast），不另造一套。

const SkillsEmpty = ({ text }) => h('div', { className: 'dsh-skills-empty' }, text);

/**
 * 让位提示（D15）：检测到**另一个** MCP 管理插件时，本插件不注册入口，只说明情况。
 *
 * 为什么是「让位」而不是「两个都装」：两个 MCP 管理面板同时在场时，它们的悬浮按钮、
 * 侧栏入口会互相遮挡，且都写同一份 profile 配置——用户看到的是两个都在、却不知该信哪个。
 * 所以后装的那个主动退出，只留一条可关闭的说明。
 *
 * 反过来「检测失败必须 fail-open」（SPEC 约束 10）：漏检最坏是两个入口并存（可自愈），
 * 误判则用户**完全打不开面板**——代价不对称，所以拿不准时照常注册（见 apply 的判定）。
 *
 * ⚠️ 它渲染在**面板之外**（入口被占的位置），所以走通知条原语时要自带定位：
 * .dsh-mcp-notice-dock 就是为这个场景加的，别在别处复用。
 */
const HandoverNotice = ({ conflict }) => h(
  'div',
  { className: 'dsh-mcp-notice warn dsh-mcp-notice-dock', role: 'status' },
  h(Icon, { d: ICONS.warn, size: 18 }),
  h('div', { className: 'dsh-mcp-notice-body' },
    h('b', null, t('已让位给另一个 MCP 管理插件')),
    h('span', null, t('检测到 {name} 已挂载，本面板不再注册入口，以免两个面板互相遮挡、同时改写同一份配置。', { name: conflict?.name || t('另一个 MCP 管理插件') })),
    h('span', null, t('卸载其中一个后重启 DSH 即可恢复。')),
  ),
);

/**
 * 管理模式的左列表一行。
 *
 * 作用域**不再出现在行内**：它由所在组的组头承载（见 skillGroups）。
 * 之前每行挂一条 `项目 xxx · .agents/skills` 的 badge，在 288px 侧栏里必然被裁断；
 * 分组之后行内腾出的宽度还给技能名，行只说「哪一份」该说的事：调用权限与同名遮蔽。
 */
const SkillRow = ({ row, selected, onSelect, onToggle, busy, shadowedBy, twins }) => h(
  'div',
  {
    // 与 MCP 面同一套行容器（.dsh-mcp-item）：状态点 + 主列 + 右侧开关。
    // 切换能力层时列表的视觉与操作位置因此不再跳动。
    className: 'dsh-mcp-item' + (selected ? ' sel' : '') + (row.enabled === false ? ' muted' : ''),
    role: 'button',
    tabIndex: 0,
    'aria-selected': !!selected,
    onClick: () => onSelect(row),
    onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(row); } },
  },
  // 状态点沿用 MCP 那套语义：停用 = stopped（灰），可用 = connected（绿）。
  // 三态：读不出文件时（enabled === null）用 loading 的灰点——不假装知道它是哪一种。
  h(Dot, { phase: row.enabled === false ? 'stopped' : row.enabled === null ? 'loading' : 'connected' }),
  h('div', { className: 'dsh-mcp-item-main' },
    h('div', { className: 'dsh-mcp-item-name', title: row.name }, row.name),
    h('div', { className: 'dsh-mcp-item-sub' },
      // 作用域由**组头**承载，行内不再重复一条会被裁断的路径（这是分组的直接收益）。
      //
      // ⚠️ 两个调用面**各自**都可能被关掉，所以这里要按面各说一句——只标模型面的话，
      // 「仅模型可调用」（用户面关着）在列表上**看不出任何异常**，用户点进去才会发现
      // 自己没法用 /名字 调用它。顺序有讲究：停用是更强的结论（两个面都关了），先说它，
      // 否则停用的行会被说成「仅用户可调用」——用户会以为手动还能调用它，实际不能。
      row.enabled === false
        ? h(Badge, { cls: 's-off' }, row.migrated ? t('旧机制停用') : t('已停用'))
        : [
          row.modelInvocable === false ? h(Badge, { key: 'no-model', cls: 's-off', title: t('模型不会自动调用它') }, t('模型不用')) : null,
          row.userInvocable === false ? h(Badge, { key: 'no-user', cls: 's-off', title: t('你不能用 /名字 手动调用它') }, t('不可手调')) : null,
        ],
      shadowedBy
        // 被遮蔽时说出**生效的那份在哪**：原先只说「被遮蔽」，用户找不到另一份。
        ? h(Badge, { cls: 's-err', title: t('模型只会收到「{scope}」那一份', { scope: skillScopeLabel(shadowedBy) }) }, t('被遮蔽'))
        : (twins && twins.total > 1
          ? h(Badge, { cls: 's-off', title: t('另有 {names}', { names: twins.others.join(t('、')) }) }, t('同名 {count} 份', { count: twins.total }))
          : null),
    ),
  ),
  onToggle
    ? h(Toggle, {
      on: row.enabled !== false,
      disabled: busy || row.writable === false,
      label: row.name + (row.enabled === false ? t('：已停用') : t('：已启用')),
      title: row.writable === false ? t('内置技能只读') : (row.enabled === false ? t('启用') : t('停用')),
      onChange: () => onToggle(row, row.enabled === false),
    })
    : null,
);

/** 一个作用域组的组头：可折叠，整行显示作用域，右侧计数。 */
const SkillGroupHeader = ({ group, collapsed, onToggleCollapse }) => h(
  'button',
  {
    type: 'button',
    className: 'dsh-skills-group' + (collapsed ? ' collapsed' : ''),
    onClick: () => onToggleCollapse(group.key),
    // 完整根路径放 title：组头一行放不下时（超长项目名），这里是不丢信息的兜底。
    title: group.root ? group.label + ' — ' + group.root : group.label,
    'aria-expanded': !collapsed,
  },
  h(Caret, { open: !collapsed, cls: 'dsh-skills-group-caret' }),
  h('span', { className: 'dsh-skills-group-label' }, group.label),
  h('span', { className: 'dsh-skills-group-count' }, String(group.rows.length)),
);

/**
 * 「调用权限未知」到底是哪种未知——给用户一句**说得对**的原因。
 *
 * 为什么不能一律写成「frontmatter 读不出来」：那是把两种不同的事说成了一种，而且真机报告
 * 证明它会把用户引向错误的方向。技能目录是符号链接时根定位不到（`root === undefined`），
 * 文件本身完全合法、宿主也照常加载，用户却看到「frontmatter 读不出来（宿主会跳过这条技能）」
 * ——一句凭空的断言，照它去查 frontmatter 只会白费功夫。
 *
 * 这里能分开的是两种（行上有 root 与否就是面板掌握的全部线索）：
 *   · 根没定位到 → 面板根本不知道去哪读这个文件（定位问题，不是文件问题）；
 *   · 有根却读不出权限 → 文件没了/搬走了/没权限，或 frontmatter 本身有问题。
 * 第二种没法再细分：读取失败的原因在宿主侧（`invocationOf` 只把结果压成 null），
 * 面板拿不到更细的话，就不编一个——正文页会把真正的失败原文摆出来。
 */
function invocationUnknownReason(row) {
  if (typeof row?.root !== 'string' || row.root === '')
    return t('面板没能定位这条技能的目录（技能目录可能是符号链接），因此读不到它的调用权限——文件本身可能是好的');
  return t('SKILL.md 的 frontmatter 读不出来（宿主会跳过这条技能），无法判断它的调用权限');
}

/** 管理模式的右侧详情：元信息 + 正文 + 启停/删除（与 MCP 面同一张详情卡片）。 */
/**
 * 来源记录 → 一行人话（R14）。
 *
 * 版本可能为空串（上游不一定给）：那时只显示 slug 与页面链接，**不编造一个版本号**。
 * 纯函数是因为它要能真跑：客户端在本仓库跑不了 hook，但字符串拼装可以。
 */
const hubSourceLabel = (hub) => {
  const slug = String(hub?.slug ?? '');
  const version = String(hub?.version ?? '');
  return version ? slug + ' · v' + version : slug;
};

const SkillDetail = ({ row, shadowedBy, body, busy, onRetry, onToggle, onRemove, onModelInvocable, onUserInvocable, tab = 'overview', onTab }) => {
  if (!row) return h('div', { className: 'dsh-mcp-detail' }, h('div', { className: 'dsh-mcp-d-empty' },
    h('b', null, t('选择左侧的一个技能')),
    h('span', null, t('这里会显示它的位置与调用权限、SKILL.md 正文，以及遮蔽或校验失败时的诊断。'))));
  const disabled = row.enabled === false;
  // 三态：true / false / null（读不到文件时不知道两个调用面是否都关掉了）。
  const enabledKnown = row.enabled === true || row.enabled === false;
  const readonly = row.writable === false;
  // 调用权限的**三态**：true / false / 未知。未知是真实的一态——宿主对 frontmatter 非法的技能
  // 整条跳过，那时「能不能被模型调用」没有答案。此前它被渲染成「不可调用」，那是凭空的断言。
  const invocationKnown = row.modelInvocable === true || row.modelInvocable === false;
  const paneOff = (id) => detailPaneOff(tab, id);
  const tabBtn = (id, label, count) => detailTab(tab, onTab, id, label, count);
  // 「（加载中…）」只能出现在**真的在加载**的时候。之前失败也落到这句兜底文案上
  // （`content || t('（加载中…）')`），用户看到的就是「加载半天没反应」——
  // 失败没有终态，等于把错误伪装成等待。
  const bodyPane = body.status === 'loading'
    ? h('pre', { className: 'dsh-skills-pre' }, t('（加载中…）'))
    : body.status === 'error'
      ? h('div', { className: 'dsh-skills-risk' },
        h('div', { className: 'dsh-skills-risk-row' },
          h('span', { className: 'k dsh-skills-blocked' }, t('读取失败')),
          h('span', { className: 'v' }, body.text || t('宿主未返回原因')),
        ),
        h(Btn, { onClick: onRetry, disabled: busy }, t('重试')),
      )
      : h('pre', { className: 'dsh-skills-pre' }, body.text || t('（无正文）'));
  return h(
    'div',
    { className: 'dsh-mcp-detail' },
    // 与 MCP 详情共用同一套头部原语（d-head / d-title / d-name / d-meta / d-actions）：
    // 切换能力层时「名字在哪、状态在哪、按钮在哪」不用重新学一遍，切面也不重排。
    h('div', { className: 'dsh-mcp-d-head' },
      h('div', { className: 'dsh-mcp-d-title' },
        h('div', { className: 'dsh-mcp-d-name' },
          row.name,
          readonly ? h(Badge, { cls: 's-lock' }, t('内置只读')) : null,
        ),
        h('div', { className: 'dsh-mcp-d-meta' },
          h(Badge, { cls: disabled ? 's-off' : shadowedBy ? 's-warn' : 's-on' },
            disabled ? t('已停用') : shadowedBy ? t('被遮蔽') : enabledKnown ? t('已启用') : t('状态未知')),
          invocationKnown
            ? h(Badge, { cls: row.modelInvocable ? null : 's-off' }, row.modelInvocable ? t('模型可调用') : t('模型不可调用'))
            : h(Badge, { cls: 's-off', title: invocationUnknownReason(row) }, t('调用权限未知')),
          invocationKnown && !row.userInvocable ? h(Badge, { cls: 's-off' }, t('用户不可调用')) : null,
          row.migrated ? h(Badge, { cls: 's-warn', title: t('这是旧版启停机制（改名成 .disabled）留下的条目；恢复后请用新的停用方式') }, t('旧机制残留')) : null,
        ),

      ),
      // 与 MCP 面同一套槽位：[主行为] + [次要行为] + [⋯ 更多]。
      // 与列表行那个开关同一动作、同一双向语义：已停用的技能在这里也能启用回来。
      // 技能面暂时没有次要行为可放（打开编辑器 / 复制副本都要新 RPC），所以次槽空着——
      // 空槽是契约的一部分：以后加动作进 ⋯，头部照样不换行。
      actionBar({
        primary: h(Btn, {
          cls: 'primary',
          icon: disabled ? 'play' : 'pause',
          onClick: () => onToggle(row, disabled),
          disabled: busy || readonly,
          title: readonly ? t('内置技能只读') : undefined,
          children: disabled ? t('启用') : t('停用'),
        }),
        more: [
          { key: 'remove', icon: 'trash', label: t('删除技能'), danger: true, disabled: busy || readonly, title: readonly ? t('内置技能只读') : undefined, onSelect: () => onRemove(row) },
        ],
      }),
    ),
    h('div', { className: 'dsh-mcp-tabs', role: 'tablist', 'aria-label': t('详情分区') },
      tabBtn('overview', t('概览')),
      tabBtn('text', t('技能正文')),
      tabBtn('diag', t('诊断'), shadowedBy ? 1 : 0),
    ),
    h('div', { className: 'dsh-mcp-d-body' },
      h('div', { className: 'dsh-mcp-card' + paneOff('overview') },
        row.description ? h('p', { className: 'dsh-mcp-d-description' }, row.description) : null,
        h('h4', null, t('技能属性')),
        h('div', { className: 'dsh-mcp-kv' },
          // 作用域与根目录合成一行：分组之后「哪一级」已由组头说过，这里只补完整路径。
          h('b', null, t('位置')), h('span', null, (row.root || t('（未报告）')) + t('（{name}）', { name: skillScopeLabel(row) })),
          // R14：外部源装进来的技能显示来源与版本；本机导入的没有来源（不显示这一行，
          // 而不是显示"未知"——"没有来源"与"来源读不出来"是两件事）。
          body.hub ? h('b', null, t('来源')) : null,
          body.hub ? h('span', null, hubSourceLabel(body.hub)) : null,
          body.hubError ? h('b', null, t('来源')) : null,
          body.hubError ? h('span', { className: 'dsh-mcp-d-err' }, body.hubError) : null,
          // 「停用」的落点是**文件内容**（frontmatter 的两个调用面字段），不是文件名——
          // 旧机制（改名 .disabled）只在迁移读取时才会出现在状态里，如实标出来。
          h('b', null, t('状态')), h('span', null,
            row.migrated
              ? t('旧机制停用（SKILL.md.disabled）——点「启用」把它改回来')
              : disabled
                ? t('已停用（disable-model-invocation: true + user-invocable: false）')
                : enabledKnown ? t('已启用') : t('未知（读不到这个文件）')),
          // 两个调用面**各自可写**：宿主支持的就是两个面，而「已停用」只是「两个都关」这一种组合。
          // 只给一个面开关的话，用户在面板里拨不回「仅手动可调用」那一档——只能去编辑文件。
          // 写在 SKILL.md 的 frontmatter 里，所以只在可写根上给开关；权限读不出来时不装懂
          // ——开关禁用并写明未知。
          h('b', null, t('模型自动调用')),
          h('span', null,
            h(Toggle, {
              on: row.modelInvocable === true,
              disabled: busy || readonly || !invocationKnown,
              label: t('{name}：允许模型自动调用', { name: row.name }),
              title: readonly
                ? t('内置技能只读')
                : invocationKnown
                  ? t('写入 SKILL.md 的 disable-model-invocation。宿主用文件监听盯技能根，改动约 0.25 秒就生效（实测中位数 246ms），不必重启')
                  : invocationUnknownReason(row),
              onChange: () => onModelInvocable(row, row.modelInvocable !== true),
            }),
            ' ',
            invocationKnown ? (row.modelInvocable ? t('允许') : t('禁止')) : t('未知'),
          ),
          h('b', null, t('用户可调用')),
          h('span', null,
            h(Toggle, {
              on: row.userInvocable === true,
              disabled: busy || readonly || !invocationKnown,
              label: t('{name}：允许用户手动调用', { name: row.name }),
              title: readonly
                ? t('内置技能只读')
                : invocationKnown
                  ? t('写入 SKILL.md 的 user-invocable：关掉后你就不能用 /名字 手动调用它（模型仍可自动调用）。与上面那个一起关掉就是「已停用」')
                  : invocationUnknownReason(row),
              onChange: () => onUserInvocable(row, row.userInvocable !== true),
            }),
            ' ',
            invocationKnown ? (row.userInvocable ? t('允许') : t('禁止')) : t('未知'),
          ),
        ),
      ),
      h('div', { className: 'dsh-mcp-card' + paneOff('text') },
        h('h4', null, t('技能正文')),
        bodyPane,
      ),
      h('div', { className: 'dsh-mcp-d-diag' + paneOff('diag') },
        shadowedBy
          ? h('div', { className: 'dsh-skills-risk' },
            h('div', { className: 'dsh-skills-risk-h' }, t('同名遮蔽')),
            h('div', { className: 'dsh-skills-risk-row' },
              h('span', { className: 'k' }, t('实际生效')),
              h('span', { className: 'v' }, t('来自 {scope}，模型只会收到那一份；本行是另一个作用域里的副本。', { scope: skillScopeLabel(shadowedBy) })),
            ),
          )
          : h('div', { className: 'dsh-mcp-d-note' }, t('未检测到跨作用域同名遮蔽，本份已进入模型目录。')),
      ),
    ),
  );
};

/** 技能详情页签的状态宿主。理由与 ServerDetailPane 相同：详情组件必须是纯函数，
 *  否则测试里以普通函数调用它会抛 "Invalid hook call"。 */
const SkillDetailPane = (props) => {
  const [tab, setTab] = useState('overview');
  const key = props.row ? props.row.name + ':' + (props.row.source || '') : '';
  // 被遮蔽 / 只读这类「需要解释」的行直接落到诊断页；正常行回概览。
  useEffect(() => { setTab('overview'); }, [key]);
  return h(SkillDetail, { ...props, tab, onTab: setTab });
};

/**
 * 外部源（skillhub.cn）的安装确认弹窗——市场只剩这一条来源，所以安装只走这里。
 *
 * ⚠️ 上游条目**没有 license 字段**，所以本插件在这里能做的只有披露：
 * 把上游唯二可信的东西摆出来（发布方企业认证、安全扫描结论）、把「本插件未核验」写在明处、
 * 要一次**显式确认**（服务端也校验 `acknowledged`，UI 只是它的界面）。
 * 判定归工具，决定归人——但工具不提供它没把握的判定：**不编一个许可判定**出来。
 *
 * 落点用同一套「安装到」，身份是 `(source, root)`（见 installTargetId）。
 */
const SkillInstallModal = ({ entry, scopeOptions, scope, onScope, onClose, onConfirm, busy, external = {} }) => {
  const [ack, setAck] = useState(false);
  if (!entry) return null;
  // 外壳沿用既有的 dsh-mcp-overlay 与 h3 标题、dsh-mcp-modal-actions 页脚——这是本仓库既有的
  // 模态约定（其它弹窗都这样）。**不要**另造 modal-h/-b/-f：那些类没有样式定义，
  // theme-contract 的「渲染出来的类都要有样式」会直接红（实测抓到过）。
  // 内层走共享的 Dialog 构造器，不手写 role/tabIndex/Escape：焦点契约（ref + 挂载即吸焦点 +
  // stopPropagation）就是那个构造器本身。手写一份的后果实测过——焦点留在面板里，按一次 Esc
  // 会把面板连着弹框一起关掉（侧栏入口形态下则是按了没反应），与 1.5.1 修掉的是同一个缺陷。
  return h('div', { className: 'dsh-mcp-overlay', onClick: (e) => e.target === e.currentTarget && onClose() },
    h(Dialog, { label: t('安装 {name}', { name: entry.name }), onClose },
      h('h3', null, t('安装 {name}', { name: entry.name })),
      h('dl', { className: 'dsh-skills-meta' },
        h('dt', null, t('来源')), h('dd', null, external ? 'skillhub.cn · ' + entry.source : entry.source),
        // 外部源没有许可字段——**不编一个许可**，如实写「未提供」。
        h('dt', null, t('许可')), h('dd', null, external ? t('上游未提供许可信息') : entry.license),
        external ? h('dt', null, t('上游页面')) : null,
        external ? h('dd', null, h('a', { className: 'dsh-skills-link', href: external.pageUrl, target: '_blank', rel: 'noreferrer' }, external.pageUrl)) : null,
      ),
      // 外部源披露：上游唯二可信的东西都摆出来，且**说清本插件没做什么**——
      // 「未做许可判定」比一个编出来的绿灯诚实。
      h('div', { className: 'dsh-skills-risk' },
        h('div', { className: 'dsh-skills-risk-h' }, t('外部源（skillhub.cn）')),
        h('div', { className: 'dsh-skills-risk-row' },
          h('span', { className: 'k dsh-skills-warn' }, h(Icon, { d: ICONS.warn }), t('本插件未核验')),
          h('span', { className: 'v' }, t('只做来源披露，不做许可判定、不做安全审查')),
        ),
        h('div', { className: 'dsh-skills-risk-row' },
          h('span', { className: 'k' }, t('发布方')),
          h('span', { className: 'v' },
            external.publisher?.verified
              ? t('已认证{suffix}', { suffix: external.publisher.certifiedName ? t('：{name}', { name: external.publisher.certifiedName }) : (external.publisher.name ? t('：{name}', { name: external.publisher.name }) : '') })
              : (external.publisher?.name || t('未提供认证信息')),
          ),
        ),
        h('div', { className: 'dsh-skills-risk-row' },
          h('span', { className: 'k' }, t('安全扫描')),
          h('span', { className: 'v' },
            external.security?.sanbu || external.security?.keen
              ? [external.security?.sanbu, external.security?.keen].filter(Boolean).map((scan) => scan.statusText || scan.status).join(' · ')
              : t('上游未提供扫描结论'),
          ),
        ),
        h('div', { className: 'dsh-skills-risk-row' },
          h('span', { className: 'k' }, t('运行前提')),
          h('span', { className: 'v' }, external.requiresApiKey ? t('需要 API Key') : t('不需要 API Key')),
        ),
      ),
      h('div', { className: 'dsh-skills-risk' },
        h('div', { className: 'dsh-skills-risk-h' }, t('它会带来什么')),
        // 「进入模型上下文」是无条件的，作为第一等披露项单独说明。
        h('div', { className: 'dsh-skills-risk-row' },
          h('span', { className: 'k dsh-skills-warn' }, h(Icon, { d: ICONS.warn }), t('进入模型上下文')),
          h('span', { className: 'v' }, t('技能正文会作为指令注入会话')),
        ),
        h('div', { className: 'dsh-skills-risk-row' },
          h('span', { className: 'k' }, t('可执行片段')),
          // ⚠️ 不要在这里断言「无 scripts/ 目录」：上游条目**根本没有 scripts 字段**
          // （normalizeHubSkill 拿不到），所以 entry.scripts 恒为 undefined。
          // 真机实测抓到过反例——弹框写着「无 scripts/ 目录」，而落盘出来的技能带
          // scripts/ 与 hooks/*.py。把「没核验」说成「没有」正是这个弹框最不该犯的错，
          // 所以这里如实写「未提供 + 未核验」，把"有没有"留给装完的自己看。
          h('span', { className: 'v' }, external
            ? t('上游未提供清单，本插件未核验：正文可能引用 scripts/ 等可执行文件')
            : (entry.scripts ? t('含 scripts/ 目录') : t('无 scripts/ 目录'))),
        ),
        h('div', { className: 'dsh-skills-risk-row' },
          h('span', { className: 'k' }, t('工具权限')),
          // 同理：上游也不给工具权限清单，「未声明」会被读成「作者声明了没有」。
          h('span', { className: 'v' }, external
            ? t('上游未提供，本插件未核验')
            : ((entry.allowedTools || []).length ? entry.allowedTools.join(', ') : t('未声明'))),
        ),
      ),
      h('div', { className: 'dsh-skills-sec' }, t('安装到')),
      // 作用域候选来自**实际发现**的 source（约束 12），不是写死列表；
      // 且只列**可写**的那些——内置目录只读，列出来只会让人装进去然后困惑
      // （第一版就是这样：只读的内置排在前面，还成了默认目标）。
      // 容器复用 MCP 面的 .dsh-mcp-radio-row：技能面原先自造的 dsh-skills-list/-row
      // 两条规则已被当作死 CSS 删掉，弹窗里这一整块因此是裸的（label 堆叠、无 hover）。
      scopeOptions.length
        ? h('div', { className: 'dsh-mcp-radio-row' },
          ...scopeOptions.map((option) => h('label', { key: option.id },
            h('input', {
              type: 'radio',
              name: 'dsh-skills-scope',
              checked: scope === option.id,
              onChange: () => onScope(option.id),
            }),
            h('span', null,
              option.label + (option.root ? t('（{name}）', { name: option.root }) : ''),
              // 目录还没建也要能选（宿主 importSkill 会 mkdir -p），但要说清楚——
              // 否则用户以为选了个不存在的坏位置。
              option.pending ? h('b', { className: 'dsh-skills-pending' }, t('　安装时创建')) : null,
            ),
          )),
        )
        : h(Notice, {
          tone: 'warn', icon: 'warn', title: t('没有可写入的技能目录'),
          children: t('宿主报告的作用域都是只读的（例如只有内置技能）。装不了任何位置——先确认 DSH 的用户级技能目录存在且可写。'),
        }),
      // 外部源恒需一次显式确认：它是本插件唯一可安装的来源，也是唯一没有许可信息的来源。
      h('label', { className: 'dsh-skills-ack' },
        h('input', { type: 'checkbox', checked: ack, onChange: (e) => setAck(e.target.checked) }),
        h('span', null, t('我知道这是外部来源、本插件未做核验，愿意自行承担安装后的风险。')),
      ),
      h('div', { className: 'dsh-mcp-modal-actions' },
        h(Btn, { onClick: onClose }, t('取消')),
        h(Btn, {
          cls: 'primary',
          onClick: () => onConfirm(entry),
          disabled: busy || !scopeOptions.length || !ack,
          title: !scopeOptions.length ? t('没有可写入的技能目录') : (!ack ? t('先勾选上面的确认') : undefined),
        }, busy ? t('安装中…') : t('确认并安装')),
      ),
    ),
  );
};

/**
 * 外部源（skillhub.cn）的一张市场卡片：与内置目录卡片**同一个原语**（.dsh-mcp-mcard），
 * 只是把「许可红绿灯」换成上游真有的东西：发布方 owner、下载量、是否需 API Key、是否已认证。
 *
 * 为什么不做红绿灯：上游没有许可字段，用颜色表达一个不存在的判定就是编（约束 8 的闸门
 * 只对内置目录成立）。这里的每一枚徽章都能在上游响应里指到出处。
 */
const HubCard = ({ entry, installed, onInstall }) => h(
  'div',
  { className: 'dsh-mcp-mcard' + (installed ? ' installed' : '') },
  h('div', { className: 'dsh-mcp-mcard-top' },
    h('div', { className: 'dsh-mcp-mcard-icon' }, h(Icon, { d: ICONS[installed ? 'check' : 'box'], size: 16 })),
    h('div', { className: 'dsh-mcp-mcard-main' },
      h('div', { className: 'dsh-mcp-mcard-name', title: entry.name }, entry.name),
      h('div', { className: 'dsh-mcp-mcard-meta' },
        h('span', null, entry.owner || t('未知发布者')),
        h('span', null, t('下载 {count}', { count: entry.downloads })),
      ),
    ),
  ),
  h('div', { className: 'dsh-mcp-mcard-desc', title: entry.summary || undefined }, entry.summary || t('（上游未提供说明）')),
  h('div', { className: 'dsh-mcp-mcard-tags' },
    entry.verified ? h(Badge, { cls: 's-on' }, t('已认证')) : null,
    entry.requiresApiKey ? h(Badge, null, t('需 API Key')) : h(Badge, { cls: 's-off' }, t('免密钥')),
    entry.version ? h(Badge, null, 'v' + entry.version) : null,
  ),
  h('div', { className: 'dsh-mcp-mcard-foot' },
    h('span', { className: 'dsh-mcp-mcard-stat' }, installed ? t('本地已有同名技能') : t('来自 skillhub.cn')),
    h('div', { className: 'dsh-mcp-mcard-actions' },
      h(Btn, { cls: 'primary sm', onClick: () => onInstall(entry), children: t('安装') }),
      h('a', {
        className: 'dsh-mcp-btn sm',
        href: entry.pageUrl,
        target: '_blank',
        rel: 'noreferrer',
        title: t('在 skillhub.cn 上查看'),
        children: t('页面'),
      }),
    ),
  ),
);

/**
 * 市场每页条数。上游 /api/skills 的 pageSize 上限就是 100（宿主侧会夹住），用满它：
 * 上游有 19 万条（实测 total=192936），按 48 一页要翻 4019 页，按 100 翻 1930 页。
 */
const HUB_PAGE_SIZE = 100;

/**
 * 市场条目的唯一性不变式：同一个 slug 只出现一次。
 *
 * 为什么必须全局去重（跨页 + 页内一起）：上游**同一页内**就会返回重复 slug——
 * 实测第 1 页（pageSize=100, sortBy=downloads）100 条里只有 88 个不同 slug
 * （agent-browser / anti-fraud 各出现 3 次，同一技能被不同发布者重复发布）。
 * 只按「与已加载页」去重挡不住页内重复：重复 key 进 React 后 reconciliation
 * 错乱，真机表现是卡片越滚越多、计数与实物不符（297 张卡 vs 计数 285）、
 * 搜索像没生效。 HubCard 的 key 是 slug，所以这条不变式同时是渲染正确性的前提。
 *
 * @param {object[]} items - 上游条目（已规范化的形状）。
 * @returns {object[]} 去重后的新数组（保持原顺序，不修改入参）。
 */
function dedupeHubSkills(items) {
  const seen = new Set();
  const unique = [];
  for (const item of items ?? []) {
    const slug = String(item?.slug ?? '');
    if (seen.has(slug)) continue;
    seen.add(slug);
    unique.push(item);
  }
  return unique;
}

/**
 * 技能能力面的入口组件：管理 + 市场。
 *
 * 数据全部走宿主 RPC（skillsManager），不依赖会话（SPEC 约束 14：官方的
 * ctx.remote.skills.list 需要真实 sessionId，会激活冷 Agent）。
 */
// ⚠️ 它**不接** onClose / floating / onMode：悬浮外壳（wrapFloating）与模式分段都归 McpTab，
// 面板只负责「技能面那具身体」。留着没人用的 prop 会让下一个人以为这里还能控制面板开关。
/**
 * 技能市场（外部源）的那一半：搜索、翻页、分类标签、披露详情。
 *
 * 为什么与 SkillsPanel 分开：这七个状态由一个**翻页状态机**串着，而它的三条规则都只能靠
 * 注释和"别动这里"维持——
 *   ① 关键字分草稿与已提交两份：依赖链把击键变成请求的话，就变成"每敲一个字打一次上游"；
 *   ② 在途闸必须是**同步** ref：state 要等下一次渲染+effect 才同步，双击/滚动连发会在
 *      那个窗口里并发打同一页，去重后第二次全是重复项 → 被误判成 done → 翻页提前终止；
 *   ③ 分类只随**语言**重取，不随关键字（否则每搜一次多打一次分类接口）。
 * 三条规则各自失效时症状都很轻（慢一点、少几页、多一次请求），所以散在 493 行里没人会
 * 同时看见它们。收进一个 hook 之后，翻页状态机只有一处可改。
 */
function useSkillsHub({ call, localeV }) {
  const [hub, setHub] = useState({ items: [], total: 0, page: 1, done: false, loading: false, loadingMore: false, error: '', kind: '' });
  // 滚动回调与「加载更多」按钮都在渲染之外触发，那里读不到本次渲染的 hub——ref 拿最新的一份。
  const hubRef = useRef(hub);
  useEffect(() => { hubRef.current = hub; }, [hub]);
  // 同步的在途标志：state 要等下一次渲染+effect 才同步进 ref，那之间的重复触发
  // （双击按钮、滚动事件连续 fire）会并发打同一页——去重后第二次响应全是重复项，
  // 会被误判成 done，翻页提前终止。所以这道闸必须是同步的。
  const hubInFlight = useRef(false);
  const [hubCategory, setHubCategory] = useState('');
  const [hubCategoryLabels, setHubCategoryLabels] = useState({});
  // 外部源条目被选中时的披露信息（点安装时按 slug 拉一次 detail）。
  const [hubDetail, setHubDetail] = useState(null);
  // 市场的关键字分**草稿**与**已提交**两份。为什么要分开：
  // `searchHub` 是 useCallback，而挂载/切分类/提交都靠 `useEffect([call, searchHub])` 触发——
  // 把输入框直接绑到 searchHub 的依赖上，就等于「每敲一个字打一次上游」，
  // 与代码注释和文档都写着的「显式触发（回车 / 切分类）」正相反（依赖链与真机都能证实）。
  // 拆开之后：击键只改草稿，回车才把草稿提交成 hubKeyword，依赖不变就不会重发请求。
  // 顺带把两个面的输入框也分开——它们本来就是两个互不相干的搜索框，
  // 共用一份状态会让「管理面筛选词」出现在市场搜索框里，也会让两边互相触发。
  const [marketDraft, setMarketDraft] = useState('');
  const [hubKeyword, setHubKeyword] = useState('');

  const searchHub = useCallback(async () => {
    setHub((current) => ({ ...current, loading: true, error: '', kind: '' }));
    try {
      // page: 1 是**重置搜索**：换关键字/分类时整体替换，翻页态归零。
      const result = await call('skillHubSearch', { keyword: hubKeyword, category: hubCategory, page: 1, pageSize: HUB_PAGE_SIZE, locale: contentLocale() });
      if (!result.ok) throw new Error(result.error || t('搜索失败'));
      setHub({ items: dedupeHubSkills(result.skills), total: result.total || 0, page: 1, done: false, loading: false, loadingMore: false, error: '', kind: '' });
    } catch (error) {
      const message = String(error?.message || error);
      setHub({ items: [], total: 0, page: 1, done: false, loading: false, loadingMore: false, error: message, kind: classifyHubError(message) });
    }
  }, [call, hubCategory, hubKeyword]);

  // 加载下一页：**追加**而不是替换（替换就成了「永远只有第 1 页」）。
  const loadMoreHub = useCallback(async () => {
    const current = hubRef.current;
    // 没有更多就不发：done（上游该给新条目的页全是重复项）或已显示满 total。
    if (hubInFlight.current || current.loading || current.loadingMore || current.done || current.items.length >= current.total) return;
    hubInFlight.current = true;
    setHub((prev) => ({ ...prev, loadingMore: true, error: '', kind: '' }));
    try {
      const result = await call('skillHubSearch', { keyword: hubKeyword, category: hubCategory, page: current.page + 1, pageSize: HUB_PAGE_SIZE, locale: contentLocale() });
      if (!result.ok) throw new Error(result.error || t('搜索失败'));
      setHub((prev) => {
        // 一条不变式表达两种重复：拼接后整体去重，新增的尾部就是这一页的净增。
        // 跨页重复（排名漂移）与页内重复（多个发布者同一 slug）一次挡住；
        // 净增为 0 = 上游翻不出新东西了，再滚也是重复请求。
        const merged = dedupeHubSkills([...prev.items, ...(result.skills || [])]);
        return { ...prev, items: merged, page: prev.page + 1, loadingMore: false, done: merged.length === prev.items.length };
      });
    } catch (error) {
      const message = String(error?.message || error);
      setHub((prev) => ({ ...prev, loadingMore: false, error: message, kind: classifyHubError(message) }));
    } finally {
      hubInFlight.current = false;
    }
  }, [call, hubCategory, hubKeyword, localeV]);

  // 还有没有下一页：一条派生值，按钮显隐、滚动触发、停止条件都读它——不各写一份判断。
  const hubHasMore = hub.items.length < hub.total && hub.done !== true;

  // 分类只随**语言**重取：它不随关键字变（放进搜索的 effect 里会每搜一次多打一次
  // 分类接口），但语言切换必须重取——上游每个分类给中英两份（name/nameEn），
  // 不重取就停在切换前的语言。locale 也一起传：宿主侧按它挑 nameEn。
  useEffect(() => {
    // try/catch 不能省，理由同上面的安装目标：RPC 抛错时没有它就会逃逸成
    // `Uncaught (in promise)`，而"取不到就用原始 key"只覆盖了 ok:false 那一条路。
    void (async () => {
      try {
        const result = await call('skillHubCategories', { locale: contentLocale() });
        // 分类只是显示层：取不到就用原始 key，不该因此让市场打不开。
        if (result.ok) setHubCategoryLabels(result.labels || {});
      } catch { /* 分类标签只是增强：保持空映射即显示原始 key，不该把市场带下去 */ }
    })();
  }, [call, localeV]);

  useEffect(() => { void searchHub(); }, [searchHub]);

  return {
    hub, hubCategory, setHubCategory, hubCategoryLabels,
    hubDetail, setHubDetail,
    marketDraft, setMarketDraft, hubKeyword, setHubKeyword,
    searchHub, loadMoreHub, hubHasMore,
  };
}


/**
 * 技能管理面的那一半：本地列表、详情正文、以及所有会改磁盘的动作。
 *
 * 为什么与市场面分开：这两半**没有共享状态**，只有一个交汇点——市场装了技能之后要收起
 * 披露弹窗。分开之前，16 个 useState 挤在一个 493 行的函数里，"改本地技能"与"翻市场页"
 * 的代码互相夹着，读一处必须跳过另一处。
 *
 * 收敛在这里的三条纪律（每一条单独失效时症状都很轻，所以必须写下来）：
 *   ① 工作区列表**由 props 传进来**：本组件的 call 是 callSkills（skillsManager），
 *      而列表在 mcpManager 上——自己问只会拿到 ok:false 且不报错，表现为"项目级技能永远不出现"；
 *   ② 安装目标只列**可写**的：内置 bundled 目录只读，让它成为默认目标会直接把技能写进内置目录；
 *   ③ 选中存**身份**（行 key）而不是行对象：存对象会留住上一次取数时的快照，启停之后详情
 *      仍渲染旧值（真机实测过）。
 */
function useSkillsManage({ call, workspaces, onSummary, flash }) {
  const [rows, setRows] = useState([]);
  // ⚠️ 选中存的是**身份**（行 key），行对象从当前 rows **派生**——不存对象本身。
  // 存对象会留住"上一次取数时的那个对象"：面板里刚启停一个技能后列表刷新，详情却还在渲染
  // 旧对象（真机实测：磁盘上已经是 .disabled，详情仍写「已启用」，点「刷新」也不变，只有重新
  // 选中那一行才对）。派生之后这个状态无法存在——没有旧对象可留。
  const [selectedKey, setSelectedKey] = useState('');
  // 正文是**三态**，不是字符串：字符串没法表达「失败了」，于是失败只能长得像加载中。
  const [body, setBody] = useState({ status: 'idle' });
  const [busy, setBusy] = useState(false);
  const [entry, setEntry] = useState(null);
  const [scope, setScope] = useState('');
  // 宿主支持的**全部**落盘位置（含还没建的）。老宿主没有这个方法 → 空数组 → 退回发现集。
  const [targets, setTargets] = useState([]);

  const summaryRef = useRef(onSummary);
  useEffect(() => { summaryRef.current = onSummary; }, [onSummary]);

  const load = useCallback(async () => {
    // ⚠️ 工作区列表**由 McpTab 通过 props 传进来**，不能在这里自己问服务：
    // 本组件的 `call` 是 callSkills（打到 skillsManager），而 `listWorkspaces` 只在
    // **mcpManager** 上——问了也只会拿到 {ok:false}，且**不报错**，表现为「项目级技能
    // 永远不出现」。这个缺陷由「面板只调 skillsManager 真实存在的方法」用例抓出。
    // SPEC 约束 13：每个工作区各查一次 list({cwd}) 再合并（宿主传 cwd 时返回合并视图，
    // 所以按 source 过滤在宿主侧完成，客户端只负责把列表传下去）。
    const result = await call('list', { workspaces: workspaces || [] });
    if (!result.ok) {
      // 服务不可用：把原因与「一个技能都没有」分开——前者要一条降级提示，后者是空状态。
      summaryRef.current?.({ state: 'down', count: null, error: result.error || '', scopeTabs: [] });
      return result;
    }
    // 宿主返回的是**一个**数组：停用不再是「在另一个数组里」，而是行上的派生态
    // （enabled = 两个调用面是否都关掉，见 lib/skills-registry.js 的 toView）。
    // 旧版是两个数组、停用件由宿主扫盘补一份——那套做法的代价见 SkillsManagerGateway.list。
    const next = skillRows(result.skills || []);
    setRows(next);
    // 计数就是行数：已停用的技能也是技能（面板里看得见、也点得动），
    // 只数可调用的会让「能力层写着 8、列表里有 11 行」这种自相矛盾出现。
    summaryRef.current?.({ state: 'ready', count: next.length, error: '', scopeTabs: skillScopeTabs(next) });
    return result;
  }, [call, workspaces]);

  useEffect(() => { void load(); }, [load]);
  // 切回这个标签页时重取一次列表：**宿主侧本来就已经自动发现**（它用 chokidar 监听技能根，
  // 新增/改名/删除技能无需重启即到达模型），所以面板缺的只是「知道自己该重取一次」。
  //
  // ⚠️ 为什么不是订阅 `skills/change` 做到推送式刷新：那个事件**不在**宿主的 Remote 转发
  // 白名单里，而白名单由 `dsh-api-remotes` 独占（`registerRemoteEvents` 只接受一个源，
  // 第二个注册直接抛 already registered）——第三方插件没有合法途径把它送到浏览器。
  // 这是契约没开这个口，不是我们偷懒；如实写在这里，免得下一轮有人又去试一遍。
  //
  // 也不轮询：技能变化远没有 MCP 连接状态那么频繁，而每次 list 都要扫全部技能根并逐个读文件
  // 解析 frontmatter。焦点重取的收益/成本比明显更好。
  useEffect(() => {
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined;
    const onVisibilityChange = () => { if (document.visibilityState !== 'hidden') void load(); };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [load]);
  useEffect(() => {
    // 安装目标：问宿主「可以写到哪里」。拿不到（老宿主）就留空，由 skillTargetOptions 退回归发现集。
    // ⚠️ try/catch 不能省：RPC **抛错**（宿主没这个 endpoint、传输失败）时没有它，
    // 这个 async IIFE 会 reject 成 `Uncaught (in promise)`——注释承诺的"拿不到就留空"
    // 对抛错那条路根本不成立。真机 console 实测过（stack 经 prepareInvocation）。
    void (async () => {
      try {
        const result = await call('skillTargets', { workspaces: workspaces || [] });
        if (result.ok) setTargets(result.targets || []);
      } catch { /* 安装目标只是增强：留空即退回归发现集，不该把面板带下去 */ }
    })();
  }, [call, workspaces]);

  const loadBody = useCallback(async (row) => {
    if (!row) return;
    setBody({ status: 'loading' });
    const result = await call('detail', skillDetailRequest(row));
    setBody(result.ok
      // R14：hub 是宿主从 <技能>/.hub.json 读出来的来源（slug/version/pageUrl）。
      // 原来这里只取 content，把来源直接丢了——于是界面永远看不到'从哪装的、哪个版本'。
      ? { status: 'ok', text: result.skill?.content || '', hub: result.skill?.hub ?? null, hubError: result.skill?.hubError || '' }
      // 错误原文给出去：用户要靠它判断下一步，只留一句「加载失败」等于没给信息。
      : { status: 'error', text: result.error || t('宿主未返回原因') });
  }, [call]);

  const selectRow = useCallback((row) => {
    setSelectedKey(row?.key ?? '');
    void loadBody(row);
  }, [loadBody]);

  // 行动作的统一出口——与 MCP 面的 act 同一条纪律：**失败必须说出来**。宿主拒绝时给的是具体
  // 原因（「这个字段的值跨了多行，请手工修改这一行」这类），吞掉它就只剩「点了没反应」；而技能面
  // 的动作真的动用户的文件，那句原因正是用户唯一能据以修好的信息。成功才重新取数。
  // 返回 true = 成功，调用方据此决定要不要做后续（清选中、关弹窗）。
  const act = useCallback(async (method, payload) => {
    setBusy(true);
    try {
      const res = await call(method, payload);
      if (!res || res.ok !== true) {
        flash?.((res && res.error) || t('{method} 失败', { method }), 'err');
        return false;
      }
      await load();
      return true;
    } finally { setBusy(false); }
  }, [call, flash, load]);


  const toggleRow = useCallback(async (row, enable) => {
    // 双向：MCP 面每行都有启用/停用开关，技能面必须同样能**恢复**已停用的技能。
    const next = enable === undefined ? row.enabled === false : enable === true;
    // 只送**引用**（source + root + 项目路径 + 磁盘条目 + 形态），不送 writable：可写与否由服务端
    // 判定，客户端传什么不算数（否则「只读根不可写」只是客户端的礼貌）。
    await act('setEnabled', { ...skillDetailRequest(row), enabled: next });
  }, [act]);

  const toggleModelInvocable = useCallback(async (row, modelInvocable) => {
    // 「允许模型自动调用」的开关：写技能文件里的 disable-model-invocation（issue #5）。
    // 与启停同一条纪律：只送引用，可写与否由服务端判定。
    // 重新取数在 act 里：行上的权限来自**磁盘上的那个文件**（宿主侧从文件解析），刷出来的就是
    // 真正写下去的值；被拒绝时文件没变，开关如实停在原位，而原因由 act 说出来。
    await act('setModelInvocable', { ...skillDetailRequest(row), modelInvocable: modelInvocable === true });
  }, [act]);

  const toggleUserInvocable = useCallback(async (row, userInvocable) => {
    // 「用户可调用」的开关：写技能文件里的 user-invocable。
    // 它存在的理由与「停用」直接相关：停用 = 两个面都关，而只给一个面开关的话，
    // 用户在面板里拨不回「仅手动可调用」那一档（只能去编辑文件）。
    // 纪律与上面那个完全一致（只送引用、可写与否由服务端判定、失败要把原因说出来）。
    await act('setUserInvocable', { ...skillDetailRequest(row), userInvocable: userInvocable === true });
  }, [act]);

  const removeRow = useCallback(async (row) => {
    // 「删除技能」是**真删**（宿主 removeSkill：目录捆绑连目录、扁平删文件）。
    // 之前这个菜单项接的是 toggleRow —— 点删除只会把技能停用，还报成功。
    if (!confirm(t('确认删除技能「{name}」？{target}会从磁盘移除，不可撤销。', { name: row.name, target: row.kind === 'bundle' ? t('整个目录（含 scripts/references）') : t('该文件') }))) return;
    // 删成功才清选中：失败时那一行还在，清掉选中只会让用户面对一个空详情、还不知道为什么。
    if (await act('removeSkill', skillDetailRequest(row))) setSelectedKey('');
  }, [act]);


  return {
    rows, selectedKey, setSelectedKey, body, setBody, busy, entry, setEntry,
    scope, setScope, targets,
    load, loadBody, selectRow, act,
    toggleRow, toggleModelInvocable, toggleUserInvocable, removeRow,
  };
}


/**
 * 本机技能导入：浏览器选中文件 → `importSkill` 的 payload。
 *
 * 为什么是模块级函数而不是组件里的 useCallback：它的全部输入（file、落点、act、flash）
 * 都能从外部给，所以拆出来就能**真跑**（客户端在本仓库跑不了真实文件选择器，但可以传一个
 * 带 `text()` / `arrayBuffer()` 的假 file）。留在组件里只能靠源码正则间接证明。
 *
 * 两条边界写在参数里，不在这里重新判断：
 *   · 落点（source/root/projectPath）由调用方给，**不在这里拼路径**；
 *   · 归档格式由**宿主**按魔数判（客户端只按扩展名决定走 content 还是 archiveBase64）。
 */
async function importSkillFile({ file, target, act, flash }) {
  if (!file) return false;
  if (!target) { flash?.(t('没有可写入的技能位置'), 'err'); return false; }
  const name = String(file.name ?? '');
  const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  const isText = TEXT_SKILL_EXTENSIONS.includes(extension);
  try {
    const payload = skillImportPayloadOf({
      name,
      // 文本读成字符串更直接；归档必须字节。
      text: isText ? await file.text() : undefined,
      bytes: isText ? undefined : new Uint8Array(await file.arrayBuffer()),
      target,
    });
    return await act('importSkill', payload);
  } catch (error) {
    // 读文件本身失败（权限/被移走）也要说出来：否则用户只看到“什么都没发生”。
    flash?.(String(error?.message || error), 'err');
    return false;
  }
}

const SkillsPanel = ({ call, workspaces, mode = 'manage', scopeFilter = 'all', onScopeFilter, sortKey = 'default', onSort, onSummary, flash }) => {
  // 市场只有**一个**来源：skillhub.cn（直连上游、本插件只做披露）。
  // page/done 是翻页的真值来源：上游 total=192936（实测，深页有货），只取首页就会
  // 「计数写着 19 万、屏幕只有一页」——数字与实物对不上，用户以为下拉会刷新。
  // 语言版本：搜索与分类的 effect 依赖它——切语言要按新语言重拉
  // （上游描述中英两份、分类名中英两份，不重拉就停在切换前的语言）。
  const localeV = useLocaleVersion();

  // 市场面（外部源搜索 / 翻页 / 分类 / 披露）：七个状态 + 两个在途闸自成一体，
  // 与管理面（本地列表 + 技能文件读写）没有共享状态，只有 confirmInstall 一处交汇（留在组件）。
  const {
    hub, hubCategory, setHubCategory, hubCategoryLabels,
    hubDetail, setHubDetail,
    marketDraft, setMarketDraft, hubKeyword, setHubKeyword,
    searchHub, loadMoreHub, hubHasMore,
  } = useSkillsHub({ call, localeV });

  // 管理面（本地技能列表 + 技能文件读写）：数据、加载、写动作。confirmInstall 也在这里，
  // 但它的收尾要同时影响市场面的披露弹窗——那一处由 onInstalled 通知，不把两个面的 state 缠在一起。
  const {
    rows, selectedKey, setSelectedKey, body, setBody, busy, entry, setEntry,
    scope, setScope, targets,
    load, loadBody, selectRow, act,
    toggleRow, toggleModelInvocable, toggleUserInvocable, removeRow,
  } = useSkillsManage({ call, workspaces, onSummary, flash });
  // 管理面列表的筛选词：只管**本地**那张表，不发任何网络请求。
  // 它刻意与市场的 marketDraft / hubKeyword 分开：两个面本来就是两个互不相干的搜索框，
  // 共用一份状态会让管理面的筛选词出现在市场搜索框里（反之亦然）。
  const [query, setQuery] = useState('');
  // 筛选只留状态。作用域**不在这里**：它是第二行那排药丸（外壳持有），由 scopeFilter 传进来。
  const [statusFilter, setStatusFilter] = useState('all');
  const [collapsedGroups, setCollapsedGroups] = useState(() => new Set());

  // onSummary 是外壳的回调，用来把「技能服务在不在 + 一共几个技能」报上去
  // （第二行的连接状态、能力层那个计数都读它）。用 ref 拿最新的一份，避免把它写进 load 的依赖。

  // 外部源的搜索：**显式触发**（挂载首屏 / 切分类 / 回车提交），不是每次击键都打网络。
  // 这条纪律靠**依赖**成立，不靠注释：searchHub 只依赖 hubKeyword（已提交的），
  // 而输入框改的是 marketDraft —— 所以击键不会让它换身份、也就不会有请求。
  // 远端目录不可用时只把错误留在结果区，面板照旧（约束 11 的降级纪律）。

  const scopeOptions = skillTargetOptions(targets, skillScopeOptions(rows));
  // 安装目标 = 候选里**可写**的那些。内置目录（bundled）只读，既不该进候选、
  // 更不该像第一版那样因为排在前面而成为默认目标（真机实测：默认就指向内置目录，
  // 而 importSkill 不传 writable 时宿主按可写处理 → 会直接写进内置目录）。
  const installTargets = scopeOptions.filter((option) => option.writable !== false);
  // 摘要、弹窗默认选项与最终写入共用这一个目标；scope 是身份，作用域语义来自 option.scope。
  const installTarget = installTargets.find((option) => option.id === scope) || installTargets[0];

  // 浏览器只能给内容：读字节/文本 → payload 的事在模块级做（可单测），这里只接线。
  // 落点用 installTarget——它是**渲染派生值**，所以这一步必须留组件（同 confirmInstall 的理由）。
  const onImportFile = (file) => { void importSkillFile({ file, target: installTarget, act, flash }); };

  // 安装是**两个面的交汇点**：落点由管理面派生（installTarget），装完要收起市场面的披露弹窗。
  // 所以它留在这里，不进任何一边的 hook —— 放进去就要么把两面的 state 缠在一起，
  // 要么把 installTarget 这个渲染派生值塞进 hook 的依赖里。
  const confirmInstall = useCallback(async (target) => {
    // 落点按**安装目标的唯一身份**（source + root）解析：两个工作区会有同一个 source，
    // 按 source `find` 会静默装进第一个（用户以为选了项目 B，实际写进项目 A）。
    const option = installTarget || {};
    // writable 是显式声明：宿主默认按可写处理，所以这里的 true 必须与
    // 「只列可写目标」这个前提一致，不能靠默认值蒙。
    //
    // 市场只有外部源这一条路：宿主下载上游 zip 再走**同一个** importSkill 落盘——
    // 落点因此仍然由面板选，而不是上游说了算。
    const ok = await act('skillHubInstall', {
      slug: target.slug,
      version: target.version,
      // 落点只送引用；`acknowledged` 是**服务端**要求的确认（UI 的勾选框只是它的界面）。
      source: option.source,
      root: option.root,
      projectPath: option.projectPath,
      acknowledged: true,
    });
    // 装失败时弹窗留在原地（用户要能看到失败原因、能重试），只有成功才收起来。
    // 装成功才收起弹窗：失败时留在原地，用户要能看到原因并重试。
    if (ok) { setEntry(null); setHubDetail(null); }
  }, [act, installTarget, setEntry, setHubDetail]);

  const shadowed = shadowedSkills(rows);

  // 列表与详情共用筛选结果，不能继续操作已被作用域、状态或查询排除的行。
  const visibleRows = useMemo(() => sortSkills(rows.filter((row) => {
    if (scopeFilter !== 'all' && skillGroupKey(row) !== scopeFilter) return false;
    if (statusFilter === 'disabled' && row.enabled !== false) return false;
    if (statusFilter === 'enabled' && row.enabled === false) return false;
    const needle = query.trim().toLowerCase();
    if (needle === '') return true;
    return [row.name, row.description, skillScopeLabel(row), row.cwd]
      .some((value) => String(value || '').toLowerCase().includes(needle));
  }), sortKey), [rows, scopeFilter, statusFilter, query, sortKey, localeV]);
  const selected = selectedSkillRow(visibleRows, selectedKey);
  // 保留仍可见的选择；筛选排除它时补选第一行，无匹配时清空详情。
  // ⚠️ 这个 effect 必须留在组件：它读的是**视图派生值**（selected / visibleRows），
  // 而那两样依赖 query / statusFilter / sortKey / localeV —— 都是视图状态，不属于管理面的数据。
  useEffect(() => {
    if (selected) return;
    if (visibleRows.length) selectRow(visibleRows[0]);
    else if (selectedKey) { setSelectedKey(''); setBody({ status: 'idle' }); }
  }, [selected, visibleRows, selectedKey, selectRow]);

  // 加载某一行的正文。三态必须都落到 UI 上：失败没有终态，就会长得像「一直在加载」。

  // 选中的作用域在数据刷新后可能整个消失（工作区被移除），留着它会让列表永远空着、
  // 而药丸上已经找不到那个高亮项——用户没有任何办法退回去。
  useEffect(() => {
    if (scopeFilter === 'all') return;
    if (!rows.length) return;
    if (rows.some((row) => skillGroupKey(row) === scopeFilter)) return;
    onScopeFilter?.('all');
  }, [rows, scopeFilter, onScopeFilter]);
  // 分组在**过滤之后**算：搜索/筛选命中的行落在哪几组，就只显示那几组的组头。
  const groups = skillGroups(visibleRows);
  const twinCounts = skillTwinCounts(rows);
  const toggleGroup = useCallback((key) => {
    // 新 Set 而不是原地 add/delete：与这个仓库其余 state 一样走不可变更新，
    // 否则引用不变、组件不会重渲染，折叠点了没反应。
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  return h('section', { className: 'dsh-skills-root', 'aria-label': t('技能面板') },
    // ⚠️ 第二行**不在这里**：模式分段、作用域药丸、连接状态都由外壳（McpTab）渲染，
    // 这一层只负责「技能面这具身体」。技能面自己画第二行，正是当初「两套 UI」的来源
    // ——标题栏上会并排出现 MCP | 技能 | 管理 | 市场 四个标签，其中「技能」还是死按钮。
    mode === 'manage'
      ? h('div', { className: 'dsh-mcp-body' },
        // 左栏与 MCP 面同一张卡片（.dsh-mcp-side），并且**管理模式下也有搜索**——
        // 技能只会越装越多，MCP 面常驻的搜索在这里同样必需（原先只有市场模式有，自身就不一致）。
        h('div', { className: 'dsh-mcp-side' },
          h('div', { className: 'dsh-mcp-search' }, h(Icon, { d: ICONS.search }), h('input', { placeholder: t('搜索技能…'), value: query, onChange: (e) => setQuery(e.target.value) })),
          h('div', { className: 'dsh-mcp-filters' },
            h('select', { value: statusFilter, onChange: (e) => setStatusFilter(e.target.value), 'aria-label': t('按状态过滤') },
              h('option', { value: 'all' }, t('全部状态')),
              h('option', { value: 'enabled' }, t('已启用')),
              h('option', { value: 'disabled' }, t('已停用')),
            ),
            // 本机导入：一个包裹式 <input type=file>（原生控件样式不可控，所以把图片藏着）。
            // 它传的是**内容**而不是路径：浏览器拿不到宿主路径，宿主收到后先落 system tmp
            // 再走与 skilhub 同一套导入路径（zip-slip / 符号链接 / 锁 / 原子提交）。
            h('label', { className: 'dsh-mcp-btn sm', title: t('从本机选择技能文件（.md 或压缩包）导入到当前落点') },
              t('导入本机技能'),
              h('input', {
                type: 'file',
                'aria-label': t('选择要导入的技能文件'),
                style: { display: 'none' },
                onChange: (event) => {
                  const file = event?.target?.files && event.target.files[0];
                  // 先清空再读：同一个文件连选两次时必须都能触发 change（不清会静默无反应）。
                  if (event?.target) event.target.value = '';
                  if (file) void importLocalSkill(file);
                },
              }),
            ),
          ),
          h('div', { className: 'dsh-mcp-list' },
            visibleRows.length === 0
              ? h('div', { className: 'dsh-mcp-empty-list' }, rows.length === 0 ? t('没有发现技能。检查宿主是否挂载了 dsh-skill 内置插件。') : t('没有匹配的技能'))
              : null,
            // 按作用域分组：组头整行放得下路径，行内不再重复一份被裁断的标签。
            ...groups.flatMap((group) => collapsedGroups.has(group.key)
              ? [h(SkillGroupHeader, { key: group.key, group, collapsed: true, onToggleCollapse: toggleGroup })]
              : [
                h(SkillGroupHeader, { key: group.key, group, collapsed: false, onToggleCollapse: toggleGroup }),
                ...group.rows.map((row) => h(SkillRow, {
                  key: row.key,
                  row,
                  selected: row.key === selectedKey,
                  onSelect: selectRow,
                  onToggle: toggleRow,
                  busy,
                  shadowedBy: shadowed.find((item) => item.key === row.key)?.shadowedBy,
                  twins: twinCounts.get(row.key),
                })),
              ]),
          ),
          // 底栏：统计 + 排序/刷新，与 MCP 面同一副（ListFooter）。
          // 统计同样只数**看得见的行**（visibleRows）：作用域药丸筛出 12 行时，
          // 底栏必须写 12——写成全量就与屏幕上的行数对不上了。
          h(ListFooter, {
            text: skillStatsText(visibleRows),
            sortKey,
            onSort,
            onRefresh: () => void load(),
            refreshing: busy,
            sortTitle: t('排序技能'),
          }),
        ),
        // 右栏与 MCP 面同一张卡片（.dsh-mcp-detail）。
        h(SkillDetailPane, {
          row: selected,
          shadowedBy: shadowed.find((item) => item.key === selectedKey)?.shadowedBy,
          body,
          busy,
          onRetry: () => void loadBody(selected),
          onToggle: toggleRow,
          onModelInvocable: toggleModelInvocable,
          onUserInvocable: toggleUserInvocable,
          onRemove: removeRow,
        }),
      )
      // 市场与 MCP 面同一副骨架：分类药丸 + 搜索 | 说明 | 网格 + 卡片。
      // 曾经这一面用的是 .dsh-skills-bar / .dsh-skills-tags / .dsh-skills-grid / .dsh-skills-card
      // 一整套私有原语——同一个「发现市场」在两个能力面长得不一样，于是切换时像换了个产品。
      // 滚动监听挂在滚动容器**自己**身上（React 对 scroll 是原生直挂，不靠事件委托），
      // 不在 effect 里挂：宿主外壳在持续高频重渲染本面板（真机 wire 上 list/skillTargets
      // 每秒一轮、连续上百次渲染），被动 effect 的重跑会被饿住——IntersectionObserver
      // 版的观察器在首屏搜索完成后迟迟创建不出来，实测「首次滚动不加载、交互过一次才加载」。
      // onScroll 的处理器每次渲染都是新闭包，读的也是当次渲染的 loadMoreHub，不过期。
      : h('div', {
        className: 'dsh-mcp-market-view', role: 'region', 'aria-label': t('技能发现市场'),
        onScroll: (event) => {
          const box = event.currentTarget;
          // 离底部还有 200px 以上就什么都不做——给一点提前量，用户看到的就是「到底就有」。
          if (box.scrollTop + box.clientHeight < box.scrollHeight - 200) return;
          void loadMoreHub();
        },
      },
        h('div', { className: 'dsh-mcp-market-toolbar' },
          h('div', { className: 'dsh-mcp-market-head' },
            h('div', { className: 'dsh-mcp-search' },
              h(Icon, { d: ICONS.search }),
              h('input', {
                value: marketDraft,
                placeholder: t('搜索 skillhub.cn（回车）'),
                'aria-label': t('搜索技能'),
                // 击键只改草稿；回车才提交（提交后 searchHub 换身份 → effect 发一次请求）。
                onChange: (event) => setMarketDraft(event.target.value),
                onKeyDown: (event) => { if (event.key === 'Enter') setHubKeyword(marketDraft); },
              }),
            ),
          ),
          // 分类 key 来自上游、标签来自它的分类接口（取不到就显示原始 key）。
          h('div', { className: 'dsh-mcp-chips', role: 'tablist', 'aria-label': t('按分类浏览') },
            ...[['', t('全部')], ...Object.entries(hubCategoryLabels)].map(([key, label]) => h('button', {
              key: key || 'all',
              type: 'button',
              role: 'tab',
              'aria-selected': hubCategory === key,
              className: 'dsh-mcp-chip' + (hubCategory === key ? ' sel' : ''),
              onClick: () => setHubCategory(key),
            }, label)),
          ),
        ),
        h('div', { className: 'dsh-mcp-market-section' },
          h('b', null, t('skillhub.cn（外部源）')),
          // 计数说清「已显示 / 共」：只写总数就是 19 万条结果旁边只摆一页卡片——
          // 数字是真的，用户在面板里却到不了其余条目，看着就像没有。
          h('span', null, hub.loading ? t('正在搜索…') : installTarget
            ? t('已显示 {shown} / 共 {total} 条 · 装入{scope}', { shown: hub.items.length, total: hub.total, scope: installTarget.scope === 'global' ? t('全局') : installTarget.label })
            : t('已显示 {shown} / 共 {total} 条', { shown: hub.items.length, total: hub.total })),
        ),
        // 两种失败**分开说**：宿主没这个接口 ≠ 上游挂了。混成一句会让用户去查网络，
        // 而真正要做的是重启宿主加载新版插件。
        // 错误 Notice 只在**一页都没有**时替换整个结果区：首屏失败 = 市场打不开，这么摆；
        // 加载更多失败是另一回事——已加载的页面要留着，错误与重试放在结果区上方，
        // 否则上游抖一下，用户已翻的几百张卡就全没了（追加失败是翻页引入的新失败面）。
        hub.items.length === 0
          ? (hub.error
            ? (hub.kind === 'missing'
              ? h(Notice, {
                tone: 'warn', icon: 'warn',
                title: t('当前宿主进程还没有外部源接口'),
                children: t('面板已更新，但这个正在运行的宿主进程是在更新之前启动的，所以它不认识 skillHubSearch。重启宿主（dsh 进程）后即可使用。'),
              })
              : h(Notice, {
                tone: 'warn', icon: 'warn', title: t('连接 skillhub.cn 失败'), children: hub.error,
                actions: [h(Btn, { key: 'retry', cls: 'sm', disabled: hub.loading, onClick: () => void searchHub(), children: t('重试') })],
              }))
            : h(SkillsEmpty, { text: hub.loading ? t('正在搜索…') : t('没有匹配的外部技能。') }))
          : h('div', { className: 'dsh-mcp-grid' },
              ...hub.items.map((item) => h(HubCard, {
                key: item.slug,
                entry: item,
                installed: rows.some((row) => row.name === item.name || row.name === item.slug),
                onInstall: (target) => {
                  setEntry(target);
                  setScope(installTarget?.id || '');
                  setHubDetail(null);
                  // 装之前拉一次详情：披露块要的是发布方认证与安全扫描，列表里没有。
                  void (async () => {
                    const result = await call('skillHubDetail', { slug: target.slug, locale: contentLocale() });
                    setHubDetail(result.ok ? result : { pageUrl: target.pageUrl, publisher: null, security: null, requiresApiKey: target.requiresApiKey });
                  })();
                },
              }))),
        hub.error && hub.items.length > 0
          ? h(Notice, {
            tone: 'warn', icon: 'warn', title: t('加载更多失败'), children: hub.error,
            actions: [h(Btn, { key: 'retry-more', cls: 'sm', disabled: hub.loadingMore, onClick: () => void loadMoreHub(), children: t('重试') })],
          })
          : null,
        // 翻页区：显式按钮（兜底，键盘可达）。滚动到底的自动加载挂在上面那个滚动
        // 容器的 onScroll 上——没有更多时整块消失，摆一个点不动的按钮比不摆更糟。
        hubHasMore
          ? h('div', { className: 'dsh-skills-hub-more' },
              h(Btn, { cls: 'sm', disabled: hub.loadingMore, onClick: () => void loadMoreHub(), children: hub.loadingMore ? t('加载中…') : t('加载更多') }))
          : null,
        h('div', { className: 'dsh-skills-note' },
          h('b', null, t('外部源，本插件未核验。')),
          t('skillhub.cn 上的技能由任何人发布，条目里没有许可信息；安装前会把上游给的发布方认证与安全扫描结论摆出来，但那不等于本插件的审查结论。收录 ≠ 背书。')),
      ),
    // 关闭时**真的卸载**，而不是进到组件内部再 return null：
    // 许可确认的勾选必须随弹窗一起消失。复用实例会让「关掉再开同一个技能」
    // 时 ack 仍是 true——那等于闸门白设。key 保证换一张卡也必是新实例。
    entry ? h(SkillInstallModal, {
      key: entry.name + ':' + (entry.source || ''),
      entry,
      // 传**可写**目标：只读的内置目录不是安装位置（选了它等于把技能写进只读目录）。
      scopeOptions: installTargets,
      scope,
      onScope: setScope,
      onClose: () => { setEntry(null); setHubDetail(null); },
      onConfirm: confirmInstall,
      busy,
      // 外部源：披露块用详情接口拿到的发布方/安全扫描；未到位时先按列表字段说「未提供」。
      external: entry.source === 'skillhub'
        ? {
          pageUrl: hubDetail?.pageUrl || entry.pageUrl,
          publisher: hubDetail?.publisher || null,
          security: hubDetail?.security || null,
          requiresApiKey: entry.requiresApiKey === true,
        }
        : null,
    }) : null,
  );
};

