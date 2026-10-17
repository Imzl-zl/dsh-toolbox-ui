# 新会话提示词：MCP ToolSearch 的 O6/O7/O8 —— 独立复核 + 实现

> 🔴 **第十轮已做完复核并把方案定稿。新会话不要从本文开始，从
> `.tasks/mcp-tool-search/DECISIONS.md` 开始**——那里有最终决策、证据编号、
> 受影响清单、验证计划，以及本文中被推翻的断言（尤其"渲染器没导出"那条是**错的**）。
> 本文保留作为**复核方法**的参考：哪些源码必须读、哪些断言怎么验。

> 用法：把本文件全文粘进新会话的第一条消息。
> 你是**独立复核者**，不是上一轮的继承者。**上一轮的结论一律当作"待验证的断言"，不是既定事实。**

---

## 你的角色与第一要务

上一轮（第九轮）做的是**方案调研，零代码改动**，产出在
`.tasks/mcp-tool-search/OPEN-ITEMS.md`（O6 / O7 / O8 三条已被重写）与
`docs/mcp-tool-search-design.md` §12.6。

**它犯过一个具体错误，你必须引以为戒**：它在 O6 上先写了"插件够不到 `tools:sdk`，所以做不到"，
**只读了两处源码就下了否定结论**；后来真去试，发现**能做**，而且收益很大。
它自己的复盘是："**读码推断只能得出'这条路不清楚'，不能得出'这条路不通'**。"

所以你的第一要务：

1. **把下面「必读源码清单」读完再下任何结论。** 尤其是标了「上一轮没读」的那几个。
2. 对上一轮的每条断言，**自己跑一遍**再决定采信与否。它给的数字都附了配方。
3. **没实测的写「未验证 + 需要什么证据」**，不要把读码推断写成"已验证"。

**允许的结论包括**：「上一轮错了」「维持现状 + 把限制写清楚」「需要用户决策」。
**硬造补丁是最坏的结果。**

---

## 环境事实（前几轮真金白银换来的，直接用）

- node 在 `D:\soft\nodejs\node.exe`；测试命令 **`node --test`**（不是 `node --test test/`），
  全量约 10–18s，**基线 738 绿**。
- **绝对不要动用户的 `web` profile**（`~/.dsh/profiles/web`），也**不要点杀父进程是
  `dsh lib/bin.js web` 的 serena**。`~/.dsh/storages/workspace.json` 是全 app 共享的，
  用户会话也在用。**读**用户 profile 是可以的（只读不写）。
- 隔离环境：`$T = "$env:TEMP\dsh-ui-rev"`，`DSH_HOME` 指向它，profile/storages/sessions 全隔离。
  启动姿势：
  ```
  $env:DSH_HOME = $T
  dsh --profile uirev --from-default-profile headless --dump-config | Out-Null
  dsh plugin --profile uirev add D:\sudy\github\dsh-toolbox-ui
  # 必须把 <profile>\package.json 的 bundles 换成
  # ["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app","dsh-toolbox-ui"]
  dsh --profile uirev --no-open --port 8917 --host 127.0.0.1
  ```
  上一轮的实例探测时**在监听但返回 401（需鉴权）**。你没拿到 token 就用程序化探针，
  别为此去翻用户的凭据。
