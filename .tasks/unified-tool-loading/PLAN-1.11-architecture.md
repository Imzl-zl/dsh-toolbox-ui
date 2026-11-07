# v1.10.0 架构审查与改造方案

- 审查对象：`dsh-toolbox-ui` v1.10.0（`cb02d6e..8dc9ab3`）
- 参照系：宿主源码 `D:\sudy\github\deepseek-harness`（`@deepseek-ai/dsh-root@0.2.2-rc.1`）
- 结论摘要：**形状是对的，边界定义含糊，有一条隐含不变量没写进契约。**

---

## 一、先回答"这是哪一层的问题"

不是单一层。14 条问题里：

| 层级 | 条目 | 判断依据 |
|---|---|---|
| **架构（模型/边界）** | 4 条 | 插件的模型与宿主的模型在某一处没有对齐，不是写错代码 |
| **代码设计（职责/结构）** | 6 条 | 同一概念有两处实现或两个真源 |
| **细节** | 4 条 | 拼写、重复键、过时文档、测试计数 |

其中真正影响正确性的是**架构层的第 1 条**（组合 API 的实例身份）与**设计层的"两套事务入口"**。
其余是精度问题。

---

## 二、参照系：宿主源码给出的三条"应该长什么样"

方案不是凭空设计的，下面三条来自宿主自己的实现。

### 2.1 配置事务的参照实现：`configEditor.edit()`

`packages/boot/config-editor/src/index.ts:87-153`：

```
withFileLock(profile/package.json)          // :93  与插件同一把锁
  reconcileProfilePatches(root, 当前盘上, 'dsh')   // :96  **写之前先让运行中收敛到盘上**
  计算 next
  isDeepStrictEqual(有效组合.config, next) ? : throw  // :137-140 **整个 config 深比较**
  writeFileAtomic                            // :141
  reconcileProfilePatches(root, patches, 'dsh', [entryId])  // :143 requiredIds
  catch → 回写 before + reconcile(beforePatches) 再抛     // :144-148 回滚
```

插件 `lib/profile-composition.js` 的 `commitProfilePatches` 是这套流程的**忠实移植**：
锁序一致、写前判定、requiredIds、失败回滚都对应得上。**这是 v1.10.0 最大的对的地方。**

但它比官方**少了一步**：官方校验的是"有效组合里的 config 是否等于我打算写的那份"，
插件只校验"条目还在不在、disabled 对不对"。见 §4.2。

### 2.2 模式判据的参照：`ToolExecutor.inject`

- PTC executor：`packages/core/tool-executor-ptc/src/index.ts:105` → `inject = ['tools','systemPrompt','ptcRuntime']`
- native executor：`packages/core/tool-executor-native/src/index.ts:27` → `inject = ['tools']`

**executor 的选择是 per-scope 的**：`tools.setExecutor()` 按当前作用域登记
（`tools/src/index.ts:325-350`），`Config.mode` 已改成 `z.never()` 并注明
"Mount a native or PTC tool executor instead"（`:101-104`）。
注意：`ptcRuntime` **不能**当作作用域的判据——它对所有作用域都可见（§八 8.6 实测）。
0.2.2 没有公开的"这个作用域选了哪个 executor"查询口，这是 `modeFor` 被删除后留下的空缺。

### 2.3 声明与手册同源的参照：`SystemPrompt.tools / assemble`

- `PromptAssembly.tools: ToolSchema[]`（`system-prompt/src/index.ts:132-134`）是**模型看到的声明**；
- executor 的 `describe()` 决定它长什么样（native 全量 / PTC 塌缩成 `run_code`）；
- executor 还能注册自己的 prompt section（`tools/src/index.ts:332-341`），PTC 的 `tools:sdk` 手册就是这么来的。

两者同源：都由**同一个 executor** 从**同一份 definitions** 生成。插件在 `execute` 里拿不到
assembly，也没有可用的 per-scope 模式查询口——所以模式只能在装配时判定并记录（§八 8.6）。

---

## 三、逐项归因

### 架构层

**A1. 组合 API 的"实例身份"问题（含已修的 E）**

- 现象：`lib/profile-composition.js:56-135`。插件通过 `loader.import('@deepseek-ai/dsh-app-boot')`
  取组合 API，再用 `probeComposition` 跑一次真 reconcile 来证明"拿到的是宿主那一份模块实例"。
