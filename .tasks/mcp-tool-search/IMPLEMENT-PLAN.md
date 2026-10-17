# 实施方案：MCP ToolSearch × PTC（第十轮定稿）

> 依据：`.tasks/mcp-tool-search/DECISIONS.md`（B1–B14 / C1–C6 / G1–G4 / V1–V3）。
> 本文是**执行计划**，不重复论证；有疑问回 DECISIONS.md 查证据编号。
> 当前环境：运行宿主 **0.2.0-rc.2**，支持范围 **`>=0.2.0-rc.1 <0.3.0`**。

---

## 0 · 交付目标（可量化验收）

| # | 目标 | 验收方式 |
|---|---|---|
| D1 | PTC 会话不再倒贴 | 35 工具夹具：`renderPrompt` 从 **15510** 降到 **≤ 7500** 字符（不装插件是 12651） |
| D2 | native 会话零变化 | 现有 `tool-search-*` 用例全绿；同进程 native 对照用例断言遮罩/守卫/目录/手册全照旧 |
| D3 | 勾了就生效 | 12 工具服务器（原来被门槛挡）在真宿主里 `deferring` 为真、目录出现、手册被裁 |
| D4 | 发现状态能恢复 | **native 与 PTC 两条**都从会话还原发现集（真宿主用例） |
| D5 | 退化不劣于今天 | 五条护栏用例（§11.6）全绿；撤掉任一道护栏对应用例必红 |
| D6 | 全量绿 | `node --test` **738 + 新增**，0 红 |

---

## 1 · 代码结构（新增 3 个模块，拆分按职责）

```
lib/tool-search-host.js     能力探测 + 重名选名         （新增，~80 行）
lib/tool-search-sdk.js      SDK 手册裁剪（纯决策）       （新增，~90 行）
lib/tool-search-state.js    发现集 LRU + 投影 fold       （新增，~140 行）
lib/tool-search-runtime.js  只留装配与三入口，调用上面三个（改，净增 ~80 行）
lib/tool-search-config.js   配置桥                          （不动）
lib/tool-search-index.js    目录索引                        （不动）
lib/index.js                装配点 + peer 无关的注释
lib/client.js               文案
```

**为什么拆**：runtime 已 569 行；裁剪、状态、探测是三块**可以单独测**的纯逻辑，
塞进 runtime 会让"每个入口都要读 600 行"。

---

## 2 · 模块接口与不变量

### 2.1 `tool-search-host.js`

```js
export function probeHost(ctx) {
  const tools = ctx.tools
  return {
    modeFor:     typeof tools?.modeFor === 'function',      // private，但全 0.2 都在
    sdkSchemas:  typeof tools?.sdkSchemas === 'function',   // 可选快路径，缺席不影响正确性
    projections: typeof ctx.get?.('sessionProjections')?.register === 'function'
              && typeof ctx.get?.('sessionProjections')?.stateOf === 'function',
    agents:      typeof ctx.get?.('agents')?.list === 'function',   // 面板用（C2）
  }
}
// 日志去重：每个缺项只记一次（Set 记已报过的键），不刷屏
export function warnOnce(ctx, key, message)

/** G1 的公开退化判据：modeFor 不可用时从 assembly 形状推断 */
export function inferMode(assemblyTools, managed) {
  const hasRunCode = assemblyTools.some(t => t.name === 'run_code')
  if (!hasRunCode) return 'native'
  return assemblyTools.some(t => managed.has(t.name)) ? 'both' : 'ptc'
}

// G4：返回一个可注册的名字 + 是否改名
export function chooseToolName(tools, preferred, candidates)
```

**不变量**
- `probeHost` 安装时调用**一次**，结果存起来；热点路径不再探测。
- **数据来源是公开 API**（`schemas()` + `get()`，F22）；`sdkSchemas` 只用来省时间，
  **它缺席时行为不变**（只是每次 revision 多花一次 `get()` 预热）。
