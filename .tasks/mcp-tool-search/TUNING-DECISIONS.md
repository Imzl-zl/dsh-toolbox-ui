# ToolSearch 目录形态与参数取值：证据账本

> 建立于 2026-10-18。**这份文件管的是"取值凭什么"**，不重复 `DECISIONS.md` 的机制决策
> （B/C/G/V 系列在那边）。凡写在这儿的结论都必须带来源；没有来源的写"未测"并列出结算条件。
>
> 触发：用户追问"`descriptionChars` 110 这能行吗？Claude Code 也这样吗？别猜"。
> 复核结果：**这条既不是抄来的、也不是量出来的**——它是第三方实现的一个形状，被我们照抄后
> 当成了默认值。连带把整个取值面过了一遍，发现另一个同类问题（`maxDiscovered`）。

---

## 1 · 已确认（有来源，可直接引用）

### F1 Claude Code 的延迟工具在 prompt 里**只有名字，没有用途**

Claude Code 未开源，但打包产物可读。系统提示原文（v2.1.7x 泄露稿）：

> `ToolSearch` … **Deferred tools appear by name in `<system-reminder>` messages. Until fetched, only the name is known — there is no parameter schema, so the tool cannot be invoked.**

配套镜像（[Piebald-AI/claude-code-system-prompts](https://github.com/Piebald-AI/claude-code-system-prompts/blob/main/system-prompts/tool-description-toolsearch-unfetched-tool-note.md)，`ccVersion: 2.1.231`）全文只有一句：

> Until fetched, only the name is known — there is no parameter schema, so the tool cannot be invoked.

**含义**：延迟工具的 route 信息只有**标识符**。用途靠搜索（见 F2），不靠 prompt 里的摘要。

> 来源可信度：第三方镜像/泄露稿，非官方；但两处独立镜像一致，且与官方 API 文档（F2）不冲突。
> 本仓 `docs/mcp-tool-search-design.md` §3 曾写"系统提示里列出全部延迟工具的名字 **+ 一行用途**"——
> 与本条**不符**，见 F5。

### F2 API 层：延迟工具定义完全不进初始 prompt，搜索索引覆盖全文

[官方文档](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)：

- "Initially, Claude's context contains **only the tool search tool and any non-deferred tools**."
- 搜索匹配 "tool names, descriptions, argument names, and argument descriptions" ——**全文，从不截断**。
- 命中后以 `tool_reference` 返回，API 展开成**完整定义**；"The API automatically expands these … into full tool definitions."
- 每次搜索默认返回 **5** 个（`limit` 1–10,000 可调）。

### F3 官方给的"可发现性"手段是**类别级说明 + 清晰的 name/description**

[Anthropic 高级工具使用博客](https://www.anthropic.com/engineering/advanced-tool-use)（2025-11-24）与
[Agent SDK 文档](https://code.claude.com/docs/en/agent-sdk/tool-search) 同一条建议：

> Add system prompt guidance so Claude knows what's available: "You have access to tools for Slack messaging, Google Drive file management, Jira ticket tracking, and GitHub repository operations. Use the tool search to find specific capabilities."

> Tool search matches against names and descriptions, so **clear, descriptive definitions improve discovery accuracy**.

**没有一处建议"在 prompt 里逐工具列用途"**，更没有截断。

### F4 官方度量（可直接当参数依据）

- 延迟化后准确率：Opus 4 **49% → 74%**，Opus 4.5 **79.5% → 88.1%**。
- "**Claude's ability to pick the right tool degrades once you exceed 30–50 available tools**"。
- 5 服务器 58 工具 ≈ 55K tokens；优化后 ~8.7K（降 85%）。
- 建议：把最常用的 **3–5** 个工具常驻，其余延迟。

### F5 我们的目录是"名字 + 截断用途"，`110` 无来源

- 实现：`catalogSectionLines()`，每行 `- <name> — <前 110 字符>…`（`lib/tool-search-runtime.js:315-327`）。
- 来源：设计文档 §3 引用的第三方 DSH 实现 `lordqyxz/dsh-tool-search` 用"名字+截断目的"；我们照了形状，
  **但 `110` 在任何文档里都没有测量记录**。
- 设计文档 §3 的"名字 + 一行用途"与它自己引的镜像（F1）矛盾——镜像我抓了原文核对，只有 unfetched 注解。

### F6 截断的作用域是**只有目录行**

| 路径 | 截断？ | 位置 |
|---|---|---|
| 每轮 system prompt 目录行 | ❌ 截断到 110 | `runtime:315-327` |
| 搜索索引（name + description + 参数文本） | ✅ 全文 | `lib/tool-search-index.js:93-97` |
| `tool_search` 命中后返回的 schema | ✅ 全文 | `runtime:702` |

**所以风险等级是"路由召回"，不是"调用正确性"**：不会给模型坏参数，只可能让它没想到去搜某个工具。

### F7 三处文案把"一行用途"写死了，改目录必须同步

- 工具描述：`Only tool names and purposes are listed upfront`（`runtime:629`）
- 参数描述：`Capability query in English words. … Translate non-English queries into English keywords first.`（`runtime:635`）
- 引导段：`the prompt lists every deferred tool with a one-line purpose`（`runtime:740`）

### F9 截断的危害已**量化到内容层**（不再只是"可能"）

2026-10-18 实测：spawn 两个**官方参考 MCP 服务器**（`@modelcontextprotocol/server-filesystem` 14 工具、
`server-everything` 13 工具，stdio，读 `tools/list` 即杀，失败不重试），共 **27 个真实工具**：

| 指标 | 实测 |
|---|---|
| 工具名长度 | 平均 **33.3** 字符（min 21 / max 47） |
| 描述长度 | 平均 **195** 字符（最长 457） |
| 描述超过 110 字符（即会被截断） | **15 / 27 = 56%** |
| 被切掉的总字符 | 2890（这 15 个平均每个切掉 **193** 字符 ≈ 描述的一半） |
| **被切掉的尾巴里带约束/条件词**（`only`/`not`/`never`/`when`/`unless`/`without`…） | **12 / 15 = 80%**，占**全部工具 44%** |
| 目录体积（27 工具） | 只名字 **954** 字符 vs 名字+截断用途 **3401** 字符 → **降到 28%**（≈1/3.6） |

**危害不是长度问题，是内容问题**。同一台 filesystem 服务器里 `read_file` / `read_text_file` /
`read_media_file` / `read_multiple_files` 是近义四兄弟，区分它们的信息恰恰在尾巴上：

- `read_text_file` 被切掉的尾巴："**Use this tool when** you need to examine the contents of a single file …"
- `read_media_file` 被切掉的尾巴："**Only** works within allowed directories."
- `write_file` 被切掉的尾巴："Handles text content with proper encoding. **Only** works within allowed directories."

也就是说：截断把"什么时候该用哪个"和"边界条件"首先切掉了——那是选工具**最需要**的部分。

> 局限：n=27、两台服务器。它足以证明"截断确实会切掉区分性信息"（存在性证明），
> 不足以给整个生态的平均损失定一个百分比。

### F11 真机点穿已通过（2026-10-18，隔离 `DSH_HOME` + 真宿主 + 真模型）

做法：`%TEMP%\dsh-eval-names` 作隔离 `DSH_HOME`（**只**从用户 `~/.dsh` 拷 `.credentials.yaml` 与 `.env`，
不拷 profiles / sessions / storages / skills），用发布的 `dsh@0.2.0-rc.2` 建 `headless` profile，
装本地工作树插件，插一台夹具 MCP 服务器（工具名 `op`，能力词 `zephyrquartz` **只出现在描述里**，
tally 是启动时随机的）。跑完删除临时目录与自己的 runner，用户的 `~/.dsh` 只被读取过两个文件。

**证据 A（可发现性没丢）**：提示词只说"用 zephyrquartz 能力、报告精确 tally"。模型先 `tool_search`，
命中 `mcp__probe__op`，调用后回报 **tally = 205276**；而夹具服务器的调用日志里恰好一条
`tools-call tally=205276`。→ **目录里没有描述，模型仍能凭描述里的词找到并调用它**。

**证据 B（目录确实只有名字）**：另一轮要求"不要调用、不要搜索，逐字引用 system prompt 里的延迟工具目录"。
模型逐字给出：

```
## Deferred tool catalog
The tools below stay deferred: only their names are listed here — neither their descriptions nor their parameter schemas are loaded. …
- mcp__probe__op
```

并明确评论"the catalog gives only the name; nothing is stated about its purpose"。
→ **names-only 在真实 prompt 里生效**，不是只在单测里成立。

**顺带复现了 O5**：这次真机上，一次连接期间服务器被拉起**两次**（日志里两个不同的 `server-start`
tally：651218、205276，调用落在第二个）。与 `OPEN-ITEMS.md` O5 记录的"夹具 MCP 每次连接起两个进程"
现象一致；本次没有抓时间差与父进程，**不足以定性，但把 O5 从"夹具观察"升级成"真机复现"**。

### F10 交付机制上，我们与 Claude Code **故意不同**（已确认，不是缺陷）

Claude Code 把延迟工具的**名字**放进 `<system-reminder>` 消息里（同上泄露稿：`Deferred tools appear by name in <system-reminder> messages`）——即**事件驱动、落在消息流**。

我们是**常驻 system prompt section**（`tool-search:catalog`，每次组装渲染）。这是设计文档决策 6/9 的
刻意选择，理由是：① 字节稳定，落在 prompt 缓存前缀上；② 不会被压缩丢掉（提醒是消息，压掉就没了，
而我们的守卫依赖"模型知道有哪些工具"）。代价是**每轮都付这份 token**。

**差异是真的，优劣不确定**：Claude 那套每轮零固定成本，我们的那套更抗压缩。要判定哪个更好需要
A/B（同一模型、同一 300+ 工具 profile、看"该搜没搜"的比例），本文没有这个数据，**不据此改机制**。

### F8 批量加载：Claude Code 明确要求"一次 select 装完"

chrome MCP 的服务器指令原话（同上泄露稿）：

> **batch every tool you expect to need into ONE ToolSearch call** … each separate ToolSearch call wastes a full round-trip.

我们天然满足：搜索命中即掀罩（schema 在结果里、工具同时在原生列表里），**不需要二次 select**
（这是 `docs/mcp-tool-search-design.md` §3 记录过的、我们比 Claude Code 快一步的点）。

---

## 2 · 待定项（每条都写清"凭什么、还差什么"）

### Q1 目录形态：names-only，还是 names + 用途？

**现有资料**：F1（Claude Code 只有名字）、F2（搜索吃全文）、F3（可发现性靠类别说明）。

**分析**：
- 保留用途的唯一好处是"模型不用搜就能判断该不该搜"。但代价是**必须截断**（否则 700 工具 ×
  ~400 字符描述 ≈ 28 万字符），而截断点必然在某处切掉区分性信息——这就是当前的风险。
- names-only 把"要不要用某个工具"完全交给搜索（全文索引），这是被 1 万工具量验证过的路径；
  代价是模型多一次往返（我们每次搜索都有 1 次往返成本，但命中即可调用，没有第二次）。
- **中间态更优**：目录按**服务器分组**给一行（`serena — 28 tools`），工具名逐行列出。这正好是 F3 的
  "类别级说明"，成本几乎为零（服务器数量 ≪ 工具数量），且比扁平 300 行更好扫。名字本身已自带
  服务器前缀（`mcp__<server>__<tool>`），所以分组几乎不增加字符。

**建议**：**names-only + 每服务器一行分组头**；删除 `descriptionChars` 与截断逻辑。
**结算条件**：改完后在真实工具集上量一次目录体积（chars/tokens），并在真机上跑一次
"给它一个只有用途里才出现的能力词、看它会不会主动搜并命中"。

### Q2 `maxDiscovered = 20` —— 从"无依据"升级为"可推导"

**现状**：`OPEN-ITEMS`/`IMPLEMENT-SESSION` 自认"没有权威依据（官方不设上限）"。

**新资料**：F4 的 **"超过 30–50 个工具后选择准确率显著下降"**。已发现工具是**掀罩**的，会和常驻工具
一起进工具列表——所以这个上限真正约束的是"**当前会话里模型面对多少个可选工具**"，不是内部状态大小。

**分析**：常驻工具（非 MCP 的内置工具 + 未延迟服务器）通常 10–15 个；20 个已发现 + 12 个常驻 ≈ 32，
正落在 30–50 的退化带下沿。**所以 20 不是随手写的，它恰好与 F4 相容**——只是当初没写出来。

**建议**：把这个推导写进注释与文档（`maxDiscovered + 常驻工具数 < 50`），并作为配置项开放，默认仍 20。
**结算条件**：真实会话里统计一次"淘汰发生过几次"；若几乎不淘汰，说明 20 够用；若频繁淘汰，
说明该上限应该按"已发现工具的平均 schema 体积"折成 token 预算，而不是按个数。

### Q3 中文查询：引导段一律要求英文，与实现能力不符 —— **已实测（2026-10-18）**

**现状**：索引对 CJK 用**字符二元分词**（`lib/tool-search-index.js:15-40`），中文查询**能命中**中文描述；
但引导段与参数描述都写"用英文关键词，非英文查询先翻译"（F7）。

**实测**（索引层直跑，`buildCatalog` + `searchCatalog`，不连接任何服务器）：

| 查询 | 描述语言 | top-1 | 结论 |
|---|---|---|---|
| `查找符号` | 中文 | ✅ `find_symbol` | CJK 二元分词生效（`tokenize("查找符号") = ["查找","找符","符号"]`） |
| `符号 定义 跨文件` | 中文 | ✅ `find_symbol` | 空格分词后同样命中 |
| `find symbol definition` | 中文 | ✅ `find_symbol` | **英文查询也能命中中文描述**——因为工具名是英文标识符，名字侧就命中了 |
| `读取文件内容` | 英文（`read_file`） | ❌ 落到 `list_dir` | **真正会漏的组合**：中文查询 + 纯英文描述 |
| `read file` | 英文 | ✅ `read_file` | 基线 |
| `read 文件` | 英文 | ✅ `read_file` | 混合写法可用 |

**分析**：BM25 是纯词面匹配（`DECISIONS` §11 已承认 bridging 不了派生/同义），所以跨语言只靠
**工具名**这一条救命通道。结论因此很具体：

- 服务器描述是**英文**（绝大多数 MCP）→ 现在"用英文查"是对的，而且比中文查更准；
- 服务器描述是**中文** → 英文查询也能命中（名字是英文），但如果中文查询被引导段劝退，反而少了半条路。

**建议**：措辞改成"工具名永远是英文标识符，**英文关键词最稳**；服务器描述是中文时，**中文关键词同样命中**"。
这句话既保留默认路径，又不再把中文描述那半边堵死。（**已按此实施**。）

**结算条件**：已完成（F9 的内容层量化）。剩余可选：拿更多服务器把 n 从 27 做大。

### Q4 `maxCatalogLines = 300` 的口径要重新量

**现状**：设计文档 §128 写"700+ 名字全量进 prompt 约 10 万字符（实测）"。但按旧代码每行含名字+截断用途，
这条实测几乎肯定**含用途**，而文档写的是"名字"——口径不清。

**口径已查实（2026-10-18）**：那个数出自 `docs/mcp-tool-search-design.md` 决策 9 —— **735 工具、正文 100,914 字符**。
`100914 / 735 = 137 字符/行`，而旧形态每行 = 名字(均 33) + ` — ` + 110 用途 ≈ 146 —— **对上了，所以那次的
"10 万字符"是含用途的**；文档写成"名字"是笔误。names-only 同规模约 **26k 字符**（每行 35.3）。

**已量到的（F9，27 工具）**：names-only 每行 = `2 + len(name)`，名字平均 33.3 字符 → **每行约 35.3 字符**。
按这个均长外推：300 行 ≈ **10.6k 字符 ≈ 2.6k tokens**；而旧形态同 300 行 ≈ 38k 字符。
**结论：`300` 这个上限在 names-only 之后偏保守**——同样的 token 预算现在能装约 3.6 倍的名字。
但**外推不是实测**（27 工具的名字分布不能代表 700 工具的分布），所以本轮**不动 `300`**：

**建议（下一轮）**：拿一台真实的大工具集（serena/deepwiki 之类 100+ 工具）抓一次真实 catalog 长度，
再决定是否把上限提高。**结算条件**：真实 catalog 的 `text.length / 工具数` 落到实测量级后，才允许改数。

### Q5 `NAME_BONUS = 12` / BM25 `k1=1.2, b=0.75`

**现状**：只有**变异测试**保证"这个分支真的起作用"（改坏→红），**数值本身没调过**。BM25 是标准默认值。

**分析**：`isExactName` 走 `Infinity` 短路，所以 bonus 只影响"非精确命中"的排序分辨率；在没有基准集的
情况下动它，等于用一个猜换另一个猜。

**建议**：**不动**。若将来要调，先建基准集（真实工具的查询-期望映射，至少 50 条），否则谁调都是猜。
**结算条件**：基准集存在之前，这一项不进任何"优化"任务。

### Q6 `requireDiscovery = true`

**现状**：已发现才放行，否则守卫返回"先搜再调"的指引错误。有变异用例锁住。

**建议**：**不开放给用户**。关掉它等于让模型凭记忆直接调未加载的 MCP 工具（schema 不在上下文里），
这是准确性灾难而不是"高级用法"。这条要写进"为什么不给配"。

---

## 3 · 本轮结论（**已实施，2026-10-18**）

| # | 决定 | 依据 |
|---|---|---|
| 1 | 目录改 **names-only**：每行 `- <name>`，不带用途、不带分组头 | F1/F2/F3 + Q1。分组头被否掉的理由见下 |
| 2 | **删除 `descriptionChars`** 及其截断逻辑；写进配置**显式报错** | F1（上游没有这件事）+ F5（110 无来源）+ C3 先例 |
| 3 | 同步改三处文案（F7）：工具描述、参数描述、引导段 | 否则文案与实现不符，等于又一处"看起来生效了" |
| 4 | `maxDiscovered` 保留 20，把"20 + 常驻 < 50"的推导写进注释 | F4 + Q2 |
| 5 | 中文查询措辞按 Q3 实测结果改 | Q3 |
| 6 | `NAME_BONUS`/BM25 不动；`requireDiscovery` 不开放 | Q5/Q6 |

**与初版方案的一处偏离（重要）**：原计划"names-only + 每服务器一行分组头"，实施时否掉了分组头——
`catalogSectionLines` 按**完整名字**做 code-unit 排序，而同一服务器的工具共享 `mcp__<server>__` 前缀，
**排序结果天然按服务器聚簇**；再加分组头只是把排序已经表达的信息写第二遍，还引入"截断落在服务器中间
怎么办"的分支。少一个分支 = 少一处可能出错的地方。

**改动面（实际）**

| 文件 | 改了什么 |
|---|---|
| `lib/tool-search-runtime.js` | `DEFAULTS` 删 `descriptionChars`；`resolveRuntimeConfig` 删该键、进 `REMOVED_KEYS`；`catalogSectionLines` 只输出名字；`catalogSectionText` 表头改写；工具描述/参数描述/引导段三处同步；`maxDiscovered` 补推导注释；`maxCatalogLines` 补口径注释 |
| `test/tool-search-runtime.test.mjs` | 目录形状用例改写成 names-only + 排序 + 上限；新增"描述一个字都不进目录"用例；`resolveRuntimeConfig` 增加 `descriptionChars` 报错断言；把"描述变了 → 目录跟着变"改成"描述变了 → **搜索能搜到新词**"（目录不再承载这个观测量） |
| `docs/mcp-tool-search-design.md` | §3 更正"名字 + 一行用途"的误述；§12 的"descriptionChars 不进测试"加更正块 |

**验收**

| 项 | 结果 |
|---|---|
| 0.2.0-rc.2 基线 `node --test` | **799 / 799** |
| 0.2.1-rc.2（cordis 4.0.5 + loader 1.0.6，排除 package-contract） | **751 / 751** |
| 目录体积 | **已实测**（F9，n=27）：names-only 954 字符 vs 旧形态 3401 字符 = **28%**。全生态均长仍待更大样本 |
| 描述截断的危害 | **已实测**（F9）：56% 的描述会被切；其中 80% 的尾巴带约束/条件词 |

---

## 4 · 实施与验收（做的时候照这个走）

**改动面**
1. `lib/tool-search-runtime.js`：`catalogSectionLines` / `catalogSectionText`（形态）、`DEFAULTS`（删一个键）、
   `resolveRuntimeConfig`（删一个键，写进来的旧配置**显式报错**，与 `threshold`/`minServerTools` 同待遇）、
   三处文案。
2. `lib/tool-search-index.js`：无需改（搜索一直吃全文）。
3. 用例：`test/tool-search-runtime.test.mjs`（目录文本形状、分组、上限）、
   新增 `test/loader-compat` 式常驻守卫不必动；`test/tool-search-real-host.test.mjs` 里任何断言目录
   内容的用例要跟着改。
4. 文档：`docs/mcp-tool-search-design.md` §3 更正"名字+一行用途"的误述；`docs/design.md` 记这次取值决策；
   `docs/installation.md` 若提到参数则同步。

**验收（缺一不算完）**
- `node --test`：0.2.0 基线全绿；0.2.1（cordis 4.0.5 + loader 1.0.6）矩阵全绿。
- 目录体积：给出 names-only 前后的**可复算数字**（每行均长 × 行数）。→ 已做，见 F9。
- 真机：在 `dsh web` 里让模型用一个"只在描述里出现的能力词"触发一次搜索并命中（证明 names-only
  没有把可发现性丢掉）。→ **已做**，见 F11（用隔离 `DSH_HOME` 的 `dsh headless`，两条证据：
  真调用 + 逐字引用目录）。

---

## 5 · 怎么复核这份记录（F9 的复现配方）

F9 的数字来自一个一次性探针（用完即删，不进仓库）。复现步骤：

1. `npx -y @modelcontextprotocol/server-filesystem <某个临时目录>` 与
   `npx -y @modelcontextprotocol/server-everything`——两台都是官方参考服务器，stdio、无外部依赖；
2. 按 MCP 握手发三条：`initialize`（id 1）→ `notifications/initialized` → `tools/list`（id 2），
   读 id 2 的响应即得全部 `{ name, description }`；
3. 统计：名字长度、描述长度、`description.length > 110` 的比例、被切尾巴的字符数、
   尾巴里是否命中 `only|not|never|when|unless|without`；
4. 目录体积：`old = Σ(2 + len(name) + 3 + min(desc,110))`、`new = Σ(2 + len(name))`。

**结果必须能复算**：任何人重跑这三步都应得到 27 个工具、56% 超 110、目录降到约 28%。
若未来某个版本这些数字明显不同（比如描述普遍变短），F9 的结论要重新评估——
**它证明的是"截断会切掉区分性信息"，不是"永远都会"。**

---

## 6 · 合规自检（2026-10-18 收尾时逐条过）

| 检查项 | 结果 |
|---|---|
| 没有残留的模型可见截断 | ✅ `lib/tool-search-*.js` 里 `slice(0, N)` 只剩两处**非模型可见**用途：词干化（`index:73-75`）与目录行数上限（`runtime:341`）。另 `mcp-observability:69` 截 2000 字符的是**面板里给人看的日志**，不进 prompt |
| 删除的键不会被静默忽略 | ✅ 进 `REMOVED_KEYS`，写进来抛错。⚠️ **诚实说明**：插件类目前没有 `Config` schema（`DECISIONS.md` F9），所以这个守卫今天**只能被内部调用方/测试触发**，不是面向终端用户的报错路径。它的作用是挡住将来的 C2 配置面把该键悄悄带回来 |
| 没有新增"看起来生效"的分支 | ✅ `descriptionChars` 从 `DEFAULTS`/`resolveRuntimeConfig`/`viewRevision` 三处一起删，没有留下读它但没人写的地方 |
| 文案与实现一致 | ✅ 三处模型可见文案（工具描述/参数描述/引导段）+ 目录表头 + 截断提示全部同步；两处历史误述（design §3 的"名字+一行用途"、runtime 里"中文查询零命中"）已更正 |
| 测试断言的是行为而非常量 | ✅ 目录形状用例断言**输出文本**；新增"描述一个字都不进目录"把"无截断"变成可断言性质；`descriptionChars` 用例断言**抛错**而不是断言某个默认值 |
| 两套宿主矩阵 | ✅ 0.2.0 = 799/799；0.2.1（cordis 4.0.5 + loader 1.0.6）= 751/751 |
| 真机点穿 | ✅ 隔离 `DSH_HOME` + 真模型：描述里的能力词仍能搜到并调用（tally 与调用日志一致），目录逐字只有名字（F11） |
| 未把"推导"写成"实测" | ✅ 体积在 F9 里是实测（n=27），对 700 工具的外推在 Q4 里明确标为**外推**，并规定"落不到实测量级不许改 `maxCatalogLines`" |

