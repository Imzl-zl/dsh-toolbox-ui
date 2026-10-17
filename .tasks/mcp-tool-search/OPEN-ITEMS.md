# MCP ToolSearch：遗留项与未验证清单

> 这份文件记的是**没做完 / 没验证**的事。已修完的四项在文末只列标题防重做，细节在
> `docs/mcp-tool-search-design.md` §12。
>
> 每条都给足了「现象 / 证据 / 为什么停在这里 / 要修需要什么」，因为下一个人（或下一轮
> 会话）没有这次的上下文。**没有证据的条目会明说没有证据**，不要拿推断当结论用。
>
> **第五轮（独立审查后的整改）之后的变化**：O1 已修完并真机验证（见 §12.3 #24）。
> O3 定性为"非产品缺陷、但是隔离环境 UI 结论不可信的方法论警示"。
> **第七轮：O2 已终验（见下）**。剩下的未验证项是 **O5**；O1 的终验缺口（O1R）已在第六轮补上。
>
> **第八轮（独立复核）之后的变化**：修掉三条产品缺陷 + 一处测试空守卫，细节见
> `docs/mcp-tool-search-design.md` §12.5 与文末表格。**新增三条遗留项 O6 / O7 / O8**，
> 都是"需要先定方案再动手"的，不是"忘了做"。
> ⚠️ **本文档的轮次编号有缺口**：§12.3 自称"第五轮"、§12.4 自称"第七轮"，中间没有第六轮小节
> （第六轮内容散在 §12.3 正文里）。**不要靠编号推断时间顺序**，按内容判断。

---

## O1R（已终验）`removeServer` 为什么走 `entry.parent.remove()` 而不是 `ctx.loader.remove()`

**曾经的疑点**：第五轮把 `removeServer` 从"只删 patch 行"修成"真的停掉运行中的条目"时，走的是 `entry.parent.remove(entry.options.id)`。`ctx.loader.remove()` 结尾会调 `entry.parent.tree.write()`，对 include 子树条目那就是 `Include.write()`——审查轮读码认为它会把"含 patch 插入条目的整个 root.data"写回 base 配置，下次启动 patch 再 insert → 重复条目。当时无法终验，因为本仓不依赖 `@deepseek-ai/cordis-plugin-include`，fixture 里 `write()` 是 no-op。

**本轮已终验**（`test/real-host-include.test.mjs`，真 Include 1.0.10 + 真 Loader + 真 ToolRuntime + 真 mcp-client + 真 stdio 子进程，并且真的"重启"——dispose 整个 ctx、用同一对 cordis.yml / cordis.patch.yml 重新起宿主）：

正向（产品代码现在的形状，全绿）：
- `add()` 根部创建 → cordis.yml **一个字节都没动**；重启后 `mcp-a`、`mcp-b` **各恰好一条**、两条连接都在。
- `removeServer()` → 条目没了、工具没了、stdio 子进程退出（哨兵文件）、patch 行删掉、cordis.yml 仍原样；二次重启后只剩 `mcp-b`，无残留。

反向对照（证明这条用例守得住、不是空过）：直接调 `ctx.loader.remove(entry.id)`，**两个后果同时发生**——
1. 条目**没有被移除**（`EntryTree.remove()` 把完整 id `include:<id>` 传给按局部 id 查表的 `EntryGroup.remove()`，查不到就 `if (!entry) return`，静默 no-op）；
2. cordis.yml **被改写**，patch 插入的 mcp 条目（连同另一条）整个被烙进 base 配置。

也就是说走那条路会"既没删掉、又把配置写脏"。变异复验：把产品代码改回 `ctx.loader.remove(entry.id)`，正向用例立刻红。

**遗留的环境事实**（不影响使用，但要知道）：`cordis-plugin-include@1.0.10` 的 peer 要求 cordis ~4.0.5 / loader ~1.0.6，本仓开发基线是 4.0.2 / 1.0.3。这不是新问题——所有 `@deepseek-ai/dsh-*@0.2.0-rc.2` 都要 cordis ~4.0.4，仓库一直在宽于实际的 peer 声明下运行（732 个测试全绿即证据）。该包**只进 devDependencies**：运行时不 import 它，与 `@deepseek-ai/dsh-typert-loader` 同一待遇（宿主进程里才有真 Include）。