- `chooseToolName`：`tools.get(name) === undefined` 才算可用；全部被占 → 抛错（明确失败，不静默）。
- 缺项**不抛错**，只 `warnOnce`。

### 2.2 `tool-search-sdk.js`

```js
/**
 * @returns {{ ok: true, text: string, dropped: number }
 *         | { ok: false, reason: 'no-schemas'|'no-drop'|'premise-mismatch'|'render-threw' }}
 */
export function trimSdkText({ hostText, schemas, drop, render, programFormat })
```

算法（**唯一正确顺序**）：

```
1. if (!Array.isArray(schemas) || schemas.length === 0) → no-schemas
2. full = render(schemas, programFormat?)        // programFormat === undefined 时不传
3. if (full !== hostText) → premise-mismatch     ← 前提自检：我能复现宿主原文吗
4. kept = schemas.filter(s => !drop.has(s.name))
5. if (kept.length === schemas.length) → no-drop
6. return { ok: true, text: render(kept, programFormat?) }
```

**不变量（写进注释）**
- 第 3 步验证的是**前提**（"我算出的输入 = 宿主渲染用的输入"），**不是**变换本身；
  它**不检测**宿主渲染器版本漂移（同一包 → 两边一起变）。
- 失败一律**返回原文**（调用方用 `hostText`），永不发坏文本。
- **不做名字残留扫描**：被删的名字可能出现在别的工具描述里 → 假阳性会把裁剪误判成失败。
  第 3 步的逐字节相等已经蕴含"删的就是那些条目"。

### 2.3 `tool-search-state.js`

```js
export function createState()                       // { tick: 0, discovered: Map<name, tick> }
export function seed(state, names)                  // 恢复：按发现顺序播种（C4）
export function discover(state, names)              // B8：新名字播种为 ++tick
export function touch(state, name)                  // LRU：只在已发现时刷新
export function evict(state, cap)                   // B9 公式，返回被淘汰的名字数组
export function versionOf(state)                    // 目录文本缓存键（每次变更 +1）
export function sizeOf(state)
export function foldEvent(state, event, opts)       // 投影 apply：纯函数，未变化时返回原 state
export function discoveryProjection({ z, max, toolName, protocol })
```

**`evict` 公式（DECISIONS §2.1 已修正）**

```js
if (state.discovered.size <= cap) return []
const k = Math.max(1, Math.floor(state.discovered.size / 2))
const remove = Math.min(state.discovered.size - cap, k)
// 按 tick 升序取前 remove 个删除
```

**`foldEvent`**（投影 apply）
- `event.type === 'tool/result'` → `event.data.message.content[0].text`
- `event.type === 'tool/ptc-dispatch'` && `event.data.name === toolName` → `event.data.content[0].text`
- 解析 JSON + `parseDiscoveredMeta`（复用现有导出）；无新名字 → **返回原 state 引用**
  （注册表只在引用变化时通知，减少噪声）
- 结果按 `max = max(maxDiscovered*4, 100)` **从旧到新剪枝**（有界）

**不变量**
- `apply` **必须始终返回状态对象**（不能 `return undefined`——探针里踩过，会把状态设成 undefined）。
- 状态是纯 JSON：`{ discovered: string[] }`。
- `stateVersion: 1`。

---

## 3 · 关键算法

### 3.1 `D = managed − discovered` 与两个布尔

```js
const hasDeferredServers = view.managed.size > 0          // 给 guard / 搜索
const D = new Set([...view.managed.keys()].filter(n => !discovered.has(n)))
const hasDeferredWork = D.size > 0                        // 给目录 / 引导 / SDK 裁剪
```

| 用途 | 判据 |
|---|---|
| 遮罩 `assembly.tools` | `D`（现有 `filterManagedTools` 已是，只是把 discovered 换成 LRU map 的 `has`） |
| 指令段 `mcp:<server>` | 该服务器有工具在 `D`（现有 `activeMaskedServers` 已对） |
| **目录段** | `D`（**改**：现在列 `managed` 全集） |
| **引导段** | `hasDeferredWork`（**改**：现在看 `deferring`） |
| **SDK 裁剪** | `D` |
| guard 拒绝 | `D` |
| `tool_search` 明确报错 | `hasDeferredServers === false`（B13） |

