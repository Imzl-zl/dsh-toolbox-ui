# 1.11.1 复查与优化清单（逐项确认）

本文件是**唯一进度真相源**。每项都要走完固定流程才算完成；不允许"顺手一起改"。

## 隔离环境

| 用途 | 位置 |
|---|---|
| 隔离工作树（改动只在这里发生） | `D:/sudy/github/dsh-toolbox-ui.review`（`git worktree add --detach`，`node_modules` 为 junction 指回主树） |
| 复现脚本（不提交，`.tmp-*` 已 ignore） | `<worktree>/.tmp-review/` |
| 回归用例（提交） | `<worktree>/test/*.test.mjs` |
| 主树 | 只写本文件与最终合并；不在主树跑改动 |

复核运行方式：`cd D:/sudy/github/dsh-toolbox-ui.review && npm test`（基线 1000 例 / ~31s，2026-11-09）。

## 每项的固定流程

1. **复现**：隔离目录里一段可重复脚本，输出"错的事实"，贴进本文件。
2. **先红**：把复现改成 `test/` 下的回归用例，在**未修**的代码上跑一次，确认它失败（采样检查：每批至少一次）。
3. **最小修**：优先结构化修（一处表达不变量），不做防线叠加；不改 wire 契约、不改客户端可见行为，除非该项本身就是功能项。
4. **门禁**：`npm test` 全绿 + `npm run contract:check` + `npm run client:check` + `npm run catalog`（生成器自带字节比对用例）。
5. **对比**：贴 `git diff --stat` 与关键 diff；写回滚方式。
6. **勾选**：更新 `TODO.csv`，进入下一项。

## 不变量（所有项共同遵守）

- wire 上的方法名、参数名、结果类型、顺序不变（`lib/rpc-contract.js` 与 `scripts/rpc-contract.mjs --check` 是闸门）。
- `lib/client.js` 仍必须由 `lib/client/` 分片逐字节拼出（`client:check`）。
- 读侧宽容 / 写侧严格的既有分工不变。
- 面板文案、状态取值域（`deriveMcpPhase`）、`{persisted, live, diagnostics}` 的语义不变。
- 新增的错误路径必须是**显式报错**，不得静默降级成默认值。

---

## A 批：缺陷（会静默做错事）

### R1 空 wsPath 在 Windows 上解析成宿主进程 cwd —— 13 个 RPC 的守卫失效

- **级别**：缺陷（可写坏别的项目配置 / 泄露凭据）
- **证据**：`lib/workspace-runtime.js:989` `canonicalWorkspacePath` 只做 `realpathSync`；Windows 上 `realpathSync('')` 返回 cwd（`lib/index.js:1669` 的注释已记录此坑，但只有 `setDeferAll` 与 `getWorkspaceView` 按正确顺序写）。
- **复现**：`.tmp-review/r1-empty-wspath.mjs`（已跑）
  ```
  canonicalWorkspacePath("") => "D:\\sudy\\github\\dsh-toolbox-ui.review"
  RPC result                 => "applied"
  wrote cwd/.dsh/mcp.json?   => true
  content                    => { "mcpServers": { "review-probe": { "command": "node" } } }
  ```
  即 `addWorkspaceServer({ wsPath: '' })` 写进了宿主 cwd 的项目配置。
- **受影响入口**：守卫在 canonicalize 之后（Windows 上死代码）——`addWorkspaceServer` / `updateWorkspaceServer` / `removeWorkspaceServer` / `reconnectWorkspaceServer` / `setWorkspaceExclude` / `installWorkspaceBuiltins` / `copyWorkspaceServers` / `exportWorkspaceJson`；无守卫——`previewWorkspaceImport` / `importWorkspaceJson` / `revealWorkspaceServer`；只做注册校验——`workspaceToolLoading` / `setWorkspaceToolLoading`。
- **修法**：把校验收进 `canonicalWorkspacePath`（空串/空白 → `throw`；非绝对路径同样拒绝），删掉 13 处重复的 `if (!wsPath)`。不新增概念，也不改签名。
- **回归用例**：`test/workspace-host.test.mjs` 加一组"空 / 空白 / 相对 wsPath 对每个写入口都抛错且不落盘"。
- **真宿主实测（不靠"看着像对"）**：新增 `repro/r1-real-host.mjs`（随仓库提交，cwd = 仓库根）在隔离树里起**生产形状宿主**——真 cordis + 真 Loader + 官方 `mountRootInclude` + 真 ToolRuntime + 真 `McpManagerGateway` 实例，通过 `ctx.get('mcpManager')` 调宿主注册的那批 Remote 方法；进程 cwd 先 `chdir` 到空临时目录**并登记进 `workspaceRegistry`**（否则只会撞上"目标未注册"，看不出危害）。`git stash push -- lib/` 前后对照：
  ```
  修复前：✘ addWorkspaceServer wsPath:"" — 没有被拒绝，返回 {"persisted":"applied",…}
          ✘ importWorkspaceJson wsPath:"" — 没有被拒绝，返回 {"persisted":"applied",…}
          ✘ previewWorkspaceImport wsPath:"" — 没有被拒绝（removed:["r1-probe"]）
          ✘ exportWorkspaceJson wsPath:"" — 没有被拒绝，path 就是宿主 cwd
          ✘ 宿主 cwd 未被污染 — …\r1-host-cwd-*\.dsh 存在：mcp.json
          10 项失败（3 项正控仍绿）
  修复后：14/14 ✔（含 3 项正控：真实项目 add → 盘上 → getWorkspaceView → export）
          setDeferAll 不传 wsPath 仍走全局分支 ✔
  ```
  同一脚本可直接复用到 R2（`getWorkspaceView` 的诊断字段就在它的正控路径上）。
- **不破坏**：UI 永远带真实路径，正常路径行为逐字不变；只把"缺参"从静默写 cwd 变成明确报错。
- **回滚**：单个文件 + 一处函数，revert 即可。

<h3>结果</h3>

- **实际改动**（未 commit，在 `dsh-toolbox-ui.review`）：
  - `lib/workspace-runtime.js:998`：`canonicalWorkspacePath` 成为 wsPath 的唯一合法化出口。非字符串 / 空 / 纯空白 → `throw new Error("缺少 workspace 路径")`；相对路径 → `throw new Error("workspace 路径必须是绝对路径：…")`。校验在 `realpathSync` **之前**，正好堵住 Windows 上 `realpathSync("")` 返回 cwd 的行为。
  - `lib/index.js`：删掉 11 处重复守卫 —— `getWorkspaceView`、`addWorkspaceServer`、`updateWorkspaceServer`、`removeWorkspaceServer`、`reconnectWorkspaceServer`、`setWorkspaceExclude`、`installWorkspaceBuiltins`、`copyWorkspaceServers`、`exportWorkspaceJson`，以及 `resolveWorkspaceCopy` 的 `from`/`to` 两条。
  - 保留 `setDeferAll` / `setDefer` / `tools` 的“先判空”：那里空串是合法的「全局族」语义，不是重复校验（`setDeferAll` 的注释已改成说明这一点，避免后人把它“简化”成抛错）。
  - `git diff --stat`：`lib/index.js 20 +--`、`lib/workspace-runtime.js 13 ++`、`test/workspace-host.test.mjs 60 ++`（75 insertions / 18 deletions）。
- **红用例**：`test/workspace-host.test.mjs:81`（`empty, blank and relative wsPath are rejected by every workspace entry point`）。未修代码上首个断言即失败：
  ```
  AssertionError [ERR_ASSERTION]: Missing expected rejection: addWorkspaceServer 必须拒绝 wsPath=""
  ```
  用例把宿主 cwd `chdir` 到空临时目录**并登记进注册表**——两件事缺一不可：不 chdir 会往仓库里写，不登记就只会撞上“目标未注册”，测到的不是这处守卫。覆盖 17 个入口 × 3 种坏输入（`''` / `'   '` / `'relative/proj'`）= 51 组断言，每组同时断言“抛错”与“宿主 cwd 没出现任何东西”。
- **门禁**：`npm test` 1001 例 / 994 通过 / 0 失败 / 7 skipped（基线 1000 / 993）；`contract:check` ✔ 55 方法；`client:check` ✔ 10 分片 / 7488 行；`node scripts/build-catalog.mjs` ✔ 47 条 · 10 分类，`git status` 只剩预期 3 个文件。
- **复现脚本**：提交的 `repro/r1-empty-wspath.mjs` 第 42 行直接打印 `canonicalWorkspacePath("")`，修完后**该行会抛**——这正是修好的样子，脚本本身未改。把 `.tmp-review/r1.mjs` 这一行包进 try/catch 后输出：
  ```
  canonicalWorkspacePath("") threw => 缺少 workspace 路径
  cwd                        => "D:\\sudy\\github\\dsh-toolbox-ui.review"
  RPC threw                  => 缺少 workspace 路径
  wrote cwd/.dsh/mcp.json?   => false
  ```
  下一轮若要复跑提交版 repro，先给该行加 try/catch。
- **不破坏**：正常路径只多一次 `trim()`/`isAbsolute`，`realpathSync` 之后的行为逐字不变；读侧宽容分工不变——`agentWorkspace`（`lib/tool-search-config.js:75`）本来就 `try/catch → null`，`mountProjectMcpForAgent` 的 throw 落在 `agent/created` 监听器的既有 catch 里（只记日志，不会让会话创建失败）；注册表记录路径按官方 `Workspace.path` 契约本就是 canonical 绝对路径。
- **语义收窄（需要知情）**：`resolveWorkspaceCopy` 原来的 `缺少源/目标 workspace 路径` 两句合成通用的 `缺少 workspace 路径`——同一个出口的必然结果，UI 两个字段总是同时带上。
- **回滚**：`git checkout 2adb277 -- lib/index.js lib/workspace-runtime.js test/workspace-host.test.mjs`（三个文件，无其它依赖）。

### R2 诊断记录没有寿命：删掉/禁用失败的条目后，横幅仍点名它

- **级别**：缺陷（面板撒谎，用户无法消除）
- **证据**：`lib/workspace-runtime.js:939-951` 只在"同一条目再次挂载成功"时清；`reconcileWorkspaceConnections:434` 与 `removeWorkspaceServer` 都不清；`lib/index.js:2187` 整份返回；`lib/client/70-shell.js:750-771` 整份渲染。
- **复现**：`.tmp-review/r2.test.mjs`（已跑，真实挂载路径 + 真实删除 RPC）
  ```
  [R2] 挂载失败记录 = [{"serverName":"db","error":"模拟：宿主未提供 mcp-client"}]
  [R2] 删除前 servers = [ 'db' ] | mountErrors = 1
  [R2] removeWorkspaceServer = "applied"
  [R2] 盘上配置 = { "mcpServers": {} }
  [R2] 删除后 servers = [] | mountErrors = [{"serverName":"db", ...}]
  ```
- **同类**：`scopeErrors`（同一渲染形状）；`restrictError`（不清，等下次成功 restrict）。
- **修法**：读取端按**当前** `config.servers` 过滤（`getWorkspaceView` 一处），记录逻辑一行不动。
- **回归用例**：`test/workspace-runtime.test.mjs` 追加"删除后 mountErrors 为空 / 禁用后为空"；`test/workspace-host.test.mjs` 追加"view.mountErrors 只列当前配置里的条目"。
- **不破坏**：仅影响展示层返回值，行上的 `mountFailed` 标记与错误文本来源不变。

---

<h3>结果</h3>

- **实际改动**（只动读取端，一行记录/清除逻辑未改）：`lib/index.js:2186` `getWorkspaceView` 新增
  - `activeNames = Set(config.servers.filter(s => !s.disabled).map(s => s.name))` —— 只算一次；
  - `currentOnly(rows)` 同时过滤 `mountErrors` 与 `scopeErrors`（同一集合、同一条规则）；
  - `restrictError`：`deny` 是工具名（`mcp__<server>__<tool>`），只有当它指向的全局条目都不存在时才置 null（`lib/index.js:2209-2216`）。
  - `mountErrorByName` 用的是过滤后的表 ⇒ 行级 `mountFailed` 与横幅同一口径。
  - `git diff --stat`：`lib/index.js` 本节 +20/−19（其中 11 行是 R1 的守卫删除）。
- **红用例**：`test/workspace-runtime.test.mjs:1857`（`R2: stale diagnostics are filtered by the current config at read time, not cleared on write`）。用真挂载失败（`loader.import` 拒绝 mcp-client）+ 真 `agent/created` 派发 + 真 `removeWorkspaceServer` RPC。未修时：
  ```
  AssertionError [ERR_ASSERTION]: 禁用后不得再点名
    actual: [ { serverName: 'db', error: '模拟：宿主未提供 mcp-client' } ]
    expected: []
  ```
  用例同时钉住反向：重新启用后诊断必须回来；删除/禁用后 `workspaceMountErrorsView` / `workspaceRestrictErrorView` **仍在**（证明是读取端过滤，不是第二真相源）。
- **门禁**：`npm test` 1002 例 / 995 通过 / 0 失败 / 7 skipped；`contract:check` ✔ 55；`client:check` ✔ 10 分片 / 7488 行；`build-catalog` ✔ 47 条，`git status` 只有预期文件。
- **真宿主实测**：新增 `repro/r2-real-host.mjs`（随仓库提交，cwd = 仓库根）：真 loader 宿主 + **真 mcp-client 连一个不存在的命令**（`failOnStartupError` + `readyTimeoutMs: 0` 让失败当场定论，否则要等重试预算）。`git stash push -- lib/index.js` 前后对照：
  ```
  修复前：✔ 真实挂载失败被记录 — [{"serverName":"ghost",…}]
          ✔ 视图点名该条目 — mountErrors=["ghost"]
          ✘ 禁用后视图不再点名 — [{…"ghost"…}]
          ✘ 删除后视图不再点名 — applied / servers=[] / mountErrors=[{…"ghost"…}]
  修复后：8/8 ✔（含：记录仍在 / 重新启用后诊断回来 / 删除不清表 / restrictError 无记录时为 null）
  ```
  注意：同一脚本在旧代码上「行级 mountFailed」**看不出差别**（`summarizeWorkspaceRow:653` 对 disabled 行提前返回，删除的行根本不在 `servers` 里），所以这条检查已从脚本里删掉——留着就是空绿。
- **与计划的两处节差（知情）**：
  1. `test/workspace-host.test.mjs` 那条未加：该文件的 `ctx` 是手搭的 plain object（无 `on`/`effect`/`extend`），`installAgentRuntime` 装不上去，造不出任何真实诊断记录。同一性质已由 `workspace-runtime.test.mjs` 的真实挂载路径 + `getWorkspaceView`（同一个 Remote）覆盖，加一个只能自己塞记录的版本就是假绿。
  2. 同理没法在同一个夹具里同时造出真实 `scopeErrors`（挂载失败 ↔ ACTIVE 连接互斥），但两者共用同一行 `currentOnly(...)`，规则已被 mountErrors 覆盖。
- **不破坏**：`{persisted, live, diagnostics}` 语义与 `deriveMcpPhase` 未动；客户端渲染条件（`mountErrors.length > 0`）未动；`revision` 本来就含这三个字段，过滤后变化照常触发刷新。restrictError 的 `exclude` 变化仍由写路径重算（`reconcileWorkspaceRestricts`），没有在读取端兜。
- **回滚**：`git checkout 2adb277 -- lib/index.js test/workspace-runtime.test.mjs`。

## B 批：结构闸门（零行为变化，先立规矩）

### R3 客户端分片没有依赖方向

- **级别**：结构（当前靠"全在渲染期调用"侥幸成立；初始化期用后置分片即 TDZ）
- **证据**（去注释后的代码级反向引用）：
  ```
  30-skill-model.js -> installTargetId (50-mcp-panels.js:827)
  40-shared-ui.js   -> SORT_KEYS / SORT_LABELS (50-mcp-panels.js:69)
  70-shell.js       -> ABILITY_TABS / SKILL_MODES / SkillsPanel (80-skills-face.js)
  70-shell.js       -> ensureLocaleWired (90-contribution.js)
  ```
- **修法**：`lib/client/parts-deps.js`（或 build-client 内的表）声明"分片 → 允许引用的前序分片" + 一个扫描测试；把 `SORT_KEYS/SORT_LABELS`、`installTargetId` 移到前面的分片；`ensureLocaleWired` 移到 `40`。
- **门禁**：`client:check` 必须仍逐字节一致（搬移后重跑 `--write`，并确认产物只有预期行变化）。
- **不破坏**：纯搬移 + 新测试；运行时行为不变。

