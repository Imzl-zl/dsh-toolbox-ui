# 新会话提示词（第十五轮·收口）：dsh-toolbox-ui 1.11.1 收尾

> ⚠️ **合入之前先做审查**：`NEW-SESSION-PROMPT-AUDIT.md`（审查专用）。本文件是合入清单，
> 审查轮要先确认 14 项改动没把功能改坏、且几处判断前提没错。审查 PASS 后再按本文件 §5 合入。

> 用法：在新会话里说
> `读 .tasks/review-1.11.1/NEW-SESSION-PROMPT-15.md，按它执行，不要只做摘要`
> （cwd 是主树或隔离树都可以，本路径两边都有。）
>
> **本文件取代 `NEW-SESSION-PROMPT-14.md`**：第十四轮的目标（R14）已经做完——**1.11.1 的 14 项全部完成**。
> 本文件是**收口文档**：不再有"下一步做哪项"，只有合入前的检查清单、已知边界、以及这批改动留下的判断纪律。
> 当前基线：1056 例 / 1049 通过 / 0 失败 / 7 skipped；契约 56 个方法；client 8068 行。

---

## 0. 一句话目标

**14 项已全部 `fixed`。** 接下来是"合入"这件事本身——见 §5。
**不要停下来等确认**：隔离工作树、真宿主夹具、全量门禁都在，自己验证、自己推进；
每完成一项就更新 PLAN/TODO 并往下走。只有需要模型渠道（F 批真会话 E2E）时才问用户。

---

## 1. 现状（必须知道，不要"重做"）

- 隔离工作树：`D:\sudy\github\dsh-toolbox-ui.review`，分支 `review/1.11.1`，HEAD = `e29f21c`。
- **工作区有 8 个新模块 + 若干已修改文件，全部是 R1–R6 的成果，尚未 commit。**
  `git status` 里的"一大片改动"不是垃圾：**不要** `git checkout -- .`、`git clean`、
  `git reset --hard`，也不要 stash 掉。
- 门禁基线（**当前**，务必与之比对）：

  | 命令 | 期望 |
  |---|---|
  | `npm test` | **1056 例 / 1049 通过 / 0 失败 / 7 skipped**，~15–40s |
  | `npm run contract:check` | 退出 0，`✔ RPC 契约一致（56 个方法）` |
  | `npm run client:check` | 退出 0，`✔ 10 个分片 / 8068 行` |
  | `node scripts/build-catalog.mjs` | `47 条 · 10 分类`，跑完 `git status` 无变化 |
  | `node --test test/docs-parity.test.mjs` | 20 通过 |

- 主树 `D:\sudy\github\dsh-toolbox-ui` 只有 `.tasks/` 改动，**没有代码改动**。两边的
  `.tasks/` 内容逐字节一致。
- `TODO.csv`：**R1–R14 全部完成**（R1–R5 `verified`，R6–R14 `fixed`）。
- **每项的完整证据都在 `PLAN.md` 对应小节的 `<h3>结果</h3>` 里**。动手前先读那一项的结果块。

### 1.1 已完成（一句话 + 别回退）

| 项 | 做了什么 | 不要回退/重做 |
|---|---|---|
| R1 | wsPath 校验收进 `canonicalWorkspacePath`，删掉 11 处重复守卫 | `setDeferAll`/`setDefer`/`tools` 的"空 = 全局族"判空必须保留 |
| R2 | `getWorkspaceView` **读取端**按"当前启用条目"过滤诊断 | 不要在 `removeWorkspaceServer` 等处加清除（第二真相源） |
| R3 | 分片依赖方向闸门 `PART_FORWARD_REFS`；`lib/client.js` 纯重排 | 不要改分片顺序/文件名 |
| R4 | 全局工具清单 + 全局 schema 快照按 `(appRoot, 代次)` 共享 | 不要改 `revision`/`toolRevision` 语义 |
| R5 | 视图 revision 的内容指纹按 `(agent, 代次, 名字指纹)` 复用 | 不要把代次号写进 revision |
| R6.1 | 56 个 `__esDecorate` → `applyRemoteMethods(this, <表>)` | 不要再手写 `Remote("…")`（`contract:check` 会红）；不要删 `var __esDecorate`（仍是装配回调） |
| R6.2 | 按职责拆出 8 个模块，`index.js` **2788 → 1590 行** | 见下 |
| R7 | `HostState` per app root + `dispose()` 一处清；工具代次改 per-root | 见 §1.3 |
| R8a | `useReveal` + `useMcpServers`：McpTab 973→864 行、34→23 useState、6→1 useRef；`invalidate()`/`resetScope()` 取代 5 处裸改 `revisionRef` | 见 §1.4 |
| R8b | `useSkillsHub` + `useSkillsManage`：SkillsPanel 493→308 行、16→3 useState、3→0 useRef；`confirmInstall` 作为唯一交汇点留组件 | 见 §1.5 |
| R8c | 通知条抽成 `buildNotices` 纯函数（McpTab 864→791 行）+ 3 条真行为用例；论证并放弃 JSX 子组件提取 | 见 §1.6 |
| R9 | 新增 wire `exportGlobalJson`（55→56 方法）+ 全局页导出出口；明文警告与项目层分开；补上"导出 UI 零覆盖"的缺口 | 见 §1.7 |
| R10 | `projectConnections` 只读接线：`connectionAnomalyOf` 纯函数 + 项目页折叠入口（展开才取数）；`refs > sessions` 这个泄漏信号终于可见 | 见 §1.8 |
| R11 | 本机导入技能：**扩展 payload 收内容**（不新增方法）+ 自实现 base64 + 模块级 `importSkillFile`；6 条用例（3 宿主 + 3 客户端真跑） | 见 §1.9 |
| R12 | 最近日志：先量体积（24KB/台）⇒ 定为 `status` 按需取、**零新增方法**；`list` 不带的反向断言钉住体积 | 见 §1.10 |
| R13a | 目录体检：`toolSearchSettings.catalog`（预算/延迟服务器/上次组装的**字符数**与截断），**零新增 wire** | 见 §1.12 |
| R13b | 旁路记录模型真实搜索（query/返回/空手而归/每次字符成本），**零上下文成本**（不改 `execute` 返回） | 见 §1.13 |
| R14 | 技能来源记录：`.hub.json` 跟技能文件走（bundle 随目录删 / flat 用 `.md.hub.json` 不进技能扫描）；`detail` 带出显示 | 见 §1.17 |