---

## O2（已终验，第七轮）skills 三个 RPC 的运行中生效性

**原判定**：`setEnabled` / `setModelInvocable` / `removeSkill` 在 `lib/skills-file-ops.js` 里只有
`writeTextKeepingMode` / `rm`，没有 registry 通知；投递机制**推断**是宿主
`@deepseek-ai/dsh-skill-filesystem` 的 watcher（`watch` 默认 true，chokidar + `fs.watchFile`，
变更调 `control.invalidate`）。推断当时不是实测。

**结论：推断成立，三个 RPC 都在运行中生效。**

**用例**：`test/skills-host.test.mjs` 的 `the three mutating RPCs take effect in the running host,
not only on disk`。夹具 = 临时技能根（`mkdtemp`，绝不碰 `~/.agents/skills`）× 真 `SkillRegistry`
× 真 `dsh-skill-filesystem`（`watch: true`，真机默认）；RPC 引用取自**面板自己的列表路径**
`listSkillViews`，不手写。七条用例覆盖：扁平的启/停、模型面关/开、捆绑的停用、捆绑目录删除
（`unlinkDir`）、扁平文件删除（`unlink`）。每条都断言「新会话**目录**里它在不在、模型/用户两个面
拿不拿得到、正文是否等于盘上那一份」。

**拿到的真证据（invalidate → registry 重扫 → 会话可见）**：

| 证据 | 内容 |
|---|---|
| 正向 | 七条 RPC 全部 `changed:true`，且宿主的**新会话视图**（`ctx.skills.snapshot()` + `ctx.skills.get()`）在 5s 窗口内收敛到盘面状态（实测 200–300ms，受 watcher 的 `stabilityThreshold: 200ms` 支配）。删除两条：目录里**消失**（扁平删 `unlink`、捆绑删 `unlinkDir`，两条是不同代码路径） |
| 反证（撤掉机制看红） | `watch: false` 复跑同一条路径：三个 RPC **全都返回 `changed:true`**，而 registry 一直报 `modelVisible:true`；`removeSkill(bundle)` 之后 **3 秒**目录里仍然报得出那条**目录已被删除**的技能。也就是说没有 watcher 投递时，这三个 RPC 就是「报成功但运行中不生效」——正是当初担心的形态 |
| 负对照（证明探针读的是宿主缓存） | 盯住**同一格**（旁观技能的描述）走 A→B：A 处连读两次目录，两次都是同一个旧值；改盘后等它自己翻成新值。证明「有缓存」且「缓存会被作废」。RPC 之后连**旁观技能**（没被 RPC 碰过）的新描述也在目录里 → 宿主重扫的是**整个根**，不是特判修补某一行 |

**反证的配方**（30 秒可复现，`.tasks/` 里的临时脚本已删——别为一次性反证留脚本）：
把上面那条用例里 `fsProvider` 的 `{ dshHome, agentsHome, watch: true }` 改成 `watch: false`，然后
① 先 `await ctx.skills.snapshot({})`（把缓存填上）→ ② `listSkillViews(hostCtx, {})` 取引用来调三个
RPC（都会报 `changed:true`）→ ③ 反复读 `ctx.skills.snapshot({})`：状态**永远不变**，
`removeSkill(bundle)` 删掉的目录 3 秒后仍被报成一条可被模型调用的技能。改完记得改回来。

**过程中被实测推翻的错误假设**（留给下一个人，省得再踩）：

1. **「宿主有静默改动」不存在**。原打算用「watcher 判据里与技能无关的改动」做负对照，实测
   `isRelevantWatchEvent` 收得极宽：根下 `*.md` 的 `add`/`unlink`、一级的 `addDir`/`unlinkDir`、
   两层以内的 `SKILL.md` 的 `add`/`change`/`unlink` **全都算**。所以**任何**改到技能内容或存亡的
   事件都会触发 invalidate（改描述这种最常见的手工编辑也算）——这也解释了为什么这条链一直好用。
2. **宿主缓存只在目录一侧陈旧，`get()` 永远是盘上最新的**。实测：刚写完文件，同一刻
   `snapshot()` 仍是旧描述，而 `ctx.skills.get('x').description` 已经是新的（`get()` 每次回
   provider 重读正文）。**拿 `get()` 的量做陈旧性断言会恒真**——这是本条用例第一版翻车的地方。