---

<h3>结果</h3>

- **实际改动**（未 commit）：
  - `scripts/build-client.mjs`：新增导出 `PART_FORWARD_REFS`（唯一登记项：`70-shell → 80-skills-face: SkillsPanel`，带 `why`），并把「分片之间可以自由互相引用」的契约注释改成「只能引用前序，后置必须登记」。
  - 新增 `test/client-parts-deps.test.mjs`（3 条）：① 扫描器自检（真引用正控 + 注释/字符串/同名局部 shadow 负控）；② 真实分片零未登记越界、零陈旧登记；③ 登记表自洽（分片存在 / 符号真在对方分片声明 / why 非空 / 必须是后置）。
  - 搬移（逐块精确移动，未改一个字符）：`SORT_KEYS`/`SORT_LABELS` 50→40，`installTargetId`（含身份注释）50→30，`ABILITY_TABS`/`SKILL_MODES` 80→40，`createLocaleVersion`/`localeVersion`/`useLocaleVersion` 70→20，`localeProbeCtx`/`localeWired`/`wireLocale`/`ensureLocaleWired` 90→20。
  - `git diff --stat`：9 files / 291 insertions / 269 deletions（其中 `lib/client.js` 264 行是纯位置变化）。
- **与计划的两处偏差（知情）**：
  1. `ensureLocaleWired` 实际挪到 **20**（不是 40）。只挪函数会新造 `40 → 70`（它用 `localeVersion`，而那个 store 原本在 70），等于把越界换个方向；整簇（含 store）下沉到 locale 自己的分片 20 才真正消掉方向问题。
  2. 扫描器初版报了 `byName`（30 引 50），实测是 `30-skill-model.js:250` 的**函数内局部 `Map`**（同名 shadow）。闸门因此加了「同名局部变量不算依赖」规则；`byName` 留在 50 原位不动，避免无谓搬移。
- **验证**：
  - **红线**：把 `lib/client/` 回退到重构前，闸门精确报出计划里那 4 条（`installTargetId` / `SORT_KEYS,SORT_LABELS` / `ABILITY_TABS,SKILL_MODES` / `ensureLocaleWired`），`byName` 未被误报。
  - **纯重排**：`lib/client.js` 与 HEAD 的**行内容多重集 0 差异**（7489 行；只有顺序变化），`client:check` ✔ 10 分片 / 7488 行。
  - **渲染零变化**：`.tasks/_uipreview.mjs` 用真 `lib/client.js` + 假 React 渲染 18 个场景，重构前后 HTML **逐字节相同**（152814 bytes）——TDZ 类回归会在 vm 求值/渲染当场报错。
  - **门禁**：`npm test` 1005 例 / 998 通过 / 0 失败 / 7 skipped；`contract:check` ✔ 55；`build-catalog` ✔ 47 条无变更。
- **不破坏**：分片文件名与顺序未变；`PART_FORWARD_REFS` 只登记一条真实存在的渲染期引用（`McpTab` 渲染 `SkillsPanel`）。
- **回滚**：`git checkout 2adb277 -- lib/client.js lib/client/ scripts/build-client.mjs`，再删除 `test/client-parts-deps.test.mjs`。

## C 批：性能（行为不变，可量化）

### R4 工具清单：一份事实两套实现，全局侧无缓存

- **级别**：性能 + 一致性
- **证据**：项目侧有 epoch + 哨兵缓存（`workspace-runtime.js:758-800`）；全局侧 `mcp-registry.js:24` 每次 `ctx.tools.schemas()`（宿主对每个工具深拷贝 parameters）+ 每台服务器 `JSON.stringify` + SHA-256。`getWorkspaceView:2205` 还额外调一次全局 `listMcpServers`，所以项目标签页每 5s 付两遍全量 inventory。
- **测量**：735 工具 / 1.72MB schema，仅 stringify+sha256 = **14.3ms/次**（未计深拷贝），客户端每 5s 一次，与 agent 同一事件循环。
- **修法**：inventory 收成一份，键用 `toolsEpoch`（`workspace-runtime.js:1076`，每次 `tools/change` flush 自增），全局/项目共用；`getWorkspaceView` 复用。`revision` 字段语义与取值不变。
- **回归用例**：用夹具已有的 `toolReads.schemas` 计数断言"同一代次内连续 list() 只枚举一次"。
- **不破坏**：返回的 `servers[].toolCount/toolRevision` 逐字一致（用现有用例 + 一次快照对比）。

<h3>结果</h3>

- **实测基线（本机，真 ToolRuntime，736 工具 / 1.64MB schema / 20 台条目）**：
  - `ctx.tools.schemas()`（宿主对每个工具的 parameters 深拷贝）≈ **92ms/次**；
  - `toolInventory()` ≈ **220ms/次**（其中串行 stringify+sha256 ≈ 18ms；归属扫描 ≈ 1.5ms）；
  - `deferStateOf(srv)` ≈ **100ms/次** —— 它默认会重新 `collectAvailableTools()`。
  - 面板 RPC：`list()` 中位 **286.9ms**，`getWorkspaceView()`（空项目）中位 **3286ms**。
- **两个根因（不是一个）**：
  1. 全局清单每次都重算（计划已写）。
  2. **`getWorkspaceView` 给每台全局服务器各传一个 `(name) => this.deferStateOf(name)`**，而 `deferStateOf` 默认路径会重收一次可见工具 ⇒ 20 台 ≈ **20 遍**全量枚举（计划里的“两遍”低估了，实测 3.3s）。`list()` 早就按“一次枚举、每行复用”写了——同一个需求两套实现。
- **实际改动**：
  - `lib/workspace-runtime.js`：代次前进时机从微任务 flush 挪到**事件发生**（`noteToolsChanged`，旧名 `scheduleToolsChange`，现导出）；新增 `globalToolSchemas(ctx)`（全局 `schemas()` 快照）与 `toolInventoryOf(ctx)`，都按 `(appRoot, 代次)` 缓存，app 释放即回收。
  - `lib/mcp-registry.js`：`toolInventory(ctx, visible)` 加可选入参（同一次枚举喂清单与面板可见集），函数仍是纯的。
  - `lib/index.js`：新增模块函数 `deferStateResolver(gateway)`，`list` 与 `getWorkspaceView` 共用；`listMcpServers` / `status` / `tools` 改用 `toolInventoryOf`；`collectAvailableTools` 的全局部分改为 `globalToolSchemas`。
  - `test/host-import.test.mjs`：桩 ctx 没有事件总线，换工具后调 `noteToolsChanged`（= 派发 tools/change）。
- **失效语义（关键决定，有宿主源码依据）**：`dsh-scope` 的 `ScopedLayers.effect` 在 register / dispose / restrict 时**同步** `onChange()` → `ctx.emit("tools/change")`。所以代次必须在**事件那一刻**前进；把自增留在微任务 flush 里会留一个“同一 tick 内读到的旧清单却按新代次缓存”的窗口。合并批次仍只前进一次（pending 短路），与旧语义“每轮合并一次”相同。反向断言：不派发事件时缓存不失效（钉住“信号来自事件，而不是自愈”）。
- **量化（同一夹具、同一 RPC）**：
  ```
  list()                        286.9ms → 8.4ms
  getWorkspaceView()（空项目）    3286ms → 10.8ms
  每分钟 12 次轮询              5408ms → 105ms
  ```
- **红用例**：`test/workspace-runtime.test.mjs` 两条（`R4: 同一代次内工具清单只枚举一次…` / `R4: getWorkspaceView 与 list 共用同一次可见工具收集`）。未修代码上分别 `actual: 2, expected: 1`（枚举 2 次 / 收集 2 次）。夹具新增 `globalSchemas` 计数（只增无删）。
- **与计划的偏差**：
  1. 缓存放在 `workspace-runtime.js` 而不是 `mcp-registry.js`：它需要 `appRoot` 与 `toolsEpoch`，而与两者同住才不会引入反向依赖（`mcp-registry` 保持纯函数，可直接测）。
  2. 缓存的不只是 inventory，还有**全局 `schemas()` 快照**：面板可见集与工具清单是同一次枚举，只缓存前者等于把深拷贝又付一遍；`toolInventory` 因此多了可选入参（不传时行为不变）。
  3. 导出 `noteToolsChanged`：不是测试专用门——它就是“工具集变了”这个操作的唯一入口，生产由监听器调。
- **不破坏**：`revision` / `toolRevision` 取值语义未动（同内容同 hash）；`toolCountAmbiguous` 判定未动。缓存里的 schema 对象是**共享只读**，已 grep 确认无就地修改（`projectToolSchema` 只共享 `parameters`，上一层序列化前不写）。
- **已知剩余开销（未改，实测）**：全局标签页上每台**已连接**的全局 MCP 条目仍各读一次作用域视图（`collectAvailableTools` 里的 `entryCtx.tools.schemas(entryCtx)`）：20 条已连接条目时 `collectAvailableTools()` ≈ 454ms、`list()` ≈ 400ms/轮询。它与 R4 修的同一类 N× 深拷贝，但需要逐条目哨兵缓存（与 `readConnectionTools` 同手法），不在 R4 范围内——建议归到 R7 的 HostState（逐条目状态有 owner）一并做。
- **回滚**：`git checkout 2adb277 -- lib/index.js lib/workspace-runtime.js lib/mcp-registry.js test/host-import.test.mjs test/workspace-runtime.test.mjs`。

### R5 装配期的缓存键和被缓存的计算同阶

- **级别**：性能（模型路径，每请求）
- **证据**：`tool-search-runtime.js:250-262` `viewRevision` 每次组装对全部 schema（含 parameters/output）+ 配置做 stringify + SHA-256；同文件 `865-871` 用它当 `viewCache` 键；调用点 `1080/1150/1184`（`systemPrompt.assemble` 的 wrapper）。注释里量过目录文本 735 工具 ~11ms，而算键本身 ~14ms。
- **修法**：粗粒度代次优先（`toolsEpoch` + 配置指纹 + `toolSet` 名字集合哈希），只在代次变化时才落到内容哈希。
- **回归用例**：新增"同一代次内两次 assemble 不重算内容哈希"的计数断言，并保留"工具内容变化必须使视图失效"的既有用例（那条是正确性底线，先确认它存在；不存在则先补）。
- **不破坏**：视图内容与 `revision` 的**失效语义**不变（只是算 key 的方式变便宜）。

---

<h3>结果</h3>

- **实测基线（本机，735 工具 / 1.27MB 参与 hash 的字段）**：`viewRevision` 未命中 ≈ **11.0ms/次**（其中全量内容指纹 9.5ms），而它保护的目录文本 ≈ 11ms——同阶，且**每个请求**都算。名字集合指纹只要 0.05ms。
- **实际改动**：
  - `lib/tool-search-runtime.js`：`resolveRuntimeConfig` 新增可选注入 `toolsGeneration`；`viewRevision` 的内容那一半改成 `contentFingerprintFor(schemas, config, agent)`——按 `(agent, 代次, 名字指纹)` 复用全量内容指纹，代次/agent 缺失时退回全量算。**revision 仍是内容派生**（不是代次号），所以无关的 `tools/change`（项目工具注册、restrict 对齐）不会把所有会话的视图与目录文本一起打穿。
  - `lib/workspace-runtime.js`：导出 `toolsGenerationOf(ctx)`——只在**有人听 tools/change**（`activeGenerationByRoot` 里该 root 的令牌仍 active）时返回代次，否则 `undefined`。
  - `lib/index.js`：`installToolSearch` 注入 `toolsGeneration: () => toolsGenerationOf(ctx)`（与该处既有的 `deferServers`/`serverNames`/`policyFor` 同一注入风格）。
  - `docs/mcp-tool-search-design.md` §9 补一条：复用规则 + “代次不可信就全量”的安全条件。
- **量化（同一 bench）**：
  ```
  稳态（同一代次）  11.0ms → 0.05ms（~200×）
  事件后首轮        ~6–13ms（每代次每 agent 一次，不可避免）
  ```
- **红用例**：`test/tool-search-runtime.test.mjs` 的 `viewRevision: 同一代次复用内容指纹…` 用 **Proxy 计数**观察“有没有真的序列化工具内容”（不靠计时，CI 不 flaky）。未修代码上 `actual: 6, expected: 0`。同时钉住两个反向：代次前进必重算、名字集合变了必重算。
- **集成用例**：`test/tool-search-real-host.test.mjs` 新增「同名工具的内容变化仍然立刻反映到搜索索引」：真 ToolRuntime 走 `dispose → 同名重注册`（**名字与顺序都不变、只有描述变**），断言新描述可搜到、旧描述退出索引、连续组装字节一致。**故障注入验证**：把 `toolsGenerationOf` 冻结成常量 → 该用例红在「内容变了必须重建索引」，证明它不是空转。
- **前置确认**：“工具内容变化必须使视图失效”的用例原本就存在两条（`tool-search-runtime.test.mjs` 直接测 revision；真宿主那条“库存不变则目录字节稳定，工具增减后跟随变化”测装配），本次又补了“同名内容变化”这条最危险的路径。
- **门禁**：`npm test` 1009 例 / 1002 通过 / 0 失败 / 7 skipped；`contract:check` ✔ 55；`client:check` ✔；`build-catalog` ✔ 47 条；`docs-parity` ✔ 20。
- **已知剩余（未改，实测）**：本机宿主 0.2.1 没有 `tools.definitions()`（`probeHost.caps.definitions` 为假），`viewFor` 每次组装都调 `agentTools.schemas(agent)` = **全量深拷贝 ~92ms/735 工具**，现在是单请求的大头。它与本条同源（都能用代次裁决），但要连准入 `toolSet`（逐回合变、不派发事件）一起想清楚，建议单独一项。
- **回滚**：`git checkout 2adb277 -- lib/tool-search-runtime.js lib/workspace-runtime.js lib/index.js test/tool-search-runtime.test.mjs test/tool-search-real-host.test.mjs docs/mcp-tool-search-design.md`。

## D 批：源码结构（纯搬移 / 表驱动）

### R6 `lib/index.js` 2778 行职责混装 + 154 行装饰器脚手架

- **证据**：一个文件同时是 RPC 服务层、profile patch 存储、HMR 锁、连接桥、诊断汇总、更新检查、whats-new；19 个 import；`static` 块 154 行 / 56 个 `__esDecorate`，与 `rpc-contract.js` 的表重复。
- **修法（两小步，分开提交）**：
  1. 装饰器装配改成按 `MCP_METHODS` / `SKILL_METHODS` 表驱动；**`rpc-contract.mjs --check` 保持原样**，它是"顺序 + 名字 + 参数"的闸门。
  2. 按职责拆 `patch-store.js` / `mcp-service.js` / `skills-service.js` / `update-hint.js`，只改 import。
- **不破坏**：wire 形状由契约检查兜底；拆文件不改导出名。

<h3>结果（第 1 步：表驱动装配）</h3>

- **复现/现状**：`grep -c "__esDecorate" lib/index.js` → **56**；`grep -c "Remote(\"" lib/index.js` → **56**（两处静态块合计 55 条 + `Remote` 的 import）。两份清单与 `MCP_METHODS:24` / `SKILL_METHODS:71` 逐字重复。
- **红用例（未修代码上真实失败，非形式红）**：
  - `test/rpc-contract.test.mjs:38`「宿主装配是表驱动的」→ `AssertionError: index.js 不得再手写 Remote("…") 名字清单`，实际 `actual: ['list','status','enable',…]`（55 条）对 `expected: []`。
  - `test/rpc-contract.test.mjs:92`「装配只在原型上真实存在的方法上贴标记」→ `ERR_MODULE_NOT_FOUND: lib/remote-wiring.js`。
  - `test/rpc-contract.test.mjs:51`「真宿主里装配出的 Remote 标记与契约表逐方法同序」→ 先红在 `service "skillsManager" has been registered`（说明它确实起了真 cordis Context 并激活了子插件），改成只挂父 gateway 后绿。
