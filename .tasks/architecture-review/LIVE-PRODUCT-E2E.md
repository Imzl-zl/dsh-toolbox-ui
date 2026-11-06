# 真实产品端到端（1.10.0 这一轮）

隔离实例：`D:/sudy/temp/prod-panel-20261106`（`DSH_HOME`/`DSH_AGENTS_HOME`/`HOME`/`TEMP` 全部独立，
端口由 OS 分配，仓库与用户 profile 都没被碰过）。宿主：`0.2.2-rc.1`（真 dsh web 进程）。

## A. 真进程内的变更型 RPC（`probe.mjs`，通过 `ctx.get('mcpManager')`——面板走的就是这个服务）

| RPC | persisted | live | 面板文案 | 旁证 |
|---|---|---|---|---|
| `add(smoke)` | applied | applied | 已添加并开始连接（无需重启宿主） | 4s 后工具表出现 `mcp__smoke__review_lookup` |
| `disable(smoke)` | applied | applied | 已禁用并写入 profile patch | 行状态变化 |
| `enable(smoke)` | applied | applied | 已启用并写入 profile patch | — |
| `update(smoke, defer: true)` | applied | applied | 已更新 profile patch，立即生效 | — |
| `setDefer(smoke, false)` | applied | applied | 已把 smoke 切回全量常驻，立即生效 | `changed: 1` |
| `removeServer(smoke)` | applied | applied | 已移除并停止运行中的连接 | 条目消失、工具表回到只剩 fixture |

`diagnostics` 全程为空数组；每条结果都带 `version`（写盘后的内容指纹）。
`ctx.loader.entries()` 里的相关条目：`add` 后为 `['mcp-fixture','toolbox','smoke']`，`remove` 后回到两条。

## B. 真浏览器面板（Chrome DevTools MCP 驱动真 UI，不是读 DOM 字符串断言）
1. 打开 `http://127.0.0.1:49737/?token=…` → 侧栏「工具箱」→ 面板出现（MCP / 技能 / 工具 三个能力面）。
2. **工具页**：37 个可设置工具，36 常驻 / 1 按需；`mcp__fixture__review_lookup` 在表里（按组策略延迟）。
   点它的「常驻」→「保存」→ 面板提示 **已保存工具加载策略**，计数回到 36/1；
   盘上出现 `toolLoading.tools.mcp__fixture__review_lookup: resident`（稀疏写入，只写非默认值）。
3. **MCP 页**：点 fixture 行的启停开关 → 面板提示 **已禁用 fixture**、`1 个服务 · 0 启用`；
   盘上该行出现 `disabled: true`。再点一次 → `1 个服务 · 1 启用`、`1 个工具`、`已连接`。

这三条覆盖了「写盘 + 运行中」两条事实在**用户可见面**上的表现：提示来自服务端返回的 `note`，
不是前端猜测；启停确实改了盘上的行并由宿主重新挂载。

## C. 这一轮发现的（与发布无关，但值得记住）

- 在插件 `apply()` 期间调用变更型 RPC 会**自锁**：`reconcileProfilePatches` 内部 `loader.await()`
  等的是"所有未完成的初始化任务"，而此刻我们自己就是那个任务。真实面板的调用发生在启动完成
  之后，不会遇到；写在这里是为了让后来写脚本/探针的人别踩（`probe.mjs` 用 `setTimeout` 复刻真实时机）。
- 夹具写成 `command: node`（无脚本）时，子进程会把 MCP 的 stdin 当脚本读，既不握手也不退出；
  rc.1 的 mcp-client 在 dispose 时会等它收尾。测试里已改用真夹具服务器。

## D. ToolSearch 本身（产品路径，真宿主进程）

隔离实例：`D:/sudy/temp/prod-toolsearch-20261106`（rc.1 真 dsh web；插件是**本轮源码**的副本；
夹具 MCP 一台，组级策略 `groups.fixture = deferred`）。探针 `driver.mjs` 直接调产品注册表
（`ctx.tools.get(...).execute(...)`），不用模型。

