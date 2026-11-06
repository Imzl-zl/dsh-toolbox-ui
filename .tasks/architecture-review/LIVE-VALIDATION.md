# 最新宿主、官方源码与隔离真实模型验证

日期：2026-11-06，Asia/Shanghai。目标是把方案的“可行性”从局部夹具推进到真实 boot、标准 preset、模型及 Node PTC runtime，并据此确定当前能实施的设计。不是实现完成或发布验收报告。

## 1. 版本与范围

| 对象 | 本轮实际确认 |
|---|---|
| npm @deepseek-ai/dsh latest | 0.2.2-rc.1 |
| npm next / alpha | 0.2.2-rc.1 / 0.2.2-alpha.3 |
| 用户已安装桌面与其中的 DSH | 都是 0.2.2-rc.1，读取桌面 app.asar 中真实 package.json 确认 |
| 官方源码 | master HEAD fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159，合并 release-dsh-0.2.2-rc.1；工作树干净 |
| 本轮真实启动的宿主 | 已有隔离依赖中的 npm 0.2.2-rc.1 原包，复用完整依赖树，没有安装/下载另一套宿主 |
| 旧版覆盖 | rc.5 的准入/固定绑定等结论保留上轮真实包探针，本轮重点按用户当前最新版验证 |

[npm与源码身份记录](<D:/sudy/temp/dsh-live-design-20261106/version-evidence.json>)、[安装路径/hash事实](<D:/sudy/temp/dsh-live-design-stock-20261106/facts.json>)。

桌面 app.asar 是归档，普通文件路径不能直接 Get-Content。首次将其当目录读取失败，随后只读解析归档头与目标 package.json，确认桌面、desktop-runtime 和 @deepseek-ai/dsh 的版本；没有修改归档。

## 2. 隔离环境与真实模型

三条模型测试线各自有独立目录、DSH_HOME、DSH_AGENTS_HOME、HOME、USERPROFILE、TEMP/TMP、缓存与工作区：

- 当前 npm 原包兼容桥：`D:/sudy/temp/dsh-live-design-stock-20261106`。
- 长期宿主接口原型：`D:/sudy/temp/dsh-live-design-20261106`。
- 当前工作树真实 ToolSearch 模块：`D:/sudy/temp/dsh-live-runtime-20261106`。

均通过官方 CLI `web --host 127.0.0.1 --port 0 --no-open` 启动新的 Node 进程；独立端口由 OS 分配。启动清除无关 DSH、常见模型及凭据环境，禁用遥测/标题模型调用。profile 使用官方 base + web-app bundle，agent 通过官方 preset registry 选择 standard/ptc，不改 preset 配置或替换执行器。

模型使用用户明确授权的 spark-x2.6 与指定 v2 endpoint，经官方 llm-pi-ai 的 openai-completions 协议调用。密钥仅由启动 shell 环境传入 REVIEW_MODEL_KEY，不写入脚本、profile、源码或结果。对70个测试代码/配置/结果文件的凭据模式扫描未发现密钥。

工具夹具只返回现场生成的 UUID 校验值；模型输入不包含这个值。以最终答案与工具实际值相等、真实工具事件及 request/header 为证据，避免只检查模型说“成功”。PTC 使用默认真实 Node 进程 runtime，不是直接调用 binding 的假 runtime。

最终三个进程均正常退出，临时端口已释放。原GUI的监听端口53409与PID22656保持不变。没有浏览器打开临时页面，不把服务器启动当成浏览器验收。

## 3. 当前 npm 原包：窄呈现兼容桥

[测试驱动](<D:/sudy/temp/dsh-live-design-stock-20261106/driver.mjs>)、[结果](<D:/sudy/temp/dsh-live-design-stock-20261106/logs/stock-assemble-bridge.json>)。

宿主包未改。用同模块 Cordis symbols.original 取原服务，装饰 SystemPrompt.assemble 返回值，在正常 Agent 写入请求头之前过滤模型声明；SDK 使用公开 assemble waterfall 与同版本 renderer，全集重渲染必须与宿主原段逐字节相等才替换子集。

这属于明确的兼容性方法装饰，不是当前宿主已经提供的正式 hook。没有读取或替换私有 selectExecutor，没有新注册executor，没有改冻结的 llm/stream 请求。

| 场景 | 真实结果 |
|---|---|
| standard native | 首次请求不含目标schema；模型调用tool_search，随后调用目标工具；最终输出与随机值相同 |
| ptc | 只有一次run_code；内部先tool_search再调用目标，真实Node子进程成功；最终输出与随机值相同 |
| 搜索后的呈现 | native目标schema出现；PTC SDK目标类型出现；SDK与官方子集渲染全文相同 |
| agent隔离 | 同preset第二个agent仍未发现目标，声明/SDK保持隐藏 |
| 请求事实 | llm/stream只读观察到5次请求；搜索前后模型工具列表与正常记录的header一致 |

最终结果2/2，5次LLM请求，exit0。首次请求native工具数32，发现后33；PTC始终只有run_code。model-free场景不是本表的通过依据。

## 4. 当前工作树真实 ToolSearch 复用

[驱动](<D:/sudy/temp/dsh-live-runtime-20261106/driver.mjs>)、[结果](<D:/sudy/temp/dsh-live-runtime-20261106/logs/result.json>)、[native会话事件](<D:/sudy/temp/dsh-live-runtime-20261106/logs/standard-events.json>)、[PTC会话事件](<D:/sudy/temp/dsh-live-runtime-20261106/logs/ptc-events.json>)。

从工作树复制整个 lib 到temp；runtime、index、state、policy、host与SDK关键文件经逐字节比较全部相同。没有修改这些副本的业务逻辑。