### 3.2 目录文本缓存（B11 修正）

- 搜索索引仍建在 `managed`（`view.catalog`，按 revision 缓存，复用现状）。
- **显示文本**按 `D` 过滤，缓存键 = `` `${revision}:${versionOf(state)}` ``，
  存两个 slot（当前 + 上一版）避免抖动。
- 只过滤显示，不重建索引 → 735 工具不出现 52.8ms 重建。

### 3.3 装配时裁手册

在现有 `system-prompt/assemble` handler 里，`next()` 之后、返回之前：

```js
if (!caps.sdkSchemas && !caps.publicSchemas) → 跳过（实际上公开路径恒可用，所以这条几乎不触发）
if (resolved.requireDiscovery !== true) → 跳过（B12）
const mode = caps.modeFor ? ctx.tools.modeFor(context.agent)
                          : inferMode(resolvedAssembly.tools, view.managed)   // G1 退化判据
if (mode !== 'ptc') → 跳过（native 没有可裁的段；'both' 按 B4 inert）
const section = sections.find(s => s.name === 'tools:sdk')
if (!section || section.text === '') → 跳过
       ⚠️ 段**存在但文本为空**是常见情形（PTC 部署下的 native agent，`sdkSection` 对 native 返回 ''），
       此时 `render(full) !== ''` 会触发 premise-mismatch 白跑一遍 —— 必须先按空文本短路
const schemas = fullSdkSchemas(context.scope)   // ▼ 见下，公开优先 + 按 revision 缓存
const render = runtime.language === 'python' ? renderToolsSdkPy : renderToolsSdk
const { ok, text } = trimSdkText({ hostText: section.text, schemas, drop: D,
                                   render, programFormat: runtime.programFormat })
sections = sections.map(s => s === section ? { ...s, text: ok ? text : s.text } : s)
```

**`fullSdkSchemas(scope)` = 公开优先，按 revision 缓存**

```js
// 快路径（可选）：sdkSchemas 一次给全，≈15ms（701 工具）
// 公开路径（主）：schemas(scope) 给 name/description/parameters，
//                 逐工具 get(name, scope) 补 output.schema（≈278ms / 701 工具）
// 两者产出逐字节相同（F22）→ 缓存 key = revision，缓存值 = { schemas, fullText }
```

缓存的意义：`get()` 的 O(n²) **每个 revision 只付一次**，不是每次组装。

**注意**
- `sdkSchemas` 传 **`context.scope`**（与宿主 `sdkSection` 同参）。
- `programFormat` **有值才传**（G3）；Python 渲染器不接受第二参，多传也无害。
- 整个裁剪包在 try/catch 里：任何异常 → 用原文 + `warnOnce`。

### 3.3.1 handler 的新控制流（最容易出 bug 的地方）

现有 handler 是 `if (!view.deferring) { 摘引导; return }` 的单闸。改成：

```
agent === undefined              → 原样返回
mode === 'both'                  → 原样返回（inert，手册也别动）
!hasDeferredServers              → 摘引导段，返回
D.size === 0                     → 摘引导段，返回（全发现了：无目录、无需裁）
D.size > 0                       → 遮 assembly.tools（现状 filterManagedTools）
                                 + 遮指令段（现状 activeMaskedServers）
                                 + 追加目录段（按 D 过滤、带缓存）
                                 + 裁 SDK 手册（仅 mode==='ptc' 且 requireDiscovery）
```

**三条必须钉住的不变量**：
1. `D.size === 0` 时**既不加目录也不裁手册**（裁也没东西可裁），但**引导段必须摘**。
2. `mode === 'both'` 时**连引导段都不摘**（inert = 完全不管）。
3. `mode === 'ptc'` 时**必须走完整分支**——写错成"非 native 就 inert"会把 PTC 关掉。

