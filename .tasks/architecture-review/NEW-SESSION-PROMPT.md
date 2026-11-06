# 新会话任务：dsh-toolbox-ui 架构设计与代码设计审查

请用中文回复。这是一次**审查**任务：默认只读，先给结论和证据；未经我确认不要修改实现、测试、依赖或 lockfile。

## 背景

- 仓库：`D:\sudy\github\dsh-toolbox-ui`
- 审查对象：worktree `D:\sudy\github\dsh-toolbox-ui\.worktrees\feature\unified-tool-loading`（分支 `feature/unified-tool-loading`），**包含大量未提交和 untracked 改动**，审查必须基于当前工作树，而不是 HEAD。用 `git status` / `git diff` 看全部改动。
- 插件性质：DeepSeek Harness（DSH）Web 插件，提供 MCP 管理面板、技能管理、统一工具加载策略与 ToolSearch（工具延迟加载/按需搜索）。宿主基于 Cordis（插件框架）+ cordis-plugin-loader + cordis-plugin-include。
- 上一轮已完成的优化（本次要审查的正是这批设计）：
  1. ToolSearch 同时支持两代宿主：0.2.1-rc.5 走旧适配（`modeFor` / `sdkSchemas` / `@deepseek-ai/dsh-tools` 渲染器）；0.2.2 走新公开契约（`tools.resolve` / `tools.definitions(scope, toolSet)` / `toolSet.view(scope)` / 独立 PTC executor 的渲染器）。靠能力探测分流，不靠版本号。
  2. MCP 生命周期：一条持久化配置行只对应一个 live loader 条目；盘上更新与 live 更新失败时一起回滚（`liveEntrySnapshot` / `restoreLiveEntry` / `restoreRemovedLiveEntry` / `rollbackLiveChange`）。
  3. ToolSearch 初始化失败被隔离（`installToolSearchIsolated`），不影响 MCP 与 skills 服务。
  4. skills 根目录读取 provider 运行时配置（`entry.fiber.config` 优先于 `entry.options.config`），兼容 loader `entries()` 返回 Generator。
  5. 兼容声明收敛为 `engines.dsh` 与 peer `>=0.2.1-rc.5 <0.3.0`，Cordis `>=4.0.5 <4.2.0`，Loader `>=1.0.6 <1.2.0`；不再支持 0.2.0。
  6. CI：`.github/workflows/upstream-drift.yml` 改为版本矩阵（0.2.1-rc.5 基线、0.2.2-rc.1、latest/next/alpha 去重）+ 单独的 source HEAD 任务。**这些 GitHub job 从未实际运行过。**
- 当前验证状态：本地全量 `node --test --test-timeout=60000` 为 913 项、912 通过、0 失败、1 跳过（0.2.2 专用用例在 rc.5 开发依赖上按设计跳过）。0.2.2-rc.1 在隔离目录 `D:\sudy\temp\dsh-review-20261105-2004\0.2.2-rc.1` 做过真实 profile 探针（native + PTC）。
- 上一轮的审查提示词与任务记录：`.tasks/dsh-0.2.2-review/`、`.tasks/unified-tool-loading/`（可读作背景，但结论以当前代码为准）。
- 官方源码：`D:\sudy\github\deepseek-harness`（有 tag `dsh-v0.2.2-rc.1`），用于核对宿主公开契约，不要修改。

## 审查目标

我关心的是**长期可维护性**：这个插件要同时面对晚升级和早升级的用户，宿主仍是 0.x、官方 API pre-stable。请判断当前架构能否撑住后续多个宿主版本，而不是只看"现在测试是绿的"。

### 1. 宿主适配边界（最重要）

- 版本/能力差异是否收敛在一个**窄的适配层**里，还是散落在 runtime、sdk、index、client、skills-registry 多处各自 `if (typeof x === 'function')`？列出每一处分支点（文件:行号）并判断是否应该收拢。
- `probeHost()` 的能力模型是否是唯一真源？新旧路径会不会混用（例如同一次组装一半走 `definitions` 一半走旧 `schemas`）？
- 必需能力缺失时是明确失败/明确降级，还是静默"全常驻"却宣称 ToolSearch 正常？
- 新宿主才有的包（PTC executor、dsh-system-prompt 等）是否都是运行时按需加载，旧宿主不会因静态 import 整包加载失败？
- 对宿主私有/非公开面的依赖清单：Cordis logger 私有字段、loader `entries()` / `entry.fiber.config` / `entry.parent.remove`、旧版 `modeFor` / `sdkSchemas` 等。逐项给出：是否有公开替代、风险、建议。

### 2. 模块划分与职责

- `lib/index.js`（约 2500 行）同时承担 Remote 网关、profile patch 读写、MCP live 生命周期、ToolSearch 装配、skills 网关、内置 MCP 安装等。职责是否过载？给出可行的拆分边界（不是为拆而拆），并说明哪些拆分会降低兼容维护成本。
- `lib/client.js`（约 7000 行）单文件客户端：是否需要拆分？受宿主客户端加载方式约束的部分要说明。
- 纯决策层（`tool-loading-policy.js`、`tool-search-state.js`）与有副作用层（runtime、index）的边界是否干净？依赖是否注入，是否有隐藏的全局状态（模块级缓存、`toolsEpoch` 之类）？
- 工作区/项目 MCP（`workspace-runtime.js`、`workspace-config.js`）与全局 MCP 是否共享同一套不变量，还是两套平行实现？

