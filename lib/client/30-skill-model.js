// ── 技能面板的纯逻辑 ────────────────────────────────────────────────────
// 单独放一组、且都是纯函数：面板组件本身在 jsdom 里测不出多少真东西（渲染得出来 ≠ 对），
// 而下面这些推导才是最容易出错的地方（作用域归属、遮蔽、诊断合并、红绿灯判定）。

/**
 * 宿主六级 source 的可读标签（SPEC 约束 2 的完整集合）。
 *
 * ⚠️ 表里存的是**中文原文（词典键）**，不是 t() 的结果。
 * 模块级求值的 t() 一定拿到中文：这些常量在 bundle 加载时就建好了，而 active 语言要等
 * apply() 读到 locale 服务才知道——先求值就等于把语言**在加载那一刻定死**。
 * 真机表现：切到 English 后，凡来自这些表的文案仍是中文（详情页签、排序菜单、入口菜单、
 * 作用域标签），其余都正常。所以统一改成「存键、用时翻」，调用点见各处的 t(...)。
 */
const SCOPE_LABELS = {
  'project-dsh': '项目 · .dsh/skills',
  'project-agents': '项目 · .agents/skills',
  custom: '自定义目录',
  'user-dsh': '全局 · .dsh/skills',
  'user-agents': '全局 · .agents/skills',
  bundled: '内置（只读）',
};

/**
 * 项目级 source 的**路径部分**（不含「项目」前缀）。
 *
 * 为什么单独存一份：带项目名的那句是「项目 {name} · {detail}」——
 * 前缀与路径各自要能翻译，而合起来又必须是一条整句（中英语序不同）。
 * 所以把不随项目变的那半段提出来，按 source 取。
 */
const PROJECT_SOURCE_PREFIX = 'project-';
// 同 SCOPE_LABELS：存原文，用时翻（模块级 t() 会锁死成加载时的语言）。
const SCOPE_LABEL_DETAILS = {
  'project-dsh': '.dsh/skills',
  'project-agents': '.agents/skills',
};

/**
 * 从工作区路径取项目名（末段目录名）。
 * Windows 与 POSIX 都要吃：宿主回的是各平台原生分隔符。
 */
function projectLabelOf(cwd) {
  const parts = String(cwd || '').split(/[\\/]+/).filter(Boolean);
  return parts.length === 0 ? '' : parts[parts.length - 1];
}

/**
 * 一行的作用域标签：在「哪一级 source」之上补上「**哪个项目**」。
 *
 * SCOPE_LABELS 只回答前者，于是多工作区下每个项目级技能都写着同一句
 * 「项目 · .agents/skills」——用户问的「你分项目和全局，但没说哪个项目啊」
 * 就是这个。行数据上一直有 cwd（toView 带过来的），只是从没被用上。
 *
 * 完整路径放 title 与详情页的根目录行；两个项目末段目录同名时，靠这两处区分。
 *
 * ⚠️ 这里**按 source 判「是不是项目级」**，绝不按显示出来的标签判。
 * 曾经写成 `base.startsWith(t('项目'))` / `base.replace(t('项目'), …)`——那是用**文案**
 * 当判据：`t()` 在英文下返回 'Project · .agents/skills'，而 `t('项目')` 返回 'Project'，
 * 于是英文界面里两件事同时坏掉——`startsWith` 侥幸还对（都以 Project 开头），
 * 但 replace 只会换掉第一处、且中文下 `'项目 ' + name` 里的前缀又没走 t()。
 * 判据必须是数据（source），文案只负责显示。
 */
function skillScopeLabel(row) {
  const source = row?.source;
  // 两张表存的都是中文原文（词典键），所以这里必须过 t()：这是**渲染路径**，
  // 每次调用都读当前语言，切语言后立刻正确。
  const base = t(SCOPE_LABELS[source] || source || '');
  // 项目级 source 是 project-dsh / project-agents 两个（见 skillScopeOptions 的同源判据）。
  if (!String(source || '').startsWith(PROJECT_SOURCE_PREFIX)) return base;
  const name = projectLabelOf(row?.cwd);
  return name === '' ? base : t('项目 {name} · {detail}', { name, detail: t(SCOPE_LABEL_DETAILS[source] || '') });
}

