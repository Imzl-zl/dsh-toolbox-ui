# 新会话提示词（统一 ToolSearch 收尾）

把下面整段复制给新会话。它自带背景、已完成项、剩余项、验收标准和约束；不需要再读旧会话。

---

## 你要做什么

在 `D:\sudy\github\dsh-toolbox-ui\.worktrees\feature\unified-tool-loading`（分支
`feature/unified-tool-loading`，base `cb02d6e`）继续完成"DSP 插件 dsh-toolbox-ui 让 MCP 与内置工具
统一支持 ToolSearch"的收尾工作。**源码改动已基本完成并有真机证据**；剩下的是任务书里三块没做的
（W3 统一入口、W4 契约/文档/CI、双宿主复核）以及一次发布。

工作方式（用户明确要求）：
- **按用户可见面闭合**，不要每轮只修一层再交"未闭合项"。一个界面/能力的所有层（数据、渲染、
  文案、测试、真机验证）一次改完再报。
- 不逐步要确认，自主推进；遇到实际问题用通俗中文说清"哪里不成立、影响什么、怎么解决"，
  不隐藏失败、不用临时关闭功能代替完成。
- 测试失败就是失败：不许删断言、不许放宽、不许靠跳过变绿。
- 全部完成、统一验收后**只发布一次**；发布前要用户确认；不要中途 commit/push。

## 背景（必须知道的语义）

- 插件 `dsh-toolbox-ui`，同一版本要同时支持两代宿主：`0.2.1-rc.5`（legacy）与 `0.2.2-rc.1`（modern）。
- 核心语义：`A`=宿主准入、`D`=已发现集合、`M`=策略延迟集合、`V = A − (M − D)`；ToolSearch 只改
  **展示**，从不 `restrict`、从不重注册。
- rc.5：`system-prompt/assemble` 瀑布载荷里有 `tools`；rc.1：载荷只有 `sections/contexts/variables`，
  宿主在瀑布之后才把 `tools` 贴回来 → 必须装饰 `SystemPrompt.assemble`（`Symbol.for('cordis.original')`
  解代理，`internal/service` 事件重绑）。
- rc.1 的 `sessionProjections.register` 返回 thenable 句柄（`stateOf(session)` + 异步 `dispose`）；
  rc.5 返回同步 disposer + `stateOf(session, key)`。
- rc.1 的 tools 服务没有 `presentAs`/`sdkSchemas`/`modeFor`，渲染器在 `@deepseek-ai/dsh-tool-executor-ptc`。

## 已完成的（有证据，别重做）

| 项 | 证据 |
|---|---|
| 适配层/展示层/发现集/投影四件套 + 两代兼容 | `lib/tool-search-adapter.js`、`lib/tool-search-presentation.js`、`lib/tool-search-discovery.js`、`lib/tool-search-projections.js` + 各自单测 |
| v2 恢复协议（`tool/result.meta` 有序快照） | `lib/tool-search-state.js`；真实宿主事件里能看到 `meta.protocol=dsh-tool-search/v2` |
| 策略（含组级/单工具/总开关）、配置事务、面板 | `lib/tool-loading-policy.js`、`lib/workspace-config.js`、`lib/client.js` |
| rc.5 全量 | **950 项：947 通过 / 0 失败 / 3 跳过**（2026-11-06 19:55） |
| rc.1 全量 | 945 项：**903 通过 / 1 失败 / 41 跳过**；唯一失败 `lockfile resolves DSH host packages…` 是隔离树假象（那棵树装着完整宿主元包，本插件 package.json 只声明自己用的，CI 按声明集合安装不会出现） |
| 真实模型端到端（两轮通过） | 见 `.tasks/architecture-review/LIVE-PRODUCT-E2E.md`；工具隐藏→搜索→调用→答案等于随机值；PTC 单 `run_code` 内 `tool_search`→目标工具 |
| 浏览器真实操作面板 | 工具页含 MCP 行、计数同源；点行内「常驻」+保存写到 profile；MCP 页芯片读统一策略（组级 deferred → 延迟） |

真机跑法（隔离目录、独立进程、密钥只进子进程环境）：
- 产品端到端：`D:\sudy\temp\prod-live-20261106`（`prepare.mjs` / `launch.mjs` / `driver.mjs` /
  `fixture-mcp.mjs`），插件副本放在宿主树 `D:\sudy\temp\dsh-review-20261105-2004\0.2.2-rc.1\live-plugin`。
- 面板验证：`D:\sudy\temp\prod-panel-20261106`（只装插件 + MCP 夹具，不装模型），插件副本在
  `...\0.2.2-rc.1\panel-plugin`。**插件副本必须复制、不要用 junction**（Windows 删链接会清空源目录）。
