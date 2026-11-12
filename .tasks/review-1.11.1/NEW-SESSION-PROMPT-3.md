> ⚠️ **本文件已被 `NEW-SESSION-PROMPT-4.md` 取代。** R6 的两步都已做完并验证
> （表驱动装配 + 按职责拆 8 个模块，`lib/index.js` 2788 → 1590 行）；下面关于
> "本次目标：R6 第 2 步""仍有 2685 行""先只给拆分方案等我确认"的说法都已过期。
> 留档仅供查第三轮当时的上下文，不要按它执行。

# 新会话提示词（第三轮）：dsh-toolbox-ui 1.11.1 收尾

> 用法：在新会话里说
> `读 .tasks/review-1.11.1/NEW-SESSION-PROMPT-3.md，按它执行，不要只做摘要`
> （cwd 是主树或隔离树都可以，本路径两边都有。）
>
> **本文件取代 `NEW-SESSION-PROMPT-2.md`**：第二轮的目标（R6 第 1 步 = 装饰器表驱动）已经
> 做完并验证过，那份文件里"本次目标：R6 第 1 步""`static {` 在 1304 附近""56 个 `__esDecorate`"
> 等说法都已过期，不要再照它执行。读到本文件后先完整读完，再动手。

---

## 0. 一句话目标

从 **R6 第 2 步**（按职责拆 `lib/index.js`）继续，一次只做一项；
每一项先在隔离工作树写红用例，再做最小结构修，跑全量门禁，贴 diff 与回滚方式，勾选进度，
然后停下等确认。

---

## 1. 现状（必须知道，不要"重做"）

- 隔离工作树：`D:\sudy\github\dsh-toolbox-ui.review`，分支 `review/1.11.1`，HEAD = `e29f21c`。
- **工作区有 24 个已修改文件 + 1 个未跟踪文件（`lib/remote-wiring.js`）+ 4 个未跟踪的
  `.tasks/` 文件，全部是 R1–R5 与 R6 第 1 步的成果，尚未 commit。**
  新会用 `git status` 看到的"一大片改动"不是垃圾：**不要** `git checkout -- .`、
  `git clean`、`git reset --hard`，也不要因为 diff 看着大就 stash 掉。
- 门禁基线（**当前**，务必与之比对）：

  | 命令 | 期望 |
  |---|---|
  | `npm test` | **1011 例 / 1004 通过 / 0 失败 / 7 skipped**，~15–40s |
  | `npm run contract:check` | 退出 0，`✔ RPC 契约一致（55 个方法）` |
  | `npm run client:check` | 退出 0，`✔ 10 个分片 / 7488 行` |
  | `node scripts/build-catalog.mjs` | `47 条 · 10 分类`，跑完 `git status` 无变化 |
  | `node --test test/docs-parity.test.mjs` | 20 通过 |

- 主树 `D:\sudy\github\dsh-toolbox-ui` 只有 `.tasks/` 改动（`PLAN.md`、`TODO.csv`、
  `NEW-SESSION-PROMPT*.md`、`repro/*.mjs`），**没有代码改动**。两边的 `.tasks/` 内容逐字节一致。
- `TODO.csv`：R1–R5 = `verified`，**R6 = `doing`（第 1 步已修、第 2 步待做）**，
  R7–R14 = `todo`。
- **每项的完整证据都在 `PLAN.md` 对应小节的 `<h3>结果</h3>` 里**（改了什么文件、红用例在哪、
  实测数字、回滚命令）。动手前先读你要做的那一项的结果块。

### 1.1 已完成（一句话 + 别回退）

| 项 | 做了什么 | 不要回退/重做 |
|---|---|---|
| R1 | wsPath 校验收进 `canonicalWorkspacePath`（非字符串/空/空白/相对路径都抛），删掉 11 处重复守卫 | 不要再给入口各加一道 `if`；`setDeferAll`/`setDefer`/`tools` 的"空 = 全局族"判空必须保留 |
| R2 | `getWorkspaceView` **读取端**按"当前启用条目"过滤 `mountErrors`/`scopeErrors`/`restrictError` | 不要在 `removeWorkspaceServer` 等处加清除（那是第二真相源） |
| R3 | 分片依赖方向闸门 `PART_FORWARD_REFS` + 7 个符号下沉；`lib/client.js` 是**纯重排**（行内容多重集 0 差异） | 不要改分片顺序/文件名；`SkillsPanel` 是唯一登记的后置引用 |
| R4 | 全局工具清单 + 全局 schema 快照按 `(appRoot, 代次)` 共享；`list` 与 `getWorkspaceView` 共用一次可见工具收集 | 不要改 `revision`/`toolRevision` 语义与 `toolCountAmbiguous` 判定 |
| R5 | 视图 revision 的**内容指纹**按 `(agent, 代次, 名字指纹)` 复用；代次不可信时退回全量算 | 不要改 `revision` 进目录文本缓存键的用法；不要把代次号写进 revision |
| R6 第 1 步 | 56 个 `__esDecorate` + 3 条 `let _…_decorators` 收成两行 `applyRemoteMethods(this, <表>, …)`；新增 `lib/remote-wiring.js`；`lib/index.js` 2788 → **2685** 行 | 不要再手写 `Remote("…")` 字面量（`contract:check` 会红）；不要删 `var __esDecorate`（它仍是装配回调）；`applyRemoteMethods` 的原型断言不许改成静默兜底 |

