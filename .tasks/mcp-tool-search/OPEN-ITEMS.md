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
>
> **第九轮（O6/O7/O8 方案调研，只调研不改代码）之后的变化**：O6 **推翻了两条旧定性**
> （不是"半失效"、遮罩不是"打在另一条投影上"）并**把方案定为"裁 `tools:sdk` 文本"**
> （实测：PTC 会话从倒贴 3181 字符变成真省 3688 字符）；O7 补到**四条**失效路径、
> 查清**两道门槛都不是官方做法**、拿到**官方中文术语证据**并定了面板语义；O8 三条**都定了结论**。
> ⚠️ 本轮**没有改任何产品代码**（`git status` 干净、738 绿）——方案已定，实现留给下一轮。
> **第九轮的完整证据、我踩的坑、以及"未验证"清单都在 O6 条目的各小节里，动 O6 之前请全读一遍。**
> 下一轮的交接提示词见 `.tasks/mcp-tool-search/NEXT-SESSION.md`。
>
> ⚠️ **本文档的轮次编号有缺口**：§12.3 自称"第五轮"、§12.4 自称"第七轮"，中间没有第六轮小节
> （第六轮内容散在 §12.3 正文里）。**不要靠编号推断时间顺序**，按内容判断。
>
> ## 🔴 第十轮（独立复核 + 方案定稿）：先读 `DECISIONS.md`
>
> 第十轮把第九轮的结论**逐条实测复验**，发现**第九轮有一条断言是错的**，而它是"方案"的地基：
>
> - ❌ 第九轮写「`SDK_RENDERERS` / 渲染器**不在公开面**上」→ **错**。`renderToolsSdk` /
>   `renderToolsSdkPy` / `jsonSchemaToTs` / `jsonSchemaToPy` **都导出**（`dsh-tools:3714`）。
> - 因此 **O6「方案（首选）」里的裁剪器实现细节整段作废**（别再去抠生成物、别数花括号、
>   别给 Python 另写判据）——直接把子集喂给官方渲染器重渲染。**实测逐字节相等。**
> - **O6「更干净的正解（宿主需求，主动权不在我们手里）」整段作废**：不需要求官方。
> - **O8 第 1 条「改注释不改判据」被取代**：两道门槛整个删掉，`applyServerFloor` 成为死代码。
> - **O7「误导的只有面板」对 PTC 不成立**：`deferring=false` 时 `tool_search` 仍可见且返回
>   空结果 + 指向不存在的目录段（已实测）。
> - 第九轮「未验证」里的**最后一个缺口已补上**：真 `dsh-ptc-runtime-node` 跑真程序，
>   守卫拒 → `tool_search` → 调通，闭环成立。
>
> **所有最终决策、证据编号、受影响清单、验证计划、以及被推翻的中间立场，见
> `.tasks/mcp-tool-search/DECISIONS.md`。动 O6 之前先读它。**
>
> ## 🟢 第十一轮（实施）：S1–S9 已落地，O6/O7/O8 的主体闭合
>
> 按 `IMPLEMENT-PLAN.md` 的 S1→S10 实施。**S1–S10 全部跑过**（S10 是"装得上 + 面板出得来"级别，见下），每个阶段都有自己的
> 提交边界与"撤掉改动看红"记录（见提交信息）。落地后的状态：
>
> | 条目 | 状态 |
> |---|---|
> | O6（PTC 净亏） | ✅ **已修**：装配时裁 `tools:sdk`（`lib/tool-search-sdk.js` + runtime 的 `trimSdkSections`）。只在 `mode === 'ptc'` 且 `requireDiscovery` 时裁；前提自检失败一律沿用原文 |
> | O7（面板自相矛盾 / 门槛） | ✅ 门槛整删（`applyServerFloor` / `minServerTools` / `threshold` 连配置键一起，写进来显式报错）；面板预告不再承诺"≤10 不参与延迟" |
> | O8（三条小项） | ✅ 全部按第九轮结论落地（判据删掉而不是改注释） |
> | F18（PTC 无法恢复发现集） | ✅ 已修：`sessionProjections` 内部投影；真服务探针上 fold / unregister / restore 三项全过 |
> | F15（全部发现后仍说"stay deferred"） | ✅ 已修：三处统一到 `D = managed − discovered` |
> | F16（空搜索也淘汰） | ✅ 已修：只在本次有新发现时淘汰（B10） |
> | F10（`tool_search` 空结果） | ✅ 已修：`managed = ∅` 时明确报错（B13） |
>
> ### 仍未做的（本轮确实没做，不要当成已验）
>
> 0. **S10 真机 UI：做到了"装得上 + 面板出得来"，没做到"逐条点穿"**。做法与证据：
>    复制用户的 `~/.dsh/profiles/web`（13.4 MB，`node_modules/dsh-toolbox-ui` 是**实体拷贝**
>    而非符号链接）到临时 `DSH_HOME`，把其中插件目录的 `lib/` 换成**本地工作树**，
>    再 `dsh web --no-open --port 0`：
>    - ✅ 真宿主加载了本轮的插件（无加载错误），面板打开，MCP 面渲染出真实服务器列表
>      （firecrawl 3 工具 / serena 28 工具 / chrome-devtools 32 工具）与「全部延迟」入口。
>    - ⚠️ 改过的那句预告文案（「该服务器仅 N 个工具：…省下的空间可能不多」）**没有点开编辑框看**；
>      它的证据是：出货包里的 `lib/client.js` 确实含新串 + `client-i18n` 中英 parity 全绿。
>    - ❌ 「PTC 会话在 UI 里被真正启用」仍未验：那需要在那个 profile 里有一个 ptc 呈现的 agent，
>      本轮没配。
>    - 📌 顺手记一条**下次会用到的坑**：同一台机器上开第二个 DSH 实例时，Chrome 会因
>      `127.0.0.1` 上累积的 cookie（cookie **不按端口隔离**）把请求头撑爆，服务端返回
>      **HTTP 431**，页面表现为 `chrome-error`。用隔离浏览器上下文（fresh cookie jar）打开即可。
>
> 1. ~~**S10 真机 UI 没跑**~~ → 见上：已跑通"装得上 + 面板出得来"，逐条点穿与 PTC 会话启用仍未验。
> 2. **`both` 模式下的新行为**：仍然零行为（B4）。0.2.1 起该模式已被删除，别为它写代码。
> 3. **面板参数表单（C2）**：下一轮的事。`ctx.agents.list()` 可用这件事没变（F21），
>    "显示真实生效状态"仍可做。
> 4. **`complete section` 部署下裁手册**：仍未验（那种部署会吞掉所有 section）。
> 5. ✅ **已修（2026-10-18）目录形态与 `descriptionChars`**：目录改成**只列工具名**（对齐 Claude Code：
>    延迟工具在 prompt 里只有标识符），`descriptionChars` 与截断逻辑连同该配置键一起删除
>    （写进配置显式报错），三处模型可见文案同步。证据、其余参数的证据等级、以及
>    `maxDiscovered` 的推导见 `TUNING-DECISIONS.md`。**仍欠**：目录体积重量（Q4）与真机点穿。

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

