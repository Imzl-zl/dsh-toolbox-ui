# 新会话提示词（审查轮）：1.11.1 的 14 项改动是否把功能改坏了

> 用法：在新会话里说
> `读 .tasks/review-1.11.1/NEW-SESSION-PROMPT-AUDIT.md，按它执行，不要只做摘要`
> （cwd 是主树或隔离树都可以，本路径两边都有。）
>
> **这不是开发提示词，是审查提示词。** 目标是**验证功能没被改坏**，不是继续优化。
> 完成 14 项的开发轮见 `NEW-SESSION-PROMPT-15.md`（收口版，含合入清单）；
> 本文件在它之前——**审查通过之后**才按它 §5 合入。

---

## 0. 一句话目标

用**只读的方式**回答一个问题：**R1–R14 这 14 项改动，有没有把原本正常的功能改坏、或让某个判断建立在错误前提上？**
发现问题就**记录 + 给最小修复建议**，不要顺手重构（除非问题本身要求）。

---

## 1. 现状（先说清，否则你无法判断"谁改的"）

- 隔离工作树：`D:\sudy\github\dsh-toolbox-ui.review`，分支 `review/1.11.1`，HEAD = `e29f21c`。
- **24 个已修改文件 + 6 个未跟踪的 `lib/*.js` + 若干 `.tasks/` 文件，全部是 R1–R14 的成果，未 commit。**
  **不要** `git checkout -- .` / `git clean` / `git reset --hard` / `git stash`——那会毁掉审查对象。
- 门禁基线（当前实测，连跑两次一致）：

  | 命令 | 期望 |
  |---|---|
  | `npm test` | **1056 例 / 1049 通过 / 0 失败 / 7 skipped** |
  | `npm run contract:check` | `✔ RPC 契约一致（56 个方法）` |
  | `npm run client:check` | `✔ 10 个分片 / 8068 行` |
  | `node scripts/build-catalog.mjs` | `47 条 · 10 分类`，跑完 `git status` 无变化 |
  | `node --test test/docs-parity.test.mjs` | 20 通过 |

- 主树 `D:\sudy\github\dsh-toolbox-ui` 只有 `.tasks/` 改动，**没有代码改动**。
- `TODO.csv`：R1–R14 全部 `verified` / `fixed`。
- **每项的改动内容与理由都在 `PLAN.md` 对应小节的 `<h3>结果</h3>`**；R13 有两节"纠正"与"审计"，
  **先读那两节**——它们记录的正是"我的判断曾经错过"的地方。

---

## 2. 审查的四个焦点（由用户指定，按此优先级）

### 焦点一：功能还正常吗（最高优先）

不是"测试还绿吗"——测试是我自己写的。要问的是：
- **原本能用的路径现在还通吗**：模型的 `tool_search`、MCP 列表/详情、项目挂载、技能增删改查、导出/导入。
- **有没有哪一处我把"读侧"改成了"写侧"，或者让诊断代码进入了关键路径**。
- **有没有让某个函数的语义悄悄变了**（返回多字段、多一次 I/O、多一次序列化）。

### 焦点二：我把自己的环境当成了通用事实

我实测用的是**自己造的 fixture**（735 工具 / 20 台服务器 / 456 个延迟工具）。真实用户的分布差异极大。
要审：**代码注释、界面文案、默认值、建议值**里，有没有把"我的规模"写成了普遍结论。

### 焦点三：「注入了整个工具目录」这件事的价值判断

**关键事实（用户指出，必须按这个前提审）**：ToolSearch 的收益是**把每个工具的完整 schema 换成一份名字清单**。
实测（`node .tmp-review/measure-context.mjs`）：735 工具不延迟 = **221,380 字符**；延迟 + 目录全注入 = **37,403 + 3,015/次搜索** ⇒
**已经省了 81.7%**。所以**"全注入目录"本身就是一个有效的优化**，不是需要被砍掉的东西。

要审：**有没有哪处代码/文案在引导用户去砍目录预算**（那只是边际收益，代价是名字不可见），
或者把"省那 24k"说成主要收益。