---

## 2. 硬约束

1. **代码只改隔离树**；主树只更新 `.tasks/review-1.11.1/`（PLAN/TODO/新提示词）。
   进度文件改完要**同时同步到隔离树**（新会可能在任一目录里读它）。
2. **一次只做一项**。先红用例（真 RPC / 真宿主优先，不要只测内部函数），再最小结构修。
3. **四条不变量**：
   - wire 契约：方法名/参数名/结果类型/顺序（`lib/rpc-contract.js` 是唯一真相源，
     `npm run contract:check` 是闸门）。加/改方法必须跑 `contract:write` 并检查产物 diff。
     **R6 第 1 步之后，宿主的装饰器不再手写**，所以"加一个方法"是只改表、不碰 `lib/index.js`
     的装配行——但如果新方法在原型上不存在，`applyRemoteMethods` 会在加载时抛错。
   - `lib/client.js` 必须仍能由 `lib/client/` 分片**逐字节**拼出（`npm run client:check`）。
   - 面板文案与状态取值域：`deriveMcpPhase`、`{persisted, live, diagnostics}` 语义、
     `mountFailed`/`scopeFailed`/`status` 的区分方式。
   - 读侧宽容 / 写侧严格 的既有分工。
4. **不加静默兜底**。新增错误路径必须显式抛出；禁止 `catch {}` 吞掉后返回默认值。
5. **不格式化**：没有 prettier/eslint。`lib/index.js` 用 tab + 分号；`lib/*.js`（其余）
   与 `test/*.mjs` 用 2 空格无分号。不要整文件重排。
6. **不重写**：`scripts/rpc-contract.mjs`、`scripts/build-client.mjs`、`lib/client/` 的
   分片切分方式、四面对齐机制，都当作已定架构；要改只在它们之上加闸门。
7. **不碰** `.worktrees/feature/unified-tool-loading`。
8. 每个断言/结论都要带 `文件:行号` 或命令输出。没有证据的"我觉得"不要写进结论。

### 2.1 前两轮踩过的坑（照着避）

- **CRLF**：`.gitattributes` 是 `* text=auto eol=lf`。Windows 上 Python 文本模式写文件
  会把整份文件转成 CRLF（`io.open(p,'w')`），`client:check` 会因此假红/假绿。
  用 `io.open(..., newline='')` 或 Node `fs.readFileSync/writeFileSync`；改完用
  `node -e "if (fs.readFileSync(f,'utf8').includes('\r\n')) throw ..."` 检查。
  **注意：主树的 `.tasks/*.md|csv` 在磁盘上仍是 CRLF，隔离树是 LF**；同步时用
  `fs.writeFileSync(dst, fs.readFileSync(src))` 复制，别用 PowerShell 的文本管道。
- **别并行跑会互相影响的 bash 调用**：曾经把 `git stash` 与复现脚本并行执行，
  导致脚本"看起来没修好"（实际是 stash 生效期）。红采样一律**串行**。
- **`.tasks` 里的行号会漂**：PLAN 里 R1–R5 各节引用的行号是**第一轮之前**的行号。
  R6 第一句"`static {` 在 1304 附近"在 R6 第 1 步之后也不再成立（现在是 1302/2394 两处）。
  动手前 grep 重新定位，别按行号跳。
- **改闸门的正则时要连"谁的消费者"一起看**：R6 第 1 步删掉手写 `Remote("…")` 之后，
  有 4 处正则读者同时失效（`scripts/rpc-contract.mjs` 的 `checkHostFace`、
  `test/rpc-contract.test.mjs`、`test/package-contract.test.mjs` 的两条）。
  只改实现不改读者，得到的是"永远对空数组做断言"的假绿。

---

## 3. 环境与基线复跑

