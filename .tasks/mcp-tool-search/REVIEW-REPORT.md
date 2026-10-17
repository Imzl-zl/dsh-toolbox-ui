# MCP ToolSearch 收尾工作 · 独立审查报告

> 审查者：本轮独立会话（非前一轮执行者）。范围：工作树全部未提交改动（15 个已跟踪文件 +743/-28，
> 12 个未跟踪新文件）与前一轮自述（`docs/mcp-tool-search-design.md` §12、`.tasks/mcp-tool-search/OPEN-ITEMS.md`）。
> 方法：离线（基线测试、全量 diff、撤销/变异实验）+ 真机（隔离 profile + 真实浏览器 + 真 loader 生产形状夹具）。
> 全部实验可复现；原仓工作树零净改动（`git diff --stat` 始终 743+/28-）。
> 纪律：每个结论附原始证据；推理与实测分开标注；改了产品代码必做"撤掉看红"。

---

## 1. 总判

**"真修了，但没修透"。四项修复都经过真实验证（没有凑数的），但 F1/F2 是"补丁式正确"——
症状修了、根因原样保留；F3 真修好且测试比前一轮自述的更强；F4 删得基本干净但留了死代码、
一个永假守卫和 i18n 漏洞。前一轮更系统性的问题是对自己的两次停摆理由（O1/O2）缺少证伪尝试：
都把"仓库根 node_modules 里没有"当成了"做不到"，两者都已被本轮证据推翻。**

| 项 | 判定 |
|---|---|
| F1 | **真修好**（真机点击全链路命中），但"三边齐缺"盲区仍在，根因（手写编译产物）未动 |
| F2 | **读侧真修好**，但 managed 字段清单实缴**五份**手抄，漂移可静默丢数据 |
| F3 | **真修好**，三种宽度真机量测达标；余 3 处残留（含项目小列表下按钮不渲染） |
| F4 | **方向对、基本删净**，但 1 个永假守卫 + 死词条 + 5 个在用字符串缺英文 |
| O1 | **停工理由被证伪**；正确形状已端到端实测；另发现一个前一轮没列的重复条目风险 |
| O2 | **"缺依赖"是事实错误**（就在 .pnpm store）；watcher 机制已部分实验验证 |
| O3 | **非产品缺陷**，但它是"隔离环境 UI 结论不可信"的方法论警示 |
| O4 | **根因确认（引用一字不差）；不是插件该处理的事** |
| O5 | 两种流行解释已排除，确切成因未验证 |

---

## 2. 基线与实验纪律

```
原仓 node --test → tests 712 / pass 712 / fail 0 / 8.9s（前一轮自述的 712 全绿属实）
```

- 撤销/变异实验共 10 个（F1×3、F2×3、F3×2、F4×1、watcher×1），每个先备份、改、跑、恢复；
  全部结束后 `git diff --stat` 复原为 743+/28-，未跟踪文件集不变。
- 真机实验在隔离 profile `ts-review`（测毕已删）；用户 web profile 与 `~/.dsh/sessions` 日志未动。

---

## 3. 逐项审查

### F1 `setDeferAll` 三边契约 —— 真修好，根因与盲区都在

**修复证据**：`lib/index.js:982-983`（`_setDeferAll_decorators = [Remote("setDeferAll")]` + `__esDecorate`）、
`lib/typert.js:83`（`mv('setDeferAll', [deferAllParam], 'DeferAllResult')`）、`lib/client.js:6139`（descriptor）。
三边各 35 条 mcpManager 方法，codec typeSymbol 两侧一致。

**真机全链路（最强证据）**：隔离 profile 真实浏览器点「取消全部延迟」→ 按钮翻转、徽标消失、
patch 文件两个条目变 `defer: false`。客户端 → wire → host → 落盘 + 内存同步 → UI，全通。

**测试非空（变异 A）**：删 index.js:982-983 → `✖ the three contract faces list the same methods in the same order`。