### 1.2 R7 之后的状态归属（这是现在的架构，别推翻）

| 状态 | 住在哪 | 一句话 |
|---|---|---|
| `connections` / `projectSlots` / `configCache` / `schemasCache` / `inventoryCache` / `denyCache` / `scopeModule` / `toolsChangeFlush` / `warned` / `epoch` / `generation` | **`lib/host-state.js` 的 `HostState`**（`WeakMap<appRoot, HostState>`） | per app root；`dispose()` 一处清 |
| `workspaceMountErrors` / `workspaceScopeErrors` / `workspaceRestrictErrors` | 待在 `lib/workspace-runtime.js`，但写入点走 `hostStateOf(ctx).own(wsPath)` 登记 | 键是**项目路径**（事实属于项目，不属于实例）；`dispose()` 按登记删 |
| `agentWorkspaceStates` | 留模块级 | 键是 **agent**，且 `liveAgents()` 必须可枚举（WeakMap 不行）；owner 机制本来就对 |
| `workspaceWriteState` | 留模块级，**卸载不删** | 它是文件锁：删条目会让两个 app 各排一条队列 → 并发丢更新 |
| `contentFingerprintCache`（tool-search-runtime）/ `patchWriteQueues`（patch-store）/ 日志表（mcp-log） | 各自的 `WeakMap<agent|ctx|scope>` | 已经是弱引用回收 + 各自 effect 里 delete，不需要业主 |
| `updateCheckState`（update-hint） | 留模块级 | **刻意**跨重装保留（24h 节流），清掉等于重装后立刻再打一次 registry |

### 1.3 R8 第一批之后的客户端结构

`lib/client/70-shell.js` 里有三个单元，顺序不能乱（TDZ 闸门钉住了它）：

```
startVisibilityAwarePolling(doc, timer, intervalMs, run)   // 可见性感知轮询（纯函数）
useReveal({ call, scope, resetOn, flash })                 // 明文状态机
useMcpServers({ call, scope, timer, flash, revealRevisionRef, clearRevealed })
                                                          // 11 份数据状态 + load/poll/防串
McpTab                                                     // 864 行：只剩 UI 状态与 JSX
```

- `useMcpServers` 对外三个动词：`load(notify)` / `invalidate()` / `resetScope()`，外加三个
  乐观更新用的 setter（`setServers` / `setGlobalServers` / `setExclude`）。
- **组件里不允许再出现 `revisionRef` / `loadSeq` / `manualRefreshSeq`**：作废走 `invalidate()`，
  切作用域走 `resetScope()`。`test/client-hooks.test.mjs` 钉住这条。
- **为什么不抽 `useUpgrade`**（PLAN 原文列了它）：`updateHint` / `upgradeState` 是渲染的直接输入，
  Notice 的 done 分支有三条谨慎规则（不得再读 `updateHint`、done 时 state 要留着、blocked 要带当前版本）。
  抽出去只是把同一批值换个名字传回来，组件行数不减，反而把规则与读点分开。**判断：不抽**。

### 1.5 技能面的三个单元（R8 第二批之后）

```
useSkillsHub({ call, localeV })                     // 88 行：市场面（搜索/翻页/分类/披露）+ 两条在途闸
useSkillsManage({ call, workspaces, onSummary, flash })  // 144 行：管理面（列表/详情/写动作）
SkillsPanel                                          // 308 行：三个纯视图 state + JSX
  ├─ const confirmInstall = useCallback(...)         // 23 行：唯一交汇点，刻意留在这里
```

- **`confirmInstall` 不许进任何一侧的 hook**：它读管理面的 `installTarget`（渲染派生）与市场面的
  `setHubDetail`。放回任一 hook 就要么把另一面的 state 拖进来，要么把渲染派生值塞进 hook 依赖。
  闸门钉住这一条（`test/client-hooks.test.mjs`）。
- **组件只该剩三个 `useState`**：`query` / `statusFilter` / `collapsedGroups`。它们没有 owner 问题
  （纯视图筛选），搬进 hook 反而会让 hook 认识筛选语义。
- **`query` 属于管理面**（本地列表筛选），`marketDraft` / `hubKeyword` 属于市场面 —— 两组刻意分开，
  共用会让两个搜索框互相串。第一版我把它错放进 `useSkillsHub`，已纠正；别改回去。

### 1.6 R8 的收尾结论（别重复劳动）

三批之后的数字：`McpTab` **973 → 791**、`SkillsPanel` **493 → 308**、五个单元（`useReveal` /
`useMcpServers` / `useSkillsHub` / `useSkillsManage` / `buildNotices`）。

