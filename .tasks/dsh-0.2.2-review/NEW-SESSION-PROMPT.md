# 新会话任务：审查 dsh-toolbox-ui 的 DSH 多版本兼容、宿主接口与模块边界

请对当前 dsh-toolbox-ui 做一次有真实运行证据的功能/架构审查，重点是 DSH 新版本兼容与可替代旧绕路的官方接口。UI 当前先保持，不再做视觉重设计。本轮先审查、复现、提出设计，不直接实施迁移或重构。

## 工作现场与保护范围

- 主仓库：`D:\sudy\github\dsh-toolbox-ui`。
- 实际待审代码：`D:\sudy\github\dsh-toolbox-ui\.worktrees\feature\unified-tool-loading`，分支 `feature/unified-tool-loading`，HEAD `cb02d6e68dcb3093255f91d04a54930f52b2ec93`。
- 大量实现与测试尚未提交，并有 untracked 文件。审查对象是当前工作树全部内容，不只是 HEAD；新隔离副本也要包含当前未提交/未跟踪实现。先记录 git status/diff。禁止 reset/clean、覆盖用户改动、提交/推送/发布。
- UI 交付证据：`.tasks/unified-tool-loading/UI-VALIDATION.md`。前一轮完整895/895在0.2.1-rc.5开发依赖下通过；这不能证明0.2.2兼容。UI外观冻结，功能回归仍要查。
- 本地官方源码：`D:\sudy\github\deepseek-harness`，只读参考，勿修改/切换/重置用户 checkout。需要另一版本源码时创建独立 worktree/副本。
- 正在使用的桌面运行时位于 `D:\soft\DeepSeek Harness\resources\app.asar\dsh`，此前核实为0.2.1-rc.5。不要把它当成新宿主，更不要改写它。
- 19791是上一轮UI预览；保留现有实例和用户web/desktop profile。新审查使用独立目录、独立用户数据根和空闲端口。

## 已有预检事实：请复核，不可当最终兼容结论

2026-11-05查询到：

| 证据面 | 版本/定位 |
| --- | --- |
| npm `@deepseek-ai/dsh` latest | `0.2.1-rc.5` |
| npm next | `0.2.2-rc.1` |
| npm alpha | `0.2.2-alpha.3` |
| npm `0.2.2` 正式版 | 404，不能把RC说成正式版 |
| 本地官方master | `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`，其manifest仍标0.2.2-rc.1 |
| 官方发布tag `dsh-v0.2.2-rc.1`的commit | `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`，与master不同 |
| 对照旧tag `dsh-v0.2.1-rc.5`的commit | `b830ec950faba0a46dda564be3e2d854afed94f1` |

开始时重查registry dist-tags，冻结本轮实际测试版本、tarball integrity、Node/包管理器、Cordis/loader/Include和所有关键DSH包的解析版本。不要只根据package.json版本判定源码与npm产物相同。

已确认的重要差异：

1. npm DSH0.2.2-rc.1使用Cordis `~4.1.0`、loader `~1.1.0`。本插件当前Cordis peer为`>=4.0.2 <4.1.0`，loader peer为`^1.0.3`，DSH peers为`>=0.2.0-rc.1 <0.3.0`。DSH范围匹配不等于整套实际依赖兼容，需测试解析与运行时身份。
2. 官方`packages/boot/app-boot/src/plugin-compatibility.ts`支持`engines.dsh`优先、没有才查DSH peers，并用`includePrerelease:true`；这不是npm/pnpm默认的peer判断。引入版本已早于0.2.2，不能把它误报成0.2.2新增。检查旧宿主、安装/启动/热更新路径及精确版本豁免的真实语义。
3. npm0.2.2-rc.1的`dsh-tools`已经拆分native/PTC executor；发布d.ts有`definitions`、`resolve`、`ResolvedToolSet`、`setExecutor`和批量`execute`；旧private `modeFor/sdkSchemas`已不在发布面。PTC SDK渲染器移到`dsh-tool-executor-ptc`。检查运行时实现/实际exports，不能仅靠旧fallback日志当兼容成功。
4. 本地master已有官方`dsh-mcp-manager`（list/watch/restart/probe、Settings写配置）和`mcp-client.connectionStatusOf/probeServer`；但预检npm `dsh-mcp-manager@0.2.2-rc.1`为404，发布mcp-client d.ts无这两个接口，发布Web app也无manager依赖。这些属于源码候选，不能当作npm0.2.2-rc.1可用API。
5. 源码候选manager用`super(ctx,'mcpManager')`，本插件网关`lib/index.js`也用此名。仅当相关源码/未来发布的组合实际挂载manager时才有此冲突风险；要在该组合验证，不能把它写成已发布0.2.2的确定故障。官方manager当前只管其全局配置/注册项，不自动治理静态mcp-client条目或项目MCP。

## 要回答的问题

### 1. 整体功能是否适配；问题是否局限于ToolSearch

不要预设“架构好就只有ToolSearch受影响”。分别判断直接改动面、共享宿主契约、启动故障传播和存量数据语义。