### 3.4 恢复（C4 / F18–F20）

安装时若 `caps.projections`：

```js
disposeProjection = projections.register(discoveryProjection({ ... }))
```

`stateFor(agent)` 首次调用时：

```js
if (caps.projections) {
  const saved = projections.stateOf(agent.session, KEY)      // try/catch
  if (saved?.discovered?.length) seed(state, saved.discovered)
} else if (typeof agent.session?.deriveMessages === 'function') {
  seed(state, [...discoveredFromMessages(agent.session.deriveMessages())])   // 退回：native 有效
}
```

- 投影 **只当恢复种子**；运行期状态仍是 per-agent `WeakMap`（避免"一会话多 agent 共享"）。
- `lastUsed` 不持久化，恢复时按发现顺序播种（自愈，见 DECISIONS §8）。

### 3.5 使用记录 / LRU

- **唯一写入口**：现有 `ctx.tools.guard`。在 `guardDecision` 之前：
  ```js
  if (hasDeferredServers && discovered.has(execution.name)) touch(state, execution.name)
  ```
- guard 是全局的、每次执行都跑（含 PTC 嵌套派发，已实测），**不加新订阅**。
- 被拒的调用不记录（`discovered.has` 为假自然不记）。

### 3.6 搜索结果

```js
// 1) 没东西可搜 → 明确报错（B13）
if (!hasDeferredServers) throw new Error(
  'no MCP server is set to deferred loading in this session; all tools are already available — call them directly')

// 2) 命中后
state.discover(newNames)                       // B8
if (newNames.length > 0) {
  const removed = evict(state, resolved.maxDiscovered)   // B10：只在增长时淘汰
}

// 3) C1：非 native 时补签名
const lang = ctx.get?.('ptcRuntime')?.language
if (lang && caps.sdkSchemas) {
  const outputByName = new Map(safeSdkSchemas(agent).map(s => [s.name, s.output]))
  // 每个 match 追加 signature：TS `tools.x(args: A) => Promise<B>` / Py `async def x(args: A) -> B`
}
```

结果里 `matches[]` 的既有字段不动，只**追加** `signature`（可选字段）→ 向后兼容协议 v1。

### 3.7 装配判据（`lib/index.js`）

```js
const toolsMode = typeof ctx.tools?.modeFor === 'function' ? ctx.tools.modeFor() : 'native'
// 无条件安装；per-agent 行为在 runtime 里判（inert 只针对 'both'）
installToolSearchRuntime(ctx, { deferServers: ..., serverNames: ... })
```

> 当前是 `if (toolsMode === 'native')` 才装。改后 **native / ptc 都装**，`both` 由 runtime 判 inert。

---

## 4 · 分阶段实施（每阶段一个可独立验证的产物）

