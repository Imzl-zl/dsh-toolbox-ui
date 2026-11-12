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
- **不破坏**：UI 永远带真实路径，正常路径行为逐字不变；只把"缺参"从静默写 cwd 变成明确报错。
- **回滚**：单个文件 + 一处函数，revert 即可。

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

## C 批：性能（行为不变，可量化）

### R4 工具清单：一份事实两套实现，全局侧无缓存

- **级别**：性能 + 一致性
- **证据**：项目侧有 epoch + 哨兵缓存（`workspace-runtime.js:758-800`）；全局侧 `mcp-registry.js:24` 每次 `ctx.tools.schemas()`（宿主对每个工具深拷贝 parameters）+ 每台服务器 `JSON.stringify` + SHA-256。`getWorkspaceView:2205` 还额外调一次全局 `listMcpServers`，所以项目标签页每 5s 付两遍全量 inventory。
- **测量**：735 工具 / 1.72MB schema，仅 stringify+sha256 = **14.3ms/次**（未计深拷贝），客户端每 5s 一次，与 agent 同一事件循环。
- **修法**：inventory 收成一份，键用 `toolsEpoch`（`workspace-runtime.js:1076`，每次 `tools/change` flush 自增），全局/项目共用；`getWorkspaceView` 复用。`revision` 字段语义与取值不变。
- **回归用例**：用夹具已有的 `toolReads.schemas` 计数断言"同一代次内连续 list() 只枚举一次"。
- **不破坏**：返回的 `servers[].toolCount/toolRevision` 逐字一致（用现有用例 + 一次快照对比）。

### R5 装配期的缓存键和被缓存的计算同阶

- **级别**：性能（模型路径，每请求）
- **证据**：`tool-search-runtime.js:250-262` `viewRevision` 每次组装对全部 schema（含 parameters/output）+ 配置做 stringify + SHA-256；同文件 `865-871` 用它当 `viewCache` 键；调用点 `1080/1150/1184`（`systemPrompt.assemble` 的 wrapper）。注释里量过目录文本 735 工具 ~11ms，而算键本身 ~14ms。
- **修法**：粗粒度代次优先（`toolsEpoch` + 配置指纹 + `toolSet` 名字集合哈希），只在代次变化时才落到内容哈希。
- **回归用例**：新增"同一代次内两次 assemble 不重算内容哈希"的计数断言，并保留"工具内容变化必须使视图失效"的既有用例（那条是正确性底线，先确认它存在；不存在则先补）。
- **不破坏**：视图内容与 `revision` 的**失效语义**不变（只是算 key 的方式变便宜）。

---

## D 批：源码结构（纯搬移 / 表驱动）

### R6 `lib/index.js` 2778 行职责混装 + 154 行装饰器脚手架

- **证据**：一个文件同时是 RPC 服务层、profile patch 存储、HMR 锁、连接桥、诊断汇总、更新检查、whats-new；19 个 import；`static` 块 154 行 / 56 个 `__esDecorate`，与 `rpc-contract.js` 的表重复。
- **修法（两小步，分开提交）**：
  1. 装饰器装配改成按 `MCP_METHODS` / `SKILL_METHODS` 表驱动；**`rpc-contract.mjs --check` 保持原样**，它是"顺序 + 名字 + 参数"的闸门。
  2. 按职责拆 `patch-store.js` / `mcp-service.js` / `skills-service.js` / `update-hint.js`，只改 import。
- **不破坏**：wire 形状由契约检查兜底；拆文件不改导出名。

### R7 12 个模块级可变单例，诊断表没有 owner

- **证据**：`sharedConnections`、`agentProjectSlotsByRoot`、`agentWorkspaceStates`、`workspaceConfigCache`、`workspaceWriteState`、`workspaceMountErrors`、`workspaceScopeErrors`、`workspaceRestrictErrors`、`warnedDiagnostics`、`toolsEpoch`、`denyCacheByRoot`、`activeGenerationByRoot`；R2 的根因就是"记录者有 owner、清除者没有"。
- **修法**：收成 per-app-root 的 `HostState`（`open(root)` / `dispose()` 一处清），键与上限写在类里。
- **不破坏**：`projectConnections` 等只读视图字段不变；`dispose()` 的清空范围要与现在 `disposeAllProjectSlots` 的实际行为逐项对齐（先写一个"卸载后状态为空"的用例，再搬）。

---

## E 批：客户端结构

### R8 `McpTab` 973 行 / 34 个 useState

- **证据**：`lib/client/70-shell.js:130-1102`，973 行、34 useState、6 useRef、9 useCallback、8 useEffect、6 useMemo；`SkillsPanel` 494 行 / 16 useState 同类。
- **修法**：抽 `useMcpServers`（load + poll + seq/revision 防串）、`useReveal`、`useUpgrade`；视图按列表/详情/横幅分区。`SkillsPanel` 拆管理面与市场面。
- **收益**：一半在可测性——现在这些逻辑只能钉源码文本（`test/client-behavior.test.mjs`）。
- **不破坏**：现有行为用例全绿；`client:check` 逐字节重建；窄屏与移动宽度的 CSS 类名不变（`test/panel-css-invariants.test.mjs`）。

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
- [ ] R1 修 + 回归用例
- [ ] R2 修 + 回归用例
- [ ] R3 / R4 / R5 / R6 / R7 / R8
- [ ] R9 … R14