### 焦点四：「按名字搜怎么会搜不到」——我这条判断错过

目录段第一次组装就列**全部**延迟工具名（`filterCatalog` 只剔除已发现的），模型照目录抄名字用 `select:<名>`
**必然命中**。我把"无命中"当成缺陷信号，是把一个几乎不发生的现象当成了主要风险。

要审：代码与文案里**还有没有残留这个错误前提**（例如把"搜索为空"当告警、把某条诊断称为缺陷）。

---

## 3. 我这个轮次的可疑改动清单（逐条怀疑 → 怎么验 → 判据）

**这是本文件的核心。** 每条都给了锚点（别按行号跳，行号已漂多次；用 `grep` 定位）。

### A. ToolSearch 面（用户点名，优先）

| # | 我改了什么 | 怀疑什么 | 怎么验 | 判据 |
|---|---|---|---|---|
| A1 | `tool-search-runtime.js`：`catalogSectionText` / `flatCatalogText` 的返回**加了 `listed`/`total`**（原只有 `text`/`truncated`） | 有消费者按位置解构或 `deepEqual` 整个返回 ⇒ 被我悄悄改坏 | `grep -rn "catalogSectionText(" lib test` 逐处看是否具名解构 | 全部按名字取 ⇒ 安全；有任何一处 `Object.values()` / 数组解构 ⇒ **回归** |
| A2 | `execute` 里新增 `recordSearch(...)`（在 `returned` 算好之后、`discovery.discover` 之前） | ① 引入新的抛错点（`JSON.stringify(parameters)`、`sanitizeMcpLog`）⇒ 模型搜索直接失败；② 位置挪动改变了 discovery/claim/evict 的顺序 | ① 造一个 `parameters` 含**循环引用**的 schema，调 `execute`，看是否抛；② 读 `execute` 全文确认 `discover → claim → evict` 的**相对顺序未变** | ① **已用实验确认安全**（`.tmp-review/audit-a2-cycle.mjs`）：`buildCatalog` 对循环引用直接抛 `Converting circular structure to JSON`，那种条目**进不了 catalog** ⇒ 能走到 `execute` 的 `parameters` 必然已成功序列化过一次。**仍要复核**：`sanitizeMcpLog` 对任意字符串是否可能抛（它内部有 `JSON.parse`，但对纯文本是安全的）；② 顺序不变 |
| A3 | `catalogFacts()` 返回 `recentSearches: this.toolSearchRuntime.searches?.() ?? []` | **直接返回内部数组引用**：同进程内调用方（含测试、将来的诊断视图）改了它，会污染 runtime 状态 | 读 `searches: () => recentSearches` 的实现，确认是否返回副本 | **已确认泄漏**（`.tmp-review/audit-a3-alias.cjs`：返回表达式是裸变量 `recentSearches`）。**建议修一行**：`searches: () => recentSearches.slice()`。跨 RPC 时是快照（序列化），所以客户端侧无风险；**同进程内的消费者才是风险面**（P2） |
| A4 | `catalogTextFor` 的缓存键**不含 `maxCatalogChars`**（既有设计，我加了注释说"改预算会重装所以没事"） | 这条依赖是否真的成立？若预算被改成热更新（或将来有人这么做），目录段会用旧预算 ⇒ 体检与界面都错 | 读 `updateToolSearchSettings` 的实现，确认它是否**重建 runtime**；再看有没有"只改 settings 不重装"的路径 | 若存在不重装的路径 ⇒ **真缺陷**（注释不足以挡住） |
| A5 | `lastCatalogAssembly` **只在缓存未命中时**写入（在 `catalogTextFor` 里，缓存在 `catalogCache.get(key)` 命中时直接 return） | 命中缓存时体检**不刷新**：`chars`/`listed`/`truncated` 会永久停在第一次的数字？ | 连续组装两次（第二次必然命中缓存），读 `toolSearchSettings().catalog.lastAssembly` 的 `at`/`revision` 是否变 | 若第二次读到的 `at` 不变 ⇒ **不是 bug**（本来就是"上一次**实际组装**"）；但文案必须说"上一次组装"，不能说"当前" |
| A6 | `recentSearchesText` 我改过两次（先"空手而归排最前 + ❌"，后改成中性 + 时间倒序） | 还有没有别处残留"无命中=缺陷"的措辞/排序/告警色 | `grep -n "❌" lib/client/60-tool-loading.js`；读 `recentSearchesText` | 无 ❌、无按 empty 排序 |
| A7 | 我在注释里写过"实测 735 工具"这类数字 | 被后人当成通用真值 | `grep -rn "735\|456" lib/ | grep -v test` | 数字必须标明"本机实测 / fixture"，不能当结论 |

