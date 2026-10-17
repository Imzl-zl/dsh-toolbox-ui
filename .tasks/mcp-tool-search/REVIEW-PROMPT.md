# 任务：独立审查 dsh-toolbox-ui 的 MCP ToolSearch 收尾工作

## 你的角色

你是**独立审查者**，不是执行者。上一轮会话（下称"前一轮"）自称修好了四个问题、留下四个遗留项。
你的工作是用证据判断：**哪些是真的修好了，哪些是凑出来的；哪些"最好结果"其实还有更结构性的做法。**

⚠️ **最重要的要求，读三遍**：

> **不要只看结果，要看这个结果是"凑出来的"还是"每一步都优雅踏实的最好结果"。**

"结果对了"是最低标准，不是验收标准。一个能让测试全绿、能让按钮出现在屏幕上的补丁，完全可能是凑出来的——
它堵住了症状、留下了结构不一致、或者把真正的根因推给了下一个人。

## 怎么区分"凑出来的"和"优雅踏实的"

**凑出来的结果的特征**（每条都要主动排查）：

1. **测试绿是因为断言被弱化了**，而不是代码对了。前一轮明说了它改过你的 4 处测试——逐个核对这些改动，判断每次是"测试本身错了"还是"测试碍事了"。
2. **症状修补而非根因修复**。比如：三边契约（`index.js` 装饰器 / `lib/typert.js` / `lib/client.js`）手写三份，漏一份就静默失效——前一轮补上了漏的那一份，但**"要手写三份"这个结构 itself 就是根因**。它有没有处理这个？还是只补了第三份？
3. **用推理冒充实测**。凡是"应该是"、"理论上"、"代码走这里所以"，都标出来。前一轮自己承认过两次这类错（把合并效果记在单项头上；据代码推断无 HMR 后来才做对照实验）。
4. **为了不破坏现有测试而绕路**。比如保留一个没人调用的函数、加一个永假的分支、把断言从精确值放宽成范围。
5. **掩盖失败而非暴露失败**。silent fallback、吞掉异常、把错误写成"成功"——前一轮的活例：`add` 的 note 曾经假称"正在热加载"。
6. **数字或结论是拼凑的**。比如把 maxResults+stem 的合并效果记在 maxResults 单项头上。

**优雅踏实的结果的特征**：

- 不变量在**一处**表达，别处派生或自动校验
- 失败**响亮**：缺契约就红，静默缺失就说明闸门没装对
- 断言值来自**生产代码路径 / 真实证据**，不是测试里重抄一个常量
- 每个结论附**原始证据**（事件名+字段值 / 命令原始输出）
- 修的是根因，且能说清"为什么这是根因而不是症状"
- 删掉的东西是真死了（没有隐藏调用者），不是"先留着"

## 背景：前一轮做了什么

仓库 `D:\sudy\github\dsh-toolbox-ui`（DSH 插件 dsh-toolbox-ui）实现了 MCP 工具延迟加载：
MCP 工具定义不再全量常驻模型上下文，改为按服务器 defer——默认不进模型可见面，
模型经一个 `tool_search` 工具按需搜索、命中即用。

前一轮（在真实模型 + 真实浏览器 + 真 loader 夹具下）声称修好了四项，并声称验证充分。

**先读这两个文件，它们是前一轮的自述，不是事实**：
- `docs/mcp-tool-search-design.md` —— 设计文档，§12 是历次修正记录
- `.tasks/mcp-tool-search/OPEN-ITEMS.md` —— 遗留项清单（4 项未修/未验证 + 4 项已修摘要）

## 你要审的四项"已修"

对每一项，回答三个问题：**真的修好了吗？是根因还是症状？有没有更结构性的做法？**

### F1 `setDeferAll` 整个方法没接上
前一轮的说法：`index.js` 漏 `@Remote` 装饰器、`lib/typert.js` 漏登记、`lib/client.js` 漏 descriptor，
三边全缺 → 面板点了毫无反应（真浏览器实测：170 个请求里从未出现 `setDeferAll`）。
修法：三处补齐。