**顺带钉死的一条 wire 事实**：扁平技能的 `kind` 是 flat，但 `entry` 是**带扩展名的文件名**
（`probe-flat.md`，不是 `probe-flat`）。这是 `skills-registry` 的 `matchFlatEntry` 按 realpath 匹配
后返回的**根下条目名**。用例里手写 `entry: 'probe-flat'` 会让 RPC 直接抛 `SkillNotFoundError`
——所以引用一律从 `listSkillViews` 现取（手写 wire 形状的用例测不出真契约，design.md §12.1）。

**残留的三点（都不影响上面结论，但别当成已验证）**：

- **硬前置：这三个 RPC 的生效性依赖 filesystem provider 的 watcher 真的起来了**。watcher 不是
  挂载时就起，而是由 `provider.list()` 里的 `observeRoots()` 拉起（`dsh-skill-filesystem/lib/index.js:93-108`），
  而 `observeRoots` 只**登记**根、`ensureWatcher` → `openStableWatcher` 才开 chokidar。
  所以「某个根上的第一次读取」是这三个 RPC 在该根上生效的前提。
  ⚠️ **别以为 provider 的 `complete:false` 能兜住**（我第一版这么写，读码核对后改掉了）：
  `SkillRegistry.collect()`（`dsh-skill/lib/index.js:265-297`）在**缓存命中时直接返回**
  （`return { entries: cached, cacheable: true }`），`collectFresh` / `collectLayer` 的
  `cacheable=false` 只在**未命中**那条路上产生效果。也就是说：
  **首次读取之前** watcher 就失败 → 不缓存、每次都重扫（这时 `complete:false` 有效）；
  **先有过一次可缓存读取、随后 watcher 失效** → 缓存条目留着，`complete:false` 再也到不了判定点，
  消费者可以**永久**读到陈旧目录。**这一段是读码结论，本轮没实测**（要实测得让 watcher 中途死掉，
  夹具里没有现成的触发手段）。
- **watcher 中途失效（`handleWatcherError` / `scheduleRewatch`）后的行为没测**。代码里那条路也会
  `queueInvalidation()`（所以**失效这个动作本身**不是静默的），但失效之后、没有任何后续文件事件时
  不会自愈——结合上一条，那种状态下缓存会一直陈旧下去。「失效期间做的 RPC 之后会不会补上」没实测。

- **没走 UI 那条最小路径**：没起隔离 profile 做 UI toggle → 新会话 `/` 命令列表。理由是程序化夹具
  能拿到**更强**的证据（同一进程里直接读 `ctx.skills` 的目录，而 UI 只能看见渲染结果），且 UI 路径
  的每一段都已被这条用例覆盖（RPC 入口相同、`listSkillViews` 相同、宿主相同）。若要补 UI 级确认，
  配方在 `.tasks/mcp-tool-search/REVIEW-PROMPT.md` 的「环境事实」一节。

---

## O3（非产品缺陷）隔离 profile 的 accent 主题色注入不对

**现象**：在隔离 profile（`--profile ts-ui*`）起的 web UI 里，整个面板的 accent 色解析成 `#f9fafb`（近白）。实测：

```
--mcp-accent                = #f9fafb
--dsw-alias-brand-primary   = #f9fafb
既有主按钮 backgroundColor   = rgb(249,250,251)
标题色条 backgroundColor     = rgb(249,250,251)
toggle[aria-checked=true]    = rgb(249,250,251)
```

**根因（审查轮已定位）**：该 token 由 `dsh-client-ui-theme` 声明；用户的 web profile **有** ui-theme（`cordis.patch.yml` 里 `preference: system`），而隔离 profile 的 patch **没有**——缺 ui-theme 的隔离 profile 回落到默认主题，所有 accent 结论都不可信。宿主自己的主按钮填充也是同一个 `#f9fafb`，所以**面板跟随宿主设计系统，没有不一致**。

**判定**：非产品缺陷、不停摆也成立。但它给了一条方法论教训——**几何/结构量测（路宽、位置、第一屏）在失真的隔离环境里依然可信，颜色/视觉重量不可信**。若产品想要品牌蓝主按钮，那是设计决策（动 `--mcp-accent` 取值并过 `theme-contract.test.mjs`——该测试只校验别名名合法，不校验色相语义）。

