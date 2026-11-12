> ⚠️ **本文件已被 `NEW-SESSION-PROMPT-5.md` 取代。** R7 已经做完并验证（HostState 一处清、
> 工具代次改 per-root，代次被模块级计数器打穿的问题已用真实用例量化并修掉）；下面关于
> "下一步：R7""门禁 1014 例"的说法都已过期。留档仅供查第四轮当时的上下文，不要按它执行。

# 新会话提示词（第四轮）：dsh-toolbox-ui 1.11.1 收尾

> 用法：在新会话里说
> `读 .tasks/review-1.11.1/NEW-SESSION-PROMPT-4.md，按它执行，不要只做摘要`
> （cwd 是主树或隔离树都可以，本路径两边都有。）
>
> **本文件取代 `NEW-SESSION-PROMPT-3.md`**：第三轮的目标（R6 两步）都做完了并验证过，那份
> 文件里"本次目标：R6 第 2 步""`lib/index.js` 仍有 2685 行""先只给拆分方案等我确认"
> 都已过期，不要再照它执行。读到本文件后先完整读完，再动手。

---

## 0. 一句话目标

从 **R7**（12 个模块级可变单例收成 per-app-root 的 `HostState`）继续。
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
  | `npm test` | **1014 例 / 1007 通过 / 0 失败 / 7 skipped**，~15–40s |
  | `npm run contract:check` | 退出 0，`✔ RPC 契约一致（55 个方法）` |
  | `npm run client:check` | 退出 0，`✔ 10 个分片 / 7488 行` |
  | `node scripts/build-catalog.mjs` | `47 条 · 10 分类`，跑完 `git status` 无变化 |
  | `node --test test/docs-parity.test.mjs` | 20 通过 |

- 主树 `D:\sudy\github\dsh-toolbox-ui` 只有 `.tasks/` 改动，**没有代码改动**。两边的
  `.tasks/` 内容逐字节一致。
- `TODO.csv`：R1–R6 = 完成（R6 = `fixed`），R7–R14 = `todo`。
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

### 1.2 R6.2 之后的模块地图（这是现在的架构，别推翻）

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
npm test                 # 期望 1014 / 1007 / 0 / 7
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

### 下一步：R7（12 个模块级可变单例收成 per-app-root 的 `HostState`）

- **证据**（PLAN R7 节）：`sharedConnections`、`agentProjectSlotsByRoot`、`agentWorkspaceStates`、
  `workspaceConfigCache`、`workspaceWriteState`、`workspaceMountErrors`、`workspaceScopeErrors`、
  `workspaceRestrictErrors`、`warnedDiagnostics`、`toolsEpoch`、`denyCacheByRoot`、
  `activeGenerationByRoot`。R2 的根因就是"记录者有 owner、清除者没有"。
- **前置（先写，必红）**：一条"插件卸载 / `dispose()` 之后这些状态为空"的用例。
  这是本项的红用例，不是可选项——没有它就无法证明"一处清"。
- **也要归进去**（PLAN 已注明，别漏）：R4/R5 新增的 `globalSchemasCache` /
  `toolInventoryCache` / `contentFingerprintCache` ——它们同样是按 root/agent 的模块级状态。
- **修法**：`HostState` 类，`open(root)` / `dispose()`，键与上限写在类里。
- **不破坏**：`projectConnections` 等只读视图字段不变；`dispose()` 的清空范围必须与现在
  `disposeAllProjectSlots` 的实际行为**逐项对齐**（先列清单再搬）。
- **验收**：`npm test` 全绿（≥1014）；`contract:check` 0；`client:check` 逐字节；
  `lib/typert.js` 无变化；新增的"卸载后为空"用例在未修代码上红、修后绿。

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
## R7 模块级单例无 owner —— 已修

复现/现状：<命令> → <输出>
红用例：<文件:行> 在未修代码上失败（贴断言）
改动：<文件:行> 一句话；git diff --stat
门禁：npm test 1014/1007 ✔ · contract:check ✔ · client:check ✔ · catalog ✔
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
2. 读 PLAN 的 R7 小节 + `lib/workspace-runtime.js` 里的 12 个模块级状态（grep 变量名，
   别按 PLAN 的行号跳）。
3. 写"卸载后为空"的红用例 → 确认红 → 再动结构。
4. 做完 R7 后**继续 R8**，不要回来等确认。

---

## 9. 如果你这一轮要结束（交接清单）

1. 更新 `PLAN.md` 对应小节的 `<h3>结果</h3>`（改了什么、红用例、实测数字、回滚命令）。
2. 更新 `TODO.csv`（`todo` → `doing` → `fixed`/`verified`）。
3. **主树与隔离树各写一份**（两边 `.tasks/` 内容一致）。
4. 写下一轮提示词（照本文件结构，只改"现状/已完成/下一步"），并在本文件顶部加
   "已被 N+1 取代"。
5. 不要 commit，除非用户明确要求。