- **实际改动**：
  - 新增 `lib/remote-wiring.js`（38 行）：`applyRemoteMethods(ctor, methods, { decorate, metadata, initializers })` 按表逐条贴 `Remote(method)`，并且**先断言每个名字都是原型上的自有方法**（`Object.hasOwn` + `typeof === 'function'`），否则显式抛错并列出原型上实际有哪些方法。
  - `lib/index.js`：两处静态块各收成 `applyRemoteMethods(this, <表>, { decorate: __esDecorate, metadata: _metadata, initializers: _instanceExtraInitializers })` 一行；删掉 3 条 `let _…_decorators` 声明；`import { Remote, TypertRemoteService }` → 只剩 `TypertRemoteService`，新增 `applyRemoteMethods` / `MCP_METHODS, SKILL_METHODS` 两个 import。**`var __esDecorate` 定义逐字保留**（仍是装配回调），`__runInitializers` 未动。**2685 行**（原 2788，净 −103）。
  - 被脚手架包住的 4 条注释搬到它们解释的实现上：`setDeferAll` 的方法文档块补上"曾经漏了 @Remote"那段故障形态（`lib/index.js:1673` 附近），`toolSearchSettings` / `toolLoadingSettings` 各补一条"为什么读写分两个方法 / 名单不再手写"。`setDefer` 原有的 `/** … */` 文档块本来就在方法上，未动。
- **闸门也跟着改了（这一步的必然）：** 4 处 `Remote("…")` 正则读者必须换，否则它们只能永远读到一个空数组：
  - `scripts/rpc-contract.mjs:checkHostFace`：先查"不得残留手写字面量"（残留即两处登记同一件事，而 `mark()` 对同名标记**静默去重** → 谁生效取决于执行顺序），再查"两个装配点、参数分别是 MCP_METHODS / SKILL_METHODS"。`readHostRemoteOrder` 保留导出（它现在是"应返回空"的反向指标）。
  - `test/rpc-contract.test.mjs`：新增上面三条（源码形状 + 真宿主 `remoteMethods()` 逐方法同序 + 装配期断言）。真宿主那条是**唯一**能看见"装配写错导致 wire 面消失"的用例——源码正则可读不出 initializers 是否传对。
  - `test/package-contract.test.mjs:442` / `:486`：`declared` 从源码正则改为读**真装配**（`byPosition(hostIndex, [/applyRemoteMethods\(\s*this,\s*(MCP_METHODS|SKILL_METHODS)/g])` + 契约表扁平化）。第四面（原型方法集合 = 契约）语义不变。
- **故障注入（三条，均先注入后逐字节复原并 `cmp` 校验）**：
  1. 把 MCP 的实参换成 `SKILL_METHODS` → `contract:check` 红 `✖ applyRemoteMethods 的装配点应为 [MCP_METHODS, SKILL_METHODS]，实际 [SKILL_METHODS, SKILL_METHODS]`；`rpc-contract.test.mjs` 红 2 条。
  2. 把 MCP 侧的 `initializers` 换成 `[]`（模拟装配漏参）→ **源码形状用例照旧绿**，只有真宿主那条红：`actual` 只剩 `['list']`（55 条全丢）。这条注入正是真宿主用例存在的理由。
  3. 回退成手写 `Remote("…")`：即上表第一条红用例。
- **门禁**：`npm test` **1011 例 / 1004 通过 / 0 失败 / 7 skipped**（1009→1011，新增 2 条）；`contract:check` ✔ **55 个方法**；`client:check` ✔ 10 分片 / 7488 行；`build-catalog` ✔ 47 条 · 10 分类且 `git status` 无变化；`docs-parity` ✔ 20。
- **wire 形状为什么没变**：
  - `lib/typert.js` **逐字节未动**（`git diff --stat lib/typert.js` 空），`lib/client.js` 的 descriptor 段也未动（`contract:check` 的生成比对覆盖它，`git diff --stat lib/client.js` 里的 132/132 全部是 R1–R5 的既有改动）。
  - 标记顺序 = 表里的顺序：`__esDecorate` 按调用顺序把 initializer 追加进 `_instanceExtraInitializers`，构造末尾的 `__runInitializers` 按同一顺序跑，`mark()` 再按顺序追加——网关按这个顺序发现 endpoint。
  - `exportName` 与 `method` 同名时协议不下发 `exportName`（`lib/index.js` 的 `mark()` 只在不同名时展开），新用例断言了"55 条里一条 exportName 都没有"，所以 wire 上的段名与原先逐字相同。
  - `access: { has, get }` 不再生成：`Remote()` 只读 `kind/name/static/private/addInitializer`（`dsh-typert-protocol/lib/index.js:367-378`），`__esDecorate` 只是把 `contextIn.access` 原样拷进 context（同文件 `:35-65`），**无读者**。这不构成形状变化，因为 access 从不进任何 wire 产物。
- **不破坏**：`setDeferAll` / `setDefer` / `tools` 的"空 = 全局族"判空未动（R1 的红线）；`static inject` / `static Config` / 构造函数逐字未动；`SkillsManagerGateway` 仍是 `McpManagerGateway` 的子插件（新用例顺带确认了这一点：重复挂载会撞 `service has been registered`）。

<h3>结果（第 2 步：按职责拆文件）</h3>

- **实测数字**：`lib/index.js` **2685 → 1590 行**（累计从 2788 → 1590，净 −1198）；`git diff --stat lib/index.js` = **75 insertions / 1263 deletions**。新增 8 个模块，合计 1218 行。
- **拆法（与 PLAN 原文的偏离，理由在后）**：原文列的是 `patch-store.js` / `mcp-service.js` / `skills-service.js` / `update-hint.js`。实际落成 8 个模块，**没有拆 mcp-service / skills-service**：

  | 新模块 | 行 | 装的是 | 被谁用 |
  |---|---|---|---|
  | `lib/patch-store.js` | 266 | patch 读-改-写、HMR 锁、托管条目定位、从 patch 内容派生的视图 | gateway 的写入方法 |
  | `lib/mcp-rows.js` | 183 | 一行 MCP 的展示投影（全局行 + 项目行，同一个 `deriveMcpPhase`） | `list` / `status` / `getWorkspaceView` |
  | `lib/mcp-import-plan.js` | 252 | 导入/合并的**决策**（哪些算新增/更新/移除）与预览文案 | `previewImport` / `importJson` / `previewImportSource` / `importSource` |
  | `lib/mcp-write-paths.js` | 248 | 写入路径（落盘与生效分开报、锁内的写与锁外的 reconcile） | 所有变更型 RPC |
  | `lib/mcp-projection.js` | 106 | 配置播种规则（掩码 / 保留原值标记 / reveal 求值），读出去与写回来成对 | 行投影 + 详情 + 导入预览 |
  | `lib/update-hint.js` | 127 | 包身份、让位检测判据、更新检查（24h 进程内缓存） | `updateHint` / `whatsNew` / `conflictingManager` |
  | `lib/mcp-log.js` | 94 | mcp-client 日志采集（连接状态只存在于日志） | 构造 + `status` / 行投影 |
  | `lib/remote-wiring.js` | 42 | **第 1 步**的 `applyRemoteMethods` | 两个 gateway 的静态块 |

- **为什么没拆 mcp-service / skills-service**：那两个"服务"就是 `McpManagerGateway` / `SkillsManagerGateway` 类本身，而第 4 面契约（`test/package-contract.test.mjs` 的"gateway prototypes are the fourth contract face"）是拿 `Object.getOwnPropertyNames(Gateway.prototype)` 判定的。把方法体搬进 mixin 会改原型链形状，收益（文件更短）与风险（wire 面、`static inject`、第四面判定同时受影响的静默失败）不成比例。**"只改 import"这条约束恰好对应这个判断**：方法体不动，搬的是它们调用的实现。
- **纯搬移的硬证据**（`node .tmp-review/verify-function-bodies.cjs`，以 R6.1 结束态的 index.js 为基准）：
  ```
  搬移前顶层函数: 78
  搬移后顶层函数: 78
  函数体逐字节不变: 78
  消失: 0
  函数体变了: 0
  离开 index.js 的: 73 → appendRecent, mcpLogLabelSource, …, copyResultNote
  新增的顶层函数: 0
  ```
  脚本按 `^(async )?function name(` 切函数体、逐字节 sha256 比对：**78/78 函数体哈希不变，0 消失、0 变更、0 新增**，73 个离开 `index.js` 进入新模块。这比"行内容多重集"强——后者会被"两处都有同一条通用语句"干扰（实测有 7 条这种行，全是真的重复语句如 `const state = await managedState(ctx);`，不是残留副本）。
- **红用例**：`test/module-boundaries.test.mjs`（新增，3 条）。未搬前实测红：
  - `AssertionError: checkForUpdate 的实现应住在 lib/update-hint.js`；
  - `AssertionError: lib/index.js 现在 2686 行：实现应当继续住在各自的模块里`。
  每条都是**成对**断言（`doesNotMatch(宿主)` + `match(新文件)` + 反向"装配面还在 index.js"），所以"删掉实现"和"搬走又留副本"都能红。
- **故障注入验证**：把 `redactMap` 重新写回 `index.js`（模拟"搬走但留旧副本"）→ 红线报在 `index.js 只留装配与 wire 面` 与 `搬走的符号仍然从包入口可达`。注入前备份、复原后 `cmp` 逐字节校验。
- **5 类"读 index.js 源码"的闸门跟着改了读者**（搬移必然，不改就是"对空数组做断言"的假绿）：
  - `test/package-contract.test.mjs:234` reveal 求值 → 求值器查 `mcp-projection.js`，调用点仍查 `index.js`（两半缺一不可，注释里写清了为什么）；
  - `:365` `row.mountFailed = true;` → `mcp-rows.js`；
  - `:546` `maskedFields: …` → `mcp-import-plan.js`（掩码漏写泄的是真凭据，所以这条跟着事实走）；
  - `:746` 行投影字段清单 → `mcp-rows.js`；
  - `:740` `alignWorkspaceConnections` 实现 → `mcp-write-paths.js`（"RPC 里不直接调 reconcile"那条仍查 `index.js`）。
- **搬移过程中被全量用例抓到的真错误（4 次，都不是断言而是 ReferenceError）**：`mcp-import-plan.js` 缺 `REDACTED_VALUE`、`mcp-rows.js` 缺 `MANAGED_CONFIG_FIELDS` 与 `projectToolSchema`、`mcp-write-paths.js` 把 `composedRowVisible`（在 profile-composition.js）和 `toolSearchDisabled`（在 tool-search-config.js）接错了文件。
  **这才是这类重构的主要风险**：`import('./lib/index.js')` 会成功（模块图完整），只有跑到那条分支才炸。所以每一步都跑了全量 `npm test`，而不是只跑"看起来相关"的那几个文件。
- **门禁**：`npm test` **1014 例 / 1007 通过 / 0 失败 / 7 skipped**（1011→1014，新增 module-boundaries 3 条）；`contract:check` ✔ **55**；`client:check` ✔ 10 分片 / 7488 行；`build-catalog` ✔ 47 · 10 且 `git status` 无变化；`docs-parity` ✔ 20。
- **不破坏**：`lib/typert.js` 未出现在 `git diff` 里（逐字节未动）；`lib/client.js` 的 descriptor 段未动（`contract:check` 的生成比对覆盖）；导出名未变（`McpManagerGateway` / `SkillsManagerGateway` / `checkForUpdate` / `summarizeWorkspaceRow` / default 全在，新用例 `搬走的符号仍然从包入口可达` 钉住）；两个 gateway 类、`static inject`、`static Config`、构造函数、所有方法体**逐字未动**。
- **已知剩余**：`lib/index.js` 1590 行里，`McpManagerGateway` + `SkillsManagerGateway` 两个类占约 1165 行（wire 面本体），其余 425 行是 `installToolSearch` 装配、`listMcpServers` / `deferStateResolver` / `hostLiveAgents`（列表胶水）与 tsc 助手。再拆就要动类结构或把列表胶水搬走——前者是 R8 之前不该碰的，后者收益很小。
- **回滚**：`rm lib/{patch-store,mcp-rows,mcp-import-plan,mcp-write-paths,mcp-projection,update-hint,mcp-log,remote-wiring}.js test/module-boundaries.test.mjs && git checkout e29f21c -- lib/index.js lib/rpc-contract.js scripts/rpc-contract.mjs test/package-contract.test.mjs test/rpc-contract.test.mjs`（同第 1 步的注意：`e29f21c` 不含 R1–R5，要保留它们就只用 `git diff` 反向应用本步的 hunk）。
- **回滚**：`rm lib/remote-wiring.js && git checkout e29f21c -- lib/index.js lib/rpc-contract.js scripts/rpc-contract.mjs test/rpc-contract.test.mjs test/package-contract.test.mjs`（注意 `e29f21c` 不含 R1–R5，所以只回滚本步涉及的文件；`lib/index.js` 若同时含 R1–R5 改动，改用 `git diff` 反向应用本节列出的 5 个 hunk）。

### R7 12 个模块级可变单例，诊断表没有 owner

- **证据**：`sharedConnections`、`agentProjectSlotsByRoot`、`agentWorkspaceStates`、`workspaceConfigCache`、`workspaceWriteState`、`workspaceMountErrors`、`workspaceScopeErrors`、`workspaceRestrictErrors`、`warnedDiagnostics`、`toolsEpoch`、`denyCacheByRoot`、`activeGenerationByRoot`；R2 的根因就是"记录者有 owner、清除者没有"。
- **修法**：收成 per-app-root 的 `HostState`（`open(root)` / `dispose()` 一处清），键与上限写在类里。
- **不破坏**：`projectConnections` 等只读视图字段不变；`dispose()` 的清空范围要与现在 `disposeAllProjectSlots` 的实际行为逐项对齐（先写一个"卸载后状态为空"的用例，再搬）。

<h3>结果（R7：状态归属与一处清）</h3>

- **红用例（未修代码上真实失败，三条全部实质红，非形式红）**，都加在 `test/workspace-runtime.test.mjs` 末尾的「R7」分组：
  1. 「卸载插件后，挂载失败记录必须消失」→ `actual: [{serverName:'db',error:'模拟：宿主未提供 mcp-client'}] vs expected: []`。前置断言（`before.length === 1`）先证明"真的记下了一笔"，避免空转。
  2. 「卸载插件后，作用域故障与 restrict 记录同样不留」→ 先红在 `前置：必须真的记下一笔作用域故障（实际 []）`（我第一版用 `fixture.failToolReads = true` 赋值，而它是**方法**，已改成既有用例的时序：`connectAll()` → `failToolReads(true)` → 推一次 `tools/change`）；改对后红在 `卸载后作用域故障记录仍是脏的`。
  3. 「工具代次是 per app root 的」→ `B 没有被任何变更碰过，代次不得前进（38 → 39）`。**这一条是量化证据**：模块级 `let toolsEpoch` 让 A 的每一次 `tools/change` 都把 B 的缓存（工具清单 / 全局 schema 快照 / deny 展开 / ToolSearch 视图 revision）一起打穿。症状只在多实例下出现，单实例测试永远看不见。
- **改了什么**：
  - 新增 `lib/host-state.js`（`HostState` 类）。字段：`connections` / `projectSlots` / `configCache` / `schemasCache` / `inventoryCache` / `denyCache` / `scopeModule` / `toolsChangeFlush` / `warned` / `agentStates`(未用) / `epoch` / `generation` / `ownedPaths`。三处上限从散落的字面量变成 `HostState.cacheLimit / warnLimit / denyLimit`（64 / 64 / 32）。
  - `lib/workspace-runtime.js`：`hostStates: WeakMap<appRoot, HostState>` + `hostStateOf(ctx)` / `hostStateOfRoot(root)`；删掉 `bucketOf`（它的"按 root 分桶"职责现在由 HostState 承担）；`agents` 兼容入口不变。
  - `cleanup()` 里一处清：`const teardown = disposeAllProjectSlots(ctx); hostStateOf(ctx).dispose(); return teardown;`
