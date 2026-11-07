# v1.10.0 审查记录

- 审查范围：`cb02d6e..8dc9ab3`（v1.10.0，113 文件，+19594/−2201）
- 审查依据：源码通读 + 隔离安装树实跑 + 四个针对性探针
- 记录时间：2026-11-07
- 结论：**方向正确，但有 1 个发布承诺未落地、1 处 v1.9.0 回归、1 个已证实的运行时不生效缺陷。**

## 一、验证环境

隔离树（仓库自带脚本，不需要新造基础设施）：

```bash
node scripts/host-matrix.mjs --host 0.2.2-rc.1 --dir D:/tmp/dsh-matrix-rc1 --keep
```

结果：

| 腿 | tests | pass | fail | skipped |
|---|---|---|---|---|
| 0.2.1-rc.5（仓库本树） | 970 | 965 | 0 | 5 |
| 0.2.2-rc.1（隔离树） | 970 | 938 | 0 | 32 |

仓库本树的三项闸门同样通过：`contract:check`（55 方法）、`client:check`（10 分片 / 7054 行）、全量测试。

**注意**：970 里有 3 条是 `test/helpers/*.mjs` 被 `node --test` 当成测试执行，其中
`update-failure-scenario.mjs` 末尾硬写 `process.exitCode = 0`，永远通过且白跑 4.9 秒。
真实用例数是 967。

## 二、已确认的问题

### A. 发布承诺未落地：面板根本不读 `persisted` / `live`

`.github/release-notes/v1.10.0.md:23` 与 `lib/whats-new.js:703` 都写「面板现在会分开告诉你两件事」。
实测 `lib/client/` 里对 `persisted` / `live` / `liveReason` 的引用数为 **0**（只匹配到拖拽变量 `drag.live`）。

- `lib/client/70-shell.js:317` —— `flash(successMsg || res.note)`：传了成功文案就完全丢掉宿主 note。
- `enable/disable/setDefer/setDeferAll/reconnect/setWorkspaceExclude` 全部传了固定文案
  （`70-shell.js:337,340,350,354,369,376,378,397`），`live: 'skipped'` 时用户仍看到「已启用 X」。
- `lib/client/70-shell.js:436-441` —— add/update 固定 flash「已保存 {name}」。
- `lib/client/60-tool-loading.js:245-266` —— 策略/参数保存只看 `ok`。
- 失败时 `lib/client/90-contribution.js:338,349` 只保留 `message`/`code`，
  「已回滚」与「状态恢复不完整」无法区分。

处置：要么补一个按 `persisted × live` 分支的结果展示函数，要么把发布说明改成「RPC 返回这些字段」。

### B. v1.9.0 的修复被回退（目录上限输入框）

- v1.9.0（`e87fce6`）：始终渲染 + `disabled: !enabled` + placeholder 建议值
  （见 `e29105f:lib/client.js` 3712-3722 行及其注释）。
- v1.10.0：`lib/client/60-tool-loading.js:312` 变回 `limitOn ? input : null`，placeholder 也没了。
- 对应测试断言同时被反转（`test/tool-search-settings-panel.test.mjs`），
  「打开开关预填 12500」的断言改成测试里手敲 12500。

这是重构时的连带丢失，不是有意改产品。

### C. `update()` 只改 `disabled` 时运行中不生效，却报「立即生效」（**已实测复现，已修复**）

- 根因：`MANAGED_CONFIG_FIELDS`（`lib/mcp-config.js:13`）不含 `disabled`，
  而 `touchesConnection()`（`lib/index.js:690`）只比较这份清单。
  于是只改 `disabled` 的更新走 `applyLive`（只翻 defer 遮罩）分支。
- 实测（真 Loader + 真 stdio 子进程）：

```
update 返回 persisted = applied  live = applied
update 返回 note     = "已更新 profile patch，立即生效"
实测：盘上写了 disabled = true
实测：live 条目 disabled = false，工具仍在
```

- 影响：盘上与运行中不一致，且提示说反了。UI 目前碰不到（表单会原样带回 `disabled`，
  开关走 `enable/disable`），但这是 RPC 层面的真实缺陷。

### D. `persisted: 'failed'` 用于「一个字节都没写」（**已实测复现**）

- `lib/profile-composition.js:285,331`：`persisted: changed ? 'rolled-back' : 'failed'`。
- 实测：内容未变 + live 失败 → 抛 `ProfileMutationError`，`persisted = "failed"`，
  **实际写盘 0 次**。语义上应为 `unchanged`。
- 对照：内容变了 + live 失败 → `persisted = "rolled-back"`，写盘 2 次（NEW → ORIGINAL），正确。

### E. 首次探测会顺带热应用「盘上已改、尚未重载」的外部改动（**已实测复现，已修复**）