- 宿主侧事实：`bootstrapIncludes` 是模块私有 `WeakMap<Context, Entry>`
  （`app-boot/src/index.ts:259,334`），**没有任何公开访问器**；`mountRootInclude` 只把 root include
  以 `id: 'include'`、`name: 'cordis:include'` 挂进 loader（`app-boot:774-783`）。
- 官方为什么不用探测：`config-editor` **直接 import** app-boot（`:10`），运行在同一个模块图里，
  永远拿到同一份 WeakMap。插件是外部包，跨模块图，才有这个问题。
- 判断：**这是宿主 API 边界的缺口，不是插件的疏忽。** 插件用探测补偿是合理选择，
  代价是"探测即一次真 reconcile"，而探测时机变成了语义的一部分。

**A2. 结果契约没有消费者（含已确认的 A）**

- `persisted / live / diagnostics` 是插件自创的契约（宿主没有对应概念，`configEditor.edit` 返回 `void`，
  失败靠抛错）。
- 自创契约就必须有消费者，否则它只是注释。当前客户端 0 引用，
  发布说明却按"面板会显示"来写。
- 判断：**契约设计与交付物脱节**，属于架构层的完成度问题，不是拼写错误。

**A3. 自己那条配置行没有复用宿主的事务能力**

- `toolSearch` / `toolLoading` 写在插件自己的 config 行里（`lib/tool-search-settings.js:256-302`），
  写入走 `writePatch` 直写。
- 宿主其实提供了 `configEditor.edit(entry, change)`（base bundle 默认挂载：
  `packages/bundle/base/cordis.patch.yml: - id: config-editor`），它自带覆盖检测、写盘、requiredIds
  reconcile 与回滚。
- 但它是给"编辑插件自己的 config 行 → 宿主按行生命周期重载该插件"设计的。**已实测确认（§八）**：
  改同一行的 `config` 再 reconcile，插件会被 dispose + 重新 apply（apply 1→2、dispose 0→1）。
  所以它不适合 ToolSearch 这类**活值**的写入口——每次保存会把整个插件重载一遍。
- 判断：**不直接复用**；复用它的**流程**与判据（见 §5 P1-2、P1-3）。

**A4. 两个真相源（延迟状态）**

- 芯片读 `deferEffective ?? defer`（`50-mcp-panels.js:156`），切换方向读 `defer`
  （`70-shell.js:333`），计数读 `defer`（`50-mcp-panels.js:55`）。
- 宿主侧 `defer` 是插件自有字段，`deferEffective` 是"策略算完之后的有效值"——后者才是模型看到的事实。
- 判断：**投影层（effective）与配置层（raw）混用**，属架构层的"哪一层是真相"没定清楚。

### 代码设计层

**D1. 两套事务入口并存**

`commitProfilePatches` 是 v1.10.0 立的"唯一入口"，但 `updateToolSearchSettings` /
`updateToolLoadingSettings`（`lib/index.js:1711-1875`）仍直接 `writePatch`。
后果：无覆盖检测、无回滚、失败抛普通 `Error`（返回形状与其它变更 RPC 不一致）。
这正是它自己注释里批评过的"同一件事两个实现"。

**D2. 模式判定与执行上下文不匹配（含已确认的 F）**

`modeOf`（`tool-search-runtime.js:803-811`）在 `caps.modeFor === false` 时退回
`inferMode(assemblyTools)`；而 `execute` 调 `viewFor(exec.agent, undefined, exec.toolSet)`
（`:1059`）传的 `assemblyTools` 是 `undefined` ⇒ 恒判 `native` ⇒ 签名分支短路（`:1091`），
但能力面照报 `ready`（`:1235-1238`）。同一概念，组装路径有 assembly 可看，执行路径没有，
却仍然复用了同一个判据函数。

**D3. 探测与"解析"耦合在一个函数里（这是 E 的根）**

`profileSources()` 同时承担两件事：**取得模块** 和 **证明实例**。而证明需要执行，执行有副作用。
拆开之后很多问题自然消失（见 §5 P1-1）。

**D4. `checkComposedRow` 的判据比官方松**

见 §4.2。

**D5. `restoreFrom` 的注释与代码不符（行为正确）**

