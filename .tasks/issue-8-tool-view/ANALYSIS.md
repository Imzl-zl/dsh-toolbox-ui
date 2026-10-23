# issue #8：新建会话固定卡顿 —— 源码核对、根因与最终方案

> 状态：**已实现，未提交**（分支 `fix/issue-8-tool-view`，基线 v1.8.2）
> 证据分级：**【读码】**= 只读源码得出的结论；**【实测】**= 真宿主 / 真 stdio 子进程 / 真模型跑出来的数字。
> 外部依据：GitHub issue #8（Wuyunonjiji，2026-10-23）、DSH 源码 `D:\sudy\github\deepseek-harness`、插件 v1.8.2、DSH Desktop 0.2.1-rc.2。
> 探针：`probes/`（本目录，可复跑；命令见 §10）。

---

## 0 · 一句话

> 项目 MCP 的工具**只能**复制进每个 agent 自己的工具层（平台没有“工作区级工具来源”，agent 的唯一父级被 preset 占用）；
> 平台公开的读面只有“逐个 `get()`（每次重建全表）”和“`schemas()`（全量深拷贝 parameters）”。
> 插件原来对**每一次** `tools/change` 都把这件事重做一遍，于是代价是 `O(事件 × 会话 × 工具)`。
> 最终方案：**一条连接的工具集按“代次哨兵”缓存，事件合并成一轮**——稳态下一次重算只付**一次 `get()`**，
> 且只用公开 API。
> （复核轮删掉了原先的第三层「投射批次内忽略事件」，四个机制收敛成三个，理由与实测见 §5.1。）

---

## 1 · issue 的说法 vs 核对结论

| issue 的说法 | 核对 |
|---|---|
| `L527/L545/L552/L553/L574` 的热点循环 | 【读码】与 v1.8.2 完全一致 |
| `dsh-tools` 无缓存：`get()` 内部又一次 `view()`，`schemas()` = `view()` + 全量深拷贝 | 【读码】属实（0.2.1-rc.2 `lib/index.js:2959/2995/3023`；0.2.0-rc.1 同位置也存在） |
| `tools/change` 同步派发、每次遍历全部会话 | 【读码】属实（`tools/index.ts:836` 的 `ScopedLayers` onChange → `emit('tools/change')`，无载荷） |
| 读失败 → 当空集 → 卸载已注册工具 | 【读码】属实，是独立的正确性缺陷 |
| 建议“改成一次 `view()` 遍历” | 【读码】**不能采纳**：`view()` / `schemaOf()` 是宿主 **private** 方法（`core/tools/src/index.ts:1186/1290`），README 只公开 `register/restrict/guard/get/schemas` |
| 建议“合并 `tools/change`” | 采纳，但它是**第二层**手段；第一层是“根本没有变化就别读” |

---

## 2 · 源码事实（结论的依据）

| # | 事实 | 位置 |
|---|---|---|
| S1 | agent 的 scope 由 `createScope(loopCtx, agent)` 建立，`agent.ctx === scope.ctx`；**创建时没有父级** | `packages/core/agent-loop/src/agent.ts:130-131` |
| S2 | `bindScopeParent` 对**已绑定**的 key 直接抛错（scope 链是单父） | `packages/core/scope/src/index.ts:72` |
| S3 | 桌面版每次 create/resume 的 setup 里 `presets.mount(agentCtx, ...)` → `bindScopeParent(agentKey, generationKey)` | `packages/api/session-controller/src/agent.ts:388-399`、`packages/preset/agent-preset-registry/src/index.ts:266` |
| S4 | 桌面跑的是 web 应用 profile，web-app bundle **compose 了** `agent-preset-registry`（default `standard`）；headless 明确不 compose | `apps/desktop-host/src/index.ts:1`、`packages/bundle/web-app/cordis.patch.yml:586`、`packages/bundle/headless/src/index.ts:196` |
| S5 | 公开读面只有 `get(name, scope)` / `schemas(scope)`；`view`/`schemaOf` 是 private。**注意**：它们是 TS `private` 修饰符落在真 class 上（无 `#` 字段），编译后就是原型方法 ⇒ **运行期可达**，只是非契约（不进生成的声明、不进 README） | `packages/core/tools/src/index.ts:1186/1238/1268/1290`、`packages/core/tools/README.md:85` |
| S6 | `mcp-client` 每次 `tools/list` 同步都**整批重建定义对象**（generation：dispose 旧代 → register 新代） | `packages/mcp/mcp-client/src/connection.ts:172`（`syncTools(generation, ...)`）、`src/tools.ts:117-153` |
| S7 | 官方“agent 级 MCP”的做法是**每 agent 一个连接**：`createScope(ctx, agent)` + 在该 scope 里挂 `McpClient` | `packages/experimental/browser-use-runtime/src/mcp.ts:118-155` |
| S8 | preset 的共享能力用的是“代次 scope + 绑定 + `rebind` + 引用计数”，**只支持一个父级** | `packages/preset/agent-preset-registry/src/index.ts:243-296` |