---

## O4（未修，不动用户的 profile）lightvela 网关拒 `role:"developer"`

**现象**：所有发往 `https://token.lightvela.ai/v1` 的请求返回 `400 {"code":"400001","message":"The request is invalid: the request was rejected by an internal MaaS component"}`。

**根因（已实测定位）**：`@earendil-works/pi-ai/dist/api/openai-completions.js:896`——
`const instructionRole = model.reasoning && compat.supportsDeveloperRole ? "developer" : "system";`。
`auto` 是推理模型，于是发 `developer`，而该网关只认 `system`。抓包对照证实：同一条请求把 `developer` 换成 `system` 即 200。

**归属判定**：本仓 lib/+test/ 对 lightvela/pi-ai/supportsDeveloperRole **零引用**（grep 实证）——插件侧没有处理点，不该动。正确处置：用户 profile 的 `llm-pi-ai` 条目 providers.lightvela 下 `compat.supportsDeveloperRole: false`，或 pi-ai 收窄探测默认。用户默认模型是 stepfun，不主动切 lightvela 不会撞到。

---

## O5（附带观察，未深究）夹具 MCP 每次连接起两个进程

真 loader 夹具里，一个 mcp-client 连接会把夹具服务器进程拉起**两次**（实测：两次启动间隔 143ms，同父进程、同 argv）。审查轮已排除两种流行解释：MCP SDK 每 transport 只 spawn 一次（`@modelcontextprotocol/client` stdio.mjs:66 `if (this._process) throw`）；mcp-client 默认重连初始延迟 500ms（dsh-mcp-client lib:436）也与之不符。

形态上 = 同一 config 两个连接 owner，最可能是夹具把同一 mcp-client 配置挂了两个 owner；真 loader 夹具已删，无法回看——**未验证**。对 pid 集合整体换新的判据无影响，但间歇性双 spawn 会让 pid 断言 flaky。

---

## O6【缺陷，已实测，未修｜需先定方案】PTC 组合下插件"半失效"：遮罩打在一条投影上，而模型看的是另一条

**现象**：部署默认 `native`（插件照装）时，如果某个 agent 被 preset 设成 `ptc`，那个 agent 处在一个自相矛盾的状态——

- 它的 `tools:sdk` section 里 **30/30 个 mcp 工具 schema 全在**（含 `tool_search` 自己）；
- 而 `assembly.tools` 里被遮到 0 个（遮罩"生效"了，但遮的是另一条投影）；
- 直调 `tool_search` → `isError:true`：「only `run_code` is callable directly」；
- 同进程对照的 native agent → `isError:false`。

即 §12 自己写的判据「半失效（模型看着完整 schema 却调用即错）比不装更坏」**在跨 scope 组合下真实发生**了。

**证据（第八轮实测，真宿主）**：真 cordis + 真 SystemPrompt + 真 ToolRuntime + 真 dsh-scope；
`ctx.provide('ptcRuntime', { language: 'typescript' })` 最小 stub（`requirePtcRuntime` 只检查服务存在 +
language 命中 `SDK_RENDERERS`，与运行时实现无关）+ 真 `agent.ctx.tools.presentAs('ptc')`。原始输出：

```
deployment default mode = native
plugin installed (deployment default is native)
agent mode = ptc  (deployment default still native)
(a) tools:sdk 段含全部 30 个 schema？ true
    tools:sdk 段含 tool_search？ true
    assembly.tools 里 mcp 工具数 = 0
(b) PTC agent 调 tool_search -> isError = true :: Error: unknown tool "tool_search": only `run_code` is callable directly — ...
    PTC agent 直调 mcp 工具 -> isError = true :: ... only `run_code` is callable directly ...
CONTROL native agent 调 tool_search -> isError = false
```

**根因（读码 + 实测一致）**：装配判据在 `lib/index.js:1131` 读的是**部署默认层**
（`ctx.tools.modeFor()` 不传 scope）。而宿主 `dsh-tools/lib/index.js:2767-2774` 的 `modeFor(scope)`
是按 `layers.chainLayers(scope)` 解析的，`:3090-3094` 的注释明说这个组合正是
`dsh-agent-tool-presentation` 存在的理由（该包 `:47` 调 `presentAs`）。