`tool-search-state.js:358` 的 init 带 `protocol: META_PROTOCOL_V2`，使
`tool-search-runtime.js:788` 的 `explicitEmpty` 恒真，`:791` 的 `deriveMessages` 退路对 **init 状态**不可达。
但这不是缺陷：宿主在 `ver` 不匹配时丢弃缓存行并从头折叠（见 §八 8.5），init 出现时确实没有可派生的事件。
**需要改的是注释**——`tool-search-runtime.js:782-783` 声称"init 状态退回派生消息"，与代码不符。

**D6. 宿主 warnings 被丢弃**

`applyPatches`（`profile-composition.js:200-207`）不接 `reconcileProfilePatches` 的返回值
（它返回 `warnings`，`app-boot:320-324`），成功路径 `diagnostics` 恒空。

### 细节层

**T1.** `20-locale.js` 9 处重复键。
**T2.** `test/helpers/*.mjs` 被 `node --test` 当测试执行（3 条假测试，970 计数虚高）。
**T3.** 注释/命名：`efreshSkillCatalog`、悬空 JSDoc、`verifyLive` 文档过度承诺。
**T4.** 文档过时：README 页面名与 UI 不符、`PROGRESS.md` 的 895/未提交。

---

## 四、逻辑语义判断

### 4.1 事务语义：形状对，但有一条隐含不变量

`commitProfilePatches` 的失败分型（写盘失败 / 生效失败 / 回滚失败）是清楚的，
诊断码也分得开。**问题是"探测必须在写盘之前"这条不变量没有写进任何注释或类型**，
而它决定回滚会不会发生：

`recompose` 用 `previousFailures` 做基线（`app-boot:337-341`），
`introduced = failures.filter(f => !previousFailures.some(same))`（`:398-406`）。
探测若在写盘之后运行，会先用新内容 reconcile 一次，把故障记进基线；
随后真正的 reconcile 就判不出"新引入"，**不抛错、不回滚**。

> 这是本轮真实踩到的坑：第一版修复把 `profileSources` 移到写盘之后，三条回滚用例全红。

结论：这条不变量应当**显式写进 JSDoc 与测试名**，而不是靠下一个人不去动它。

### 4.2 覆盖判定：语义偏松（新发现）

官方判据（`config-editor:137-140`）：

```ts
const effective = flatten(composeEntries([patches])).find(row => row.id === entry.options.id)
if (!isDeepStrictEqual(effective?.config ?? {}, next)) throw new Error('... overridden by a home patch or command-line overlay')
```

插件判据（`profile-composition.js:167-178`）：只检查 `row !== undefined` 与 `row.disabled` 是否符合预期。

后果：home patch 覆盖了同一个条目的**其它字段**（`env`、`args`、`headers`），
条目仍在、`disabled` 仍对 ⇒ 插件判"算数"，实际运行的是被覆盖后的配置。
官方会在这里抛错。

判断：**这是"写盘成功但行为不是用户要的"的同类问题，只是范围更窄。**

### 4.3 `persisted` 枚举的语义错位

`profile-composition.js:285,331`：`persisted: changed ? 'rolled-back' : 'failed'`。
内容没变（`changed === false`）时一个字节都没写，却报 `failed`。
`failed` 的语义是"写过但失败／写不动"；没写过应当报 `unchanged`。

实测：内容未变 + live 失败 ⇒ `persisted: "failed"`，实际写盘 0 次。

### 4.4 探测的 catch 过宽

`profile-composition.js:132-134` 把**任何**非 `root Include entry` 的错误都判成"实例正确"。
真实故障不会消失（后续 reconcile 会再抛），但错误归属被推迟，诊断信息可能指错方向。

### 4.5 双真源的语义后果

策略把某台服务器算成 `deferred`、而 patch 里 `defer: false` 时：
点芯片发 `setDefer(true)` ⇒ 芯片（读 effective）不动 ⇒ 提示成功。
用户看到的是"点了没反应"。这是语义不一致最典型的表现形态。

### 4.6 已证伪的一条

"PTC 会被误判成 `both`" —— 不成立。真 0.2.2 + 真 PTC executor 下
`assembly.tools === ['run_code']`，`inferMode` 返回 `'ptc'`。延迟未失效。

---

## 五、改造方案

### 目标形态（三条原则）

1. **事实只有一个出口**：服务端算出的 `persisted/live` 必须有客户端消费者，或者删掉这套契约。
2. **一个概念一个判据**：模式只在装配时判定一次、执行时读记录（**不是**用 `ptcRuntime`，见 §八 8.6）；
   延迟只认 effective 值；事务只走一个入口。