- `probeComposition()`（`lib/profile-composition.js:125`）会拿盘上的组合跑一次真 reconcile。
- 实测：外部往 patch 追加一条 beta（未重载）→ 调 `setDeferAll`（只翻遮罩、**不该动条目生命周期**）
  → beta 条目出现且连上（`mcp__beta__echo` 可见）。
- 注释「探一次是幂等的（组合没变，reconcile 不会重启任何东西）」只在「盘上 = 运行中」时成立。
- 附带风险：探测的 catch 把**任何**非 `root Include entry` 的错误都判成「实例正确」
  （`profile-composition.js:133`），真实故障被推迟到后面的 reconcile 才暴露。

### F. 现代宿主上签名永远不生成，能力面却报 `ready`（**已实测**）

- `execute` 调 `viewFor(exec.agent, undefined, exec.toolSet)`（`lib/tool-search-runtime.js:1059`），
  `assemblyTools` 传的是 `undefined`；`caps.modeFor === false` 时
  `modeOf` 走 `inferMode(undefined)` → 恒为 `'native'`（`tool-search-runtime.js:804,863`）。
- 于是 `mode === 'native' ? undefined : ...`（`:1091`）永远短路，签名永不生成。
- 实测（0.2.2-rc.1 + 真 PTC executor）：`ptcSdk.state = "ready"`、`signatures.state = "ready"`、
  `jsonSchemaToTs` 可用、`readSdkSchemas` 能取到带 `output` 的 schema，
  但结果里没有 `signature` 字段。**能力面虚报 ready。**

### G. 两个设置 RPC 绕过了「唯一事务入口」

- `updateToolSearchSettings` / `updateToolLoadingSettings`（`lib/index.js:1711-1875`）直接
  `withPatchWrite` + `writePatch`，不走 `commitProfilePatches`：
  不检查更高配置层覆盖、失败不回滚、失败抛普通 `Error` 而非带 `persisted` 的 `ProfileMutationError`。
- 与提交说明「live 变更只走官方 profile 组合」不一致。

### H. 延迟芯片有两个真相源

- 芯片显示 `deferEffective ?? defer`（`lib/client/50-mcp-panels.js:156`），
  切换方向与「全部延迟」计数却只看 `s.defer`（`lib/client/70-shell.js:333`、`50-mcp-panels.js:55`）。
- 当策略使某台实际延迟、而 `defer` 为 false 时：点芯片看不到变化，却提示成功。

### I. 会话恢复的退路成了死代码

- 投影 init 带 `protocol: META_PROTOCOL_V2`（`lib/tool-search-state.js:358`），
  使 `explicitEmpty` 恒真（`lib/tool-search-runtime.js:788`），
  `deriveMessages` 那条退路（`:791`）永远走不到，与上方注释矛盾。

### J. 宿主 warnings 被丢弃

- `reconcileProfilePatches` 返回既有失败条目的 warnings，`applyPatches`（`profile-composition.js:205`）
  不接返回值，成功路径 `diagnostics` 恒为空数组。

### K. 契约测试只验形状（**订正：契约本身是合规的**）

- `lib/rpc-contract.js:18` 声明变更型方法「必须」带 `{persisted, live, diagnostics}`。
  **实测核对：22 个 MCP + 6 个技能变更方法全部返回这三字段**——技能 5 个直接 `mutationResult(...)`；
  workspace 的 `updateWorkspaceServer` / `setWorkspaceExclude` 在方法末尾返回 `mutationResult`；
  `enable`/`disable`/`importJson`/`setDefer*` 是委托，继承被调方的返回。
  （早前"workspace 8 个 + skills 6 个都没返回"的说法是错的：那次 grep 打在了
  `lib/workspace-runtime.js`，而这些 RPC 的实现其实在 `lib/index.js`。）
- 真正的问题在测试：`test/real-host-loader.test.mjs:335-344` 的 `assertResult` 只检查值落在枚举内，
  返回 `failed` 也算通过；钉住具体值的只有 add 与两条 repeat 用例（`:356-357`）。

### L. 文档与实现不符

- `README.md:48` 说页面叫「工具搜索」、选项是「常驻 / 可搜索」、MCP 不在表内；
  实际 UI 是「工具加载」「常驻 / 按需」（`lib/client/60-tool-loading.js:332,35-36`），MCP 也在表里。
- `docs/mcp-tool-search-design.md:462` 附近 说 `verifyLive` 验「数量、启用态、目标工具出现」，
  实际只验数量（`index.js:1497,1538,1895`）与启用态（`:1391`）。
- `lib/whats-new.js` 中「迟延」为错别字。
- `.tasks/unified-tool-loading/PROGRESS.md:7` 写「895/895」且「未提交、未推送、未发布」，
  实际 970 例，且 v1.10.0 已提交并推送到 `origin/main`。

### M. 小问题