**为什么停在这里（不是忘了）**：修法要动 `installToolSearchRuntime` 的**装配结构**——
`ctx.tools.register` / `ctx.tools.guard` 都是全局一次的，而"该不该生效"是 per-agent 的。
两条候选路线的取舍我判断不了，需要先做方案调研：

1. **装配照旧，三个入口各自按 agent 短路**：`assemble` / `guard` / `execute` 里判 `modeFor(agent)`，
   PTC agent 直接放行（不遮、不拒、引导段摘掉）。`tool_search` 仍全局注册。
   好处：不动装配结构、不改 RPC。风险：`tool_search` 对 PTC agent 仍"存在"（虽不可调），
   语义上比"整体不装"模糊；且要在三处各加一次判据 = 三处可能漂移。
2. **装配前遍历现存 agent**：装配时若有任何 agent 是 ptc 就不装。好处：保持"全或全不装"。
   风险：agent 是**动态**的（新会话才出现 PTC agent），装配时看不到未来；这正是 `modeFor(scope)`
   与 `defaultMode` 分开的原因。
3. **补 SDK section 整形**（参考实现的 `shapeSdkSection`）：把延迟工具也挡在 `tools:sdk` 外。
   好处：唯一根治、PTC 下功能也能用。代价：碰 `tools:sdk` 投影，与插件"只做 assembly"的
   架构决策（决策 8①）冲突，要重新论证。

**要修需要什么**：先在真宿主里确认 `sdkSchemas` / `wireSchemas` 对 ptc scope 的**完整**行为
（本轮只测了 `sdkSection` 文本与 `collapses`），再定上面三条里走哪条，然后补真宿主回归用例（先红后绿）。

---

## O7【缺陷，已实测，未修｜需先定方案】面板三处自相矛盾，且"机制整体没启用"在 UI 上看不见

**现象**（真渲染实测，隔离实例 1468×880，DOM 直读）：长名服务器 `abcdefghijklmnopqrstuvwxyz012345`（0 工具）
同一屏上同时存在四个说法：

```
行徽标        : "延迟"
详情行        : "工具延迟加载" → "已开启（0 工具经 tool_search 按需加载）"
编辑表单复选框: "延迟加载工具（ToolSearch 按需搜索）"  checked: true
紧邻的预告    : "该服务器仅 0 个工具，不参与延迟（工具数 ≤ 10 时每轮必多一次搜索往返，不划算）"
```

**更隐蔽的一层（第八轮新发现，比上一条重要）**：uiprobe（**12 工具**，过得了 per-server 下限）
的预告是"该服务器 12 个工具，将经 tool_search 按需加载"——**看着完全正常**。
但同一 profile 此刻 `managed = 12 < threshold 15` → `deferring = false`，**机制整体没开**：
这批工具全部常驻、`tool_search` 一次都不会被引导去调。

**未达阈值时的实际行为（实测，非推断）**：`tool_search` **仍注册且可见**、引导段文本被清空、
无目录段、12 个工具全量可见。所以这一层**不误导模型**，**误导的只有面板**——
面板断言的"状态"实际只是"配置标记"，两道门槛（per-server > 10、会话级 ≥ 15）都可能让它不成立，
而 UI 没有任何地方说这件事。`lib/client.js:2778-2781` 附近有注释承认"会话级聚合阈值行级看不到，
说了就是假话"，但没说"那么徽标该叫什么"。

**术语（用户提过）**：整仓同一概念两个词——徽标/按钮用「延迟」「全部延迟」，
tooltip/预告/工具描述用「按需加载」「按需搜索」。官方叫法有据：功能名 **Tool Search**、
开关字段 **`defer_loading`**、Claude Code MCP 文档一节标题 **"Defer a server's tools"**
（`platform.claude.com` 的 `defer_loading` 页、`code.claude.com` 的 mcp-servers 文档）。
宿主侧英文渲染实测为 `Deferred` / `Undefer all` / `Tool deferral`，对得上官方 Defer。
**未验证**：官方中文文档把 `defer_loading` 译成什么（中文页 302 跳到 anthropic.com，没跟上）——别编。
建议统一到「按需加载」（徽标两字可用「按需」），英文保留官方 Defer/Deferred。