**但盲区被变异 B 直接证实**：把 `setDeferAll` 从**三边同时删掉**（F1 的原始 bug 形态）→
三边比对测试**绿**，只有 typert-manifest 计数（34≠35）红。**该测试守边间漂移，对"均匀缺失"结构性失明，
而 F1 恰恰是均匀缺失。** 前一轮"三边比对守住了它"（OPEN-ITEMS:101）只对不对称退化成立——**前一轮错了**。
它自己在 typert-manifest 新注释里也承认"真正该守的是三边同组"，但"同组"正是失明的那一维。

**根因未处理**：无构建脚本、无 `src/`，`__esDecorate` 是手工维护的编译产物——加一个方法要改
index.js 四处 + typert + client 六处，全靠人记得。更结构性的做法（本轮实证可行）：
**把 `McpManagerGateway.prototype` 当第四边**（实测可导入，36 个方法含 setDeferAll），
一条"每个原型方法必须出现在三份清单"的断言会让变异 B 直接红。
（typert↔client 已有 codec 级 deepEqual：`client-lifecycle.test.mjs:64-92`；缺的正是 host 实现面这一边。）

---

### F2 `entrySpec` 读侧丢 `defer` —— 读侧真修好，根因（五份手抄清单）原样保留

**修复证据**：`mcp-config.js:399-402` 补 `PLUGIN_OWN_CONFIG_FIELDS` 循环。变异实验（删该循环）→
`✖ entrySpec 必须读回 defer` 红。新回归测试三态断言（true/false/undefined）全部取自生产函数
`readManagedMcpServers` 真实返回。

**同类漏读排查（全路径）**：defer 现已全通——entrySpec:399、summarize(index.js:430)、
workspaceServerView(index.js:909)、specToMcpEntry(workspace-config.js:94)、
normalizeEntry(mcp-config.js:283)、项目侧读路径走同一 normalizeMcpImport。
**没有其他漏读点。**

**根因实缴五份手抄**（本轮逐一核实）：
1. `mcp-config.js:13` `MANAGED_CONFIG_FIELDS` 常量（唯一真相源，export 了）
2. `mcp-config.js:390` entrySpec 读侧字面量（9 字段——transport 在 :389 单独处理，与常量**不同形**）
3. `mcp-config.js:418` makeEntry 字面量（10 字段；隔壁 updateEntry:504 已用常量，它没迁）
4. `mcp-config.js:226` warnUnsupported known 集合（超集，另一用途）
5. `index.js:1481` installWorkspaceBuiltins 字面量（10 字段，双引号——`builtinSpec`(mcp-config.js:569) 就是干这个的却没复用）

**漂移实验（实证根因未修）**：往常量加一个 `futureField` → **712 全绿**；
round-trip 实测：`updateManagedMcpPatch` 写出 `futureField: v1`，`readManagedMcpServers` 读回 `undefined`
——**静默丢失、零测试覆盖**。F2 要治的"读写两份清单漂移"，此刻是"一份常量 + 四份手抄"的更糟形态。

**更结构性的做法**：五处全部改引常量（entrySpec 的 transport 特例显式处理）；known 集合从常量派生；
补一条表驱动 round-trip 测试（每个 MANAGED 字段：写→读回必须相等）——这条测试会让上面的漂移实验变红。

---

### F3 「全部延迟」按钮位置 —— 真修好，真机达标，3 处残留

**真实渲染量测**（隔离 profile，serena 已连接 28 工具；fixture 行失败是我把 node 路径写错，非产品问题）：

| 视口 | 面板 | 过滤器行 | 按钮 | 溢出/省略号 |
|---|---|---|---|---|
| 1468×880 | 1000×774 | 288px：83+83+**109** | (441,215) 109×29，第一屏内 | 无 |
| 750×900（≤760 断点） | 全宽 730 | 685px：282+282+**109** | (608,166)，第一屏内 | 无 |
| 470×900（≤480 断点） | 全宽 450 | 405px：142+142+**109** | (328,249)，第一屏内 | 无 |