```powershell
cd D:\sudy\github\dsh-toolbox-ui.review
git log --oneline -1     # e29f21c
git status --short       # 24 M + 5 ??，全部是 R1–R6.1
npm test                 # 期望 1011 / 1004 / 0 / 7
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

- **真宿主复现/验证**（已提交在 `.tasks/review-1.11.1/repro/`，cwd = 仓库根）：
  - `r1-real-host.mjs`：真 cordis + 真 Loader + 官方 `mountRootInclude` + 真 ToolRuntime +
    真 `McpManagerGateway` 实例；验证空/空白/相对 wsPath 被所有入口拒绝且不落盘。
  - `r2-real-host.mjs`：真 mcp-client 连一个不存在的命令，制造真实挂载失败，验证
    「删除/禁用后视图不再点名、记录仍在」。
- **R6.1 新增的两个可复用件**：
  - `lib/remote-wiring.js` 的 `applyRemoteMethods(ctor, methods, { decorate, metadata, initializers })`
    ——要新增一个 gateway 类（R6 第 2 步拆文件时很可能需要）就直接用它，别再手写装饰器。
  - `test/rpc-contract.test.mjs` 的「真宿主里装配出的 Remote 标记…」——**这是唯一能看见
    "装配写错导致 wire 面消失"的用例**（源码正则可读不出 `initializers` 是否传对）。
    拆文件后它必须仍然绿；拆成两个类时记得同步改它的 marker 拼接。
- **scratch（`.tmp-review/`，已 gitignore，可能还在）**：`r4-bench.mjs`、`r4-poll.mjs`、
  `r5-bench.mjs`（R4/R5 的量化脚本）、`scan-parts.mjs`/`matrix.mjs`（分片依赖扫描）。
  不在了就按 PLAN 结果块里的口径重建。
- **真宿主夹具**：`test-support/loader-host.mjs`。需要"工具代次可信"的宿主时，还要调用
  `installAgentRuntime(ctx)`（R5 的集成用例 `tool-search-real-host.test.mjs` 就是这么做的）。
- **验证手法**（前两轮反复用，建议沿用）：
  - 红采样：`git stash push -- <文件>` → 跑用例看红 → `git stash pop`（串行）。
  - 故障注入：把关键判据临时改成常量（例如让 `toolsGenerationOf` 返回 `1`，或把
    `applyRemoteMethods` 的 `initializers` 换成 `[]`），确认新用例会红，再逐字节复原
    （`cp` 备份 + `cmp` 校验）。
  - 纯搬移：`lib/client.js` 的**行内容多重集 0 差异** + `_uipreview.mjs` 渲染 HTML 逐字节相同。

---

## 5. 剩余任务与顺序（一项一停）

按 `PLAN.md` 里的 R6（第 2 步）→ R14 顺序。每项的"证据 / 修法 / 不要做 / 验收"都在 PLAN 中，逐项读。

### 本次目标：R6 第 2 步（按职责拆 `lib/index.js`）

- 目标形态：`patch-store.js` / `mcp-service.js` / `skills-service.js` / `update-hint.js`
  （PLAN 里的名字是建议，落笔前先自己数一遍真实职责边界；**只改 import 与文件归属，
  不改行为、不改导出名**）。
- **先读三样东西**：`lib/index.js` 现在的 2685 行里哪些是纯函数/常量（可直接搬）、
  哪些是 `McpManagerGateway` 的实例方法（要搬就得连 `this.ctx` 的用法一起想）、
  `test/package-contract.test.mjs` 里读 `hostIndex` 正则的那几条（**拆文件会让它们全部
  变成读空**——这是本次最大的隐性风险，先盘清有几条、各自应该改读哪个文件）。
- **红用例建议（真宿主优先）**：现有 1011 条就是验收网——拆文件本身不该新增行为，
  所以红用例的正确形态是"**搬完后哪些断言会因为你搬错而红**"：
  1. 先加一条 `test/`，"`lib/index.js` 只做装配、不含业务实现"的结构断言（比如
     `updateHint`/`whatsNew` 的实现体不在 index.js 里），它现在必红；
  2. 再把 `package-contract` 里所有 `hostIndex` 正则改成"从哪个模块读"，用一个
     "这 5 处正则必须命中"的计数断言钉住，避免搬完后静默读空。
- 验收：`npm run contract:check` 仍 0；`npm run client:check` 仍逐字节一致；
  `npm test` 全绿（1011 或更多）；`lib/typert.js` 无变化。
- **不要**为了拆文件改任何方法体；不要动 `applyRemoteMethods` 的两处装配行位置
  （`test/package-contract.test.mjs` 按文件内出现顺序读它们）。

### R7 起的要点（详见 PLAN）

- R7：12 个模块级可变单例收成 per-app-root 的 `HostState`（`open`/`dispose` 一处清）。
  前置：先写"插件卸载后这些状态为空"的用例。**R4/R5 新增的 `globalSchemasCache` /
  `toolInventoryCache` / 内容指纹缓存 / `contentFingerprintCache` 也应归进去**——它们也是
  按 root/agent 的模块级状态。
- R8：`McpTab` 拆分（973 行 / 34 useState）。CSS 类名与 DOM 结构不变（`panel-css-invariants`
  与 `panel-chrome` 是闸门），`client:check` 逐字节。
- R9–R14：F 批功能项，每条独立。**新增 wire 方法必须走 `lib/rpc-contract.js` +
  `contract:write`，并在 `test/package-contract.test.mjs` 的"第四面"同步**（R6.1 之后
  宿主侧不用再手写装饰器，但方法体必须真的在原型上，否则加载即抛）；R10 只读入线；
  R13 优先复用既有方法。

---

## 6. 每项的产出格式（照抄）

```
## R6（第 2 步）按职责拆文件 —— 已修