🆕 **2026-10-18 真机复现（仍未定性）**：隔离 `DSH_HOME` + 发布的 `dsh@0.2.0-rc.2` `headless`，
一台真 stdio 夹具服务器，一次连接期间日志里出现**两个不同的 `server-start`**（tally 不同：651218、205276），
`tools-call` 落在第二个。也就是说"双 spawn"**不只是夹具现象**，真宿主 + 真实 MCP 服务器也能复现。
本次没抓时间差/父进程/连接 owner，所以仍不能定性；但**它已经够格升为 O5b**：若要修，先按
`loader.entries()` 与 `ctx.get('mcpClient')` 侧统计"同一 config 的 owner 数"。

---

## O6【缺陷，已实测，方案已定｜未修】PTC 组合下插件**净亏**——不是"半失效"，而且**能真解决**（裁 `tools:sdk`）

> **第九轮重做了这条**：推翻旧定性的两条、把伤害量成数字、把方案从"整体闭嘴"改成"裁 SDK 手册"。
> 被推翻的旧结论留在下面的「旧记录错在哪」。「证据（第八轮实测）」小节**原始输出仍然有效**，
> 但**它支持的那个结论已被推翻**——别照着旧结论做方案。
>
> ⚠️ **第九轮自己踩的坑也要看**（在「方案（首选）」的"代价与坑"里）：第一版裁剪器**静默失败**
> 却报"自检通过"。那一节写的自检要求是拿真金白银换来的，不是理论。

