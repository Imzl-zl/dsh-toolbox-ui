# dsh-toolbox-ui 架构改造方案（复查修订版）

> 2026-11-06。范围：当前 feature/unified-tool-loading 工作树；目标是同一插件版本支持 DSH 0.2.1-rc.5 与 0.2.2-rc.1。
> 本文取代上一版方案。已补充官方源码、npm 最新包、当前桌面版本及独立 DSH 进程的真实模型验证；没有修改工作树实现、测试、依赖、lockfile、官方源码或真实 profile。详细过程与证据见 [隔离实测记录](<LIVE-VALIDATION.md>)。
> **发布约定：同一分支逐步完成，全部验收通过后一次发布。下文顺序是开发依赖，不是拆开发版，也不要求用户逐步确认。**

## 1. 复查结论及撤回的设计

上一版不能原样实施。最大的错误是把“能隐藏工具”当成“能保持工具调用语义”：`restrict` 是宿主执行准入的一部分，不能充当纯展示开关。

| 原方案 | 本次证据 | 修订 |
|---|---|---|
| 两代统一 restrict，项目工具发现前不注册 | 两代 PTC 在程序启动时固定绑定；被 restrict 的工具，搜索后仍没有绑定。0.2.2 的 toolSet 也不会扩充 | **保留注册和宿主准入，只裁剪模型声明及 SDK** |
| 搜索目录从全局定义补回隐藏工具 | 全局定义包含 when=false 工具；全局与 agent 的同名定义也可能不同 | 目录只来自调用 agent 的有效准入视图 |
| LRU 淘汰立即 restrict/撤销投射 | 已通过 guard、尚未进入工具体的调用，随后会变 UNKNOWN_TOOL；同定义重注册也不能恢复旧 toolSet | LRU 只调整后续呈现，不撤销注册或修改权限 |
| 用 JSON key 就能防 tools/change 重入 | 两代同步重入探针均出现 8 层递归；释放唯一记录的句柄后仍残留限制 | 展示层不再创建 restrict；真正的 exclude 协调单独保留，调度器防重入 |
| 将单个 patch 文件的 rows 传给 reconcile | 真实 Include 组合：完整层得到两个条目，只传 override 得到空列表 | 必须使用启动 profileContext 组合出的完整、有序 patch 列表 |
| 策略迁到新文件，保留旧字段即可安全降级 | v1.9.0 的真实 schema 拒绝 toolLoading；保留该键仍不能降级 | 保留现有存储，不为回退旧插件引入新存储体系；明确兼容边界 |
| 发现集快照直接保存 LRU/promised 就能原样恢复 | 当前 fold 不读事件 data.meta，忽略空快照，序列化还按名字排序 | 明确事件协议；活动状态与持久恢复种子分开 |
| 方法名/类型码表能保证全部 RPC schema 一致 | 当前大量 codec 是 unknown/identity，表里没有字段约束 | 明确方法清单同源与字段校验同源各自的责任 |

**最终方向：一套策略、检索、发现状态和管理用例；一个组装呈现边界，两代窄适配；全局 profile 与项目配置各保留符合其载体的生效方式。** 当前 0.2.2-rc.1 用请求头记录前的呈现兼容层，保留标准 preset 和 executor；将来宿主提供正式呈现 filter 后，在同一端口替换兼容实现。无需先重写每个 preset，也不依赖先发布一个修改版宿主。

2026-11-06 实测版本：npm latest/next、已安装桌面及隔离运行宿主均为 **0.2.2-rc.1**；本地官方 master 为 `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`。官方源码、发布包与当前使用版本分别核对，不再因项目开发依赖仍 pin rc.5 就误认为用户没有升级。

## 2. 先定义清楚逻辑语义

### 2.1 准入、发现与呈现集合

对 agent 的一个 step 定义：

- `A`：宿主允许该 step 使用的工具。0.2.2 来自原始 `toolSet.view(agent)`；包括 scope 覆盖、限制、when 条件及注册身份检查。插件无权扩大这个集合。
- `D`：本插件记录的已发现工具。
- `M`：对 `A` 应用加载策略后得到的延迟工具。
- `V = A − (M − D)`：本次向模型展示完整声明/SDK 的工具；目录与搜索候选来自 `M`。

PTC 的传输工具 `run_code` 单独由官方 executor 描述；上面的 `V` 指它所访问的能力工具，而非把 run_code 从 A 中猜出来。

