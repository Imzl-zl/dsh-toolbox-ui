# 新会话提示词：实施 MCP ToolSearch × PTC（从 S1 开工）

> 用法：把本文件全文粘进新会话的第一条消息。
> 你是**实现者**，不是调研者。方案已经定稿并落盘，**不要重新论证、不要重新调研**。

---

## 你的任务

按 `.tasks/mcp-tool-search/IMPLEMENT-PLAN.md` 的 **S1 → S10** 顺序实现。
每阶段先写失败用例、再实现、改完产品代码跑一次**撤掉改动看红**。

## 必读（按顺序，读完再动手）

1. **`.tasks/mcp-tool-search/DECISIONS.md`** —— 决策与证据（B1–B14 / C1–C6 / G1–G4 / V1–V3 / §10 版本差异 / §11 兼容 / §12 第三轮复核）。**这是唯一真相源。**
2. **`.tasks/mcp-tool-search/IMPLEMENT-PLAN.md`** —— 执行计划（模块拆分、接口、算法、分阶段、测试清单、反证清单）。
3. `docs/mcp-tool-search-design.md` §12.7 —— 第十轮推翻第九轮的记录（知道哪些旧论据已作废）。
4. **跳过** `.tasks/mcp-tool-search/NEXT-SESSION.md`：那是上一轮的**复核**提示词，部分断言已被推翻，只作历史参考。

## 开工前必做的三件事

```powershell
cd D:\sudy\github\dsh-toolbox-ui
dsh --version          # 确认宿主版本（写这份提示词时是 0.2.0-rc.2）
git status --short     # 当前只有文档改动，代码零改动
node --test            # 基线必须 738 绿 / 0 红
```

**建议先把文档单独提交一个 commit**（`DECISIONS.md` / `IMPLEMENT-PLAN.md` / `OPEN-ITEMS.md` / `design.md`），
这样后面每个阶段的代码 commit 都是干净边界。

---

## 环境事实（前几轮真金白银换来的，直接用）

- node 在 `D:\soft\nodejs\node.exe`；测试命令 **`node --test`**（**不是** `node --test test/`）。
  全量约 10–18s，**基线 738 绿**。
- **绝对不要动用户的 `web` profile**（`~/.dsh/profiles/web`），也**不要点杀父进程是
  `dsh lib/bin.js web` 的 serena**。`~/.dsh/storages/workspace.json` 全 app 共享。**读**可以，**写**不行。