**要审的**：
- 三边契约靠手写同步，这本身就是根因。前一轮只是补了第三份。**该不该有生成机制、或一条自动比对所有边的测试？**
- 现有 `test/package-contract.test.mjs` 的 "the three contract faces list the same methods in the same order"
  为什么当初没抓到？（前一轮说因为 host 侧读 `Remote("...")` 正则读不到——但那意味着这条测试对"漏 @Remote"这类失效是**结构性失明**的，它还守得住什么？）
- `test/typert-manifest.test.mjs` 原有 `assert.equal(mcp.length, 34)` 把缺口固化成"正确值"。改成 35 就够了吗？
- 装饰器是编译产物形式（`__esDecorate`），加方法要改四处（变量声明、装饰器数组、`__esDecorate` 调用、方法体）。
  这个形状 itself 是不是在鼓励漏？

### F2 `entrySpec` 读侧丢了 `defer`
前一轮的说法：`lib/mcp-config.js` 的 `entrySpec()` 只读 `MANAGED_CONFIG_FIELDS`，
漏了 `PLUGIN_OWN_CONFIG_FIELDS`（defer），而写侧一直在用那份清单 → 盘上 `defer:true`、
面板显示「关闭」，状态与真实相反。
修法：`entrySpec` 补读 `PLUGIN_OWN_CONFIG_FIELDS`。

**要审的**：
- **读写两份字段清单，这本身就是根因。** 前一轮只是在读侧补了一份枚举。该不该合成单一来源？
  （注意 `PLUGIN_OWN_CONFIG_FIELDS` 与 `MANAGED_CONFIG_FIELDS` 的划分有语义理由——前者是插件自有、
  不下发 mcp-client。所以"合成一份"未必对，但"让两侧不可能漂移"一定有比手写两份枚举更好的做法。判断之。）
- 同类漏读还会发生在别处吗？把所有"读配置 → 投影给客户端"的路径核一遍。

### F3 「全部延迟」按钮位置
前一轮的说法：按钮原在列表底栏（`ListFooter`）、太小，滚出视野就找不到。
用户原话：「我都没注意到，差点以为没有这个功能」。
修法：移到过滤器行右侧，主按钮 + 闪电图标，唯一入口。

**要审的**：
- 过滤器行是不是最优位置？那一行原本只有两个下拉。服务器多起来时，搜索框 + 两个过滤 + 一个主按钮
  在同一行会不会挤？窄屏（面板 760px 断点）下怎样？**看真实渲染，不要看代码猜。**
- "唯一入口"意味着什么？如果用户想对**单个服务器**操作，现在的路径是什么（编辑表单里的复选框）？
  一键全局 + 逐服务器两个粒度，信息架构上成立吗？
- 前一轮自己做了源码正则测试，发现它抓不住退化（撤掉渲染处仍绿），于是改成真实渲染断言。
  这个迭代过程是对的方向，但现在的测试够吗？

### F4 删除 token 估算
前一轮的说法：我们不知道用户装了什么 MCP，schema 大小差一个量级，估算数字是假精确感，
且用户会拿它做决定（"7.4K 好像不多，不用延迟"）→ 主动误导。
修法：整套删除（两个函数、两处计算、三处渲染、4 个单测）。

**要审的**：
- **完全删 vs 保留定性提示**（比如只说"工具数多/少"而不给数字），哪个更负责？
  前一轮选了完全删，理由是"给了数字就有精确感"。但用户原本是拿这个数字判断"值不值得延迟"的——
  删掉之后用户靠什么判断？现在的替代信息（工具数 + per-server 规则）足够吗？
- `estimateSchemaTokens` 的 CJK 感知逻辑（CJK 按 1 字符/token）是上一轮的工作成果，说删就删了。
  有没有别处还需要 token 量感知？（比如工具数很多时的上下文告警）
- 删掉的 4 个单测是不是真死了？有没有可能将来又想加回来，那该留什么？

## 你要审的四个遗留项（`OPEN-ITEMS.md`）

对每一项，判断：**前一轮"停在这里"的理由成立吗？该不该现在做？如果做，最小正确的第一步是什么？**