- **12 项的去向（这是本项的实质判断，逐项理由）**：

  | 状态 | 去向 | 理由 |
  |---|---|---|
  | `sharedConnections` | **HostState.connections** | 键是 app root（WeakMap），本来就是实例状态；进类后卸载可**枚举清理**（以前只能等 GC） |
  | `agentProjectSlotsByRoot` | **HostState.projectSlots** | 同上（投射索引，注释已写明"不是所有权凭据"） |
  | `workspaceConfigCache` | **HostState.configCache** | 键是 app root + 项目路径，per 实例；上限搬进类 |
  | `activeGenerationByRoot` | **HostState.generation** | 键是 app root；令牌本身就该只有一个 owner |
  | `denyCacheByRoot` | **HostState.denyCache** | 键含工具代次，代次 per 实例 ⇒ 缓存也必须 per 实例 |
  | `globalSchemasCache` / `toolInventoryCache` | **HostState.schemasCache / inventoryCache** | 同上（R4 新增，PLAN 特别点名要一起归） |
  | `scopeModulePromises` | **HostState.scopeModule** | 键是 app root，"每个 app 一份 dsh-scope"是原注释的原话 |
  | `toolsChangeFlushByRoot` | **HostState.toolsChangeFlush** | 键是 app root（合并刷写 promise） |
  | `warnedDiagnostics` | **HostState.warned** | "这个实例已经告过什么"；卸载后必须回空白，否则新代再也告不出同一条故障 |
  | `toolsEpoch` | **HostState.epoch** | **语义修正**：代次是"本实例的变更序号"，模块级会让多实例互相打穿（第 3 条用例量化） |
  | `agentWorkspaceStates` | **留模块级** | 键是 **agent** 而非 root，而 agent → root 的映射不存在；`liveAgents()` 必须能**枚举**（WeakMap 做不到）。它的 owner 机制本来就对（两层：agent scope effect 删自己那条 + cleanup 按 `state.root` 过滤后逐条删）。搬进 HostState 只会把一个正确的机制拆成两半 |
  | `workspaceMountErrors` / `workspaceScopeErrors` / `workspaceRestrictErrors` | **留模块级 + owner 登记** | 键是**项目路径**，事实属于"这个项目的那台服务器"，不属于某个 app 实例（原注释的解释成立，不推翻）。它们的写入点统一走 `hostStateOf(ctx).own(wsPath)` 登记，`dispose()` 按登记删 —— 这正是 R7 要补的那一半 |
  | `workspaceWriteState` | **留模块级，且卸载不删** | 它是"同一份文件的读-改-写串行化"，本质是**文件锁**：两个 app 同时写同一个 `.dsh/mcp.json` 时必须在一条队列上，删条目会让两条队列并存 → 并发丢更新。键是文件路径，空闲条目只是一个已 settle 的 Promise，没有实例引用 |

- **对象级补充（PLAN 点名但属于别的模块的两个）**：
  - `lib/tool-search-runtime.js` 的 `contentFingerprintCache`：**保留** `WeakMap<agent, {generation, names, content}>`。它是 per-agent 且用 WeakMap，agent 消失即回收，不存在"卸载后残留"；搬进 HostState 反而要给 tool-search-runtime 加一条指向 host-state 的依赖，而它现在是**被** workspace-runtime 的调用方注入的（单向依赖）。
  - `lib/patch-store.js` 的 `patchWriteQueues` / `hmrLockDepth`：`WeakMap<ctx>`，随 ctx 回收，同上。
  - `lib/mcp-log.js` 的 `recentMcpLogs` / `recentFiberLogs` / `logCaptureState`：`WeakMap<scope>`，且 `ensureLogCapture` 注册的 `ctx.effect` 已经在卸载时 `delete` 这三个键（原本就是"一处清"）。
  - `lib/update-hint.js` 的 `updateCheckState`：**刻意**进程级（24h 节流，跨插件重装要保留），清掉等于重装后立刻再打一次 registry。
- **实测（故障注入，两次，均备份 + `cmp` 校验逐字节复原）**：
  1. 从 `cleanup()` 删掉 `hostStateOf(ctx).dispose()` → 第 1、2 条红（第 3 条不红是**正确**的：它测 per-root 语义，与 dispose 无关）。
  2. 把 `const toolsEpoch = 0` 注回模块级 → 防回退闸 `per-root 的可变状态只住在 HostState 里` 红。
- **踩到并修掉的两个真错误（都被既有用例抓住）**：
  1. `dispose()` 放在 `disposeAllProjectSlots(ctx)` **之前** → 后者遍历到空表，**一条连接都不拆**。三条既有用例同时红：`末代卸载必须销毁连接 1 !== 0`、`插件卸载的 cleanup 必须返回 teardown promise`、`HMR 后运行中会话的工具投射必须撤回`。修法：先取 teardown（它的同步阶段已把条目全部取出），再 `dispose()`，最后返回 teardown。
  2. `recordWorkspaceRestrictError(wsPath, deny, error)` 没有 ctx，我把它写成 `hostStateOf(ctx)` 后 `ReferenceError` 被 restrict 的 `catch` 吞掉，症状是"restrict 失败不再被记账"（3 条用例红但看不出原因）。修法：给它加 `ctx` 形参（唯一调用点本来就有）。
- **门禁**：`npm test` **1018 例 / 1011 通过 / 0 失败 / 7 skipped**（1014 → 1018，新增 4 条）；`contract:check` ✔ 55；`client:check` ✔ 10 分片 / 7488 行；`build-catalog` ✔ 47 · 10 且 `git status` 无变化；`docs-parity` ✔ 20；`lib/typert.js` 无变化。
- **不破坏**：`projectConnections` 等只读视图字段未动；三张诊断视图函数的签名未变（`workspaceMountErrorsView(wsPath)` 等），所以 12 处调用点（`index.js` 3 处 + 测试 9 处）一处都没改；`liveWorkspaceAgentCount(wsPath)` 仍是"按项目统计、不区分 root"（原语义）。
- **回滚**：`rm lib/host-state.js && git checkout e29f21c -- lib/workspace-runtime.js` 后手工恢复 R1–R5 在该文件里的改动（或用 `git diff` 反向应用本节 hunk）；测试侧 `git checkout e29f21c -- test/workspace-runtime.test.mjs` 会一并丢掉 R1–R5 的用例，改用反向 hunk。


---

## E 批：客户端结构

### R8 `McpTab` 973 行 / 34 个 useState

- **证据**：`lib/client/70-shell.js:130-1102`，973 行、34 useState、6 useRef、9 useCallback、8 useEffect、6 useMemo；`SkillsPanel` 494 行 / 16 useState 同类。
- **修法**：抽 `useMcpServers`（load + poll + seq/revision 防串）、`useReveal`、`useUpgrade`；视图按列表/详情/横幅分区。`SkillsPanel` 拆管理面与市场面。
- **收益**：一半在可测性——现在这些逻辑只能钉源码文本（`test/client-behavior.test.mjs`）。
- **不破坏**：现有行为用例全绿；`client:check` 逐字节重建；窄屏与移动宽度的 CSS 类名不变（`test/panel-css-invariants.test.mjs`）。

<h3>结果（R8 第一批：useReveal + useMcpServers）</h3>

- **前置调查（这是本项的真实成本，先量再动）**：读 `lib/client.js` 源码的断言共分布在 27 个测试文件里，其中 **`test/panel-chrome.test.mjs` 独占 42 条**。逐条分类后：约 27 条钉的是 **DOM/类名/文案**（抽 hook 不动 JSX ⇒ 天然不受影响），约 15 条钉的是**实现写法**（`const scopeChoices = useMemo`、`}, [call, isWorkspace, knownNames, knownNamesKey])` 这类依赖数组与 ref/state 分工 ⇒ 抽 hook 必然失配）。`test/client-behavior.test.mjs` 反而只有 **1 条**读源码，其余 18 条走 `__test` 注入真跑。
- **实测数字**：

  | 指标 | R8 之前 | 现在 |
  |---|---|---|
  | `McpTab` 行数 | 973 | **864** |
  | `useState` | 34 | **23** |
  | `useRef` | 6 | **1**（只剩 `panelRef`） |
  | `useEffect` | 8 | 6 |
  | `useCallback` | 9 | 5 |
  | `lib/client.js` | 7488 行 | 7548 行 |

- **改了哪两个 hook**（`lib/client/70-shell.js`，同一分片内，**不新增分片**——新增分片会动 `PART_FORWARD_REFS` 与分片计数，与"纯搬移"无关）：
  - `useReveal({ call, scope, resetOn, flash })`：`revealed` / `revealGeneration` / `revealRevisionRef` / `clearRevealed` / `revealValue` / `onReveal`，以及"选中项变了就清明文"的 effect。它是一套**协议**（展开→待读→代次校验→折叠），不是几个独立状态。
  - `useMcpServers({ call, scope, timer, flash, revealRevisionRef, clearRevealed })`：11 份数据状态 + `loadSeq` / `manualRefreshSeq` / `revisionRef` + `load` + 轮询 effect；对外暴露 `load` / `invalidate()` / `resetScope()` 与三个乐观更新用的 setter。
- **真正修掉的耦合**：组件里原有 **5 处 `revisionRef.current = ''`**，每处都在声明"我改了本地数据，下次 load 必须写回"，但相隔几百行、各改各的。现在是 `invalidate()`——这条协议有了名字，且组件里再也拿不到 `revisionRef`（防回退闸钉住）。`switchScope` 里"作废在途请求 + 清空作用域数据"那一整块同样收成 `resetScope()`。
- **等价性证据（产物级，这是本轮最硬的一条）**：新增 `.tmp-review/render-snapshot.mjs`——用与 `.tasks/_uipreview.mjs` 相同的假 React 装载**真 `lib/client.js`**，渲染 `McpTab` 的三个真实分支（全局空列表 / 悬浮态 / 加载中），落成 HTML。抽 hook **前后逐字节 `cmp` 相同**（12990 bytes / 3 场景）。
  为什么必须有它：本仓库的假 React `useEffect` 是 noop，**hook 跑不起来**；所以"纯搬移"不能靠读 diff 断言，只能靠 DOM 产物。
- **新增闸门**：`test/client-hooks.test.mjs`（5 条，全部结构断言 —— 客户端的 hook 在本仓库测不了行为，这是唯一可行形态）：
  1. 10 份数据 state / 3 个协议 ref / reveal 的两个 state 不得再出现在组件里（成对断言：hook 必须被调用）；
  2. 组件里 `revisionRef` 出现次数必须为 **0**，且 `invalidate()` 至少 4 处、`resetScope()` 必须存在 ⇒ 封死"绕过 invalidate 裸改协议"；
  3. **TDZ 回归闸**：`flash` 的声明必须早于 `useReveal` / `useMcpServers`，`useReveal` 早于 `useMcpServers`；
  4. 规模不回退（行数 / useState / useRef 三个上限）；
  5. 两个 hook 必须在 70-shell 分片里，且 `lib/client.js` 里也有（拼装闸）。
- **故障注入（两次，均备份 + `client:write` 重建 + `cmp` 逐字节复原）**：
  1. 把 `useReveal` 调用挪到 `flash` 之前 → 闸门 3 红；
  2. 在组件里写一处 `revisionRef.current = ''` → 闸门 2 红。
- **踩到并修掉的真错误（1 个，只有真渲染才暴露）**：第一版把 `useReveal({ …, flash })` 写在 `flash` 的 `const` **之前** → 渲染时抛 `ReferenceError: Cannot access 'flash' before initialization`，`panel-chrome` 里 7 条渲染类用例同时红（`技能服务不可用时给出降级通知` 等）。**这一类错误在纯非渲染断言下是全绿的**，所以闸门 3 是必要的，不是形式主义。
- **门禁**：`npm test` **1023 例 / 1016 通过 / 0 失败 / 7 skipped**（1018 → 1023，新增 5 条）；`client:check` ✔ 10 分片 / 7548 行；`contract:check` ✔ 55；`build-catalog` ✔ 47 · 10 且 `git status` 无变化；`docs-parity` ✔ 20；`lib/typert.js` 与 `lib/index.js` 无变化。
- **为什么不抽 `useUpgrade`（PLAN 原文列了它）**：`updateHint` / `upgradeState` 是**渲染的直接输入**（`lib/client/70-shell.js` 的 Notice 分支要同时读两者，且 done 分支有三条谨慎规则：不得再读 `updateHint`、`phase === 'done'` 时 state 要留着、`blocked/not-npm` 要带当前版本）。抽成 hook 只是把同一批值换个名字传回来，减少的组件行数为零，而把"三条 done 分支规则"和它们的读点分开。**判断：不抽**，理由是"抽象要对着一个真实的力"，这里没有第二个消费者。
<h3>结果（R8 第二批：SkillsPanel 的两个面）</h3>

- **前置调查**：`SkillsPanel` = `lib/client/80-skills-face.js:487`，**493 行 / 16 `useState` / 3 `useRef` / 12 `useCallback` / 10 `useEffect`**。读它源码的断言只有 **1 条**（`test/skills-client.test.mjs:295` 数 `callSkills('…')` 的调用名），其余 36 条全是**渲染树断言**（假 React 带 useState 槽位 + 重渲染循环）。⇒ 与 `McpTab` 相反，这一块的失配风险很低，坏的是"归属"而不是"正则"。
- **实测数字**：

  | 指标 | 之前 | 现在 |
  |---|---|---|
  | `SkillsPanel` 行数 | 493 | **308** |
  | `useState` | 16 | **3**（`query` / `statusFilter` / `collapsedGroups`，纯视图） |
  | `useRef` | 3 | **0** |
  | `useCallback` | 12 | **2** |
  | `lib/client.js` | 7548 行 | 7625 行 |

- **拆法**（同分片内，不新增分片）：
  - `useSkillsHub({ call, localeV })`（88 行）：`hub` / `hubCategory` / `hubCategoryLabels` / `hubDetail` / `marketDraft` / `hubKeyword` + 两个在途闸 ref + `searchHub` / `loadMoreHub` / `hubHasMore` + 两个 effect。它守的是**翻页状态机**的三条规则（草稿/已提交分离、同步在途闸、分类只随语言重取）——每条单独失效的症状都很轻（慢一点、少几页、多一次请求），散在 493 行里没人会同时看见。
  - `useSkillsManage({ call, workspaces, onSummary, flash })`（144 行）：`rows` / `selectedKey` / `body` / `busy` / `entry` / `scope` / `targets` + `load` / `loadBody` / `selectRow` / `act` / 三个 toggle / `removeRow`。三条纪律写进 hook 头注释：工作区列表由 props 传入（`call` 是 skillsManager，列表在 mcpManager）、安装目标只列可写、选中存身份不存对象。
  - **`confirmInstall` 留在组件**（23 行）：它是两个面的**唯一交汇点** —— 读管理面的 `installTarget`（渲染派生）与市场面的 `setHubDetail`。放回任一 hook 都要么把另一面的 state 拖进来，要么把渲染派生值塞进 hook 依赖。这是**拆分的边界**，不是"没拆干净"（闸门钉住）。
- **归类判断（一次自我纠正）**：第一版把 `query` 放进了 `useSkillsHub`。原文注释写的是"**管理面**列表的筛选词：只管本地那张表"，而它与 `marketDraft`/`hubKeyword` 分开放正是为了"两个面的输入框不互相串"。已移回组件——hook 的边界必须跟着**职责**走，不是跟着"都是搜索框"走。
- **接线错误（4 个，全部被 `skills-client.test.mjs` 的渲染断言当场抓住）**：
  1. `setHubDetail is not defined` —— 我在移除 `query` 时把同一行的 `hubDetail, setHubDetail` 一起删了（`split/join` 的 count 校验只保证"出现两次"，没保证"只删了该删的"）；
  2. `selected is not defined` —— 管理面里混进了一个依赖组件派生值的 effect（"筛选排除选中项时补选第一行"），它读 `selected`/`visibleRows`，必须留在组件；
  3. `flash is not defined` —— `act` 用 `flash`，它是 props，hook 需要显式接收；
  4. `installTarget is not defined` —— 见上，`confirmInstall` 不该进 hook。
  **这 4 次都是"搬错一块"而不是"逻辑写错"**，正是纯搬移类重构的典型故障；渲染级断言比源码正则强的地方就在这里。
- **等价性证据**：`.tmp-review/render-snapshot.mjs` 的 6 个场景（`McpTab` 3 个 + `SkillsPanel` 的 manage/market/带工作区 各 1 个，16663 bytes）。取基线的做法：把分片恢复到改动前 → `client:write` → 渲染 → 再换回新分片 → 渲染 → `cmp`。**逐字节相同**。
- **新增闸门**（`test/client-hooks.test.mjs` 从 5 条 → 8 条）：两个 hook 的归属、`confirmInstall` 必须留组件、`SkillsPanel` 只剩三个纯视图 state、规模上限、hook 必须在同一分片。
- **故障注入（1 次，含一次自我纠错）**：
  1. 第一次注入**没生效**（`replace` 的锚点写成了 `McpTab` 的签名形态），闸门照旧全绿 —— 那是**假绿**。重新用存在的锚点注入并断言替换真的发生，闸门立刻红在"技能面板的两个面各自成 hook"。**教训：注入脚本必须校验"替换确实发生"，否则验证本身就是假的。**
