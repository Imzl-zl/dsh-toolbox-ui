# 任务：独立复核 dsh-toolbox-ui 对 issue #8 的修复，是否是「最原生、最省、语义最清晰」的方案

> ⚠ **本文件是第一轮复核的任务书。** 描述的是该轮**开始时**的状态；复核结论与当前状态见
> `ANALYSIS.md` §5（三个机制）与 §10（复核记录）。下面「已知结论」两条已按复核结果改写，其余保持原样。
> 具体地：Q-B2 里的「投射批次加锁」与 Q-C1 里的 `{names, definitions, error, failed, changed}` **都已不存在**，
> 这两问作为历史记录保留（当时的答案见本轮的 findings 与 `ANALYSIS.md` §5.1 / §10）。

## 背景

- 插件仓库：`D:\sudy\github\dsh-toolbox-ui`（纯 JS ESM；测试用 `node --test`；无 lint 脚本）。
- DSH 源码：`D:\sudy\github\deepseek-harness`（monorepo）。重点包：
  `packages/core/{tools,scope,agent,agent-loop}`、`packages/mcp/mcp-client`、`packages/preset/agent-preset-registry`、
  `packages/api/session-controller`、`packages/bundle/{web-app,headless}`、`apps/desktop-host`。
- 当前分支 `fix/issue-8-tool-view`（基线 v1.8.2，**未提交**）。改动集中在 `lib/workspace-runtime.js`。
- **先读**：`.tasks/issue-8-tool-view/ANALYSIS.md`（结论、源码事实、被否方案、测量、边界、复跑命令）。

## 目标（按顺序）

1. **核对事实**：ANALYSIS.md 里的源码结论是否仍成立？有没有被读漏/读错的**原生能力**，能让同一目标更简单地实现？
2. **判断最优**：当前实现是不是「公开 API 下最省」的形态？有没有更优雅的设计（更少机制、更清晰语义、更少缓存）？
3. **给判定**：保持 / 改进（具体到函数与代码）/ 推翻（给出证据）。

## 已知结论（不要重新研究，除非你有反证并给出证据）

- agent scope 的唯一父级槽位在桌面版被 preset 占用（`core/agent-loop/src/agent.ts:130`、`api/session-controller/src/agent.ts:388-399`、`preset/agent-preset-registry/src/index.ts:266`、`core/scope/src/index.ts:72`）⇒ **作用域继承不可行**。
- `tools.view()` / `schemaOf()` 是 **private**（`core/tools/src/index.ts:1186/1290`）⇒ 插件不得使用。
- `mcp-client` 每次工具同步都**整批重建定义**（`mcp/mcp-client/src/connection.ts:172`、`src/tools.ts:117-153`）⇒ 「定义对象身份 = 连接工具代次」。
- 当前方案 = 代次哨兵 + 定义身份对账 + 事件合并 / deny 缓存（**三个机制**，全部公开 API）。原方案里的第四层「投射批次加锁」已在复核轮删除，理由与实测见 `ANALYSIS.md` §5.1。
- 基线 vs 现在（207 工具、真宿主）：首会话约 3–5×、事件路径约 50–100× 的改善；**绝对值在这台机器上能差 2×，判据是同一次交替运行里的 new/base 比值**，见 `ANALYSIS.md` §6。

## 必须逐条回答的问题（每条都要证据）

### A. 原生能力有没有漏？

1. 通读 `packages/core/tools/src/index.ts` 的**公开**方法（`register/restrict/guard/get/schemas` 及类型）：
   有没有“批量定义 / 名字快照 / 工具来源（provider）/ 某 scope 自身贡献（own, contributions）”的公开路径？
2. 通读 `packages/core/scope/src/index.ts`：`createScope(ctx, key, options.parent)`、`bindScopeParent` / `rebind`、
   `chainLayers` / `peek` / `merge`。是否存在多父、合并层、或“在已绑定后追加一个来源”的原生做法？