| 阶段 | 内容 | 产物 / 验证 |
|---|---|---|
| **S1** | `tool-search-host.js`：探测 + `warnOnce` + `chooseToolName`；接到安装流程 | 新 `test/tool-search-host.test.mjs` 6 条（含重名换名）；生产行为不变 |
| **S2** | `tool-search-state.js`：LRU + 播种 + `evict` + `foldEvent` + 投影定义 | 新 `test/tool-search-state.test.mjs`；`clampDiscovered` 改写并迁移旧用例 |
| **S3** | `tool-search-sdk.js`：`trimSdkText`（含前提自检） | 新 `test/tool-search-sdk.test.mjs`（含 `programFormat: 'repl'` 反证） |
| **S4** | runtime：`D` / 两个布尔 / 目录按 `D` + 缓存 / 引导按 `hasDeferredWork` | 改 `tool-search-runtime.test.mjs` 的相关断言；新增 `D = ∅` 不注入 |
| **S5** | runtime：装配按段名裁手册（§3.3） | 真宿主：PTC 手册不含未发现；native 手册不存在；`requireDiscovery` 门控 |
| **S6** | 装配判据 per-agent（§3.7）+ `both` inert | 真宿主三 agent 对照；改写 `tool-search-wiring.test.mjs:423` |
| **S6.5** | `viewFor(agent)` 按模式分流：`'both'` → `inertView()`（`managed` 为空 ⇒ 两个布尔都 false） | 用例：`both` agent 无目录/无引导/手册原样；**`ptc` agent 必须启用**（防把 inert 判据写成"非 native 就 inert"） |
| **S7** | 去门槛：删 `applyServerFloor` / `minServerTools`；改写 6 处断言；面板文案 | 12 工具服务器在真宿主里真的启用 |
| **S8** | `tool_search` 明确报错（B13）+ 搜索签名（C1）+ 恢复（C4） | 真宿主恢复用例（native + PTC 各一条） |
| **S9** | `peerDependencies` → `">=0.2.0-rc.1 <0.3.0"`；更新 DECISIONS/OPEN-ITEMS/design.md | `git status` 干净、全量绿、撤掉改动看红 |
| **S10** | 🆕 **真机 UI 验证**（F23 配方）：`DSH_HOME=<临时> dsh web --no-open --port 0`，从 stdout 抓 `http://127.0.0.1:<port>/?token=…`，用 chrome-devtools MCP 打开、点 preset 卡片、看面板文案 | 截图/断言：PTC 会话被真正启用；面板徽标与详情行说的是实话 |

**顺序理由**：S1–S3 是**纯新增、零行为变化**，先把基础设施和测试网搭好；
S4–S6 才动真实行为；S7 是破坏性最大的一项，放在裁剪链路稳定之后。

### 面板参数（C2）单独一轮

不放进本轮：它要新增**插件 Config**（现在压根没有）+ RPC + 表单 + i18n 两侧 + `i18n-parity`，
是独立一块。本轮只保证"门槛去掉后用户勾了就生效"。

**但 C2 的目标已上修**：原先写"做不到显示真实生效状态"，第三轮复核证明 **`ctx.agents.list()` 可用**（F21），
所以下一轮除了参数表单，还可以做"活跃会话中有多少在延迟"这类**真数据**。展示位需要产品决定。

---

## 5 · 测试清单

### 5.1 新增文件

| 文件 | 用例 |
|---|---|
| `test/tool-search-host.test.mjs` | ① 探测全有 → 全 true；② 去掉 `sdkSchemas` → false 且 `warnOnce` 只记一次；③ 去掉 `sessionProjections` → false；④ `chooseToolName` 首选可用 → 原名；⑤ 首选被占 → 次选 + 标记换名；⑥ 全被占 → 抛错 |
| `test/tool-search-sdk.test.mjs` | ① 正常裁剪：删掉的名字不在结果里、保留的在；② `premise-mismatch`（宿主原文被篡改）→ `ok:false`；③ `no-drop`；④ `render` 抛错 → `ok:false`；⑤ **`programFormat='repl'` 时自检失败**（证明参数被真转发）；⑥ Python 渲染器路径 |
| `test/tool-search-state.test.mjs` | ① `discover` 播种 tick；② `touch` 只刷新已发现；③ `evict` 公式（size21→踢1；size31→踢11；size100+cap20→50/25/20 三步）；④ 刚发现的一批不被淘汰；⑤ `foldEvent` 两种事件都识别；⑥ 无新名字时返回**同一引用**；⑦ 剪枝有界；⑧ `apply` 恒返回对象 |

### 5.2 改写（不是删）

| 位置 | 改成 |
|---|---|
| `test/tool-search-runtime.test.mjs:51`（`applyServerFloor`） | **删除该用例**（函数已删），换成"per-server 下限不存在：3 工具服务器也启用" |
| 同上 `:151-157` / `:162-164` / `:173-174` | `deferring` 语义改为 `hasDeferredServers`；`threshold` 边界用例删除 |
| 同上 `:241-251` | `resolveRuntimeConfig` 不再有 `threshold`/`minServerTools`；改成"传入已废弃键 → **显式报错**" |
| 同上 `:93-99`（`clampDiscovered`） | 迁到 state 用例；导出面保留一个薄包装或直接改名 |
| `test/tool-search-real-host.test.mjs:219` | `deferNothing` 时仍"无目录/无引导"，但改为断言 `hasDeferredWork === false` |
| `test/tool-search-wiring.test.mjs:423` | 改成"PTC 下**也**注册 `tool_search` 与守卫；手册里不含未发现的延迟工具" |