- **可测性收益只在新建的那五个单元上**（`client-hooks` 8 条归属断言 + `buildNotices` 3 条真行为断言）。
- **不要再试图把 JSX 提取成子组件**：`panel-chrome` 的 42 条断言读的是**整个 bundle**，
  "搬位置"既不失配也不产生新断言，只是把闭包捕获改成 20 个 props 的显式传递。已论证，写进 PLAN。
- `McpTab` 剩下的 791 行里约 500 行是 JSX 本体，这是它的职责（面板长什么样），不是债务。

### 1.7 R9 之后的全局导出（F 批第一个 wire 改动）

```
lib/rpc-contract.js     exportGlobalJson  { params: [], result: WorkspaceExportResult }
                        ↑ 紧邻 exportWorkspaceJson（同族相邻，顺序即契约）
lib/index.js            宿主实现：数据源 managedState(ctx).servers，物化复用 specToMcpEntry
lib/client/50-mcp-panels.js  WorkspaceExportModal：按 scope 调不同方法，三处文案分叉
lib/client/70-shell.js  全局标签页的「导出全局」按钮
```

- **"同形状"不是约定而是同一段代码**：两个导出都走 `specToMcpEntry`。差别只有
  「有没有 `path`」与「`excluded` 恒为空」（exclude 是"项目屏蔽全局 MCP"，属于项目）。
- **一处必须记住的安全事实**：`toMcpClientConfig` 用 `evaluateEnvExpression` **求值**后才写 patch，
  所以**面板添加过的条目在 patch 里已是实际值** ⇒ 全局导出**是明文**；项目 `.dsh/mcp.json` 存
  `${VAR}` 模板，项目导出保留引用。手写的 `!!js process.env.X` 仍会转回 `${X}`。
  ⇒ 界面警告必须分三处（标题 / 警告 / 格式说明），照抄项目层就是对用户撒谎。
- **两个计数闸门会在新增 wire 方法时红，这是它们的设计**：
  `test/typert-manifest.test.mjs` 的精确计数（注释里按 `旧 → 新（版本）：原因` 追加），
  `test/rpc-contract.test.mjs` 的 `readOnly` 集合（只读方法必须加进去，否则它不会被检查"不得标 mutating"）。
- **新增文案必须同时加英文**：`test/client-i18n.test.mjs` 会列出所有"有用例、没英文"的键。
  取中文字面量时**不要**用 `lastIndexOf("'")`（R9 第一次这么干，把 `t(` 也吃进来，往 `EN_DICT`
  写了 14 行垃圾键）；用 `.tmp-review/literal.cjs` 的正向扫描 + 自检（含中文、长度上限、无代码残渣）。

### 1.8 R10 之后的连接诊断（只读入线，方法数不变）

```
lib/client/40-shared-ui.js   connectionAnomalyOf(row) / connectionDiagText(row)   ← 纯函数，可单测
lib/client/70-shell.js       diagOpen（组件只持展开态）
useMcpServers({ …, diagEnabled })  diagRows / diagError + 展开才取数的 effect
```

- **判定顺序 = 排查顺序**：`refs > sessions`（引用泄漏）→ `configStale`（旧配置建的）
  → `configError` → `scopeError` → `duplicateOwners`。**`refs=0 + idle` 是正常**（空闲待回收），
  不报——把它当异常会让这个视图每一次都响。
- **数据面在 hook、展开态在组件**：组件只留 `diagOpen`。R8 的规模闸门会在你往组件里塞
  `diagRows` 时立刻红（实测过），那时的正确反应是搬进 hook，**不是放宽闸门**。
- **折叠态必须零调用**：那是排障视图，常驻/每 5s 轮询只会给它加负载而没有任何信息增量。
  用例里有一条 `calls.filter(projectConnections).length === 0` 钉这一点。
- **入口用既有 CSS 类**（`dsh-mcp-source-detail` / `dsh-mcp-log` / `Badge`）⇒ 零新增 CSS，
  不碰 `panel-css-invariants`。位置在左栏 `.dsh-mcp-ws-body` 底部（它本来就是 column）。

### 1.9 R11 之后的本机导入（"后端已完整"是错的）

```
lib/skills-file-ops.js  importSkill：入口归一化「内容 → tmp 文件」再重入，之后只有一条导入路径
lib/index.js            wire 层：payload.content / payload.archiveBase64 → source
lib/client/40-shared-ui.js  base64FromBytes（自实现）/ skillImportPayloadOf（按扩展名决定传送形式）
lib/client/80-skills-face.js  importSkillFile（模块级，可真跑）+ 管理面 <input type=file>
```

- **别再以为"加个 file input 就完事"**：宿主原本只收 `{ type, path }` 并从**自己的磁盘**读，浏览器给不了路径。
  现在的形态是**扩展 payload 收内容**，不新增方法（仍 56），而且比"客户端传路径"更窄（拿不到读任意文件的能力）。
- **为什么归一化后重入而不是各分支加 if**：zip-slip / 符号链接 / 锁 / 原子提交四道关卡都在"读盘那条"上，
  加分支就等于第二套导入实现。
- **两个必须记住的守卫**：文本按 `MAX_FILE_BYTES` 拒；base64 **先按长度拒再解码**，并回验
  （`Buffer.from(..., 'base64')` 是宽容的，静默丢字符 —— 不验的话错误会指向"解压失败"）。
- **客户端不抄宿主的魔数判断**：只按扩展名决定走 `content` 还是 `archiveBase64`，格式由宿主
  `detectArchiveFormat` 判。错判只会得到一句明确报错，不会绕过校验。