/**
 * 作用域候选项，**由实际发现的 source 集合派生**（SPEC 约束 12）。
 *
 * 为什么不能写死一份「全局/项目」清单：本机 `~/.dsh/skills`（rank 400）**不存在**，
 * 11 个技能全在 `~/.agents/skills`（rank 500）。写死的清单会让用户看到一个空的作用域、
 * 或看不到自己技能真正所在的那一级。所以只列宿主真报出来的来源，并带上真实根路径。
 *
 * @param {object[]} rows - 技能行（listSkillViews 的结果）。
 * @returns {{ source: string, label: string, scope: string, root: string|undefined, cwd: string|undefined }[]}
 */
/**
 * 候选的**展示顺序**按宿主 rank（见 docs/skills.md 的优先级表）。
 *
 * 这只决定「谁排在前面」（也就是安装时的默认选中项），**不决定谁存在**——
 * 存在与否永远只看宿主实际报了什么（约束 12）。所以表里没有的 source 一律排到最后。
 * 为什么值得单独一张表：localeCompare 会把 bundled 排到 user-dsh 前面（'b' < 'u'），
 * 于是只读的内置目录成了安装弹窗的默认目标。
 */
const SOURCE_RANK = { 'project-dsh': 100, 'project-agents': 200, custom: 300, 'user-dsh': 400, 'user-agents': 500, bundled: 600 };
const sourceRank = (source) => SOURCE_RANK[source] ?? 999;

/**
 * 安装目标的**唯一身份**：`source + root`。
 *
 * ⚠️ 不能只用 `source`：两个工作区都会有 `project-agents`。只按 source 做 key/查找，会让
 * 两个单选项撞同一个 key、同一个选中值，而且 `find` 取首个 → 用户以为选的是项目 B，
 * 实际写进项目 A（或 `installTargets[0]` 那个默认）。宿主本来就是按 `source\0root`
 * 去重的（skills-registry.js 的 skillTargetsView），面板必须用同一套身份。
 */
const installTargetId = (option) => `${option?.source || ''}\u0000${option?.root || ''}`

function skillScopeOptions(rows) {
  const seen = new Map();
  for (const entry of Array.isArray(rows) ? rows : []) {
    // ⚠️ 去重键必须是**作用域身份（source + cwd）**，不是 source：两个工作区都会有
    // `project-agents`，只按 source 去重会把它们合成一项，还带上第一个的 root。
    //
    // 曾经这里还要展开 `row.disabled`（旧版把已停用技能放在**第二个数组**里）——
    // 那个数组已经不存在了（停用是行上的派生态，见 SkillsManagerGateway.list）。
    const source = entry?.source;
    if (typeof source !== 'string' || source === '' || seen.has(skillScopeIdentity(entry))) continue;
    seen.set(skillScopeIdentity(entry), {
      // 安装目标的身份与宿主一致：source + root（见 installTargetId）。
      id: installTargetId({ source, root: entry.root }),
      source,
      // 标签同样带项目名：筛选下拉里两行「项目 · .agents/skills」是没法选的。
      label: skillScopeLabel(entry),
      scope: entry.scope === 'project' ? 'project' : 'global',
      root: entry.root,
      cwd: entry.cwd,
      // wire 上的目标引用用的是 projectPath；这条退路上它等于行的 cwd。
      projectPath: entry.cwd,
      // ⚠️ writable 必须带下去：宿主在每一行上标了它（bundled 为 false），
      // 第一版把它丢了，于是「内置（只读）」既进了候选、还因为排在前面成了**默认**
      // 安装目标。注意它现在只是**显示用**：真正的可写与否由服务端判定（不接受载荷里的 writable）。
      writable: entry.writable !== false,
    });
  }
  // 全局在前、项目在后（与宿主 rank 的语义一致：rank 小的先被采纳，用户级是默认视角）。
  return [...seen.values()].sort((left, right) => {
    if (left.scope !== right.scope) return left.scope === 'global' ? -1 : 1;
    const rank = sourceRank(left.source) - sourceRank(right.source);
    return rank !== 0 ? rank : left.label.localeCompare(right.label);
  });
}