- **门禁**：`npm test` **1026 例 / 1019 通过 / 0 失败 / 7 skipped**（1023 → 1026，新增 3 条）；`client:check` ✔ 10 分片 / 7625 行；`contract:check` ✔ 55；`build-catalog` ✔ 47 · 10 且 `git status` 无变化；`docs-parity` ✔ 20；`lib/typert.js` 与 `lib/index.js` 无变化（`index.js` 的 M 是 R1–R7 的既有改动）。
- **回滚**：`git checkout` 恢复 `lib/client/80-skills-face.js` 后 `npm run client:write`；或用 `git diff` 反向应用本节两个 hunk（`useSkillsHub` 插入、`useSkillsManage` 插入 + 组件内的定义删除）。

- **本批之后的两条结论（第三批已处理，见下一节）**：
  1. `SkillsPanel` 的两个面已拆完（本节即它的结果）；
  2. "视图按列表/详情/横幅分区"经第三批论证**不做子组件提取**——`panel-chrome` 的断言读整个 bundle，搬位置零失配也零收益。

<h3>结果（R8 第三批：通知条计算抽成纯函数 + JSX 分区的成本结论）</h3>

- **动手前先盘的清单（这是本批的主要交付之一）**：`test/panel-chrome.test.mjs` 那 42 条 `clientSource` 断言逐条分类后得出一个关键事实——**它们读的是整个 `lib/client.js` bundle，所以"搬位置"零失配、也零收益，只有"改写 JSX"才会失配**。
  - 印证：第二批把 `marketDraft` / `hubKeyword` 搬进 `useSkillsHub` 后，钉它们的 6 条断言（`:1019/:1020/:1022/:1024/:1027/:1028`）**全部仍然绿**，因为那段代码还在 bundle 里。
  - 结论：把 JSX 提取成"传 20 个 props 的子组件"**不会让任何断言变强**，只是把闭包捕获改成显式传参。**因此本批不做子组件提取**，只做一处**有真实收益**的提取（下条）。这个判断写在这里，免得下一轮重复劳动。
- **做了什么**：`buildNotices({ … })`（`lib/client/70-shell.js:127`）——把 75 行的通知条计算（原 791–865）从 `McpTab` 里抽成**模块级纯函数**。
  - `McpTab` **864 → 791 行**（累计从 973 → 791）。
  - 收益不是行数，而是那四条的**顺序与互斥规则**从"只能读 500 行 JSX 才知道"变成函数的输入输出。
- **新增行为用例（3 条，真的在跑那个函数，不是源码正则）**：`test/client-behavior.test.mjs`，用本文件既有的 `__test` 注入手法：
  1. 「顺序固定：降级 → 读取失败 → 三种项目级故障 → 更新」——六条同时成立时顺序必须稳定；
  2. 「项目级故障只在项目作用域下出现，且三种故障各成一条横幅」——挂载失败/作用域失败/restrict 失败**修法不同**，合在一起用户不知道先修哪个；
  3. 「升级提示的三个阶段都显示，且 done 阶段不依赖 updateHint」——done 时宿主已把 `updateHint` 刷成 null，仍必须显示（否则"升级成功后提示消失"像是失败）。
- **踩到的三个细节坑（都不是逻辑错，全是"验证方式"错）**：
  1. **漏传自由变量**：第一次搬完只红了 1 条（`liveAgents is not defined`），但我手写的 `require` 校验只检查"我想到的符号"——那等于"我保证我没漏"。补了 `.tmp-review/free-vars.cjs`（自由变量差集）后机器报出真正漏掉的 **3 个**：`liveAgents` / `refreshing` / `load`。
  2. **断言值不能凭"应该有"猜**：我第一版按"三种项目级故障会合并成一条"写了 `workspace-failures`，实际源码里是三张独立横幅（`mount-failed` / `scope-failed` / `restrict`），各有各的原因。改成从 `buildNotices` 源码里读真实 key。
  3. **跨 vm realm 的数组比较**：`buildNotices` 跑在 vm 沙箱里，`map/filter` 返回沙箱的 `Array`；`assert/strict` 的 `deepEqual` 是 `deepStrictEqual`（**比原型**），于是"内容完全相同"的两个数组仍然失败，**错误信息里 actual 与 expected 一模一样**。修法：用主 realm 的 `Array.from(...)` 重建。
- **新增工具（可复用，别再手写一次性脚本）**：
  - `.tmp-review/inject.cjs`：注入 → **自校验替换真的发生**（锚点唯一 + 写入后读回哈希比对）→ 跑验证 → 逐字节还原并 `cmp`。第二轮那次假绿就是没这一步。
  - `.tmp-review/move-block.cjs`：按**内容锚点**切块（起止唯一、`require` 证明切对、`forbid` 证明没多切），替代行号与裸 `split/join`（后者在第二批里连带删掉过 `hubDetail`）。
  - `.tmp-review/free-vars.cjs`：切块的自由变量差集，抓漏传。
- **故障注入（1 次，用新工具，自带校验）**：去掉 `scope !== 'global' &&` 这个条件（真实的回退形态）→ 第 2 条用例红（`pass 21 · fail 1`），恢复后 `client:write` 重建 + 逐字节还原。
- **门禁**：`npm test` **1029 例 / 1022 通过 / 0 失败 / 7 skipped**（1026 → 1029）；`client:check` ✔ 10 分片 / 7643 行；`contract:check` ✔ 55；渲染快照 **6 场景逐字节相同**；`lib/typert.js` 与 `lib/index.js` 无变化。
- **R8 的结论**：三批之后 `McpTab` 973 → 791、`SkillsPanel` 493 → 308，抽出五个单元（`useReveal` / `useMcpServers` / `useSkillsHub` / `useSkillsManage` / `buildNotices`），**可测性收益全部落在那五个单元上**（`buildNotices` 的 3 条 + `client-hooks` 的 8 条是真行为/真归属断言）。继续提取子组件不再带来可测性，**建议 R8 收尾为 `fixed`**，剩下的 `McpTab` 791 行里约 500 行是 JSX 本体。



---

## F 批：功能完整性

| ID | 缺口 | 现状证据 | 修法 | 优先级 |
|---|---|---|---|---|
| R9 | 全局 MCP 无法导出 | `70-shell.js:1070` 只在 `scope !== 'global'` 渲染；`exportWorkspaceJson` 只接 wsPath | 新增 `exportGlobalJson`（读 patch 里 managed 条目，输出同一 `{mcpServers}` 形状） | 高 |
| R10 | `projectConnections` 不接线 | `docs/design.md:110` 自认；`refs > sessions` 是唯一泄漏信号 | 项目页加"诊断"区 | 高 |
| R11 | 本机导入技能无入口 | `skillsManager/importSkill` 后端完整（file/dir/archive + zip-slip + 锁 + 原子提交），UI 无 `<input type=file>` | 技能面加导入入口 | 中 |
| R12 | 每 server 12 条日志只取最后一条 | `index.js:78` 采集，界面只用 `lastError` | 详情加"最近日志"抽屉 | 中 |
| R13 | ToolSearch 无法试搜 | 只能盲调 `maxResults` / `maxCatalogChars` | 复用 `searchCatalog` 加"试搜"，显示模型会看到什么 | 中 |
| R14 | 技能市场装完无来源/版本 | `skillHubInstall:2705` 不落 manifest；上游有 `slug`/`version` | 落 `.hub.json` → 检查更新/升级 | 低 |

---

## F 批已修项

### R9 全局 MCP 无法导出 —— 已修

- **现状证据**：全局标签页（`scope === 'global'` 分支）没有任何导出按钮；宿主侧只有 `exportWorkspaceJson`（只吃 `wsPath`）；弹窗条件是 `exportOpen && scope !== 'global'`，所以全局页即使触发也永远不显示——"点了没反应"的典型形态。
- **暴露的测试缺口**：`exportOpen` / `WorkspaceExportModal` 在 `test/` 下**0 次出现**，即导出界面此前没有任何测试覆盖。缺陷正好长在这个空档里。
- **红用例**（`test/workspace-host.test.mjs`，2 条，未修代码上红在 `Cannot read properties of undefined (reading 'call')`）：
  1. 「exportGlobalJson exports every managed profile entry in the same shape as a project export」——两条 managed 条目（stdio + http）逐字段断言；**键集合单独钉**（对称往返会一起少，deepEqual 照样相等）；与 `exportWorkspaceJson` 的返回键集合对称（除 `path`）。
  2. 「exportGlobalJson is empty-safe and round-trips through the paste import preview」——空 profile 返回 `{ mcpServers: {} }` 不抛；导出结果经 `previewImport` 必须识别为**同名更新**（`updated: ['alpha']`、`added: []`）。
- **wire 改动（完整五步）**：
  1. `lib/rpc-contract.js` 新增 `{ method: 'exportGlobalJson', params: [], result: 'WorkspaceExportResult' }`，紧邻 `exportWorkspaceJson`（同族相邻，顺序即契约）；
  2. `npm run contract:write` → `lib/typert.js` 与 `lib/client.js` descriptor 段**各只多一条**（已逐行 diff 核对：`mv('exportGlobalJson', [], 'WorkspaceExportResult')` 与对应的 descriptor，`parameters: []`）；
  3. 宿主实现写在 `McpManagerGateway` 上（方法体真在原型上，否则 `applyRemoteMethods` 加载即抛）；
  4. 第四面（原型集合 = 契约表）自动覆盖；
  5. 新增客户端断言一条（见下）。
- **实现要点**：数据源是 `managedState(ctx).servers`（profile patch 里的 managed 条目），物化复用 **`specToMcpEntry`**——它与 `exportWorkspaceJson` 是同一个函数，所以"同形状"不是约定而是同一段代码。`name` 用 `pluginName()`（文件名不随部署路径变），`excluded` 恒为 `[]`。
- **一处必须说清的安全事实**：`toMcpClientConfig` 用 `evaluateEnvExpression` **求值**后才写 patch，所以**面板添加过的条目在 patch 里已是实际值** ⇒ 全局导出是**明文**；而项目 `.dsh/mcp.json` 存 `${VAR}` 模板，项目导出保留引用。手写的 `!!js process.env.X` 仍会被 `jsExpressionToTemplate` 转回 `${X}`。
  ⇒ 界面上全局导出的警告文案**必须**与项目层不同（照抄就是对用户撒谎）。三种表述都在 `lib/client/50-mcp-panels.js` 的三元分支里，并各有断言。
- **客户端**：全局标签页加「导出全局」按钮（条件 `servers.length > 0`，与项目页同一 `dsh-mcp-section-actions` 类）；弹窗 `open` 去掉 `&& scope !== 'global'`；弹窗内部按 `scope` 调不同方法、文案分三处（标题 / 警告 / 格式说明）。
- **新增 i18n（5 条，中英成对）**：`client-i18n.test.mjs` 当场抓到"有用例文案没有英文"。这次改用 `.tmp-review/literal.cjs` 从源码**正向扫描**取字面量（上一版用 `lastIndexOf("'")` 定位，把 `t(` 也吃进来，往 `EN_DICT` 写了 14 行垃圾键，靠 `git diff` 才发现并回滚）。
- **计数闸门按设计报警**：`test/typert-manifest.test.mjs` 的精确计数 42 → **43**（注释里补了 `42 → 43（1.11.1）：新增 exportGlobalJson（R9）`）。`test/rpc-contract.test.mjs` 的 `readOnly` 集合补 `exportGlobalJson`（否则这条只读方法不会被检查"不得标 mutating"）。
- **新增客户端断言**（`test/panel-chrome.test.mjs`）：「导出出口在项目层与全局层都存在」。**是源码断言不是渲染断言**，原因写在测试注释里：本文件假 React 不执行 effect ⇒ `servers` 恒为空 ⇒ 按钮条件 `servers.length > 0` 走不到。宿主侧等价性由上面两条行为用例保证。
- **故障注入（用带自校验的 `inject.cjs`）**：把弹窗 `open` 条件改回 `&& scope !== 'global'` → 新断言红，恢复后逐字节相同。
- **门禁**：`npm test` **1032 例 / 1025 通过 / 0 失败 / 7 skipped**（1029 → 1032）；`client:check` ✔ 10 分片 / 7670 行；`contract:check` ✔ **56 个方法**；渲染快照 6 场景逐字节相同（空列表下按钮不渲染，符合条件式）；`build-catalog` ✔ 47 且 `git status` 无变化。
- **回滚**：`git checkout` 恢复 `lib/{rpc-contract,typert,index}.js`、`lib/client/{20-locale,50-mcp-panels,70-shell}.js`、`lib/client.js`，再 `npm run contract:write && npm run client:write`；测试侧移除本项新增的两条 `exportGlobalJson` 用例与那条导出出口断言。

### R10 `projectConnections` 不接线 —— 已修

- **现状证据**：宿主侧 `projectConnections` 早已实现并上了 wire（`params: []`），`projectConnectionsView` 也有真宿主用例（`refs`/`sessions`/空闲回收），**但客户端零调用**——`grep -c projectConnections lib/client/*.js` 只有 `00-boot/90-contribution` 之外的一处 descriptor。`docs/design.md` 自己写着"面板暂未接线"。
- **为什么值得接**：它回答的是单行视图回答不了的问题——`refs > sessions` 说明某条共享连接的引用卡住不归还。那些引用由 cordis 的 agent scope effect 拥有，**泄漏时没有任何单行症状**：面板会一直显示连接正常、工具可用，直到空闲回收永远不发生。
- **红用例**（`test/panel-chrome.test.mjs`，2 条）：
  1. 纯函数「连接诊断：refs 大于会话数是泄漏信号」——未修时红在 `connectionAnomalyOf 必须存在`；覆盖 6 种判定（健康 / 空闲待回收**正常** / 泄漏 / 旧配置 / 配置读失败 / 作用域故障 / 同名多条）。
  2. 真渲染「项目页有连接诊断入口；展开后才取数，异常连接被标出」——未修时红在 `项目页必须有「连接诊断」入口`；断言三件事：入口存在、**折叠态不调用** `projectConnections`、展开后异常行被标出而健康行不被标。
- **实现**：
  - `lib/client/40-shared-ui.js`：两个纯函数 `connectionAnomalyOf(row)`（判定顺序 = 排查顺序：引用 → 旧配置 → 配置读失败 → 作用域 → 同名多条）与 `connectionDiagText(row)`（`{name}  refs N / 会话 M`）。纯函数是因为客户端在本仓库跑不了 hook 行为，但纯函数能真跑。
  - `lib/client/70-shell.js`：`diagOpen` 一个展开态留在组件；**数据面（`diagRows`/`diagError`）在 `useMcpServers`**，入参 `diagEnabled`，`useEffect` 只在展开且非全局作用域时取一次。
  - 入口放在左栏 `.dsh-mcp-ws-body` 底部——那个容器本来就是 `flex-direction:column`，**零布局改动**；视觉用既有类（`dsh-mcp-source-detail` / `dsh-mcp-log` / `Badge`），**零新增 CSS**。
- **取舍（写清楚，别当遗漏）**：PLAN 原本写"只在有异常时提示"，但那要求**常驻**取数才能知道有没有异常——与"排障视图不该每次开项目页都多一个 RPC"冲突。最终选：入口**始终可见**、默认折叠、**展开才取数**、异常行带 `s-err` 徽章。这样零轮询开销、零常驻数据，入口也不藏。
- **被自己的闸门抓到的两处（都是设计上正确的报警）**：
  1. R8 的规模闸门（`useState <= 24`）红了——我把 3 个诊断 state 放进组件时是 26。修法不是放宽闸门，而是把数据面搬进 `useMcpServers`（组件只留展开态）——**这正是那条闸门存在的理由**。
  2. R8 的调用形状闸门（`useMcpServers({ … })` 的入参列表）红了——新增 `diagEnabled` 让它失配。修法是更新断言并补一条"diagRows 归 hook"的归属断言，而不是删掉形状断言。
- **i18n**：11 条新文案，`client-i18n` 逐条列出。这次用 `.tmp-review/literal.cjs` 从源码取字面量 + 自检（中文、长度、占位符集合一致、无重复）。**踩过一个坑**：定位片段里带引号时 `literal()` 的"向前找起始引号"会被片段内部的引号带偏（返回 `") : t("`），最后那一改用常量 + "源码里必须存在"的自检。
- **等价性证据**：渲染快照 6 场景**逐字节相同**——但要看清它的含义：初始 `scope` 是 `'global'`，**项目页根本没被渲染**，所以这个"相同"证明的是"全局页与技能面未受影响"，**不是**新代码的覆盖。新代码由上面那条真渲染用例覆盖（它跑 effect、驱动点击）。这个分工写在这里，免得下轮把"快照相同"误当成覆盖证据。
- **故障注入（2 次，均用带自校验的 `inject.cjs`）**：
  1. `refs > sessions` 改成 `refs > sessions + 999`（泄漏判定永不成立）→ 纯函数用例红；
  2. 入口 `onClick` 改成空函数 → 渲染用例红。