- 宿主包在 `C:\Users\zhanglu\AppData\Local\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\`。
- **探针脚本放仓库根的 `.tmp-*.mjs`**（`.gitignore` 里就是给"一次性实跑脚本"的），**用完删掉**。
  别在仓库留截图（要么内联，要么存进仓库再删）；截图**不能**存 `~/.dsh/attachments/`（会被拒）。
- 交付前必须：`git status` 干净 + `node --test` 全量绿。**没动代码就不要制造 diff。**

---

## 必读源码清单（读完再动手）

宿主包根目录记为 `$H = ...\node_modules\@deepseek-ai`。

### A. `$H\dsh-tools\lib\index.js`（3714 行，本任务的核心）

| 位置 | 为什么必须读 |
|---|---|
| `:1729 renderToolsSdk` | **TS SDK 渲染器**。裁剪 `tools:sdk` 的**全部依据**都在这里 |
| `:2432 renderToolsSdkPy` | **Python 渲染器 —— 上一轮完全没读**。裁剪判据（2 空格缩进 / 行首 `}`）**只对 TS 验证过** |
| `:1494 pad$1` / `:1498 docLines$1` / `renderKey`（含 `IDENTIFIER$1`） | 键形态（裸 vs 引号）、行结构、描述是否跨行 |
| `jsonSchemaToTs` | 类型渲染：**一个条目的类型是否可能多行**（决定"按行切"是否够用） |
| `:2665`（Config）/ `:2670` | `mode` 的枚举与**默认值 `native`** |
| `:2703-2711`（constructor） | `defaultMode` vs `presentAs`；PTC 部署才注册 `tools:sdk` section |
| `:2745 sdkSection` / `:3027 sdkSchemas` / `:2959 view` | SDK 文本 = `SDK_RENDERERS[lang](sdkSchemas(scope))`，而 `sdkSchemas` 读 `view(scope).visible`。**这是"assembly 过滤够不到它"的根据** |
| `:2831 wireSchemas` | PTC 下**只回报 `run_code`**（`:2840-2843` 是根因） |
| `:3099 collapses` / `:3100` | model-direct 才拒；`nested` 绕过 |
| `:2767 modeFor` / `:2810 presentAs` / `:2979` | per-scope 解析；`view()` 在非 native 时把 `run_code` 塞进 visible |
| `:1306`（`parent: exec.token`） | **`run_code` 的嵌套派发**从哪来 |
| `:3131 createExecution` / `:3185` / `:3214 prepareExecution` / `:3241 guardReason` | 证明**嵌套派发绕过 collapses 但走完整管线含 guard** |
| `:2518 SDK_RENDERERS` / `:965 resolveFlavor` / `:2863 requirePtcRuntime` | 渲染器表与语言如何解析 |
| `:3714`（文件末尾的 `export`） | 🔴 **渲染器是导出的**：`renderToolsSdk` / `renderToolsSdkPy` / `jsonSchemaToTs` / `jsonSchemaToPy` 全在公开 export 列表里。**旧版此处写"没有导出"是错的**（第十轮实测证伪，见 `DECISIONS.md` F3） |

### B. `$H\@deepseek-ai\dsh-agent-tool-presentation\lib\index.js`（51 行，全读）

`presentAs` 是**按挂载 scope** 声明的；`mode` 必填；ptc 需要 `ctx.ptcRuntime`。

### C. preset 的出货路径（可达性）

- `$H\dsh-web-app\presets\ptc.patch.yml` —— 出货的 PTC preset（`tool-presentation` / `mode: ptc`）
- `$H\dsh-web-app\package.json` 的 `dsh.bundle.patch` —— 确认四个 preset 都在补丁链里
- `$H\dsh-web-app\cordis.patch.yml` —— `tools` 行的 **`DSH_TOOLS_MODE` 临时env seam**（注释明写
  "unset keeps the schema default (native)"）、`agent-preset-registry`（`default: standard`）、
  `ui-agent-preset`（"General settings 里的 agent-preset 行"）
- `$H\dsh-base\cordis.patch.yml:310` —— 组合 `dsh-ptc-runtime-node`（否则 preset 挂不上）
- `$H\dsh-client-ui-agent-preset\lib\client.js` —— roster 卡片 /「Set as new task default」/
  `ptc` 的**出厂帮助文案**（`guidePtcIntro` / `guidePtcExplanation`）

### D. `$H\dsh-system-prompt\lib\index.js`

`assemble` 的 section 合并、**complete section 会吞掉所有 section** 的规则、
`renderPrompt` 的 `.filter(text => text.length > 0)`。

### E. 本仓

- `lib/tool-search-runtime.js`（**全文**，569 行）——装配、视图、guard、目录段
- `lib/index.js:1114-1140` —— **装配点**：`modeFor()` 无参 = 部署默认层
- `lib/client.js:2770-2790`（表单预告与那条注释）、`:2282`（徽标）、`:2513-2514`（详情行）
- `test/tool-search-wiring.test.mjs`（`:77-80` 的 stub、`:393`、`:423`）
- `test/tool-search-real-host.test.mjs`（真宿主夹具的样子，可直接改造成新用例）

---

## 要独立复核的断言（逐条自己验）

### O6

| # | 上一轮的断言 | 怎么验 |
|---|---|---|
| 1 | PTC 下 `wireSchemas(agent).schemas` **只有 `run_code`**；`assembly.tools` 里 mcp 数 **0**（装/不装插件都一样） | 真宿主三 agent（native/ptc/both）对照，读 `modeFor` / `wireSchemas` / `sdkSchemas` / `assemble().tools` |
| 2 | **嵌套派发绕过 `collapses` 但经过我们的 guard**：PTC agent 用 `parent` = 真 run_code execution token 调 `tool_search` 成功；调未发现的延迟工具被我们的 guard 拒 | `tools[TOOL_RUNTIME_SCHEDULER].prepare({name:'run_code',…})` 拿真 token，再 `tools.execute({…, parent: token})` |
| 3 | **裁 `tools:sdk` 可行**：9533 → 2664 字符；PTC 会话 12184 → **5315**（不装插件是 9003） | 在 `assembly.sections` 里替换 `tools:sdk` 的 `text`，重算 `renderPrompt` |
| 4 | 裁剪器的两个坑：`renderKey` **裸标识符不加引号**；**别用数花括号切块**（改"行首第 0 列的 `}`"） | 造含连字符的服务器名（引号形态）+ 含**净失衡**花括号的第三方描述 |
| 5 | **可达性 = 出货功能、Web 两步可达** | 出货文件 + `dsh --profile uirev --dump-config` 里找 `preset-ptc` / `mode: ptc` / `ptc-runtime` |
| 6 | 伤害是**净亏 +3181 字符**（不是"半失效"） | 同一探针里跑"装/不装插件"对照 |

**上一轮明确没做、你要补的（O6）**：
- **`renderToolsSdkPy` 没读**：Python 语言下裁剪判据是否成立？不成立就按语言门控。
- **裁剪后模型能否真写程序并调通**：装真 `dsh-ptc-runtime-node`，程序里 `await tools.mcp__srv__t5(...)`。**最后一个缺口。**
- **发现工具后 SDK 是否恢复**（实现上是 `remove = managed − discovered`）。
- **`both` 模式下 SDK 的裁剪**。
- **子 agent / complete-section 部署**下的交互。
- **真机 UI**：没在跑起来的实例里点过 preset 卡片（8917 返回 401）。

### O7

| # | 断言 | 怎么验 |
|---|---|---|
| 7 | **"效果断言"有四条失效路径**：per-server ≤10 / 会话级 <15 / `DSH_MCP_TOOL_SEARCH=off` / PTC | 前两条：探针量 8 与 12 工具服务器的 `assemblyMcp` / 目录段 / 引导段。第三条：走**真配置桥** `deferServersOf`（**别像上一轮那样自己塞 `deferServers`，那是探针伪影**）。第四条见 O6 |
| 8 | **两道门槛都不是官方做法** | 抓官方中文 `code.claude.com/docs/zh-CN/mcp`：「工具搜索默认启用」「(未设置) → 所有 MCP 工具延迟并按需加载」；`auto` 是按**体积** 10%；免除靠**用户手动 `alwaysLoad`** |
| 9 | **术语：官方中文自己两词并用**（状态=延迟 / 效果=按需加载）；旧建议"统一到按需加载"方向错 | 同一页的「延迟服务器的工具」小节标题 + 「按需加载」动词短语；`platform.claude.com/docs/zh-CN/.../tool-search-tool` |
| 10 | 面板语义：`deferring` 是 per-agent、面板是 per-config、**插件枚举不出 agent**（两个 WeakMap） | 读 `lib/client.js:2775-2783` 的注释 + `lib/tool-search-runtime.js` 的 `discoveredStates` / `viewCache` |

### O8（三条已定结论，只需确认）

| # | 结论 | 复核方式 |
|---|---|---|
| 11 | `applyServerFloor` 的 `> minTools`：**改注释不改代码** | 跑一次变异：`>` → `>=` 应当**恰好 1 条红**（`test/tool-search-runtime.test.mjs:51`，夹具 10 vs 11，actual 21 / expected 11） |
| 12 | `maxCatalogLines` 兜底文案：**改文案**（`select:` 对被截断的那批不可用） | `test/tool-search-runtime.test.mjs:196` 只断言前缀，**改文案不会红**——你要决定要不要顺手补断言 |
| 13 | `uniqueOwner` 三处：**合并到 `ownersOf`，不动 `ambiguous`** | 读三处（`tool-search-runtime.js:103-111` / `mcp-registry.js:32-36` / `workspace-runtime.js:977-979`）；确认依赖方向无新边 |

---

## 纪律（项目自己的，按它判）

1. **"做不到"这类否定结论，必须真的试过再下。** 上一轮就是在这里翻车的。
2. **自检不能和被测代码共享同一个假设。** 自检要能不依赖形态（条目计数对账 + 内容残留 + 结构锚点）。
3. 先写失败测试再实现；改了产品代码要跑一次「撤掉改动看测试红」证明测试网不是空的。
4. 断言值从生产代码路径取，不在测试里重抄常量。
5. **不静默兜底**：失败要么炸要么显式记账；**不允许"看起来成功了其实没生效"**。
6. 真宿主契约必须有真宿主用例——手写夹具会系统性漏掉宿主校验。
7. 拿不准就说不知道。

---

## 建议的执行顺序

1. **先读完全部源码**（清单 A–E），写下你**不同意的**地方。
2. 复核 O6 的断言 1–6 → 决定"裁 SDK"是否真的可行、真的是最优。
3. 若可行：**先写失败用例**（PTC agent 的 `tools:sdk` 不得含未发现的延迟工具），再实现，
   自检**强制**、失败退兜底（per-agent inert view）。
4. O7：先让用户定门槛去留（三选一：a 保留+说实话 / b 只留一道 / c 学官方不做自动豁免），
   再改文案 + 加全局开关横幅。
5. O8：三条直接做（结论已定）。
6. `node --test` 全量 + `git status` 干净 + 撤掉改动看红。

## 需要用户拍板的产品取舍（别替他决定）

- O6：`both` 部署要不要一并启用（实测 `both` 下遮罩有效）？
- O6：PTC 的 SDK 里要不要用 per-agent `restrict` 把 `tool_search` 也摘掉？
  还是接受"广告里有一个会显式报错的工具"？
- O6：要不要把"让 `sdkSchemas` 支持 per-scope 隐藏集"作为需求提给 DSH 官方（最干净的正解）？
- O7：门槛去留 a / b / c？
- O7：术语接受"状态=延迟 / 效果=按需加载"，还是仍要强行统一？
