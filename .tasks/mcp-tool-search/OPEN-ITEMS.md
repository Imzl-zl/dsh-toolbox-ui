# MCP ToolSearch：遗留项与未验证清单

> 这份文件记的是**没做完 / 没验证**的事。已修完的四项在文末只列标题防重做，细节在
> `docs/mcp-tool-search-design.md` §12。
>
> 每条都给足了「现象 / 证据 / 为什么停在这里 / 要修需要什么」，因为下一个人（或下一轮
> 会话）没有这次的上下文。**没有证据的条目会明说没有证据**，不要拿推断当结论用。
>
> **第五轮（独立审查后的整改）之后的变化**：O1 已修完并真机验证（见 §12.3 #24）。
> O3 定性为"非产品缺陷、但是隔离环境 UI 结论不可信的方法论警示"。
> 剩下的未验证项是 **O2** 与 **O5**；O1 的终验缺口（O1R）已在第六轮补上。

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

## O2（未验证）skills 三个 RPC 的运行中生效性

`setEnabled` / `setModelInvocable` / `removeSkill` **没有实测**。

**代码判定**（`lib/skills-file-ops.js`）：三者只有 `writeTextKeepingMode` / `rm`，无 registry 通知。投递机制推断是宿主 `@deepseek-ai/dsh-skill-filesystem` 的 watcher（`watch` 默认 true，chokidar + `fs.watchFile`，变更调 `control.invalidate`）——**这是读码推断，不是实测**。

**为什么没测**：要起真 `dsh-skill` + `dsh-skill-filesystem`。审查轮已证实拦路石不成立：
`@deepseek-ai/dsh-fs` 与 `dsh-home-paths` **就在 `.pnpm store`**（peerDeps 被自动装入，只是没在根 node_modules 顶层链接）——"依赖树里没有"是错的。隔离 profile 里真技能服务跑着（「skills 服务已就绪」，42 技能）也佐证了这一点。

**要修需要什么**：搭一个夹具：建临时技能根 → 写一个扁平技能 → mount 真 skill 服务 → 调 RPC →
观察 registry 是否反映变更。最小第一步：隔离 profile 加临时技能根（别碰用户 `~/.agents/skills`）
→ 重启 → UI toggle → 新会话 `/` 命令列表。

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

# 已修完（防重做，细节见 `docs/mcp-tool-search-design.md` §12）

| # | 问题 | 修法 |
|---|---|---|
| F1 | `setDeferAll` 没接上：index.js 漏 `@Remote`、typert.js 漏登记、client.js 漏 descriptor，三边全缺 → 面板点了毫无反应 | 三处补齐 + `test/package-contract.test.mjs` 的三边比对 + **第四边**（`McpManagerGateway.prototype` / `SkillsManagerGateway.prototype` 对账，第五轮补，专治"三边均匀缺失"这个原测试的盲区） |
| F2 | `entrySpec` 读侧漏 `PLUGIN_OWN_CONFIG_FIELDS`（defer）→ 盘上 `defer:true`、面板显示「关闭」，状态与真实相反 | 补读；`test/mcp-config.test.mjs` 新增回归。第五轮把五处手抄字段清单全部收敛到 `MANAGED_CONFIG_FIELDS`，并补表驱动 round-trip 测试 |
| F3 | 「全部延迟」按钮在列表底栏、太小，滚出视野就找不到功能 | 移到过滤器行（第一屏），主按钮 + 闪电图标，唯一入口；`test/detail-panes.test.mjs` 用**真实渲染**断言位置。第五轮修掉三处残留（项目小列表下按钮不渲染、计数口径分裂、ListFooter 死槽位） |
| F4 | token 估算是假精确感（我们不知道用户装了什么 MCP，schema 大小差一个量级） | 整套删除：两个估算函数、两处计算、三处渲染、4 个单测。徽标只剩「延迟」，表单预告只留工具数与 per-server 规则。第五轮修掉永假守卫与 i18n 缺口（补 6 条 EN、删 8 条死词条、parity 扩到 `t()` 调用点） |
| O1 | `add` / `removeServer` / `installBuiltins` 只写盘，运行中进程不生效 | 第五轮修好：writePatch 之后在**运行中的进程**里创建/停掉 loader 条目（根部创建 + `entry.parent.remove`），共用同一个失败回滚形状。`test/real-host-loader.test.mjs` 用真 Loader + 真 mcp-client + 真 stdio 子进程覆盖。剩一条终验缺口见 O1R |

**F1 的那个讽刺**（第五轮复查后改写）：`test/typert-manifest.test.mjs` 原有 `assert.equal(mcp.length, 34)` 的精确计数，在 `setDeferAll` 缺失时 manifest 恰好还是 34 条——**这条断言把缺口固化成了"正确值"**。已改成 35 并加注释。但第五轮的变异实验进一步证明：即使计数改对，**三边同序比对对"三边同时缺"仍然失明**（那条用例绿，只有计数红）——所以真正补的是第四边。