- **O1** `add` / `removeServer` / `installBuiltins` 只写盘。前一轮做了可行性探针：
  loader 根部创建真 entry 已证实可行，但生产形状（include 子树）因缺
  `@deepseek-ai/cordis-plugin-include` / `cordis-plugin-group` 无法复现，于是没动。
  **审**：这个"缺依赖所以不能验证所以不做"的推理链成立吗？加两个 devDependency 是不是就可解？
  手写一个最小 `EntryTree` 子类呢（`EntryTree` / `EntryGroup` 本仓装着，缺的只是带 `[Service.init]`
  的 group 包装）？如果验证可行，`add()` 的正确形状是什么（参见 O1 里列的 4 个设计疑点）。
  **这是唯一影响真实使用的一项，优先审它。**
- **O2** skills 三个 RPC 未实测（缺 `dsh-fs` / `dsh-home-paths`）。
- **O3** 隔离 profile 的 accent 主题色解析成 `#f9fafb`（近白），影响整个面板的既有按钮。
  前一轮说与 ToolSearch 无关所以没深究。**审**：真的无关吗？它会不会让 UI 判断失真？
- **O4** lightvela 网关拒 `role:"developer"`；用户的 web profile 里 lightvela 没有
  `compat.supportsDeveloperRole: false`。**审**：这是插件该处理的，还是用户配置问题？
  如果是前者，插件侧有干净的处理点吗？

## 硬性纪律（违反任何一条，你的审查结论作废）

1. **每个结论附原始证据**：事件名 + 关键字段值、命令原始输出、真实渲染的 DOM 量测。
   不许只给"能用"/"没问题"/"应该是"。
2. **明确区分"已验证"和"未验证/无法验证"**。没验就说没验。拿推理当实测是这轮最重的罪。
3. **发现前一轮错了，明确说"前一轮错了"并给证据**，不要绕着走。
4. **不要为了让任何东西变绿而弱化断言**。如果你认为某条测试本身错了，说清它错在哪、正确的断言是什么。
5. **测试断言的值要从生产代码路径取**，不要在测试里重抄实现常量。
6. **改了产品代码，跑一次"撤掉改动看测试变红"**（每批一次就够），证明测试不是空的。
7. **拿不准就说不知道**，不要填一个看起来合理的答案。
8. **不要把单次结果当普遍结论**。前一轮的教训：stemming 在 serena 上 +11%、在 chrome-devtools 上 +0%，
   场景相关性极大。下任何结论前先想"我在几个工具集/几个模型上验过"。
9. **失败就贴原始输出**，不要修饰。

## 环境事实（前人用真金白银换来的，能省你一小时）

**仓库与测试**
- 测试命令：`cd D:\sudy\github\dsh-toolbox-ui; node --test`（约 10-14 秒，前一轮基线 **712 全绿**）
- ⚠️ 用 `node --test`，**不是** `node --test test/`（后者报 MODULE_NOT_FOUND）
- 当前工作树有未提交改动（`git status` 可见），前一轮的改动都在里面

**⚠️ 绝对不要动用户的 `web` profile（`~/.dsh/profiles/web`）**——用户当前会话就跑在里面。
所有真机测试在新建的隔离 profile 里做。测完删掉隔离 profile，但**不要删 `~/.dsh/sessions/` 下的日志**
（那是证据）。用户的 web profile 有一组 serena 进程（父进程是 `dsh lib/bin.js web`），**不能杀**——
看到 serena 进程先看 CommandLine 确认归属。

**隔离 profile 重建（web UI 验证用）**
```powershell
dsh --profile <name> --from-default-profile headless --dump-config | Out-Null
dsh plugin --profile <name> add D:\sudy\github\dsh-toolbox-ui
# ⚠️ 然后必须把 <profile>/package.json 的 bundles 从 dsh-headless 换成 dsh-web-app，
#    否则 `dsh --profile <name> web` 报 "too many arguments"——app 由默认 bundle 决定
# 最终 bundles 应为 ["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app","dsh-toolbox-ui"]
```
patch 要点（`<profile>/cordis.patch.yml`）：
- **serena 的 `defer: true`** 要用 `- insert:` 形式（headless 模板没有 mcp 条目，
  直接 `- id: mcp-serena` 会报 `patch: entry "mcp-serena" not found`）