**推论（决定了整个方案）**：

- S1–S4 合起来 ⇒ **“把 agent scope 绑到项目 scope 上”在桌面版不可行**（父级槽位已被 preset 占掉，且不能抢）。
- S5 ⇒ 插件没有“一次读全部定义”的公开接口；读一次的代价是 1 次全表重建（`get`）或 1 次全量深拷贝（`schemas`）。
- S6 ⇒ **一个定义对象的身份 = 一条连接的工具代次**。这是本方案唯一依赖的宿主不变量，可测、可回归。
- S7 的代价是每个会话一条子进程；对一个 207 工具的服务器不可接受 ⇒ 共享连接 + 投射是正确方向，不是“绕路”。

---

## 3 · 根因（三层，缺一不可）

1. **平台层**：没有“工作区级工具来源”的抽象。全局层、agent 层、preset 代次层都有，工作区没有位置；agent 的单父槽位又被 preset 占用 ⇒ 项目工具必须**复制**进每个 agent 的 own 层。
2. **接口层**：“复制”需要读定义，而公开读面没有批量/便宜的读法 ⇒ 每次重算天然 `N+1` 次全表重建或 1 次全量深拷贝。
3. **事件层**：`tools/change` 无载荷，任何层的任何变更都会派发（包括插件**自己**的投射）⇒ 原实现把它当“全世界都要重算”，且自激。

原代码的总代价因此是 `O(事件数) × O(存活会话) × O(工具数 × 层数)`；issue 实测的 92–143 ms 与 431 次重算、324 s 累计都落在这条链上。

---

## 4 · 被否决的方案（每条先写它最强的地方）

### 4.1 用作用域继承代替投射（`bindScopeParent`）
- **最强理由**：零复制、零重算、多会话共享同一批定义对象，理论上是最干净的形态；【实测】在无 preset 的组合里完全成立（`probes/scope-inherit-probe.mjs`：继承、`restrict` 过滤继承名、`rebind` 迁移全部通过）。
- **为什么否**：桌面版 agent 的唯一父级在 setup 里已被 preset 绑定（S3/S4），`bindScopeParent` 会抛错（S2）。要腾出槽位只能抢 preset 的绑定或改写宿主创建流程——前者会破坏 preset 工具，后者本仓上一轮刚把“包装 create/resume”删掉改成官方事件。
- **代价**：接受“每个会话复制一份定义引用”（注意：不是复制工具对象本身，宿主里是同一个定义对象被多个层引用）。

### 4.2 用 `view()` / `schemaOf()` 提速
- **最强理由**：一次 `view(scope)` 同时给名字与定义，实测 0.04 ms，比 `schemas()` 的 5.8 ms 和逐名 `get()` 快两个数量级；语义与宿主内部完全一致。
- **为什么否**：两者在源码里是 `private`（S5），不是插件契约；宿主改名/改形就断，而且文档面没有它。**这是“绕路”**，不能进发布版。
- **代价**：读一次必须付“1 次 `schemas()` 深拷贝 + 逐名 `get()`”，所以只能靠“减少读取次数”而不是“降低单次读取成本”取胜。

### 4.3 把 `tools/change` 合并当成主解
- **最强理由**：一次 207 工具的注册会派发 200+ 次事件，合并直接把 200+ 轮压成 1 轮；不改读面，风险最小。
- **为什么否**：合并只解决“次数”，不解决“每轮都要读全表”。修完后如果每轮仍读 `schemas()`，一个有 `exclude` 的工作区每次合并事件仍要 20 ms 深拷贝。合并因此降级为**第二层**手段，与哨兵配合。
- **代价**：事件从同步变成“同一微任务内合并”，`tools/change` 的投射最多延迟一个微任务；首轮就绪仍由挂载路径同步保证。