### B. 通用性（风格与文案层）

| # | 怀疑什么 | 怎么验 | 判据 |
|---|---|---|---|
| B1 | `CATALOG_CHARS_SUGGESTION = 12500`（`60-tool-loading.js`）的依据是"456 个延迟工具" ⇒ 对只有 15 个工具的用户**这个建议值毫无意义**（他根本碰不到上限） | 读它的注释与使用处（输入框 placeholder / 打开开关时的默认填入） | 若它在"工具很少"时也把一个 12500 摆给用户，且文案暗示"该设" ⇒ **建议改为按当前库存给建议，或干脆不预填** |
| B2 | 界面文案有没有把"目录被砍"说成普遍问题 | 读 `catalogFactsText` 全文 | 未截断（`truncated === 0`）时不得出现任何"截断/砍掉/退化"的字样 |
| B3 | 我新增的 i18n 文案有没有把机制说错（这轮改过 3 次） | 读 `lib/client/20-locale.js` 里本轮新增的键 + 对应 `t()` 调用 | 文案与代码行为一致（尤其"不能用 select 精确取"这句） |

### C. 其它项的回归面（快速过，不是重点）

| # | 怀疑什么 | 怎么验 | 判据 |
|---|---|---|---|
| C1 | R6.1 的表驱动装配是否与"逐条手写 `@Remote`"**完全等价**（这是全局最大风险：它决定 56 个 wire 方法还在不在） | `npm run contract:check`（✔ 56）+ 真宿主里 `remoteMethods(gateway)` 与契约表逐方法同序（`test/rpc-contract.test.mjs` 有这条）+ **再对照 DSH 源码**（见 §4 E3） | 三处一致 |
| C2 | R7 的 `HostState` 是否覆盖了我**新加**的模块级状态 | `lastCatalogAssembly` / `recentSearches` 在 `installToolSearchRuntime` 的**闭包**里（不是模块级 `let`）。要确认：同一 app root 重装时闭包被丢弃 ⇒ 状态重置 | 闭包随重装丢弃 ⇒ 安全；若是模块级 ⇒ **违反 R7** |
| C3 | R9 的 `exportGlobalJson` 是**唯一**新增的 wire 方法 | `git diff e29f21c -- lib/rpc-contract.js` 只应有它一条 | 只有 1 条 |
| C4 | R11 扩展了 `importSkill` 的 payload（`content` / `archiveBase64`） | ① 原有 `{type, path}` 路径是否仍然工作；② 服务端是否对任意大小/内容做了限制 | ① `test/skills-file-ops.test.mjs` 的既有 path 用例全绿；② 文本 > `MAX_FILE_BYTES` 被拒、base64 非法被拒 |
| C5 | R14 的 `.hub.json` 会不会被当成技能条目 | `test/skills-file-ops.test.mjs` 有专条；**再手工确认** `<name>.md.hub.json` 不被 `*.md` 匹配、`.hub.json` 不被 `<dir>/SKILL.md` 规则匹配 | 两种形态都不进技能列表 |
| C6 | R1–R5 的原始证据是否被我后来的改动影响 | 这五项的结果块里有具体断言；跑一次对应测试文件即可（`workspace-runtime` / `workspace-host` / `tool-search-runtime` / `client-parts-deps`） | 全绿 |