按模块列实际依赖表：本插件调用位置 → 宿主公开契约/内部形状 → 旧版行为 → npm新版行为 → source HEAD候选 → 风险与真实证据。

- ToolSearch/统一加载策略：`lib/tool-search-{host,runtime,sdk,state,config,settings}.js`、`lib/tool-loading-policy.js`。查模式判定、SDK重渲染、schema/definition差异、step-owned toolSet与条件注册、工具已发现集合、LRU/恢复、守卫、native/PTC及子调用一致性。区分“defer定义不进模型上下文”和“工具不可执行”；`when/resolve`未必等价替代搜索发现，不要仅凭名字迁移。provider层的deferLoading/tool-history能力也需核实能否替代某段自实现。
- MCP全局管理：`lib/index.js`、`mcp-{config,registry,observability}.js`。查loader条目枚举、Fiber状态/错误日志、启停/编辑/删除/重连、profile持久化、HMR与并发。loader1.1的EntryTree commit/journal/flush语义变化必须实测；不要保留已失效的1.0.x绕路当兼容层。
- 项目MCP：`lib/workspace-{runtime,config}.js`。它通过agent/context挂载，与全局loader树不同；`.dsh/mcp.json`是本插件私有配置。查多项目同名、作用域可见性与exclude、dispose/撤回工具、全局与项目策略组合。官方global-only manager不能直接替换全部项目功能。
- skills：`lib/skills-{registry,file-ops,frontmatter}.js`及skills网关。查发现/重复名优先级/根目录/禁用启用/导入删除/模型与用户调用权限。当前安装目标复制filesystem provider的roots与home解析逻辑，核对是否有正式公开替代。skills是独立网关、只依赖skills服务，应保留缺skills不拖垮MCP的边界；反过来ToolSearch初始化失败是否仍会拖垮两面，要跟实际构造顺序验证。
- 公共基础设施：Cordis服务身份、inject/effect/dispose、Typert Host/Client admission与codec、Remote命名空间、配置写入、客户端加载/HMR。三边契约当前有手写成分，查能否使用官方生成/导出面减少同步责任。

### 2. 官方接口能否删除我们现有绕路

逐项列“当前实现 → 替代候选 → 首次实际可用版本/发布状态 → 能覆盖什么 → 尚缺什么 → 是否值得迁移”。至少检查：

- 新ToolExecutor公开接口与独立PTC renderer，是否可消除private modeFor/sdkSchemas、手册重建/模式形状猜测。
- ConfigEditor/Settings的校验、revision与串行持久化，能否替代手写profile patch/重载；普通配置、插件私有defer字段与项目文件不能混为同一种写入。
- source HEAD的MCP manager、connectionStatusOf/probeServer，能否替代日志解析/loader操作/轮询；识别与当前网关同名问题，并设计未来共存/迁移方案。不要用默认强制卸载官方服务的方式规避。
- skills/filesystem/home-paths公开接口，能否减少路径规则和provider语义复制。

没有现成等价API就写清缺口，不为“跟官方”而引入新绕路。把立即兼容修复、可选简化、等待上游发布分开排序。

### 3. 多版本兼容如何长期维护

用户会有的晚升级、有的立即升级。给出适用于本插件规模的推荐方案，并比较成本：

- 一套领域逻辑＋集中、窄的宿主适配边界（优先评估）与不同插件发布线/维护分支。
- 必需能力缺失时明确阻止对应功能或准入；可选新能力才允许显式、可观察的旧路径，不静默“全常驻”后宣称ToolSearch正常。新包仅存在于新宿主时，不要在公共入口静态import导致旧宿主整包加载失败。
- 区分宿主支持声明`engines.dsh`、真实peer依赖、dev精确测试pin；不要只放宽peer或engine让测试安装过去。用宿主真实兼容评估器测范围/预发布/拒绝路径。
- 给出支持窗口：当前文档支持0.2.0和0.2.1，不能无说明丢弃。最小运行矩阵应覆盖已声明最低代表版、0.2.1-rc.5、npm0.2.2-rc.1；latest/next/alpha按解析版本去重做漂移监测，source HEAD候选单列。实际承诺、能准入、已测、未测分别写清，不承诺所有未来0.2.x。
- DSH仍是0.x且官方说明API pre-stable；语义版本范围不能代替契约测试。说明补丁兼容/主版本规则在这里的局限。
- 推荐CI矩阵与每周upstream-drift职责。检查现有`.github/workflows/upstream-drift.yml`是否配齐目标DSH自己那一代Cordis/loader/Include/完整peer，并避免先用旧Cordis配新DSH得出误报。可以分开发pin契约与版本无关运行契约，但不得删除失败测试/放宽断言来“适配”。
- 存量profile格式、新旧读写、降级可行性独立审查。自动数据迁移/扩大支持下限需要审查结果确认后再做；不能让一个新接口改写旧格式导致旧用户失效。

## 允许的隔离测试与执行约束

允许在新的隔离目录下载npm发布包、准备测试fixture、启动独立测试实例和运行有针对性的验证；这不等于允许改工作树实现或用户profile。不要只给理论报告而完全不运行可行的验证。