隔离驱动用一个上下文facade，将真实 runtime 注册的 assemble transform 接到原 assemble 返回之后；正常 ctx.tools/guard/logger/loader 保持宿主对象。这样验证同一“呈现端口”能够复用当前实现，不必为了接入重写搜索或接管执行。

真实策略通过 resolveToolLoadingPolicy 将目标设为deferred；使用现有检索、guard、发现状态及SDK签名链。模型任务的select查询明确指定夹具工具，PTC任务给出短程序，避免测试变成自由推理能力评估。

| 场景 | 结果 |
|---|---|
| standard | tool_search → review_lookup，随机值回答一致；隐藏前/呈现后、第二agent隔离通过 |
| ptc | 一次run_code，内部tool_search → review_lookup；两次nested执行均成功，随机值回答一致 |

最终2/2，5次LLM请求，exit0。未把整个管理插件的网关、UI、配置保存都装入此模型场景，因此不声称完整插件已经修复。

## 5. 长期最佳宿主接口原型

[原型生成脚本](<D:/sudy/temp/dsh-live-design-20261106/prepare.mjs>)、[驱动](<D:/sudy/temp/dsh-live-design-20261106/driver.mjs>)、[最终结果](<D:/sudy/temp/dsh-live-design-20261106/logs/host-hook-prototype.json>)。

只在temp复制的dsh-tools包增加scoped filter registry与两个呈现调用点：executor.describe前、函数型section.text前。原解析树依赖复用，原包hash未变；执行、注册、resolve和toolSet代码不动。实验profile禁用原tools行并插入新id的原型行，官方preset和executor保持原样。

拟新增接口 `tools.filterPresentation((defs,{scope,toolSet}) => subset)` 返回disposer。每一轮输出必须是输入原对象身份的保序、无重复子序列；克隆、新增、重排都会抛错。该API在当前npm没有，不能让业务代码假定存在。

最终native/PTC两个场景、5次LLM请求全部通过；包含真实Node PTC同程序搜索后调用与第二agent隔离。说明这个边界能直接支撑标准preset，无需复杂的executor接管。

最佳长期实现还应明确：回调不得修改嵌套定义，返回数组拷贝，同次assembly决策快照一致，HMR/多作用域及错误归属。原型只为验证架构，没有作为发布代码交付。

## 6. 完整 boot root 的配置事务

[脚本](<D:/sudy/temp/focused-plan-review-20261106/boot-root-probe.mjs>)、[结果](<D:/sudy/temp/focused-plan-review-20261106/boot-root-result.json>)。

真实appBoot.boot + RuntimeResolution/PluginPackages启动，自建profile、home与CLI overlay。已挂载插件使用公开loader.import取得app-boot，并实际断言：root同一、root导入reconcile同函数、插件导入reconcile同函数、readProfilePatches同函数。

在真实HMR.runExclusive和profile/package.json锁内，组合全层配置、原子写入、reconcile。7个场景通过：初始对账、添加、更新、禁用、启用、真实激活失败后的补偿、删除。

每步home和CLI overlay标记保留，driver fiber未更换、disposed=0。激活失败后文件文本恢复，失败条目移除。结果是正常官方解析路径具备可用的公开事务入口；不是无法拿到模块身份。

尚未测试外部编辑CAS冲突、补偿自身再次失败、真实Remote响应期间自重组。不可据此承诺磁盘和进程事务永远同时成功。

## 7. 失败记录及证据边界

本轮没有跳过失败后直接宣布成功：

- 第一轮provider retryPolicy遗漏mode、Include patch.name误作替换字段，导致未进入模型测试；按真实schema/Include源码修正。
- Cordis代理方法每次读取产生新proxy，普通===所有权检查不成立；改用公开symbols.original解包原服务。最终产品桥仍需descriptor/多方冲突与卸载完整实现。
- 旧SDK形态字符串断言错误，随后改为与官方渲染器全文比较；未削弱隐藏/出现断言。
- 驱动额外读取ptcRuntime时漏inject，以及setup回调意外返回preset对象触发setupCommit检查，均修正夹具后重新启动独立进程。
- 自由写程序的模型有两次长时间推理，90秒上限取消，未产生工具调用，不能算通过；保留[超时失败结果](<D:/sudy/temp/dsh-live-design-20261106/logs/host-hook-prototype-model-timeout.json>)。最终长期接口原型改用明确短程序任务，测工具协议而非模型规划能力；当前原包兼容桥曾在自由生成程序任务中完整成功。

最终成功的三组模型测试合计6场景、15次LLM请求；这是功能可行性验证，不是成功率/延迟基准。失败和重跑的调用不混入这个数字。

未覆盖：Python runtime、真实远程MCP、产品RPC/浏览器、恢复/预设切换/子agent与HMR冲突的完整产品回归、GitHub Actions。后续实现必须将这些适合自动化的场景变成常驻测试；本轮没有安装依赖、改真实profile、提交或发布。

## 8. 明确推荐

当前0.2.2-rc.1：用窄的pre-header呈现兼容层，复用现有领域模块与公开SDK renderer，保留官方preset/executor/准入。兼容层集中、带身份/契约检查、可清理，并在能力状态中明示其版本范围。

长期：向宿主提供统一的呈现filter接口，替换该端口的兼容实现，不维护修改版宿主分叉。实现时仍一套领域逻辑，不因宿主代次复制MCP管理或发现策略。

全局MCP：使用已验证的公开ProfileStore组合/reconcile路径，补齐CAS与错误聚合。用户当前最新版已经具备这条公开能力。

整个插件改造完成后统一验收、一次发布，不先发布关闭ToolSearch的临时版。