/**
 * 技能行的**唯一身份**：`source + cwd + name`。
 *
 * 为什么必须只有一个：同一件事曾经在面板里被写成四份不同的身份——行的 key 用
 * `scope:source:name`、分组键用 `rank\0source\0cwd`、诊断去重用 `scope:name`、
 * 安装目标用 `source`——于是「同名跨作用域是合法配置」这条事实在每个推导里都要被
 * 重新记得一次，漏掉一个就是静默错：
 *   · 诊断按 `scope:name` 去重 → 同名的一条启用一条停用会被判成「已在工作中」而丢掉，
 *     调用方为了避免重复只好把输入清空，整块诊断 UI 因此恒为空；
 *   · 行的 key 少了 cwd → 两个工作区的同名技能撞同一个 React key，看起来是一行；
 *   · 安装目标只用 source → 两个工作区合成一项，装进第一个。
 * scope 不再进身份：它是 source 的函数（project-* / custom / user-* / bundled），
 * 写进来等于给同一件事留第二处判据。
 */
const skillScopeIdentity = (row) => `${row?.source || 'unknown'}\u0000${row?.cwd || ''}`;
const skillIdentity = (row) => `${skillScopeIdentity(row)}\u0000${row?.name || ''}`;

/**
 * 把技能行加工成面板要的形状：加一个**稳定的 key**。
 *
 * key 必须是「来源 + 项目 + 名称」而不是名称：同名跨作用域是合法配置（DSH 按 rank 裁决谁生效），
 * 按名字当 key 会让 React 把两份不同的技能认成同一行，用户就只能看到一个副本——
 * 而启停/删除是精确作用到某一个根上的（SPEC 决策 D8）。
 */
function skillRows(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    ...row,
    key: skillIdentity(row),
  }));
}

/**
 * 组的排序档位：全局在前、项目居中、自定义次之、内置垫底。
 *
 * 原先候选项按 `source.localeCompare` 排，于是 `bundled`（'b' < 'u'）**排在用户自己的
 * 全局技能之前**——最不该日常操作的那一组反倒置顶。
 */
function skillGroupRank(row) {
  const source = String(row?.source || '');
  if (source === 'bundled') return 'bundled';
  if (source.startsWith('project-')) return 'project';
  if (source === 'custom') return 'custom';
  return 'user';
}

const GROUP_RANK_ORDER = { user: 0, project: 1, custom: 2, bundled: 3 };

/**
 * 一行的组身份：`档位 \0 source \0 cwd`。
 *
 * 抽出来是因为**两个地方必须算出同一个 key**：列表分组（skillGroups）和第二行那条作用域
 * 药丸（skillScopeTabs 的选择值）。各写一份的话，药丸点了之后筛不出任何行——而界面上
 * 看不出哪里错了（药丸高亮正常、列表空着）。
 *
 * 身份含 cwd 的理由见 skillGroups：两个项目都有 project-agents 时，只按 source 会混组。
 */
function skillGroupKey(row) {
  return `${skillGroupRank(row)}\u0000${skillScopeIdentity(row)}`;
}