**为什么停在这里**：三条候选路线的代价差一个量级，得先定：
① **只改文案**——零接口改动，但"机制没启用"仍然看不到；
② 徽标 `title` 写清两道门槛——仍是"配置标记"语义，没消除歧义；
③ **Host 暴露视图状态**（`deferring` + 每服务器有效工具数）给面板——唯一能消除歧义的做法，
但要动 RPC/接口。**关键约束**：若走 ③，面板现有的 `defer` 字段（"配置标记"）
与新的"生效状态"必须**是两个字段**，不能合并——合并只是把一个歧义换成另一个。

---

## O8（Minor，读码结论，未修｜语义二选一）三条"改判据还是改注释"的小项

三条都不是 bug（代码/单测/UI 三者自洽），但会误导后人。每条只需选一边，**别两边都不动**：

1. **`applyServerFloor` 的 `> minTools` 与被引用的官方原话差一档**（`lib/tool-search-runtime.js:150`）。
   代码用 `(counts.get(owner) ?? 0) > minTools` 才保留，而 `DEFAULTS.minServerTools` 的注释引的是官方
   "<10 tools less beneficial"（按该原话 10 个工具是"值得"的），参数名 `minServerTools`（最小工具数）
   读起来也是 `>=`。选一个：改判据，或改注释+参数名明确写成 exclusive。
2. **`DEFAULTS.maxCatalogLines` 的 docstring 与实现不同**（`lib/tool-search-runtime.js:48`）：
   注释写"超出部分提示模型改用关键词/`select:` 查询"，而 `catalogSectionText` 的兜底文案是
   "…or use `select:<exact name>` **once you know the name**"——但被截断的正是名字没列出来的那批，
   模型无从知道那个名字。措辞可改（影响很小：名字可从工具列表/别处得知）。
3. **`uniqueOwner` 与 `toolInventory` / `applyWorkspaceRestrict` 是同一规则的两种写法**
   （`lib/tool-search-runtime.js:100-108` vs `lib/mcp-registry.js:33-35` / `lib/workspace-runtime.js:978-979`）。
   后两者是同一个内联惯用法（`names.filter(startsWith).length`），字面重复；新的那支是独立函数。
   **语义已实测等价**（`owners.length === 1` ⇔ `uniqueOwner !== null`）。服务器全集确实不同
   （前两者只取全局 loader 条目，新的取"全局 + 项目共享连接"），但那是**消费侧的输入差异**，
   不是判定规则的分歧。可行修法：`uniqueOwner` 提到 `mcp-registry` 一处导出、三处各自消费
   （per-schema 早退还更快）。**代价**：改的是"判定"不是"消费"，`ambiguous` 的集合语义不能顺手改。
   注：`tool-search-runtime.js:97-98` 的注释已写"与…同一条规则"——**注释承认了、代码没合并**。

---