- 模型密钥**只**通过 `REVIEW_MODEL_KEY` 环境变量传给子进程；不得写进任何文件、报告、配置。

## 剩余工作（按顺序，每项都要"整面闭合"）

### 1. W3：把 `reconcileProfilePatches` 接成唯一 live owner

现在 `lib/index.js` 的 `assertProfileEffect()` 只用 app-boot 的 `readProfilePatches` +
`reconcileProfilePatches` **校验**写入是否生效；新增/修改条目仍走手写的 `ctx.loader.create/update`。
要做：
- 用官方 `@deepseek-ai/dsh-app-boot` 的 `readProfilePatches(profileName, profileContext, loaded?)` +
  `reconcileProfilePatches(root, patches, profileName, requiredIds?)` 作为**唯一**的 live 变更入口，
  删掉重复的手动 create/update 路径（同一件事两个实现就是这次面板 bug 的同源病灶）；
- 保留回滚：写盘成功但 live 未生效 → 回滚到上一份 patches 并如实报错；
- 参考实现（只读）：`D:\sudy\github\deepseek-harness` @ `fcc0ad46` 的 `packages/boot/config-editor/src/index.ts`。
- 验收：`add` / `update` / `setDisabled` / `remove` / import / builtins 全部走同一入口；双宿主全绿；
  至少一条真实宿主用例证明"写盘 + live 同一事实"。

### 2. W3：所有变更型 RPC 返回结构化结果

现在只有 `add` 返回 `{ persisted, live, diagnostics }`。其余入口补齐同样的三字段（失败时
`persisted:'failed'` 或 `live:'skipped'` + 具体原因），面板按它显示"已保存但未生效"这类状态；
配 RPC 契约测试（typert 声明与实现一致）。

### 3. W4：契约单源 + 文档 + 版本

- RPC 方法/字段做单源生成（host 声明、typert、client descriptor 三边由同一份定义生成），
  加 `--check` 模式进 CI；现有 `test/package-contract.test.mjs` 的"第四面"（gateway 原型）保留，
  新的内部方法要继续登记进 `INTERNAL_ONLY` 并写理由。
- 客户端拆分：`lib/client.js` 已 7k 行，按"面板/MCP 面/技能面/工具页"拆模块，保持单文件产物可用。
- 文档与版本号：README/CHANGELOG/兼容窗口（rc.5 + rc.1），版本按语义化升一次。

### 4. 双宿主复核 + 发布

- rc.5 与 rc.1 两套全量跑绿（rc.1 隔离树同步 `lib/ test/ scripts/ .tasks/mcp-servers-verified*.yaml`
  与 `package.json`；已知唯一允许的失败是 lockfile 那条，且必须在报告里说明原因）。
- CI 双矩阵复核：`DSH_EXPECT_STEP_TOOLSET=0/1` 各自断言对应能力，不允许靠 skip 变绿。
- 最后一次性发布（用户确认后）。

## 验证命令

```powershell
cd D:\sudy\github\dsh-toolbox-ui\.worktrees\feature\unified-tool-loading
node --test --test-timeout=60000                      # rc.5 全量
$env:DSH_EXPECT_STEP_TOOLSET='1'
cd D:\sudy\temp\dsh-review-20261105-2004\0.2.2-rc.1
node --test --test-timeout=60000                      # rc.1 全量（先同步 lib/test/scripts/.tasks 源文件）
```

隔离运行必须设独立 `DSH_HOME / DSH_AGENTS_HOME / HOME / TEMP` 与 OS 分配端口。

## 硬约束

- **不要动**真实用户 profile、已安装插件、桌面 `app.asar`；当前 GUI `http://127.0.0.1:53409` 全程不动。
- 工作树里有大量**先前就存在**的未提交改动，禁止 `git reset` / `git clean` / `git checkout .`。
- 测试断言必须来自生产路径/真实 wire/外部规格，不能把实现里的常量抄进测试。
- 后端单测 60s 超时；改完先跑最窄的检查再跑全量。
- 报告里不得出现模型密钥；截图/日志同样。
- 遇到"面板看起来正常、实际策略相反"这类**静默错误**，按缺陷处理，不许记成"已知限制"。

## 建议的第一件事

读 `.tasks/architecture-review/IMPLEMENTATION-PROGRESS.md` 与 `LIVE-PRODUCT-E2E.md`（现状与证据），
然后从上面第 1 项开始：先用 `readProfilePatches/reconcileProfilePatches` 替换 `add` 的 live 路径，
跑双宿主全量，再逐项替换其余入口——一项做完做透再动下一项。