侧栏列仅 288px，两个 select（各 83px）是仅有的压缩点且文字未截断，按钮不受影响；≤760px 后面板全宽、
行宽反涨到 685px。**位置判断成立，"挤"的担忧不成立。**

**信息架构（两粒度）真机确认**：编辑表单有「延迟加载工具（ToolSearch 按需搜索）」复选框（serena 勾选态），
预告「该服务器 28 个工具，将经 tool_search 按需加载」。全局一键 + 逐服务器都可达。

**测试充分性（两个变异实验）**：
- 变异 A（删 ServerList 渲染处）→ detail-panes 两条真实渲染断言红 → **真渲染断言有效**（前一轮从源码正则升级的方向对了）
- 变异 B（删 McpTab 一处 `toolbarAction: deferAllAction` 接线）→ detail-panes **全绿**，
  只有 `tool-search-wiring.test.mjs:375` 源码计数（===2）红 → **McpTab 接线只靠源码正则守**
- 缺口：≤760/≤480 的 CSS 断点行为无自动化测试（本轮人工三种宽度补测）；测试从不传 `embedded`，
  覆盖不到下面的残留①

**残留①（Important，前一轮和我都 initially 漏了，子审查者抓到、我已核实）**：
`showControls = !embedded || count > CONTROLS_THRESHOLD(6)`（client.js:2237/2077），
项目作用域的 ServerList 是 `embedded: true`（:4368）→ **项目 MCP ≤6 个时，整个控件行（含按钮）不渲染**。
"唯一入口"在项目小列表下不存在——而项目作用域恰恰是一键延迟的另一个写入口（.dsh/mcp.json）。

**残留②（Minor）**：计数口径分裂——client.js:4244 按 `filtered` 算 total/all/title，
host index.js:1229 按 `state.byName`（patch 全部 managed）执行；有筛选时 title「所有 MCP（N 个）」
与完成后 toast「已把 M 个服务器…」同交互两个数。

**残留③ 死代码**：ListFooter 的 `action` 槽（client.js:2009-2018）+ 4 条 `.dsh-mcp-foot-action` CSS（:135-138）
无任何调用方（两个 ListFooter 调用点都不传 action）；docstring 还写着该槽是给"全部延迟"用的，
与 :4254"唯一入口在过滤器行"自相矛盾——本轮 diff 新添。正是 REVIEW-PROMPT 列的"凑"特征第 4 条。

---

### F4 删除 token 估算 —— 基本删净（真死），但 1 个永假守卫 + i18n 漏洞

**删除确认**：`estimateSchemaTokens`/`toolEstTokens`/`fmtTokens`/`stableNames`/`tokenCount`
在 lib/ 与 test/ 代码零残留（grep 实证）。真机：徽标仅「延迟」、编辑模态 `hasTokenEstimate: false`。
变异实验（徽标加回 `~{est} tok`）→ `✖ 延迟徽标不带 token 估算` 红。
CJK 二元分词（tool-search-index.js:15-37，搜索用）与估算是两回事，保留正确。

**永假守卫（Important）**：`tool-search-wiring.test.mjs:383` 守的是 `/estimateSchemasTokens/`（Schemas 复数），
而真实函数名是 `estimateSchemaTokens`（单数，design.md:274 与 REVIEW-PROMPT:98 两处独立记载）——
**即使有人用真名把估算器加回来，这条断言也永远绿**。撤掉改动看测试红的反面教材：这条测试生来就是空的。

**i18n 漏洞（Important，英文用户可见）**：
- **5 个在用字符串无 EN 条目**（已抽查证实）：按钮实际标签 `'全部延迟'`/`'取消全部延迟'`（:4257）、
  详情行 `'已开启（{count} 工具经 tool_search 按需加载）'`（:2517）、预告
  `'该服务器 {count} 个工具，将经 tool_search 按需加载'`（:2786）等——**英文界面主按钮显示中文**
