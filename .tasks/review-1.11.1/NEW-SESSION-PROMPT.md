# 新会话提示词：dsh-toolbox-ui 1.11.1 逐项优化

> 用法（任选其一，效果相同）：
>
> - 在新会话里说：`读 .tasks/review-1.11.1/NEW-SESSION-PROMPT.md，按它执行，不要只做摘要`
>   （cwd 是主树时用这条；cwd 已经是隔离树 `dsh-toolbox-ui.review` 时同一路径也存在。）
> - 或把本文件全文粘进新会话的第一条消息。
>
> 本文件随仓库提交；同目录还有 `PLAN.md`（每项证据与修法）、`TODO.csv`（勾选表）、
> `repro/`（两条已跑通的复现脚本）。**读到本文件后先完整读完再动手**，不要凭标题猜内容。
> **你不是上一轮的继承者，而是执行者。** 上一轮只做了"审查 + 复现"，**零代码改动**（主树除外：
> 本轮新增了 `.tasks/review-1.11.1/` 三个文件）。所有结论都已在隔离目录复现过，复现脚本随仓库提交，
> 不要重新推导，也不要凭印象改代码。

---

## 0. 一句话目标

按 `.tasks/review-1.11.1/PLAN.md` 里 **R1 → R14** 的顺序，**一次只做一项**：先在隔离工作树复现/写红用例，
再做最小结构修，跑全量门禁，贴 diff 与回滚方式，勾选进度，然后停下等我确认下一项。

---

## 1. 硬约束（违反即回滚重做）

1. **主树 `D:\sudy\github\dsh-toolbox-ui` 的 `lib/`、`test/`、`docs/`、`package.json` 一律不碰。**
   所有代码改动只发生在隔离工作树 `D:\sudy\github\dsh-toolbox-ui.review`。
   主树只允许更新 `.tasks/review-1.11.1/`（进度表与笔记）。
2. **一次只做一项**。禁止"顺手一起改"。每项独立提交候选（先不 commit，除非我要求）。
3. **不动的四条不变量**：
   - wire 契约：方法名 / 参数名 / 结果类型符号 / 顺序（`lib/rpc-contract.js` 是唯一真相源，
     `npm run contract:check` 是闸门）。加/改方法必须同时跑 `contract:write` 并检查产物 diff。
   - `lib/client.js` 必须仍能由 `lib/client/` 分片**逐字节**拼出（`npm run client:check`）。
   - 面板文案与状态取值域：`deriveMcpPhase`、`{persisted, live, diagnostics}` 的语义、`mountFailed` /
     `scopeFailed` / `status` 的区分方式，一律不改。
   - 读侧宽容 / 写侧严格 的既有分工不改。
4. **不加静默兜底**。新增错误路径必须显式抛出，禁止 `catch {}` 吞掉后返回默认值。
5. **不格式化**：仓库没有 prettier/eslint，`lib/index.js` 用 tab+分号、`lib/*.js` 用 2 空格无分号。
   不要整文件重排，不要引入 prettier / eslint --fix。
6. **不重写**：`scripts/rpc-contract.mjs`、`scripts/build-client.mjs`、`lib/client/` 的分片切分方式、
   四面对齐机制，都当作已定的架构。要改只在它们之上加闸门。
7. **不碰** `.worktrees/feature/unified-tool-loading`（另一条产品线的残留，与本轮无关）。
8. 每个断言/结论都要带 `文件:行号` 或命令输出。**没有证据的"我觉得"不要写进结论。**

---

## 2. 环境（已就绪，先验证再用）

```powershell
# 隔离工作树（已存在，detached @ 2adb277）
cd D:\sudy\github\dsh-toolbox-ui.review
git log --oneline -1            # 期望 2adb277 fix(tools): …
git status --short              # 期望干净
ls node_modules\@deepseek-ai     # 期望列出 cordis / dsh-* 等（junction 指回主树，31M）
```

如果 `node_modules` 丢了或行为诡异，重建（PowerShell，注意先解析再删除）：

```powershell
$main = 'D:\sudy\github\dsh-toolbox-ui'
$work = 'D:\sudy\github\dsh-toolbox-ui.review'
if ((Resolve-Path $work).Path -eq $work) { Remove-Item -LiteralPath (Join-Path $work 'node_modules') -Force }
cmd /c mklink /J "$work\node_modules" "$main\node_modules"
```

