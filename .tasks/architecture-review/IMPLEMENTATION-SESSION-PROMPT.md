# 新会话：按已验证方案实施 dsh-toolbox-ui 架构改造

请用中文沟通。这次是**实施任务**，不是再次审查或只出建议。方案已确认，直接读取证据、检查当前工作树后开始修改，在同一开发分支完成全部必要工作、统一验收，最后只发布一次。不要每完成一个开发步骤就要求用户确认，也不要先发关闭 ToolSearch 的临时版。

## 1. 工作位置与授权边界

- 仓库根：`D:\sudy\github\dsh-toolbox-ui`。
- **实际修改目录**：`D:\sudy\github\dsh-toolbox-ui\.worktrees\feature\unified-tool-loading`，分支 `feature/unified-tool-loading`。新会话 cwd 可能仍是仓库根，先确认并切到该 worktree。
- 该 worktree 已有大量 tracked/untracked 改动，属于本任务的既有实现。先查看 git status、git diff 和相关新增文件；保护现有成果，不 reset、clean 或还原用户改动，不另起一份从 HEAD 重写。
- 允许修改本 worktree 的实现、测试、契约生成、必要依赖/lockfile、文档和 CI；新增依赖应有实际理由，不为拆文件引入无关构建链。
- 官方源码 `D:\sudy\github\deepseek-harness` 只读，用于核对真实契约。**本次产品不依赖修改官方宿主或维护宿主分叉。**
- 不修改真实用户 profile、已安装插件或桌面 app.asar；不重启、替换当前用户 GUI。当前 GUI 在上轮为 `http://127.0.0.1:53409`，运行时信息可能变化，按新会话实际环境核对。
- 明确允许在 `D:\sudy\temp\` 建立测试目录、启动独立 DSH 进程和浏览器测试页，使用独立 home/profile/agents/workspace/cache/temp 与端口。管理并清理自己启动的进程，不影响用户进程。
- 本提示词授权实施与验收，不要求立即发布。准备最终发布版本、制品与报告后，按已有明确发布授权执行；若仍缺发布授权或凭据，只在具体制品可审阅的最后一步说明，不在开发步骤间反复询问。不得把“只发布一次”理解为先发布一部分。

## 2. 先读这些资料，避免重走已否定方案

权威顺序：本提示词中的用户范围与约束 → 当前解决方案 → 验证记录 → 历史审查材料。旧的 NEW-SESSION-PROMPT.md 是上轮“只读审查”任务，不能拿它的只读约束阻止本次已经授权的实施。

1. [解决方案](<D:/sudy/github/dsh-toolbox-ui/.worktrees/feature/unified-tool-loading/.tasks/architecture-review/SOLUTION.md>)：完整语义、模块边界、W1–W4、发布验收表。
2. [真实进程验证](<D:/sudy/github/dsh-toolbox-ui/.worktrees/feature/unified-tool-loading/.tasks/architecture-review/LIVE-VALIDATION.md>)：已验证事实、脚本、失败记录、未覆盖项。
3. [当日记忆](<D:/sudy/github/dsh-toolbox-ui/.worktrees/feature/unified-tool-loading/.ai-memory/20261106/daily.md>)、[会话记录](<D:/sudy/github/dsh-toolbox-ui/.worktrees/feature/unified-tool-loading/.ai-memory/20261106/session_memory_20261106-1335.jsonl>)：最后面的记录覆盖早期 G1“标准 preset 接入未闭合”的结论。
4. 本项目实际生效的 AGENTS.md/规则。代码任务先读 Serena initial_instructions；按需使用 dev-expert，不重新要求用户批准已确认方案。

开始时简短说明实施顺序和验证路径，维护任务清单；需要跨自动续轮时建立持久目标。**不要读完文档后只交一份计划就结束。**

## 3. 用户需要的最终行为

同一插件版本支持 DSH `0.2.1-rc.5` 与 `0.2.2-rc.1`：

- MCP 工具与非 MCP/内置工具都可纳入 ToolSearch。
- 用户可以设为常驻或按需搜索；MCP 支持组级策略与逐工具覆盖，内置工具默认常驻、可显式逐工具改为按需搜索。
- 全局策略和项目覆盖按同一决策规则生效；搜索入口、PTC 传输入口等必要保护项不被藏掉。
- native 搜索前隐藏完整声明，搜索成功后可调用；PTC 隐藏 SDK，但保留合法程序绑定，**同一个 run_code 程序内搜索后立即调用成功**。
- 工具权限、项目 exclude、条件 when、scope 覆盖与注册身份保持宿主原语义。ToolSearch 不扩大权限。
- 不同独立会话/agent 的发现状态隔离，包括同工作区与不同工作区；全局库存和策略共享不等于已发现集合共享。
- 面板显示实际生效状态、继承来源和错误，不能只有目录可见却声称延迟加载正常。

用户报告过“A 会话搜索新增15个工具，别的工作区也显示15个工具更新”。**用户已明确暂不追查这次历史现场**，不要扩大为真实会话日志调查任务；保留线索，实施时覆盖会话隔离回归。相同数量不能当成已复现串状态。库存不变时 A 搜索不应改变 B 的呈现；真实全局工具库存变化则允许每个会话独立记录差异。

## 4. 已确认的技术选择

### 4.1 ToolSearch 只修改呈现

A = 宿主原 step 准入，D = 当前 agent 已发现集合，M = 策略选出的延迟集合；完整呈现 V = A − (M − D)。搜索候选也必须来自当前 agent 的有效 A。

- **禁止用 restrict 或发现前不注册/重注册工具来实现延迟加载。** 两代 PTC 启动程序时固定绑定，现代 toolSet 不会因搜索扩大；这种设计已经被真实反例推翻。
- 不从全局 get/definitions 补回被权限或 when 排除的工具，不再 resolve 一个新的 toolSet 代替本步准入。
- 不改变真实注册与定义身份；LRU 只改变后续呈现，不能中断已经接受的调用或同 PTC 执行根内的搜索承诺。

### 4.2 两代宿主通过窄呈现端口适配

- rc.5：保留有效的 assemble waterfall 过滤与同版本 SDK renderer/全文自检，收敛到 legacy adapter。
- rc.1：原 assemble 完成后、正常 request/header 记录之前，对最终 assembly 做统一呈现处理。**这是明确的兼容方法装饰，当前不是官方公开 hook。**
- 用宿主同模块 Cordis `symbols.original` 解包原 systemPrompt 服务；普通代理方法每次读取会生成新 proxy，不能用其 === 判断补丁所有权。
- 正式实现要保存/恢复 descriptor 与方法身份，只有一个 owner/分发层，支持可清理的注册、第三方冲突诊断、服务重挂与 HMR。禁止卸载时覆盖别人的后续替换。
- 同次组装捕获一致的策略/发现快照；声明、SDK、目录与 guard 避免各用一份不同版本事实。SDK 使用宿主同解析树的公开 renderer；先验证 render(全集) 与宿主原段全文一致，才重渲染子集。
- 保留官方标准 preset 和 executor；不读取/替换 selectExecutor，不强制 agent override，不接管每个 agent 的执行器，不改冻结的 llm/stream 请求或历史。
- 长期推荐的 `tools.filterPresentation` 是拟新增宿主接口，目前 npm **不存在**。本次把当前兼容层做稳，预留窄边界即可；不把实现上游接口作为本次前提，不伪造能力存在。

### 4.3 发现状态和生命周期

- root/service 实例拥有 DiscoveryStore，按 agent 隔离；参数更新不能先销毁发现状态再从不完整历史猜回。
- 并发搜索同步合并版本；异步签名准备不能覆盖较新状态。活动执行根保护搜索返回，结束后释放并收敛 LRU。
- 持久恢复采用方案中的 v2 有序替换快照；读真实成功结果 data.meta，native/PTC 均覆盖，空快照要清空，不能 union/sort。
- v1兼容读取、projection版本重放、缺投影时实际恢复能力都要明确。现代异步 projection handle 必须 await ready/cleanup；安装失败要逆序释放半成品。
- 错误明确暴露；不以空结果、无声全常驻或 catch/no-op 掩盖失败。

### 4.4 配置、MCP owner 与策略

- 全局 MCP 由 root Include 唯一拥有，不再制造影子 live 根条目。所有 add/update/disable/remove/import/builtins 经同一 ProfileStore 用例。
- 从实际启动 profileContext 读取完整有序 bundle/profile/home/CLI/telemetry 等层；reconcile 接收完整组合，不是局部 rows。
- 宿主正常 PluginPackages/runtime resolution 下，公开 loader.import 可取得启动器同模块/同 root；这点已在完整 boot 实证。
- 锁顺序为 HMR.runExclusive（存在时）→官方同一 profile package.json 文件锁；禁止嵌套 HMR 锁。锁内重读、生成计划、版本检查、原子写、reconcile、对账。
- 补偿需CAS保护；原错误、盘恢复错误、live恢复错误一起保留。别人已改文件时不盲写旧内容。真实 RPC 发起者不能在错误重组中被卸载。
- 项目 MCP 保留共享连接/agent scope owner，与全局共用领域计划和结果语义，不伪装为同一分布式原子事务。写盘成功但连接失败应诚实显示 persisted/live。
- 保留 `config.toolLoading`、`config.toolSearch`、项目 `.dsh/mcp.json`。一类配置一个读写服务；保留未知字段、严格校验已知字段、defer 三态、首次项目策略触达已有 agent。
- 总开关 `DSH_MCP_TOOL_SEARCH=off` 对所有策略路径统一生效且不删偏好。
- 不承诺直接回退旧插件 v1.9.0：其真实 strict schema 拒绝新键。支持两代宿主和回退旧插件是两件事。

### 4.5 模块、契约和客户端

按 SOLUTION 的职责抽取 host adapter、ProfileStore、SearchService、DiscoveryStore、MCP用例；保留已成熟纯模块，不追求文件行数，不把服务探测撒到各业务文件。

RPC 方法描述单源生成；必要字段schema单源校验；unknown codec不能冒充字段保证。生成检查写临时目录再逐字节比对，不能要求整个既有 dirty worktree 的 git diff 为空。

客户端保留宿主 `window.__ModuleLoader__.load({id,factory})` 产物契约，源码拆分须有真实构建/打包支持，不直接往产物加相对 import。先处理契约与重复决策，不夹带无关 UI 重写。

## 5. 已有真实证据，复用而非从零猜测

截至2026-11-06，npm latest/next和用户桌面都为0.2.2-rc.1；官方源码HEAD是 `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`。执行时重新核对发生变化的部分，不把当时的版本认定成永久事实。

现有完整隔离依赖：`D:\sudy\temp\dsh-review-20261105-2004\0.2.2-rc.1`。pnpm传递包从对应宿主入口 createRequire/loader 解析，不能假设根目录暴露每个传递依赖。

- [原包兼容桥驱动](<D:/sudy/temp/dsh-live-design-stock-20261106/driver.mjs>)、[结果](<D:/sudy/temp/dsh-live-design-stock-20261106/logs/stock-assemble-bridge.json>)。
- [真实ToolSearch模块驱动](<D:/sudy/temp/dsh-live-runtime-20261106/driver.mjs>)、[结果](<D:/sudy/temp/dsh-live-runtime-20261106/logs/result.json>)：业务模块逐字节复制，呈现facade只是可行性测试接线，产品应实现清晰端口而非照抄所有测试简化。
- [宿主filter原型](<D:/sudy/temp/dsh-live-design-20261106/prepare.mjs>)、[结果](<D:/sudy/temp/dsh-live-design-20261106/logs/host-hook-prototype.json>)：仅长期边界验证，别把修改宿主副本的结果冒充原包能力。
- [完整root事务脚本](<D:/sudy/temp/focused-plan-review-20261106/boot-root-probe.mjs>)、[结果](<D:/sudy/temp/focused-plan-review-20261106/boot-root-result.json>)：7项通过，包括激活失败的补偿、同模块身份、home/CLI保留和driver未dispose。

三个最终模型进程合计6场景、15次请求成功，真实spark-x2.6与Node PTC；这证明关键接入可行，**不代表本次产品已经实施或全验收**。初始夹具失败与模型长思考取消均记录在 LIVE-VALIDATION，不能忽略。

上轮最后一次全量复查为913项：911通过、1失败、1跳过；失败与HOME表达式环境有关，原审查提示词中912通过是更早结果。实施时测自己的当前基线，修复环境依赖测试的根因，不能掩盖/放宽断言让它变绿。

## 6. 实施顺序与验收

按方案W1→W2→W3→W4推进，属于开发顺序，全部完成后一次发布。允许合理调整相邻实现顺序，但不悄悄漏掉正确性与兼容要求。

每步先跑最窄有意义检查，最终完整验收：

1. **两代 native/PTC**：最终声明/SDK确实隐藏，搜索后实际调用；PTC同一程序完成搜索和调用；when=false、权限deny、scope同名覆盖与工具重注册身份反例。
2. **策略与面板**：MCP组/工具、内置工具逐项策略、全局/项目优先级、保护项、defer三态、总开关、保存后生效与继承来源。
3. **隔离/生命周期/恢复**：同工作区及跨工作区agent、已有会话、新建/resume/子agent/preset切换，HMR与第三方冲突、半安装失败、projection异步句柄、参数重装、并发/LRU/在途pin、v1→v2/空快照/meta重放。
4. **配置事务**：所有CRUD/import/builtins的唯一owner，完整overlay、合作锁/CAS，激活失败、补偿自身再失败、外部编辑、真实RPC自重组、无HMR状态。
5. **项目载体**：未知字段保留、非法文件不覆盖、首个策略触达存量会话、连接失败与重试的真实结果。
6. **制品与兼容**：生成器check、host/client契约、factory与发布文件完整；两固定宿主整套检查。latest/next/alpha按实际结果去重并保留来源标签，匹配各宿主Cordis/Loader/Include；HEAD身份独立验证。CI不得靠skip静默通过。
7. **真实产品驱动**：独立profile装载最终插件，通过真实RPC及浏览器操作面板；观察实际DOM/工具列表和执行结果。不能以临时夹具模型成功代替产品端到端。

后端单测单例timeout=60000ms。必要的定向检查、正常本地全量回归和隔离产品冒烟属于本次实施；长时间安装、成百上千次模型eval或大范围兼容扫描先说明时间/成本并获得明确范围，不启动无关大扫测。

模型续验沿用用户授权的 `https://maas-api.cn-huabei-1.xf-yun.com/v2`、`spark-x2.6`，免费。通过进程环境 REVIEW_MODEL_KEY 等方式取密钥；提示词/源码/配置/报告不含密钥。新会话不保证继承旧shell凭据；确实缺密钥时只询问这一项，其余实现/非模型验证继续。模型失败明确记录，不能当成功；核心断言用真实结果/随机值和宿主事件，不复述自己手写的常量。

## 7. 完成口径与交接

- 简短、持续汇报发现、已完成与下一步；不要反复重讲方案或要求用户选择已选路线。
- 可独立并行委派小范围实施/审查，主agent复核集成与测试；禁止两个agent同时修改同一职责文件。无需大型多agent工作流。
- 遇到真实问题，用通俗话说明“哪里不成立、影响什么、证据、解决办法”，继续已授权且不依赖该问题的工作；不把正常工程困难当成要求用户重新设计。
- 每个阶段更新开发记录与交接，注明改动、证据、未完成和具体阻塞。保留用户既有改动与上轮证据。
- 交付最终代码、测试/真实宿主/浏览器结果、兼容与发布制品检查、文档、剩余边界。未经验证的部分直说，不能说“方案验证过所以产品无问题”。
- 若还没达到验收，继续同分支解决；全部完成统一验收后再走一次发布，不能用临时禁用、静默降级或降低测试要求冒充完成。

现在开始：确认正确worktree → 读取权威方案和实测 → 检查dirty基线与相关代码 → 建立执行清单 → 直接实施W1，不停在计划阶段。