/**
 * 按作用域给技能行分组——**作用域在技能面是列表的结构，不是一个筛选值**。
 *
 * 为什么必须分组而不是塞进下拉：一条作用域标签是「哪一级 source × 哪个项目」两维，
 * 压成一句 `项目 easyStory · .agents/skills` 后长度不可控，而侧栏筛选器只有 ~139px
 * （原生 select 的面板宽度等于自身宽度、option 不换行），于是必然被裁——
 * 用户看到的「显示也不全」是维度用错了控件，不是字号问题。
 * 组头占满整行宽度，路径放得下，且作用域从「要选的」变成「看到的」。
 *
 * ⚠️ 组的身份是 (source + cwd)，**不是 source**：两个项目都有 `project-agents` 时，
 * 只按 source 分组会把两个项目的技能混进同一组——那正是「没说哪个项目」本身。
 */
function skillGroups(rows) {
  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const rank = skillGroupRank(row);
    const key = skillGroupKey(row);
    let group = groups.get(key);
    if (group === undefined) {
      group = { key, rank, source: row.source, cwd: row.cwd, root: row.root, label: skillScopeLabel(row), rows: [] };
      groups.set(key, group);
    }
    group.rows.push(row);
  }
  return [...groups.values()].sort((left, right) => {
    const rank = GROUP_RANK_ORDER[left.rank] - GROUP_RANK_ORDER[right.rank];
    if (rank !== 0) return rank;
    // 同档位内按项目名排，让多项目的顺序稳定且可读（而不是按宿主返回顺序）。
    return left.label.localeCompare(right.label);
  });
}

/**
 * 第二行那条作用域药丸的候选：**全部** + 每个实际存在的组。
 *
 * 为什么以组（source + cwd）为单位、而不是以 source：组才是列表的结构，也是用户能
 * 点击的最小作用域单位。以 source 为单位的话，两个项目会合成一个药丸，点下去筛出
 * 两个项目的技能——而用户以为选的是某一个项目。
 *
 * 计数取组内行数，所以药丸上的数字与它筛出来的行数**一定相等**（都由 skillGroups 派生）。
 */
function skillScopeTabs(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return [
    { key: 'all', label: t('全部'), count: list.length, title: t('全部作用域（{count}）', { count: list.length }) },
    ...skillGroups(list).map((group) => ({
      key: group.key,
      label: group.label,
      count: group.rows.length,
      title: group.root ? group.label + ' — ' + group.root : group.label,
    })),
  ];
}

/**
 * 同名跨作用域的行 → 「还有几份、都在哪」。
 *
 * 分组之后这件事第一次**看得见**：同一个名字出现在两个组里就是遮蔽的现场。
 * 原先只有一个「被遮蔽」badge，用户知道有问题但找不到另一份在哪。
 */
function skillTwinCounts(rows) {
  const byName = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const list = byName.get(row.name) || [];
    list.push(row);
    byName.set(row.name, list);
  }
  const counts = new Map();
  for (const list of byName.values()) {
    if (list.length < 2) continue;
    for (const row of list) {
      counts.set(row.key, {
        total: list.length,
        // 其他份在哪：最多列两个，多了放不下。
        others: list.filter((other) => other.key !== row.key).slice(0, 2).map((other) => skillScopeLabel(other)),
      });
    }
  }
  return counts;
}

/**
 * 详情要渲染的那一行：**按身份从当前 rows 派生**。
 *
 * 为什么不是把选中的行对象存进 state：那样存的是"上一次取数时的那个对象"。面板里刚启停一个
 * 技能时列表会重新取数，而详情仍渲染旧对象——真机实测：磁盘上的状态已经改了，详情却仍写旧值，
 * 点「刷新」也不变，只有重新选中那一行才对。派生之后这个状态无法存在。
 * 选中项从列表里消失（被删掉/换了作用域）时返回 null，详情自然回到空态。
 */
const selectedSkillRow = (rows, key) => (Array.isArray(rows) ? rows.find((row) => row?.key === key) ?? null : null)

