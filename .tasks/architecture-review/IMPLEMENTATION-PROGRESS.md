# 实施进度（W1–W4）与验收证据

> 2026-11-06，分支 `feature/unified-tool-loading`（工作树 `.worktrees/feature/unified-tool-loading`）。
> 本文只写**已经改了什么、用什么证据验的、还剩什么**。方案与边界见 SOLUTION.md。

## 1. W1 展示端口 + 两代宿主适配（已完成，本轮未改）

- `lib/tool-search-presentation.js`：一次组装只取一份 snapshot，声明/目录/SDK 三处共用。
- `lib/tool-search-adapter.js`：按能力判代次（不看版本号）；legacy 走 `system-prompt/assemble`
  瀑布，modern 装饰 `SystemPrompt.assemble`（`Symbol.for('cordis.original')` 解代理、`internal/service`
  重绑），失败按清理栈逆序释放。
- 证据：`test/tool-search-adapter.test.mjs`、`test/tool-search-presentation.test.mjs`、
  `test/tool-search-rc22-host.test.mjs`（真实 rc.1 宿主）。

## 2. W2 领域状态、v2 恢复协议、投影端口（已完成，本轮未改）

- `lib/tool-search-discovery.js`（按 agent 隔离的发现集）、`lib/tool-search-state.js`
  （`dsh-tool-search/v2` 有序快照）、`lib/tool-search-projections.js`（同步/异步注册统一）。

## 3. W3 收口：写盘与运行中合成一条链路（本轮完成）

### 3.1 唯一的 live 变更入口

新增 `lib/profile-composition.js`。所有 MCP 行变更（新增 / 编辑 / 启停 / 移除 / 导入 /
内置安装 / 延迟）都走它：

1. 官方 `readProfilePatches` 读**完整有序组合**（bundle → profile → home → CLI overlay → telemetry）；
2. 唯一的写盘函数写 profile patch（原子写 + 版本校验）；
3. 官方 `composeEntries` 判定**这一行在最终有效配置里算不算数**（被更高层覆盖/禁用就当场失败）；
4. 官方 `reconcileProfilePatches(root, patches, name, requiredIds)` **应用整份组合**——
   条目由宿主自己挂起/移除/重启，插件不再调用 `loader.create` / `entry.update` / `parent.remove`；
5. 校验运行中的条目（数量、启用态），失败把盘上内容写回上一份并重新应用，两份失败原因一起报。

删除的重复实现：`assertProfileEffect`（手写组合判定）、`createLiveEntries`、`settleLiveEntry`、
`liveEntrySnapshot`、`restoreLiveEntry`、`restoreRemovedLiveEntry`、`rollbackLiveChange`、
`entryConfigOf`、`toLiveConfigValue`。

两个必须知道的实现细节（都写进了代码注释与 `docs/design.md`）：

- 组合 API 认**根 context**（`ctx.root`）：app-boot 的 `bootstrapIncludes` 是模块内
  `WeakMap<Context, Entry>`，拿插件派生 ctx 去取必然取不到。
- 解析 app-boot 时会做一次**实例探针**（幂等 reconcile）：依赖树里出现两份 app-boot 时，
  副本的函数齐全但没有那个 WeakMap，探针能提前识别并换用另一条解析路径，而不是写盘之后才回滚。
- 移除行之前先置 `disabled`：rc.5 的 loader 1.0.6 卸载钩子会 `Include.write()` 写**已应用树**，
  不置位会把兄弟服务器的 patch 行烙进 `cordis.yml`。这条不变式由 `test/real-host-loader.test.mjs`
  的「base 配置全程不被写回」和 `test/loader-compat.test.mjs` 的移除用例盯住。

### 3.2 所有变更型 RPC 统一返回结构化结果

`persisted`（`applied` / `unchanged` / `rolled-back` / `failed`）、`live`（`applied` /
`unchanged` / `skipped` / `failed`）、`diagnostics[{code,message}]`。覆盖 MCP 面（add/update/
setDisabled/enable/disable/reconnect/removeServer/installBuiltins/importJson/importSource/
setDefer/setDeferAll/updateToolSearchSettings/updateToolLoadingSettings/setWorkspaceToolLoading）、
工作区面（add/update/remove/exclude/builtins/import/copy/reconnect）、技能面（setEnabled/
setModelInvocable/setUserInvocable/removeSkill/importSkill/skillHubInstall，写盘后调
`ctx.skills.invalidateCache()`，否则模型看到的是缓存条目）。