3. 通读 `packages/mcp/mcp-client/src`（`index.ts` / `connection.ts` / `tools.ts` / `server-context.ts`）：
   除了无载荷的 `tools/change`，有没有可订阅的“工具集变化”信号？`generation` / `defer` / 重连是否对外暴露代次或版本？
4. 通读 `packages/preset/agent-preset-registry/src/index.ts` 的 `Generation` / `join` / `bind` / `rebind` / `users` 引用计数：
   它的语义能不能直接复用给项目 MCP（把“一条项目连接”当成一个代次去组合）？如果不能，卡在哪一行、为什么？
5. 全域搜索是否存在**工作区级**能力的既有机制：`packages/workspace`、`api/session-controller`、`bundle/*`、
   `apps/*` 里有没有 workspace scope / workspace 插件 / per-workspace capability？插件是否本可以挂在那里？

### B. 当前实现是否最省、是否安全？

1. “整批重建定义”这个不变量在源码里是**明确保证**还是巧合？有没有路径能改定义而不换对象
   （例如 `deferLoading`、presentation、reconnect 复用同一个 Client）？如果有，哨兵会漏什么？
2. 事件合并（一个微任务一轮）+ 投射批次加锁（同步块内忽略 `tools/change`）：**有没有可能丢掉外部变更**？
   给出反例或证明（注意：同步代码块内不可能插入别人的任务；但 flush 是异步的）。
3. `denyForExclude` 的缓存键 `(toolsEpoch, 全局 serverName 集合, exclude)` 是否完备？`toolsEpoch` 何时自增、会不会漏？
4. 边界是否都被覆盖：0 工具连接、同名全局实例、`dsh-scope` 双实例泄漏、子代理（scope 已被绑）、HMR/卸载、
   同进程多 app root、连接就地重载、`tools/list_changed`。
5. `checkedEpoch` 这个针对空连接的特例，是不是可以被更简单的机制吸收（例如哨兵换成“代次令牌”）？

### C. 设计是否优雅、语义是否清晰？

1. `readConnectionTools` 返回 `{names, definitions, error, failed, changed}`：每个字段都被用到了吗？能减到几个？
2. 现有机制共四个，能否再减一个？如果减，代价是什么？
3. 对照 ANALYSIS.md §5 的六条不变式逐条读代码：代码是否真的保证了它们？哪条只是注释承诺？
4. 下一个会话最容易改坏的地方是哪里？现有注释/测试是否足以阻止？

### D. 如果上游愿意改一行，最值得改哪一行？

给出 patch（文件 + 行 + 改动）以及它能让插件**删掉哪些机制**、删不掉什么。

## 规则

- 只有**公开 API** 的结论才算“原生”；提到 private/内部字段必须显式标注为“非契约”。
- 每条结论标【读码】或【实测】；实测用 `.tasks/issue-8-tool-view/probes/` 里的脚本，或新写一次性脚本
  （放同一目录，不要留在 `.tmp-*`）。
- 不要为了让测试通过而削弱断言；不要用 no-op / 静默兜底掩盖错误。
- 可以运行：`node --test`、`node .tasks/issue-8-tool-view/probes/{bench,scope-inherit-probe,e2e-probe}.mjs`
  （e2e 的 baseline 变体需先按 ANALYSIS.md §9 生成 `lib/.baseline-workspace-runtime.mjs`）。
- 结论必须落到“改哪个函数/哪一行”，或明确说“不用改”。

## 输出

1. **总判定**：保持 / 改进 / 推翻（一句话）。
2. **findings**：级别（blocker / should-fix / nit）+ 证据（`file:line` 或实测数字）+ 建议改动。
3. 若建议改：最小 diff 思路，以及它替掉了当前哪些机制。
4. 你实际跑过的命令与结果（原样贴关键输出）。
5. 可选：上游最值得改的一行 patch。