### 旧记录错在哪

1. **"半失效（模型看着完整 schema 却调用即错）"不成立。** PTC 下模型的**原生函数清单里只有 `run_code` 一个**
   （`wireSchemas` 在 ptc 下 `schemas.filter(name === RUN_CODE_NAME)`，`dsh-tools:2840-2843`）——它**没有机会**
   发出 model-direct 的 mcp 调用，`collapses` 那条"调用即错"的拒绝路径**在真实使用里不可达**。
   第八轮测的是**直调**，而直调在 PTC 下**不是模型的可用动作**。
2. **"遮罩生效了，只是遮的是另一条投影"不准确。** 遮罩是 **no-op**：装/不装插件，`assembly.tools` 都是
   `[run_code]`、mcp 数都是 0。它**没有可作用的对象**（`wireSchemas` 早就把 mcp 全滤掉了）。

### 真正的伤害：净亏（第九轮实测，真宿主，PTC 会话 + 30 个延迟工具全未发现）

| | 未装插件 | 装了插件 | 净差 |
|---|---|---|---|
| `renderPrompt` | **9003 字符** | **12184 字符** | **倒贴 +3181** |
| `assembly.tools` 里的 mcp 数 | 0 | 0 | 遮罩 no-op |
| `tools:sdk` section | 8820（推算） | **9533** | +713（`tool_search` 自己也被塞进 SDK）|

多出来的是：目录 2409 + 引导段 359 + `tool_search` 的 SDK 签名 ~713。**外加**：模型每次首次用一个延迟
工具，我们的 guard 会拒一次（"is deferred; call tool_search…"）——**白绕一圈**
（嵌套派发绕过 `collapses` 但**不绕过 guard**，已实测）。

旧记录下面的四条"现象"**仍然真实，但不是模型的真实处境**，原文保留供对照：

**旧的"现象"段**：部署默认 `native`（插件照装）时，如果某个 agent 被 preset 设成 `ptc`，那个 agent 处在一个自相矛盾的状态——

- 它的 `tools:sdk` section 里 **30/30 个 mcp 工具 schema 全在**（含 `tool_search` 自己）；
- 而 `assembly.tools` 里被遮到 0 个（~~遮罩"生效"了，但遮的是另一条投影~~ —— **已推翻：遮罩是 no-op**，见上）；
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

### 可达性（第九轮实测，Q1 的答案）：**出货功能，Web GUI 两步可达**

**不是"只有手写 preset 才会"**，所以结论是**改行为**，不是"把限制写清楚 + 启动日志报出来"。

| 证据 | 内容 |
|---|---|
| `dsh-web-app/presets/ptc.patch.yml`（出货） | 内含 `tool-presentation` 行、`mode: ptc` |
| `dsh-web-app/package.json` 的 `dsh.bundle.patch` | 列了 `./presets/ptc.patch.yml` → 每个 web 部署都声明它 |
| `dsh-base/cordis.patch.yml:310` | 组合 `dsh-ptc-runtime-node` → 该 preset **挂载得起来**（否则 registry 拒挂） |
| `dsh-client-ui-agent-preset` | Settings 里有 roster 卡片 +「Set as new task default」；客户端带 `ptc` 的**出厂帮助文案** |
| 真 `--dump-config`（隔离 profile，**实测**） | `preset-ptc`（`id: ptc`）+ `tool-presentation.mode: ptc` + `ptc-runtime` 全在；`tools` 行是 `mode: !!js process.env.DSH_TOOLS_MODE`（不设 → schema 默认 `native`，`dsh-tools:2670`）|