**必须保持的区别：PTC 的 SDK 文本使用 V，程序可绑定的工具仍使用 A。** 未发现的工具由 ToolSearch guard 给出搜索指引；它们仍然保持宿主原始注册和准入，搜索成功后可以在同一个程序内调用。`when=false` 或被真正权限限制的工具始终不进入目录、搜索结果或调用路径。

### 2.2 必须成立的不变量

| 不变量 | 归属 |
|---|---|
| ToolSearch 不修改宿主准入、真实权限、scope 覆盖或工具注册身份 | host/tools 适配 + SearchService |
| 声明、SDK、目录、搜索结果与 guard 使用同一份策略及同一 agent 的准入事实 | PresentationPlan / SearchService |
| 搜索成功返回的工具可在宿主允许的当前执行上下文中调用；不能默默变成“下一步再试” | 跨代行为验收 |
| LRU 淘汰不撤销已接受的在途调用，也不撤销活动执行根内尚未兑现的搜索承诺 | DiscoveryStore |
| 一条有效 profile MCP 行由 root Include 唯一管理；插件不另建影子根条目 | ProfileStore |
| 配置保存的持久状态和 live 状态必须分别、如实报告；补偿失败明确标记不确定 | MutationResult |
| 宿主代次判断只有一个入口，业务层不自行探测或拼接两代路径 | host/adapter |
| 每种配置有唯一写入口，RPC 方法描述只有一份权威定义 | PolicyStore / contract |

DSH_MCP_TOOL_SEARCH=off 是总开关：它要在策略与运行时入口统一生效，不能仅清空旧 deferServers 后仍通过 policyFor 隐藏工具。关闭展示优化时不删除用户策略。

## 3. 模块边界：按职责抽取，避免大搬家

保留现有已经独立且测试充分的纯模块，不为了目录整齐搬动所有文件。目标边界如下，名称表示拟新增/拆出的职责：

```text
lib/
  tool-loading-policy.js        纯策略决策；三态输入；不读 env/宿主
  tool-search-index.js          纯检索
  tool-search-state.js          纯状态转移、快照编码和事件 fold
  host/
    adapter.js                  一次确定工具契约；服务重挂时由适配层失效重建
    tools-legacy.js             rc.5 呈现过滤、SDK 自检、旧读取契约
    tools-step.js               现代准入读取；组装返回值的窄兼容适配
    presentation-hook.js        宿主正式filter端口可用时直接接入
    projections.js              rc.5 同步注册与现代异步 handle 的统一端口
    profile-store.js            完整 profile 组合、串行调度、CAS 与补偿
    logger.js                   可选日志采集与私有 logger 字段
    skills-roots.js             provider 运行时配置读取
  tool-search/
    service.js                  目录、查询、guard、呈现计划协调
    discovery-store.js          root 所有、按 agent 隔离的活动状态
    presentation.js             同次组装的策略/发现快照；过滤tools与SDK
  mcp/
    mutations.js                add/update/remove/import/builtins 的纯变更计划
    global-service.js           ProfileStore 用例
    workspace-service.js        项目文件 + 连接协调用例
  tool-loading-service.js       策略入口、面板行、来源和继承理由
  contract/
    methods.js                  方法/参数/返回/codec 描述表
    schemas.js                  可共用的 payload 结构和归一化入口
  gateways/                     MCP 与 skills 的 Remote 转发
  index.js                      组装服务和插件生命周期
  client.js                     保持宿主需要的 factory 产物；契约段生成
  typert.js                     生成的 host 描述
```

依赖方向：gateway → service → 纯决策/存储/宿主端口。skills 文件操作、下载、解包等有 I/O 的模块不能仅因名称是 skills 就归入“纯 domain”。

DiscoveryStore、项目连接和缓存属于具体 root/service 实例；可使用实例内 Map/WeakMap。问题是跨 root、跨热重载的隐式全局共享，不是 Map 这种数据结构本身。

不设“index 必须小于 200 行”的人工目标；用职责边界与依赖检查验收拆分。

## 4. ToolSearch 设计

### 4.1 纯决策与呈现端口

```ts
type StepContext = { agent: object; toolSet?: object }
type PresentationPlan = {
  visible: readonly ToolDefinition[]
  searchable: readonly ToolDefinition[]
  deferredNames: ReadonlySet<string>
}

interface ToolsAdapter {
  admitted(context: StepContext): readonly ToolDefinition[]
  installPresentation(service: SearchService): Promise<PresentationHandle>
}
```