- 宿主包在 `C:\Users\zhanglu\AppData\Local\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\`。
  DSH 源码在 `D:\sudy\github\deepseek-harness`（**0.2.1-rc.2，未构建、无 node_modules**，只用来看代码）。
- **探针脚本放仓库根的 `.tmp-*.mjs`**（`.gitignore` 已覆盖），**用完删掉**。
- 支持范围 **只 0.2.x**（`>=0.2.0-rc.1 <0.3.0`）。**不要为 0.1.x 写任何兼容分支。**

### 真 PTC 运行时最小挂载链（照 `dsh-base/cordis.patch.yml`）

```
session-projection → session（必须，否则 SessionSeq NaN）
→ subprocess-local → sandbox-local
→ sandbox-policy（{ mode:'danger-full-access', workspaceRoot }）
→ fs-sandbox → user-approval（{ policy:'never' }）→ ptc-runtime-node
```

`agent.session` **必须是真 Session**（`ctx.sessions.create()`）。手写的 `{ snapshotEvents, seq }` 桩会被
`dsh-session-projection` 的属性名检查绕过去、再接上 `eventAt`，调试成本极高。

### 真机 UI（想验时才用）

```powershell
$env:DSH_HOME="$env:TEMP\dsh-ui-impl"
dsh web --no-open --port 0     # stdout 会打：dsh web: http://127.0.0.1:<port>/?token=...
```

把那串 URL（**含 token**）喂给 chrome-devtools MCP 打开。上一轮 401 是因为没取 token，不是取不到。

---

## 已经证明过的，不要再验

| 事实 | 证据 |
|---|---|
| 裁 SDK 手册能省：12651 → **7431** 字符 | 真宿主 35 工具夹具 |
| `renderToolsSdk(宿主同参)` 与宿主 `tools:sdk` 段**逐字节相等** | 真宿主 |
| **公开 API**（`schemas()`+`get()`）重建同样逐字节相等 | 真宿主（所以 private `sdkSchemas` 只是快路径） |
| PTC 下 `deriveMessages()` 返回 0 条，日志只有 `tool/ptc-dispatch*` → **必须用投影恢复** | 真 PTC 运行时 |
| 投影能 fold `tool/result` 与 `tool/ptc-dispatch`，`stateOf` 两条都还原 | 真 Session |
| 嵌套派发绕过 `collapses` 但**走 guard** | 真 execution token 四向对照 |
| `ctx.agents.list()` 可挂载可用 | 实测 |
| `dsh web` 打带 token 的 URL | 实测 |

## 还没证明的（实现时要自己验）

1. 投影**从 `installToolSearchRuntime` 内部**注册（只在探针 ctx 里注册过）。
2. 目录文本按 `(revision, discoveredVersion)` 缓存的正确性与耗散。
3. per-agent 装配的**完整组合**（`modeFor` 与 `presentAs` 单独测过；"无条件安装 + `both` inert + 裁手册"三者同跑没测）。
4. `agents.list()` 返回的对象**就是** `context.agent`（源码这么写，但没造真 agent 验）。
5. `maxDiscovered` 默认 20 没有权威依据（官方不设上限）。

---

## 纪律（违反任一条，本轮成果作废）

1. **TDD**：每项先写失败用例；后端单测 60s 超时。
2. **每改一处产品代码，跑一次"撤掉改动看红"**（每批一次即可）。反证清单在 `IMPLEMENT-PLAN.md` §6。
3. **断言值从生产代码路径取**，不在测试里重抄常量。
4. **不静默兜底**：失败要么炸、要么显式记账；不允许"看起来成功了其实没生效"。
5. **真宿主契约必须有真宿主用例**——手写夹具会系统性漏掉宿主校验（前几轮的真教训）。
6. **测试命令 `node --test`**；收尾时全量必须绿。
7. **拿不准就说不知道**，不要填一个看起来合理的答案。

---

## 三条"上一轮踩过的坑"，别重踩

1. **"我没找到 API" ≠ "宿主没有这个能力"。** 上一轮我把 `ctx.agents`、公开 API 重建、`dsh web` 的 token
   全判成"做不到"，实际三条都能做。**写"做不到"之前必须回答**：① 搜过整个 API 面吗？② 跑过一次吗？
   ③ 慢/麻烦 与 做不到，分开了吗？
2. **不要解析官方生成的 SDK 文本。** 官方**导出**了渲染器（`renderToolsSdk` / `renderToolsSdkPy`），
   直接重渲染子集；前提自检（`render(全集) === 宿主原文`）不成立就用原文。
3. **`deferLoading` 是陷阱。** 它属于"动态工具增减"，单设会让工具**永久不可用**（DECISIONS §10.3）。
   它不是"按需加载"。

---

## 阶段清单（细节见 IMPLEMENT-PLAN.md §4）

| 阶段 | 内容 | 行为变化 |
|---|---|---|
| S1 | `tool-search-host.js`：能力探测 + `warnOnce` + `chooseToolName` + `inferMode` | 无 |
| S2 | `tool-search-state.js`：LRU + 播种 + `evict` + `foldEvent` + 投影定义 | 无 |
| S3 | `tool-search-sdk.js`：`trimSdkText`（含前提自检） | 无 |
| S4 | runtime：`D = managed − discovered` / 两个布尔 / 目录按 `D` + 缓存 / 引导按 `hasDeferredWork` | 有 |
| S5 | 装配时裁手册（空文本短路、`requireDiscovery` 门控、`programFormat` 有值才传） | 有 |
| S6 | 装配判据 per-agent（`native`/`ptc` 都启用，**只有 `both` inert**）+ `viewFor` 分流 | 有 |
| S7 | 去门槛：删 `applyServerFloor`/`minServerTools` + 改写 6 处断言 + 面板文案 | 有 |
| S8 | `tool_search` 明确报错（`managed = ∅`）+ 搜索签名（按模式）+ 投影恢复 | 有 |
| S9 | `peerDependencies` → `">=0.2.0-rc.1 <0.3.0"` + 文档同步 | 无 |
| S10 | 真机 UI 验证（token URL 配方） | 无 |

**S1–S3 零行为变化，先落地最安全。** S5 与 S6 互为独立 commit，任一可单独 revert。

---

## 收尾（必做）

1. `node --test` 全量绿；`git status` 干净；`lib/` 的每处改动都有对应红→绿证据。
2. 反证清单 `IMPLEMENT-PLAN.md` §6 **逐条真跑一次**，结果写进提交信息或 DECISIONS 的新小节。
3. 更新 `.tasks/mcp-tool-search/OPEN-ITEMS.md`：做完的删掉/打勾，没做的写明卡在哪。
4. `docs/mcp-tool-search-design.md` 按既有格式追加本轮修正（§12.8）。
5. **上下文不够做完就停**：更新交接文档，不要留半验证的改动。

## 本轮不做

- 面板参数表单（C2）——下一轮；但**"显示真实生效状态"已确认可做**（`ctx.agents.list()`）。
- 任何 `both` 模式的新行为（0.2.1 已删除该模式）。
- 任何 0.1.x 兼容。
- 依赖 private API 才能工作的设计（当前零 private 硬依赖：`modeFor` 有公开退化判据）。