3. **副作用要么被需要，要么不发生**：解析组合 API 不等于验证它；验证必须发生在它该发生的地方。

---

### P0 —— 兑现发布承诺（不改架构）

| # | 改动 | 位置 | 验证 |
|---|---|---|---|
| P0-1 | 客户端按 `persisted × live` 分支展示 | `70-shell.js:311-329,436-441`、`90-contribution.js:338,349` | 新增面板用例：`live:'skipped'` 必须显示"重启后生效"，不得显示"已保存" |
| P0-2 | 目录上限输入框恢复"置灰保留" | `60-tool-loading.js:312` | 恢复 v1.9.0 断言（3 个输入框都在、`disabled === true`、保存不发该键） |
| P0-3 | 延迟芯片统一读 effective | `50-mcp-panels.js:55,156`、`70-shell.js:333` | 策略延迟 + `defer:false` 时点芯片必须真的翻转 |
| P0-4 | 签名判据改为「执行时读装配记录」 | `tool-search-runtime.js:1059,1091` | 现代宿主 PTC 用例：结果必须带 `signature`；**混合作用域用例**（root PTC + agent native）不得误加签名 |

P0-4 的具体做法（**已按实测修正**，见 §八 8.6）：`ptcRuntime` 对**所有作用域**都可见，
拿它判模式会在"root 挂 PTC、agent 作用域挂 native"的部署里把 native 会话误判成 PTC。
正确做法是——模式**只在装配时有事实可依**（`assembly.tools`），把算出的 `mode` 按 agent 记下来，
`execute` 读这份记录；没有记录（从未装配过）时按 `native` 处理并记一条诊断。
`inferMode` 只保留给装配路径。

---

### P1 —— 收敛事务语义（真正的架构改造）

**P1-1 拆分 `profileSources`：解析 ≠ 验证**

```
compositionApi(ctx)        // 只取模块。纯函数（readProfilePatches / composeEntries / loadProfileDirectory）安全
verifiedComposition(ctx)   // 取模块 + 探测。**必须在写盘之前调用**（见 §4.1）
```

- `commitProfilePatches` 的非 applyLive 路径：用 `verifiedComposition`（行为不变）。
- applyLive 路径：用 `compositionApi`，因此**既没有副作用、又能跑覆盖判定**（`composeEntries` 是纯函数，
  拿错实例也照样算对；只有 `reconcileProfilePatches` 依赖那个 WeakMap）。
- 探测的 catch 收窄：只把 `root Include entry` 判为"实例不对"，其余错误原样抛出并标注
  `PROFILE_API_UNAVAILABLE`，不再静默当作"实例正确"。

**P1-2 设置写入并入唯一入口**

`updateToolSearchSettings` / `updateToolLoadingSettings` 改为 `commitProfilePatches` +
`applyLive`（重装运行时）+ `entryId = pluginPatchIdentity().id` + `expect`。
收益：覆盖检测、`persisted` 语义、失败形状三处自动对齐，删掉一份写盘实现。
注意：`applyLive` 路径过去不跑覆盖判定，P1-1 之后才会跑。

**P1-3 `checkComposedRow` 对齐官方深度**

把"条目在不在 + disabled"升级为"有效 config 与期望 config 深比较"，
参照 `config-editor:137-140`。期望值取 `toMcpClientConfig(normalized)`（插件已有该函数）。
失败信息沿用官方措辞："被更高层配置覆盖"。

**P1-4 `persisted` 语义订正**

`changed === false` 时一律 `unchanged`，包括 live 失败的场合；
`failed` 只留给"写盘动作本身失败"。

**P1-5 warnings 进 diagnostics**

`applyPatches` 接收 `reconcileProfilePatches` 的返回值，映射成
`{ code: 'RECONCILE_WARNING', message }` 放进 `diagnostics`。

---

### P2 —— 清理与防回归