- 死词条：4 条 `{est}`（:837-840，随本 diff 新增即死）+ 2 条从未使用的标签
  `'全部开启延迟'`/`'全部关闭延迟'`（:842-843，实际标签是另一个）——**该翻的没翻，翻了的没人用**
- `client-i18n.test.mjs:159-178` 的 parity 测试只覆盖表驱动标签，抓不到这三类

**删掉的 4 个单测**：真死了（无其他消费者；CJK 映射无第二处需要）。但**原断言无法从 git 取证**——
整个 ToolSearch 功能是未跟踪文件，删除发生在未跟踪文件内（git diff 无相关删除行）。OPEN-ITEMS 说"4 个单测"
无法核数，只能采信。

**文档矛盾**：design.md §8(:216)/§10(:241)/§11(:254) 仍描述估算 UI，§12 无 F4 删除记录——
F1-F4 四项修复的细节都不在 §12（OPEN-ITEMS 说"细节在 §12"不属实，那里只有第四轮的 #17-19）。
文档与代码已是两个真相源。

**"完全删 vs 保留定性提示"之争**：以真机信息量看可辩护（工具数 + per-server 规则 + 徽标状态三样在位），
删除的决策没错；错在执行漏了 i18n 与死代码。

---

### O1 `add` / `removeServer` / `installBuiltins` 只写盘 —— 停工理由被证伪，正确形状已实测

**前一轮推理链断在哪（三个事实，本轮全部亲自证实）**：

1. **"复现不了生产形状"不成立**。两个包都在 npm 上（include 1.0.10 / group 1.0.5，5 秒装好）。
   本轮探针复现了生产形状：真 `ctx.plugin(Loader)` + `ctx.loader.builtins.include = Include` +
   include 条目带 `patches` 层 → 子树物化 mcp 条目、真 mcp-client 连真夹具服务器、工具进活视图。
2. **"缺的只是那个带 [Service.init] 的 group 包装"与事实相反**：`cordis-plugin-group` 的 lib 只有 5 行——
   它是 `@deepseek-ai/cordis-plugin-loader` 里 `Group`（lib/index.js:129-144，`static [EntryGroup.key]=true`
   + `async *[Service.init]()`）的再导出。前一轮拿裸 `EntryGroup` 顶替报 `ensureId` undefined，
   是因为没用对包装类——可用的那个一直在**已安装**的 loader 包里且导出。**前一轮错了。**
3. **loader 无 watch**（loader lib 全文无 watch/chokidar）→ patch 改动不自动物化（O1 现象属实），
   运行中手建条目也不会被重复物化。

**正确形状的端到端实测**（探针：真 Loader + 真 Include 生产形状 + 真 mcp-client + 真 RPC 层）：

| 步骤 | 结果 |
|---|---|
| V1 真 `add()` | note「重启后生效」；loader 条目不变（现象复现） |
| V2 `ctx.loader.create({id,name,config})` **根部创建** | 条目在、工具活、**patch 文件未被改写**（根部 tree.write() 是 no-op） |
| V3 真 `list()` | beta 行 `managed:true, connected, toolCount:1` |
| V4 真 `setDeferAll({defer:true})` | 「已把 2 个服务器切到延迟加载…立即生效」；内存 defer=true |
| V5 真 `update()` 只翻 defer | 内存翻转、command 未丢、note「立即生效」 |
| V6 `includeEntry.subgroup.create(...)` | 条目落进子树、工具活、**patch 文件未被改写** |
| V7 `ctx.loader.remove(id)` | 条目移除、夹具进程退出（哨兵文件为证）、工具消失 |

**OPEN-ITEMS 四个设计疑点，第一个有答案**：「根部条目会不会被划成 external」——**不会**（V3 实测 managed:true）。
代码路径：`externalMcpEntries` 在 profileEntries 非空时要求 `!profileEntries.has && !managedIds.has(id)`，
add() 先把 id 写进 patch，`managedIds` 逃生门兜住；`resolveManagedEntry` 翻全树，根部条目照常解析。