这些是插件内部拟定接口，不冒称宿主现有 API。现代执行上下文缺 toolSet 时，不自动调用一次新的 resolve，也不改读全局定义；应区分非 step 诊断与正式执行，正式执行缺少必要上下文就明确报错。

搜索时再次用**原来的** toolSet 与定义身份核对结果，防工具移除、重连或条件改变后返回旧定义。缓存也不能只有全局 revision：必须包含 agent/准入身份及策略、发现状态版本。

### 4.2 rc.5：保留有效的旧呈现路径

- 继续在允许改 tools 的 assemble 事件里过滤声明，保留全部可执行注册。
- PTC SDK 继续通过宿主同版本渲染器和现有前提自检裁剪；将这些细节移入 legacy 适配器。
- `modeFor`、`sdkSchemas` 的 private 依赖和公开慢路径集中在该文件，并记录缺失时该功能究竟是否可用。
- 不能提前删除 SDK 适配链、inferMode 等仍被旧宿主需要的行为；后续可在证明等价后精简。

### 4.3 0.2.2 当前版本：组装返回值兼容层

现代 waterfall 只允许修改 presentation，宿主在返回时重新附加 provider-owned tools。因此当前版本不能继续在普通 waterfall 里返回 tools；也没有必要为了拿到它而替换 executor。

采用**请求头记录前的组装兼容层**：

1. 通过宿主同模块 Cordis 的 `symbols.original` 取到原 systemPrompt 服务实例，在窄适配器中装饰其 `assemble` 方法；这属于显式的版本兼容桥，**不是当前官方公开 hook**。
2. 先调用并 await 原 assemble，取得完整、最终的 assembly 以及原 agent/toolSet 上下文；再对它执行插件统一的 PresentationPlan。
3. native 过滤返回的 tools；PTC 仅保留官方传输声明，SDK 使用宿主同模块公开 renderToolsSdk/Py。重新渲染全集与宿主原段逐字节相同，才渲染子集；不匹配明确报告不可应用，不能默默覆盖第三方协议。
4. 完成后的 assembly 由正常 agent loop 记录 request/header，再进入正常冻结与发送；不改 llm/stream 请求，不修改 Session 历史。
5. registry、原 toolSet、权限和官方 executor 完全不动。项目工具保持原连接生命周期注册；LRU/发现变化只改变后续展示。

这样可以直接接入**既有标准 native/PTC preset**，上下文来自每次 assemble，天然按 agent 隔离，不需要额外装一个 per-agent executor。原来的 PTC 同程序绑定保持完整。

兼容桥必须只有一个 owner：保存原方法 descriptor/identity、检测第三方方法替换、卸载时仅撤自己的装饰；多消费者共享同一宿主实例的注册表，不能反复覆盖方法。HMR 服务重挂时重新绑定，旧实例解绑；同次调用捕获一份策略/发现快照，避免一次组装的 tools 和 SDK 使用不同版本。第三方改变方法或 SDK 基线时明确报错/能力状态，不静默换成 restrict。

已在独立 CLI web 进程、未经修改的 npm 0.2.2-rc.1、官方 standard/ptc preset、真实 spark-x2.6 和默认 Node PTC runtime 上通过两组验证：最小呈现协议；从工作树逐字节复制的真实 ToolSearch runtime/index/state/policy/SDK。均验证搜索前隐藏、搜索后出现、随机工具值回传、同一 PTC 程序搜索后调用、第二 agent 未被发现污染。

### 4.3.1 长期最佳边界：宿主正式呈现 filter

官方源码提供了更干净的扩展位置：Tools 调用 `executor.describe` 前，以及调用函数型 section.text 前，统一取得 `presentationDefinitions(context)`。拟新增接口：

```ts
tools.filterPresentation((definitions, { scope, toolSet }) => subset) // returns disposer
```

这不是 npm 已有能力。本次仅在 temp 的工具包副本加两处调用点和 scoped filter registry，标准 preset/executor 不改，真实模型 native/PTC 已通过。

正式契约应同步按 global → ancestor → own 与注册顺序组合，只允许每轮保留输入定义的原身份、保序、无重复子序列；不能新增、克隆或修改定义。数组结果立即复制，定义视作只读；scope 未指定时不应用 per-agent 发现状态。同次 assemble 复用决策快照。`resolve/get/definitions/executable/execute` 不走这个过滤流程，run_code 由原 delegate 描述。

当前插件端优先使用正式 filter（将来具备时），否则使用已验证兼容桥；上游接口可用后替换窄适配即可，无需重做业务层。不建议维护修改版宿主发布线。