| # | 改动 | 说明 |
|---|---|---|
| P2-1 | `restoreFrom` 的注释与退路 | **已查清（§八 8.5）**：宿主按 `ver` 丢弃不匹配的缓存行并**从头折叠**，所以升级不会丢发现集；`init` 出现时确实没有可派生的事件。行为正确，**只需删掉那段声称"init 会退回派生消息"的注释**（或把退路收窄为"投影缺席"这一种） |
| P2-2 | 契约测试补强 | **不是契约变更**（§八 8.9：28 个变更方法全部合规）。只需把 `assertResult` 从"值在枚举内"改成断言具体值，并给 `persisted: 'failed' → unchanged` 的语义订正补一条用例 |
| P2-3 | locale 去重 + helpers 移出 `test/` | 计数口径统一（`test/*.test.mjs`） |
| P2-4 | `.gitattributes`：`*.js text eol=lf` | 现在 blob 干净，但没有防护 |
| P2-5 | 文档同步 | README 页面名/选项名、`verifyLive` 的真实断言范围、`PROGRESS.md` |
| P2-6 | `BUILTIN_LABELS` 走 `t()`，删掉非 builtin 的死条目 | `60-tool-loading.js:40-98` |

---

### 明确不做

- **不改用 `configEditor.edit` 写 ToolSearch 设置。** 已实测：它最后一步的
  `reconcileProfilePatches` 会因为该行 `config` 变化而把插件 dispose 再 apply（§八）。
  活值不值得付一次整套插件重载。
- **不把探测换成"比对已应用 patches"**。`bootstrapIncludes` 无公开访问器，
  比对 `entry.options.config.patches` 需要重新 prepare，误判风险高于收益。
- **不给 `inferMode` 打补丁去猜执行路径的模式**。执行路径没有形状可推断，也没有公开的
  per-scope executor 查询口；正确做法是装配时记下、执行时读回（§八 8.6）。

---

## 六、上溯到宿主的改进建议（可选，非本插件可解）

1. **`app-boot` 应暴露实例判据**，例如 `hasBootstrapInclude(ctx): boolean` 或
   `bootstrapIncludeOf(ctx): Entry | undefined`。有了它，插件的 `probeComposition` 可以整体删除，
   E 那条副作用从根上消失。
2. `bootstrapIncludes` 用 `WeakMap` 是私有实现在先、公开 API 缺失在后；
   官方编辑器因为同图所以没暴露需求，外部插件则被迫探测——这是生态边界的空缺。

---

## 七、验证矩阵与完成标准

| 阶段 | 必须绿的 | 额外证据 |
|---|---|---|
| P0 | 全量（rc.5）+ 现代腿（rc.1） | 每条新增用例先红后绿；面板用例覆盖 `skipped` 分支 |
| P1 | 全量 + 现代腿 + `contract:check` | 覆盖判定用真 home patch 覆盖一次（当前只有桩）；回滚的二次失败分支至少一条 |
| P2 | 全量 | 计数口径与文档一致 |

完成标准（我建议写进 SPEC）：
1. 任何变更型 RPC 的 `persisted/live` 都有客户端可见的表现，或该字段被删除；
2. `commitProfilePatches` 是 profile 写入的**唯一**调用点（`grep writePatch` 只剩它内部）；
3. 模式判定只有一个来源（装配时算的那一次，执行时读记录）；
4. 延迟状态只有一个来源（effective）。

---

## 八、实测记录（不再有"需确认"）

环境：隔离树 `D:/tmp/dsh-matrix-rc1`（0.2.2-rc.1，另装 `@deepseek-ai/dsh-config-editor@0.2.2-rc.1`），
真 `cordis` Context + 真 Loader + 官方 `mountRootInclude`，夹具插件自报 apply/dispose。

### 8.1 改配置行会不会重载插件 —— **会**

| 步骤 | 结果 |
|---|---|
| 初始挂载 | `applies = [{value:1}]`，`disposes = 0` |
| 把该行 `config.value` 改成 2 后 `reconcileProfilePatches` | `applies` 1→2、`disposes` 0→1 |
| 重载后收到的配置 | `{value:2}` |

即：**行 config 变化 ⇒ 该行 fiber 被 dispose 再 apply。** `configEditor.edit()` 的最后一步正是这个
reconcile（`config-editor/src/index.ts:141-143`），所以采用它写 ToolSearch 设置会让整个插件重载。

### 8.2 `fiber.resolveConfig` 本身不重载

`cordis/lib/fiber.d.ts`：只做候选校验——"Does not publish the result, replace raw input, or commit
running volatile references"；实现 `resolveConfig(runtime, config)` 仅跑 runtime schema 校验。
**重载来自写盘后的 reconcile，不是来自 `resolveConfig`。** 这一条纠正了方案前稿的猜测方向。

### 8.3 官方 `configEditor.edit` 在裸夹具里走不通 —— 是夹具限制，不是编辑器缺陷