失败仍然抛错（面板按错误显示），错误对象带同一个 `result`；「写盘成功但运行中没生效」不再抛错，
而是 `live: 'skipped'` + 具体原因（例如没有 profile 启动器的部署）。

证据：`test/real-host-loader.test.mjs`「每个变更型 RPC 都返回 persisted / live / diagnostics」
（逐个真调）、`test/profile-composition.test.mjs`（事务/回滚/探针语义）。

## 4. W4 契约单源、客户端拆分、文档与版本（本轮完成）

- `lib/rpc-contract.js`：RPC 契约的**唯一**定义（55 个方法 + `INTERNAL_ONLY` 登记表）。
- `scripts/rpc-contract.mjs`：从它生成 `lib/typert.js` 与 `lib/client.js` 的 descriptor 段，
  校验宿主 `@Remote` 的顺序与名字；`--check` 进 CI（`npm run contract:check`）。
  `test/rpc-contract.test.mjs` 在测试内等价地跑一遍生成比对；`test/package-contract.test.mjs`
  的第四面（网关原型）改为从同一份 `INTERNAL_ONLY` 取登记表。
- 客户端：`lib/client/` 10 个分片（boot / 主题与 CSS / 文案 / 技能模型 / 共享 UI 原子 /
  MCP 面 / 工具页 / 外壳 / 技能面 / 贡献与描述符），`lib/client.js` 仍是单文件产物，
  由 `scripts/build-client.mjs` 拼装并 `--check`（CI 里 `npm run client:check`）。
  分片是构建输入，不随 npm 包发布（`files` 里 `!lib/client`，`test/package-artifact.test.mjs` 断言）。
- 版本 `1.10.0`；`.github/release-notes/v1.10.0.md` 与 `lib/whats-new.js` 的最新条目逐条对账；
  README / README.en / docs/installation(.en) 的版本引用与兼容窗口（rc.5 + rc.1）已更新；
  `docs/design.md` / `.en.md` 增加「写盘与运行中：一条链路」「契约与产物：同一份定义」两节。

## 5. 双宿主与 CI

- `scripts/host-matrix.mjs`：把源码复制到独立安装树，装上指定那一代宿主包跑全量；
  CI 的 `host-matrix` 作业跑两腿（`0.2.1-rc.5` / `0.2.2-rc.1`），每腿用
  `DSH_EXPECT_STEP_TOOLSET` 在**加载期**断言代次，另一代用例按能力跳过并在 skip 文案里写明理由。
  `package-contract` 的开发基线断言改为读 `DSH_HOST_MATRIX_BASELINE`，矩阵腿断言的仍是
  "等于本腿目标"，不是放宽。
- 结果见下一节。

## 6. 当前验证结果

| 环境 | 结果 |
|---|---|
| 本仓库（rc.5，legacy） | 见 §6.1 |
| 隔离 rc.1（`D:/sudy/temp/dsh-review-20261105-2004/0.2.2-rc.1`，同步本树源码 + 同一真实路径的 app-boot 链接 + 本腿 lock） | 见 §6.2 |

本轮修掉的三项真实问题（不是放宽断言）：

1. **rc.1 上 `面板改延迟参数` 用例卡到超时**：夹具的 MCP 行写成 `command: node`（无脚本），
   子进程把 MCP 的 stdin 当脚本读，既不握手也不退出；rc.1 的 mcp-client 在 dispose 时等子进程
   收尾 → `cleanup()` 卡 60s。改成真夹具服务器后两代宿主都是 ~0.1s。
   顺带说明：rc.5 那边因为提前失败所以一直没暴露这个夹具问题。
2. **`update()` 重连失败用例的宿主代次差异**：cordis 4.0.5 的 `Fiber.update()` 里
   `this.restart()` 没有被 await，重启失败会漏一个 unhandled rejection（真宿主 fail-loud
   = 进程退出）；4.1.0 已修。用例改成**从子进程实测 cordis 版本**再按代次断言泄漏次数，
   并把这条宿主缺陷写进 release notes 的「已知问题」。
3. **`test/package-artifact.test.mjs` 把版本写死**（`'1.9.0'`）：bump 版本时变成第三个真源。
   改成读仓库 `package.json` 的版本，断言"打包产物带着仓库当前版本"。

## 7. 未做 / 下一步

- 真实浏览器面板点击复验（本轮的结构化结果只做了 RPC 层与真宿主层证据；面板把 `note`
  直接显示出来，但没有为 `live: 'skipped'` 做专门的状态芯片）。
- 真实模型端到端（沿用 `.tasks/architecture-review/LIVE-PRODUCT-E2E.md` 的隔离脚本）本轮未重跑。