基线（2026-11-09 实测，先复跑确认）：

| 命令 | 期望 |
|---|---|
| `npm test` | 1000 例 / 993 通过 / 0 失败 / 7 skipped / ~31s |
| `node --test test/workspace-host.test.mjs` | 19/19 |
| `npm run contract:check` | 退出 0 |
| `npm run client:check` | 退出 0 |
| `node scripts/build-catalog.mjs` | 打印 "已生成 … 47 条 · 10 分类"，且 `git status` 无变化 |

复现脚本（**已提交，直接用**，cwd 必须是隔离工作树根目录；隔离树自身也带着这份目录）：

```powershell
cd D:\sudy\github\dsh-toolbox-ui.review
copy .tasks\review-1.11.1\repro\r1-empty-wspath.mjs .tmp-review\r1.mjs
node .tmp-review\r1.mjs          # 期望：RPC result => applied / wrote cwd/.dsh/mcp.json? => true

copy .tasks\review-1.11.1\repro\r2-stale-diagnostics.test.mjs .tmp-review\r2.test.mjs
node --test .tmp-review\r2.test.mjs 2>&1 | Select-String '\[R2\]'
# 期望：删除后 servers = [] | mountErrors = [{"serverName":"db", …}]
```

若隔离树里看不到 `.tasks/review-1.11.1/`，说明工作树还停在旧提交上，先同步：

```powershell
cd D:\sudy\github\dsh-toolbox-ui.review
git checkout -B review/1.11.1 b91fc66
git diff --stat 2adb277 HEAD -- lib test docs package.json   # 必须为空：只多了 .tasks
```

`r2.test.mjs` 是 `head -350 test/workspace-runtime.test.mjs`（sha256 前缀 `7d9dc638088d2b45`）
加上末尾的 R2 用例。**禁改**，它以 fixtures 复刻真实挂载失败 + 真实 `removeWorkspaceServer`。
`.tmp-review/` 与 `.tmp-*` 已在 `.gitignore`，不会进版本库。

---

## 3. 进度真相源

- 清单与每项的"证据 / 修法 / 回归用例 / 不破坏 / 回滚"：`.tasks/review-1.11.1/PLAN.md`
- 勾选表：`.tasks/review-1.11.1/TODO.csv`（`status` 列：`todo` → `doing` → `fixed` → `verified`）

**每项完成后必须更新 TODO.csv，并在 PLAN.md 对应小节末尾追加一段 `<h3>结果`：** 实际改的文件、
`git diff --stat`、门禁用例名与结果、以及"如果这项回滚要 revert 哪些文件"。这是下一轮唯一的交接凭据。

---

## 4. 逐项任务（按顺序，一项一停）

### A 批：缺陷（必须先做）

#### R1 空 `wsPath` 在 Windows 上解析成宿主进程 cwd

- **已复现**：
  ```
  canonicalWorkspacePath("") => "D:\sudy\github\dsh-toolbox-ui.review"
  RPC result                 => "applied"
  wrote cwd/.dsh/mcp.json?   => true
  content                    => { "mcpServers": { "review-probe": { "command": "node" } } }
  ```
- **根因**：`lib/workspace-runtime.js:989` 的 `canonicalWorkspacePath` 只做 `realpathSync`；
  Windows 上 `realpathSync('')` 返回 cwd 而不抛错（`lib/index.js:1669` 的注释记录过这个坑，
  但只有 `setDeferAll` 和 `getWorkspaceView` 按正确顺序写了）。
- **受影响入口**（守卫在 canonicalize 之后 ⇒ Windows 上是死代码）：
  `addWorkspaceServer:2225`、`updateWorkspaceServer:2244`、`removeWorkspaceServer:2267`、
  `reconnectWorkspaceServer:2286`、`setWorkspaceExclude:2296`、`installWorkspaceBuiltins:2322`、
  `copyWorkspaceServers:2370`、`exportWorkspaceJson:2402`；
  **完全无守卫**：`previewWorkspaceImport:2352`、`importWorkspaceJson:2359`、`revealWorkspaceServer:2421`；
  **只做注册校验**：`workspaceToolLoading:1910`、`setWorkspaceToolLoading:1978`。