### 4.4 每个 agent 各挂一个 `mcp-client`（官方 agent-scoped 模式，S7）
- **最强理由**：这是宿主官方的“agent 级 MCP”写法，无投射、无读取、无共享，语义最简单。
- **为什么否**：每会话一条子进程；207 工具的服务器 × N 个会话 = N 份内存与握手成本，且项目级“一份连接”正是本插件的产品语义。
- **代价**：保留共享连接与投射，接受“复制引用”的成本。

### 4.5 先推上游公开 `view()` 再发版
- **最强理由**：一行可见性改动 + 文档，插件就能拿回 0.04 ms 的读法，且完全合规。
- **为什么否（本轮）**：用户要求一次发版；本方案已经用公开面做到稳态 `O(1)`，不需要等上游。上游若日后公开 `definitions(scope)` / `own(scope)`，`readConnectionTools` 的刷新分支可以整体替换，哨兵机制可以退休——这是**可选的优化**，不是前置条件。
- **代价**：换代时仍付一次 `schemas()` 深拷贝（见 §9）。

---

## 5 · 最终方案：三个机制

| 机制 | 代码 | 作用 |
|---|---|---|
| **代次哨兵** | `readConnectionTools`（[lib/workspace-runtime.js:763](../../lib/workspace-runtime.js)） | 每条连接缓存 `{definitions, sentinel}`；每次只 `get(sentinel, scopeKey)` 一次：身份相同 ⇒ 整条连接没换代码 ⇒ 直接返回缓存；身份变了 ⇒ `schemas(scopeKey)` 拿名字 + 逐名 `get()` 拿定义，刷新缓存。`names` 就是 `definitions` 的键，不另存一份。空连接用 `checkedEpoch` 避开发哨兵（否则每轮都会为“拿名字”深拷贝一次全局层）。 |
| **定义身份对账** | `syncSessionProjectTools`（[lib/workspace-runtime.js:541](../../lib/workspace-runtime.js)） | 每个 slot 记 `projected: Map<name, {definition, dispose}>`；对账键是**定义对象**，不是名字。换代时先 `dispose` 旧定义再 `register` 新定义。 |
| **事件合并 + deny 缓存** | `scheduleToolsChange`（[lib/workspace-runtime.js:1162](../../lib/workspace-runtime.js)）、`denyForExclude`（[lib/workspace-runtime.js:1069](../../lib/workspace-runtime.js)） | 同一微任务内的外部事件合并成一轮；每轮自增 `toolsEpoch`。`exclude` 展开按 (代次, 全局 serverName 集合, exclude) 缓存，空 `exclude` 直接短路 ⇒ 不再“每个会话各深拷贝一次”。 |

保留的既有修复：按 wsPath 分组读配置（不再每会话一次 `stat`）、读失败不卸载（读不到 ≠ 没有工具）。

### 5.1 复核轮删掉的第四层：投射批次加锁（`withProjectionGuard`）

原先在挂载 / 重算的同步投射块内把 `tools/change` 一律忽略，理由是“同步代码块里不可能插进别人的变更，所以这批事件一定是我们自己发的”。**这条不成立**：

- `cordis emit` 是 `dispatch('emit', args).map(cb => cb(...))`（同步、不 await），所以 `register()` 派发期间**别的监听器会同步跑**；它们若注册工具，nested emit 会被守卫吞掉。真例：`packages/subagent/tool-subagent/src/index.ts:503` 的监听器，它自己在 `:462-463` 就写着「tool registration emits `tools/change` synchronously, which re-enters」。
- 它还有一条静默跳过：守卫命中时 `run()` 不执行，而 `moveSlotToConnection` 是先 `projected.clear()` 再调用并忽略返回值 —— 一旦将来在守卫内被调用，会话的工具会被静默清空。
- 收益实测为零：去掉后 `test/workspace-runtime.test.mjs` 52/52、全量 832/833、e2e 每个指标持平或更好（交替各两轮的比值见 §6）。

去掉后自己发出的那一批事件由**合并**吸收，且重算是幂等的（哨兵没换就不注册），只多排一轮空转，不会自激。`tools/change` 没有载荷，任何“按是谁发的过滤”都只能靠猜，所以这一层不该存在。