- **`providers` 属于 `llm-pi-ai` 条目，不是 `llm`**（放错报 `no adapter registered for provider "lightvela"`）
- **lightvela 必须带 `compat.supportsDeveloperRole: false`**，否则所有请求 400
  （`token.lightvela.ai` 拒收 `role:"developer"`；根因在 pi-ai 的
  `openai-completions.js:896`：`model.reasoning && compat.supportsDeveloperRole ? "developer" : "system"`）
- `agent-default-model → lightvela/auto`、`permission → danger-full-access`
- 用 `dsh --profile <name> --dump-config` 核对组合结果

**起 web 服务**
```powershell
Set-Location D:\sudy\github\dsh-toolbox-ui
dsh --profile <name> --no-open --port <free-port> --host 127.0.0.1
```
- 端口要自己探空闲（**8787 被别的服务占着**，前一轮用过 8898/8899）
- `--no-open` 时不打印 URL，token 要从 job 输出里取：`dsh web: http://127.0.0.1:PORT/?token=...`
- 页面必须带 token 打开，否则显示 "dsh web authentication required"

**session 日志分析**
- 日志在 `~/.dsh/sessions/--D-sudy-github-dsh-toolbox-ui--/<sessionId>/session.v4.jsonl.zstd`
- sessionId 从 `--json` 开头的 `session` 事件拿
- ⚠️ **多帧 zstd**，`zstdDecompressSync` 只解第一帧，会误判成"只有 1 个事件"。
  必须按 magic `28 B5 2F FD` 切帧逐个解
- 载荷形状：`request/header → data.header.tools`（每项 `.name`，不是 `.function.name`）；
  `tool/call → data.name` / `data.arguments`；`tool/result → data.message.content[].text` / `.isError`；
  `developer/message → data.message.source.kind` / `.content[].type`；
  `system/message → data.message.content[]` 里找 `type: 'text'`
- `--json` 事件流字段名是 `tool` / `input`，不是 `name` / `arguments`

**其他坑**
- serena 冷启动 1-3 分钟，一次 headless 调用就是一个全新会话
- **不要注入 `LIGHTVELA_API_KEY` 环境变量**（用户口头给过的 key 已失效，报 401）。
  正确做法：`Remove-Item Env:LIGHTVELA_API_KEY -ErrorAction SilentlyContinue`，
  让 DSH 自己从凭据库（`~/.dsh/.credentials.yaml` 的 `refs.LIGHTVELA_API_KEY`）解析
- `mcpManager.update(spec)` 的 spec 用 `name` 字段，不是 `serverName`
- 测试夹具的 stub loader entry 是普通对象，没有 `update` 方法；要测"走 entry.update() 重启路径"
  必须先给 stub 补一个可观测的 update
- `dsh` 在 PATH 里指向 npx 缓存：`C:\Users\zhanglu\AppData\Local\npm-cache\_npx\1e7f6d9597241db0\...`

**真 loader 夹具的做法**（前一轮为审 P1 搭的，可复用）
真 `ctx.plugin(Loader)` + `ctx.loader.create({id, name: '@deepseek-ai/dsh-mcp-client', config})`
造真 entry（真 fiber、真 `update()`/`restart()`）；`include` 条目可以只是一个让 `patchPath(ctx)`
能解析的载体（`{options:{id:'include', name:'cordis:include', config:{path}}}`）。
注意：`@deepseek-ai/cordis-plugin-include` / `cordis-plugin-group` **本仓装不了**（MODULE_NOT_FOUND），
这是 O1 卡住的直接原因。

## 产出要求

一份审查报告，结构：

1. **总判**：前一轮的工作，整体是"凑出来的"还是"优雅踏实的"？一句话 + 理由。
2. **逐项审查**（F1-F4、O1-O5）：每项给
   `判定（真修好/凑的/错了/未验证）` + `原始证据` + `更结构性的做法（如果有）`。
3. **你实际做了什么**：如果审出必须改的，改完要有"撤掉改动看测试红"的证据；
   如果只审不改，说清为什么不用改。
4. **没做的事**：明确列出你没能验证的，以及为什么。

## 最后

如果你审完发现前一轮的四个修复其实都是凑的、或者某个"遗留项"的理由不成立——
**明确说，给证据**。这比让报告好看重要得多。