- **要做的**：
  1. 把校验收进 `canonicalWorkspacePath`：非字符串 / 空 / 纯空白 → 抛 `缺少 workspace 路径`；
     相对路径同样拒绝（`isAbsolute`）。它成为"什么是合法 wsPath"的唯一出口。
  2. 删掉那 13 处重复的 `if (!wsPath) throw …`（保留 `getWorkspaceView` 与 `setDeferAll`
     语义等价的判断也可以，但**不许两套口径**）。
  3. 先写红用例：`test/workspace-host.test.mjs` 加一组"空 / 空白 / 相对 wsPath 对每个写入口都抛错，
     且 cwd 的 `.dsh/` 不出现"。用例必须用真实 RPC（`McpManagerGateway.prototype.xxx.call`），
     不是只测 `canonicalWorkspacePath`。
- **不要做**：不要给每个方法各加一道 `if`；不要引入 `WsPath` 包装类型；不要动 `getWorkspaceView`
  的返回值形状。
- **验收**：`r1.mjs` 输出 `RPC threw => 缺少 workspace 路径` 且 `wrote cwd/.dsh/mcp.json? => false`；
  全量 1000+ 例绿（新增用例使总数上升）。

#### R2 诊断记录没有寿命：删/禁用失败的条目后横幅仍点名它

- **已复现**：`删除后 servers = [] | mountErrors = [{"serverName":"db",…}]`。
- **根因**：`lib/workspace-runtime.js:939-951` 只在"同一条目再次挂载成功"时清
  （调用点只有 573 / 579 / 1325-1341）；`reconcileWorkspaceConnections:434` 与
  `removeWorkspaceServer` 都不清；`lib/index.js:2187` 整份返回；`lib/client/70-shell.js:750-771`
  整份渲染。
- **要做的**：在 `getWorkspaceView`（`lib/index.js:2181` 起）**读取端**按当前 `config.servers`
  过滤 `mountErrors` 与 `scopeErrors`（`restrictError` 同理：deny 涉及的条目都不存在了就返回 null）。
  记录/清除逻辑一行都不改。写一个 `Set` 只算一次。
- **先写红用例**：`test/workspace-runtime.test.mjs` 追加"删除后 `mountErrors` 为空"、
  "禁用后为空"；`test/workspace-host.test.mjs` 追加"`view.mountErrors` 只列当前配置里的条目"。
- **不要做**：不要在 `removeWorkspaceServer` 里加清除（那是第二个真相源）；不要改
  `recordWorkspaceMountError` 的文本；不要动客户端渲染条件（`mountErrors.length > 0` 本来就对）。
- **验收**：`r2.test.mjs` 输出 `删除后 mountErrors = []`；全量绿。

### B 批：结构闸门（零行为变化）

#### R3 客户端分片没有依赖方向

- **证据**（去注释后的代码级反向引用，用脚本可复算）：
  ```
  30-skill-model.js -> installTargetId (50-mcp-panels.js:827)
  40-shared-ui.js   -> SORT_KEYS / SORT_LABELS (50-mcp-panels.js:69)
  70-shell.js       -> ABILITY_TABS / SKILL_MODES / SkillsPanel (80-skills-face.js)
  70-shell.js       -> ensureLocaleWired (90-contribution.js)
  ```
- **要做的**：在 `scripts/build-client.mjs` 旁加一张 `PART_DEPS`（分片 → 允许引用的前序分片），
  并加 `test/client-parts-deps.test.mjs`：扫每个分片的标识符，命中**后置**分片的顶层声明就红
  （注释先剥离，否则会被文档注释误报）。然后把 `SORT_KEYS` / `SORT_LABELS`、`installTargetId`
  挪到前面的分片（`40` 或 `30`），`ensureLocaleWired` 挪到 `40`。
- **必须**：搬完跑 `node scripts/build-client.mjs --write`，然后 `npm run client:check`；
  `lib/client.js` 的 diff 只允许是这些符号的**位置**变化，不允许任何字符级改写。
- **不要做**：不要顺便把分片重新切分成"真正的 ES 模块"；不要引入打包器。

### C 批：性能（行为不变）

#### R4 工具清单：一份事实两套实现，全局侧无缓存

- **证据**：项目侧有 epoch + 哨兵缓存（`workspace-runtime.js:758-800`，注释明写
  "`schemas(scope)` 会把全局层整个深拷贝一遍"）；全局侧 `mcp-registry.js:24` 的 `toolInventory`
  每次 `ctx.tools.schemas()`（宿主对每个工具 `snapshotJsonValue` 深拷贝 parameters）
  + 每台服务器 `JSON.stringify` + SHA-256（`revisionOf`）。`getWorkspaceView:2205` 还额外调一次
  全局 `listMcpServers` ⇒ 项目标签页每 5s 付两遍全量 inventory。