---

## 4. 必须对照 DSH 源码的问题（`D:\sudy\github\deepseek-harness`，只读）

**这些是我在设计时**假设**的宿主行为。如果假设错了，我基于它们得出的性能结论与"安全"判断都要重算。**
每条都给了要查的东西与判据；**没有答案就记"未验证"，不要猜**。

| # | 我的假设 | 去哪查 | 为什么重要 |
|---|---|---|---|
| E1 | `ctx.tools.schemas(scope)` 每次调用都**深拷贝**（所以"每台各读一次"才贵） | `packages/` 下 `dsh-tools`（找 `schemas` / `schemaOf` / `view`） | PLAN 里 **454ms/20 条**、**92ms/735 工具** 这两个数字全建立在这条上。若宿主自己有缓存，这两个数字是错的，R4/R12/R13 的"体积/成本"论证也要跟着改 |
| E2 | `tools.definitions()` 在 0.2.1 **不存在**（所以组装期只能 `schemas(agent)`） | 同上，查 `definitions` | 若它其实存在（或在 rc 里加了），ToolSearch 组装期那 92ms 有直接解法 |
| E3 | `Remote(name)` 与 `context.addInitializer` 的语义：R6.1 用 `__esDecorate` 手工调 `Remote(method)`，**等价于**逐条贴装饰器 | `node_modules/@deepseek-ai/dsh-typert-protocol/lib/index.js` 的 `Remote` / `addMarkerInitializer` / `mark`；再对照 `packages/typert/protocol/src/**` | 这是**唯一新增/保留 wire 面**的机制。若行为有差异（例如 `context.access` 被读、`Symbol.metadata` 有用途），56 个方法可能在某些宿主上消失——而**所有测试都是在本机这一版宿主上绿的** |
| E4 | `tools/view(scope)` 是 `schemas`/`get` 的唯一重建入口，且**按 scope 隔离** | 同上 | R4 的"全局快照按代次共享"依赖"同一 scope 下内容只随代次变" |
| E5 | 客户端 `document.visibilityState` / `localStorage` / `Blob` 的可用性（R10/R12/R13 的按需取数依赖可见性感知轮询） | `packages/client/**` | 若桌面壳里 `visibilityState` 恒为 `visible`，"隐藏时跳过轮询"这条优化等于没生效（不是 bug，但结论要改） |

**查源码的方式**：`grep -rn "export function schemas\|schemas(scope\|definitions(" D:\sudy\github\deepseek-harness\packages --include=*.ts`。
**只读**，不要改那边任何文件。

---

## 5. 审查方法（按这个顺序，都是只读）

1. **先跑门禁**（§1 五条），数字不一致先报告。
2. **读 PLAN 的 R13 两节**（"纠正"+"主动审计"）——那里已经记了 3 个我错过的判断，
   你要做的是确认**它们是否真的被改对了**，以及**同样的错误有没有出现在别处**。
3. **逐条过 §3 的 A1–A7**（ToolSearch 面），每条给"验了什么、结论"。
4. **对照 §4 的 E1–E5 查 DSH 源码**，每条给"假设成立/不成立/未验证"。
5. **回归采样**：从每一批（A–K，见 `NEW-SESSION-PROMPT-15.md` §5 三）挑 1–2 条**真宿主**用例单独跑，
   确认它们不是"跟着全量绿"而绿。优先跑：
   - `test/real-host-loader.test.mjs`（真 Loader + 真 mcp-client）
   - `test/real-host-integration.test.mjs`（真 ToolRuntime + 共享连接）
   - `test/tool-search-real-host.test.mjs`（真宿主里的 ToolSearch 装配）
   - `test/skills-host.test.mjs`（真 cordis + 真 skills 服务）
6. **渲染快照**：`node .tmp-review/render-snapshot.mjs audit` 与 `.tmp-review/render-baseline.html` 比。
   **差异必须能逐行解释**；解释不了就是回归。（已知预期差异：R11 的"导入本机技能"按钮。）