- **门禁**：`npm test` **1034 例 / 1027 通过 / 0 失败 / 7 skipped**（1032 → 1034）；`client:check` ✔ 10 分片 / 7760 行；`contract:check` ✔ **56**（**没有新增方法，只读入线**）；渲染快照 6 场景逐字节相同；`lib/typert.js` 无变化。
- **回滚**：恢复 `lib/client/{40-shared-ui,70-shell,20-locale}.js` 后 `npm run client:write`；测试侧移除本项两条用例、`__chrome` 注入里的两个纯函数、以及 R8 闸门里那条 `diagEnabled` 形状断言。

### R11 本机导入技能无入口 —— 已修（但形态与 PLAN 原假设不同）

- **PLAN 的原假设是错的，必须写在这里**：原文写"后端完整、UI 无 `<input type=file>`"，暗示只差一个输入框。实际上
  `importSkill` 的 source 是 **`{ type, path }`**，宿主**从自己的磁盘读**（`lib/skills-file-ops.js` 的三条分支
  全是 `readFile`/`extractArchive`）。浏览器拿不到宿主机路径（除非 Electron 的 `files[0].path`，web 端没有），
  所以"加个 file input"直接走不通。
- **三个候选与选择**：
  1. 客户端传路径（Electron `files[0].path`）—— web 端不可用，且**客户端获得"读宿主任意文件"的能力**；
  2. 新增一个"收内容"的 wire 方法 —— 与"R11 不该新增方法"冲突；
  3. **扩展 `importSkill` 的 payload 接受内容**（选中）：不新增方法（仍 56），复用同一条导入路径，
     而且比方案 1 **更窄**（客户端给不了路径，只能给内容）。
- **实现**：
  - `lib/skills-file-ops.js`：`importSkill` 入口归一化——`source.content`（文本）/ `source.archiveBase64`（归档）
    先落到 `mkdtemp(tmpdir(), 'dsh-skill-upload-')`，再**重入自己**走既有 path 分支。于是 zip-slip、
    符号链接检查、文件锁、原子提交**全部复用**，没有第二套导入实现。
  - 两道入口守卫（都是因为"内容"没有输入路径可查大小/格式）：文本按 `MAX_FILE_BYTES`（10MB）拒；
    base64 **先按长度拒再解码**，并对 `Buffer.from` 的宽容行为做**回验**（非法 base64 会被静默丢弃字符，
    不验的话错误会指向"解压失败"而不是"输入非法"）。
  - `lib/index.js`：wire 层把 `payload.content` / `payload.archiveBase64` 转成 source；`path` 形态照旧保留
    （宿主侧/命令行仍用它）。
  - 客户端：`40-shared-ui.js` 两个纯函数 `base64FromBytes`（不依赖 `btoa`：vm 里没有，且大文件会卡栈）
    与 `skillImportPayloadOf`（按**扩展名**决定 content/archiveBase64 —— **不抄宿主的魔数判断**，那是第二真相源；
    错判只会得到宿主的明确报错，不会绕过校验）；`80-skills-face.js` 的模块级 `importSkillFile`
    （输入全从外部给 ⇒ 可真跑）+ 管理面工具区一个包裹式 `<input type=file>`。
- **边界（与 R8/R10 一致）**：`importSkillFile` **留组件之外**但调用点在组件里（它需要 `installTarget`
  这个渲染派生值，与 `confirmInstall` 同理）。第一次我把它放进 `useSkillsManage`，被 `skills-client`
  的渲染断言当场抓住（`installTarget is not defined`）。
- **红用例 → 绿**：
  - 宿主侧 3 条（`test/skills-file-ops.test.mjs`）：文本导入（名字取自 frontmatter，不来自文件名）、
    zip base64 导入、**超限/非法 base64 被拒且技能根与 tmp 都不留残骸**。未修时红在 `缺少导入源路径`。
  - 客户端 3 条（`test/panel-chrome.test.mjs`，**真跑**）：`base64FromBytes` 与 `Buffer` 在 8 种长度上逐字节一致、
    `skillImportPayloadOf` 的四条分支、`importSkillFile` 的四条路径（文本不碰 arrayBuffer / 归档不碰 text /
    无落点不发 RPC / 读文件失败如实报）。
- **被自己的闸门抓到的两处（都在设计上正确）**：
  1. 技能面板规模闸门（<340 行）红了 —— 我把 25 行逻辑放进组件。修法不是放宽阈值，而是抽成模块级
     `importSkillFile`（顺带变成可单测）。
  2. i18n 列出 4 条新文案没英文（同 R9/R10 的流程）。
- **等价性证据（这次快照真的变了，且是可解释的）**：`render-snapshot.mjs` 的 `skills-manage-*` 场景多了一个
  `<label class="dsh-mcp-btn sm">导入本机技能<input type=file></label>`。用 `diff` **逐行核过**：新增内容只有这一个
  元素，其余结构逐字相同。基线已更新为 `render-baseline.html`。
  ⚠️ 快照的已知局限：`style: { display: 'none' }` 被序列化成 `[object Object]`，所以它证明不了"那个 input 真的隐藏了"。
- **故障注入（2 次，自校验工具）**：
  1. 文本判定改成 `if (false)`（文本被当归档上传）→ `skillImportPayloadOf` 用例红；
  2. 宿主侧内容分支改成 `if (false)` → 宿主 2 条用例红（`缺少导入源路径`）。
- **门禁**：`npm test` **1040 例 / 1033 通过 / 0 失败 / 7 skipped**（1034 → 1040）；`client:check` ✔ 10 分片 / 7873 行；
  `contract:check` ✔ **56**（**没有新增方法**）；渲染快照与 R11 基线逐字节一致；`lib/typert.js` 无变化。
- **回滚**：恢复 `lib/{skills-file-ops,index}.js` 与 `lib/client/{40-shared-ui,80-skills-face,20-locale}.js`，
  再 `npm run client:write`；测试侧移除本项 6 条用例与注入名单里的三个单元。

### R12 每 server 12 条日志只取最后一条 —— 已修

- **现状证据**：`lib/mcp-log.js` 早就在采（`MAX_LOG_RECORDS = 12`，按 scope 归集 serverName 与 fiber 两个来源），
  但只有 `lastLogFor` 被用——**12 条里 11 条被丢掉**，而它们正是"连接为什么反复失败"的上下文。
- **先量的体积（这一步决定了实现形态）**：`sanitizeMcpLog` 已把单条截断到 **2000 字符** ⇒
  12 条最坏 **24KB/服务器**，列 20 台就是 **480KB/轮询**（5s 一次）。
  ⇒ **不能**放进行投影。改成 **`status`（单台详情）带 `recentLogs`**，客户端点一次才取——而 `status` 早就在契约里，
  **方法数不变（仍 56）**。
- **另一个必须先查的事实**：客户端**从不调 `status`**（`grep "call('status')` 在客户端只有 `role='status'` 这种 ARIA 字样）。
  详情页的数据全部来自行投影。所以"按需取"是真的按需，不是把已有轮询改一下。
- **实现**：
  - `lib/mcp-log.js`：抽出 `allLogsFor`（合并 serverName 与 fiber 两个来源 + 按 ts 升序），`lastLogFor` 与新的
    `recentLogsFor` 共用它。**为什么不各写一份**：一边按 ts 升序、一边忘了排序时，"最新一条"在两处会不一样。
  - `lib/index.js`：`status` 返回 `{ ...summarize(...), recentLogs }`。**`summarize` 本身一个参数都没加**——
    否则 `list` 也得跟着传，等于把"该不该带日志"这个决定散到两个调用点。
  - 客户端：`40-shared-ui.js` 两个纯函数 `logClock`（固定宽度 HH:MM:SS，刻意不用 `toLocaleTimeString`）与
    `recentLogLines`（**倒序**：宿主升序、人读日志习惯最新在前）；`ServerDetailPane`（它本来就有 `tab` 状态）
    加 `recentLogs` state 与 `loadRecentLogs`；`ServerDetail` 的诊断页加"查看最近日志"按钮 + 列表。
- **为什么状态放 `ServerDetailPane` 而不是 `ServerDetail`**：后者是**纯函数**（测试直接当普通函数调，
  见它上方那段注释），函数体里放 `useState` 会在那种调用下抛 `Invalid hook call`。
- **为什么不做成第四个页签**：`tabBtn('diag', t('诊断'), diagBlocks.length)` 的数字是"冲突/歧义条数"。
  再加一页会让那个数字变成两种含义（冲突数 + 有没有日志）——正是本项目反复修的那类"一个数字两种含义"。
- **等价性证据与它的盲区**：渲染快照 6 场景与 R11 基线**逐字节相同**，因为快照场景里没有
  "选中一台服务器 → 切到诊断页"。这个盲区**不能**靠快照补（它的假 React 不跑 effect），由新用例覆盖（见下）。
- **新增用例 3 条**：
  1. 宿主侧（`test/host-import.test.mjs`）：20 条日志 → `status.recentLogs` 恰好 12 条、**最新在最后**、
     旧的被截掉（第 9..20 条）、**不含明文 token**、`lastError` 语义不变；**反方向**再钉一遍
     `list` 的 `recentLogs === undefined`（否则轮询体积最多 480KB）。
  2. 纯函数（`test/panel-chrome.test.mjs`）：`recentLogLines` 倒序 + 时间格式 + 空/非法输入不抛。
  3. 真渲染两段式（`test/panel-chrome.test.mjs`）：`ServerDetailPane` 未点击**零 `status` 调用** →
     点击后取一次 → 通过 `ofType` 读它传给 `ServerDetail` 的 props 断言两条都在；
     再直接调纯函数 `ServerDetail` 断言"最新的在前"。
- **故障注入（2 次，自校验工具）**：
  1. `status` 的 `recentLogs` 改成 `undefined` → 宿主用例红；
  2. `recentLogLines` 去掉 `.reverse()` → 纯函数用例红。
- **本轮踩到并已修的三个坑（都是"我的操作方式"问题）**：
  1. **误删注释两次**（改 `toggleRow` 与 `copyPlanText` 附近时把下一行一起删了）——都靠 `node --check` 与复读发现并恢复。
     教训：**只在锚点处插入，不要用"替换含上下文的多行"**。
  2. **shell 吃掉引号**：用 `node -e '...'` 写含 `'...'` 的客户端代码时，单引号被 shell 截断，
     `'--:--:--'` 变成 `--:--:--`、`'log'` 变成 `log`。改为**一律用 `.tmp-review/*.cjs` 文件**改代码。
  3. **跨 vm realm 数组 `deepEqual` 又踩了一次**（R8/R10 已经踩过）。这次不只在 PLAN 里记：
     已把"client 跑在 vm 里，数组不要 `deepEqual`"与"hook-renderer 只渲染 root、子组件只能读 props"
     写进 `test/panel-chrome.test.mjs` 的**文件头注释**——重复三次的错误值得一条注释。
- **门禁**：`npm test` **1043 例 / 1036 通过 / 0 失败 / 7 skipped**（1040 → 1043）；
  `client:check` ✔ 10 分片 / 7936 行；`contract:check` ✔ **56**（零新增方法）；渲染快照与 R11 基线相同；`lib/typert.js` 无变化。
- **回滚**：恢复 `lib/{mcp-log,index}.js` 与 `lib/client/{40-shared-ui,50-mcp-panels,70-shell,20-locale}.js`，
  再 `npm run client:write`；测试侧移除本项 3 条用例。

### R13a 目录体检（零新增 wire）—— 已修

- **为什么先做 a 而不是 PLAN 原来的"试搜"**：查清后发现一个更基础的缺口——
  `tool-search-runtime.js:941` 早就有一条"目录因 maxCatalogChars 未列出 N 个工具名"的诊断，
  但它走 `warnOnce(ctx, …)`，**只落在宿主进程日志里，面板完全不可见**。
  `maxResults` / `maxDiscovered` 连这条都没有。⇒ "参数改完有没有效果"这件事，
  先得能**看见现状**，再谈"看某次搜索返回什么"（试搜 = R13b，要新增方法）。
- **做了什么（零新增 wire，方法数仍 56）**：
  - `catalogSectionText` / `flatCatalogText` 的返回补 **`listed` / `total`**（原来只有 `truncated`）——
    三个数来自**同一次分配**，所以"列出 + 被砍 = 总数"是结构保证，不是两处各算一遍。
  - runtime 里记 `lastCatalogAssembly`（**全局一份**，不按 agent 分表）：面板要回答的是"这台机器上
    目录有没有被预算砍"，而预算与池子大小对同一代次的所有会话是同一件事；按 agent 存表还会在
    R7 那条线上多一份需要清理的状态。
  - gateway 新增 `catalogFacts()`（**登记进 `INTERNAL_ONLY`**），`toolSearchSettings` 的返回多一个
    `catalog` 字段：`{ budget, maxResults, maxDiscovered, deferredServers, globalToolCount, lastAssembly }`。
  - 客户端：`catalogFactsText(facts)` 纯函数 + 设置页"目录体检"一行。
- **两个"不编数字"的决定**（都写进了代码注释与用例）：
  1. `lastAssembly` 未组装时是 **null**，面板说"还没有组装过目录"，**不写 0**——
     "还没跑过"与"跑了但没截断"是两件事；
  2. `globalToolCount` 取不到工具服务时是 **null**，不报"0 个工具"。
- **红用例（4 条）**：
  1. 宿主侧（`test/tool-search-wiring.test.mjs`）：`catalog` 存在、`budget` 与 `settings` **同源**、
     `deferredServers` 与 `deferServersOf` **同一个函数**（不重新实现判断）、`globalToolCount` 是数字、
     `lastAssembly` 初始为 null。未修时红在 `必须带 catalog 体检字段`。
  2. 纯函数（`test/tool-search-runtime.test.mjs`）：`listed + truncated === total`、总数不随预算变、
     预算缺省分支的 `listed === total`。
  3. 面板真渲染（`test/tool-loading-panel.test.mjs`）：显示延迟服务器名 / 工具池 / 预算 / 上次 assembly 的三个数。
  4. 降级（同文件）：`lastAssembly: null` 时说"还没有组装过"而不是 0；**老宿主返回里没有 `catalog` 时整块不渲染**。
- **被闸门抓到的两处（都是设计上正确）**：
  1. **第四面**（原型集合 = 契约表）：我加了 `catalogFacts()`，它不在契约表里 ⇒ 红。
     修法：登记进 `INTERNAL_ONLY` 并写理由（这正是 R9 时确认过的规则）。
  2. **"每个渲染出来的类名都必须有样式"**：我手写了 `dsh-mcp-tool-param-note`（正确是**复数**
     `dsh-mcp-tool-params-note`）与根本不存在的 `-wide`。改用既有类 ⇒ 零新增 CSS。
- **故障注入（3 次）**：面板不渲染体检块 → 2 条用例红；`flatCatalogText` 把 `listed` 报成 `total` → 2 条红。
  **第 3 次（`lastCatalogAssembly` 恒为 null）不红**——因为我没有"组装后统计是真的"的端到端用例，
  只有 `catalogSectionText` 的纯函数覆盖。这个边界如实记在这里，不假装全覆盖。
- **门禁**：`npm test` **1046 例 / 1039 通过 / 0 失败 / 7 skipped**（1043 → 1046）；
  `client:check` ✔ 10 分片 / 7982 行；`contract:check` ✔ **56（零新增方法）**；渲染快照 6 场景与基线相同
  （**设置页不在快照场景里**，这是已知盲区，由上面第 3/4 条真渲染用例覆盖）；`lib/typert.js` 无变化。