### 4.3.2 不选择 executor 接管的原因

当前 standard executor 无实例服务，serviceFor 读不到；systemPrompt.tools 只能累加贡献；AgentSetup 是创建者入口，不是全局拦截器。读取私有 selector 后新注册 agent wrapper，还会引入同 scope 冲突、共享 preset 继承、dispose 的 unavailable tombstone、原 delegate 卸载和 recompose 问题。直接让 selector 返回 wrapper 更会破坏原 SDK section 的身份检查。

自有 executor 装配适用于用户自己控制 composition 的产品，不作为本插件的通用方案。此前 G1 的“必须先控制每个 agent executor 装配”要求撤回；当前标准 preset 接入已经实测闭合。resume、preset切换、子agent、HMR冲突检测仍属于产品实现后的常驻回归验收。

### 4.4 权限、exclude、签名与降级状态

- 项目 exclude 属于真实可用范围限制，保留其独立协调器。它与 ToolSearch 的展示策略不合成一个 deny 集。
- exclude 协调器使用现有微任务合并，并维护 running/dirty、desired/applied 和句柄所有权；同 key 只是一层优化。替换失败保留旧限制；不能在创建新限制前短暂释放应持续存在的权限限制。
- 搜索只使用 A：不从全局定义补回、不重新 resolve、不暴露其他 scope 的同名工具。来源无法确认时保持常驻并显示诊断。
- `exec.parent` 只表示嵌套执行，不能单独用来判断 executor 模式或语言。由已选适配器和 ptcRuntime 共同提供签名能力；渲染器必须来自宿主同解析树，现代专属包按需加载。
- 状态不能只是一个 supported 布尔值：区分 ready/disabled/unsupported/failed，并单独列出 native 声明、PTC SDK、签名、恢复能力及原因。不把有目录但无隐藏算作 ready。

### 4.5 活动发现状态与在途调用

DiscoveryStore 独立于 tool_search 的注册生命周期，按 root/agent 管理：

- 保存发现成员、LRU 顺序、暂时保护的返回集合和活动执行根的保护集合。
- 不同工作区、同工作区不同独立会话的发现成员必须隔离；共享全局工具库存/策略不等于共享发现。2026-11-06 用户报告“A会话搜索新增15个工具，其他工作区也显示15个工具更新”，作为尚待现场定位的回归线索记录，不能仅凭相同数量判为已复现串状态。验收需要对比实际工具名称与各自request/header；全局库存不变时A搜索不应改变B的呈现，真实全局库存变更则允许各会话独立记录工具差异。
- 搜索对状态的修改使用同步、带版本的提交；需要异步签名加载时先准备再合并，避免两个并发搜索用旧快照互相覆盖。
- 对已进入执行的调用，后续 LRU/参数修改不能撤销；PTC 同一执行根里刚返回的工具至少保护到该根结束。超限时暂时保留保护项，根结束后再收敛到预算。
- “尝试调用”与“成功使用”分开。guard 只验证，不把进入 guard 当成成功执行；使用权威结果/完成边界更新使用统计，失败/取消的处理写成明确策略。
- 参数更新保留 DiscoveryStore；若确需更换工具定义，在活动调用安全结束后切换注册。不能先 dispose 整个运行时再靠投影猜回状态。

工具与 guard、section、projection 的安装必须有异常清理栈：安装到一半失败时逆序释放已获得资源，异步初始化要 await。原来的同步 try/catch 返回 no-op 不能回收半安装资源或捕获异步拒绝。

## 5. MCP 配置：唯一 owner 与诚实事务

### 5.1 全局 ProfileStore 的输入和身份

采用 root Include 唯一管理 live 的方向仍然正确，但必须按官方 profile 语义完整实现：

- 写目标只限当前 profile 的可编辑 patch 文档；保持其他条目、表达式、注释和文件权限。
- 生效输入来自实际启动的 profileContext，通过宿主 `readProfilePatches` 组合 bundle → profile → home → CLI overlay → telemetry 等完整层。
- `reconcileProfilePatches(root, fullPatches, prefix, requiredIds)` 接收的是完整 patch 列表，不是单文件 rows，更不是扁平 MCP spec。
- app-boot 使用模块私有的 bootstrapIncludes WeakMap。必须使用**启动该 root 的同一 app-boot 模块实例**。本次实际 boot + PluginPackages/runtime resolution 证明，插件通过公开 loader.import 能取得启动器同函数，ctx.root也是同root；正常官方路径已验证，不再泛称“身份拿不到”。异常自装副本仍需防范，只检查函数存在或 id=include 不够。
- 更高层覆盖时检查最终有效配置；不能保存后宣称已生效。失败消息说明具体覆盖来源。