### 语义不变式（review 时按这条清单看）

1. 投射的唯一来源是**连接 scope 的当前定义**；`projected` 里记录的那个对象必须与连接当前那一版**同源**。
2. “连接工具集变了”的判据是**哨兵定义身份**，不是名字集合，也不是事件次数。
3. 任何 `tools/change`（包括本模块投射时同步派发的那一批）都**只**通过 `scheduleToolsChange` 合并成一轮；**不做**按来源过滤。
4. 读取失败 ⇒ 本轮不增不删，只记账；不得把空集当“没有工具”。
5. `deny` 依赖 (exclude, 全局 serverName 集合, 全局工具**内容**)；最后一项由 `toolsEpoch` 近似 —— 它每轮 flush 自增，而 flush 正是由每一次 register/dispose 派发的 `tools/change` 排出来的。`restrict` 只在确保生效后记账。
6. 不读私有 API、不缓存宿主状态到模块级以外（`entry.toolCache` 随连接生命周期消失）。

---

## 6 · 测量（隔离进程，真 cordis + 真 `dsh-mcp-client` + 真 stdio，207 工具、schema 249 KB）

**先说口径**：这台机器上同一份代码的墙钟能差 2×（同一版首会话 408 ms 与 813 ms 都出现过），
所以**判据是同一次交替运行里的 new/base 比值**，不是跨轮绝对值。下表是复核轮交替跑两轮的结果（每轮 new → base）。

| 指标 | v1.8.2 基线 | 现在（三个机制版） |
|---|---|---|
| 首个会话（建连 + 207 注册 + 投射） | 1315 / 1867 ms | **408 / 813 ms** |
| 其中 `register()` 同步段 | 998 / 1359 ms | **29 / 83 ms** |
| 8 个存活会话下一次 `tools/change` | 72–104 / 68–83 ms | **0.68–1.06 / 1.41–2.19 ms** |
| 第 8 个会话创建 | 329 / 210 ms | **20 / 45 ms**（不随会话数增长） |
| 无项目 MCP 工作区新建会话 | 245–275 ms | **1.3–1.8 ms** |
| 面板轮询一次 `projectConnectionsView` | 101 / 46 ms | 5.2 / 11.7 ms ⚠ 见下 |
| 每会话投射工具数 / 真调 `echo` | 207 / 成功 | 207 / 成功 |
| 重复注册告警 | 3 条 | **0** |

⚠ **面板那一行只在“前一串事件还没排完”的量法下成立，不是面板本身变快了。** 静置后（`probes/panel-idle-probe.mjs`：8 会话建完 + 等 100 ms 清队）实测基线 min **13.15 ms** / 现在 min **14.52 ms** —— 两者都还是一次 `schemas(scope)` 深拷贝，本改动**没有**降低它，反而多了一次哨兵 `get()`（0.04 ms）。e2e 里的下降来自“基线还压着 414×8 个未 await 的配置读取”。

【实测】`probes/bench.mjs`（读面原语级，258 工具）：`view(scope)` 0.059 ms、`get()` 0.037 ms、`schemas(scope)` 20.6 ms、`schemas()` 2.38 ms；单次 `syncSessionProjectTools` 的旧读法 27.4 ms → 新读法 0.05 ms（≈229×）。
【实测】复核轮删掉 `withProjectionGuard` 前后，交替各两轮的 e2e 每个指标持平或更好；`node --test` 52/52 与全量 832/833 不变。

---

## 7 · 测试

- 新增三条回归（旧实现上为红）：
  - 稳态只付一次哨兵 `get()`、不读 `schemas`（[test/workspace-runtime.test.mjs:917](../../test/workspace-runtime.test.mjs)）
  - **连接重建定义后必须刷新成新定义**（[test/workspace-runtime.test.mjs:941](../../test/workspace-runtime.test.mjs)）——旧实现只按名字对账，会把指向已关闭 client 的旧定义留在会话里（既有缺陷）
  - 注册工具时同步派发的 `tools/change` 不会让同一工具注册两次（[test/workspace-runtime.test.mjs:998](../../test/workspace-runtime.test.mjs)）
- 全量 `node --test`：833 条，**832 通过**；唯一失败是既有的 `real-host-loader` 环境用例（读 `process.env.HOME`，本机 Windows 没有该变量，基线同样失败）。

---