复现/现状：<命令> → <输出>
红用例（若适用）：<文件:行> 在未修代码上失败（贴断言）
改动：<文件:行> 一句话；git diff --stat
门禁：npm test 1011/1004 ✔ · contract:check ✔ · client:check ✔ · catalog ✔
不破坏：<为什么 wire 形状/客户端字节不变>
回滚：revert <文件>
下一步：等确认后做 <下一项>
```

---

## 7. 已知边界（不要在会话里重新调查）

- 本机 **`dsh` 不在 PATH**。真机 UI 冒烟只能用真宿主夹具 + `.tasks/_uipreview.mjs` +
  `panel-chrome.test.mjs` / `panel-css-invariants.test.mjs`。
- A–E 批**不需要模型**。只有 F 批要做真会话 E2E（尤其 R13）时才需要渠道，届时**只问用户要
  provider + model 名**（本地有 `magpie`/`deepseek`，远端有 `qwen`/`glm`/`kimi`）。
  **密钥绝不写进仓库、不写进测试、不打印。**
- 官方源码（只读）：`D:\sudy\github\deepseek-harness`。
  `@deepseek-ai/dsh-typert-protocol` 的 `Remote()` / `mark()` / `remoteMethods()` 语义在
  `node_modules/@deepseek-ai/dsh-typert-protocol/lib/index.js:363-465`，R6 第 1 步已核对过。
- `docs/` 只有 5 对中英文档受 `test/docs-parity.test.mjs` 约束：
  `installation` / `skills` / `json-import` / `project-mcp-lifecycle` / `design`。
  其余中文文档（如 `mcp-tool-search-design.md`）单独改即可。
- **两个已量化、但不在计划内的遗留性能点**（别当新发现重报）：
  1. 全局标签页每台**已连接**条目仍各读一次作用域视图
     （`collectAvailableTools` 里的 `entryCtx.tools.schemas(entryCtx)`）：20 条已连接
     ≈ 454ms/轮询。
  2. 宿主 0.2.1 没有 `tools.definitions()`，ToolSearch 每次组装走 `schemas(agent)`
     全量深拷贝 ≈ 92ms/735 工具。
  两者都与"工具代次"同源，可各自单独立项。

---

## 8. 第一步做什么

1. 复跑第 3 节基线，数字与第 1 节不一致先报告。
2. 读 PLAN 的 R6 小节（含 `<h3>结果</h3>` 两步的区分）+ `lib/index.js` 现在的结构
   （2685 行，`let McpManagerGateway = …` 与 `let SkillsManagerGateway = …` 两个 IIFE）。
3. **只做 R6 第 2 步的第一件事：盘清职责边界与 5 处 `hostIndex` 正则读者的下落，
   给出拆分方案（哪些文件、搬哪些符号、每处正则改读哪个文件），然后停下等我确认。**
   大改文件归属属于结构决策，先对齐再动手。

---

## 9. 如果你这一轮要结束（交接清单）

1. 更新 `PLAN.md` 对应小节的 `<h3>结果</h3>`（改了什么、红用例、实测数字、回滚命令）。
2. 更新 `TODO.csv`（`todo` → `doing` → `fixed`/`verified`）。
3. **主树与隔离树各写一份**（两边 `.tasks/` 内容保持一致）。
4. 写 `NEW-SESSION-PROMPT-4.md`（照本文件的结构，只改"现状/已完成/下一步"），
   并在 `NEW-SESSION-PROMPT-3.md` 顶部加上"已被 4 取代"的提示。
5. 不要 commit，除非用户明确要求。