### 行为规格（第九轮实测，Q2 的答案——旧记录只测了 `sdkSection` 文本与 `collapses`）

30 工具、真宿主、同一进程三个 agent 对照：

| 观测 | native | **ptc** | both |
|---|---|---|---|
| `modeFor(agent)` | native | ptc | both |
| `wireSchemas(agent).schemas` | 31 | **1（只有 `run_code`）** | 32 |
| `sdkSchemas(agent)` | 31 | 31（mcp 30，带 output schema） | 31 |
| `assembly.tools`（mcp 数） | 1（0） | 1（**0**） | 2（0） |
| `tools:sdk` section | 不存在 | 7763 字符，含全部 30 | 7763 |
| 直调 `tool_search` | ✅ | ❌ `only run_code is callable directly` | ✅ |
| **嵌套**（`parent` = 真 run_code execution token）调 `tool_search` | ✅ | **✅ 能用** | ✅ |
| 嵌套调未发现的延迟工具 | ❌ 我们的 guard 拒 | **❌ 我们的 guard 拒** | ❌ |
| 发现后嵌套再调 | ✅ 执行 | **✅ 执行** | ✅ |

**两个关键读数**：
- PTC 下模型的**原生函数清单只有 `run_code`**，所以"直调即错"这条路径**不可达**；
- **嵌套派发绕过 `collapses` 但走完整管线（含我们的 guard）**（`dsh-tools:1306` 的 `parent: exec.token`，
  再进 `prepareExecution` → `guardReason`）。也就是说 **PTC 下插件的完整闭环其实是通的**——
  `tool_search` 能调、guard 能自愈、发现后能执行。**唯一失效的是"省地方"**，而那正是本功能的目的。

### 方案

**首选：裁 `tools:sdk` 的文本（第九轮实测可行，收益最大）**

原理：`tools:sdk` 与 `mcp:<server>` 指令段在**同一个 `assembly.sections` 数组**里，而插件**本来就在改这个数组**
（清空指令段 / 追加目录段 / 清空引导段）。把它的 `text` 换成"只含已加载工具"的版本，**结构上是同一招**。

**实测数字**（PTC 会话、30 个延迟工具全未发现、保留 `tool_search`）：

| | `renderPrompt` |
|---|---|
| 不装插件 | 9003 字符 |
| 装了插件（现状） | 12184 字符 ← **倒贴 3181** |
| **装了插件 + 裁 SDK** | **5315 字符** ← **真省 3688** |

`tools:sdk` 从 9533 → 2664 字符（只剩固定说明 + 空壳类型 + `tool_search` 一条）。

**代价与坑（第九轮亲手踩的，别重踩）**

1. **`renderKey` 两种形态**：合法 TS 标识符**不加引号**（`mcp__srv__t0:`），含连字符等的才 `JSON.stringify`
   （`"defer-me-x":`）。按"都带引号"写 → **删了 0 个**。
2. **第一版自检和裁剪器犯了同一个错误假设**，于是"删了 0 个"却报"自检通过"——**正是本项目禁止的
   "看着成功其实没生效"**。自检必须**不依赖键的形态**。
3. **别用"数花括号"切块**：第三方描述里一个不配对的花括号就能带偏计数。可靠判据是
   **行首第 0 列的 `}`** 做 map 收尾、**`^ {2}` + 键形态**做条目起点。
   宿主把 `description` 用 `\s+` collapse 成**单行**且转义 `*/`（`docLines`），所以描述既不跨行、也撑不破注释。