```
TS_PROBE before : { hiddenBefore: true, catalogLists: true, toolCount: 35 }
TS_PROBE search : { matchName: 'mcp__fixture__review_lookup', hasParameters: true }
TS_PROBE after  : { visibleAfter: true, otherIsolated: true }
TS_PROBE call   : { value: 'VALUE-7f45b47a-…' }
TS_PROBE panel  : { total: 38, row: { policy: 'deferred', owner: 'fixture', reason: 'global-group' } }
TS_PROBE result : { status: 'passed' }
```

这证明**机制**在产品里成立：延迟工具在最终模型可见清单里不可见（35 条）→ 目录段列出它 →
真执行一次 `tool_search` 拿到**完整 schema** → 同一准入根里它回到声明、并且**真的能调用**
（返回值是夹具进程启动时随机生成的 `VALUE-…`，只能来自真实调用链）→ 另一个 agent 未被污染 →
面板 RPC 报的实际策略是 `deferred`。

## E. 真模型回合（10:04 那次，同一套 ToolSearch 代码层）

`D:/sudy/temp/prod-live-20261106/logs/result.json`（rc.1 + spark-x2.6）：

| 场景 | 调用序列 | 断言 |
|---|---|---|
| standard（native 声明） | `tool_search` → `mcp__fixture__review_lookup` | 搜索在调用之前（`searchedBeforeCall: true`）；最终答案含工具随机值；发现后工具进声明；另一个 agent 不受影响 |
| ptc（`run_code` 内） | 一次 `run_code`，嵌套派发 `tool_search` → 目标工具 | 同一程序内先搜索后调用，两次派发都成功，返回真实随机值并回到 `tools:sdk` |

模型请求侧证据：第一轮请求 35 个工具（目标不在其中），搜索后的请求变成 36 个（目标已进入）。
本轮 W3/W4 没有改策略/呈现这一层（只改了行生命周期、结果字段、契约生成与客户端拆分），
上面 §D 在**本轮源码**上重新验证了同一机制；真模型回合若要在本轮源码上重跑，需要
`REVIEW_MODEL_KEY`（当前环境没有该变量）。

## F. 真模型回合（本轮构建 1.10.0，21:0x 跑）

隔离实例 `D:/sudy/temp/prod-toolsearch-model-20261106`：rc.1 真 dsh web + 本轮源码副本 + 一台真 MCP
夹具（组策略 `groups.fixture = deferred`）+ 本地网关渠道（`http://127.0.0.1:3425/v1`，模型
`spark/spark-x2.6`，OpenAI-completions）。中间串了一个只落盘请求/响应的观察代理（127.0.0.1:34301）。

```
TS_MODEL standard : calls = ["tool_search", "mcp__fixture__review_lookup"]
                    searchedBeforeCall = true
                    visibleAfter = true
                    otherAgentIsolated = true
                    answerEchoesValue = true   (VALUE-2dc3130f-b408-431b-b504-aa9902c52533)
TS_MODEL panel    : total = 38, row = { policy: 'deferred', owner: 'fixture', reason: 'global-group' }
TS_MODEL ptc      : calls = ["run_code"], dispatches = [tool_search(ok), mcp__fixture__review_lookup(ok)]
TS_MODEL requests : tools=35 target=false → tools=36 target=true → tools=36 → (ptc) tools=1 ×2
TS_MODEL result   : status = passed
```

这就是"模型真的会用它"的证据：**第一次请求 35 个工具（目标不在其中）→ 模型自己调 `tool_search`
→ 下一次请求 36 个（目标已进入）→ 模型调用目标工具 → 最终答案等于夹具进程启动时随机生成的值**。
PTC 场景在同一个 `run_code` 程序里完成"搜索 + 调用"，两次嵌套派发都成功。

排障记录（都不涉及产品代码）：`relayfor/deepseek-v4.1-flash` 在网关侧"暂无可用渠道"（503 与一次
400），换成 `spark/spark-x2.6` 后稳定；网关调用凭据只经子进程环境进入（`LOCAL_GW_KEY`），
不写进任何文件或日志。