- **`importSkillFile` 留模块级**（输入全从外部给 ⇒ 可真跑），调用点在组件里（需要 `installTarget`
  这个渲染派生值，与 `confirmInstall` 同理）。往 `useSkillsManage` 里塞会被 `skills-client` 当场抓住。

### 1.10 R12 之后的最近日志（先量体积再定形态）

```
lib/mcp-log.js        allLogsFor（合并 serverName + fiber，按 ts 升序）/ lastLogFor / recentLogsFor
lib/index.js          status 返回 { ...summarize(...), recentLogs }   ← summarize 本身零改动
lib/client/40-shared-ui.js   logClock（固定宽度）/ recentLogLines（倒序）
lib/client/50-mcp-panels.js  ServerDetailPane 持 state 并取数；ServerDetail 只画（纯函数）
```

- **体积是这个决定的全部理由**：`sanitizeMcpLog` 截到 2000 字符/条 ⇒ 12 条最坏 24KB/台、20 台 480KB/轮询。
  **永远不要把 recentLogs 放进行投影**；`list` 不带它这条有**反向断言**钉着。
- **状态必须放 `ServerDetailPane`**：`ServerDetail` / `SkillDetail` 是纯函数（测试当普通函数调），
  函数体里放 `useState` 会抛 `Invalid hook call`。
- **不要做成第四个页签**：`诊断 (N)` 的 N 是"冲突/歧义条数"，再加一页会让它变成两种含义。
- **`lastError` 的语义一个字节都没动**，新字段是并列的 `recentLogs`。

### 1.11 ToolSearch 面的第一硬约束：**上下文成本**（读这一节之前先读它）

ToolSearch 存在的唯一理由是省上下文。所以这个面里的任何改动，先问三个问题：

1. **它进模型上下文吗？** 目录段（`catalogSectionText` 的返回值）与 `execute` 的返回**都进**；
   `toolSearchSettings` / 面板 / 诊断**不进**。诊断类数据一律走旁路，**绝不塞进目录段或 execute 返回**。
2. **它是 per-request 还是 per-search？** 目录段是**每轮请求都付**（per-request）；
   搜索返回是**每次搜索付一次**（per-search）；`discoveredTools` 累计表也是 per-search。
3. **数字是多少？** 任何关于"多列几个/多返回几条"的判断都必须带字符数。实测基线（`node .tmp-review/measure-context.mjs`）：

   | 735 个延迟工具 | 上下文成本 |
   |---|---|
   | 不延迟加载（每个工具完整 schema） | **221,380 字符**（每轮） |
   | 延迟 + 目录不限制 | 目录段 **37,403** + 搜索 3,015（省 81.7%） |
   | 延迟 + `maxCatalogChars=12500` | 目录段 **12,886**（砍 492）+ 搜索 3,015（省 **92.8%**） |
   | `maxResults` 单价 | 3→903 / 5→1,507 / 10→3,015 / 20→6,033 字符**每次搜索** |

- **取舍是真实存在的、可接受的**（用户明确说过）：多花上下文换更好的命中是合理的。
  但它必须是**有数字支撑的取舍**，不是"感觉问题不大"。
- **反例（R13a 第一版）**：体检里统计 `globalToolCount` 调了 `globalToolSchemas`，那是宿主的
  **全量 schema 深拷贝**（735 工具 ≈ 92ms / 1.6–2MB）——**一个为了省上下文的插件的体检，自己触发了全量枚举**。
  体检只能读已经存在的东西（设置值 / 延迟服务器名 / 上次组装统计）。
- **"目录被砍" ≠ "搜不到"**：`searchCatalog` 搜的是**全量目录**，没列进目录的名字照样能命中；
  被砍的代价是**模型不知道它们存在**（想不到去搜）。这两件事在界面上必须分开说。

### 1.11b 两条判断纪律（都是 R13 被用户当场纠正后写下的）

**纪律一：不要拿自己的环境当通用事实。**
实测数字只能说明**曲线形状**，不能说明"某个值对所有人最优"。真实用户的工具规模分布差异极大
（3 台 15 个工具 vs 20 台 700 个），所以：
- 通用的做法是**报用户自己的数字**（像 `catalogFacts` 那样），**不替所有人给结论**；
- 任何"建议值/默认值该改成 X"的结论，必须说清它成立的前提规模，否则就是在替一个不存在的"平均用户"做决定。

**纪律二：说清"截断"的机制代价，不要用"仍能搜到"这种话糊过去。**
- `select:<名字>` 是**按精确名字**取 schema 的。名字不在目录里 ⇒ 模型**不知道那个名字** ⇒ `select:` 用不了。
- 剩下的唯一路径是**关键词**，而 `searchCatalog` 是 **BM25 词法匹配**（无同义词、无语义），
  所以关键词必须**恰好**出现在工具描述/参数名里才命中。
- ⇒ 截断的代价是「那批工具从**点名可取**退化成**猜词**」，不是"少列几个字"。
- **截断后模型仍知道的**（`catalogGroupHeader` 输出 `### server1 · 37 tools · 31 not listed`）：
  有哪些服务器、每台几个、几个没列 ⇒ 兜底路径是 `+server1 关键词`（名字硬约束收窄）。文案必须给出这条路。
- **反面教材**：R13 第一版把「被砍掉的名字仍能被搜索命中」写进了界面文案，**还写成了测试断言**
  （`assert.match(text, /仍能被搜索命中/)`）——把错误说法焊死了。已拆。