- **上下文取舍（这是本项真正的核心，第一版没算）**：ToolSearch 存在的唯一理由就是省上下文，所以体检必须报**字符数**，只报"列了几个名字"是错的（名字长短不等）。
  实测（`node .tmp-review/measure-context.mjs`，数字全部来自生产函数 `buildCatalog` / `catalogSectionText` / `searchCatalog`）：

  | 735 个延迟工具 | 上下文成本 |
  |---|---|
  | **不延迟加载**（每个工具完整 schema） | **221,380 字符**（每轮请求都付） |
  | 延迟 + 目录不限制预算 | 目录段 **37,403** + 每次搜索 3,015 ⇒ 省 81.7% |
  | 延迟 + `maxCatalogChars=12500` | 目录段 **12,886**（砍 492）+ 搜索 3,015 ⇒ 省 **92.8%** |
  | `maxResults` 的单价 | 3→903 / 5→1,507 / 10→3,015 / 20→6,033 字符**每次搜索**（与池子大小无关） |

  两件事因此定下来了：
  1. **目录段是 per-request 的固定成本**，`maxCatalogChars` 从"不限制"降到 12,500 = 每轮省 **24,517 字符**，
     代价是 492 个工具名不进目录——但它们**仍能被搜索命中**（`searchCatalog` 搜的是全量目录），
     代价是"模型不会主动知道它们存在"。界面上必须把这句写出来，否则用户以为它们彻底废了。
  2. **搜索返回是 per-search 的边际成本**，`maxResults` 调大一档 ≈ 每次搜索多 300 字符/条。
- **第一版的两个缺陷（本轮修掉，都跟"上下文"直接相关）**：
  1. **体检自己触发了全量枚举**：`catalogFacts()` 最初统计 `globalToolCount`（`globalToolSchemas`），
     而那在缓存未命中时是宿主的**全量 schema 深拷贝**（实测 735 工具 ≈ 92ms / 1.6–2MB）——
     等于让"打开设置页"这个只读动作付一次全量枚举。**ToolSearch 的体检如果自己吃上下文，就完全反了。**
     已成：只读**已经存在**的东西（设置值 + 延迟服务器名 + 上次组装统计），并加用例钉住
     `'globalToolCount' in catalog === false`。
  2. **只报名字数、不报字符数**：已加 `lastAssembly.chars`（目录段实际字符数），界面文案改为
     "这段目录占 N 字符——每一轮请求都要付；被砍掉的名字仍能被搜索命中"。
- **R13b 的正确形态因此改了（不再是"试搜"）**：试搜复现的是**你输入的 query**，而模型发的是它自己生成的 query——
  `execute` 里 query 只在返回结果里带一下（`lib/tool-search-runtime.js` 的 `execute`），**不落任何记录**。
  所以更有价值的是**旁路记录真实搜索**（query + 返回了哪几条 + 有没有 `found: false`），
  它**零上下文成本**（不改 `execute` 返回形状、不进目录段），且回答的是真实问题而不是你的替身。
  同时它能量化 `maxResults` 的实际单价（每次搜索的 payload 字符数）。

- **回滚**：恢复 `lib/{tool-search-runtime,index,rpc-contract}.js` 与 `lib/client/{60-tool-loading,20-locale}.js`，
  再 `npm run client:write`；测试侧移除本项 4 条用例新增的断言。

<h3>结果（R13 主动审计：一处语义错、一处隐含依赖）</h3>

用户要求"功能逻辑不要搞错、搞乱"，所以对 R13 的改动做了一次主动审计。结论：**两处需要修，其余安全**。

#### 审计过的地方（安全）

| 检查项 | 结论 |
|---|---|
| `catalogSectionText` 返回加字段会不会打破消费者 | **安全**。全仓只有一个生产消费者（`catalogTextFor`），全部**按名字解构**；测试里也是 `.text` / 具名解构，没有按位置访问、没有 `deepEqual` 整个对象 |
| `recordSearch` 放在 `execute` 哪里 | 在 `returned` 算好之后、`discovery.discover` 之前。**不参与任何后续计算**，纯写侧信道 |
| `recordSearch` 的热路径成本 | 每次搜索多一次 `JSON.stringify`（10 条 ≈ 3KB ≈ 0.05ms）。有意的取舍，注释里写明 |
| `catalogFacts()` 会不会触发全量枚举 | **已修**（上一轮去掉了 `globalToolSchemas`）。现在只读设置值 + `deferServersOf`（纯内存遍历）+ 上次组装统计 |
| `lastCatalogAssembly` / `recentSearches` 的作用域 | 都在 `installToolSearchRuntime` 的闭包里 ⇒ 每次重装重置，不跨代次泄漏（符合 R7 的方向） |

#### 修正一：`total` 的语义是「待发现」，不是「全部」

`filterCatalog(view.catalog, deferred)` 里的 `deferred` 是**还没被发现**的集合（函数注释明写"只列还没被发现的工具"）。
所以 `catalogSectionText` 返回的 `total` = **待发现的延迟工具数**，而原来文案写「共 {total} 个名字」——
用户会理解成"我的机器上只有 735 个工具"，**这是错的**（735 是"还没被发现的"，会随使用减少）。

已改成：「待发现 {total} 个工具名，目录列出 {listed} 个（**已发现的工具不再重复列出**）」，
且断言跟着改成钉这个说法（否则文案再写错也没人抓）。

#### 修正二：记下一条隐含依赖（不是本轮引入，但被 R13a 变得可观测）

`catalogTextFor` 的缓存键由 `view.revision`、`versionOf(state)`、`instructionFingerprint(sections)` 三段拼成，
**不含 `maxCatalogChars`**。所以改预算后若缓存命中，目录段会是旧预算的结果。现在之所以不出问题，是因为
`updateToolSearchSettings` 会**重装运行时**（新闭包 ⇒ 新 `catalogCache` ⇒ 无缓存）。

R13a 的体检读的正是"上一次组装"，所以这条依赖第一次变得**可观测**。已在代码里写明：
**将来若把预算改成热更新（不重装），必须同时把预算补进这个缓存键**，否则体检会显示旧预算下的数字。

#### 顺带：`payloadChars` 的口径

不含 PTC 模式下额外补的 `signature`（那是 mode 相关的、要到后面才算）。所以它是"这批 schema 本体"的
成本下界，够用来比较 `maxResults` 的档位差。已写进注释，避免以后拿它当精确值。

- **门禁**：`npm test` 1051 / 1044 / 0 / 7；`client:check` ✔；`contract:check` ✔ 56。

<h3>结果（R13 的两处纠正：把"想当然"当成了结论）</h3>

用户的两条批评直接推翻了 R13 第一版的部分结论。记在这里，因为**它们是判断方法的问题，不是笔误**。

#### 批评一：不能拿自己的工具规模当通用事实

我实测用的是**自己造的 fixture**（735 工具 / 20 台服务器），并据此说"压到 500 预算能省 35k 字符"。
但真实用户的分布完全可能不同：
- 3 台服务器 15 个工具 → 目录本来只有 ~500 字符，**预算这个参数根本不需要动**；
- 1 台服务器 200 个工具 → 目录 ~10k，压在 12,500 附近刚好；
- 20 台 × 50 个 → 目录 ~35k，才是"该调预算"的场景。

⇒ **"某个默认值/某个建议值对所有人最优"这件事不存在**。通用的做法只有一个：
**报用户自己的数字**（R13a 干的正是这个），不替所有人给结论。
测量脚本只证明**曲线形状**（预算 → 字符数 → 列名数），不能当"你的机器"用。已在
`.tmp-review/measure-catalog-shapes.mjs` 的文件头写清这一点。

#### 批评二：截断目录的代价被我说轻了（这是实质错误）

我原来的文案是「被砍掉的名字**仍能被搜索命中**，只是模型不会主动知道它们存在」。
这句话**误导**：`select:<名字>` 是**按精确名字**取 schema 的，名字不在目录里 ⇒ 模型**根本不知道那个名字** ⇒
`select:` 用不了。它只剩关键词一条路，而 `searchCatalog` 是 **BM25 词法匹配**（没有同义词、没有语义），
所以关键词必须**恰好**出现在工具的描述/参数名里才命中。

⇒ 截断的真实代价是：**那批工具从"点名可取"退化成"猜词"**，不是"少列几个字"。
- 现在文案改成：「被砍掉的 N 个工具：模型不知道它们的名字，不能用 select: 精确取，只能靠关键词碰；
  关键词要命中，得工具描述里恰好有那个词。」
- 并且**拆掉了**一条把错误说法固化成闸门的断言（`assert.match(text, /仍能被搜索命中/)`）——
  我上一轮把误导性措辞写成了测试，等于把它焊死。
- **截断后模型仍知道的**（事实核查：`catalogGroupHeader` 输出 `### server1 · 37 tools · 31 not listed`）：
  有哪些服务器、每台几个工具、几个没列。所以兜底路径是 `+server1 关键词`（名字硬约束收窄），
  这条路径必须在文案里说出来，否则用户以为完全没救。

#### 顺带纠正：R13b 的「无命中」不是缺陷信号

我原来把"无命中"标成 `❌` 并**排在最前**。但代码事实是：目录第一次组装就列**全部**延迟工具名
（`filterCatalog` 只移除"已发现的"），所以模型照目录抄名字用 `select:` **必然命中**——
"无命中"几乎只发生在它抄错名字，那不是插件的问题。我那条红用例里的 `select:mcp__jshook__nope`
是我**手造的不存在名字**。
⇒ 现在：搜索记录**按时间倒序**，无命中只给中性标记（`（无命中）` / `（点名未找到：…）`），
不上色、不排序、不挂告警符号。它只在**目录被截断**时才值得怀疑，而那个判断由体检那句"被砍掉 N 个"来讲。

#### 官方做法（查证，不是印象）

Anthropic `advanced-tool-use` 页面的 Tool Search Tool：
> "Deferred tools **aren't loaded into Claude's context initially**." /
> "returns references to matching tools, which get expanded into full definitions" /
> 基线 "~72K tokens for 50+ MCP tools"

⇒ 官方**连名字都不列**（延迟工具完全不进 context，只靠 system prompt 提示"有工具可用"）。
本插件把工具名全列进目录，是**比官方更贵**的设计——但换来"模型知道具体名字、能 select 精确取"。
这是一个**真实的取舍**，不是缺陷；代价与收益都随用户的工具规模变，所以只能由用户看着自己的数字决定。

- **本轮改动**：`catalogFactsText` 的截断文案 + `recentSearchesText` 去假警报 + 拆掉那条错误断言 + 4 条 i18n（删 3 条废弃键）。
- **门禁**：`npm test` 1051 / 1044 / 0 / 7；`client:check` ✔；`contract:check` ✔ 56。

### R13b 旁路记录模型的真实搜索（零新增 wire、零上下文成本）—— 已修

- **为什么不是"试搜"**（PLAN 原文列的是试搜）：试搜复现的是**人输入的 query**，而模型发的是**它自己生成的 query**。
  `execute` 里 query 只出现在返回结果里（模型看得到自己问的），**不落任何记录**——"模型问了什么、拿到几条、
  哪些 query 空手而归"全是空白。你测的那个 query 不是它遇到的那个。所以改成**旁路记录真实搜索**。
- **零上下文成本的三条证据（这是本项最硬的部分）**：
  1. **不改 `execute` 的返回**（那才是进模型上下文的东西）。用例里钉住"返回里不得出现
     `searches` / `recentSearches` / `searchLog` / `recent` / `searchHistory` 任何一个键"。
  2. **不进目录段**。用例在"只搜一次、目录段非空"时断言目录正文里不含 query 文本（**多搜几次目录段就是空的，
     那条断言会变成空转**——这个坑我踩了一次）。
  3. **故障注入验证**：把记录塞进 `execute` 的返回（`recentSearches: recentSearches.slice()`）→ 用例立刻红。
     这是唯一真正会吃上下文的错误形态，必须有用例守住。
- **记录什么**（每条 ≈ 几百字节，环形上限 **20** 条 ⇒ ≈ 10KB 内存，不随会话长度增长）：
  `{ query, limit, returned[], missing[], payloadChars, at }`
  - `query` / `returned` / `missing` 都过 `sanitizeMcpLog`：**复用日志那条脱敏规则**（一个脱敏入口），
    query 是模型生成的自由文本，可能夹带用户贴进来的凭据。
  - `missing` 是 `select:` 点名但找不到的名字——**"搜不到"的最强证据**。
  - `payloadChars` = 本次返回那批 schema 的 JSON 字符数 ⇒ **`maxResults` 的单价有了本机数字**
    （实测口径：maxResults 每调大一档 ≈ 每次搜索多 300 字符/条）。
- **为什么它能回答试搜回答不了的问题**：显示的是**模型真实问过什么**；空手而归的排在最前
  （那是唯一直接指向缺陷的信号）；同一句 query 反复出现 = 它在绕圈。
- **实现**：
  - `lib/tool-search-runtime.js`：`MAX_SEARCH_RECORDS = 20` + `recentSearches` + `recordSearch()`；
    `execute` 里在 `returned` 算好之后**旁路**写一条；返回对象加 `searches: () => recentSearches`。
  - `lib/index.js`：`catalogFacts()` 加 `recentSearches`（**零新增方法**，方法数仍 56）。
  - `lib/client/60-tool-loading.js`：纯函数 `recentSearchesText`（**空手而归排最前** + 时间倒序 + 每条带字符数）
    + 设置页在"目录体检"下面显示。
- **用例（4 条）**：
  1. runtime：字段齐全、`returned` 与本次真返回一致、`missing` 记下点名失败的、`limit` 是本次生效值；
     **返回里不含记录键**。
  2. runtime：环形上限 20（搜 25 次只留最近 20）+ 脱敏（`token=supersecret` → `REDACTED`）。
  3. runtime：**只走旁路**——只搜一次时目录段非空，断言目录正文不含 query。
  4. 面板：显示 query 与字符数、**空手而归排在命中之前**、没有记录时说"还没有搜索记录"。
- **故障注入（3 次，全中）**：不记录 → 2 条红；**塞进 execute 返回 → 红**；面板不显示 → 1 条红。
- **门禁**：`npm test` **1051 例 / 1044 通过 / 0 失败 / 7 skipped**（1046 → 1051）；
  `client:check` ✔ 10 分片 / 8032 行；`contract:check` ✔ **56（零新增方法）**；`lib/typert.js` 无变化。
- **回滚**：恢复 `lib/{tool-search-runtime,index}.js` 与 `lib/client/{60-tool-loading,20-locale}.js`，
  再 `npm run client:write`；测试侧移除本项 4 条用例与 `__settingsPanel` 注入里的两个纯函数。

### R14 技能市场装完无来源/版本 —— 已修

- **现状证据**：`skillHubInstall` 装完**什么都不留**——用户看不到"这个技能从哪个上游、哪个版本装的"，
  也就无从检查更新。
- **实现（只读优先 + 跟技能文件走）**：
  - `lib/skills-file-ops.js`：`hubSourcePath` / `writeHubSource` / `readHubSource`。
    **位置跟着技能文件走，不建额外目录**：
    - bundle → `<技能目录>/.hub.json` ⇒ **删目录时连带删掉**，零清理代码；
    - flat → `<name>.md.hub.json`（挂在技能文件后面）⇒ **不会被当成技能条目**（只认 `*.md` / `<dir>/SKILL.md`）。
    "多开一个 `<root>/.hub/` 目录"要额外操心"它会不会被扫描当成技能、删技能时清不清空"——那是白送的风险。
  - `skillHubInstall`：装完写来源，并把 `hub` 放进返回（**写失败不把整次安装报成失败**，
    但也不静默：结果里带 `hubError`，因为"技能已落盘"与"来源没记住"是两件事）。
  - `detail`：读来源带出 `hub`（**读失败不抛**，放进 `hubError` 让人看见——
    "没有来源"与"来源坏了"必须分开，否则用户会以为这个技能是手工装的、永远不去更新）。
  - 客户端：`hubSourceLabel(hub)` 纯函数（**有版本才显示版本，不编造**）+ 详情"来源"一行。
- **用例（5 条，都是真跑）**：
  1. `skills-file-ops`：落盘内容（slug/version/pageUrl/installedAt）+ bundle 的路径形状；
  2. `skills-file-ops`：**来源记录不会被当成技能条目**（bundle 与 flat 两种形态，含 `scanDisabledSkills` 不认它）；
  3. `skills-file-ops`：删技能时来源跟着清（flat 显式删、bundle 随目录连带）；
  4. `skillhub-install`（**真 HTTP 夹具**）：装完之后 `.hub.json` 真的存在且内容正确、`result.hub` 带出处；
  5. `skills-client`：`hubSourceLabel` 三态 + 详情"有来源显示 / 没有不显示 / 损坏要报"。