- 现象：抛 `Configuration for "probe-row" is overridden by a home patch or command-line overlay`。
- 原因：`composeEntries` 从空树开始应用补丁，**id 覆盖行只有在基座已有该 id 时才生效**。
  实测：`composeEntries([覆盖层])` → `[]`；`composeEntries([基座层, 覆盖层])` → 正确合并。
- 我原先的夹具只有 profile patch、没有 bundle layers（`loadProfileDirectory(...).layers = 0`），
  覆盖行无处附着，于是 `effective.config` 为 `undefined`，判定必然失败。
- 结论：**不能据此说编辑器有问题**；真实 profile 有基座层，路径是通的。但这也说明
  §4.2 那条"整个 config 深比较"确实是官方判据，值得插件对齐。

### 8.4 对方案的修正

- A3：从"需实测"改为"已实测，不采用"。
- §5「明确不做」第一条：理由由猜测改为数据。
- P1-1 的拆分更有必要：插件必须自己写盘（不能用编辑器），于是纯校验（`composeEntries`）
  与验证（`reconcile`）更需要解耦。

### 8.5 投影的 `stateVersion` 升级会不会丢发现集 —— **不会**

- 宿主契约定死写在 `session-projection-cache/src/index.ts:10-14`：
  "The cache is a fold shortcut, never an authority… **a `ver` mismatch discards the row instead of
  migrating it**."
- 插件投影是真 fold（`tool-search-state.js:359` → `foldEvent`），`stateVersion: 2` 的正确性
  `:360-361` 的注释已写明。
- 推论：升级后旧缓存行被丢弃、从 seq 0 重放事件重建 ⇒ `discovered` 恢复；`init` 只在
  "这份会话一条相关事件都没有"时被观察到，此时 `[]` 就是正确答案。
- 因此 I 条（`restoreFrom` 退路成死代码）**不是数据丢失，是注释过期**。
  需要改的是 `tool-search-runtime.js:782-783` 那段话，不是逻辑。

### 8.6 `ptcRuntime` 能不能判模式 —— **不能（我原方案错，已改）**

夹具：root 挂 PTC executor 并 provide `ptcRuntime`；另建一个 agent 作用域，在**该作用域**挂
native executor（`tools.setExecutor` 是 per-scope 的）。

| 作用域 | `assembly.tools` | 有 `tools:sdk` 手册 | `agent.ctx.get('ptcRuntime')` |
|---|---|---|---|
| a-ptc（root） | `["run_code"]` | 是 | 有值 |
| a-native（作用域挂 native） | `["mcp__x__alpha","mcp__x__beta"]` | 否 | **有值** |

`ptcRuntime` 对两个作用域都可见 ⇒ **它不能区分 executor 选择**。拿它当判据，会把 native 会话
误判成 PTC（给原生调用附加"返回类型"签名，是噪声）。
⇒ 方案改为"装配时判定、执行时读记录"。这条如果不验，就是把"漏签名"换成"误加签名"。

同一张表也证明**新判据是可靠的**：`assembly.tools`（`['run_code']` vs 全量清单）与
`tools:sdk` 手册的有无，两个作用域都判对了。所以"装配时算一次、按 agent 记下来"有事实依据，
缺的只是把它接到 `execute`。

### 8.7 组合后的 row.config 能否与 `toMcpClientConfig` 深比较 —— **能**

同一份 patch 里放 `mcp-manager-ui`（插件自己的行）与一条 stdio MCP 行，组合后逐字段比对：

| 侧 | 值 |
|---|---|
| `composedRow(...).config` | `{transport, serverName, command, args, env}` |
| `toMcpClientConfig(spec)` | `{serverName, transport, command, args, env}` |
| 字段差异 | **无**（仅键顺序不同） |

⇒ P1-3 的深比较不会因为宿主注入默认值而误报（至少对这个形状成立）。
仍建议比较前归一化（排序键），避免 `JSON.stringify` 的键序陷阱。

### 8.8 插件自己的行有没有稳定 id —— **有**

- 出货 `cordis.patch.yml`：`- insert: [{ id: mcp-manager-ui, name: dsh-toolbox-ui }]`
- 实跑 `pluginPatchIdentity()` → `{"name":"dsh-toolbox-ui","id":"mcp-manager-ui"}`
- `composedRow(api, patches, 'mcp-manager-ui')` 在真实组合里**能定位**，config 与盘上一致。