`requiredIds` 覆盖本次需要确认激活的新增、更新、启用目标；禁用/删除目标用组合结果和 live owner 对账确认。不能要求一个有意 disabled 的条目必须 ACTIVE。

### 5.2 执行顺序及锁

事务边界是**互斥下的读改写与生效/补偿**，不是磁盘和进程之间的分布式原子提交：

1. 进入宿主 HMR 的 runExclusive（若部署有 HMR）；禁止嵌套调用它。
2. 使用与官方 config-editor/package 管理相同的 profile package.json 锁，统一锁顺序。
3. 锁内重读完整层和本地文档版本；必要时先对齐外部已保存配置，重查目标 entry 及运行状态。
4. 纯函数生成变更计划，校验 schema、disabled、ID/作用域唯一性和 overlay 最终有效值。
5. 检查本地文档的 hash/version（CAS），原子落盘；然后对完整候选配置 reconcile 并 await。
6. 对账持久结果和 live owner，返回真实生效结果。
7. 失败时执行受 CAS 保护的补偿；原错误、盘补偿错误、live 补偿错误一起保留。

与外部编辑器的 CAS 只能发现已观察到的冲突，不能让不遵守锁的外部程序具备事务保证。补偿时版本已被外部修改，就停止盲写旧文本并报告 conflict/indeterminate，不覆盖他人编辑。

建议的统一结果语义：

```ts
type MutationResult = {
  changed: boolean
  persisted: 'unchanged' | 'applied' | 'restored' | 'conflict' | 'unknown'
  live: 'applied' | 'restored' | 'pending' | 'unavailable' | 'unknown'
  diagnostics: readonly Diagnostic[]
}
```

一次操作失败仍抛出明确业务错误；有多个失败使用 AggregateError 或等价的结构化 causes。不能把“已写盘但 live 失败”用成功 note 盖住，也不能让 rollback 错误遮掉最初错误。

### 5.3 owner、HMR、自身生命周期与降级

- add/update/setDisabled/remove/import/installBuiltins 走同一个 ProfileStore 用例入口。disabled 跟配置行进入 Include。
- 替换完成前验证 HMR 重读同一文件不会再多建一条；完成后才能删除 createLiveEntries 与旧回滚代码。
- MCP 编辑不应修改 mcpManager 自身配置；仍需真实 RPC 测试验证重组后发起操作的服务/响应不被错误卸载。
- ToolSearch 设置更新本来就可能改变插件 config，引发自重载；由配置所有者统一应用，不能同时手动重装一遍。验证持久服务和活动调用的交接，不以“两步同步所以无中间态”代替证明。
- 缺少合法的启动 profile/root/app-boot 接入时，明确为只读或写盘待重启能力。普通“保存并应用”不能悄悄落盘后换成待重启；界面与 RPC 必须显式选择并返回该状态。

## 6. 项目 MCP 与加载策略

### 6.1 统一领域规则，保留不同载体

全局 MCP 的 live owner 是 Include，项目 MCP 的 live owner 是共享连接与 agent scope。这两个实现不强行伪装为同一个原子事务。

共用：输入校验、规范化、增删改/导入/builtins 计划、同名与作用域规则、策略决策和结果格式。分别实现：profile 完整层生效、项目连接 reconcile/重试。

项目文件写成功而连接失败时，返回 persisted=applied/live=pending 加诊断；面板显示连接失败并可重试，不能假报“更新完成”。所有入口都走同一调度路径。

写队列和文件锁职责不同：实例内按资源串行化；文件锁协调合作的跨进程写者；HMR 锁协调运行树替换。保留有用的队列，只将键与所有权收敛到 canonical 文件路径/root；不要直接删 workspaceWriteState，它还承担缓存版本失效。

没配置 MCP 文件的工作区仍须登记 live agent。第一次创建项目策略要能触达已有会话，不能依赖“此前已成功挂载服务器”才建立状态。

### 6.2 存储位置和唯一入口

本次**保留当前存储位置**：全局 `config.toolLoading`、参数 `config.toolSearch`、项目 `.dsh/mcp.json`。它们都归插件自己的配置语义管理。

