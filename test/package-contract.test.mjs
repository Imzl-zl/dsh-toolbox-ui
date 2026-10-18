import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { parse } from 'yaml'

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const hostIndex = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8')
const readmeEn = await readFile(new URL('../README.en.md', import.meta.url), 'utf8')
// 深层设计（共享连接模型、连接状态语义、已知限制、依赖细节）单独成文，
// README 只留使用路径；下面这些断言跟着内容走，就近检查。
const designDoc = await readFile(new URL('../docs/design.md', import.meta.url), 'utf8')
const installationGuide = await readFile(new URL('../docs/installation.md', import.meta.url), 'utf8')
const lockfile = parse(await readFile(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8'))
const dshHostPackages = [
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-agent-loop',
  '@deepseek-ai/dsh-atomic-write',
  '@deepseek-ai/dsh-mcp-client',
  '@deepseek-ai/dsh-scope',
  '@deepseek-ai/dsh-skill',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-typert-protocol',
]
// 只支持 0.2.x：ToolSearch 的 per-agent 呈现模式、`tools:sdk` 手册与 `sessionProjections`
// 都是 0.2 的形态（0.1.x 没有 `modeFor(scope)`，也无法把一个内部投影挂到会话上）。
// 窗口从原来的 `>=0.1.5-rc.1 <0.2.0` 上修——那条在 0.2.1 一发布就会被宿主判不兼容。
const COMPAT_WINDOW = '>=0.2.0-rc.1 <0.3.0'
// 开发基线跟随已验证的最新 RC；发布边界由 peer 窗口表达。
const DEV_BASELINE = '^0.2.0-rc.2'
// 锁文件里解析出的具体版本。**从 DEV_BASELINE 推导**，不要另写一处：这里原本硬编码
// /^0\.1\.5-rc\.2/，于是 bump 基线时就有了第二个真源。
const DEV_BASELINE_VERSION = DEV_BASELINE.replace(/^[^0-9]*/, '')
// cordis 的**已验窗口**：ensureLogCapture 读写 logger.exporters / logger._snExporter 私有字段，
// 而两个受支持的 dsh 版本自带不同的 cordis——0.2.0 是 ~4.0.2，0.2.1 是 ~4.0.5。
// 两端都跑过全量，所以 peer 覆盖整段而不是钉死一端；上界只到 minor（<4.1.0）：
// 私有面一动就要靠这道声明让宿主判不兼容，而不是静默错位。
const CORDIS_PEER = '>=4.0.2 <4.1.0'
// 开发基线仍是 0.2.0 宿主自带的那一代（~4.0.2）：peer 窗口说的是"能装哪些"，
// devDependencies 说的是"本地这套用例跑在哪个真实组合上"。两者不是一回事。
const CORDIS_DEV_BASELINE = '~4.0.2'
// reveal 用 loader 的 interpolate 求值 `!!js` 节点；范围跟随 dsh 自身对它的要求。
const CORDIS_LOADER_PEER = '^1.0.3'

test('package exposes one Web bundle entry', () => {
  assert.equal(packageJson.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(packageJson.version, '1.8.0')
  assert.equal(packageJson.dsh?.client?.platform, 'web')
  // dsh.client.inject 是客户端图里的「工厂先到」依赖边，只能写真实的 client 包名：
  //   @deepseek-ai/dsh-client-runtime  —— 上游 2026-08-22 已删除（be531688 "remove Runtime"）
  //   @deepseek-ai/dsh-client-ui-slots —— 是纯核心库，从不声明 dsh.client / 导出 ./client
  // 死引用会被客户端模块系统静默跳过（不报错），所以只能靠这条断言拦住它回潮。
  assert.deepEqual(packageJson.dsh?.client?.inject, ['@deepseek-ai/dsh-api-remotes'])
  // docs 的 markdown 随包发布（使用者能从包里读到设计与安装说明），
  // 但 **截图不随包**：README 里的相对路径会被 npm 改写到 raw.githubusercontent 渲染
  // （实测 5/5 张图正常），带进 tarball 只是白付 956KB。
  assert.equal(packageJson.files?.includes('docs/*.md'), true)
  assert.equal(packageJson.files?.includes('README.en.md'), true)
  assert.equal(
    packageJson.files?.some((entry) => entry === 'docs' || entry.startsWith('docs/images')),
    false,
    'docs 目录或截图不得整目录随包发布',
  )
  assert.equal(packageJson.repository?.url, 'git+https://github.com/Imzl-zl/dsh-toolbox-ui.git')
  assert.equal((patch.match(/id: mcp-manager-ui/g) ?? []).length, 1)
  // 挂载名必须等于包名（改名后一起变）——不写字面量，从 package.json 推导。
  assert.equal((patch.match(new RegExp('name: ' + packageJson.name, 'g')) ?? []).length, 1)
})

test('package declares the DSH compatibility window and pins development to a verified RC', () => {
  for (const name of dshHostPackages) {
    assert.equal(packageJson.dependencies?.[name], undefined)
    assert.equal(packageJson.peerDependencies?.[name], COMPAT_WINDOW)
    assert.equal(packageJson.devDependencies?.[name], DEV_BASELINE)
  }
  // 窗口两端各自钉一次：下限是"0.2 的第一个 RC"，上限是"0.3 之前"。
  // 这么写是因为**宿主真正的判定函数**（`evaluatePluginCompatibility`，带 includePrerelease）
  // 不随本包发布，仓里也没有它——模拟 semver 只会得到相反结论（见 docs/design.md §版本范围）。
  // 所以这里只钉结构：换了元组就红，至于某个具体版本能不能装，由宿主那道闸门回答。
  const [lower, upper] = COMPAT_WINDOW.split(' ')
  assert.equal(lower, '>=0.2.0-rc.1', '下限必须是 0.2 的第一个 RC')
  assert.equal(upper, '<0.3.0', '上限必须挡住 0.3（粗上限：只回答"这个大版本没验证过"）')
  // devDependencies 必须落在 peer 窗口内：否则开发/测试跑的是一个用户装不上的版本组合。
  assert.equal(DEV_BASELINE_VERSION.startsWith('0.2.'), true, `开发基线 ${DEV_BASELINE_VERSION} 必须在 0.2.x`)
})

test('every host contract this plugin actually depends on is declared as a peer', () => {
  // 不声明就等于隐式依赖：下面每一项都有硬依赖的契约，它们一变本插件就会静默失效。
  //   dsh-tools      → tools.schemas(scope)/get(name, scope) 的作用域视图，整个投射模型的地基
  //   dsh-agent      → `agent/created` 是**被 await 的串行事件**（announce() 里 await ctx.serial），
  //                    载荷带 agent.ctx/session；监听器抛错会否决会话创建
  //   dsh-agent-loop → 创建事务在 publish 之前 await 调用方的 setup，并用 raceAbort 抛弃它；
  //                    会话作用域可能在本插件建连期间就被销毁（引用归还依赖这一条）
  //   dsh-scope      → createScope/quiesceFiber（共享连接的隔离作用域与可 await 的 teardown）
  //   dsh-mcp-client → serverName 注册表、工具名前缀、日志 label
  // 注意 dsh-agent-loop 现在**不是**挂载点（挂载走 agent/created 事件），但会话生命周期仍按它的
  // 语义写：作用域销毁早于建连完成这件事只有它保证，所以它仍是必须声明的契约。
  for (const name of dshHostPackages) {
    assert.equal(packageJson.peerDependencies?.[name], COMPAT_WINDOW, name + ' 必须声明为 peer')
  }
  // cordis 只到 minor 上界（不是 caret）：ensureLogCapture 为了绕过 LoggerService.exporter()
  // 删错 ID 的 bug，直接读写了 logger.exporters / logger._snExporter 两个私有字段。这是唯一
  // 可订阅的诊断面，但它不是公开契约，所以范围必须窄到"两端都实测过"的那一段。
  assert.equal(packageJson.peerDependencies?.['@deepseek-ai/cordis'], CORDIS_PEER)
  // 官方 scope 包名是 @deepseek-ai/cordis；无 scope 的 `cordis` 是另一个包，写错就是假兼容声明。
  assert.equal(packageJson.peerDependencies?.cordis, undefined)
  // cordis-plugin-loader 不在 dsh-* 命名空间，peer 范围跟随 dsh 自身的要求：
  // reveal 用它把 `!!js` 节点求值成有效运行值。
  assert.equal(packageJson.peerDependencies?.['@deepseek-ai/cordis-plugin-loader'], CORDIS_LOADER_PEER)
  assert.equal(packageJson.devDependencies?.['@deepseek-ai/cordis-plugin-loader'], CORDIS_LOADER_PEER)
})

test('lockfile resolves DSH host packages only as a development baseline on the latest RC', () => {
  const importer = lockfile.importers['.']
  for (const name of dshHostPackages) {
    assert.equal(importer.dependencies?.[name], undefined)
    assert.equal(importer.devDependencies?.[name]?.specifier, DEV_BASELINE)
    const resolved = importer.devDependencies?.[name]?.version ?? ''
    assert.ok(
      resolved === DEV_BASELINE_VERSION || resolved.startsWith(DEV_BASELINE_VERSION + '('),
      `${name} 的锁文件版本应解析到开发基线 ${DEV_BASELINE_VERSION}，实际 ${resolved}`,
    )
  }
  assert.equal(importer.dependencies?.['@deepseek-ai/cordis'], undefined)
  assert.equal(importer.devDependencies?.['@deepseek-ai/cordis']?.specifier, CORDIS_DEV_BASELINE)
})

test('runtime YAML parser includes the nested-collection stack overflow fix', () => {
  const [major, minor, patchVersion] = packageJson.dependencies.yaml.split('.').map(Number)
  assert.equal(major, 2)
  assert.ok(minor > 8 || (minor === 8 && patchVersion >= 3))
})

test('the TOML parser used for Codex import stays a runtime dependency', () => {
  // Codex 的 config.toml 是 TOML，插件**运行期**就要解析它。挪到 devDependencies 会让
  // 装好的插件在加载 lib/mcp-import-sources.js 时直接 ERR_MODULE_NOT_FOUND；
  // package-artifact 用例能拦住，但它跑在打包阶段，这里给出就近的理由。
  assert.match(packageJson.dependencies['smol-toml'], /^\^?1\./)
  assert.equal(packageJson.devDependencies?.['smol-toml'], undefined)
})

test('the skills capability is documented where users will look for it', async () => {
  // 技能能力面是本轮新增的**主要**用户可见功能。文档不是可选项：发布闸门（whats-new）
  // 只回答「变了什么」，回答不了「怎么用」。三条链路各自要能被找到：
  //   · docs/skills.md —— 专门的使用说明（随包发布，见 package-artifact）
  //   · README —— 功能清单里要有它，否则读 README 的人不知道有这个能力面
  //   · docs/design.md —— 包结构变了（双能力面），设计文档必须跟着说
  const skillsDoc = await readFile(new URL('../docs/skills.md', import.meta.url), 'utf8')
  assert.ok(skillsDoc.length > 500, 'docs/skills.md 内容过少，疑似占位')
  // 说明必须覆盖三件用户一定会问的事。
  for (const [label, pattern] of [
    ['能力层入口（怎么打开技能面）', /技能/],
    ['作用域（装到哪）', /作用域|全局|项目/],
    ['许可门禁（为什么有的装不了）', /许可/],
  ]) {
    assert.match(skillsDoc, pattern, `docs/skills.md 缺少「${label}」的说明`)
  }
  // README 的功能清单要提到技能能力面。
  assert.match(readme, /技能/, 'README 必须提到技能能力面')
  assert.match(readmeEn, /[Ss]kill/, 'README.en 必须提到技能能力面')
  // 设计文档要说明现在是双能力面（包结构变了）。
  assert.match(designDoc, /技能/, 'docs/design.md 必须说明技能能力面')
})

test('the current release has a hand-written GitHub Release note', async () => {
  // 发布闸门（与 whats-new 同一条理由，只是对象换成 Release 页面）：本仓库的发布全部直接提交
  // 到 main、没有 PR，所以 `gh release create --generate-notes` 几乎生成不出内容——v1.3.0 及
  // 之前每个 Release 页面都只有一行 compare 链接，而面板的更新提示正是把用户指到那一页。
  // release.yml 在推 tag 时会优先用 .github/release-notes/v<version>.md，所以当前版本必须
  // 有一份手写稿：bump 版本时一起写，否则本地就红（tag 之前就能发现）。
  const notesPath = new URL(`../.github/release-notes/v${packageJson.version}.md`, import.meta.url)
  const notes = await readFile(notesPath, 'utf8').catch(() => '')
  assert.ok(
    notes.trim().length > 0,
    `缺少 .github/release-notes/v${packageJson.version}.md：这就是 Release 页面与面板更新提示指过去的内容，bump 版本时要一起写`,
  )
  // 至少要回答"升级怎么做"——只有标题的稿子和自动生成的一样没用。
  assert.match(notes, /dsh plugin --profile web (?:add|update)/, 'Release notes 里要写清升级命令')
})

test('documentation targets the verified DSH and plugin releases', () => {
  // README.en.md 同样随包发布，一并纳入：它原来不在清单里，所以英文版可以悄悄停在旧版本上。
  for (const document of [readme, readmeEn, installationGuide]) {
    // 从 DEV_BASELINE 推导，别硬编码：这里原本写死 /0\.1\.7-rc\.1/，于是 bump 基线时
    // 又多了第三个真源（前两个是 DEV_BASELINE 与锁文件版本）。
    assert.match(document, new RegExp(DEV_BASELINE_VERSION.replace(/\./g, '\\.')))
    // 不再**声称**兼容 0.1.0-rc.x：peer 窗口已收窄到 0.1.5 起。
    // （文档里可以提到旧版本，但只能出现在解释历史差异的上下文里，不能写成兼容声明。）
    assert.doesNotMatch(document, /0\.1\.0-rc\.7`?\s*(?:及以上|以上)/)
    assert.doesNotMatch(document, /(?:0\.1\.0-)?rc\.6/)
    // 版本从 package.json 推导，别硬编码：这两个断言原本写死 v1\.4\.0，于是 bump 版本时
    // 又多了两个真源（旁边 DEV_BASELINE 那条注释记的是同一类坑）。
    const escapedVersion = packageJson.version.replace(/\./g, '\\.')
    // ⚠️ 这里是**仓库** slug（GitHub 上的名字）：1.6.3 起仓库已改名成 dsh-toolbox-ui，
    // 与包名一致；旧包 dsh-mcp-manager-ui 那条线冻结在 1.5.5，只留在历史 tag 与 npm 上。
    // 从 repository.url 推导，避免再把两者混为一谈（首版就是这么错的，改名后必红）。
    const repoSlug = /github\.com\/([^/]+\/[^/.]+)/.exec(packageJson.repository.url)[1]
    assert.match(document, new RegExp('dsh plugin --profile web add github:' + repoSlug + '#v' + escapedVersion))
    // npm 是主安装路径（它让 `dsh plugin update` 能在 ^1.x 内自动升级），必须写进两份文档。
    assert.match(document, new RegExp('dsh plugin --profile web add ' + packageJson.name + '@\\^' + escapedVersion))
    // 升级命令同样跟着包名走（从 package.json 推导，改名只发生在一个地方）。
    assert.match(document, new RegExp('dsh plugin --profile web update ' + packageJson.name))
  }
})

test('the reveal control only renders for masked values', () => {
  // 明文值（如无凭据的 URL）不需要「显示/隐藏」：它本来就摆在眼前，
  // 配个眼睛只会让人以为还藏了东西，而点下去什么也不变（用户报过这个）。
  assert.match(client, /const masked = fallback === REDACTED_VALUE/)
  assert.match(client, /masked \? h\('button'/, '眼睛必须在 masked 时才渲染')
  // 复制按钮只属于「已点开」的状态，不能与眼睛一起无端出现。
  assert.match(client, /revealedNow \? h\('button'/)
})

test('reveal resolves !!js config nodes with the loader evaluator, never returns the raw node', () => {
  // loader 把 `!!js` 表达式以 raw 节点留在 entry.options.config（官方为写回保留 `!!js` 形式），
  // apply 之前才用 interpolate 求值。直接把该节点当「有效运行值」返回，客户端会把它序列化成
  // "[object Object]"——用户点眼睛看到的就是这个，看不到 key。
  assert.match(hostIndex, /import \{ interpolate \} from "@deepseek-ai\/cordis-plugin-loader"/)
  // 必须用 entry 自己的 ctx：官方用例里表达式可以引用该行 inject 的服务。
  assert.match(hostIndex, /interpolate\(entry\.ctx, value\)/)
  // 项目层用与会话建连同一个求值器（内部 spec 存的是 `!!js` 字符串），同样要运行值不要模板。
  assert.match(hostIndex, /resolveSpecValue\(current\[field\], process\.env\)/)
  // 旧的「返回文件模板」实现必须彻底消失：模板不是运行值。
  assert.doesNotMatch(hostIndex, /restoreTemplateDeep/)
  // 编辑表单仍只把运行值用于显示：保留原值标记不得因为求值而失效。
  assert.match(hostIndex, /containsRedactedValue/)
})

test('agent mount takes the agent from the official agent/created payload, never from ctx', async () => {
  const runtime = await readFile(new URL('../lib/workspace-runtime.js', import.meta.url), 'utf8')
  // 官方途径：宿主在创建事务里派发 `agent/created` 并 await 串行监听器（dsh-agent 的 announce()），
  // 载荷里的 agent 公开 ctx 与 session。方向永远是 agent → ctx：反过来从 ctx 上读 agent 会被
  // cordis 的服务守卫拒绝（`cannot get property "agent" without inject`）。
  // 签名刻意**不在参数位置解构**：解构发生在 try 之前，一个 null 载荷就能让监听器 reject，
  // 而宿主把 reject 当作「否决这次会话创建」—— 取值必须留在 try 里面。
  assert.match(runtime, /ctx\.on\("agent\/created", async \(payload\) =>/)
  assert.match(runtime, /const payloadAgent = payload\?\.agent;/)
  assert.match(runtime, /mountProjectMcpForAgent\(ctx, payloadAgent, generation, \{ signal: payload\?\.signal \}\)/)
  assert.doesNotMatch(runtime, /ctx\.on\("agent\/created", async \(\{ agent \}\)/)
  assert.match(runtime, /const agentCtx = agent\?\.ctx;/)
  assert.match(runtime, /if \(!agentCtx\)/)
  assert.doesNotMatch(runtime, /agentCtx\.agent/)
  // 不再包装宿主服务：挂载点只有事件订阅，没有 setup 中间层、也不改写 agents.create/resume。
  assert.doesNotMatch(runtime, /composeAgentSetup/)
  assert.doesNotMatch(runtime, /agentsService\[method\] = wrapper/)
  // 边界必须显式：宿主把监听器的抛错当作否决创建，所以挂载失败只能吞成日志。
  assert.match(runtime, /已吞掉，不阻断会话创建/)
})

test('bundle does not install the creation-mode Cordis tool', () => {
  assert.doesNotMatch(patch, /dsh-tool-cordis|cordis-tools/)
})

test('client exposes only the floating MCP manager and follows DSH theme contracts', () => {
  assert.doesNotMatch(client, /settings\.plugins\.tab/)
  assert.match(client, /shell\.overlay/)
  assert.doesNotMatch(client, /搜索工具/)
  assert.match(client, /添加 MCP/)
  assert.match(client, /--dsw-alias-button-elevated-fill/)
  assert.doesNotMatch(client, /background:#262a33/)
})

test('client keeps transport badges readable in both DSH color schemes', () => {
  assert.match(client, /\.dsh-mcp-badge\.t-http\{[^}]*color:var\(--dsw-alias-label-primary\)[^}]*border-color:var\(--dsw-alias-state-business-primary\)[^}]*background:var\(--dsw-alias-state-business-tertiary\)/)
  assert.match(client, /\.dsh-mcp-badge\.t-stdio\{[^}]*color:var\(--dsw-alias-label-primary\)[^}]*border-color:var\(--dsw-alias-state-warn-primary\)[^}]*background:var\(--dsw-alias-state-warn-tertiary\)/)
  assert.doesNotMatch(client, /state-warn-secondary\}/)
})

test('client keeps both enabled and disabled toggle states visible', () => {
  // 令牌对齐官方 ui-primitives/Switch.module.css：轨道关闭态 border-l3、开启态品牌色，
  // 滑块用 switch-thumb / label-primary-foreground（官方注释：这一档在两种配色下都保持浅色）。
  assert.match(client, /\.dsh-mcp-toggle\{[^}]*background:var\(--dsw-alias-border-l3\)/)
  assert.match(client, /\.dsh-mcp-toggle\[aria-checked='true'\]\{[^}]*background:var\(--mcp-accent\)/)
  assert.match(client, /\.dsh-mcp-toggle::after\{[^}]*background:var\(--dsw-alias-switch-thumb\)/)
  assert.match(client, /\.dsh-mcp-toggle\[aria-checked='true'\]::after\{[^}]*background:var\(--dsw-alias-label-primary-foreground\)/)
  assert.doesNotMatch(client, /--dsw-alias-fill-l2/)
  assert.doesNotMatch(client, /--dsw-alias-brand-primary-invert/)
  // 状态只走 aria-checked，没有并行的 .on class —— 与官方 Switch 同一形状，
  // 视觉状态不会与辅助技术读到的状态不一致。断言落在 Toggle 自身的定义上，
  // 不用"两个关键词相距 N 字符"这种写法：注释一变长它就假红。
  const toggle = /const Toggle = \([\s\S]*?\n\n/.exec(client)?.[0] ?? ''
  assert.ok(toggle.length > 0, '找不到 Toggle 组件定义')
  assert.match(toggle, /role: 'switch'/, '开关必须向辅助技术声明自己是 switch')
  assert.match(toggle, /'aria-checked': on/, '开关状态必须走 aria-checked')
  assert.match(toggle, /'aria-label': label/, '开关必须有无障碍名称（官方 Switch 的 label 是必填）')
  // 反向：不允许再加回一份平行记账（class 驱动的外观会与 aria 状态脱钩）。
  assert.doesNotMatch(client, /dsh-mcp-toggle' \+ \(on \?/)
  assert.doesNotMatch(client, /\.dsh-mcp-toggle\.on/)
})

test('client keeps connection status badges readable in both DSH color schemes', () => {
  assert.match(client, /\.dsh-mcp-badge\.s-on\{[^}]*color:var\(--dsw-alias-label-primary\)[^}]*border-color:var\(--dsw-alias-state-success-primary\)[^}]*background:var\(--dsw-alias-state-success-tertiary\)/)
  assert.match(client, /\.dsh-mcp-badge\.s-err\{[^}]*color:var\(--dsw-alias-label-primary\)[^}]*border-color:var\(--dsw-alias-state-error-primary\)[^}]*background:var\(--dsw-alias-interactive-bg-hover-danger\)/)
  assert.doesNotMatch(client, /\.dsh-mcp-badge\.s-(?:on|err)\{[^}]*state-(?:success|error)-secondary/)
})

test('client does not reference unsupported DSH alias tokens', () => {
  assert.doesNotMatch(client, /--dsw-alias-label-error/)
})

test('client preserves redacted values during edits and never previews header values', () => {
  assert.match(client, /__DSH_MCP_REDACTED__/)
  assert.match(client, /••••••（保留原值）/)
  assert.match(client, /MASKED_VALUE/)
  assert.match(client, /onReveal\(server, field, keyName\)/)
  assert.doesNotMatch(client, /String\(headers\[k\]\)\.slice\(0, 12\)/)
})

test('client reveals masked values in detail and edit views without replacing preserved form state', () => {
  assert.match(client, /onReveal\(server, field, keyName\)/)
  assert.match(client, /toggleEditReveal\(field, originalKey\)/)
  assert.match(client, /visibleEditValue\(field, originalKey, row\.v\)/)
  assert.match(client, /formatRevealedValue/)
  assert.match(client, /Object\.entries\(value\)/)
  assert.match(client, /dsh-mcp-inline-icon\{box-sizing:border-box;width:34px!important;height:34px!important/)
  assert.match(client, /dsh-mcp-kv-del\{box-sizing:border-box;width:34px;height:34px/)
})

test('manual refresh provides progress and completion feedback', () => {
  assert.match(client, /refreshing \? t\('刷新中…'\) : t\('刷新'\)/)
  assert.match(client, /t\('已刷新，共 \{count\} 个 MCP', \{ count: next\.length \}\)/)
})

test('client avoids full-screen backdrop filters and skips stale or unchanged polling renders', () => {
  assert.doesNotMatch(client, /dsh-mcp-(?:panel-)?overlay\{[^}]*backdrop-filter/)
  assert.match(client, /revision !== revisionRef\.current/)
  assert.match(client, /seq !== loadSeq\.current/)
})

test('list and detail use the same derived status and refresh tools after registration', () => {
  assert.match(client, /const dotPhase = \(s\) => \(mountFailed\(s\) \|\| scopeFailed\(s\) \? 'failed' : s\.status \|\| s\.phase\)/)
  assert.match(client, /selectedServer\?\.toolRevision/)
})

test('mount failures are attributed to the row and the detail pane, not only a banner', async () => {
  const host = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
  // 顶部横幅说 memory 挂载失败、而列表里 memory 看着一切正常，是最容易误导的状态。
  // 行与详情都只读 Host 标在行上的 mountFailed；客户端不再拿 mountErrors 列表反推一遍（第二真相源）。
  assert.doesNotMatch(client, /const mountErrorMap = useMemo/)
  assert.match(client, /const mountFailed = \(s\) => s\.mountFailed === true/)
  assert.match(client, /mountFailed\(s\) \? h\(Badge, \{ cls: 's-err' \}, t\('挂载失败'\)\) : null/)
  // 挂载失败（我们 setup 阶段挂不上）与连接失败（mcp-client 报错/重连耗尽）必须分开：
  // 用“lastError 存在”反推挂载失败会把连接失败误标成挂载失败，也是同一事实的第二个真相源。
  assert.match(host, /row\.mountFailed = true;/)
  assert.match(client, /const mountFailed = isWorkspace && server\.mountFailed === true/)
  assert.doesNotMatch(client, /return failure \? \{ \.\.\.local, lastError: failure \} : local/)
  // 列表行标红而详情说「随会话挂载」，是同一条信息在两处自相矛盾。
  assert.match(client, /const status = mountFailed \? 'failed' : server\.status \|\| server\.phase \|\| 'stopped'/)
  assert.match(client, /mountFailed\s*\n\s*\? t\('挂载失败'\)/)
  // 横幅不再猜测原因，具体错误留在它归属的条目上。
  assert.doesNotMatch(client, /可能已被其他会话占用或连接失败/)
})

test('global MCPs are inspectable from a project tab but stay read-only there', () => {
  // 长得像列表项却点不开，是最直接的交互不一致。
  assert.match(client, /onClick: \(\) => onSelect\(s\.serverName\),[^]*?onKeyDown[^]*?dsh-mcp-item-name/)
  assert.match(client, /return global \? \{ \.\.\.global, managed: false, foreign: 'global' \} : null/)
  assert.match(client, /const isForeign = server\.foreign === 'global'/)
  // 只读的同时仍要能改「对本项目是否可见」，否则详情页比列表还弱。
  assert.match(client, /isForeign\s*\n\s*\? h\(React2\.Fragment, null,[^]*?onToggleExclude\(server\.serverName, next\)/)
  assert.match(client, /isForeign \? t\('全局配置（在「全局」标签页可编辑）'\)/)
  assert.doesNotMatch(client, /← 从左侧选择一个 MCP/)
})

test('revealed values are generation-scoped and cleared when persisted configuration changes', () => {
  assert.match(client, /editRevealGeneration\.current/)
  assert.match(client, /generation !== revealGeneration\.current/)
  assert.match(client, /revealRevisionRef/)
  assert.match(client, /if \(consumeRevision\(revealRevisionRef, res\.revealRevision\)\) clearRevealed\(\)/)
  assert.match(client, /clearRevealed\(\);\s*flash\(editTarget/)
  assert.match(client, /clearRevealed\(\);\s*flash\(res\.note/)
})
test('client validates reconnect delay ordering without rejecting DSH-supported decimals', () => {
  assert.match(client, /Number\.isFinite\(initialDelay\)/)
  assert.match(client, /initialDelay > maxDelay/)
  assert.doesNotMatch(client, /\[timeout, initialDelay, maxDelay, attempts\]\.every/)
})

test('client preserves prototype-shaped header and env keys entered in the form', () => {
  assert.match(client, /setOwn\(hd, r\.k\.trim\(\), fromFormValue\(r\.v\)\)/)
  assert.match(client, /setOwn\(ev, r\.k\.trim\(\), fromFormValue\(r\.v\)\)/)
})

test('client moves focus into dialogs so Escape handlers receive keyboard events', () => {
  assert.match(client, /panelRef\.current\?\.focus\(\)/)
  assert.match(client, /e\.stopPropagation\(\)/)
  // 面板里的每个 modal 对话框都通过 Dialog 构造器渲染，而焦点契约（ref + 打开即 focus + role +
  // tabIndex + Escape）就在那个构造器里。所以这里不数"写了 dialogRef 的对话框有几个"——那种计数
  // 只统计已经写对的那些，漏写 ref 的新对话框照样能过（实测过：把一段无 ref 的 modal 拼进源码，
  // 四个相等断言全绿）。改成从**渲染站点**出发：手写 role="dialog" 的地方只允许三处已知的例外，
  // 新增第四处必须显式改这条断言，而不是悄悄绕过焦点契约。
  const dialogSites = [...client.matchAll(/role: 'dialog'/g)].length
  assert.equal(dialogSites, 3, `手写的 role="dialog" 从三处变成了 ${dialogSites} 处：Dialog 构造器 / 面板本体 / 更新卡片之外不应再有`);
  const dialogCtor = client.slice(client.indexOf('const Dialog = ('), client.indexOf('const CONTROLS_THRESHOLD'))
  assert.match(dialogCtor, /const dialogRef = useRef\(null\)/)
  assert.match(dialogCtor, /useEffect\(\(\) => \{ dialogRef\.current\?\.focus\(\); \}, \[\]\)/, 'Dialog 必须在挂载时把焦点吸进来（挂载即打开）')
  assert.match(dialogCtor, /role: 'dialog'/)
  assert.match(dialogCtor, /tabIndex: -1/)
  // 六个 modal 全部走构造器；有任何一个回去手写内层 div，这里就会掉下来。
  // 5 → 6：1.8.0 的 C2 新增「延迟加载参数」表单（它同样必须走 Dialog，才有焦点与 Escape）。
  const uses = [...client.matchAll(/h\(Dialog, \{ label: /g)].length
  assert.equal(uses, 6, `走 Dialog 的对话框数量变了（现在 ${uses} 个）`)
  assert.equal((client.match(/className: 'dsh-mcp-modal' \+ \(cls/g) || []).length, 1, 'modal 的 class 组合只该在 Dialog 里做一次')
  // 遮罩由调用点渲染一次（六个 modal + 更新卡片自己那层，共七处）。Dialog 内部再套一层就会
  // 嵌套出两个 overlay——实测踩过，所以钉住。
  assert.equal((client.match(/className: 'dsh-mcp-overlay'/g) || []).length, 7, '遮罩只在调用点渲染，Dialog 不重复套一层')
})

test('the three contract faces list the same methods in the same order', async () => {
  const { TYPERT } = await import('../lib/typert.js')
  // 三边契约（Host 实现 / lib/typert.js / lib/client.js）里，Host 与 typert.js 之间此前没有
  // 任何自动比对：加了 Remote 却忘了写契约（客户端永远调不到）、或删了实现却留着契约
  //（调用必失败），测试都还是绿的。这条把三边钉在一起，对每个未来方法都生效。
  // **顺序也是契约**，所以比较不排序：三份清单是同一件事的三面，位置一致才可能一眼对照。
  // 曾经这里排过序，于是 scanImportSources 一组在 index.js 里被追加到末尾而没人发现。
  // 新增方法时，请在同样的位置插入三份清单。
  // 本包有**两个** Remote 命名空间（mcpManager / skillsManager），所以三边清单都是
  // 「MCP 段 + 技能段」的同序拼接：host 是两个 gateway 类各自的 @Remote，typert 是
  // mv() / mvs() 两个工厂产出的 invocations，client 是字面 descriptor 加 sk() 调用。
  // 拼接按**文件里的出现位置**排，不是按「先 MCP 再技能」硬写：这样两个面在文件里交错
  // 也会被抓到（交错本身没有意义，但静默通过比报错更糟）。
  const byPosition = (source, patterns) => patterns
    .flatMap((pattern) => [...source.matchAll(pattern)].map((match) => ({ at: match.index, method: match[1] })))
    .sort((left, right) => left.at - right.at)
    .map((entry) => entry.method)
  const declared = [...hostIndex.matchAll(/Remote\("([A-Za-z0-9_]+)"\)/g)].map((match) => match[1])
  const contract = TYPERT.invocations.map((entry) => entry.method)
  // 包名不写第二遍：从 package.json 推导。写死字面量时，改包名会让这条正则一条都匹配不到，
  // 于是 descriptors 变成空数组——它照样会红，但理由是「顺序不对」，指向完全错误的地方。
  const escapedName = packageJson.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const mcpPattern = new RegExp(`id: '${escapedName}#mcpManager/([A-Za-z0-9_]+)'`, 'g')
  const skillPattern = /^\s+sk\('([A-Za-z0-9_]+)'/gm
  const mcpDescriptors = byPosition(client, [mcpPattern])
  const skillDescriptors = byPosition(client, [skillPattern])
  const descriptors = byPosition(client, [mcpPattern, skillPattern])
  assert.ok(declared.length >= 30, `从 index.js 读到的 Remote 数量异常（${declared.length}）`)
  // 两个面分别先验「读到了」：只匹配到一个面时 deepEqual 会以「少一半」失败，
  // 而那句话读起来像顺序问题，所以这里先把「哪一面空了」说清楚。
  assert.ok(mcpDescriptors.length >= 30, `client 的 mcpManager descriptor 只读到 ${mcpDescriptors.length} 条`)
  assert.ok(skillDescriptors.length >= 9, `client 的 skillsManager descriptor 只读到 ${skillDescriptors.length} 条`)
  assert.deepEqual(contract, declared, 'lib/typert.js 的 invocation 必须与 Host 的 Remote 同序')
  assert.deepEqual(descriptors, declared, 'lib/client.js 的 descriptor 必须与它们同序')
})

test('the gateway prototypes are the fourth contract face: no method falls off the wire', async () => {
  // 上面那条三边比对守的是**边间漂移**（一边加了、另一边忘了）。它对 F1 的实际形态
  // ——`setDeferAll` 从三边**同时**消失——结构性失明：那时只有 manifest 的精确计数会红。
  // 第四边就是为这个盲区存在的：Host 实现面本身（`McpManagerGateway.prototype` /
  // `SkillsManagerGateway.prototype`，纯导入即可枚举，不需要起 Context）。
  //
  // 断言方向：原型上每个方法都必须出现在三份清单里（@Remote / TYPERT / client descriptor）。
  // 均匀缺失时这一条直接红，而三边比对不会。
  const { McpManagerGateway, SkillsManagerGateway } = await import('../lib/index.js')
  const declared = [...hostIndex.matchAll(/Remote\("([A-Za-z0-9_]+)"\)/g)].map((match) => match[1])
  assert.ok(declared.length >= 40, `从 index.js 读到的 Remote 数量异常（${declared.length}）`)

  // 仅内部使用、不上面 wire 的方法必须**显式登记**：漏登记一个，这条就红，而红说的正是
  // "有个方法没接上 wire"。目前只有一个——`setDisabled` 是 enable/disable 的共用实现，
  // 面板不直接调它（调的是 enable/disable）。
  const INTERNAL_ONLY = new Set(['setDisabled'])
  const faces = [
    ...Object.getOwnPropertyNames(McpManagerGateway.prototype),
    ...Object.getOwnPropertyNames(SkillsManagerGateway.prototype),
  ].filter((name) => name !== 'constructor' && !INTERNAL_ONLY.has(name))

  const offWire = faces.filter((name) => !declared.includes(name))
  assert.deepEqual(offWire, [], '这些 gateway 方法没有 @Remote，客户端永远调不到（要么补上三边，要么登记进 INTERNAL_ONLY 并说明理由）')
  const missingImpl = declared.filter((name) => !faces.includes(name))
  assert.deepEqual(missingImpl, [], '这些 @Remote 在 gateway 原型上找不到实现（调用必失败）')
  // 两侧数量必须相等：只比"没有多的"会让"少的那一半"永远隐形。
  assert.equal(faces.length, declared.length, `原型方法数与 Remote 数不一致（原型 ${faces.length} / Remote ${declared.length}）`)
})

test('every workspace write goes through the one registered-target gate', async () => {
  const runtime = await readFile(new URL('../lib/workspace-runtime.js', import.meta.url), 'utf8')
  // 「本插件只写自己认识的工作区」这条不变量只表达一次：所有会落盘 <工作区>/.dsh/mcp.json 的
  // Remote 都从 withRegisteredWorkspaceWrite 过。少一条在功能上完全看不出来（写照样成功），
  // 所以钉成结构断言——新增写路径时它必须自己走进这道门。
  assert.equal((hostIndex.match(/withWorkspaceWrite\(/g) || []).length, 0, 'index.js 不得绕过授权直接用裸的写锁')
  const gated = (hostIndex.match(/withRegisteredWorkspaceWrite\(/g) || []).length
  const writes = (hostIndex.match(/writeWorkspaceConfigFile\(/g) || []).length
  assert.ok(writes >= 7, `写盘调用点数量变了（现在 ${writes} 个），先核对这组断言`)
  assert.equal(gated, writes, '每个写盘调用点都必须经过已注册工作区校验')
  // 注册表只在一处取用：再写一份 ctx.get('workspaceRegistry') 就等于又出现一份"哪些目录算工作区"。
  // 注释里提到这个表达式是正常的（说明原理），所以只数非注释行。
  const runtimeCode = runtime.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n')
  assert.equal((runtimeCode.match(/get\(["']workspaceRegistry["']\)/g) || []).length, 1)
  // 裸写锁不再对外导出：绕过授权的那条路在模块边界上就不存在，而不只是"我们不这么写"。
  assert.doesNotMatch(runtime.slice(runtime.lastIndexOf('export {')), /withWorkspaceWrite/, '唯一的写入口是 withRegisteredWorkspaceWrite')
})

test('client Remote contract includes JSON preview and import operations', () => {
  assert.match(client, /mcpManager\/previewImport/)
  assert.match(client, /mcpManager\/importJson/)
})

test('importing from other MCP clients goes through the Host, with no client-supplied path', async () => {
  const { TYPERT } = await import('../lib/typert.js')
  for (const method of ['scanImportSources', 'previewImportSource', 'importSource']) {
    // 契约有、Host 没有 = 调用必失败；Host 有、契约没有 = 客户端永远调不到。三边都要在。
    assert.ok(TYPERT.invocations.some((entry) => entry.method === method), `契约缺少 ${method}`)
    assert.match(hostIndex, new RegExp(`async ${method}\\(payload\\) \\{`), `Host 缺少 ${method}`)
    assert.match(client, new RegExp(`call\\('${method}'`), `客户端没有调用 ${method}`)
  }
  // 扫描结果只带名称、传输与「哪些字段会被掩码」，条目本体（含 `!!js` 表达式与字面密钥）不出 Host。
  assert.match(hostIndex, /maskedFields: entry\.spec \? maskedSourceFields\(entry\.spec\) : \[\]/)
  // 导入必须带上预览时的内容指纹，否则等于允许「预览的是 A、导入的是 B」。
  assert.match(client, /contentHash: sourcePreview\.contentHash/)
  // 路径只由 Host 的来源表拼出；客户端一旦开始传 path，接口面就退化成「读任意文件」。
  assert.doesNotMatch(client, /call\('(?:previewImportSource|importSource)', \{[^}]*path:/)
})

test('client places an explicit selectable builtin installer before manual add', () => {
  assert.match(client, /McpMarketView/)
  assert.match(client, /call\('builtins'\)/)
  assert.match(client, /call\('installBuiltins'/)
  assert.match(client, /安装/)
  // 市场形态：搜索是主操作、分类 chips、卡片网格、逐条安装、以及「已配置」时可移除。
  // 这几条一起把「市场」与旧的「勾选列表」区分开——少任何一条都会退回列表框。
  //
  // ⚠️ 2025 改版：市场从**浮层**（.dsh-mcp-modal.dsh-mcp-market）改成**内联视图**
  // （第二行的「发现市场」模式），与技能面共用 .dsh-mcp-grid / .dsh-mcp-mcard。
  // 所以这里钉的是新契约：内联容器存在、且**不再**是 overlay/modal 的形态。
  assert.match(client, /className: 'dsh-mcp-market-view'/)
  assert.doesNotMatch(client, /dsh-mcp-modal dsh-mcp-market/, '市场不得再回退成浮层形态')
  assert.match(client, /\.dsh-mcp-grid\{[^}]*display:grid[^}]*grid-template-columns:repeat\(auto-fill/)
  // 分类药丸：**换行**而不是横滚（横滚 + 隐藏滚动条会把最后一个药丸切在右边缘，
  // 真机上就是「文件与…」被裁一半）。判别断言放在 panel-chrome 那条，这里只钉它存在。
  assert.match(client, /\.dsh-mcp-chips\{[^}]*flex-wrap:wrap/)
  assert.match(client, /className: 'dsh-mcp-chip'/)
  assert.match(client, /placeholder: t\('搜索服务、用途或提供方…'\)/)
  assert.match(client, /install\(\[item\.id\]\)/)
  assert.match(client, /call\('removeServer'|call\('removeWorkspaceServer'/)
  assert.match(client, /call\('removeWorkspaceServer', \{ wsPath: scope, name \}\)/)
  // 头部顺序：导入在「添加」之前，两者都在标题栏那一列里。市场不再是这里的一个按钮
  // ——它升格成第二行的模式分段（与技能面同一个控件），所以「市场」不再参与这段排序。
  const importPosition = client.indexOf("children: t('导入 MCP'")
  const addPosition = client.indexOf("scope === 'global' ? t('添加 MCP')")
  assert.ok(importPosition >= 0 && importPosition < addPosition, '导入要排在「添加 MCP」之前')
  // 模式层是**两个能力面共用**的那一个：只有一处定义、且两处都读它。
  assert.equal((client.match(/const SKILL_MODES = \[/g) ?? []).length, 1, '模式层只能定义一次')
  assert.match(client, /seg\(SKILL_MODES, mode, setMode, t\('模式'\)\)/)
})

test('client exposes tool parameter schemas, presets, filters and clipboard copy', () => {
  assert.match(client, /tool\.parameters/)
  assert.match(client, /MCP_PRESETS/)
  assert.match(client, /flattenParameters/)
  assert.match(client, /describeType/)
  assert.match(client, /transportFilter/)
  assert.match(client, /statusFilter/)
  assert.match(client, /navigator\.clipboard/)
  assert.match(client, /ICONS\.copy/)
  assert.doesNotMatch(client, /JSON\.stringify\(prev\) === JSON\.stringify\(next\)/)
})

test('workspace tab renders project MCPs as their own card instead of a nested collapsing list', () => {
  // ServerList 内嵌进项目分区时必须丢掉自身卡片外框，否则出现卡中卡。
  assert.match(client, /\.dsh-mcp-side\.embedded\{[^}]*flex:1 1 auto[^}]*border:0[^}]*padding:0/)
  assert.match(client, /className: 'dsh-mcp-side' \+ \(embedded \? ' embedded' : ''\)/)
  // 两个分区各自成卡片，不再靠 border-top 分隔。圆角走共享刻度令牌
  // （docs/ui-radius.md：独立内容卡用 --dsw-radius-xl 一档；此处取 --mcp-r-lg）。
  assert.match(client, /\.dsh-mcp-section\{[^}]*border:1px solid var\(--mcp-line\)[^}]*border-radius:var\(--mcp-r-lg\)/)
  assert.doesNotMatch(client, /\.dsh-mcp-section\+\.dsh-mcp-section\{border-top/)
  assert.match(client, /\.dsh-mcp-section\.local\{[^}]*border-color:var\(--mcp-accent\)/)
  assert.match(client, /className: 'dsh-mcp-section local'/)
  assert.match(client, /className: 'dsh-mcp-section global'/)
  // ws-body 变成纯布局容器：不再叠一层卡片，放不下时自身滚动而不是裁掉内容。
  assert.match(client, /\.dsh-mcp-ws-body\{[^}]*overflow-y:auto/)
  assert.doesNotMatch(client, /\.dsh-mcp-ws-body\{[^}]*border:1px solid/)
})

test('server lists keep a minimum visible height and never get clipped to zero on narrow panels', () => {
  // flex:1 在被压缩的 column 容器里会塌缩成 0 并被 overflow:hidden 吃掉，必须给下限。
  assert.match(client, /\.dsh-mcp-list\{flex:1 1 auto;min-height:52px/)
  assert.match(client, /\.dsh-mcp-global-list\{[^}]*min-height:52px/)
  assert.match(client, /\.dsh-mcp-section\.local\{[^}]*min-height:124px/)
  assert.match(client, /\.dsh-mcp-section\.global\{[^}]*min-height:124px/)
  // 窄屏改为整页滚动 + 列表各自 vh 上限，取代会裁掉整块列表的 max-height:34%。
  assert.doesNotMatch(client, /max-height:34%/)
  assert.match(client, /@media \(max-width:760px\)\{[^]*?\.dsh-mcp-body\{flex-direction:column;overflow-y:auto/)
  assert.match(client, /@media \(max-width:760px\)\{[^]*?\.dsh-mcp-section\.local \.dsh-mcp-list\{max-height:30vh\}/)
  assert.match(client, /@media \(max-width:760px\)\{[^]*?\.dsh-mcp-global-list\{max-height:30vh\}/)
})

test('overflowing scope tabs keep their popover outside the scrolling strip', () => {
  // .dsh-mcp-tabs 是 overflow-x:auto 的裁剪盒：弹层挂在它内部时会被整块裁掉
  // （实测溢出时可见高度为 0），隐藏的项目标签就永远点不到。弹层必须挂在
  // 非滚动的 .dsh-mcp-tabs-wrap 上。
  assert.match(client, /\.dsh-mcp-tabs-wrap\{[^}]*position:relative/)
  assert.match(client, /\.dsh-mcp-tabs\{[^}]*overflow-x:auto/)
  assert.doesNotMatch(client, /\.dsh-mcp-tabs\{[^}]*position:relative/)
  // 弹层节点由 wrap 渲染，而不是滚动的 tabs 容器。
  assert.match(client, /className: 'dsh-mcp-tabs-wrap', ref: rootRef/)
  assert.match(client, /className: 'dsh-mcp-tabs', ref: barRef/)
  assert.match(client, /^ {4}popover,$/m)
  // 光「挪出来」还不够：复用 .dsh-mcp-tab 作弹层行时它带 padding+border，
  // 而 .dsh-mcp-tab 是 content-box，`width:100%` 会把内边距和边框再加一遍，
  // 整行比弹层宽出一圈而溢出（实测 19px，chip 右边界越过了弹层右边界）。
  // 这条与 .dsh-mcp-entry-item 那条注释是同一个坑，必须一起钉住。
  const popRowRule = client.match(/\.dsh-mcp-tab-pop \.dsh-mcp-tab\{([^}]*)\}/)
  assert.ok(popRowRule, '.dsh-mcp-tab-pop .dsh-mcp-tab 规则必须存在')
  assert.match(popRowRule[1], /box-sizing:border-box/)
  assert.match(popRowRule[1], /width:100%/)
  // 弹层还必须贴着触发它的「…N」按钮，而不是贴标签条右边缘：标签条右侧常有
  // 大段空白（可见标签按保守估算提前截断），贴右边缘会让弹层离点击处很远
  // （实测水平差 50px）。锚点用内联 right 表达，并夹取到不溢出左边。
  assert.match(client, /const POPOVER_MIN_WIDTH = 170/)
  assert.match(client, /min-width:170px/)
  assert.match(client, /style: \{ right: moreRight \+ 'px' \}/)
  assert.match(client, /ref: moreRef/)
  assert.match(client, /syncMoreAnchor/)
})

test('workspace MCPs stay toggleable and share the global status vocabulary', () => {
  // 项目 MCP 没有 loader 条目的 phase 语义，沿用全局的 stopped 判定会让禁用后再也开不回来。
  assert.match(client, /const toggleLocked = \(s\) => busy \|\| !s\.managed \|\| \(s\.scope !== 'workspace' && !s\.enabled && s\.phase !== 'stopped'\)/)
  // 项目行的 status 与全局同一个取值域（deriveMcpPhase），只是文案不同；不再有自创的
  // connecting/idle/active 那套平行词汇，也不再有把"连接在不在"和"几个会话在用"压成一句的写法。
  assert.match(client, /const status = mountFailed \? 'failed' : server\.status \|\| server\.phase \|\| 'stopped'/)
  assert.match(client, /status === 'connected' \? t\('已连接'\) : status === 'failed' \? t\('连接失败'\)/)
  assert.match(client, /尚未建立连接（新会话自动挂载）/)
  assert.doesNotMatch(client, /s\.status === 'connecting'/)
  assert.doesNotMatch(client, /isWorkspace\s*\n\s*\? '随会话挂载'/)
  assert.match(client, /cls: isWorkspace \? 'scope-ws' : ''/)
})

test('sparse workspace lists hide filter controls and global search stays outside the scroll area', () => {
  // 项目 MCP 通常只有 1-3 个，常驻搜索框 + 两个下拉会吃掉整块列表高度。
  assert.match(client, /const showControls = !embedded \|\| count > CONTROLS_THRESHOLD/)
  assert.match(client, /workspace \? null : h\('option', \{ value: 'connected' \}/)
  assert.match(client, /emptyHint: t\('此项目还没有 MCP。/)
  // 搜索框必须是分区的直接子节点，否则会随列表一起滚走。
  assert.match(client, /servers\.length > CONTROLS_THRESHOLD \? h\('div', \{ className: 'dsh-mcp-global-search' \}[^]*?\n\s*h\('div', \{ className: 'dsh-mcp-global-list' \}/)
  assert.match(client, /setTransportFilter\('all'\);\s*\n\s*setStatusFilter\('all'\);/)
})

test('visibility and enablement use deliberately different controls', () => {
  // 滑块=启用状态、眼睛=本项目可见性。两者后果不同（写 disabled vs 写 exclude），
  // 外观统一反而会让人以为关掉全局条目就是全局禁用。
  assert.match(client, /const EyeToggle = \(\{ hidden, disabled, onChange, label \}\)/)
  assert.match(client, /ICONS\[hidden \? 'eyeOff' : 'eye'\]/)
  assert.match(client, /h\(EyeToggle, \{ hidden: isHidden, disabled: busy, label: s\.serverName, onChange: \(next\) => onToggleExclude\(s\.serverName, next\) \}\)/)
  assert.doesNotMatch(client, /dsh-mcp-hide-toggle/)
  assert.match(client, /isHidden \? h\(Badge, \{ cls: 's-off' \}, t\('已屏蔽'\)\) : null/)
  // 眼睛按钮不能连带触发行选中
  assert.match(client, /onClick: \(e\) => \{ e\.stopPropagation\(\); onChange\(!hidden\); \}/)
})

test('global list collapses to a one-line summary so the project list stays the subject', () => {
  // 全局可见性是低频操作，展开时占了项目区两倍高度并把详情挤出视口。
  assert.match(client, /const \[globalOpen, setGlobalOpen\] = useState\(false\)/)
  assert.match(client, /className: 'dsh-mcp-section global' \+ \(globalOpen \? '' : ' collapsed'\)/)
  assert.match(client, /t\('\{visible\}\/\{total\} 对本项目可见', \{ visible: visibleGlobalCount, total: globalServers\.length \}\)/)
  assert.match(client, /globalOpen \? h\(GlobalServerList/)
  assert.match(client, /\.dsh-mcp-section\.global\.collapsed\{flex:none;min-height:0;border-color:transparent/)
  assert.match(client, /setGlobalOpen\(false\);/)
})

test('project MCP: what the README promises the panel shows, the panel actually shows', async () => {
  const host = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
  // README 现在承诺三件事，都必须真的在面板上看得见：
  //   1. 写盘即生效（不需要重开会话）；2. 连接跟配置走、不跟会话走；3. 项目行把「连接在不在」与
  //   「几个会话在用」分开说，不再有「待会话挂载」这种把两者压成一句的合成状态。
  assert.match(readme, /写盘即生效/)
  assert.match(readme, /连接跟配置走，不跟会话走/)
  assert.doesNotMatch(readme, /配置待生效/)
  assert.match(client, /已连接 · 当前无会话使用（连接保留，下次直接用）/)
  assert.match(client, /已连接 · \{refs\} 个会话在用\{tools\}/)
  assert.match(client, /尚未建立连接（新会话自动挂载）/)
  // 不再有渲染出来的「待会话挂载」字样（注释里作为历史提及不算）。
  assert.doesNotMatch(client, /'待会话挂载'/)
  assert.doesNotMatch(client, /配置待生效/)
  // README 承诺的「重连出口」必须有对应 RPC（而不是只有一句文案）。
  assert.match(host, /async reconnectWorkspaceServer\(payload\)/)
  assert.match(client, /'reconnectWorkspaceServer'/)
  // 对齐连接必须发生在**写锁之外**、并经一个吞错误的小助手：reconcile 会 await 整条 teardown，
  // 放在写锁里会让「移除一个卡住的 server」把该项目之后每次保存都卡住；而它的失败不该把一个
  // 已经落盘的写报成失败。所以 RPC 里不再直接调用它。
  assert.match(host, /async function alignWorkspaceConnections\(ctx, wsPath\)/)
  assert.doesNotMatch(host, /await reconcileWorkspaceConnections\(this\.ctx/)
  // 编辑表单是"重建 spec"：表单不渲染的字段必须原样带回，否则编辑一次就抹掉它们
  //（disabled 会让被禁用的 server 悄悄启用；项目级预算旋钮则会被静默清空）。
  // defer（ToolSearch 延迟开关）由表单渲染（复选框直接赋值），但行投影仍必须带上它，
  // 否则打开编辑框时复选框初始值是错的。
  assert.match(client, /if \(initial\.enabled === false\) spec\.disabled = true;/)
  assert.match(client, /for \(const key of \['idleTimeoutMs', 'readyTimeoutMs'\]\)/)
  assert.match(host, /"idleTimeoutMs", "readyTimeoutMs", "defer"\]\) if \(server\[field\] !== undefined\)/)
  // 详情页空态不能承诺“刷新即可看到工具”：那要求 tools RPC 真能枚举共享作用域层，
  // 而 toolInventory 只认 loader 条目 + 全局视图。要么能枚举，要么别承诺。
  assert.doesNotMatch(client, /刷新即可看到工具/)
  assert.match(host, /workspaceToolSchemas\(this\.ctx, value, wsPath\)\.map\(projectToolSchema\)/)
  // 项目 MCP 的详情必须带 wsPath 去问，否则两个项目同名时会列到另一个项目的工具。
  assert.match(client, /call\('tools', \{ name: selected, wsPath: scope \}\)/)
})

test('project MCP: the shared-connection reference is owned by cordis, not by our own bookkeeping', async () => {
  const runtime = await readFile(new URL('../lib/workspace-runtime.js', import.meta.url), 'utf8')
  // 一份引用 = 一个会话作用域的 effect。它的原子性使「从检查到记账不得有 await」这类
  // 只能靠注释约束的临界区消失；作用域已销毁时由 cordis 的 assertActive() 抛出，不自建判定。
  assert.match(runtime, /slot\.release = agentCtx\.effect\(\(\) => \(\) => disposeProjectSlot\(slot\), `mcp-manager\.projectConn/)
  // HMR 撤回必须走同一个官方 disposer（幂等由 cordis 的 runner\.epoch 保证），
  // 而不是另开一条释放路径——后者会让会话后续销毁时变成重复释放。
  assert.match(runtime, /typeof slot\.release === "function" \? slot\.release\(\) : disposeProjectSlot\(slot\)/)
  // 「本代挂载器还在管事吗」是插件代次的属性，不能和会话存活性共用同一张表。
  assert.match(runtime, /if \(!generation\.active\)/)
  assert.doesNotMatch(runtime, /if \(!agentWorkspaceStates\.has\(agent\)\)/)
  // 生命周期归属先建立、再订阅事件；缺少 effect() 直接抛，不静默降级。
  assert.doesNotMatch(runtime, /ctx\.effect\?\.\(/)
  assert.match(runtime, /无法为项目 MCP 挂载器建立生命周期归属/)
  // 并发等待者不能拿到一份正在 teardown 的连接（refs 从 0 再加回去）。
  assert.match(runtime, /entry\.released = true/)
  assert.match(runtime, /if \(entry\.released\) continue/)
})

test('project MCP: the design doc states the protocol claim per spec revision and names no false escape hatch', () => {
  // 随包 SDK 协商的是 2025-11-25（没有 Statelessness 一节），无状态那套要求来自 2026-07-28。
  // 不写清版本，等于把“按 2025-11-25 维护连接级状态”的服务器说成有缺陷。
  assert.match(designDoc, /2026-07-28[^]*?Statelessness/)
  assert.match(designDoc, /2025-11-25[^]*?没有\*\*\s?Statelessness/)
  assert.doesNotMatch(designDoc, /那是服务器自身的缺陷/)
  // 「放到全局作用域」「项目内另起 serverName」都给不了 per-session 隔离，不能当建议给出。
  assert.match(designDoc, /不支持 per-session 隔离/)
  assert.match(designDoc, /把它挪到全局作用域也没用/)
  // #28860 属于 anthropics/claude-code，不是 DSH 的提案。
  assert.doesNotMatch(designDoc, /DSH 的 shared-daemon 提案/)
})

test('project MCP: the tools contract carries wsPath, so the detail pane is not permanently empty', async () => {
  const { TYPERT } = await import('../lib/typert.js')
  const invocation = TYPERT.invocations.find((entry) => entry.method === 'tools')
  // 声明成标量 name 时，typert 网关会把 `{ name, wsPath }` 当作 args 映射展开并拒绝：
  // `args fields do not match the descriptor: unexpected "wsPath"`。
  // 于是项目 MCP 的详情页永远是空的——Host 侧早就能按 scopeKey 枚举，错只在契约窄了一格。
  assert.equal(invocation.parameters.length, 1)
  assert.equal(invocation.parameters[0].wire, 'payload')
  const clientDescriptor = client.match(/mcpManager\/tools'[^\n]*/)?.[0] ?? ''
  assert.match(clientDescriptor, /mcpParam\('payload'/)
  // 两条分支都必须发对象；裸字符串会落回标量参数那条老路。
  assert.match(client, /call\('tools', \{ name: selected, wsPath: scope \}\)/)
  assert.match(client, /call\('tools', \{ name: selected \}\)/)
  assert.doesNotMatch(client, /call\('tools', selected\)/)
})

test('project MCP: the read-only diagnostics RPC is declared, implemented and documented', async () => {
  const { TYPERT } = await import('../lib/typert.js')
  const host = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.ok(TYPERT.invocations.some((entry) => entry.method === 'projectConnections'))
  // Host 有、契约没有 = 客户端永远调不到；契约有、Host 没有 = 调用必失败。两边都要在。
  assert.match(host, /async projectConnections\(\) \{/)
  assert.match(host, /projectConnectionsView\(this\.ctx\)/)
  assert.match(client, /mcpManager\/projectConnections/)
  // refs 与 sessions 是两个独立事实（相等=健康），设计文档必须把这条判读方式写清楚，
  // 否则这个接口的返回值没人知道怎么用。
  assert.match(designDoc, /projectConnections/)
  assert.match(designDoc, /refs\s*>\s*sessions/)
})