- **量化**：735 工具 / 1.72MB schema，仅 stringify+sha256 = 14.3ms/次（不含深拷贝）；
  客户端每 5s 一次（`lib/client/70-shell.js:114` `POLL_INTERVAL_MS`）。
- **要做的**：inventory 收成一份，键用 `toolsEpoch`（`workspace-runtime.js:1076`，每次
  `tools/change` flush 自增），全局与项目共用；`getWorkspaceView` 复用同一份。
- **先写红用例**：用夹具里已有的 `toolReads.schemas` 计数断言"同一代次内连续两次 `list()` 只枚举一次"，
  且"`tools/change` 之后必须重新枚举"（两条都要，缺第二条就会缓存陈旧）。
- **不要做**：不要改 `revision` / `toolRevision` 的取值语义；不要动 `toolCountAmbiguous` 的判定。

#### R5 装配期的缓存键和被缓存的计算同阶

- **证据**：`tool-search-runtime.js:250-262` `viewRevision` 每次对全部 schema
  （含 parameters/output）+ 配置做 stringify + SHA-256；同文件 `865-871` 用它当 `viewCache` 键；
  调用点在 `systemPrompt.assemble` 的 wrapper 里（`1080` / `1150` / `1184`）⇒ **每个请求**都跑。
  注释里量过目录文本 735 工具 ~11ms，而算这个 key 本身 ~14ms。
- **前置**：先确认"工具内容变化必须使视图失效"的用例存在（不存在就先补，这是正确性底线）。
- **要做的**：粗粒度代次优先 —— `(toolsEpoch, 配置指纹, toolSet 名字集合哈希)`，只在代次变化时
  才落到内容哈希。
- **不要做**：不要为了快而牺牲失效正确性；`revision` 进目录文本缓存键的用法保持不变。

### D 批：源码结构（纯搬移）

#### R6 `lib/index.js` 职责混装 + 154 行装饰器脚手架

- **证据**：2778 行，同时是 RPC 服务层、profile patch 存储、HMR 锁、连接桥、诊断汇总、
  更新检查、whats-new；19 个 import；`static` 块 154 行 / 56 个 `__esDecorate`
  （`index.js:1287-1440`），内容与 `lib/rpc-contract.js` 的表重复。
- **要做的（两个独立提交步骤）**：
  1. 装饰器装配改成按 `MCP_METHODS` / `SKILL_METHODS` 表驱动；
  2. 按职责拆 `patch-store.js` / `mcp-service.js` / `skills-service.js` / `update-hint.js`，
     `index.js` 只留装配。
- **必须**：第 1 步之后 `npm run contract:check` 必须仍然 0（它校验 `@Remote` 的顺序与名字，
  是这次重构唯一的正确性闸门）；`lib/typert.js` 与 `lib/client.js` 的 descriptor 段不得变化。
- **不要做**：不要引入 TypeScript / tsc / 装饰器 polyfill；不要改 `TypertRemoteService` 的用法。

#### R7 12 个模块级可变单例，诊断表没有 owner

- **证据**：`sharedConnections`、`agentProjectSlotsByRoot`、`agentWorkspaceStates`、
  `workspaceConfigCache`、`workspaceWriteState`、`workspaceMountErrors`、`workspaceScopeErrors`、
  `workspaceRestrictErrors`、`warnedDiagnostics`、`toolsEpoch`、`denyCacheByRoot`、
  `activeGenerationByRoot`。R2 的根因就是"记录者有 owner、清除者没有"。
- **要做的**：收成 per-app-root 的 `HostState`（`open(root)` / `dispose()` 一处清）。
- **前置**：先写"插件卸载后这些状态为空"的用例（按现有 `disposeAllProjectSlots` 的实际行为对齐），
  再搬。`projectConnections` 的字段不能变。

### E 批：客户端结构

#### R8 `McpTab` 973 行 / 34 个 useState

- **证据**：`lib/client/70-shell.js:130-1102`，973 行 / 34 useState / 6 useRef / 9 useCallback /
  8 useEffect / 6 useMemo；`SkillsPanel` 494 行 / 16 useState（`lib/client/80-skills-face.js:512-1006`）。