- 全局读有效的运行配置/完整组合，不以第一个本地 YAML 匹配节点代替最终有效值。
- 每种字段只有一个读写服务，面板行、运行时和导入都通过它。
- 项目写入采用保留未知顶层字段的读改写；解析错误或非法已知策略应明确诊断，不能归一化为空后覆盖原文件。
- defer 兼容读取严格保留 true/false/undefined；推荐模式只能覆盖“未设置”，不覆盖显式 resident。
- 新的延迟偏好统一写 tools/groups 策略，旧的 setDefer/setDeferAll RPC 适配到同一个策略服务，避免直接改 live entry.options.config.defer。旧 defer 保留为兼容输入；reset 是删除新覆盖后显式回到旧值，面板显示继承来源。
- 保留现有优先级：保护项 > all-resident > 项目工具 > 全局工具 > 项目组 > 全局组 > 旧 defer 三态 > recommended > 默认。删除重复的面板“继承值”算法。
- manageBuiltin 当前是死字段。先明确产品规则为“非 MCP 工具默认 resident，显式逐工具覆盖可 deferred”，再删除死字段及相应误导注释；有效行为测试保留并补 false/true 等价反例，不靠删测试掩盖行为差异。

### 6.3 宿主兼容与插件回退分开

同一新版插件运行于两代宿主，是本次必须验收的兼容。回退到旧版插件是另一条数据兼容路径。

本次已核对**真实 v1.9.0 tag**：Config 外层 strict，只接受 toolSearch，带 toolLoading 会拒绝。新版改宽 schema 不能改变已经发布的旧版本；独立文件也不会自动清掉现有键。

因此不再承诺“任意回退 v1.9.0 都不崩溃”，也不为这个承诺增加新文件和双读优先级。确需回退时，用明确流程导出当前配置、移除旧版不支持的字段、按旧 schema 和完整组合预检。该流程不能自动在真实 profile 执行，也不能静默丢数据。

已知键继续严格校验。未知扩展键的保留与告警由读写服务负责，不采用“忽略所有拼错键”来换取表面兼容。

## 7. 发现状态恢复协议

活动状态与持久恢复种子职责不同：同进程参数更新保持准确的 DiscoveryStore；进程重启/会话恢复使用最近一次**成功搜索提交**的有序快照，不宣称恢复最后一次工具 touch。

拟定协议：

```json
{
  "protocol": "dsh-tool-search/v2",
  "discoverySnapshot": { "orderedNames": ["older", "newer"] }
}
```

- 元数据进入官方成功工具结果的 `data.meta`：native tool/result、PTC tool/ptc-dispatch 均须支持。模型显示文本继续省略累计表。
- fold 验证协议、事件类型、搜索来源与成功标志；优先读结构化 meta，旧 v1 content/meta 走明确的兼容解码。
- v2 是替换快照，`orderedNames: []` 也必须清空；不能继续 union，也不能按名字 sort。
- 单调事件 seq 决定覆盖顺序；重复事件幂等；没有相关变化时返回原状态引用。
- 提升 projection stateVersion 并验证宿主重放；未知协议或损坏状态报诊断，不能伪装成有效空集合后覆盖。
- promised/活动 root pin 不持久化为永久承诺。恢复时根据现存集合重新初始化，大小调整只影响未保护成员。
- 无投影服务：native 派生消息只能提供有限恢复，PTC 通常无法从派生消息恢复。状态报告准确说明能力，不能一律写成“不持久化”后丢掉本来可恢复的信息。
- legacy 同步 register/disposer 与现代 await register/handle 统一封装；消费者只能在现代 handle ready 后发布。参数更新不反复注销/重注册同一个 projection。

## 8. RPC、客户端和代码设计

### 8.1 契约单源的范围

一份 methods 表生成 namespace、method、参数顺序、wire 名、codec typeSymbol 与返回描述。host Remote 的真实方法集合通过 remoteMethods 实例核对，禁止正则扫描注释来确定契约。

字段校验不能只写一个类型码：已修改的策略、设置和 MCP 载荷从共享 schemas/纯验证器派生，gateway 使用同一入口；需要 browser 校验的部分由生成器生成等价实现。现有 unknown codec 若继续保留，要诚实标明它只负责传输，不声称已有字段级契约保证。

生成器生成到临时目录，逐文件字节比较；`--check` 不写源文件，不以整个 dirty 工作树的 git diff 为空作为通过条件。生成和 check 都纳入打包/CI。

### 8.2 client 拆分

