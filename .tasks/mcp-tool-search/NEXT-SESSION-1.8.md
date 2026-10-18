# 新会话提示词：dsh-toolbox-ui 1.8.0 发版 + 剩余欠账

> 用法：把本文件全文粘进新会话的第一条消息。
> 仓库 `D:\sudy\github\dsh-toolbox-ui`，分支 `main`，**领先 origin 18 个提交**，工作树干净。
> 上一轮（2026-10-18）已提交 `caa3eb8`：0.2.1 宿主适配 + tool-search 目录改 names-only。

---

## 你的任务（按顺序做，1 是第一优先级）

### 1. 发版 1.8.0（用户已确认功能完工，见「已确认的事」）

当前 `package.json` 仍是 `1.7.2`，而那正是 npm 上已发布的版本——**这批功能目前只存在于本地**，
用户装不到。发版清单（缺项会被用例拦，不是靠自觉）：

| 要改 | 为什么 |
|---|---|
| `package.json` → `1.8.0` | release.yml 会校验 tag 与它一致 |
| `.github/release-notes/v1.8.0.md` | `test/package-contract.test.mjs` 拦「bump 了版本却没写稿」 |
| `lib/whats-new.js` 加 1.8.0 条目 | `test/whats-new.test.mjs` 拦「bump 了版本却没写更新内容」；内容与 GitHub notes 不必逐字一致 |
| `README.md` / `README.en.md` 增补 **tool-search 特性段** | 这是当前最大的用户可见缺口：特性清单里**完全没有**「延迟加载 / 全部延迟」，只有兼容性那行顺带提了 ToolSearch |
| `docs/installation.md` / `.en.md` 的安装版本示例 | 现在写的是 `^1.7.2`，要同步到 `^1.8.0` |

做完：`node --test` 全绿 → `npm pack --dry-run` 核对包内容与体积 → 提交。
**打 tag 与推送要先问用户**（tag 会触发 release.yml 真发布）。

### 2. 推送（18+ 个提交）

用户在上一轮只说了"提交"，所以没推。**推之前问一句**（推到 main 会触发 CI；打 tag 会发布）。

### 3. C2：把有依据的参数开放给用户（下一轮的主要功能）

`docs/mcp-tool-search-design.md` 决策 C2、`.tasks/mcp-tool-search/OPEN-ITEMS.md` 第 3 条、
`TUNING-DECISIONS.md` §3.6 都指向这件事。要点：

- 落点：**插件自己 patch 行的 `config`**（`cordis.patch.yml` 里那条 `- id: mcp-manager-ui` 现在是空的），
  不是新开一个设置文件。需要插件类提供 `Config` schema —— 目前**没有**（`DECISIONS.md` F9）。
- 只开放**有证据**的三个：`maxResults`（实测 top5→top10 召回 67%→100%）、`maxCatalogLines`、
  `maxDiscovered`（推导见 TUNING Q2）。
- **不要**开放 `requireDiscovery`（关掉 = 让模型凭记忆调未加载工具，准确性灾难，理由写在 TUNING Q6）。
- `descriptionChars` **已删除**，不要复活；`REMOVED_KEYS` 会拦住任何写回。
- 面板侧：表单 + 中英双语文案 + 断言"改了真的生效"的真 runtime 用例。
- 展示位要先定：`ctx.agents.list()` 可用（F21），"本会话真实生效状态"可做，但产品要决定显示在哪一层。

### 4. 剩余测量：700 工具级目录体积 → 才能决定 `maxCatalogLines`

现状：27 工具实测每行 35.3 字符（`TUNING-DECISIONS` F9）；对 300/700 行只是**外推**，
记录里明确写了"落不到实测量级不许改 `maxCatalogLines`"。
做法：拿一台 100+ 工具的真实 MCP 服务器，抓一次 `catalogSectionText(...).text.length`，
把真实每行均长写进 TUNING Q4，替换外推；然后才允许讨论 300 是否上抬。

### 5. 卫生清理（5 分钟的事）