- **故障注入（3 次，全中）**：flat 删除不清来源 → 红；flat 记录位置改错 → 2 条红；
  **wire 不写来源 → 红**（这条一开始不红，因为我漏了 `skillhub-install` 的断言，补上才守住）。
- **门禁**：`npm test` **1056 例 / 1049 通过 / 0 失败 / 7 skipped**（1051 → 1056）；
  `client:check` ✔ 10 分片 / 8068 行；`contract:check` ✔ **56（零新增方法）**；`lib/typert.js` 无变化。
- **未做（明确记为后续）**："检查更新"（要打上游比版本）——它需要网络与额外的失败面，
  而 R14 的痛点（"看不到来源"）已经解决。先有来源，再谈更新。
- **回滚**：恢复 `lib/{skills-file-ops,index}.js` 与 `lib/client/{80-skills-face,20-locale}.js`，
  再 `npm run client:write`；测试侧移除本项 5 条用例。

## 批次顺序与确认点

1. **A 批**（R1 → R2）：低风险、可立即验证，改完你就能看到两条真实 diff。
2. **B 批**（R3）：只加闸门 + 搬 2 个符号，零行为变化。
3. **C 批**（R4 → R5）：性能，先做 R4（面板轮询），R5 需先补"内容变化使视图失效"的用例。
4. **D 批**（R6 → R7）：纯搬移，建议分开两次提交，便于单独回滚。
5. **E 批**（R8）：最大一笔前端重构，放在结构稳定之后。
6. **F 批**（R9…R14）：按优先级逐条，每条独立提交。

**需要你确认的**：

- 渠道：本地已有 `magpie` / `deepseek`（本地端点）与 `qwen` / `glm` / `kimi`（远端）。A–E 批**不需要模型**；F 批若要做真会话 E2E（尤其 R13），届时我只问你要 provider + model 名，密钥不进仓库。
- 本机 `dsh` 不在 PATH：UI 真机验证暂时只能用 `.tasks/_uipreview.mjs` + `panel-chrome`/`css-invariants` 用例。若你有可用的 `dsh` 安装路径，告诉我，R8 结束时补一次真机冒烟。
- 是否允许在 D 批产生"纯搬移"的大 diff（`git diff` 会显示整文件移动）？我建议 `git mv` + 同一次提交内切分，避免 review 噪声。

## 进度

- [x] 隔离环境搭建 + 基线 19/19（`workspace-host.test.mjs`）
- [x] R1 复现
- [x] R2 复现
- [x] R1 修 + 回归用例（门禁全绿 + 真宿主前后对照，未 commit）
- [x] R2 修 + 回归用例（门禁全绿 + 真宿主前后对照，未 commit）
- [x] R3 依赖方向闸门 + 符号下沉（同树渲染逐字节对照，未 commit）
- [x] R4 工具清单共享缓存 + 项目页逐行重收（实测 286.9→8.4ms / 3286→10.8ms，未 commit）
- [x] R5 视图 revision 的内容指纹按代次复用（11.0→0.05ms，含故障注入验证，未 commit）
- [x] R6 表驱动装配 + 按职责拆文件（`remote-wiring` / `patch-store` / `mcp-projection` / `mcp-log` / `mcp-rows` / `host-state` …）
- [x] R7 可变状态收进 `HostState`（per app root）
- [x] R8 客户端三批拆分（`useReveal` / `useMcpServers` / `useSkillsHub` / 通知条纯函数）
- [x] R9 … R14（含 R13 两处纠正与主动审计；逐条见 `TODO.csv`：全部 verified / fixed）
- [x] 审查轮（`NEW-SESSION-PROMPT-AUDIT.md`）：门禁全绿，3 处 P1 已修，P2–P4 见下面的「审查发现」

<h3>审查发现（R1–R14 只读审查轮）</h3>

审查提示词：`NEW-SESSION-PROMPT-AUDIT.md`。审查前门禁与基线一致；修完三处 P1 后重跑仍全绿。
**本轮只改 P1**，P2–P4 只记录（按审查轮纪律：P2–P4 不动手）。

#### P1（已修，三处同源）

三处都是**同一条被推翻的判断**（"无命中 / 名字不在目录 = 缺陷或仍可用"）在不同载体上的残留——
审查提示词 §2 焦点四说的"把几乎不发生的现象当成主要风险"，当时只改掉了其中一半载体。

1. **`catalogSectionText` 分组路径的 `total` 恒为 `undefined`** — 位置 `lib/tool-search-runtime.js` 的
   `return { …, total: catalog.length }`。`catalog` 是 `Map`，`Map.length` 是 undefined（应为 `.size`）。
   生产调用点（`catalogTextFor`）**总带 `ownerOf`** ⇒ 走分组路径 ⇒ 面板显示
   `待发现 undefined 个工具名`（`t()` 会把 undefined 渲染成字符串 "undefined"，RPC JSON 里该字段直接消失）。
   - 为什么测试没抓到：`total` 的三条既有断言（`listed===total`、`listed+truncated===total`、`total` 不随预算变）
     都跑在**无归属的 flat 路径**上，而分组路径只用例了 `text`/`truncated`。
   - 已修：`catalog.size`；并在**分组形态**的两条用例里钉住 `total`/`listed` 与 `listed+truncated===total`。
2. **面板标题与行为相反** — `lib/client/60-tool-loading.js` 的 `最近的搜索（空手而归的排在最前）`，
   而 `recentSearchesText` 是时间倒序。已改 `最近的搜索（按时间倒序）`（含 i18n 键与英文）。
3. **截断日志说了反面的话** — `installToolSearchRuntime` 里 `（模型仍可用关键词或 select: 搜到）`。
   名字不在目录里 ⇒ 模型不知道它 ⇒ `select:` 无从写起（这正是"修正二"推翻的那句）。
   已改成"被砍掉的名字模型不知道，不能用 select: 精确取，只能靠关键词碰"，并在截断日志用例里加了
   `doesNotMatch(/仍可[^；]*select:/)` + `match(/不能用 select: 精确取/)` 两条断言。

判据：`grep -rn "空手而归的排在最前\|仍可用关键词或 select" lib/` 为空。

#### P2

- **`searches()` 直接返回闭包里的数组** — `lib/tool-search-runtime.js` 的
  `Object.assign(cleanup, { …, searches: () => recentSearches })`。跨 RPC 是快照（序列化），安全；
  同进程消费者（测试、将来的诊断视图）改了它会污染运行时的记录。最小修复：`() => recentSearches.slice()`。

#### P3

- `CATALOG_CHARS_SUGGESTION = 12500` 的注释用「456 个延迟工具」论证这个建议值。**不构成缺陷**
  （默认是不限制；开关默认关；hint 只说"工具特别多时才需要设上限"），但注释应写明"本机 fixture 实测"，
  而不是给未来的维护者一个"12500 对所有人成立"的印象。
- 「实测 735 工具」系列（`lib/tool-search-runtime.js` 的指纹/组装成本注释、`lib/index.js` 的
  `collectAvailableTools` 注释、`lib/workspace-runtime.js` 的枚举成本注释）只标了数量、没标"本机 fixture"。
- 已随 P1 修掉的同源载体（记下来，避免下次再只改一半）：`recentSearchesText` 上面那段**重复且作废**的
  JSDoc、"R13b：空手而归的排最前"的面板注释、`test/tool-loading-panel.test.mjs` 的用例头注释与用例名。

#### P4

- **文案内容没有守卫**：注入验证（把标题改成任意别的字符串）⇒ 面板用例仍绿，只有 i18n 用例因"键变成废弃键"而红。
  也就是说闸门只保证"这条 key 有英文"，不保证它说的是事实——那句错误标题就是这么活到审查轮的。
  建议加一条 `assert.match(text, /按时间倒序/)`。
- `total` 的断言只覆盖 flat 路径（见 P1-1），已在本轮补上 grouped 的断言。

#### 对照 DSH 源码（只读，`D:\sudy\github\deepseek-harness` + 本机 node_modules）

| # | 假设 | 结论 | 依据 |
|---|---|---|---|
| E1 | `schemas(scope)` 每次深拷贝 | **成立** | `schemas()` → `schemaOf(definition, true)` → `snapshotJsonValue(parameters)` |
| E2 | 0.2.1 没有 `definitions()` | **开发宿主（0.2.1-rc.5）成立，但出货宿主不成立**：真机桌面版是 **0.2.2-rc.1**，`dsh-tools` 有公开的 `definitions(scope, toolSet)`（不 clone），而插件装配期**已经**走它（`caps.definitions` 为真时用 `definitions`，见 `lib/tool-search-runtime.js` 的 `viewFor`）⇒ §7 的"组装期全量深拷贝 ≈92ms"**不适用于出货宿主**，只属于 0.2.1 开发宿主 | asar 内 `dsh-tools@0.2.2-rc.1/lib/index.js` 的 `definitions(scope, toolSet) { return toolSet === void 0 ? [...this.view(scope).visible.values()] : ... }` |
| E3 | 表驱动装配 == 逐条贴装饰器 | **成立**（实测两条路径 `remoteMethods()` 逐项相同） | `typert/protocol/src/index.ts` 的 `addMarkerInitializer` 只读 private/static/name/addInitializer |
| E4 | `view(scope)` 是唯一重建入口、按 scope 隔离 | **成立** | `get()`/`schemas()` 都走 `this.view(scope)`，view 由 layers 现算 |
| E5 | `visibilityState` 可用 | **成立**（宿主自己用同一判据） | `packages/client/ui-conversation/src/client/service.ts`、`ui-account-notifications` |

#### 真机 E2E（隔离进程 + 真宿主 0.2.2-rc.1 + 真渠道）

上一版写"dsh 不在 PATH ⇒ 没有真机冒烟"是**错的**：`D:\soft\DeepSeek Harness` 就是出货宿主，`resources/runtime/cli/bin/dsh.cmd` 用 Electron 当 node 跑 CLI；渠道在 `~/.dsh/profiles/<p>/cordis.patch.yml`（magpie 本地端点 + tierflow 远端）。

复现方式（都不进仓库，`.tmp-*` 已被忽略）：
1. `DSH_HOME=.tmp-review/dsh-home`，`dsh --profile auditweb --from-default-profile web`（**全新** profile，不碰用户真实 home）；
2. `dsh plugin --profile auditweb add link:<工作树>`（把插件换成待审版本）；
3. `sed -n '/^- id: llm-deepseek/,/^- id: agent-default-model/...'` 把**用户真实 desktop profile 的渠道段**取出，用 `--patch` 挂上（不能直接用复制来的 profile：它的 `node_modules` 带原 pnpm store，`plugin add` 会 store 冲突；也**不要**把 `ui-settings-general` 一并挂上——那会把 `welcomeNoticeVersion` 钉死，"继续"写不进去）；
4. `dsh --profile auditweb --patch <渠道段> --no-open --port 1979x`，浏览器带 `?token=` 打开；
5. 跑完停进程、删掉临时 home 里复制的 `.credentials.yaml` / `.env`。

实测结果（exa = HTTP/3 工具/defer，模型 = magpie 的 `my-deepseek/deepseek-flash`）：
- 插件在 0.2.2-rc.1 上**加载正常**：MCP 面、技能面、工具面、导出/导入、whats-new 全在，56 个 RPC 全部成功返回（面板里的数字都是真的，不是夹具）；
- 一次真模型回合：模型先 `tool_search`，用 `select:web_search_exa` **照目录抄裸名**命中 1 条（"按名字搜必然命中"这条事实被真机验证），再调 exa 拿到结果；
- 面板体检（P1-1/P1-2 的真机证据）：`上次组装（revision 95980658）：待发现 2 个工具名，目录列出 2 个`（**数字**；修复前这里是 `undefined`），`这段目录占 662 字符`，标题 `最近的搜索（按时间倒序）`，记录 `select:web_search_exa → 1 条 1402 字符`；
- 真机进程日志**没有**本插件的 warn/error。

#### 本轮未验证

- Electron 壳特有的两件事：`document.visibilityState` 在桌面窗口最小化时是否真的变 `hidden`（web 下成立），以及打包后的 desktop profile 路径（真机验证用的是 web 入口 + 同一套 harness）。
- 0.2.1 开发宿主下的行为仍只有单测证据（真机只跑了 0.2.2-rc.1）。

<h3>0.2.2-rc.2 适配（issue #11 的真根因）</h3>

`NEW-SESSION-PROMPT-AUDIT.md` 的审查轮之后，用户报了 issue #11“插件入口没有挂载”。
第一个修复（让位检测要求对手“在跑”，`fb30488`）**只修掉了症状**：真机跑 rc.2 才看到根因。

#### 根因：服务名撞车，不是让位判据

rc.2 的 `@deepseek-ai/dsh-web-app` **内置** `@deepseek-ai/dsh-mcp-manager`，它和我们一样
`super(ctx, "mcpManager")`。谁先注册谁赢，另一个直接抛：

```
mcp-manager (@deepseek-ai/dsh-mcp-manager): Error: service "mcpManager" has been registered at <McpManagerGateway>
```

用户看到的就是官方那个“启动失败”；旧版让位检测又据此把我们的入口整体让掉 ⇒ “入口没了”。

它只有 `watch/restart/probe`（只读 + 重启，不写配置），且没有 `dsh.client`（没有面板），
所以做法是**让开名字**，不是让位：

- `lib/rpc-contract.js` 新增 `MCP_SERVICE = 'toolboxMcp'`（一处定义），契约表 / 生成器 /
  `lib/typert.js` / 客户端描述符 / `lib/index.js` 的 `super(ctx, …)` 全跟着它
- ⚠️ 这会改 wire 路径：`/api/mcpManager/*` → `/api/toolboxMcp/*`（只有本插件的客户端用）
- 让位检测（D15）**不再向宿主自带的那个让位**（`@deepseek-ai/` scope 下的一律不算对手面板）；
  第三方 MCP 管理面板在跑时照旧让位

#### 怎么在“最新版”上验（可复用）

npm 上 `latest` 是 0.2.2-rc.1，**rc.2 在 `next`** —— 所以 `npx @deepseek-ai/dsh` 默认是旧的：

```bash
# 1) 隔离 home + profile：装 rc.2 的 base/web-app + 本工作树
mkdir -p $DSH_HOME/profiles/rc2
#    package.json: dependencies { @deepseek-ai/dsh-base: 0.2.2-rc.2, @deepseek-ai/dsh-web-app: 0.2.2-rc.2,
#                                 dsh-toolbox-ui: file:<worktree> }
#                   dsh.profile.bundles: [base, web-app, dsh-toolbox-ui]
CI=true npm install --ignore-scripts --omit=optional   # koffi 原生件拿不到，只能看 UI/RPC，跑不了模型回合
# 2) rc.2 的 launcher（不能用桌面壳的：它会按版本禁用 rc.2 插件）
npm i @deepseek-ai/dsh@0.2.2-rc.2 --ignore-scripts --omit=optional
node node_modules/@deepseek-ai/dsh/lib/bin.js --profile rc2 --no-open --port 1981x
```

#### 实测矩阵（两版，各自一次）

| | rc.1（出货桌面壳） | rc.2（npm `next`） |
|---|---|---|
| 启动告警 | 0 | 0（修复前：官方 manager 抛 `service "mcpManager" has been registered`） |
| 侧栏「工具箱」入口 | 有 | 有 |
| `/api/toolboxMcp/list` | 正常（exa connected、3 工具、按需） | 正常 |
| `conflictingManager` | null | null |
| 官方 `mcpManager` 服务 | 不存在 | **能应答**（`/api/mcpManager/probe` 返回业务错误 “unknown server” 而非“服务不存在”） |
| 模型回合 / `tool_search` | 跑过（1 轮 3 步，`select:web_search_exa` 命中 1402 字符） | **未跑**：npm 安装缺 `koffi` 原生件（`dsh-fs-local` / `dsh-subprocess-local` 的硬依赖），CMake 也不在；要跑得等桌面版升到 rc.2 或补工具链 |

#### 两版兼容怎么守

- 代码里**不写版本号分支**：能力探测（`typeof tools.definitions === 'function'`、slot `inject`）
  已经覆盖差异；这次踩的坑是**名字独占**，也不是版本 API。
- 要守的其实是“两个真宿主各跑一次”：把上面那段做成 `.tasks/` 下的脚本 + 一个“对手条目”夹具，
  每版更新跑一次（约 2–3 分钟）。devDependency 目前仍钉 0.2.1-rc.5，应推进到最新、
  把“上一版”留成 legacy 夹具。