**新发现的生产风险（前一轮疑点没列，子审查者抓到、我已核实代码路径）**：
`loader.create(options, 'include')` 会走 `group.tree.write()`（cordis-plugin-loader:230）→
`Include.write()` 把**含 patch 插入条目的整个 root.data** 写回 base 配置文件
（applyEntryPatches:82 无 id insert 无条件 push）→ 首次 create 就把 patch 条目烙进 cordis.yml，
下次启动 patch 再 insert → **重复条目风险**。`entry.update({config})` 不走这条（noSave 路径），
现有热加载不受影响；受影响的只是未来的 create/remove——**选错 create 入口会引进这个风险**。
（离线无法终验，需真 include 夹具重启一轮。）

**给实现轮的规格**（本轮只审不改）：
- `add()`：writePatch（现状）→ `ctx.loader.create({ id, name: MCP_NAME, config: entryConfigOf(spec) })`
  **根部创建**（V2/V3 实测安全，且天然避开上面的 Include.write() 风险），失败回滚 patch
  （复用 `update()` 已有的 AggregateError 回滚形状）；id 必须与 patch 一致（`resolveManagedEntry` 靠它认人）
- `removeServer()`：`managedLiveEntry` 解析 → `ctx.loader.remove(entry.options.id)`（V7 证明停得干净）→ 再删 patch 行
- `installBuiltins()`：追加条目批量 create（注意 index.js:1481 的字段清单问题，见 F2）
- 未验证：create 失败回滚、reservedIds 并发、Include.write() 重复条目的终验

---

### O2 skills 三个 RPC —— "缺依赖"是事实错误；机制已部分实验验证

- **拦路石不成立（前一轮错了）**：`@deepseek-ai/dsh-fs` 与 `dsh-home-paths` **就在 `.pnpm store`**
  （本轮亲自列出：`@deepseek-ai+dsh-fs@0.2.0-r_…`、`@deepseek-ai+dsh-home-paths_…`）——
  dsh-skill-filesystem 的 peerDeps 被自动装入，只是没在根 node_modules **顶层链接**。
  "依赖树里没有"是错的。隔离 profile 里真技能服务跑着（「skills 服务已就绪」，42 技能）也佐证了这一点。
- **投递机制从推断变实证**：dsh-skill-filesystem lib:37 `watch` 默认 true、:80
  `new SkillWatchManager(ctx, control.invalidate, …)`、:372 chokidar depth:1、:462-469 queueInvalidation→invalidate。
  子审查者用装着的 chokidar@5.0.0 做了本地实验（与插件同策略"临时文件+rename"）：
  bundle 的 SKILL.md 与扁平 .md 都触发 change 事件——**文件变更→watcher 事件这半段成立**。
- **代码路径核实**（skills-file-ops.js 全文）：三个 RPC 确实只写文件；面板状态**刻意从文件读**
  （skills-registry.js:261-266 注释记录真机实测：宿主 summary 是发现缓存、改写后报旧值）——面板显示不依赖 watcher。
  另发现宿主还有个 `observeHostMutation(path)` 同步失效钩子，插件没用（靠 200ms 级异步 watcher，可接受）。
- **未验证**：invalidate → registry 重扫 → 会话可见（后半段，需真宿主）。
  最小第一步：隔离 profile 加临时技能根（别碰用户 ~/.agents/skills）→ 重启 → UI toggle → 新会话 `/` 命令列表。

---

### O3 隔离 profile accent 色 —— 非产品缺陷，但是"隔离环境 UI 结论不可信"的方法论警示

本轮真机把链路走到了底（前一轮"未验证"的部分补上）：

- `--mcp-accent: var(--dsw-alias-brand-primary)`（client.js:59，**无 fallback**）
- 暗色主题下该别名 = `--dsw-static-neutral-bluish-50` = **#f9fafb**（宿主 body 规则定义）；
  **宿主自己的主按钮填充 `--dsw-alias-button-primary-fill` 也是 #f9fafb**，面板既有「添加 MCP」按钮
  计算样式 rgb(249,250,251) 与新按钮完全一致——**面板跟随宿主设计系统，没有不一致**
