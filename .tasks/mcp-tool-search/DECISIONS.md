# MCP ToolSearch × PTC：决策记录（第十轮）

> 本文是**讨论收敛后的决策记录**，不是调研报告。原始证据在 `OPEN-ITEMS.md`。
> 下面标【实测】的是真宿主跑出来的，标【读码】的只有代码依据。**没有实测的不要当已验。**

---

## 0 · 为什么写这份

第九轮做完调研（零代码改动），结论写进 `OPEN-ITEMS.md` 的 O6/O7/O8 与
`docs/mcp-tool-search-design.md` §12.6。第十轮独立复核时发现**第九轮有一条断言是错的**，
而错的那条正好是"方案"的地基。本文件记录复核后的最终决策，并更正失效的历史记录（见 §7）。

---

## 1 · 核心事实（复核结论）

| # | 事实 | 依据 |
|---|---|---|
| F1 | 插件只作用于**函数清单**（`assembly.tools`）这条投影。PTC 下模型看的是 **`tools:sdk` 手册**，插件打空 | 【实测】真宿主多 agent 对照：PTC 下 `wireSchemas=1`（只有 `run_code`）、`assembly.tools` 里 mcp 数 = 0 → 遮罩是 **no-op** |
| F2 | PTC 下插件**净亏** | 【实测】35 工具：不装插件 12651 字 / 装了 15510 字 = **+2859** |
| F3 | 官方**已导出** `renderToolsSdk` / `renderToolsSdkPy` / `jsonSchemaToTs` / `jsonSchemaToPy` | 【实测】`dsh-tools/lib/index.js:3714`；`ts-types.d.ts:36`；`py-types.d.ts:48`。第九轮"渲染器不在公开面上"**错误** |
| F4 | 可用官方渲染器**干净重渲染一个子集**，不需要解析生成物 | 【实测】`renderToolsSdk(sdkSchemas(agent))` 与官方生成的 `tools:sdk` 段**逐字节相等** |
| F5 | 裁手册后**真省** | 【实测】12651 → **7431 字**（净省 5220） |
| F6 | PTC 下闭环**是通的**，只有"省地方"失效 | 【实测】真 `dsh-ptc-runtime-node` 跑真程序：守卫拒 → `tool_search` → 调通 |
| F7 | 嵌套派发**绕过 `collapses` 但走完整管线含我们的 guard** | 【实测】真 token 四向对照：`tool_search` ✅ / 未发现被拒 ✅ / 发现后执行 ✅ / 直调被 `collapses` 拒 ✅ |
| F8 | 官方**没有**那两道门槛，也**不设发现集上限** | 【实测抓取】[code.claude.com/docs/zh-CN/mcp](https://code.claude.com/docs/zh-CN/mcp)：默认全延迟；`auto`/`auto:N` 按**体积**百分比；豁免靠用户写 `alwaysLoad`；原话「Claude Code 不会对每个服务器施加固定的工具上限；实际限制是你的上下文窗口预算」 |
| F9 | 面板**一个参数都没暴露**；而且这些参数**根本不可配** | 【读码】面板只有两个布尔开关：`lib/client.js:2774`（复选框）、`:2780-2784`（预告）。参数侧：`lib/index.js:1133` 只向 `installToolSearchRuntime` 传了 `deferServers` / `serverNames`，**插件类没有 `Config` schema**（`lib/index.js` 导出只有服务类，构造函数 `constructor(ctx)` 不接 config）→ `threshold` / `minServerTools` / `maxDiscovered` / `maxResults` / `maxCatalogLines` / `descriptionChars` / `stem` **全是硬编码 `DEFAULTS`，用户在任何地方都改不了**。⚠️ **第十轮复审更正**：本条原写"7 个参数只在配置文件里"是**错的**，见 §9 #1 |
| F10 | `deferring=false` 时 `tool_search` 仍可见，返回**空结果 + 指向不存在的目录段** | 【实测】12 工具探针：`matches:[]` + `instruction:"...or consult the deferred tool catalog section of the prompt."` |
| F11 | `applyServerFloor` 的 `>` 是**四处共编码**的语义 | 【实测】变异复验 `>`→`>=` → **恰好 1 条红**（`test/tool-search-runtime.test.mjs:51`） |
| F12 | 仓里有一条测试**明确编码了"PTC 下不装"** | 【读码】`test/tool-search-wiring.test.mjs:423`：`assert.equal(mounted.registered.includes('tool_search'), false)` |
| F13 | 官方中文**两词并用**：状态叫「延迟」、效果叫「按需加载」 | 【实测抓取】同 F8 页面：「延迟服务器的工具」/「豁免服务器不延迟」/「工具搜索默认启用：MCP 工具被延迟并按需发现」 |
| F14 | **公开面与 private 面要分清**：`renderToolsSdk` / `renderToolsSdkPy` 是**导出**的；但 `sdkSchemas` 与 `modeFor` 在类型声明里是 **`private`** | 【读码】`dsh-tools/lib/types/index.d.ts`：`:711 schemas(scope?)` 公开、`:730 get(name, scope?)` 公开、**`:713 private sdkSchemas`**、**`:587 private modeFor`**。仓里无 typecheck（`package.json` 只有 `node --test`），所以 private 不阻断运行，但**依赖它要显式记账 + feature-detect** |
| F15 | 目录段列的是 **`managed` 全集（含已发现的）**，引导段挂在 `deferring` 上 | 【读码】`buildToolSearchView`：`buildCatalog([...managed.values()])`；`assemble` 钩子用 `view.deferring` 决定追加目录/摘掉引导，`filterManagedTools` 才用 `managed − discovered`。→ **全部发现之后，目录与引导仍在，且文案"stay deferred / Some tools are deferred"是假话**（F16 同类） |
| F16 | 淘汰**无条件调用**：一次"什么都没搜到"的搜索也会触发淘汰 | 【读码】`tool-search-runtime.js:495`：`clampDiscovered(...)` 在 `execute` 里无条件执行，`discoveredNow` 为空也照跑。FIFO 下是"慢慢收敛"看不出问题；**换成"最多踢一半"后，一次空搜索会当场踢掉一半** |
| F17 | `requireDiscovery: false` 与"裁 SDK"**语义冲突** | 【读码】`DEFAULTS.requireDiscovery: true`，为 false 时 `guardDecision` 直接放行（`:176`）。此时若裁掉手册签名 = **藏了签名却允许盲调** = 本项目明令禁止的"半失效" |
| **F18** | 🔴 **PTC 下发现集根本无法从会话恢复**——现有 `discoveredFromMessages` 在 PTC 会话里是**空操作** | 【实测】真 PTC 运行时跑真程序（程序里调 `tool_search`）后：`deriveMessages()` 返回 **0 条**；会话日志里只有 `tool/ptc-dispatch-start` / `tool/ptc-dispatch`。原因：`SURFACE_EVENT_TYPES = {system/message, developer/message, user/message, assistant/message, tool/result}`（`dsh-session:154-160`）**不含 ptc-dispatch** → 它不产消息 |
| **F19** | ✅ **`sessionProjections` 就是为这种状态准备的机制，且对 native 与 PTC 都成立** | 【实测】① `apply` 能收到 `tool/result`（造一条 append 事件 → 收到）与 `tool/ptc-dispatch`（真 PTC 程序 → 收到）；② `stateOf(session,key)` 分别还原出 `["mcp__rv__t7"]` 与 `["mcp__rv__t3"]`；③ `register` 支持**无 `wire`** 的内部投影（`dsh-session-projection:159` 重载），状态不暴露给客户端；④ `stateSchema.parse` **只在从持久化行恢复时**跑（`:255/:297`），不在每次 apply；⑤ 一等公民先例：`dsh-agent-loop` / `dsh-goal` / `dsh-plan-mode` / `dsh-permission-presets` / `dsh-sandbox-policy` 等 10 个包都在用；⑥ 本插件**已依赖 `zod` 4.4.3**，无需新依赖 |
| **F20** | **不能靠扫会话日志**：`snapshotEvents` / `eventAt` / `ownEvents` 全部标了 `@deprecated`「new calls are prohibited」 | 【读码】`dsh-session/lib/types/index.d.ts:177/187/196` |
| **F21** | ✅ **宿主有 agent 注册表**：`ctx.agents.list(): Agent[]` / `get(id)` 是官方服务，`dsh-base` 已经挂了 `@deepseek-ai/dsh-agent` | 【实测】挂载 `AgentRegistry` 后：`agents 服务挂上 = true`、`list 是函数 = true`、空注册表返回 `[]`；公开方法含 `get/list/roots/create/register/isOwnedBy`。源码 `packages/core/agent/src/index.ts:245`（`super(ctx,'agents')`）、`:588 list()` 返回 `entry.agent`。⚠️ 我此前"插件枚举不到 agent"的断言是**错的**。**残留**：「`list()` 返回的就是 `context.agent` 那批对象」仍是**读码**结论（要证它得造真 agent，需 `setFactory`，本轮没做） |
| **F22** | ✅ **只用公开 API 就能重建宿主渲染 `tools:sdk` 的原输入**，逐字节相等 | 【实测】`schemas(scope)`（公开）给 name/description/parameters，逐工具 `get(name, scope)`（公开）补 `output.schema`，喂给导出渲染器 → **与宿主段文本逐字节相等 = true**。所以 private `sdkSchemas` **不是必需的**；代价是逐工具 `get()`（701 工具 ≈278ms vs `sdkSchemas` ≈15ms），按 revision 缓存即可 |
| **F23** | ✅ **真机 UI 可以验**：`dsh web` 启动时把带 token 的 URL 打到 stdout | 【实测】`DSH_HOME=<temp> dsh web --no-open --port 0` → `dsh web: http://127.0.0.1:55192/?token=zfM6…`。此前"隔离实例返回 401"是因为**没拿这个 token**，不是拿不到 |

### 1.1 一条关键的架构事实：PTC 的发现路径与 native 不同

| | native | PTC |
|---|---|---|
| 发现延迟工具 | **直接调** `tool_search` | **不能直调**（只有 `run_code` 能直调），必须**写一段程序**调用它 |
| 代价 | 一次调用 | 多一层间接 + 多一次程序执行 |

**PTC 下目录段照常追加**（【实测】：`deferring` 为真时目录段在）。
所以模型看到的是互补的两块：**目录段给"有什么"（名字+用途），手册给"怎么调"（签名）**。
模型不需要猜名字。

---

## 2 · 已定决策

| # | 决定 | 理由 |
|---|---|---|
| **B1** | **去掉两道门槛**（per-server ≤10 / 会话级 <15）→ 用户勾了就生效 | 官方没有这两道（F8）。门槛制造"勾了没效果"的断层，且是代码替用户猜他的处境 |
| **B2** | 用官方导出的渲染器**重渲染子集**，不自建解析器。**取数优先走公开 API**（`schemas(scope)` + 逐工具 `get(name, scope)` 补 `output`）；`sdkSchemas` 仅作**可选快路径** | F3/F4/F14/**F22**。第九轮那套（`renderKey` 裸标识符、别数花括号、两个 map 同步删、Python 另写判据、三条自检）**全部不需要**。🔴 **第三轮更正**：原写"必须走 private `sdkSchemas`，拿不到就放弃裁剪"——**错**。实测**只用公开 API 重建的文本与宿主原文逐字节相等**（F22），所以 private 依赖**可以整个去掉**。差别只是代价：公开路径要逐工具 `get()`（701 工具约 278ms，`sdkSchemas` 一次约 15ms），因此**按 revision 缓存**（每次工具集变化预热一次，不是每次组装）。`sdkSchemas` 存在时当快路径用，不存在不影响正确性。🆕 **0.2.1 起渲染器多一个 `programFormat` 参数**（见 §10）→ 有值才转发 |
| **B3** | **自检强制**：`renderToolsSdk(全集) !== 官方原文` → **退回原文** | 不变量：**只可能变好**，最坏 = 现状（净亏）。⚠️ **第十轮复审更正了保护范围**：因为我们 import 的是**同一个已安装包**里的渲染器，官方升级时两边一起变，**这个等式并不是"版本漂移探测器"**。它真正检测的是**"我算出的输入 ≠ 宿主渲染用的输入"**（别的插件改写了这个 section、scope 取错、宿主改成后处理）。仍有价值，但别把话说大 |
| **B4** | `both` 模式**不做任何专门工作** | 两条事实：**当前运行的 0.2.0 有 `both`**（插件现在完全不装，没东西是坏的，只是没保护）；**0.2.1 已把 `both` 从 `ToolPresentationMode` 删除**（§10）→ 相关分支将变成死代码。所以：0.2.0 上保持"不启用"，0.2.1 起按纪律**清掉指向 `both` 的分支与注释**，不新增 any `both` 行为 |
| **B5** | **不向 DSH 官方提需求** | F3：官方已导出渲染函数，不需要求人 |
| **B6** | PTC 手册里**保留 `tool_search`** | 它是模型唯一的搜索入口；且在程序里调它**不会**被 `collapses` 拒（F7），是个真能用的工具 |
| **B7** | 淘汰算法换 **LRU**：`Map<name, lastUsedTick>` 单一数据结构 | 去掉"靠 `Set` 迭代序 = 插入序"这个**隐式契约**。`tools.guard` 本来就是"每次调用都经过"的现成钩子，记录使用**几乎零成本** |
| **B8** | **发现时播种 `lastUsed`** | 治"批量发现集体阵亡"：一次 `select:` 8 个、用完不再碰 → 纯 LRU 会把整批一起踢掉，而模型可能还要再调其中一个 |
| **B9** | 淘汰量 = `min(size − cap, max(1, floor(size/2)))` | 只踢到 cap 所需，且一次不超过当前一半；`lastUsed` 最大的那批（含刚发现的）永远踢不到。**公式在此修正过**，见 §2.1 |
| **B10** | 淘汰**只在发现集增长时**触发（`discoveredNow.length > 0`） | F16。否则一次"什么都没搜到"的搜索会当场踢掉一半——反直觉且没有理由 |
| **B11** | 三处投影统一到同一个集合 **`D = managed − discovered`**。但**搜索索引仍建在 `managed` 上** | F15。现在 assembly 遮罩用 `D`、目录段用 `managed` 全集、引导段用 `deferring`。统一之后：① 一个不变量覆盖三处；② `D = ∅` 时目录与引导一起消失，模型不再读到"stay deferred"这种假话；③ 目录变小。⚠️ **复审再修正**：① 搜索索引若也建在 `D` 上，每次发现都要重建索引（735 工具 52.8ms）——所以 **索引留 `managed`（可被 revision 缓存），只把"显示的目录文本"按 `D` 过滤**；重复搜到已发现的工具无害。② 目录文本变成依赖 `discovered`，而视图缓存只按 revision——**必须给目录文本单独按 `(revision, discoveredVersion)` 缓存**，否则每次组装重算（735 工具 ~11ms） |
| **B12** | 裁 SDK 额外要求 **`requireDiscovery` 为真** | F17。否则藏了签名却允许盲调，正是我们定性为不可接受的"半失效" |
| **B13** | `tool_search` 的明确报错判据是 **`managed = ∅`**，不是 `D = ∅` | 两个"空"含义不同：`managed = ∅` = 一个延迟服务器都没有（用户全关 / 总开关 off）→ **明确报错**；`managed ≠ ∅` 但 `D = ∅` = 都发现了 → **正常返回**（再搜一次合法）。写成 `D = ∅` 会把后者误判成错误，语义不通 |
| **B14** | `deferring` **拆成两个概念** | `hasDeferredServers = managed.size > 0`（给 guard 与搜索）；`hasDeferredWork = D ≠ ∅`（给目录段 / 引导段 / SDK 裁剪）。现在一个布尔身兼两义，B11 之后必须分开，否则"都发现了"仍会被判成"还有活要干" |
| **C1** | 搜索结果补 **"参数 + 返回类型"**，**按模式门控** | **PTC 下必需**（手册本来就给参数+返回；只还参数 = 比不延迟时更少 = 半失效）；**native 下不给**（原生调用没有"返回类型"这个契约，加了是噪声）。拿不到语言就不给，退回现状 |
| **C2** | 面板暴露**全部影响体感的参数**；并且**"本会话真实生效状态"现在是可做的** | F9（参数不可配）+ 🔴 **F21**（`ctx.agents.list()` 存在）。**第三轮更正**：我原先断言"插件枚举不到 agent、宿主没给注册表"——**错**。`AgentRegistry.list(): Agent[]` 是官方服务（`dsh-base` 已挂 `dsh-agent`），返回的正是 `context.agent` 那批对象，所以**我们的 per-agent `WeakMap` 可以直接查到状态**。可选显示：活跃会话数、其中多少在延迟、各服务器被延迟的会话数、已发现工具数。⚠️ 仍需产品决定"给谁看/显示到哪一层"（面板是 per-config，得选一个展示位）。工作量因此**明显大于**原估——但方向是"能做"，不是"做不到" |
| **C3** | `applyServerFloor` / `minServerTools` **整个删掉** | B1 之后它们是**死代码**。留着会被后人当"还在生效"。配置里写了已废弃键 → **显式报错**，不静默忽略 |
| **C4** | 用 **`sessionProjections` 持久化发现集**（native + PTC 通吃），缺席时退回 `discoveredFromMessages`；投影**只在恢复时读一次**，运行期状态仍是 per-agent `WeakMap` | 🔴 **原方案（按消息顺序播种）在 PTC 下是空操作**（F18 实测）。F19 实测：投影能同时收到 `tool/result`（native）与 `tool/ptc-dispatch`（PTC），`stateOf` 两条都还原成功，且是官方机制、插件已有 zod、无需新依赖。三条约束：① **状态必须有界**（按配置剪枝，否则长会话无限增长）；② **`apply` 必须始终返回状态对象**（探针里写成 `=> undefined` 会直接把状态设成 undefined）；③ 投影是**按 session** 的，而运行期状态是按 agent 的——所以只拿它做"恢复时的种子"，避免"一会话多 agent 共享"的语义变化。`lastUsed` 首版**不持久化**，恢复时按发现顺序播种（自愈，见 §8） |
| **C5** | 淘汰**不给模型信号** | 淘汰发生在搜索那一刻，模型当时无法判断要不要用被踢的；真出事时**守卫的报错**是精准反馈。预告知 = 每次搜索都多一段，收益低。（曾提议"搜索时列出被淘汰的"，已撤回。） |
| **C6** | 非 native 会话下 `tool_search` 一直可见；PTC 手册里保留它 | 同 B6。**无问题**：目录段与手册互补，模型不需要猜名字 |

### 2.1 B9 的收敛过程（验算，含一处**已修正的错误**）

**正确公式**（原来只写了"最多踢一半"，不够）：

```
remove = min(size − cap, max(1, floor(size / 2)))
```

即：**只踢到 cap 为止所需的量**，且**一次不超过当前的一半**。

> 🔴 本节初版把"最多踢一半"当成了"每次踢一半"，于是算出"30 → 踢 15 → 剩 16"——**错的**。
> 正确是 `min(size−cap, k)`：30 个、cap 20 → 只需踢 **10** 就到 20。

| 场景 | 结果 |
|---|---|
| 常规（size 21，cap 20） | deficit 1、k=10 → **踢 1**，与旧 FIFO 行为相同 |
| 一次 `select:` 30 个（cap=20） | 下限抬到 30（本批长度）→ **一个都不踢**（现有保护继续生效） |
| 之后发现 1 个（size 31） | deficit 11、k=15 → **踢 11 → 20**（一步到 cap，且只拿走"较冷的"） |
| 再发现 1 个（size 21） | deficit 1 → **踢 1**，稳定 |
| 极端：cap 从 100 调到 20（size 100） | 100→50→25→20，**3 步收敛**（每次 deficit 都 > 一半，所以一半上限真正生效） |

**"不超过一半"什么时候真正起作用**：只在 `size − cap > floor(size/2)` 时（即 cap 远小于当前规模）。
平时踢的永远是"刚好够到 cap"的量——**这就是"一次别踢太多"的正确形态**。

**为什么不会误伤刚发现的那批**：B8 在发现时就把 `lastUsed` 播种为当前，所以刚 `select:` 进来的一批
一定排在最新端；要淘汰时按 tick 从小到大取，**永远先取到旧的**。

**代价（显式记账）**：`size − cap > 一半` 的极端情况下需要多轮才收敛；这段期间多出来的 schema
**本来就已经在提示词里**——不是新增开销。与现有 `clampDiscovered` 注释里承认的取舍同类。

---

## 3 · 要改的地方（按阶段）

> 标 🆕 的是**第十轮复审后新增**的（见 §9）。

1. **先写失败用例**：PTC 会话的 `tools:sdk` 不得含未发现的延迟工具；已发现的必须在里面（含 `tool_search`）。
   **同时改写** `test/tool-search-wiring.test.mjs:423`（F12：它编码了旧决定，会当场红）。
   —— 改写，**不是删掉**。新的不变量是"PTC 下也要装，且手册里不含未发现的延迟工具"。
2. **统一延迟集 `D = managed − discovered`**（🆕 B11）：装配遮罩 / 目录段 / 引导段 / SDK 裁剪四处全部改用它。
   `D = ∅` 时目录与引导一起消失（F15：现在会留下"The tools below stay deferred"的假话）。
   🆕 **索引仍建在 `managed`**，显示文本按 `D` 过滤 + 按 `(revision, discoveredVersion)` 缓存（B11 修正）。
   🆕 `deferring` 拆成 `hasDeferredServers` / `hasDeferredWork`（B14）。
3. 🆕 **发现集持久化换 `sessionProjections`**（C4 修订，F18/F19）：注册一个**无 wire** 的内部投影，
   `apply` 同时 fold `tool/result`（native）与 `tool/ptc-dispatch`（PTC）；恢复时 `stateOf` 读一次做种子；
   服务缺席则退回 `discoveredFromMessages`。**这是 PTC 下唯一能恢复发现状态的正当路径**——
   注意 `snapshotEvents` / `eventAt` 全标了禁止新调用（F20），不许用。
4. **裁手册**：B2（**取数走 `sdkSchemas`，feature-detect，拿不到就放弃 + 告警**）
   + B3（逐字节自检，不等退原文）+ 🆕 B12（`requireDiscovery` 为假则不裁）
   + 🆕 **转发 `runtime.programFormat`**（§10 V2：0.2.1 的渲染器多这个参数，不传就自检失败）。
5. **装配判据改 per-agent**：装配点（`lib/index.js:1131` 附近）现在读 `ctx.tools.modeFor()` 无参 =
   **部署默认层**，改成**无条件安装**、让每个 agent 自己判（`ctx.tools.modeFor(agent)`）。
   这同时修好"整机 PTC"。🆕 **判据精确化**：`native`/`ptc` 都要**启用**，**只有 `both` 是 inert**
   （§11.4）——写成"非 native 就 inert"会把 PTC 又关掉。
   🆕 **同时做能力探测层**（§11.3）：`modeFor` / `sdkSchemas` / `sessionProjections` / `programFormat`
   各探测一次，缺失按退化表处理并**日志一次**。
   🆕 **`tool_search` 重名预检**（§11.4 ①）：被占用则换名 + 日志，**不许让整个插件装载失败**。
6. **去门槛**：B1 + C3（删 `applyServerFloor` / `minServerTools`）+ 改写 6 处断言 + 面板文案。
7. **`tool_search` 明确报错**：🆕 判据是 `managed = ∅`（B13），不是 `D = ∅`。
   替掉现在那个"空结果 + 指向不存在的目录段"（F10）。
8. **搜索结果补类型文本**（C1，按模式门控）。
9. **LRU + 最多踢一半 + 只在增长时淘汰**（B7/B8/B9/🆕 B10）+ 三条新单测。
   🆕 注意 `clampDiscovered` 是**导出面**，`Set → Map` 会连带改它的签名与现有测试。
10. **面板暴露参数**（C2，独立阶段；🆕 工作量已重估——这是第一次引入配置面）。
11. **更正历史记录**（§7）+ `node --test` 全量 + `git status` 干净 + **撤掉改动看红**。
12. 🆕 **兼容性用例**（§11.6）：五条护栏用例 + 反证。**只写 0.2 内部真会触发的**，不为 0.1.x 写。
13. 🆕 **改 `peerDependencies`**（§11.5）：`">=0.2.0-rc.1 <0.3.0"`（**只支持 0.2.x**）。
14. 🆕 **显式记录 `both` 的尴尬状态**：装配无条件后，`both` 下插件 inert，但 `tool_search`
    仍注册且可直调，返回"没有启用延迟加载"的明确错误。**不是 bug，要写进文档**
    （否则下一个人会当 bug 修）。0.2.1 起 `both` 已不存在，本条只在 0.2.0 上有意义。

---

## 4 · 受影响清单

### 4.1 要去门槛、必须改写的断言

| 位置 | 现在钉的是什么 |
|---|---|
| `test/tool-search-runtime.test.mjs:51` | `applyServerFloor` 的 `≤10 不延迟` |
| 同上 `:151-157` | `deferring` 的 true/false 两向 |
| 同上 `:162-164` | **恰好等于 threshold 才启用**（`>=` 语义） |
| 同上 `:173-174` | 聚合 ≥15 启用，`≤10` 的服务器不参与 |
| 同上 `:241-251` | `threshold` / `minServerTools` 的默认值与参数校验抛错 |
| `test/tool-search-real-host.test.mjs:219` | 真宿主：`deferNothing` 时机制不启用 |
| `test/tool-search-wiring.test.mjs:423` | **PTC 下不启用 ToolSearch**（要改成新的不变量） |
| `test/tool-search-runtime.test.mjs:93-99` | 🆕 `clampDiscovered` 直接喂 `Set` 并断言内容——改 Map + 部分淘汰后这条必须改写 |

### 4.1.1 🆕 复审新增的两个必须写的用例

| 用例 | 为什么 |
|---|---|
| `D = ∅` 时**目录段与引导段都不出现** | F15：现在会留下「The tools below stay deferred」/「Some tools are deferred」的假话；B11 的验收 |
| `requireDiscovery: false` 时**不裁手册** | F17/B12 的验收；撤掉该判据必须红 |

### 4.2 产品代码

- `lib/tool-search-runtime.js` —— 主战场：装配、视图、guard、目录段、搜索、淘汰。
- `lib/index.js` —— 装配点（`:1131`）、`summarize`（`:486-487`）。
- `lib/tool-search-config.js` —— 配置桥，**不动**（门槛不在这）。
- `lib/client.js` —— 文案：`:2282`（徽标）、`:2513-2514`（详情行）、`:2774` / `:2780-2784`（表单与预告）。

### 4.2.1 🆕 对宿主 private 面的依赖（必须显式记账）

| 依赖 | 声明可见性 | 用途 | 拿不到时 |
|---|---|---|---|
| `ctx.tools.modeFor(agent)` | **private**（`index.d.ts:587`） | 每个 agent 的有效呈现模式 | 已经有 runtime guard（`typeof === "function"`）；缺了就按 native 处理 |
| `ctx.tools.sdkSchemas(scope)` | **private**（`index.d.ts:713`） | 取宿主渲染 `tools:sdk` 的**原输入**；传 `context.scope`（不是 `agent`），保证与宿主渲染时同参 | **放弃裁剪 + 告警**，绝不退化成"猜输入" |
| `ctx.get('sessionProjections')` | **公开服务**（`dsh-session-projection`），非 private | 注册内部投影持久化发现集（F19） | 退回 `discoveredFromMessages`（native 可用、PTC 降级为不恢复） |

前两处要在代码注释里写明"这是 private 但有据可依：宿主自己就是用它渲染"，
并且**都在 try/catch 里 fail-safe**。仓里没有 typecheck（`package.json` 只有 `node --test`），
所以 private 不会让构建红，但**不能让下一轮误以为它是公开契约**。

⚠️ `sdkSchemas` 必须传 **`context.scope`** 而不是 `agent`：宿主 `sdkSection` 的 `text` 用的是
`context.scope`（真宿主里两者通常相同，但逐字节自检要求**同参**）。

### 4.3 文案方向（F13 定的映射）

- **状态**（徽标 / checkbox / 详情行"已开启"）→ **「延迟」**（英文 `Deferred`）
- **效果**（tooltip / 引导语 / 承诺句）→ **「按需加载」**（英文 on demand）
- 现在的毛病：`延迟加载工具（ToolSearch 按需搜索）` 把两词塞进一个标签；
  `已开启（N 工具经 tool_search 按需加载）` 用**状态数据说效果话**
- 代价：i18n 字典中英两侧都要改，`i18n-parity` 会强制同步（这是好事）

---

## 5 · 验证计划

### 5.1 要补的用例（先红后绿）

1. **PTC 会话的 `tools:sdk` 不得含未发现的延迟工具**；已发现的必须在里面（含 `tool_search`）。
2. 同进程 **native 会话对照**：遮罩 / 守卫 / 目录 / 手册全照旧（防回归）。
3. **自检失败路径**：喂一个与官方渲染器不一致的输入 → 断言**退回原文**，不发坏文本。
4. **LRU 三条**：① 刚发现的一批不被当场淘汰；② 常用工具在持续搜索下不被淘汰；
   ③ 一次批量最多踢一半。
5. 🆕 **恢复**：真 PTC 会话（程序里调 `tool_search`）→ 用投影还原发现集；
   native 会话（`tool/result`）同样还原。**这条是 PTC 下唯一能证明"发现不丢"的用例。**
6. 🆕 `D = ∅` 时目录段与引导段都不出现（B11/B14 验收）。
7. 🆕 `requireDiscovery: false` 时不裁手册（B12 验收）。
8. 🆕 `managed = ∅` 时 `tool_search` 明确报错；`managed ≠ ∅` 且 `D = ∅` 时**正常返回**（B13 验收）。

### 5.2 反证（撤掉改动看红）

- 撤掉裁剪 → 用例 1 红。
- 撤掉 B9 的一半限制 → 用例 4③ 红。

### 5.3 已知证据缺口（不要当成已验）

- **真机 UI 从没点过 preset 卡片**。第九轮与第十轮都只做到"出货文件 + 真 `--dump-config` +
  客户端 roster 代码"，隔离实例 `8917` 返回 **401（需鉴权）**。可达性是**文件级证据**，不是点击证据。
  🆕 **第三轮更正（F23）**：401 的根因是**没取 token**。`dsh web --no-open --port 0` 会把
  `http://127.0.0.1:<port>/?token=…` 打到 stdout（**已实测抓到**），所以这条缺口**可以补**，
  配方见 `IMPLEMENT-PLAN.md` 的 S10。**在真跑之前，它仍然是缺口**——别把"有配方"当成"已验证"。
- **`both` 模式下裁手册**没测。技术可行（遮罩在 `both` 有效、手册可裁），但 B4 决定不做
  ——**因为 0.2.1 已删除该模式**，不是做不到。
- **`complete section` 部署**下裁手册的交互没测（那种部署会吞掉所有 section，裁了也没用——
  但目录段本来也被吞）。

---

## 6 · 环境配方（前几轮真金白银换来的）

- node 在 `D:\soft\nodejs\node.exe`；测试命令 **`node --test`**（不是 `node --test test/`）。
  全量约 10–18s，**基线 738 绿**（第十轮实测确认）。
- **绝对不要动用户的 `web` profile**（`~/.dsh/profiles/web`），也**不要点杀父进程是
  `dsh lib/bin.js web` 的 serena**。`~/.dsh/storages/workspace.json` 全 app 共享。
  **读**用户 profile 可以（只读不写）。
- 宿主包在 `C:\Users\zhanglu\AppData\Local\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\`。
- **探针脚本放仓库根的 `.tmp-*.mjs`**（`.gitignore` 已覆盖），**用完删掉**。
- 真 PTC 运行时的最小挂载链（第十轮试出来的，照 `dsh-base/cordis.patch.yml`）：
  `session-projection` → `session`（**必须**，否则 `SessionSeq ... NaN`）→ `subprocess-local`
  → `sandbox-local` → `sandbox-policy`（`{ mode:'danger-full-access', workspaceRoot }`）
  → `fs-sandbox` → `user-approval`（`{ policy:'never' }`）→ `ptc-runtime-node`。
  `agent.session` 必须是**真 Session**（`ctx.sessions.create()`），手写的
  `{ snapshotEvents, seq }` 桩会被 `dsh-session-projection` 的属性名检查绕过去再接上
  `eventAt`，调试成本极高。

---

## 7 · 要更正的历史记录

`OPEN-ITEMS.md` 与 `docs/mcp-tool-search-design.md` 里以下内容**已失效**，下一轮别照着做：

1. **O6「`SDK_RENDERERS` / 渲染器不在公开面上」** —— 错。F3 已证伪。
   连带**「更干净的正解（宿主需求，主动权不在我们手里）」整段作废**（B5）。
2. **O6「方案（首选）」里的裁剪器实现细节** —— 全部作废：`renderKey` 两种形态、
   别用数花括号切块、两个 map 必须同步删、自检三件套。B2 不需要解析生成物。
3. **O6「Python 渲染器没读 / 按语言门控」** —— 不再是风险：`renderToolsSdkPy` 同样导出，
   重渲染天然覆盖两种语言。
4. **O7「这几层不误导模型，误导的只有面板」** —— 对 PTC 不成立（F10）。
5. **O8 第 1 条「`applyServerFloor` 改注释不改代码」** —— 被 B1 取代：那行代码要删了（C3）。
6. **`OPEN-ITEMS.md` O6「未验证」清单** —— F6 已把"最后一个缺口"补上（真运行时跑通闭环）。
   仍未做的只有 `both` 与 `complete section` 两种部署，以及真机 UI 点击。

---

## 8 · 讨论中被推翻的中间立场（记录以免重来）

- 我（第十轮）一度推荐"只修 per-agent PTC、`both` 不启用"作为**最小改动**方案，
  并把"会话 PTC"与"整机 PTC"列成两个选项。
  **两处都错**：① "整机 PTC"不是独立选项，是"装配判据改成 per-agent"的自然结果；
  ② 最小改动不是目标。正确做法是让装配不做进程级模式判断。
- 我一度说"LRU 成本高（要挂进执行管线）"。**错**：`tools.guard` 就是现成的
  "每次调用都经过"的钩子，记录使用几乎零成本。
- 我一度说"恢复时按消息顺序播种会**退化成先进先出**"。**错**：算法还在，
  `lastUsed` 只是初值，用一次就刷新，LRU 会自愈。
- 我一度提议"淘汰时在搜索结果里列出被淘汰的工具"。**撤回**：淘汰那一刻模型无法判断
  要不要用被踢的；真出事时守卫报错才是精准反馈（C5）。
- 我一度说"这些参数其实都能配，只是面板没暴露"。**错**（§9 #1）：插件连 `Config` schema 都没有，
  7 个参数全是硬编码 `DEFAULTS`，用户在任何地方都改不了。
- 我一度说"官方改渲染器时自检会失败并退回原文"。**错**（§9 #3）：我们 import 的是同一个包，
  两边一起变，自检**检测不到版本漂移**。它检测的是"我算的输入 ≠ 宿主渲染的输入"。
- 我一度设想用公开的 `get(name, agent)` 逐个取 `output.schema` 来重建输入。**不好**（§9 #2）：
  701 工具 278ms，而 `sdkSchemas` 一次调用 15ms 量级且就是宿主原输入。
- 我一直假设"PTC 会话里也能从消息恢复发现集"。**错**（§9 #4，实测）：PTC 下 `deriveMessages()`
  返回 0 条——搜索发生在程序内部，只留 `tool/ptc-dispatch` 事件，而它不是 surface 事件。
  连带我原来那句"恢复是低频事件，按消息序播种就够"也失去了前提。
- 我一度以为"目录文本改依赖 discovered"只是个小改动。**没考虑缓存**（§9 #11）：
  视图按 revision 缓存，而 discovered 不在 revision 里；不单独缓存就是每次组装 ~11ms 的重算。

---

## 9 · 第十轮复审：两轮审查共抓出 13 处问题

> 用户要求"先审一遍，看看各个方案是不是最佳选择、有没有设计问题、考虑不周全、逻辑语义不通"，
> 并明确"不能猜、不能凑答案、要挖源码"。
> **第 1–9 条**是第一轮（通读方案 + 查 API 可见性）；
> **第 10–13 条**是第二轮（深挖恢复路径与会话事件模型，都是**实测**出来的）。
> 前 4 条会改变实现方案。已全部并入上文的 F/B/C 条目。

| # | 问题 | 严重度 | 处置 |
|---|---|---|---|
| 1 | **"参数都能在配置文件里配"是错的事实**。插件无 `Config` schema，`installToolSearchRuntime` 只收到 `deferServers`/`serverNames`，7 个参数全硬编码 | 🔴 事实错误 | 改 F9；C2 从"搬到面板"升级为**第一次引入配置面**，工作量重估 |
| 2 | **`sdkSchemas` / `modeFor` 是 private**；用公开 `get()` 逐个取 output 要 **278ms**（701 工具），且要手工重建宿主输入 | 🔴 方案 | 改 B2：**优先 `sdkSchemas` + feature-detect，拿不到就放弃裁剪**；新增 §4.2.1 记账 |
| 3 | **自检的保护范围被说大了**：同一包渲染器 → 不检测版本漂移 | 🔴 论证 | 改 B3 措辞：它检测的是"输入/后处理不一致"，仍有价值但别夸大 |
| 4 | **C4 原方案在 PTC 下是空操作**（第二轮实测）：`deriveMessages()` 在 PTC 会话里返回 0 条，日志只有 `tool/ptc-dispatch` | 🔴 方案 | F18/F19/F20；C4 改为**用 `sessionProjections` 持久化**（已实测两条路径都通） |
| 5 | **淘汰时机错**：`clampDiscovered` 无条件调用，"什么都没搜到"也会淘汰；B9 下会当场踢掉一半 | 🟠 逻辑 | 新增 **B10**：只在发现集增长时淘汰 |
| 6 | **目录/引导判据错**：catalog 用 `managed` 全集、guidance 用 `deferring` → 全部发现后仍注入，且"stay deferred"是假话 | 🟠 语义 | 新增 **B11**；但见 #11 的修正 |
| 7 | **报错判据写粗**：`D = ∅` 不等于"没东西可搜"——都发现了也该正常返回 | 🟠 语义 | 新增 **B13**：判据是 `managed = ∅` |
| 8 | **`requireDiscovery: false` 与裁 SDK 冲突**：藏签名却允许盲调 = 半失效 | 🟠 语义 | 新增 **B12**：裁 SDK 额外要求 `requireDiscovery` |
| 9 | **`deferring` 一个布尔身兼两义**（"有延迟服务器" vs "还有活要干"），B11 之后必然错 | 🟠 语义 | 新增 **B14**：拆成 `hasDeferredServers` / `hasDeferredWork` |
| 10 | **`Set → Map` 会动导出面**：`clampDiscovered` 是导出的，现有测试直接喂 `Set` | 🟡 成本 | 记入 §3 第 9 步与 §4.1 |
| 11 | **把搜索索引也建在 `D` 上会每次发现重建索引**（735 工具 52.8ms）；而目录文本改依赖 `discovered` 后，视图的 revision 缓存不再覆盖它（735 工具 ~11ms/次） | 🟠 性能 | 改 B11：**索引留 `managed`，只过滤显示文本**，并按 `(revision, discoveredVersion)` 单独缓存 |
| 12 | **`both` 下留尴尬状态**：装配无条件后 `tool_search` 仍注册可直调，永远返回"没启用延迟加载" | 🟡 文档 | 记入 §3 第 12 步 |
| 13 | **投影是 per-session，而现有状态是 per-agent**；且投影状态必须**有界** | 🟡 语义 | C4 三条约束：只当恢复种子、剪枝、`apply` 必须返回状态对象 |

### 9.1 复审确认"站得住、不改"的

B1（去门槛）、B4（`both` 不启用）、B5（不提官方需求）、B6（保留 `tool_search`）、
B7（LRU 走 guard）、B8（发现时播种，**且只给新发现的名字播种**）、
B9（最多踢一半，收敛验算重算过：单调、不踢空、热点永不被踢）、
C1（按模式补返回类型；`renderToolsSdk(SdkPy)` 都是公开导出，无 private 风险）、
C3（删死代码）、C5（不给淘汰信号）、C6（保留并确认无问题）。

**C4 的"恢复自愈"论证仍然成立**（§8），只是**载体**从"扫消息"换成了投影——
`lastUsed` 首版仍不持久化，恢复时按发现顺序播种。

**B1 的诚实记账补一条**：小服务器（2~3 个工具）延迟后，每轮仍要付**引导段约 359 字符**，
"省字"可能是负的。用户的开关就是解药——**这句话要写进面板文案**，不能只写在文档里。

---

## 10 · 版本差异：0.2.0（当前运行）vs 0.2.1（源码，未构建）

> 触发：用户反馈「今天 DSH 更新了」，源码拉到 `D:\sudy\github\deepseek-harness`（**0.2.1-rc.2**）。
> 而**实际运行的是 `dsh --version` = 0.2.0-rc.2**（npx 路径），且仓库**没有 `node_modules`（未构建）**。
> 结论：**实现按 0.2.0 写，同时把 0.2.1 的差异做成兼容点**，不留硬依赖。

### 10.1 会影响实现的三处

| # | 项 | 0.2.0（运行中） | 0.2.1（源码） | 我们怎么做 |
|---|---|---|---|---|
| V1 | **`both` 模式** | 存在（`z.union(['native','ptc','both'])`，`agent-tool-presentation` 也接受） | **已删除**：`ToolPresentationMode = 'native' \| 'ptc'`；`wireSchemas` 不再有 `both` 分支 | B4：0.2.0 上不启用；0.2.1 起 `both` 相关分支是死代码，按纪律清掉。**不要写新的 `both` 行为** |
| V2 | **`renderToolsSdk` 签名** | `(schemas)` 单参 | `(schemas, programFormat: 'function-body' \| 'repl' = 'function-body')`；`sdkSection` 现在传 `runtime.programFormat` | **转发 `runtime.programFormat`（存在时）**。Node 运行时该 getter 返回 `'function-body'`；旧运行时没有该字段 → 不传（默认值相同）。**否则 0.2.1 上逐字节自检会失败、退化成不裁** |
| V3 | **`PtcRuntime.programFormat`** | 无 | 新增（抽象 getter，`ptc-runtime-node` 返回 `'function-body'`） | 只读不写，缺失即不传（V2） |

### 10.2 已核对、**没有**变化的（所以 §1 的事实仍然成立）

| 事实 | 0.2.1 复核结果 |
|---|---|
| F18（PTC 无法从消息恢复） | ✅ 仍成立：`SURFACE_EVENT_TYPES` 依旧是 `{system,developer,user,assistant/message, tool/result}`，**不含 `tool/ptc-dispatch`** |
| F20（不能扫日志） | ✅ `eventAt` / `snapshotEvents` / `ownEvents` 仍标 `@deprecated`「new calls are prohibited」 |
| F19（投影可用） | ✅ `register` 两个重载（含**无 `wire`** 的内部投影）与 `stateOf` 都还在；`stateSchema.parse` 仍只在从持久化行恢复时跑 |
| F14（可见性） | ✅ `sdkSchemas` 与 `modeFor` **仍是 private**；`get` / `schemas` 公开 |
| F3（渲染器导出） | ✅ `export { jsonSchemaToTs, renderToolsSdk }` / `{ jsonSchemaToPy, renderToolsSdkPy }` 仍在 |
| **没有**新的 per-scope SDK 过滤钩子 | ✅ 全仓 `tools:sdk` 只出现在 `ToolRuntime` 自己里 → **裁 SDK 仍是唯一路径**，B5（不求官方）仍成立 |
| `AssembleContext.agent` | ✅ 仍在（`dsh-agent/src/runtime-types.ts` 的模块增强），且注释明确「**当 `agent` 存在时 `scope` 必须标识同一个 agent**」→ 用 `context.scope` 传给 `sdkSchemas` 是对的（B2 / §4.2.1） |
| 嵌套派发 / `collapses` / `mode` 默认 `native` | ✅ 未变 |

### 10.3 一个**看着像**正解、其实是陷阱的发现：`deferLoading`

0.2.x 的 `ToolSchema` 有 `deferLoading?: true`，注释写着「Uses Anthropic's `defer_loading` terminology」，
而 DeepSeek 适配器**真的会把它发到线上**：

```ts
// packages/llm/llm-deepseek/src/serialize.ts:165
...tool.deferLoading === true ? { defer_loading: true as const } : {},
```

**很容易误判成"宿主已原生支持按需加载，插件该删"**。实际不是：

1. **无 `toolUpdate` 的路由会直接剥掉它**：`packages/llm/llm/src/content.ts:433-434`
   ——「Unsupported routes need immediately available tools」→ `deferLoading` 被删掉。
2. **有 `toolUpdate` 的路由要等一条 `tool_addition` 块来激活**，而**没有任何东西**会给一个 MCP 工具发那种块
   → 单设 `deferLoading: true` 的结果是**工具永久不可用**，不是按需加载。
3. **没有任何一方在设置它**：全仓生产代码里 `deferLoading: true` 只出现在
   `content.ts:391`（把**本轮新增**的工具标记为待激活），没有插件用它做延迟加载。
4. **宿主没有 `tool_search`**：`tool_search` / `ToolSearch` 在 `packages/core/**` 里**零命中**。

**结论**：`deferLoading` 属于「动态工具增减」这条流程，与「按需加载工具定义」是两件事。
**不许把它当成延迟加载的现成方案**——那会把工具锁死。

### 10.4 顺带发现的一个打包问题（与本次功能无关，但要修）

`package.json` 里 peer 与 dev 的版本约束**互相矛盾**：

```
peerDependencies: "@deepseek-ai/dsh-tools": ">=0.1.5-rc.1 <0.2.0"
devDependencies:  "@deepseek-ai/dsh-tools": "^0.2.0-rc.2"
```

开发/测试用的是 0.2.0-rc.2，而 peer 声明**排除了 0.2.0 正式版与之后的 0.2.1**。
另外 `@deepseek-ai/dsh-session` **不在 peer 里**，但运行期要读 `agent.session`
（本方案只做鸭子类型读取 + `ctx.get('sessionProjections')`，**不 import**，所以不需要新增依赖）。
→ **定稿见 §11.5**：只支持 0.2.x，改成 `">=0.2.0-rc.1 <0.3.0"`，否则 0.2.1 一上就被 peer 判不兼容。

### 10.5 0.2.1 新增的「插件记录」API：**不采用**，理由

0.2.1 增加了 `appendPluginRecord(session, 'plugin:...', data)` / `pluginRecordOf(event)`：
`ignorable` 事件 + `plugin:` 命名空间，不进模型可见面、fork/resume 跟着日志走。

**看起来**比投影更适合存发现集，但三条原因否掉：

1. **当前运行的 0.2.0 没有这个 API** —— 我们得在 0.2.0 上工作。
2. **读回来仍然要枚举事件**，而事件枚举接口全部 `@deprecated`（F20）。`pluginRecordOf(event)`
   需要一个 `event`，而 `apply` 之外没有合法途径批量拿到它。
3. 源码注释写明「Only production source under `packages/experimental/` may call this function」
   （仓库内 lint 闸门），信号是"实验性、随时可变"。

→ **投影仍是正解**（它在 0.2.0 就有，且是官方一等公民）。0.2.1 的插件记录留作将来若需要
"不需要 fold 的极简记录"时的备选。

---

## 11 · 版本兼容：只支持 0.2.x

> 用户定：**太旧的版本不用管，只认 0.2**。
> 方法仍是逐 tag 核对（`git show <tag>:<path>`），但范围收到 0.2，结论因此大幅简化。

### 11.1 支持范围

**`>=0.2.0-rc.1 <0.3.0`**（当前运行 `0.2.0-rc.2`；源码 `0.2.1-rc.2`）。
0.1.x **明确不支持**，也不为它做任何兼容分支。

### 11.2 0.2 内部兼容矩阵（**逐 tag 实测**）

| tag | `both` | `sdkSchemas`（private） | `modeFor`（private） | 渲染器导出 | `renderToolsSdk` 第二参 | `PtcRuntime.programFormat` |
|---|---|---|---|---|---|---|
| 0.2.0-rc.1 | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| 0.2.0-rc.2（**在跑**） | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| 0.2.1-alpha.1 | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| 0.2.1-alpha.3 | ❌ **删** | ✅ | ✅ | ✅ | ❌ | ✅ |
| 0.2.1-alpha.5 | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 0.2.1-rc.2 | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |

**结论：0.2 内部只有两处分叉**

1. **`both` 模式**：≤`0.2.1-alpha.1` 存在，`alpha.3` 起**彻底删除**（`tools` 的 `Config` 与
   `agent-tool-presentation` 同步删）。
2. **`programFormat`**：运行时侧 `alpha.3` 出现、渲染器侧 `alpha.5` 出现。
   ⚠️ `alpha.3`/`alpha.4` 有个**中间态**：`PtcRuntime.programFormat` 已存在，但
   `renderToolsSdk` 还不接受第二参 —— 此时**多传一个实参是无害的**（被丢弃，输出不变）。
   注意 **`renderToolsSdkPy` 到 `0.2.1-rc.2` 也没有这个参数**（只有 TS 渲染器有）。

**其余全部稳定**：`register` / `guard` / `schemas` / `get` / `sdkSchemas` / `modeFor` /
两个渲染器导出 / `system-prompt/assemble` + `AssembleContext.agent` / `sessionProjections.register`
（含无 `wire` 重载）+ `stateOf` / `Agent.ctx` + `Agent.session` / 嵌套派发与 `collapses` / `mode` 默认 `native`。

### 11.3 因此只保留**四道**护栏，各有各的理由

> 原则：**不为"不可能发生的版本差异"写兜底**（那是死代码）。
> 下面四道护栏，每道的理由都**不是**"旧版本没有"。

| # | 护栏 | 理由（不是版本） | 缺失时 |
|---|---|---|---|
| G1 | `typeof tools.modeFor === 'function'`；渲染器导出可用（`sdkSchemas` **不再必需**） | `modeFor` 是 **private**——宿主可能改名，而仓里没 typecheck，改名只会在运行时炸。渲染器是**公开导出**（F3），不是风险项；数据来源已改成公开 API（F22），所以 `sdkSchemas` 缺席**不影响正确性**，只是慢一点 | `modeFor` 缺失 → 用 **assembly 形状**推断（`assembly.tools` 含 `run_code` ⇒ 非 native；同时含我们的受管工具 ⇒ `both`）；仍判不出 → 按 native 处理并日志一次 |
| G2 | `ctx.get('sessionProjections')` 的 `register`/`stateOf` | 这是**部署可选服务**，与版本无关：`dsh-base` 组合了它，但自定义 profile 可能没挂 | 退回 `discoveredFromMessages`（native 能恢复、PTC 不恢复），日志一次 |
| G3 | `runtime.programFormat` **有值才转发** | 0.2 内部真实分叉（§11.2） | 不传（TS 默认 `'function-body'`，与 Node 运行时取值一致） |
| G4 | 注册 `tool_search` 前用公开的 `ctx.tools.get(name)` 预检 | **前瞻风险**：将来宿主或别的插件可能自带同名工具，而 `NamedEntries.insert` 对重名**直接抛错**（`packages/core/scope/src/store.ts`）→ 整个 mcp-manager 装载失败 | 按确定性清单换名（`tool_search` → `deferred_tool_search` → `mcp_tool_search`），**日志明说换了名** |

**注意 G1/G2 是"库内自保"，不是"版本兼容"**——它们同时覆盖未来 0.2.x 补丁与非常规部署组合。
不要把它们写成"为了 0.1.x"。

**不变量**：任何一道护栏触发，最终行为都**不劣于今天**（PTC 仍净亏，但遮罩/守卫/正确性照旧）。
这与 B3 的"只可能变好"是同一条。

### 11.4 `both`：值级容忍，零行为

**代码现状（已核）**：插件里**没有 `both` 专门分支**——只有 `toolsMode === "native"` 的粗判
（`lib/index.js:1131`）加一条 warn。所以 0.2.1 删掉 `both` **不会让我们的代码出错**。

**按 per-agent 改造后要写成**：

| `modeFor(agent)` | 行为 |
|---|---|
| `'native'` | 今天的行为（遮罩 `assembly.tools` + 目录 + 引导 + 守卫） |
| `'ptc'` | 遮罩是 no-op，但**目录/引导/守卫照常**（它们是 PTC 下模型唯一的工具索引）+ **裁 SDK 手册** |
| **`'both'`**（仅 0.2.0 会出现） | **inert**：遮罩、目录、引导、裁剪全不做（B4）。所以"inert 判定"只针对 `both` 这一个值 |

即：**不是"非 native 就 inert"**，而是 **`both` 才 inert**。这条写错会把 PTC 又关掉。
`0.2.1` 起 `'both'` 不再可能出现 → 那个分支成为死代码，届时按纪律清掉。

### 11.5 `peerDependencies` 必须改（发布前）

现在自相矛盾（§10.4）：`peer: ">=0.1.5-rc.1 <0.2.0"` vs `devDeps: "^0.2.0-rc.2"`，
而且 **0.2.1 一上就被 peer 判不兼容**。

→ 按 §11.1 改成 **`">=0.2.0-rc.1 <0.3.0"`**，其余 `dsh-*` 条目同步。
`@deepseek-ai/dsh-session` **不加**：本方案只做鸭子类型读 `agent.session` +
`ctx.get('sessionProjections')`，**不 import**。

### 11.6 兼容性用例（少了，但每条都必须是真能触发的）

| 用例 | 断言 | 护栏 |
|---|---|---|
| 去掉 `sdkSchemas` | 手册**保持原文**、不抛错、日志一次 | G1 |
| 去掉 `sessionProjections` | native 仍能从消息恢复；PTC 恢复为空但**不抛错** | G2 |
| 不提供 `programFormat` | TS 手册仍**逐字节**等于宿主原文 | G3 |
| 提供 `programFormat: 'repl'` | 自检**失败 → 退回原文**（证明参数真被转发，不是被忽略） | G3 |
| `tool_search` 名字被占 | 自动换名并注册成功；目录段/守卫文案用新名字 | G4 |

**反证**：撤掉任一道护栏 → 对应用例必须红。

---

## 12 · 第三轮复核：我列的五条"解决不了"，三条是错的

> 触发：用户追问「这五个应该正常功能吗？确实没办法解决吗？原生没有，也没办法优雅实现？」
> ——问得对。逐条回去查，**三条能解决、一条是"能为而不为"、只有一条是性质上做不到**。

| # | 我原先说 | 实际 | 依据 |
|---|---|---|---|
| 1 | 面板显示不了"本会话真实生效状态"，因为**插件枚举不到 agent** | 🔴 **错，能**：`ctx.agents.list()` 是官方服务，返回的就是 `context.agent` 那批对象 → 我们的 per-agent `WeakMap` 直接查得到。可显示：活跃会话数 / 其中在延迟的数量 / 每服务器被多少会话延迟 / 已发现工具数 | F21 |
| 2 | 裁剪**必须依赖 private `sdkSchemas`**，拿不到就只能放弃 | 🔴 **错，能去掉**：公开 `schemas()` + `get()` 重建，**逐字节相等**。private 只是"快路径"（278ms vs 15ms），按 revision 缓存后一次预热即可 | F22 |
| 3 | `both` 模式下"没保护"是选择 | 🟡 **能为而不为**：遮罩在 `both` 有效（F1）、守卫有效、手册可裁 —— 技术上完全能启用。不做的理由只有一条：**0.2.1 已删除该模式**，为将死功能写代码不划算 | §11.2 |
| 4 | 真机 UI 从没验过，是证据缺口 | 🟢 **能验**：`dsh web --no-open --port 0` 会把 `?token=…` 的 URL 打到 stdout。之前的 401 是**没取 token**，不是取不到 | F23 |
| 5 | 宿主升级改渲染器签名 → 只能退化 | ✅ **这条确实做不到预防**，但**不会静默坏**：真宿主用例断言 `render(full) === host 段文本`，签名一变就红 → 升级时当场发现，而不是线上悄悄退化 | §5.1 用例 5.3-1/3 |

**所以真实清单是**：**四条能解决（含两条我之前判死的）、一条性质上做不到但被测试网兜住。**

### 12.1 由此带来的方案变更

| 变更 | 内容 |
|---|---|
| **B2** | 取数改为**公开 API 优先**，`sdkSchemas` 降级为可选快路径 → **去掉一个 private 依赖** |
| **G1** | 只剩 `modeFor` 一个 private 依赖，且它有公开的退化判据（assembly 形状推断） |
| **C2** | 从"做不到完整状态"改成"**能做**，只是要产品定展示位"；工作量上修 |
| **§5.3 证据缺口** | 真机 UI 从"没法验"改成"**有配方**"（抓 stdout 的 token URL + chrome-devtools MCP） |
| **实施计划** | `IMPLEMENT-PLAN.md` 新增 **S10：真机 UI 验证配方**；`tool-search-host.js` 的探测项按 G1 缩减 |

### 12.2 这轮的方法教训（第三条）

前两轮的教训是"否定结论要真试"。这一轮暴露的是**另一种**：

> **把"我没找到 API"写成了"宿主没有这个能力"。**

`ctx.agents` 在我前面 grep `dsh-agent` 时其实出现过一行（"consumers program against `ctx.agents`"），
**我读到了却没去确认它有 `list()`**；`sdkSchemas` 那条更典型——我测出了 `get()` 慢，就把它当成"不可行"，
而不是"慢，需要缓存"；`dsh web` 的 token 更是连跑一下都没有，直接沿用上一轮的"401"就下了结论。

**规矩**：写"做不到"之前，必须回答三个问题——
① 我搜过整个 API 面吗（不是只搜了一个包）？② 我跑过一次吗？③ 慢/麻烦 与 做不到，我分开了吗？