/**
 * 指出哪些条目**被同名条目遮蔽**（相对模型可见目录的差异）。
 *
 * DSH 按 rank 裁决同名技能谁生效，被遮蔽的那份模型收不到——但用户确实装了它。
 * 不提示的话，用户会以为自己操作的是生效的那份（本仓库的独有价值之一）。
 *
 * ⚠️ 判据必须是 **rank**，不是数组位置。曾经取「排在最前的那个」当生效者，而那个前提是错的：
 * 宿主 `list` 的输出按**名字**排序（dsh-skill 的 compareSkillSummary），面板自己又按
 * 「全局在前、项目在后」拼接——而项目级 rank(100/200) 恰好**小于**用户级(400/500)，
 * 于是"最前的"正好是 rank 最大、也就是真正**落选**的那份，方向完全相反（真机报告 + 已复现）。
 * 结果是面板指着生效的那份说「你被遮蔽了」，用户照它去操作，改的其实是模型收不到的那份。
 *
 * 同名里 rank 最小者胜；rank 相同（同一档的不同项目）时按输入顺序取先者——那种情况下
 * 谁生效由宿主的 providerOrder 决定，面板拿不到，但两个不同项目里的同名技能互不影响，
 * 标一份为胜者只是为了让提示有个主语，不会误导操作。
 *
 * 已停用的行不参与：两个调用面都关掉的技能，模型和用户都拿不到它，
 * 说它"遮蔽/被遮蔽"都是假的。它只该出现在诊断里（见 skillDiagnostics）。
 * ⚠️ 判据是 `enabled === false`——**不知道**（null）的行要参与：
 * 它可能照样进了模型目录，把它排除掉才是漏报。
 *
 * @param {object[]} rows
 * @returns {object[]} 被遮蔽的行（附生效者信息）。
 */
function shadowedSkills(rows) {
  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.enabled === false) continue;
    const list = groups.get(row.name) || [];
    list.push(row);
    groups.set(row.name, list);
  }
  const shadowed = [];
  for (const [, list] of groups) {
    if (list.length < 2) continue;
    // 生效者 = rank 最小者（同 rank 取先出现的）。不能改用位置，理由见上。
    const winner = list.reduce((best, row) => (sourceRank(row.source) < sourceRank(best.source) ? row : best), list[0]);
    for (const row of list) {
      if (row === winner) continue;
      shadowed.push({ ...row, shadowedBy: winner });
    }
  }
  return shadowed;
}

/**
 * 汇总「用户需要知道但模型看不到」的条目。
 *
 * ⚠️ 输入只有**行**，判据与行身份同源：`enabled === false` 就是「两个调用面都关掉了」。
 * 停用现在是 frontmatter 的两个字段，宿主照样把它报在目录里，所以这里不需要第二个数组，
 * 也就不可能「同一条出现两次」或「整块 UI 恒为空」。
 *
 * 非法 frontmatter（宿主只 warn + skip）目前**没有**生产者，见 TODO row 21——
 * 在它落地之前，这里不假装能报。
 */
function skillDiagnostics(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row?.enabled === false)
    .map((row) => ({ ...row, kind: 'disabled', level: 'warn' }));
}

/**
 * detail 等动作请求的参数：**送整条引用**（source + root + 项目路径 + 磁盘条目 + 形态）。
 *
 * 为什么不能只送 name（或 name + cwd）：宿主侧 `ctx.skills.get(name)` 按 rank 返回
 * **生效者**，而面板的模型是 (根, 条目) 精确操作（D8）——只送名字时，点「被遮蔽」
 * 那一行看到的是生效者的正文，用户以为自己在读被遮蔽的那份。
 *
 * ⚠️ 送的是 **entry（磁盘条目名）而不是 name（技能名）**：宿主允许两者不一致
 * （`dir-name/SKILL.md` 里写 `name: dir-alias` 照收），而定位必须按磁盘上的真实位置。
 * name 只是显示用的身份，服务端从文件里自己读得出来。
 *
 * 单独成一个函数：这条不变量得有个能被直接断言的家里，而不是埋在组件闭包里。
 */
function skillDetailRequest(row) {
  return {
    name: row?.name,
    source: row?.source,
    root: row?.root,
    projectPath: row?.cwd,
    entry: row?.entry,
    kind: row?.kind,
  };
}