- `lib/client/20-locale.js` 有 9 处重复键（`工具`、`默认`、`读取失败`×2 等），后者覆盖前者。
- `test/helpers/*.mjs` 被当成测试执行（见上，计数虚高 3 条）。
- 仓库无 `.gitattributes`，`core.autocrlf=true`；工作区 `lib/client.js`、`90-contribution.js`
  各有 2 处 CRLF（**blob 内是纯 LF，提交状态干净**），属潜在风险而非现存缺陷。
- `lib/client/60-tool-loading.js:40-98` 的 `BUILTIN_LABELS` 中文硬编码未走 `t()`，
  且混入 chrome-devtools 的工具名（该表只对 `builtin` 生效，属死数据）。
- `lib/index.js:349` 注释 `efreshSkillCatalog` 拼写错误；`:333` 一段 JSDoc 悬空。
- 工具名直接拼进目录行（`tool-search-runtime.js:552`），未过滤换行。

## 三、实测证伪

- **「PTC 会被误判成 `both`、延迟整体失效」** —— 不成立。真 0.2.2 宿主 + 真 PTC executor 下
  `assembly.tools` 只有 `['run_code']`，`inferMode` 返回 `'ptc'`，投影正常。
- **「issue #9 在 PTC 下没修全」** —— 机制存在（`tool-search-runtime.js:922`），但**默认路径有真宿主测试覆盖**
  （`test/tool-search-rc22-host.test.mjs:182-195` 断言手册里不出现 `tool_search`）。
  缺口只在 `requireDiscovery=false`（该键不在用户可配项内）与渲染器降级态，
  而后者不裁手册是刻意取舍（没有渲染器就产不出裁剪后的手册）。属已知限制。

## 四、建议顺序

1. **A + B**：面板结果展示 + 目录上限回归。用户直接可感知，且是本次发布的核心承诺。
2. **C + H**：一处 RPC 语义缺陷 + 一处 UI 真相源。
3. **F + I**：现代宿主签名虚报、会话恢复退路。
4. **G + D + E**：事务入口收敛与语义订正。
5. **K + L + M**：契约测试、文档、小问题。

发版建议：打 1.10.1 修复，不回退 v1.10.0。

## 五、探针位置与复现

均在隔离树 `D:/tmp/dsh-matrix-rc1`（可重生成）：

| 探针 | 验证对象 |
|---|---|
| `probe-modern.mjs` | C 的签名/模式：`inferMode`、能力面、结果字段 |
| `probe-why.mjs` | F 的断点：`readSdkSchemas` 与 `jsonSchemaToTs` 是否可用 |
| `probe-update-disabled.mjs` | C（`update` 只改 `disabled`） |
| `probe-persisted.mjs` | D（`persisted` 语义） |
| `probe-sideeffect.mjs` | E（探测顺带热应用） |

其中 `probe-update-disabled.mjs` 与 `probe-sideeffect.mjs` 直接复用 `test/helpers/loader-host.mjs`
（真 cordis Context + 真 Loader + 官方 `mountRootInclude` + 真 stdio 子进程）。

## 六、本轮修复（C 与 E）

两处都已修复，并各自补了一条真宿主回归用例（`test/real-host-loader.test.mjs`）。

**C —— `touchesConnection` 纳入 `disabled`。**
`disabled` 不进 `MANAGED_CONFIG_FIELDS`（它不是 mcp-client 的 config 字段），但它改变条目生命周期，
所以在判据里单独比较一次。

**E —— applyLive 路径不再解析组合 API。**
`commitProfilePatches` 里改为 `liveOnly ? { api: undefined } : await profileSources(ctx)`。

**踩过的坑（值得记下来）**：第一版把 `profileSources` 整体挪到写盘之后，结果
`enable()` / `removeServer()` / 跨重启用例三条全红。原因是探测那次 reconcile 先按**新内容**跑了一遍，
激活失败被记成"既有失败"，后面真正的 reconcile 就不再判它是新引入的故障，回滚因而消失。
正确做法不是改顺序，而是**在 applyLive 路径上跳过解析**——顺序必须留在写盘之前。

**验证**（先红后绿，红是抽样确认而非逐例）：

| 阶段 | 结果 |
|---|---|
| 撤掉两处修复 | 两条新用例均失败，断言命中的正是缺陷点 |
| 恢复修复 | 两条通过 |
| 全量（0.2.1-rc.5） | 972 例，967 pass / 0 fail / 5 skip |
| 全量（0.2.2-rc.1 隔离树） | 972 例，940 pass / 0 fail / 32 skip |
| `contract:check` / `client:check` | 均通过 |

## 七、做对了的地方
- 写盘与生效收敛到一个事务入口，删掉 7 处自拼 loader 条目。
- 移除前预置 `disabled` 与宿主 `recompose` 自身做法一致（`dsh-app-boot` 3832 行），不是 hack。
- 锁顺序 HMR → 文件锁，嵌套显式报错。
- 双宿主矩阵与 `contract:check` / `client:check` 确实进了 CI，两腿装的是不同代次宿主。
- 无 XSS 面（无 `innerHTML`），外部字符串均经文本节点或属性输出。