⇒ P1-2 用 `pluginPatchIdentity().id` 做覆盖检测是可行的，bundle 形态下 id 不会为空。
（仍需处理"读不到自己那条 insert"的降级：那时如实报 `skipped` + 原因，不假装检查过。）

### 8.9 变更型 RPC 的三字段契约是否被违反 —— **没有，28 个全部合规**

| 结论 | 依据 |
|---|---|
| 技能 6 个变更方法 | 5 个直接 `return mutationResult(...)`；`setEnabled` 等薄封装同样经过它 |
| workspace 8 个 | `updateWorkspaceServer` / `setWorkspaceExclude` 在方法**末尾**返回 `mutationResult`；`importWorkspaceJson` 走 `applyWorkspaceImport` |
| 委托型 | `enable`/`disable` → `setDisabled`；`importJson` → `applyManagedImport`；`setDefer*` → `applyGlobalDefer`/`applyProjectDefer`，均继承三字段 |

**订正**：早前"workspace 8 个 + skills 6 个都没返回"是误判——那次 grep 打在了
`lib/workspace-runtime.js`，而实现其实在 `lib/index.js`。契约是合规的，
缺的只是**测试断言太弱**（`assertResult` 只验枚举成员）。
⇒ P2-2 从"契约变更（需产品决策）"降级为"补强测试"。

## 九、执行状态（2026-11-07）

| 项 | 状态 | 证据 |
|---|---|---|
| P0-1 面板消费 persisted/live | 完成 | `resultMessage`/`resultTone` 唯一出口；设置面板透传宿主 note；新增契约断言 |
| P0-2 目录上限置灰保留 | 完成 | 常量 `CATALOG_CHARS_SUGGESTION`；恢复"3 个输入框 + disabled"断言 |
| P0-3 延迟芯片单一真相源 | 完成 | 显示/切换/计数同读 `deferEffective`；服务端 `DEFER_GOVERNED_BY_POLICY` 如实报告（红→绿验证） |
| P0-4 模式判据改装配记录 | 完成 | `assembledMode` WeakMap；PTC 必带签名 + 混合作用域不得误加签名两条现代腿用例 |
| P1-1 解析/验证拆分 | 完成 | `compositionApi` / `profileSources` 分开；探测 catch 收窄并留证 |
| P1-2 设置写入并入唯一入口 | 完成 | 两个设置 RPC 走 `commitPatch`；`composedRowVisible` 门控避免极简 profile 假失败 |
| P1-3 覆盖判定对齐官方 | 完成（含一处有意的例外） | `checkComposedRow` 支持整份 config 深比较（键序无关）；`add` / `update` 已接线；**含 `${…}` 表达式的行跳过这一半**——`toMcpClientConfig()` 会把表达式求值成当时字符串，而组合结果保留 `{__jsExpr}`，两者不同形，硬比会把正常保存判成失败（已实测，`containsExpressionValue` 带注释说明）。真 home patch 覆盖的端到端用例已补（此前只有桩） |
| P1-4 persisted 语义 | 完成 | 两条路径都改为 `changed ? 'rolled-back' : 'unchanged'`，单测覆盖 |
| P1-5 warnings 进 diagnostics | 完成 | `applyPatches` 返回 warnings → `RECONCILE_WARNING` 诊断 |
| P2 清理 | 完成（除发布说明） | 注释订正、`assertResult` 具体值、locale 去重（9 处）、helpers 移出 `test/`（假测试消失）、`.gitattributes`、README/whats-new/PROGRESS/design 同步 |

**两腿结果**（2026-11-07）：

| 腿 | tests | pass | fail | skipped |
|---|---|---|---|---|
| 0.2.1-rc.5（本树） | 978 | 971 | 0 | 7 |
| 0.2.2-rc.1（隔离树） | 978 | 946 | 0 | 32 |

计数较开工前的 970 变化说明：+8 条新用例，−3 条 `test/helpers` 假测试（移出 `test/` 后不再被当作测试文件）。

## 附：本轮已完成

- C（`update()` 只改 `disabled` 不生效）与 E（探测热应用外部改动）已修复，
  各带一条真宿主回归用例，先红后绿。
- 验证：rc.5 腿 972 例 967 pass / 0 fail / 5 skip；rc.1 腿 940 pass / 0 fail / 32 skip。
- 修复细节与踩坑记录见 `REVIEW-1.10.0.md` §六。