### 5.3 新增真宿主用例（`tool-search-real-host.test.mjs`）

1. **PTC 手册裁剪**：PTC agent → `tools:sdk` 不含未发现延迟工具；含 `tool_search`；已发现的在里面。
2. **native 对照**：同进程 native agent 的 `assembly.tools` 遮罩照旧。
3. **自检退原文**：把 `tools:sdk` 段文本改一个字符 → 断言插件退回原文而不是解析它。
4. **恢复（PTC）**：真程序里 `tool_search` → 新建同 session 的 agent（模拟恢复）→ 发现集被还原。
5. **恢复（native）**：真 agent-loop 写 `tool/result` 的路径（**注意**：直调 `tools.execute` 不写事件，
   要么用真 loop，要么显式 `session.append('tool/result', ...)` 并注明这是模拟宿主写入）。
6. **`D = ∅`**：全部发现后目录段与引导段都消失。
7. **报错判据**：无延迟服务器时 `tool_search` 报明确错误；全发现时**正常返回**。

---

## 6 · 反证清单（每条都要真跑）

| 撤掉什么 | 哪条必须红 |
|---|---|
| SDK 裁剪 | 5.3-1（PTC 手册含未发现工具） |
| 前提自检 | 5.3-3（被篡改的段仍被裁） |
| `programFormat` 转发 | 5.1-sdk-⑤ |
| `D` 过滤目录 | 5.3-6（`D=∅` 仍出现目录） |
| `evict` 的一半上限 | 5.2-state-③ 的大规模场景 |
| `discover` 播种 | 5.2-state-④（刚发现的被淘汰） |
| 投影 `apply` | 5.3-4（PTC 恢复为空） |
| 能力探测 | 5.1-host-②⑥ |
| 重名换名 | 5.1-host-⑤ |

---

## 7 · 明确不做

- **不为 0.1.x 写任何兼容分支**（用户已定，只支持 0.2.x）。
- **不做面板参数表单**（C2，下一轮）——**但"显示真实生效状态"已确认可做**（F21），不再算"做不到"。
- **不解析官方生成物**（有导出渲染器就用它；前提自检失败就退原文）。
- **不扫会话日志**（`eventAt`/`snapshotEvents`/`ownEvents` 全部 `@deprecated`）。
- **不使用 `deferLoading`**（那是动态工具增减的机制，单设会让工具永久不可用，见 DECISIONS §10.3）。
- **不为 `both` 新增行为**（技术可行，但 0.2.1 已删该模式——为将死功能写代码不划算）。
- **不依赖任何 private API 才能工作**：`modeFor` 有公开退化判据、`sdkSchemas` 已降级为快路径。

---

## 8 · 风险与回滚

| 风险 | 兜底 |
|---|---|
| 宿主改了渲染器/段名 | 前提自检或段名查找失败 → **用原文**（最坏 = 今天） |
| `sdkSchemas` 被改名 | G1 探测失败 → 不裁（最坏 = 今天） |
| 投影状态膨胀 | 剪枝到 `max(maxDiscovered*4, 100)` |
| 目录文本缓存 bug | 缓存只影响"显示"，索引不受影响 → 最坏是目录列少/多一行，不影响可搜索性 |
| 装配改成无条件后 PTC 反而更糟 | 裁剪失败即退原文；且 S6 有 native 对照用例守回归 |

**回滚粒度**：每一阶段是独立的 commit 边界；S5（裁手册）与 S6（per-agent）任一可单独 revert 而不影响其余。