| # | 问题 | 修法 |
|---|---|---|
| F1 | `setDeferAll` 没接上：index.js 漏 `@Remote`、typert.js 漏登记、client.js 漏 descriptor，三边全缺 → 面板点了毫无反应 | 三处补齐 + `test/package-contract.test.mjs` 的三边比对 + **第四边**（`McpManagerGateway.prototype` / `SkillsManagerGateway.prototype` 对账，第五轮补，专治"三边均匀缺失"这个原测试的盲区） |
| F2 | `entrySpec` 读侧漏 `PLUGIN_OWN_CONFIG_FIELDS`（defer）→ 盘上 `defer:true`、面板显示「关闭」，状态与真实相反 | 补读；`test/mcp-config.test.mjs` 新增回归。第五轮把五处手抄字段清单全部收敛到 `MANAGED_CONFIG_FIELDS`，并补表驱动 round-trip 测试 |
| F3 | 「全部延迟」按钮在列表底栏、太小，滚出视野就找不到功能 | 移到过滤器行（第一屏），主按钮 + 闪电图标，唯一入口；`test/detail-panes.test.mjs` 用**真实渲染**断言位置。第五轮修掉三处残留（项目小列表下按钮不渲染、计数口径分裂、ListFooter 死槽位） |
| F4 | token 估算是假精确感（我们不知道用户装了什么 MCP，schema 大小差一个量级） | 整套删除：两个估算函数、两处计算、三处渲染、4 个单测。徽标只剩「延迟」，表单预告只留工具数与 per-server 规则。第五轮修掉永假守卫与 i18n 缺口（补 6 条 EN、删 8 条死词条、parity 扩到 `t()` 调用点） |
| O1 | `add` / `removeServer` / `installBuiltins` 只写盘，运行中进程不生效 | 第五轮修好：writePatch 之后在**运行中的进程**里创建/停掉 loader 条目（根部创建 + `entry.parent.remove`），共用同一个失败回滚形状。`test/real-host-loader.test.mjs` 用真 Loader + 真 mcp-client + 真 stdio 子进程覆盖。剩一条终验缺口见 O1R |
| O2 | skills 三个变更 RPC 的运行中生效性未实测 | **不是缺陷，是未验证**：第七轮搭真夹具验掉了（临时技能根 × 真 SkillRegistry × 真 dsh-skill-filesystem `watch:true`）。三个 RPC 都在运行中生效，投递机制就是宿主的 watcher → `control.invalidate` → registry 重扫。反证：`watch:false` 复跑时三个 RPC 都报 `changed:true` 而 registry 永远不变（删掉的技能 3 秒后还在目录里）。细节见上面 O2 条目 |
| #32 | `select:` 一次取超过 `maxDiscovered` 时，本批靠前的工具被当场重新遮罩，而结果自己写着"按名字直接调" | 淘汰下限抬到本批长度（`Math.max(resolved.maxDiscovered, discoveredNow.length)`），`clampDiscovered` 返回值改为淘汰数。**真宿主先红后绿**：`test/tool-search-real-host.test.mjs` 真 dispatcher 逐个直调 30 个工具断言无一被拒；夹具级用例 `test/tool-search-runtime.test.mjs` 钉"本批不被自己淘汰、下一批按 cap 回落"。变异复验：回退即红。代价（已写进注释）：单次超量 `select` 让累积集临时超上限，但那批 schema 本就已经在提示词里 |
| #33 | **唯一的**"发现即放行"纯函数断言恒为真（`test/tool-search-runtime.test.mjs` 给 3 参函数传了 4 个实参，`state` 落进 `config` → `!requireDiscovery` 早退） | 改成 3 参调用。变异复验（删 `guardDecision` 里 `discovered.has(name)` 短路）：修复前 fail 2 且**不含**这条 → 修复后 fail 4 **含**这条 |
| #34 | `serverDeferTable` 全局族是"后写覆盖"，与注释承诺的 OR 矛盾 → 同名条目的 defer 结论取决于 `loader.entries()` 顺序（用户改不了也看不见） | 全局族改 OR，与项目族同一条合并规则。新增"顺序无关"用例（`[false,true]` 与 `[true,false]` 必须同结论），变异回"后写覆盖"立刻红。**实测推翻一个担心**：同名**不会**让 `uniqueOwner` 歧义（`serverDeferTable` 是 Map，`serverNamesOf` 天然去重） |
| — | `test/tool-search-real-host.test.mjs` 顶部 `const DEFER_CONFIG` 声明后从未使用 | 删除；`globalTools(server, count = 16)` 参数化以支撑 #32 的 30 工具夹具 |
| — | 四处覆盖缺口：`NAME_BONUS`、平手 tie-break、`threshold` 边界、`serverNames` 进 revision（改坏后全量仍绿） | 逐条补"能区分"的夹具并逐条变异复验（全部转红）：查询词不能等于裸工具名（否则走 `isExactName` 的 `Infinity` 短路）；平手 fixture 输入序要**与期望序相反**；阈值边界用 `DEFAULTS.threshold` 现取；`serverNames` 单独变一次。**不补** `descriptionChars`/`maxCatalogLines`/`threshold` 的 revision：安装期固定值，会话内不可能变，补了只会造恒真守卫 |


**F1 的那个讽刺**（第五轮复查后改写）：`test/typert-manifest.test.mjs` 原有 `assert.equal(mcp.length, 34)` 的精确计数，在 `setDeferAll` 缺失时 manifest 恰好还是 34 条——**这条断言把缺口固化成了"正确值"**。已改成 35 并加注释。但第五轮的变异实验进一步证明：即使计数改对，**三边同序比对对"三边同时缺"仍然失明**（那条用例绿，只有计数红）——所以真正补的是第四边。