**纪律三（同一批纠正）：不要把自己的 fixture 当成缺陷证据。**
R13b 原来把"搜不到"标成 `❌` 并排最前，但目录第一次组装就列全部名字，模型照抄名字用 `select:` 必然命中；
我那条红用例用的是**自己手造的不存在名字**。⇒ 先问"这个现象在正常路径下会发生吗"，再决定它算不算信号。

### 1.12 R13a 之后的目录体检（零新增 wire）

```
lib/tool-search-runtime.js  catalogSectionText / flatCatalogText 返回 listed+total（与 truncated 同一次分配）
                            lastCatalogAssembly（**全局一份**，不按 agent 分表）
lib/index.js                catalogFacts()（登记进 INTERNAL_ONLY）+ toolSearchSettings.catalog
lib/client/60-tool-loading.js  catalogFactsText(facts) 纯函数 + 设置页一行
```

- **它回答的是"参数与你机器上的实际库存对不对得上"**，**不回答**"某次搜索会返回什么"（那是 R13b 试搜）。
- **两个"不编数字"的红线**：`lastAssembly` 未组装时是 **null**（面板说"还没有组装过目录"），
  `globalToolCount` 取不到工具服务时是 **null**。**绝不写 0**——"还没跑过"与"跑了但没截断"是两件事。
- **`deferredServers` 必须来自 `deferServersOf`**，不许在 gateway 里重新实现一遍判断（第二真相源）。
- **`catalogFacts()` 是内部方法**，所以必须登记进 `lib/rpc-contract.js` 的 `INTERNAL_ONLY`，
  否则第四面（原型集合 = 契约表）会红。这是 R9 就确认过的规则。
- **`listed + truncated === total` 是结构保证**：三个数来自同一次分配。改这段时别把某个数改成"另外算一遍"。

### 1.12b 官方（Anthropic）的做法 —— 对照用，不是让我们照抄

`advanced-tool-use` 页面的 Tool Search Tool：**延迟工具完全不进 context**（连名字都不列），
只靠 system prompt 提示"有工具可用，用 tool_search 搜"，搜到后"返回引用 → 展开成完整定义"。
基线数字："~72K tokens for 50+ MCP tools"。

本插件把工具名**全列进目录**（每轮都付），换来"模型知道具体名字、能 `select:` 精确取"。
**这是真实的取舍，不是缺陷**：代价与收益都随用户的工具规模变，所以只能由用户看着自己的数字决定。
⇒ 讨论这个面时，不要说"官方的做法更好"，要说"官方在哪个规模下更省、我们在哪个规模下更准"。

### 1.13 R13b 之后的搜索记录（旁路，零上下文）

```
lib/tool-search-runtime.js   recentSearches（环形 20 条）+ recordSearch()，在 execute 里**旁路**写
lib/index.js                 catalogFacts().recentSearches（**零新增方法**）
lib/client/60-tool-loading.js recentSearchesText（空手而归排最前）+ 设置页显示
```

- **记录只在 `toolSearchSettings` 里出去**。它**绝不**出现在：`execute` 的返回（进模型上下文）、
  目录段（每轮请求都付）、任何工具定义。
- **三条对着"零上下文成本"的断言必须保留**：返回里不含 `searches`/recent` 类键；目录段不含 query 文本
  （**只在"只搜一两次"时验**，搜满 20 次目录段就空了，断言会变空转）；把记录塞进返回的故障注入要红。
- **`missing` 是这个视图的核心**：`select:<名>` 点名但找不到 ⇒ 那就是"搜不到"的直接证据。
  展示时空手而归**排最前**，不要按时间线埋掉。
- **`payloadChars` 是 `maxResults` 的单价**（实测每多一条 ≈ 300 字符/次）。改这个参数时用它说话，别用估算。

### 1.17 R14 之后的技能来源记录

```
lib/skills-file-ops.js  hubSourcePath / writeHubSource / readHubSource
                        bundle → <技能目录>/.hub.json（删目录连带清）
                        flat   → <name>.md.hub.json（不进技能扫描）
