# 任务：实现 MCP ToolSearch 审查报告的整改清单（O1 优先）

## 你的角色

你是**实现者**。上一轮（独立审查）已完成，报告在 `.tasks/mcp-tool-search/REVIEW-REPORT.md`，
结论：四项修复都真修了但没修透，O1 的停工理由被证伪、正确形状已实测出来。你的工作是把审查报告 §8
的清单**按优先级实现掉**。每项按本仓纪律来：先写失败测试、再实现、撤掉改动看红、进宿主管线的补真宿主用例。
（可选：本任务是端到端所有权形态，适合 @zhanggui 技能驱动。）

## 必读（按顺序）

1. `.tasks/mcp-tool-search/REVIEW-REPORT.md` —— 审查报告。§3 每项有判定+证据+更结构性做法，§8 是给你的清单
2. `.tasks/mcp-tool-search/OPEN-ITEMS.md` —— 遗留项现状
3. `docs/mcp-tool-search-design.md` —— 设计文档，§12 是历次修正记录（你的改动要按既有格式追加）
4. `lib/index.js` 的 `update()` 方法 —— O1 要复用它已有的失败回滚形状

## 任务清单（按顺序做，P0 是硬优先级）

### P0-1：O1 —— `add` / `removeServer` / `installBuiltins` 接上 loader（唯一影响真实使用的一项）

审查轮已用真 loader 夹具端到端实测出正确形状（报告 §3 O1 节 V1-V7），**按规格实现，不要重新调研**：

- `add()`：writePatch（现状）→ `await ctx.loader.create({ id, name: MCP_NAME, config: entryConfigOf(normalized) })`
  ——**根部创建（parent 省略）**。已实测：条目立即可见、工具连上、`list()` 报 `managed:true, connected`、
  patch 文件不被根部创建改写（根部 tree.write() 是 no-op）
- ⚠️ **不要**用 `loader.create(options, 'include')`：那条路触发 `Include.write()` 把 patch 条目烙进 base
  配置文件，下次启动重复 insert（报告 §3 O1 节"新发现的生产风险"）
- `removeServer()`：`managedLiveEntry` 解析 → `await ctx.loader.remove(entry.options.id)` → 再删 patch 行
- `installBuiltins()`：追加条目批量 create（注意 index.js:1481 的字段清单，见 P0-3）
- 失败回滚：复用 `update()` 已有形状（writePatch 回滚 + AggregateError）
- note 文案从"重启后生效"改成如实描述新行为

**测试先行**：先补真 loader 夹具（`node --test` 内可跑）。生产形状 = include 条目带 subtree 且
`profileMcpEntries()` 非空。两条路（优先第一条）：
1. 手写最小 `EntryTree` 子类（~15 行：`[Service.init]` 里 `yield () => this.stop(); await this.root.update(固定条目列表)`），
   注册进 `ctx.loader.builtins.include` —— 零新依赖
2. 加两个 devDependency（`@deepseek-ai/cordis-plugin-include@1.0.10`、`@deepseek-ai/cordis-plugin-group@1.0.5`，
   npm 上有；审查轮探针实测与仓库 cordis 4.0.2 / loader 1.0.3 运行时兼容）

夹具 MCP server 抄 `test/real-host-integration.test.mjs` 的 FIXTURE_SERVER。断言至少覆盖：
add 后条目在 + 工具活 + `list()` 报 managed；removeServer 后条目没、子进程退（哨兵文件）；
create 失败时 patch 回滚。

### P0-2：F4 永假守卫（一行）

`test/tool-search-wiring.test.mjs:383` 守 `/estimateSchemasTokens/`，真名是 `estimateSchemaTokens`（少个 s）——
这条断言永远绿。改成真名，或删除并注明理由（函数已不存在，这条守的是空气）。

### P0-3：F2 五份手抄字段清单

`MANAGED_CONFIG_FIELDS` 已是唯一真相源，但还有四处手抄：mcp-config.js:390（entrySpec）、:418（makeEntry）、
:226（warnUnsupported known）、index.js:1481（installWorkspaceBuiltins）。全部改引常量
（entrySpec 的 transport 特例显式处理），known 集合改为派生。**先加一条表驱动 round-trip 测试**
（每个 MANAGED 字段：写进 patch → 读回必须相等）——审查轮的漂移实验证明现在没有这道闸。

### P1（按序；预算不够就留到下一轮并更新交接文档）

4. F3 残留：项目作用域 ≤6 服务器时按钮不渲染（showControls 门 + embedded:true）——给 toolbarAction 开口；
   deferAllState 计数口径（filtered vs state.byName）统一；删 ListFooter 死槽位（client.js:2009-2018）+ 4 条死 CSS（:135-138）
5. i18n：补 5 个在用字符串的 EN 条目（含主按钮 '全部延迟'/'取消全部延迟'），删 6 条死词条，
   parity 测试扩到 t() 调用点
6. F1 第四边：以 `McpManagerGateway.prototype`（36 方法，可导入）对账三份清单的断言
7. 文档：F1-F4 追加进 design.md §12；删 §8/§10/§11 的估算 UI 描述
8. Minor：hub 分类 effect（client.js:5611）补 catch；deferAllState title 计数与作用面一致化

## 纪律（违反任何一条，本轮成果作废）

1. TDD：每项先写失败测试；后端单测 60s 超时
2. 每改一处产品代码，跑一次"撤掉改动看测试红"（每批一次就够）
3. 断言值从生产代码路径取，不在测试里重抄常量
4. 不静默兜底：失败要么炸要么显式记账；不允许"看起来成功了其实没生效"
5. 真宿主契约（输出进宿主管线 / 调宿主入口的）必须有真宿主用例——手写夹具会系统性漏掉宿主校验
   （前两轮用真金白银换来的教训，design.md §12.1）
6. 测试命令 `node --test`（**不是** `node --test test/`），基线 712 绿，收尾时全量必须还是绿的
7. 拿不准就说不知道，不要填一个看起来合理的答案

## 环境事实（省你一小时）

- **绝对不要动用户的 `web` profile**（`~/.dsh/profiles/web`）——用户当前会话跑在里面。真机测试用隔离
  profile，配方在 `.tasks/mcp-tool-search/REVIEW-PROMPT.md` 的"环境事实"一节（serena 条目用 insert 形式、
  providers 归 llm-pi-ai 条目、lightvela 必须带 compat.supportsDeveloperRole:false、端口自探 8787 被占）
- 本机 node 在 `D:\soft\nodejs\node.exe`（**不是** C:\Program Files\nodejs）
- 隔离 profile 验 web UI 用 chrome-devtools MCP；截图存不进仓库目录（MCP workspace root 不含仓库），
  用内联截图或存 `~/.dsh/attachments/`
- 多帧 zstd session 日志要按 magic `28 B5 2F FD` 切帧逐个解
- 用户的 web profile 有一组 serena 进程不能杀（父进程 `dsh lib/bin.js web`），动手前先看 CommandLine 确认归属
- 不要注入 `LIGHTVELA_API_KEY` 环境变量（用户给过的 key 已失效），让 DSH 从凭据库解析

## 收尾（必做）

1. 更新 `.tasks/mcp-tool-search/OPEN-ITEMS.md`：做完的移除/打勾，没做的写明卡在哪、下一步是什么
2. design.md §12 按既有格式追加每项修正记录（错论据 → 证据 → 改动）
3. 全量 `node --test` 绿 + P0/P1 每项完成情况一句话结论
4. 上下文不够做完：更新交接文档后停，不要留半验证的改动