- **要做的**：抽 `useMcpServers`（load + poll + `loadSeq`/`revisionRef` 防串）、`useReveal`、
  `useUpgrade`；视图按 列表 / 详情 / 横幅 分区。`SkillsPanel` 拆管理面与市场面。
- **收益**：现在这些逻辑只能靠 `test/client-behavior.test.mjs` 钉源码文本；抽成模块作用域函数后
  可以真断言（与既有 `wsSub` / `overlaySeats` / `mcpStatusRank` 同一手法）。
- **必须**：CSS 类名与 DOM 结构不变（`test/panel-css-invariants.test.mjs`、
  `test/panel-chrome.test.mjs` 是闸门）；`client:check` 逐字节。
- **不要做**：不要换 hooks 实现、不要引入状态库、不要改视觉。

### F 批：功能完整性（每条独立，做完一条停一次）

| ID | 缺口 | 现状证据 | 修法 | 优先级 |
|---|---|---|---|---|
| R9 | 全局 MCP 无法导出 | `70-shell.js:1070` 只在 `scope !== 'global'` 渲染；`exportWorkspaceJson:2401` 只接 wsPath | 新增 `exportGlobalJson`（读 patch 里 managed 条目，输出同一 `{mcpServers}` 形状）+ 前端放开条件 | 高 |
| R10 | `projectConnections` 不接线 | `docs/design.md:110` 自认；`refs > sessions` 是唯一泄漏信号 | 项目页加"诊断"区 | 高 |
| R11 | 本机导入技能无入口 | `skillsManager/importSkill` 后端完整（file/dir/archive + zip-slip + 锁 + 原子提交），UI 无 `<input type=file>` | 技能面加导入入口 | 中 |
| R12 | 每 server 12 条日志只取最后一条 | `index.js:78` 采集，界面只用 `lastError` | 详情加"最近日志"抽屉 | 中 |
| R13 | ToolSearch 无法试搜 | 只能盲调 `maxResults` / `maxCatalogChars` | 复用 `searchCatalog` 加"试搜"，显示模型会看到什么 | 中 |
| R14 | 技能市场装完无来源/版本 | `skillHubInstall:2705` 不落 manifest；上游有 `slug`/`version` | 落 `.hub.json` → 检查更新/升级 | 低 |

F 批额外规则：**新增 wire 方法必须走 `lib/rpc-contract.js` + `contract:write`**，并在
`test/package-contract.test.mjs` 的"第四面"（网关原型方法集合）中同步；R10 只读入线即可，
R13 优先复用既有方法而不是新增。

---

## 5. 每项的产出格式（照抄这个结构回复）

```
## R1 空 wsPath —— 已修

复现：<命令> → <修复前输出>
红用例：<文件名>:<行> 在未修代码上失败（贴失败断言）
改动：<文件:行> 一句话说明；git diff --stat
门禁：npm test 1002/1002 ✔ · contract:check ✔ · client:check ✔
不破坏：<为什么正常路径行为不变>
回滚：revert <文件>
下一步：等确认后做 R2
```

---

## 6. 已知边界（不要在会话里重新调查）

- 本机 **`dsh` 不在 PATH**。真机 UI 冒烟只能用 `.tasks/_uipreview.mjs` +
  `test/panel-chrome.test.mjs` / `test/panel-css-invariants.test.mjs`。
  若我给了 `dsh` 路径，R8 结束后补一次真机冒烟。
- **A–E 批不需要模型**：全是确定性代码路径。只有 F 批要做真会话 E2E（尤其 R13）时才需要渠道，
  届时**只问我要 provider + model 名**（本地已有 `magpie` / `deepseek` 走
  `http://127.0.0.1:…/v1`，远端有 `qwen` / `glm` / `kimi`）。
  **密钥绝不写进仓库、不写进测试、不打印。**
- 官方源码若需要核对宿主契约，在 `D:\sudy\github\deepseek-harness`（只读）。
- `docs/` 是双语结构闸门（`test/docs-parity.test.mjs`）：改文档必须中英同步，
  锚点/层级序列/相对链接都校验。

## 7. 第一步做什么

1. 复跑第 2 节的基线（`npm test` + 三个 `--check`），把实际数字与"1000 例 / 31s"对比；
   不一致就先报告再动手。
2. 跑 `r1.mjs` 与 `r2.test.mjs`，确认两条复现与本文一致。
3. 只做 **R1**，按第 5 节格式回复，然后停下。