宿主只读取插件交付的 `window.__ModuleLoader__.load({id, factory})` 产物，不会自动替插件打包相对 import。源码可以拆分，由自己的生成/构建流程内联回这个产物；工具可以是现有脚本、tsdown/rolldown/esbuild 等，不能把 IIFE 等同于宿主 factory 契约。

本次先生成契约段并抽出重复的纯展示决策；大规模 UI 源码拆分若纳入，就必须同时实现构建与发布校验。不能在产物里直接加入不可解析的相对 import，也不为了拆文件额外引入无关构建链。

### 8.3 生命周期和能力状态

按 root 组装服务并注入 PolicyStore、DiscoveryStore、ToolsAdapter、ProfileStore。释放显式逆序，异步 dispose 要 await，安装失败也能清理半成品。已存在 agent 通过宿主公开 registry 查询与事件增量共同接入，不只监听未来 agent/created。

宿主服务可以重挂；一次契约选择不代表永远缓存一个已销毁的 tools/projection 实例。由适配层感知服务生命周期并使其能力状态失效，业务层不散落 typeof 探测。

## 9. 兼容窗口与 CI

- engines.dsh 与 DSH peer 窗口统一为 `>=0.2.1-rc.5 <0.3.0-0`；使用真实 evaluatePluginCompatibility 验证 prerelease。宿主有 engines.dsh 时以它为准，非 DSH peer 仍要另行验配对。
- 稳定支持目标写入单一兼容测试清单：rc.5、0.2.2-rc.1；latest/next/alpha 是动态漂移观察通道。保留固定 rc.1 行的回归意义，不直接用 latest 替代它；去重只合并执行，不丢来源标签。
- runtime 用能力选适配器；CI 验证目标代次时显式断言预期能力，不把当前版本正则外推成所有未来宿主的契约。
- 每个矩阵使用目标宿主那一代 Cordis/Loader/Include，记录并校验版本和实际模块身份。源码 HEAD 保留独立身份断言，不把包版本相同当成源码身份相同。
- DSH_HOME/DSH_AGENTS_HOME 的隔离保留；环境变量测试自行设置、清理并恢复变量。HOME 表达式用例使用测试专有环境变量和外部规定的期望值，不依赖 Windows 是否有 HOME，也不拿 os.homedir 的结果掩盖环境表达式契约。
- optional peer 只用于确实可选的现代 executor/app-boot 包，并保证旧宿主不触发静态加载、插件依赖树不另装一整套互不相干宿主。所选集成路径需要的包必须从宿主解析树按需取得。
- 行为断言必须真的运行；预期缺包/能力错配应失败，不能 skip 成绿。固定支持目标必须全过；未来通道失败明确报告，不能把所有旧接口失败列“预期失败”后放过产品回归。

## 10. 开发顺序与一次发布验收

### W1：落地已验证的呈现端口

将当前 runtime 的 assemble transform 收敛成显式 `present(assembly, context, snapshot)`；legacy waterfall 直接调用，现代兼容桥在原 assemble 返回后调用。保留标准 preset 和 executor，做方法所有权、卸载、HMR冲突检测；新建/resume/切换/子 agent 回归不丢模式和配置。标准两 preset 的独立进程真实模型路径已经验证，不再以“先取得executor装配权”为阻塞前提。

### W2：领域状态与两代呈现适配

保留 legacy 行为，统一策略、发现状态、投影协议与安装清理；修复项目 defer 三态及总开关语义。旧逻辑在替代验收通过后删除。正式宿主 filter 是未来适配替换项，不作为本次发布前提。

### W3：配置事务与工作区

实现完整 ProfileStore、合作锁/CAS/补偿结果、所有全局入口共用；完善项目配置读改写、live 诊断和已有 agent 覆盖。策略存储位置保持不变。

### W4：契约、拆分和统一验证

方法/必要 schema 单源，生成检查，拆出职责，更新文档和 CI。新增依赖/版本号仅在实际实现与兼容验收后确定，不先预设“大重写所以必须 2.0”。

以上全部完成后**一起发布一次**。复查本身不提交、不发布、不修改真实用户配置；后续实施也不因开发步骤切换而要求用户逐步批准。