- 仓库根 `.tmp-pin.cjs` / `.tmp-swap-021.cjs`：上个会话的探针，`.gitignore` 覆盖但该删。
- `%TEMP%\dsh-ui-rev\`：上个会话的隔离场，**里面有 `.credentials.yaml` 副本**，建议整个删掉
  （先问用户，别默认动）。
- `git stash list` 里有一条「判据过宽待重做（扁平 .md 判据 + 名字不一致用例）」——是
  `locateSkill` 的真 bug 修法（文件名 ≠ frontmatter name 时定位不到根）。决定落地还是丢弃，
  别一直挂着。
- O5「一次连接起两个进程」已被真机复现（`OPEN-ITEMS.md` O5 有记录），要定性就按
  "同一 config 的 owner 数"取证。

---

## 已确认的事（**不要再论证一遍**）

1. **支持面只有 0.2.0 与 0.2.1**（用户 2026-10-18 决定；更旧的不考虑，也不为它们留分支）。
2. **目录 names-only 是最终形态**，对齐 Claude Code（延迟工具在 prompt 里只有标识符）。
   `descriptionChars` 已删除。全部证据：`TUNING-DECISIONS.md` F1–F11 / Q1–Q6。
3. **两代 loader 的适配**：启动错误以 `fiber.await()` 为准（`settleLiveEntry`，三个入口共用）；
   移除条目前先置 `disabled`（挡 `Include.write()` 把兄弟 patch 行写回 base）。守卫在
   `test/loader-compat.test.mjs`，**不依赖宿主矩阵**。
4. 基线数字（CLAUDE 改动前后都一样，别当回归）：**0.2.0 = 799/799**；
   **0.2.1（cordis 4.0.5 + loader 1.0.6）= 751/751**（按定义排除 `package-contract`）。

---

## 环境事实（上一轮用的，直接抄）

- node：`D:\soft\nodejs\node.exe`；测试命令 **`node --test`**（不是 `node --test test/`），全量 18–25s。
- 仓库自身的 CI 门槛：`npm test`；`release.yml` 在推 tag 时校验「tag 与 package.json 版本一致 → pnpm install → npm test → npm publish → gh release create」。

### 两套宿主矩阵（本轮新增，务必都跑）

```powershell
$src = 'D:\sudy\github\dsh-toolbox-ui'; $A = Join-Path $env:TEMP 'dshm-A-021-cordis405'
if (Test-Path $A) { cmd /c rd /s /q "$A" }
New-Item -ItemType Directory -Path $A -Force | Out-Null
robocopy $src $A /E /XD node_modules .git .worktrees .serena .ccg artifacts logs /NFL /NDL /NJH /NJS /R:1 /W:1 | Out-Null
cd $A
pnpm install --frozen-lockfile --prefer-offline
pnpm add -D "@deepseek-ai/dsh-agent@0.2.1-rc.2" "@deepseek-ai/dsh-agent-loop@0.2.1-rc.2" "@deepseek-ai/dsh-api-gateway@0.2.1-rc.2" "@deepseek-ai/dsh-atomic-write@0.2.1-rc.2" "@deepseek-ai/dsh-mcp-client@0.2.1-rc.2" "@deepseek-ai/dsh-scope@0.2.1-rc.2" "@deepseek-ai/dsh-skill@0.2.1-rc.2" "@deepseek-ai/dsh-skill-filesystem@0.2.1-rc.2" "@deepseek-ai/dsh-tools@0.2.1-rc.2" "@deepseek-ai/dsh-typert-loader@0.2.1-rc.2" "@deepseek-ai/dsh-typert-protocol@0.2.1-rc.2" "@deepseek-ai/cordis@~4.0.5" "@deepseek-ai/cordis-plugin-loader@^1.0.6"
$files = @(Get-ChildItem test\*.test.mjs | Where-Object { $_.Name -ne 'package-contract.test.mjs' } | ForEach-Object { "test\$($_.Name)" })
node --test @files     # 期望 751/751
```

基线就是仓库本身（0.2.0-rc.2 + cordis 4.0.2）：`node --test` → 期望 799/799。

### 真机点穿（发版前建议再跑一次）

```powershell
$E = Join-Path $env:TEMP 'dsh-eval-names'; New-Item -ItemType Directory $E | Out-Null
Copy-Item 'C:\Users\zhanglu\.dsh\.credentials.yaml' $E   # 只拷凭据
Copy-Item 'C:\Users\zhanglu\.dsh\.env' $E
$env:DSH_HOME = $E
dsh --profile eval --from-default-profile headless --dump-config
dsh plugin --profile eval add D:\sudy\github\dsh-toolbox-ui   # 会自动加进 bundles
# 在 $E\profiles\eval\cordis.patch.yml 插一台 defer: true 的 stdio 夹具 MCP（工具名不含能力词）
dsh --profile eval headless "Use the <能力词> capability and report the exact tally number it returns."
```

判据：模型回报的随机数必须与夹具服务器调用日志里的 tally **完全一致**（证明真调了），
且另一轮"逐字引用目录"应当只看到 `- mcp__<server>__<tool>`。
跑完删 `$E`（含凭据），只杀自己启动的进程，**别碰用户的 `dsh web`**。

---

## 纪律（违反任一条，本轮成果作废）

1. **TDD**：先写失败用例，再改实现；改完跑一次"撤掉改动看红"。
2. **两套矩阵都要绿**（799 / 751），只跑一套当没跑。
3. **断言值从生产代码路径取**，不要在测试里重抄常量。
4. **不静默兜底**：失败要么炸、要么显式记账；删掉的配置键必须显式报错。
5. **文档与实现同步**：模型可见文案、README、docs 都算实现的一部分。
6. **拿不准就写"未验证 + 需要什么证据"**，不要把推导写成实测（`TUNING-DECISIONS` 里
   Q4 的外推就是范例：明确标注，并规定"落不到实测量级不许改数"）。
7. 交付前：`node --test` 全绿 + `git status` 干净 + 提交信息带证据。

---

## 已知的坑（上一轮踩过的）

- 起第二个 DSH 实例时，Chrome 会因 `127.0.0.1` 上累积的 cookie（cookie 不按端口隔离）把请求头撑爆，
  服务端返回 **HTTP 431**，页面表现为 `chrome-error`。用隔离浏览器上下文打开即可。
- `dsh-subprocess-local` 的 runner 在强制 kill 子进程时可能报
  `Windows Job runner exited with exit code 4294967295`。清理时**按 PID 精确杀**，不要用管线批量杀；
  判断"是不是残留"时注意别把自己当前命令的 runner 算进去（用字符串拼接避免自匹配）。
- **绝对不要**动用户的 `~/.dsh/profiles/web`、`~/.dsh/storages/workspace.json`（全 app 共享，用户会话在用）。
  读可以，写不行。
- 真机验证时如果要用用户凭据：只拷 `.credentials.yaml` 与 `.env`，跑完连临时目录一起删。