## 8 · 剩余边界 / 开放问题

1. **换代仍付一次 `schemas(scope)` 全量深拷贝**（207 工具 ≈ 20 ms），这是公开读面拿名字的唯一办法；只在 `tools/list` 变化 / 重连 / 就地重载时付，稳态不付。
2. **用了 `exclude` 的工作区**，每轮合并事件重算一次 deny（一次全局 `schemas()`，51 个全局工具 ≈ 2.4 ms）；空 `exclude` 直接短路、零成本。键里带 `toolsEpoch`，所以同一轮内所有会话共用一份、且跨轮不会陈旧（**这条原先写成“未采用缓存”，复核轮已改正**）。
3. **哨兵依赖 S6**（mcp-client 每次同步整批重建定义）。上游若改成增量同步，哨兵会漏掉“新增但未重建”的工具；`连接重建定义后必须刷新` 这条用例不会自动红（夹具建模的是旧形状）。**已补契约探针**：`probes/sentinel-contract-probe.mjs` —— 真 stdio 子进程发 `notifications/tools/list_changed`，判据是「每个仍在的名字，定义对象都必须换新」（实测：2→3 个工具，同名两个全部换新，`ok: true`）。上游一改增量同步，这个探针先红。
4. **面板**仍是 5 s 一次 `schemas(scope)` 深拷贝（详情要 parameters），不在事件链上；本改动**没有**降低它（见 §6 的 ⚠）。
5. **空工具连接**：靠 `checkedEpoch` 每轮只探一次，粒度是**连接**不是会话（`toolCache` 挂在 entry 上），所以 N 个会话共用一条连接时每轮只付一次。
6. 未验证：DSH Desktop 本体（探针是 in-process 真宿主 + 真子进程）；宿主 0.2.0-rc.1 只核对了 API 存在，没跑行为。

---

## 9 · 改动清单与复跑

分支 `fix/issue-8-tool-view`（未提交）：

| 文件 | 改动 |
|---|---|
| `lib/workspace-runtime.js` | 三机制 + 既有修复；删除对 `view()`/`schemaOf()` 的依赖；复核轮删掉 `withProjectionGuard`、把 `readConnectionTools` 的返回收成 `{definitions, error, failed}` |
| `test/workspace-runtime.test.mjs` | 夹具按真宿主建模（`register` 同步 emit、重复注册抛错、代次重建）；三条新回归 |
| `test/package-contract.test.mjs` | 宿主契约注释改为“只用公开读面 + preset 独占父级” |
| `docs/mcp-tool-search-design.md` | 读面 API 表与行号同步 |
| `.tasks/issue-8-tool-view/probes/panel-idle-probe.mjs` | 复核轮新增：把“面板一次轮询”从队列尾巴里分离出来（静置后取 5 次最小值） |
| `.tasks/issue-8-tool-view/probes/sentinel-contract-probe.mjs` | 复核轮新增：对**已安装的 mcp-client** 验证「re-sync 整批重建定义」这条上游契约（绿 = 哨兵前提成立，红 = 哨兵该重做） |

复跑：

```powershell
# 单元 / 全量
node --test test\workspace-runtime.test.mjs
node --test

# 读面成本（宿主原语级）
node .tasks\issue-8-tool-view\probes\bench.mjs

# 真宿主端到端（基线需先生成一份 v1.8.2 的实现副本）
# 注意：fixed 与 baseline 必须**串行**跑，并行会互相污染（实测首会话 740→408 的差就是这么来的）
git show v1.8.2:lib/workspace-runtime.js | Set-Content -Encoding utf8 lib\.baseline-workspace-runtime.mjs
node .tasks\issue-8-tool-view\probes\e2e-probe.mjs fixed
node .tasks\issue-8-tool-view\probes\e2e-probe.mjs baseline
Remove-Item lib\.baseline-workspace-runtime.mjs

# 面板轮询的“静置成本”（证明它没变快）
node .tasks\issue-8-tool-view\probes\panel-idle-probe.mjs fixed
node .tasks\issue-8-tool-view\probes\panel-idle-probe.mjs baseline

# 上游契约：哨兵的前提（re-sync 是否整批重建定义）—— 绿=前提成立，红=哨兵要重做
node .tasks\issue-8-tool-view\probes\sentinel-contract-probe.mjs

# 作用域继承实验（证明“绑定”在无 preset 时成立、有 preset 时不可行）
node .tasks\issue-8-tool-view\probes\scope-inherit-probe.mjs

# 模型侧闭环（需要环境变量，key 不落盘）
$env:LIGHTVELA_KEY='...'; node .tasks\issue-8-tool-view\probes\llm-smoke.mjs
```