- 真正的品牌色在另一个令牌 `--dsw-alias-brand-primary-new-colorprimary-new-color`（暗色 #5686fe），插件没引用它；
  静态色板本身是好的（blue-500 #3b82f6）
- **为什么隔离环境会失真**：该 token 由 `dsh-client-ui-theme` 声明；用户 web profile **有** ui-theme
  （cordis.patch.yml:739-742 `preference: system`），而 ts-review 的 patch **没有**——缺 ui-theme 的隔离 profile
  回落到默认主题，所有 accent 结论（包括"按钮够不够明显"）都不可信

**判定**：非产品缺陷、不停摆也成立；但它给了 F3 一个方法论教训——**几何/结构量测（路宽、位置、第一屏）
在失真的隔离环境里依然可信，颜色/视觉重量不可信**。本轮 F3 因此只把几何作为结论依据。
若产品想要品牌蓝主按钮，那是设计决策（动 `--mcp-accent` 取值并过 theme-contract.test.mjs——
该测试只校验别名名合法，不校验色相语义）。

---

### O4 lightvela 拒 `role:"developer"` —— 根因确认；不是插件该处理的事

- **逐字确认**：dsh CLI 实际使用的 pi-ai 0.87.1 `openai-completions.js:896`：
  `const instructionRole = model.reasoning && compat.supportsDeveloperRole ? "developer" : "system";`
  （前一轮记的 :896 对运行版本精确）
- 为什么 lightvela 中招：同文件 detectCompat 对非 OpenRouter 的 provider 默认 `supportsDeveloperRole: true`，
  `auto` 是推理模型 → 发 developer → 网关 400
- 用户 web profile lightvela 块确无 compat 段（本轮亲自读 cordis.patch.yml:658-676）
- **归属判定**：本仓 lib/+test/ 对 lightvela/pi-ai/supportsDeveloperRole **零引用**（grep 实证）——
  插件侧没有处理点，不该动。正确处置：用户 profile 的 `llm-pi-ai` 条目 providers.lightvela 下
  `compat.supportsDeveloperRole: false`，或 pi-ai 收窄探测默认。用户默认模型是 stepfun，不主动切 lightvela 不会撞到。

---

### O5 夹具 MCP 每次连接起两个进程 —— 两种流行解释已排除，成因未验证

- MCP SDK 每 transport 只 spawn 一次（`@modelcontextprotocol/client` stdio.mjs:66 `if (this._process) throw`）
- mcp-client 默认重连初始延迟 500ms（dsh-mcp-client lib:436）→ 观测到的 143ms 间隔二者都不是
- 形态上 = 同一 config 两个连接 owner，最可能是夹具把同一 mcp-client 配置挂了两个 owner；
  真 loader 夹具已删，无法回看——**未验证**。对 pid 集合整体换新的判据无影响，但间歇性双 spawn 会让 pid 断言 flaky。

---

## 4. 额外发现（既有缺陷，不在本 diff 内，真机抓到）

`lib/client.js:5611-5617`：技能 hub 分类的 effect 无 try/catch——注释承诺"取不到就用原始 key"，
但只处理 `result.ok === false`；RPC 抛错时逃逸为 `Uncaught (in promise)`（真机 console 实测，
stack 经 prepareInvocation）。隔壁 :5597 的搜索 effect 就有 catch。Minor，建议补。

---

## 5. "前一轮错了"清单（4 条，均有证据）

1. **OPEN-ITEMS:101「三边比对守住了它」**——变异 B（三边同删）证明该测试对 F1 实际形态（均匀缺失）失明，
   当时只有计数断言红。只对不对称退化成立。
2. **OPEN-ITEMS O1「缺 cordis-plugin-include/group 所以无法复现生产形状」**——`Group`/`EntryTree`/`EntryGroup`
   都在**已安装**的 cordis-plugin-loader 且导出；"缺的只是那个带 [Service.init] 的 group 包装"这句话与事实相反。