### 3. 单一真源与契约一致性

- RPC 契约在 `lib/index.js`（Remote 装饰器）、`lib/typert.js`、`lib/client.js`（codec 与 descriptor）三处各写一份，现在靠测试做"四边比对"。这是否应该改成生成或单源？
- 工具加载策略（global patch `config.toolLoading`、项目 `.dsh/mcp.json`、旧 per-server defer 字段、`config.toolSearch` 参数）的读写是否各有唯一入口？新旧格式并存时谁优先、能否降级回旧宿主而不破坏数据？
- 发现集恢复：运行期 LRU 状态与会话投影 `toolSearchDiscoveries` 的关系是否清晰，重装运行时（改参数）后能否一致恢复。

### 4. 生命周期与事务正确性

- MCP 的"盘 + live"双写是否真的满足"一条配置行一个 live owner、两边一起成功或一起恢复"？逐个检查 `add` / `update` / `setDisabled` / `removeServer` / `installBuiltins` / import / `setDeferAll` 的失败路径，找出仍可能留下半套状态的地方（例如 `add()` 与 `installBuiltins()` 的回滚是否只恢复 patch、没有显式 live 恢复）。
- 并发：写锁 `withPatchWrite` 覆盖范围是否足够，live 操作是否在锁内，HMR/热重载时是否有竞态。
- ToolSearch 运行时重装（`updateToolSearchSettings`）先 dispose 再 install 的失败恢复是否可靠。

### 5. 多版本兼容的长期策略

- 评估"一套领域逻辑 + 窄适配层"与"按宿主版本分发布线/分支"的取舍，结合本插件规模给推荐。
- `engines.dsh`、peer、devDependencies 精确 pin 三者的职责是否清楚；兼容窗口是否用宿主真实的 `evaluatePluginCompatibility`（`includePrerelease`）测过，而不是 semver 模拟。
- 当 0.2.1 线最终可以废弃时，删除旧路径需要动哪些文件？是否容易删干净（这本身是适配层设计好坏的检验）。
- 审查 `upstream-drift.yml`：矩阵是否用目标宿主自带那一代 Cordis/Loader/Include、是否会出现"旧 Cordis 配新 DSH"的误报；source HEAD 任务的身份校验是否可靠；有没有明显跑不起来的问题（它从未运行过）。

### 6. 测试设计

- 测试是否在验证真实行为，还是复述实现（断言值来自测试自己手写的常量）？
- 手写宿主桩与真实宿主的保真度：哪些关键路径只有桩覆盖、没有真宿主覆盖？
- `DSH_EXPECT_STEP_TOOLSET` 控制的 legacy/modern 跳过机制：在 CI 中会不会因为环境变量没设而让新版用例静默跳过？
- 0.2.2 的 PTC 行为是否只有一次性 profile 探针而没有常驻用例。

## 执行约束

- 默认只读。可以运行测试和只读命令；测试 timeout 60 秒。全量测试约 10–20 秒，可直接跑。
- 不要修改真实用户 profile（`~/.dsh` 等），不要发布、不要提交、不要改 lockfile、不要重启或替换我正在用的 DSH GUI。
- 需要在其他宿主版本上验证时，只在 `D:\sudy\temp\` 下的隔离目录做，使用独立 `DSH_HOME` / `DSH_AGENTS_HOME`；已有的隔离环境和脚本在 `D:\sudy\temp\dsh-review-20261105-2004\`（`run-isolated.mjs`）。长时间安装或需要联网下载多版本前先告诉我预计时间。
- 不要为"跟官方"而引入新绕路；没有现成公开 API 就写清缺口。
- 结论要基于本次实际读到的代码和实际运行的结果；推断要标明是推断。

## 交付格式

先给一段总体结论（架构能不能撑住多版本演进，最大的 3 个结构性问题是什么），然后：

1. **分级发现清单**：严重度（阻断 / 高 / 中 / 低）、类别（适配边界 / 职责 / 单一真源 / 事务 / 兼容策略 / 测试）、文件:行号、问题描述、证据（代码片段或命令输出）、影响、建议处置。区分"已复现/已证实"与"待验证风险"。
2. **宿主依赖清单**：每个对宿主的依赖点 → 公开/私有 → 两代宿主上的形态 → 风险 → 建议。
3. **目标架构建议**：建议的模块边界和适配层形状（可以用简单的目录/接口草图），说明会删除或合并哪些现有逻辑、哪些适配必须保留、旧用户如何不受影响。
4. **分阶段改造计划**：按"必须先修（正确性）/ 结构收敛（降低维护成本）/ 等上游稳定后再做"分开，每阶段给验证方式；不要合成一次大重写。
5. **未覆盖项**：本次没能审查或验证到的内容及原因。
