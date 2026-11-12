> ⚠️ **本文件已被 `NEW-SESSION-PROMPT-10.md` 取代。** R10 已做完（projectConnections 只读接线、
> connectionAnomalyOf 纯函数、项目页折叠入口）；下面关于"下一步：R10""门禁 1032 例"的说法
> 已过期。留档仅供查第九轮当时的上下文。

# 新会话提示词（第九轮）：dsh-toolbox-ui 1.11.1 收尾

> 用法：在新会话里说
> `读 .tasks/review-1.11.1/NEW-SESSION-PROMPT-9.md，按它执行，不要只做摘要`
> （cwd 是主树或隔离树都可以，本路径两边都有。）
>
> **本文件取代 `NEW-SESSION-PROMPT-8.md`**：第八轮的目标（R9）已经做完并验证过，那份文件里
> （新增 wire 方法 exportGlobalJson + 全局页导出出口、明文警告与项目层分开、1032 例）。那份
> 文件里"下一步：R9""门禁 1029 例""契约 55 个方法"都已过期。读到本文件后先完整读完，再动手。

---

## 0. 一句话目标

从 **R10**（`projectConnections` 不接线）继续。R9 已收尾为 `fixed`。
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
  | `npm test` | **1032 例 / 1025 通过 / 0 失败 / 7 skipped**，~15–40s |
  | `npm run contract:check` | 退出 0，`✔ RPC 契约一致（56 个方法）` |
  | `npm run client:check` | 退出 0，`✔ 10 个分片 / 7670 行` |
  | `node scripts/build-catalog.mjs` | `47 条 · 10 分类`，跑完 `git status` 无变化 |
  | `node --test test/docs-parity.test.mjs` | 20 通过 |

- 主树 `D:\sudy\github\dsh-toolbox-ui` 只有 `.tasks/` 改动，**没有代码改动**。两边的
  `.tasks/` 内容逐字节一致。
- `TODO.csv`：R1–R9 = 完成（R8/R9 = `fixed`），R10–R14 = `todo`。
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

### 1.8 R8 期间新建的三个工具（可复用，别再手写一次性脚本）

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
npm test                 # 期望 1032 / 1025 / 0 / 7
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

### 下一步：R10（`projectConnections` 不接线）

- **现状证据**：宿主侧 `projectConnections` 已经实现且上了 wire（`params: []`，返回
  `{ connections }`），但**面板没有任何入口**（`docs/design.md` 自己写着"面板暂未接线"）。
  它回答的是单行视图回答不了的问题——`refs > sessions` 说明引用卡住不归零（泄漏信号）。
- **这是只读入线（PLAN 明写"R10 只读入线"）**：**不要**新增写方法，也不要改任何现有方法
  的形状。只做：一个只读视图 + 一个入口。
- **先写红用例**：真宿主里建两条项目共享连接（一条有会话持有、一条 refs=0 空闲），调
  `projectConnections`，断言 `refs` / `sessions` / 指纹字段与真实状态一致；
  再断言**客户端有这个入口**（现在没有 → 红）。
- **客户端设计要点**：这是排障视图，不是主界面。放在项目页的次要位置（折叠区或"诊断"
  抽屉），并且**只在有异常时提示**（`refs > sessions` 或空闲连接过多），否则只会增加噪音。
  CSS 用既有类（`dsh-mcp-source-detail` / `dsh-mcp-log`）而不是新造，避免动
  `panel-css-invariants`。
- **不破坏**：`projectConnections` 的 wire 形状与返回字段**一个都不能改**（它已在契约表里，
  改了要跑 `contract:write` 并接受方法数不变）；`panel-chrome` 的既有断言全部保持绿。
- **验收**：`npm test` 全绿（≥1032）；`contract:check` ✔ **56**（**方法数不许变**）；
  `client:check` 逐字节；渲染快照 6 场景——**这次会变**（新增诊断区），用 `diff` 确认
  "只多了那一个区域"，并把新场景补进 `render-snapshot.mjs`。
- 做完 R10 后**继续 R11**，不要回来等确认。

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
门禁：npm test 1032/1025 ✔ · contract:check ✔ · client:check ✔ · catalog ✔
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

## 8. 第一步做什么

1. 复跑第 3 节基线，数字与第 1 节不一致先报告。
2. 读 PLAN 的 R10 小节（F 批表格那一行）+ `lib/workspace-runtime.js` 的
   `projectConnectionsView`（grep 定位）+ `lib/index.js` 的 `projectConnections` 方法。
3. **先写红用例**：真宿主两条项目连接（一条有会话、一条 refs=0）→ `projectConnections` 的
   `refs` / `sessions` 与真实状态一致；再断言客户端有入口（现在没有 → 红）。
4. 客户端只读视图 + 入口（折叠区，只在异常时提示），用既有 CSS 类。
5. 渲染快照会变 → `diff` 确认只多那个区域 → 补新场景进 `render-snapshot.mjs`。
6. 做完 R10 后**继续 R11**。

## 9. 如果你这一轮要结束（交接清单）

1. 更新 `PLAN.md` 对应小节的 `<h3>结果</h3>`（改了什么、红用例、实测数字、回滚命令）。
2. 更新 `TODO.csv`（`todo` → `doing` → `fixed`/`verified`）。
3. **主树与隔离树各写一份**（两边 `.tasks/` 内容一致）。
4. 写下一轮提示词（照本文件结构，只改"现状/已完成/下一步"），并在本文件顶部加
   "已被 N+1 取代"。
5. 不要 commit，除非用户明确要求。