4. **两个 map 必须同步删**：`ToolName = keyof ToolOutputMap` 而 `tools[K]` 取 `ToolArgsMap[K]`。
5. **自检必须强制，失败要退回兜底**，不是打日志。任何一条不过就**放弃裁剪**（用原文）。这是这条路的
   安全阀：最坏情况 = 退化成"兜底方案"，**绝不会把坏文本发给模型**。

**自检要覆盖（不依赖形态）**：① 两个 map 的剩余条目数**相等**且 = 期望；
② 被删名字不得以任何形态（裸 / 引号）残留；③ 结构锚点还在（`declare const tools:`、结尾 ```` ``` ````）。

**兜底（也是裁剪失败时的落点）：per-agent inert view**

在 `viewFor` / `buildToolSearchView` 里读 **`agent.ctx.tools.modeFor(agent)`**，ptc scope 返回 inert view。
`deferring` **已经是三个入口唯一的闸门**（`assemble` / `guard` / `execute` 都判它），所以这
**不是"三处各加一次判据"**——旧记录担心的"三处可能漂移"**不成立**。
代价：`mode` 要进 `viewRevision`；`tool-search-wiring` 的 stub
（`modeFor: () => toolsMode`）**忽略实参，表达不了"部署 native + agent ptc"**，必须升级
（这也是为什么现有的 `装配：PTC 模式下不启用 ToolSearch` 只覆盖了**部署级** ptc）。
残留：`tool_search` 仍全局注册 → PTC 的 SDK 里仍有它（~713 字符），描述在 PTC 下是假话，
调用会拿到空匹配 + 指向一个不存在的目录段 → **必须改成指名显式错误**（纪律 3）。

**否掉：装配前遍历现存 agent。** (a) agent 动态，安装期看不到；(b) **"遍历现存 agent"这个能力不存在**
——`discoveredStates` / `viewCache` 都是 WeakMap，宿主也没给插件 agent 注册表；(c) "每次 assemble 现算"
就等于 inert view。

**未决（需拍板）：`both` 部署要不要一并启用。** 安装期判据是 `modeFor() === "native"`，于是 `both` **完全不装**
——而实测 `both` 下遮罩**有效**（mcp 30 → 0）。放宽成 `!== "ptc"` + inert view 就顺带打开。
代价：`both` 下 SDK 仍列全量（**SDK 也要一起裁**），且该通路从没在生产跑过。

**更干净的正解（宿主需求，主动权不在我们手里）**：让 `sdkSchemas` / `sdkSection` 支持 per-scope 隐藏集，
或公开一个可传 schema 子集的 SDK 渲染器（`SDK_RENDERERS` 现在**不导出**）。有它就不用解析生成物。

### 未验证（第九轮没做，别当成已验）

- **裁剪后模型能否真写出程序并调通**：需装真 `dsh-ptc-runtime-node`，让程序里 `await tools.mcp__srv__t5(...)`。**最后一个缺口。**
- **Python 渲染器 `renderToolsSdkPy`（`dsh-tools:2432`）没读**。裁剪器的判据（2 空格缩进 / 行首 `}`）
  **只对 TS 渲染器验证过**。若运行时 `language === 'python'`，要么另写判据、要么**按语言门控**（只裁 TS）。
- **发现工具后 SDK 恢复**这条状态转移没测（实现上是 `remove = managed − discovered`，与 `filterManagedTools` 同构）。
- **`both` 模式下 SDK 的裁剪**没测。
- **子 agent / `complete section` 部署**下裁 SDK 的交互没测（`complete section` 会吞掉所有 section，
  裁了也没用——但那种部署下目录段本来也被吞）。
- **真机 UI**：没在跑起来的 web 实例里点过 preset 卡片（隔离实例 8917 返回 401 需鉴权）。
  可达性证据是**出货文件 + 真 dump-config + 客户端 roster 代码**，不是 UI 点击。

### 要补的回归用例（先红后绿，真宿主）

1. **PTC agent 的 `tools:sdk` 不得含未发现的延迟工具**；已发现的必须在里面（含 `tool_search`）。
2. 两个 map 的条目数一致；自检的三种坏形态（键形态假设错 / map 只删一个 / 缩进判据失效）**各自能被抓到**。
3. **同进程 native agent 对照**：遮罩 / guard / 目录 / SDK 全照旧（防回归）。
4. 夹具级：stub 的 `modeFor` 必须区分 `modeFor()` 与 `modeFor(agent)`，断言"部署 native 时仍然安装"。
5. `both` 部署（若决定启用）：遮罩与 SDK 裁剪同时生效。

**反证（撤掉改动看红）**：撤掉裁剪 → 用例 1 红；撤掉 per-agent 判据 → 兜底路径的用例红。

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
但同一 profile 此刻 `managed = 12 < threshold 15` → `deferring = false`，**机制整体没开**。

**"效果断言"有四条独立失效路径（第九轮补到四条，原记录只有两条）**：

| | 门槛 | 证据 |
|---|---|---|
| (a) | per-server：工具数 **≤ 10** 不参与 | 【第九轮实测】8 工具 → `assemblyMcp=8`、无目录、无引导段、指令段原样 |
| (b) | 会话级：可延迟工具 **< 15** 整套不开 | 【第九轮实测】**12 工具** → `assemblyMcp=12`、无目录、无引导段、`tool_search` 仍可见、指令段原样 |
| (c) | **全局开关 `DSH_MCP_TOOL_SEARCH=off`**（第九轮新发现，第三道闸） | 【读码】`deferServersOf` 直接返 `[]`（`tool-search-config.js:50`）；全仓 grep 该变量**只在 runtime/config/npm test 里**，**面板从不读它** → 用户自己拉了总闸，每一行仍报「已开启」 |
| (d) | **PTC agent 收益为零**（见 O6） | 【第九轮实测】倒贴 3181 字符 |

**"机制没开"时运行时的真实行为（实测，非推断）**：`tool_search` **仍注册且可见**、引导段被清空、
无目录段、工具全量可见、指令段原样。所以这几层**不误导模型**，**误导的只有面板**。

### 门槛的出处（第九轮查证，Q1 的答案）：**官方没有这两道门槛**

官方中文文档（第九轮亲手抓，`code.claude.com/docs/zh-CN/mcp`）原话：

> **工具搜索默认启用**：MCP 工具被延迟并按需发现。
> 表格「(未设置)」→ **所有 MCP 工具延迟并按需加载。**

官方**唯一**的阈值模式是按**体积**，不是按个数：

> `auto` —— 阈值模式：预先加载它本来会延迟的工具，**同时它们的定义总计少于上下文窗口的 10%**，
> 一旦达到 10% 就延迟所有工具。

官方的"免除延迟"是**用户按服务器手动指定**（`alwaysLoad: true`），**不是按数量自动豁免**。

| 本仓的门槛 | 真实出处 | 是主流吗 |
|---|---|---|
| `minServerTools: 10` | 官方**博客**一句 "less beneficial"（**程度判断，不是边界**），数字**我们自己定的** | ❌ 官方没这个门槛 |
| `threshold: 15` | 抄**社区实现** lordqyxz 的数字（设计文档 §3.3） | ❌ 不是官方的 |

**两道门槛是我们自己加的保守闸，而且是叠加的**——这就是断层：装 1 台 30 工具的会启用，
装 1 台 12 工具的**啥也没有**。

**一处内部不一致（值得单独看）**：F4 当初**删掉了 token 估算**，理由写得很好——"个数不能代表体积，
3 个工具带几千字描述 vs 50 个工具每个一句话"。**可门槛本身还在用个数当判据。** 15 与 10 的差别，
跟那个被否掉的理由是同一类不可靠。

### 面板要"真"到什么程度（Q2 的答案）

**配置页该显示"配置成什么"，不该显示"会话里现在怎样"。** 论证：
- `deferring` 是 **per-agent**，面板是 **per-config**，**面板里没有会话身份**。要显示效果必须先回答
  "哪个会话"——"最近一个 / 当前一个 / 全部"都是**新的产品定义**，不是措辞改动。
- 插件**连现存 agent 都枚举不出来**（`discoveredStates` / `viewCache` 都是 WeakMap），
  宿主也没给插件 agent 注册表 → 完整的"暴露生效状态"**目前没有数据来源**，
  做了只是把一个假话换成另一个假话（关于一个用户没在看的会话）。
- 所以 `client.js:2778-2779` 那条权衡**是对的，要延续**：面板**内部已经有过一次正确取舍**，
  是徽标 / 详情行 / 按钮文案**违反了它**（表单预告只给真实数据 + per-server 规则，并明说
  "会话级聚合阈值行级看不到，说了就是假话"；而详情行 `已开启（{count} 工具经 tool_search 按需加载）`
  用的是配置数据却说效果话）。
- **但"如果现在开一个会话会怎样"里有一部分是配置可判定的**：全局开关（进程级，无需会话）
  与 per-server 工具数（行内已有 `toolCount`）。这两块**能说真话**，应该显示。

### 术语（Q4 的答案）：官方中文**自己就是两词并用**，不用强行统一

官方中文（`code.claude.com/docs/zh-CN/mcp` 与 `platform.claude.com/docs/zh-CN/.../tool-search-tool`，**第九轮实测抓取**）：

| 英文 | 官方中文 |
|---|---|
| Tool Search（功能名） | **「工具搜索」**（platform 页标题作「工具搜索工具」）|
| `defer_loading`（字段名） | **不翻译**，保留代码字面量 |
| 概念（状态/开关） | **「延迟」/「延迟工具加载」**（小节标题）、「非延迟」「延迟工具」 |
| 概念（机制效果） | **「按需加载」**（动词短语）|
| "Defer a server's tools"（小节标题） | **「延迟服务器的工具」**；相邻有「豁免服务器不延迟」「将工具标记为预先加载或保持延迟」「配置工具搜索」 |

**→ 官方把「状态」叫延迟、把「效果」叫按需加载。OPEN-ITEMS 旧建议"统一到按需加载"方向是错的**
（会离开官方**小节标题**用词，而徽标正是"状态"）。

**建议映射（一个词一个意思，不是砍词）**：
- 功能/工具标识：`Tool search` / `tool_search`（不译）；
- **状态**（徽标、checkbox、详情行"已开启"）：**延迟**（英文 `Deferred`，与宿主渲染一致）；
- **效果**（tooltip、引导语、承诺句）：**按需加载**（英文 on demand）。
- 现在的毛病：`延迟加载工具（ToolSearch 按需搜索）` 把两词塞进一个标签；
  `已开启（N 工具经 tool_search 按需加载）` 用状态数据说效果话。
- 代价：字典中英两侧都要改，`i18n-parity`（缺英文 + 死词条两向）会强制同步——这是好事。

### 方案（第九轮定案）

**① 修文案（做）**：徽标只当"配置标记"；详情行不再断言效果，改成"配置标记 + 真实工具数 + per-server 规则"。
**② 加一条能说真话的横幅（做，无需新 RPC）**：`summarize` 已带 `defer` 与 `toolCount`（`index.js:486-487`），
只需把 `toolSearchDisabled()` 的结果作为**一个服务端布尔**带给列表页，顶部横幅说明"总开关已关，所有服务器都不延迟"。
**③ 完整"暴露生效状态"（暂不做）**：需要 ① 可枚举的 per-agent 效果值（现在没有）、② 会话身份进 RPC、
③ 一个**会话级**展示位。三条都是产品决定。

**门槛去留（需拍板，三选一）**：
- **(a)** 保留门槛，面板说实话（= 上面的 ①②）；
- **(b)** 只留一道门槛（去 per-server，或去会话级）；
- **(c)** 学官方：**用户勾了就生效，不做自动豁免**——把判断权还给用户，面板只负责讲清
  "真实工具数"与"会多一次往返"。

第九轮倾向 **(c) 或 (b)**：`(a)` 是"保留一个我们自己也解释不清的自动决定，然后诚实地把它展示出来"。

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

### 第九轮结论（三条都定了，不用再讨论）

1. **改注释 / 名字，不改判据。**
   **新证据**：这条边界**已经被一条专门的用例钉住**——`test/tool-search-runtime.test.mjs:51`
   （夹具 `small=10` / `big=11`，`minTools=10`，断言只保留 11）。**变异复验**：`>` 改 `>=` →
   **1 条红**（`applyServerFloor: 工具数不超过下限的服务器整体不延迟`，actual 21 / expected 11）。
   所以 `≤10 不延迟` 是**四处**共同编码的语义（代码 + 用例名与断言 + UI 文案 + 设计文档 §5 决策 2 正文），
   只有 `DEFAULTS` 的括号引用与参数名读起来像 `>=`。官方原话是 "less beneficial"（**程度判断**），
   当前取值**比官方保守一档**，是合理选择。
   **代价**：改 `DEFAULTS.minServerTools` 的 docstring，写明"**严格大于**才保留（exclusive floor）"
   并记下"比官方保守一档"。**零行为变更、零测试变更。**
   （若要坚持官方字面：1 个运算符 + UI 文案 `client.js:2782` 的 `≤ 10` + 设计文档 + **反转那条用例**，
   且要论证"10 个工具也值得延迟"。名字 `minServerTools` 建议只在 doc 里点明，不为此做 API churn
   ——它是导出的 `DEFAULTS` 键 + 配置键，`resolveRuntimeConfig:76` 的报错文案也带它。）
2. **改兜底文案**（docstring 描述的是意图，文案是那个"不可用指令"本身）。
   被截断的正是**名字没列出来**的那批，而兜底句让模型 `use "select:<exact name>" once you know the name`
   ——**对它自己点名的对象不可用**。改法：兜底句只留关键词查询；`select:` 的指引留在**正文那句**
   （那里名字确实列着）。
   **代价**：1 处产品字符串 + 1 处注释。**测试不会红**——`test/tool-search-runtime.test.mjs:196`
   只断言 `'2 more deferred tools are not listed here'` 前缀，没钉整句，所以这条改动**当前无回归网**：
   要么顺手把断言补到能区分（例如断言不再含 `select:`），要么接受"改文案无网"。
   目录正文是模型面英文文本，不走 i18n，无字典改动。
3. **合并到 `ownersOf`，别动 `ambiguous`。**
   三处：`tool-search-runtime.js:103-111`（函数，二次命中早退）、`mcp-registry.js:32-36`
   （内联 `filter`，`length===1`，`>1` 时把**全部** owner 记进 `ambiguous`）、`workspace-runtime.js:977-979`。
   形状：`mcp-registry` 导出 `ownersOf(schemaName, serverNames) => string[]`；
   `uniqueOwner` = `owners.length === 1 ? owners[0] : null`；另两处直接用数组。
   **`ambiguous` 的集合语义原样保留**——这正是不能把 `ownersOf` 塌成 `uniqueOwner` 的原因。
   依赖方向**无新边**（`workspace-runtime.js:5` 已 import `mcp-registry`；`tool-search-runtime.js` 已 import `revisionOf`）。
   **代价**：1 个新导出 + 3 处调用点；`ownersOf` 恒分配数组而现版早退——只在视图重建时跑一次
   （735 工具重建本就 52.8ms），影响可忽略但要写进注释。
   **若不合并**：可接受，但**必须把 `tool-search-runtime.js:97-98` 那句"与…同一条规则"改掉**
   （它现在暗示存在一个不存在的共享实现）。**别两边都不动。**

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