| 发布验收 | 必测反例 |
|---|---|
| 两代 native 搜索前隐藏，搜索后可调用 | 最终 assembly.tools，而非中间对象 |
| 两代 PTC 隐藏 SDK、保留合法绑定、同程序搜索后调用成功 | 条件 false、外部权限 deny、scope 同名覆盖不能泄漏 |
| per-agent 隔离与既有会话 | 两 agent 不同发现集、root默认与preset执行器不同、新建/resume/子agent |
| 运行时生命周期 | 初始化每个阶段失败均无残留；await projection；参数更新保留发现集；禁用/再开启有明确状态 |
| 并发/LRU | 并发搜索不丢更新，淘汰不破坏在途执行，活动根 pin 释放后预算收敛 |
| 全局配置生效 | add/update/disabled/remove/import/builtins 后唯一 owner；无HMR也能明确报告生效能力 |
| 配置失败与冲突 | overlay覆盖、导入失败、主操作+补偿双失败、外部编辑不被回滚覆盖、RPC自身不被错误卸载 |
| 项目配置 | 首次建立策略触达现存会话；未知键保留；连接失败 persisted/live 区分 |
| 恢复 | native/PTC真实结果meta、LRU顺序、空快照、v1→v2、投影重放、rename搜索入口 |
| 契约与产物 | generator --check、host/client调用、真实浏览器打开面板，发布包保留factory与声明 |
| 兼容与测试 | 两固定宿主完整测试；真实兼容评估；动态通道按实际枚举去重，不能硬写恰好3行 |

本次复查不把“关闭 0.2.2 ToolSearch”计作修复完成，也不要求先发临时版本。任何未闭合的关键能力必须继续在同一开发分支解决，并在最终结果里如实报告。

## 11. 本次证据与剩余边界

| 证据 | 本次结果 |
|---|---|
| [准入反例探针](<D:/sudy/temp/arch-review-20261106/probe-plan-semantics.mjs>) | rc.1：解除restrict后当前step仍无准入；when=false可被全局get读到；同定义重注册失效；scope覆盖保留 |
| [PTC绑定与同步重入探针](<D:/sudy/temp/arch-review-20261106/probe-ptc-bindings-reentry-review.mjs>) | 两代：控制组同程序成功，restrict组均缺绑定；同步重入泄漏限制 |
| [在途调用探针](<D:/sudy/temp/arch-review-20261106/probe-inflight-mask-review.mjs>) | 两代：guard已过，再加restrict，工具体未执行并报UNKNOWN_TOOL |
| [受控executor探针](<D:/sudy/temp/arch-review-20261106/probe-owned-executor-review.mjs>) | rc.1 native/PTC呈现过滤、条件排除、搜索后调用均通过；仅证明显式拥有delegate的组合，不证明任意现有preset自动接管 |
| [历史schema/Include/发现集探针](<D:/sudy/temp/focused-plan-review-20261106/probe-contracts.mjs>) | 真实v1.9.0拒绝toolLoading；局部patch丢完整组合；现有meta快照被fold忽略且LRU顺序丢失 |

以上早期探针均 exit 0（表示反例/可行性断言符合预期），它们使用真实官方绑定桥与夹具。用户随后要求补齐真实进程，本轮已增加：

| 实际进程证据 | 结果 |
|---|---|
| [npm 原包兼容桥结果](<D:/sudy/temp/dsh-live-design-stock-20261106/logs/stock-assemble-bridge.json>) | 官方CLI/标准native与PTC，真实模型/Node runtime：2场景、5次LLM请求，全部通过 |
| [真实工作树ToolSearch结果](<D:/sudy/temp/dsh-live-runtime-20261106/logs/result.json>) | runtime、index、policy、state、SDK逐字节复制未改；同一呈现兼容入口，2场景、5次LLM请求，全部通过 |
| [宿主filter原型结果](<D:/sudy/temp/dsh-live-design-20261106/logs/host-hook-prototype.json>) | 仅temp工具包副本新增呈现filter，标准preset/executor不动；2场景、5次LLM请求，全部通过 |
| [完整root配置事务结果](<D:/sudy/temp/focused-plan-review-20261106/boot-root-result.json>) | 同模块同root公开导入、完整组合、HMR+文件锁；7场景通过，失败激活后补偿成功、driver未卸载 |

三个最终模型验证进程均 exit 0，临时端口已释放。原用户GUI进程未变；工作树实现/依赖/lock与已装宿主包hash未变，官方源码干净。密钥只进入启动进程环境，代码/结果不含密钥。

未覆盖：Python runtime、真实 MCP 远程端点、产品RPC/浏览器全流程、兼容桥HMR冲突/恢复/preset切换/子agent的完整产品回归、CAS冲突与补偿自身二次失败、GitHub Actions。详细成功、初始夹具失败及模型思考超时都在 [隔离实测记录](<LIVE-VALIDATION.md>) 中区分，不把一次模型成功当稳定性评估。