- 隔离副本要含当前worktree的未提交/untracked实现；不复用可变node_modules junction，不在原repo切换依赖/lockfile。
- 每个宿主版本使用独立安装目录、`DSH_HOME`、`DSH_AGENTS_HOME`、项目fixture、日志/缓存与空闲端口；启动前核对filesystem provider/instructions/session/credentials等路径确实落入临时根。DSH_HOME不保证一切都已隔离，不复制整个真实profile或会话。
- 用对应版本官方`dsh` profile入口启动，不用任意包bin或临时Vite代替真实应用。记录实际执行文件、`--version`、解析依赖和URL，浏览器走启动输出的认证入口。
- 先跑最窄有意义检查与真实loader/ToolSearch/skills契约，再按证据扩展。测试timeout60秒。长时间安装/多版本全量先说明预计时间/网络与模型成本并取得同意；无需为每条只读或短验证反复确认。
- 默认用本地MCP stdio/HTTP fixture、官方mock/replay与临时技能做无付费验证。需要真实模型/外部收费API时先说明调用预算并确认。
- GUI smoke要实际操作：启停/编辑/重连/删除fixture MCP、搜索并调用工具、切scope、临时技能导入/停用/恢复等；只启动server或只截图不算功能验证。
- 测试保存/重启/持久化与卸载，检查是否污染真实profile。不要在任何junction上执行会穿透删除的plugin remove；操作前确认绝对路径与链接类型。
- 记录并收集后台任务，保留有用失败证据，结束仅关闭自己新启动的测试实例。

## 验证重点与已有测试缺口

已有`real-host-loader`、`real-host-include`、`tool-search-real-host`、`loader-compat`、`skill-targets`、`skills-host`和Typert/Client admission测试可复用。不要假定名字含real-host就覆盖所有整合：前一轮预检发现某些ToolSearch真实宿主测试自行install runtime但没传统一policyFor，纯策略测试/项目状态测试不等于“统一策略＋全局与项目MCP＋非MCP/skill工具”集成。

至少构造这条整合路径，并覆盖：

1. 插件加载/版本拒绝/命名空间共存与卸载，不只import成功。
2. native与PTC下deferred工具搜索前后可见与可执行一致；保护入口不被隐藏；step条件注册不被搜索绕过。
3. 两项目同名MCP及全局共享、排除与策略隔离；生命周期失败后不能残留工具或错误写盘。
4. ToolSearch关闭/缺可选能力/初始化失败对MCP和skills的影响。
5. 技能配置根、导入/停用/恢复与调用权限，新旧宿主读取真实临时文件闭环。
6. 新接口候选与发布包差异，分别给结论；未发布能力不列入已验证支持面。

## 最终交付

先给结论，再给证据，输出：

1. 分级发现清单（严重度、触发条件、文件行号、影响模块、复现证据、推荐处置）；区分已复现与待验证风险。
2. 版本兼容矩阵：宿主版本＋整套依赖＋准入结果＋ToolSearch/MCP/skills功能结果＋未测项。
3. 官方API替代清单和建议架构，说明会删除哪些旧逻辑、保留哪些确有必要的适配、旧用户如何继续使用。
4. 分阶段建议：必须修复才能支持npm新版／兼容设计／候选源码接口的后续采用；不要混成一次大重写。
5. 精确测试命令、退出码、原始日志路径、真实浏览器动作与结果。旧895/895仅作对照，不挪用为新宿主证据。

审查完成后停在可评审的报告与设计，本轮不实施重构、不改变UI、不迁移用户数据、不发布。若确实没有问题，说明实际验证范围，不用泛泛的“理论上没影响”。

## 初始证据入口

本地源码：

- `packages/boot/app-boot/src/plugin-compatibility.ts`
- `docs/user/develop/basic/publish.md`
- `docs/upgrade-guide/v0.2.2-alpha.2/cordis-loader-entry-trees/guide.md`
- `packages/core/tools/src/{index,contracts,executor}.ts`
- `packages/core/tool-executor-ptc/src/index.ts`
- `packages/boot/config-editor/README.md`
- `packages/mcp/mcp-manager/README.md`（HEAD候选）
- `packages/mcp/mcp-client/src/{index,status}.ts`（HEAD候选与发布tag对比）
- `packages/skill/skill-filesystem/src/index.ts`

在线一手证据：

- https://registry.npmjs.org/-/package/@deepseek-ai%2Fdsh/dist-tags
- https://registry.npmjs.org/@deepseek-ai%2Fdsh/0.2.2-rc.1
- https://unpkg.com/@deepseek-ai/dsh-tools@0.2.2-rc.1/lib/types/index.d.ts
- https://unpkg.com/@deepseek-ai/dsh-mcp-client@0.2.2-rc.1/lib/types/index.d.ts
- https://registry.npmjs.org/@deepseek-ai%2Fdsh-mcp-manager/0.2.2-rc.1 （预检404）
- https://semver.org/ （0.y.z与prerelease规则）