3. **OPEN-ITEMS O2「dsh-fs/dsh-home-paths 在本仓依赖树里没有」**——二者就在 `.pnpm store`（peerDeps 自动装入），
   只是没顶层链接。
4. **OPEN-ITEMS:104「F4 整套删除…4 个单测」**——删除本身基本干净，但"整套"漏了 4 条死 i18n 词条、
   2 条错标签的死翻译、5 个在用字符串的英文条目，还留下一个永假守卫；"4 个单测"无法从 git 取证（功能未跟踪）。

---

## 6. 我实际做了什么（全部可复现）

**离线**：基线 712 绿；全量 diff + 12 个新文件通读；10 个撤销/变异实验（F1×3 含"三边同删"原始 bug 形态、
F2×3 含 futureField 漂移 + round-trip 实证、F3×2、F4×1、watcher chokidar 实验）；
node_modules 依赖核查；用户 web profile 只读检查。

**真机**（隔离 profile，测毕已删；用户 profile 与 session 日志未动）：
隔离 profile 重建（bundles 换 web-app、双 MCP 条目带 defer、lightvela compat、danger-full-access）→
真实浏览器三种宽度量测 F3 几何 → 真实点击「取消全部延迟」验证 patch 落盘 → 编辑表单真机确认 →
O3 配色链逐层下钻到宿主令牌定义 → O1 生产形状探针 V1-V7 → O2 技能服务实跑与 watcher 源码确证 →
O4 pi-ai:896 逐字核对。

**未改产品代码**：审出的必须改项都是下一轮实现事；每一项的"撤掉看红"实验已先行证明测试网能守住它们
（F4 的永假守卫除外——它生来就是空的，正因此才要修）。

---

## 7. 没做的事 / 未验证项

1. O1：create 失败回滚、reservedIds 并发、installBuiltins 批量形状、Include.write() 重复条目终验（需重启一轮真 include 夹具）
2. O2：invalidate→registry 重扫→会话可见的后半段（需临时技能根 + 新会话）
3. O5：双 spawn 确切成因（夹具已删）
4. 窄屏断点的自动化测试（人工三种宽度测过，未写成用例）
5. tool-search-index 的 BM25 参数与 catalog 截断算法未逐行细审（主体结构与 DEFAULTS 取舍记录质量高，
   子审查者同结论）
6. F4 删掉的 4 个单测的原断言（未跟踪文件，git diff 不可见）

---

## 8. 给下一轮的清单（按优先级）

1. **O1 实现**：按第 3 节规格实现 add/removeServer/installBuiltins 的 loader 层（**根部创建**），
   先补真 loader 夹具测试（生产形状探针已证明可搭：`builtins.include = Include` + patches 层，零新依赖）
2. **F4 永假守卫**：`test/tool-search-wiring.test.mjs:383` 的 `/estimateSchemasTokens/` 改成真名
   `/estimateSchemaTokens/`（或直接删——函数已不存在，这条断言现在守的是空气）
3. **F2 收尾**：五处手抄清单全部改引常量 + 一条表驱动 round-trip 测试（每个 MANAGED 字段写→读回必须相等）
4. **F3 残留①**：项目作用域 ≤6 服务器时按钮不渲染——showControls 门要为 toolbarAction 开口
   （或把按钮移出控件行）；残留②计数口径统一；残留③删死槽位
5. **i18n**：补 5 个在用字符串的 EN 条目（含主按钮），删 6 条死词条，parity 测试扩到 t() 调用点
6. **F1 补闸**：以 `McpManagerGateway.prototype` 为第四边的"原型方法 ↔ 三份清单"断言
7. **文档**：F1-F4 补进 design.md §12；§8/§10/§11 的估算 UI 描述删掉；F4 与 §12 #10 的矛盾写明
8. **Minor**：deferAllState title 计数与作用面一致化；hub 分类 effect 补 catch