7. **故障注入抽查**（可选但有价值）：把某个判据改成常量，确认对应用例**会红**——
   证明那条用例不是空转。用 `.tmp-review/inject.cjs`（它自校验替换真的发生）。

---

## 6. 什么算"改坏了"（判定标准）

按严重度排，命中任一条就写进报告：

- **P0 功能回归**：原本能用的路径现在报错/静默失效（wire 方法消失、`tool_search` 抛错、技能装不上/删不掉、项目挂不上）。
- **P1 语义错**：返回值/文案与代码实际行为不一致（例如把"待发现"说成"全部"、把"只能关键词碰"说成"仍能搜到"）。
- **P2 失败面扩大**：诊断代码进入了关键路径（多一次可能抛的 I/O/序列化），或新增了无上限的缓存。
- **P3 判断前提错**：注释/文档/结论建立在"我的 fixture"上，且会误导后续维护者。
- **P4 测试失去意义**：某条断言只证明"我改成了我想要的样子"，或为让它变绿而放宽了既有断言。
  （这批已经出现过一次：我曾把"仍能被搜索命中"这个错误说法写成断言，后来拆掉了——**复核是否还有别的**。）

---

## 7. 已知边界（不要在审查里重新调查）

- 本机 **`dsh` 不在 PATH**。真机 UI 冒烟只能用真宿主夹具 + `.tasks/_uipreview.mjs` +
  `panel-chrome.test.mjs` / `panel-css-invariants.test.mjs`。
- **不要再论证"目录该不该截断"**：用户的意思已经明确——**全注入本身已经是有效优化（省 81.7%）**，
  预算只是极端规模下的选项。审查只需确认代码/文案没有反向引导。
- **不要新增功能**。审查轮的产物是"结论 + 最小修复建议"，不是新实现。
- 两处已量化的遗留性能点（**明确不在本轮范围**）：
  1. `lib/index.js` 的 `collectAvailableTools` 对**每个 loader 条目**与**每个存活 agent**各读一次 `schemas()`
     （`grep -n "entryCtx.tools.schemas" lib/index.js`），PLAN 实测 20 条 ≈ 454ms/轮询；
  2. `lib/tool-search-runtime.js` 组装期 `agentTools.schemas(agent)` 全量深拷贝（≈92ms/735 工具）。
  两者同源（都卡在"宿主没有轻量枚举"），需要先解决失效判据 —— **本轮只确认它们仍在，不提方案**。
- R14 的"检查更新"未做（要打上游），是有意的范围收窄。

---

## 8. 产出格式（照抄）

```
## 审查结论：<PASS / 有 N 处问题>

### 门禁
<五条命令与实测数字>

### ToolSearch 面（A1–A7）
| # | 验了什么 | 结论 | 证据（文件:行 或命令输出） |
|---|---|---|---|
| A1 | ... | 安全 / 回归 | ... |

### DSH 源码对照（E1–E5）
| # | 假设 | 结论（成立/不成立/未验证） | 依据（源码路径:行） |
|---|---|---|---|

### 问题清单（按 P0→P4）
1. **[P1] <一句话>** — 位置 `<文件:行>`；现状…；影响…；最小修复建议…；验证方式…

### 回归采样
<单独跑的真宿主用例与结果>

### 渲染快照
<是否一致；差异逐行解释>

### 未验证项
<明确列出"我没能验证的"与原因（例如本机没有某个宿主版本）>
```

---

## 9. 审查完之后

1. **P0/P1 必须先修**（修完重跑 §1 五条门禁），再谈合入。
2. P2–P4 记进 `PLAN.md` 的对应小节（`<h3>审查发现</h3>`），不要直接动手改。
3. 全部 PASS 之后，按 `NEW-SESSION-PROMPT-15.md` §5 合入（五条门禁 → diff 自审 → 11 批切分提交）。
4. **主树与隔离树的 `.tasks/` 要同步**（两边逐字节一致）。
5. 不要 commit，除非用户明确要求。