lib/index.js            skillHubInstall 落盘 + detail 带出（读失败进 hubError，不抛）
lib/client/80-skills-face.js  hubSourceLabel（有版本才显示版本，不编造）
```

- **位置跟着技能文件走，不建 `<root>/.hub/` 目录**：多一个目录就要操心"它会不会被扫描成技能、
  删技能时清不清空"，那是白送的风险。现在 bundle 的清理是**零代码**（随目录一起删）。
- **"没有来源"与"来源坏了"必须分开**：本机导入的技能 `hub: null`（界面不显示这一行）；
  JSON 坏了 `hubError` 非空（界面**显示红色原因**）。静默当成"没有来源"会让用户以为技能是手工装的，
  从而永远不去更新它。
- **写来源失败不把整次安装报成失败**（技能已经落盘是既成事实），但结果里带 `hubError`。
- **未做**："检查更新"（要打上游比版本，需要网络与额外失败面）。先有来源，再谈更新。

### 1.14 编写客户端测试的两条硬约束（已写进 panel-chrome 文件头）

1. **client 跑在 vm 里**：数组/对象原型与主 realm 不同，`deepEqual` 是 `deepStrictEqual`（**比原型**），
   "内容完全相同"也会失败，且错误信息里 actual 与 expected 一模一样。比较用 `.length` / 逐项，或 `Array.from` 重建。
   （R8 / R10 / R12 各踩一次，所以写进了文件头。）
2. **hook-renderer 只渲染 root**：子组件留成元素节点 ⇒ 子组件的**渲染结果**拿不到，但 **props** 拿得到
   （`ofType(tree, Component)[0].props`）。要验子组件输出，直接调它（它们大多是纯函数）。

### 1.15 改客户端代码的方式（别再踩 shell 引号）

**一律写 `.tmp-review/*.cjs` 文件再 `node` 跑**，不要用 `node -e '...'`：单引号会被 shell 截断，
`'--:--:--'` 变成 `--:--:--`、`'log'` 变成 `log`，只有 `node --check` 才会发现（R12 踩了两次）。
另外：**只在锚点处插入，不要替换"含上下文的多行"**——R12 两次把相邻注释一起删掉。

### 1.16 R8 期间新建的三个工具（可复用，别再手写一次性脚本）

| 工具 | 干什么 | 为什么必须有 |
|---|---|---|
| `.tmp-review/inject.cjs` | 注入 → **自校验替换真的发生**（锚点唯一 + 写回读哈希）→ 跑验证 → 逐字节还原 | 第七轮之前有一次注入没生效，闸门假绿 |
| `.tmp-review/move-block.cjs` | 按内容锚点切块，`require`/`forbid` 双向校验 | 裸 `split/join` 曾连带删掉过 `hubDetail`；行号已漂三次 |
| `.tmp-review/free-vars.cjs` | 切块的自由变量差集 | 手写 `require` 等于"我保证我没漏"；机器报出了漏传的 3 个 |

### 1.4 客户端改动的证据手段（R8 专用，别再重新发明）

本仓库的假 React `useEffect` 是 noop，**hook 在本仓库跑不了行为**。所以客户端重构的等价性只有三条路：

1. `npm run client:write` + `npm run client:check`（只证明分片拼装一致，不证明行为不变）；
2. **渲染快照逐字节**：`.tmp-review/render-snapshot.mjs <tag>` → `cmp .tmp-review/render-before.html .tmp-review/render-<tag>.html`。
   它用与 `.tasks/_uipreview.mjs` 相同的假 React 装载**真 `lib/client.js`**，渲染 `McpTab` 的三个
   六个场景（`McpTab` 3 个 + `SkillsPanel` 的 manage / market / 带工作区各 1 个）。
   **取基线的正确做法**：把分片恢复到改动前 → `client:write` → 渲染 → 换回新分片 → `client:write`
   → 渲染 → `cmp`。只在改动**之后**渲染一次不算证据（没有对照）。
   **改 JSX 或搬 hook 前后都必须用它**。
3. 结构断言（`test/client-hooks.test.mjs`）：客户端的 hook 只能这样钉。

### 1.5 R6.2 之后的模块地图（这是现在的架构，别推翻）

| 模块 | 行 | 职责 |
|---|---|---|
| `lib/index.js` | 1590 | 只剩两个 gateway 类（wire 面）+ `installToolSearch` 装配 + 列表胶水 + tsc 助手 |
| `lib/patch-store.js` | 266 | patch 读-改-写、HMR 锁、托管条目定位、从 patch 内容派生的视图 |
| `lib/mcp-import-plan.js` | 252 | 导入/合并的**决策**（哪些算新增/更新/移除）与预览文案 |
| `lib/mcp-write-paths.js` | 248 | 写入路径（落盘与生效分开报、锁内的写与锁外的 reconcile） |
| `lib/mcp-rows.js` | 183 | 一行的展示投影（全局行 + 项目行，同一个 `deriveMcpPhase`） |
| `lib/update-hint.js` | 127 | 包身份、让位检测判据、更新检查（24h 进程内缓存） |
| `lib/mcp-projection.js` | 106 | 掩码 / 保留原值标记 / reveal 求值（读出去与写回来成对） |
| `lib/mcp-log.js` | 94 | mcp-client 日志采集（连接状态只存在于日志） |
| `lib/remote-wiring.js` | 42 | `applyRemoteMethods`（R6.1 的表驱动装配） |

**纯搬移的证据手法（继续用）**：`.tmp-review/verify-function-bodies.cjs`——按
`^(async )?function name(` 切函数体、逐字节 sha256 比对，证明"函数体 78/78 不变、
0 消失、0 变更、0 新增"。**别用"行内容多重集"**：实测有 7 条通用语句在两侧都出现
（`const state = await managedState(ctx);` 之类），会误报成残留副本。

**拆/搬文件时的主要风险（实测踩了 4 次）**：`import('./lib/index.js')` 会成功（模块图
完整），只有跑到那条分支才炸 `ReferenceError`。所以**每搬一块都跑全量 `npm test`**，
不要只跑"看起来相关"的那几个文件。

---

## 2. 硬约束

1. **代码只改隔离树**；主树只更新 `.tasks/review-1.11.1/`。进度文件改完要**同时同步到隔离树**。
2. 一次只做一项。先红用例（真 RPC / 真宿主优先），再最小结构修。
3. **四条不变量**：
   - wire 契约：`lib/rpc-contract.js` 是唯一真相源，`npm run contract:check` 是闸门。
     R6.1 之后加方法=只改表，但**方法体必须真的在原型上**（`applyRemoteMethods` 加载时断言）。
   - `lib/client.js` 必须仍能由 `lib/client/` 分片**逐字节**拼出（`npm run client:check`）。
   - 面板文案与状态取值域：`deriveMcpPhase`、`{persisted, live, diagnostics}` 语义、
     `mountFailed`/`scopeFailed`/`status` 的区分方式。
   - 读侧宽容 / 写侧严格。
4. **不加静默兜底**。新增错误路径必须显式抛出；禁止 `catch {}` 吞掉后返回默认值。
5. **不格式化**：`lib/index.js` 用 tab + 分号；其余 `lib/*.js` 与 `test/*.mjs` 用 2 空格无分号。
6. **不重写**：`scripts/rpc-contract.mjs`、`scripts/build-client.mjs`、`lib/client/` 的切分、
   四面对齐机制视为已定架构；只在它们之上加闸门。
7. **不碰** `.worktrees/feature/unified-tool-loading`。
8. 每个断言/结论都要带 `文件:行号` 或命令输出。
9. **不要去动两个 gateway 类的结构**（拆 mixin）：第 4 面契约靠 `Gateway.prototype` 判定，
   改原型链会让 wire 面与第四面同时静默失效。R6.2 已论证过这一点，别重新尝试。

### 2.1 前三轮踩过的坑（照着避）

- **CRLF**：`.gitattributes` 是 `* text=auto eol=lf`。主树 `.tasks/*.md|csv` 磁盘上是 CRLF、
  隔离树是 LF；同步用 `fs.writeFileSync(dst, fs.readFileSync(src))`，别用文本管道。
  改完 `node -e "if (fs.readFileSync(f,'utf8').includes('\r\n')) throw ..."` 检查。
- **bash 的 `/tmp` ≠ Node 的 `/tmp`**：Node 写 `/tmp/x` 落到 `D:\tmp\x`，bash 的 `/tmp`
  是 `C:\Users\<user>\AppData\Local\Temp`。混用会得到"文件明明刚写却读不到"。用
  `cygpath -w /tmp/xxx` 换出真实路径，或统一用仓库内 `.tmp-review/`。
- **别在 `node -e` 里用 `"\\b"` 拼正则**：shell 单引号里 `\\b` 到 JS 是 `\b`（退格符），
  结果每条 `test()` 都返回 false，看起来像"index.js 一个都不引用"。要匹配词边界就用
  `grep -w`，或把脚本写成 `.tmp-review/*.cjs` 文件再 `node` 跑。
- **行号会漂**：PLAN 里 R1–R5 引用的行号是第一轮之前的；R6 之后 `index.js` 又少了 1000 行。
  动手前 grep 重新定位。
- **改闸门的正则时要连"谁的消费者"一起看**：R6.2 搬走实现后有 5 类 `readFile('lib/index.js')`
  的正则读者需要改读新模块。只改实现不改读者 = "永远对空数组做断言"的假绿。
  改读者时**每条都要成对**（实现查新文件 + 装配/调用点仍查 index.js），否则反向也会失守。

---

## 3. 环境与基线复跑

```powershell
cd D:\sudy\github\dsh-toolbox-ui.review
git log --oneline -1     # e29f21c
git status --short       # 8 个 ?? 新模块 + 已修改文件，全部是 R1–R6
npm test                 # 期望 1056 / 1049 / 0 / 7
npm run contract:check
npm run client:check
node scripts/build-catalog.mjs
```

若 `node_modules` 丢了（junction 指回主树）：

```powershell
$main = 'D:\sudy\github\dsh-toolbox-ui'
$work = 'D:\sudy\github\dsh-toolbox-ui.review'
if ((Resolve-Path $work).Path -eq $work) { Remove-Item -LiteralPath (Join-Path $work 'node_modules') -Force }
cmd /c mklink /J "$work\node_modules" "$main\node_modules"
```

**数字与上表不一致就先报告，别动手。**

---

## 4. 交接资产（都能直接用）

- **真宿主复现/验证**（`.tasks/review-1.11.1/repro/`，cwd = 仓库根）：
  - `r1-real-host.mjs`：真 cordis + 真 Loader + 官方 `mountRootInclude` + 真 ToolRuntime +
    真 `McpManagerGateway`；验证空/空白/相对 wsPath 被所有入口拒绝且不落盘。
  - `r2-real-host.mjs`：真 mcp-client 连不存在的命令，制造真实挂载失败。
- **纯搬移校验**：`.tmp-review/verify-function-bodies.cjs <基准 index.js>`（见 §1.2）。
- **可复用件**：
  - `lib/remote-wiring.js` 的 `applyRemoteMethods`（新增 gateway 类时用，别手写装饰器）。
  - `test/rpc-contract.test.mjs` 的「真宿主里装配出的 Remote 标记…」——唯一能看见
    "装配写错导致 wire 面消失"的用例（源码正则可读不出 `initializers` 是否传对）。
  - `test/module-boundaries.test.mjs`——职责边界闸门（成对断言，删实现或留副本都会红）。
- **真宿主夹具**：`test-support/loader-host.mjs`。需要"工具代次可信"的宿主时还要调用
  `installAgentRuntime(ctx)`。
- **验证手法**：红采样 `git stash push -- <文件>` → 看红 → `git stash pop`（**串行**）；
  故障注入（把关键判据改成常量 / 把实现写回旧文件）→ 确认红 → 备份复原 + `cmp` 校验。

---

## 5. 剩余任务与顺序（自己推进，不要停）

### 5. 合入前该做的（这是现在唯一的"下一步"）

一、**门禁全绿**（当前实测）：
```
npm test                 → 1056 / 1049 / 0 / 7
npm run contract:check   → ✔ 56 个方法
npm run client:check     → ✔ 10 分片 / 8068 行
node scripts/build-catalog.mjs → 47 条 · 10 分类，git status 无变化
node --test test/docs-parity.test.mjs → 20 通过
```

二、**diff 自审**（14 项一次性合入前，至少过一遍这五类）：
1. 有没有"第二真相源"：同一个判断被写了两遍（例如落点解析、脱敏、版本格式）；
2. 有没有为了让它变绿而**放宽/删掉**既有断言（这批改了 3 条闸门 + 拆了 1 条错断言，都有记录）；
3. 新增的 wire 方法只应有 **1 个**（`exportGlobalJson`，55→56）；其余项都是零新增；
4. `lib/client.js` 必须仍由分片逐字节拼出（`client:write` 之后跑 `client:check`）；
5. 渲染快照：`node .tmp-review/render-snapshot.mjs <tag>` 与 `.tmp-review/render-baseline.html` 比对，
   **差异必须是能逐行解释的**（R11 多一个导入按钮；R12/R13 不动目录与面板骨架）。

三、**建议的提交切分**（便于单独回滚；每批都能独立跑绿）：
- A：R1+R2（路径校验、诊断寿命）—— 缺陷修复
- B：R3（分片依赖闸门）—— 只加闸门与纯搬移
- C：R4+R5（工具清单共享、revision 指纹复用）—— 性能
- D：R6（表驱动装配 + 拆 8 个模块）—— 结构，改动面最大
- E：R7（HostState 一处清）—— 结构
- F：R8（三个 hook + buildNotices）—— 客户端结构
- G：R9（全局导出，唯一新增 wire 方法）
- H：R10+R12（诊断区、最近日志）—— 只读观测
- I：R11（本机导入：payload 收内容）
- J：R13（目录体检 + 搜索记录）—— 只读观测
- K：R14（技能来源记录）

四、**合入前最后一次确认**：`git status` 里不该出现 `.tmp-review/`（已 gitignore）
与 `lib/mcp-catalog.js`（build-catalog 的产物若内容没变就不该有 diff）。

### 之后（详见 PLAN）

- R8：`McpTab` 拆分（973 行 / 34 useState）。CSS 类名与 DOM 结构不变
  （`panel-css-invariants` 与 `panel-chrome` 是闸门），`client:check` 逐字节。
- R9–R14：F 批功能项，每条独立。新增 wire 方法走 `lib/rpc-contract.js` + `contract:write`
  并同步 `test/package-contract.test.mjs` 的"第四面"；R10 只读入线；R13 优先复用既有方法。
  **R13 需要模型渠道时才问用户要 provider + model**（本地 `magpie`/`deepseek`，
  远端 `qwen`/`glm`/`kimi`），密钥绝不写进仓库/测试/输出。

---

## 6. 每项的产出格式（照抄）

```
## R8 McpTab 拆分 —— 已修

复现/现状：<命令> → <输出>
红用例：<文件:行> 在未修代码上失败（贴断言）
改动：<文件:行> 一句话；git diff --stat
门禁：npm test 1056/1049 ✔ · contract:check ✔ · client:check ✔ · catalog ✔
不破坏：<为什么 wire 形状/客户端字节/视图字段不变>
回滚：revert <文件>
下一步：<下一项>（继续，不等确认）
```

---

## 7. 已知边界（不要在会话里重新调查）

- 本机 **`dsh` 不在 PATH**。真机 UI 冒烟只能用真宿主夹具 + `.tasks/_uipreview.mjs` +
  `panel-chrome.test.mjs` / `panel-css-invariants.test.mjs`。
- A–E 批**不需要模型**。只有 F 批真会话 E2E 才需要渠道。
- 官方源码（只读）：`D:\sudy\github\deepseek-harness`。
  `Remote()` / `mark()` / `remoteMethods()` 语义在
  `node_modules/@deepseek-ai/dsh-typert-protocol/lib/index.js:363-465`（R6.1 已核对）。
- `docs/` 只有 5 对中英文档受 `test/docs-parity.test.mjs` 约束：
  `installation` / `skills` / `json-import` / `project-mcp-lifecycle` / `design`。
- **两个已量化、但不在计划内的遗留性能点**（别当新发现重报）：
  1. 全局标签页每台**已连接**条目仍各读一次作用域视图（`collectAvailableTools` 里的
     `entryCtx.tools.schemas(entryCtx)`）：20 条 ≈ 454ms/轮询。
  2. 宿主 0.2.1 没有 `tools.definitions()`，ToolSearch 每次组装走 `schemas(agent)`
     全量深拷贝 ≈ 92ms/735 工具。

---

## 8. 这一轮唯一该做的事

1. 复跑 §5 一的五条门禁，数字与本文档不一致先报告。
2. 按 §5 二做一遍 diff 自审（重点：第二真相源、放宽的断言、新增 wire 方法数）。
3. 按 §5 三切分提交（或按用户指定的粒度）。
4. **不要**再新增功能。14 项已经全部 `fixed`；任何新想法都先写成 PLAN 的一条候选，而不是直接做。

---

## 9. 如果你这一轮要结束（交接清单）

1. 更新 `PLAN.md` 对应小节的 `<h3>结果</h3>`（改了什么、红用例、实测数字、回滚命令）。
2. 更新 `TODO.csv`（`todo` → `doing` → `fixed`/`verified`）。
3. **主树与隔离树各写一份**（两边 `.tasks/` 内容一致）。
4. 写下一轮提示词（照本文件结构，只改"现状/已完成/下一步"），并在本文件顶部加
   "已被 N+1 取代"。
5. 不要 commit，除非用户明确要求。