> 迁移说明：`.tmp-issue8/` 是 gitignored 的临时目录，正式版探针已搬到 `probes/` 并修好相对路径；
> `probes/bench.mjs` 里仍保留 `view()`/`schemaOf()` 的对比测量 —— 那是**探针**，不是插件代码。

---

## 10 · 复核记录（第二轮：独立复核「最原生、最省、语义最清晰」）

**判定：改进，已落地。** 架构（哨兵 + 身份对账 + 合并）不动；删掉第四层守卫，收紧返回结构。

复核确认了 §2 的全部事实，并补三条更硬的反证：
- `view()`/`schemaOf()` 虽是 TS `private`，但落在真 class 上（无 `#` 字段）⇒ **运行期可达**，拒绝使用是**契约**判断而非技术不可能（S5 已补注）。
- scope 的父级槽位不仅“已被占”，`createScope({ parent })` 还**丢弃**了 binding 句柄（`packages/core/scope/src/index.ts:138`）⇒ 连“先建父再改”都不存在。
- **不存在工作区级工具源**：`packages/workspace` 不创建 scope、不碰 tools；作用域只有 global/preset/agent 三档（`docs/architecture.md:145-163`）；`packages/util/launch-environment/README.md:103` 明写「**No per-workspace layer** … **deliberately**」。

复核轮的实际改动：

| 项 | 改动 | 证据 |
|---|---|---|
| 机制 3 删除 | 删 `withProjectionGuard` + 监听器短路 + 3 个调用点 | 删除后 52/52、832/833；e2e 交替两轮每项持平或更好 |
| 返回结构 | `{names,definitions,error,failed,changed}` → `{definitions,error,failed}` | `changed` 0 消费；`names` ≡ `definitions.keys()` |
| 死代码 | 删 `disposeProjectSlot` 里重复的 `projected.clear()` | — |
| 注释 | 删「同步块内的事件必然是本批次产生的」（假）；`denyForExclude` 与 `isDeadConnection` 注释按实际行为重写 | `cordis emit` 同步派发；真例 `packages/subagent/tool-subagent/src/index.ts:503` |
| 文档 | 修正 §6 面板行、§8.2、§8.5 | `probes/panel-idle-probe.mjs` |

**仍未解决（不是本插件能解决的）**：
1. 换代仍付一次 `schemas(scope)` 深拷贝（207 工具 ≈ 20 ms）——公开面拿名字的唯一办法。
2. 哨兵依赖 mcp-client 的“整批重建”设计（S6），上游改增量同步会漏；已用 `probes/sentinel-contract-probe.mjs` 兜住（上游一改就红）。
3. 每条项目连接的工具仍要**复制**进每个 agent 的 own 层（平台没有 workspace 级来源）。
4. 面板每 5 s 仍付一次 `schemas(scope)` 深拷贝（要 parameters）。**还能再快但不做**：把 `toolRevision` 挂在工具代次上可把轮询从 ≈14 ms 降到 ≈0.6 ms，代价是让「S6 假设」多一个消费者（漏了就是面板显示过期清单），不值得。
5. 未在 DSH Desktop 本体上跑过（探针是 in-process 真宿主 + 真 stdio 子进程 + 真模型）。

**模型侧闭环已补验（2026-10-23）**：本地中转（`http://127.0.0.1:23333/v1`）+ 真模型。模型看到的正是会话里投射出来的 schema `mcp__fixture__echo`，返回 `{"text":"issue-8 冒烟"}`；用该实参调**真 stdio 子进程**得 `fixture-says:issue-8 冒烟`；回灌后最终回复一致。key 只走环境变量，未落盘。

**上游一步到位**：给 `ToolRuntime` 加 `own(scope): ReadonlyMap<string, ToolDefinition>`（内部已有 `this.layers.peek(scope)`，`packages/core/tools/src/index.ts:1192`）。有了它就删掉哨兵缓存、`dropForeignNames`、前缀过滤与 deny 缓存；删不掉投射本身、事件合并、身份对账。

