// 改名（row 16 / D16）—— 本计划的最后一步。
//
// 为什么这一行值得单独一套测试：改名**没有编译期保护**。漏掉任何一处都不会报错，
// 只会以各种静默方式失效——契约 id 与实际 endpoint 不符（客户端调不通）、
// module id 与 loader 认领的凭据不符（样式变孤儿）、UPGRADE_PACKAGE 还指着旧包
// （一键升级把用户装回旧包）。所以这里的原则是：
//
//   1. **身份耦合点必须与 package.json 的 name 一致**（不硬编码新名字，从 package.json 推导）；
//   2. **不得有漏网之鱼**：整个仓库里剩下的 `dsh-mcp-manager-ui` 必须逐处在白名单里，
//      且每条都要说明为什么可以留。
//
// 白名单之外一律判红——这是唯一能机械保证「改全了」的手段。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TYPERT } from '../lib/typert.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const client = readFileSync(join(ROOT, 'lib/client.js'), 'utf8')
const hostIndex = readFileSync(join(ROOT, 'lib/index.js'), 'utf8')
const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')

/** 新包名。不写字面量：从 package.json 推导，改名只发生在一个地方。 */
const NAME = packageJson.name

/**
 * 旧包名。**故意写死**——它正是「这一行是不是还在用旧身份」的判据。
 *
 * ⚠️ 别把它抽成「从 package.json 推导」之类的东西，也别让改名脚本改到它：
 * 本文件首版就是被改名脚本顺手改掉了这里的字面量，结果它拿**新**名去查「旧名残留」，
 * 把新包名的每一行都报成漏网、而真正的旧名残留一处也没查。
 * 定义基准的测试必须排除在被测的那次改动之外。
 */
const OLD_NAME = 'dsh-mcp-manager-ui'

test('the package identity is the new name everywhere it is an identity', () => {
  assert.equal(NAME, 'dsh-toolbox-ui', 'package.json 的 name 应是新包名')
  // cordis.patch.yml 的 name 是**用户 profile 里的挂载名**，必须跟着改；
  // id 是内部标识（package-contract 断言唯一），保留即可。
  assert.match(patch, new RegExp(`name: ${NAME}\\b`), 'cordis.patch.yml 的挂载名应改为新包名')
  assert.match(patch, /id: mcp-manager-ui\b/, 'id 是内部标识，保留（改名后仍是唯一那条）')
})

test('the typert contract is entirely keyed by the new package name', () => {
  // package 由宿主的 validateTypertManifest(package.json.name, TYPERT) 校验，必须一致。
  assert.equal(TYPERT.package, NAME, 'TYPERT.package 必须等于 package.json.name')
  assert.ok(TYPERT.invocations.length > 0)
  for (const invocation of TYPERT.invocations) {
    // id 由 `包名#namespace/method` 构成：漏改一处就会出现「id 说旧包、endpoint 在新包」。
    assert.ok(invocation.id.startsWith(`${NAME}#`),
      `${invocation.id} 的 id 前缀不是新包名`)
    // sourceLocation 指向包内文件，也要跟着改（否则指向一个不存在的路径）。
    assert.ok(invocation.sourceLocation.file.startsWith(`${NAME}/`),
      `${invocation.id} 的 sourceLocation.file 仍指向旧包路径：${invocation.sourceLocation.file}`)
  }
  // codec 的 typeSymbol 同样是包级标识（宿主按它做跨 realm 判定）。
  const symbols = new Set()
  for (const invocation of TYPERT.invocations) {
    for (const parameter of invocation.parameters) symbols.add(parameter.codec.typeSymbol)
    symbols.add(invocation.result.typeSymbol)
  }
  for (const symbol of symbols) {
    assert.ok(symbol.startsWith(`${NAME}/typert#`), `typeSymbol ${symbol} 不是新包名`)
  }
})

test('the client contribution and its styles are keyed by the new package name', () => {
  // 客户端这份是 typert.js 的**同形状副本**，两处必须一起改（client-lifecycle 会 deepEqual）。
  assert.match(client, new RegExp(`package: '${NAME}'`), '客户端 contribution 的 package 应改')
  assert.equal((client.match(/package: '[^']+'/g) ?? []).length, 1, '只能有一个 contribution')
  // module id：loader 按它认领模块。
  assert.match(client, new RegExp(`id: '${NAME}'`), "client.js 的模块 id 应改为新包名")
  // 样式认领凭据：data-plugin 与 css 去重键都按包名走，漏改会让样式变孤儿。
  assert.match(client, new RegExp(`dataset\\.plugin = '${NAME}'`), 'dataset.plugin 应改为新包名')
  assert.match(client, new RegExp(`'${NAME}/mcp\\.css'`), 'CSS 去重键应改为新包名')
  // 一键升级目标包名：漏改会把用户「升级」回旧包。
  assert.match(client, new RegExp(`UPGRADE_PACKAGE = '${NAME}'`), 'UPGRADE_PACKAGE 应改为新包名')
  // descriptor 的 id 与 sourceLocation 也要跟着走。
  const descriptorIds = [...client.matchAll(/id: '([^']*#[a-zA-Z]+\/[a-zA-Z]+)'/g)].map((match) => match[1])
  assert.ok(descriptorIds.length > 0, '应能扫到 descriptor 的 id')
  for (const id of descriptorIds) {
    assert.ok(id.startsWith(`${NAME}#`), `descriptor ${id} 的 id 前缀不是新包名`)
  }
})

test('the old package name survives only where it is still factually correct', () => {
  // 这条是「改全了」的机械保证：整个仓库剩下的旧包名必须逐处能说清为什么**不该**改。
  //
  // ⚠️ 首版这里是**恒真**的：白名单里放了一条 catch-all `/dsh-mcp-manager-ui/`（本意是
  // 「指代旧包的说明文字」），而它匹配**任何**含旧包名的行——138 处全部被放行，
  // 于是这条「防漏网」的用例其实什么都没防（改名前后同样通过）。这正是它要防的失败形态。
  //
  // 现在的做法：逐**出现**判定上下文，且只认「明确的事实性引用」形态——
  // URL、安装命令、localStorage 键、环境变量名，以及在**同一行内**明确指代旧包的措辞。
  const reasons = [
    { pattern: /Imzl-zl\/dsh-mcp-manager-ui/, why: '改名前的仓库坐标（历史链接与夹具；GitHub 对旧地址 301）' },
    // ⚠️ 这里**故意不再**放行「`dsh plugin … add/update <旧包>`」这类安装命令行。
    // 曾经的放行理由是"旧包的安装命令（迁移说明要保留）"，但它在**行的形状**上做判定：
    // 「叫用户装旧包」和「告诉用户怎么从旧包迁过来」长得一模一样，于是 v1.6.0 的发布稿把
    // 旧包名当成主安装路径（npm 上装不到这条线）也照样通过。迁移说明现在靠**同行的
    // 「旧包 / 此前叫 / 迁移」措辞**放行（见下面那条），安装命令本身不再有豁免。
    // localStorage 键有**两种**写法（SPEC 附录 A 点名：`/entry`、`/fab-pos`、`.updateHint.dismissed`、
    // `.whatsNew.seen`），所以分隔符既可能是 `/` 也可能是 `.`——只写 `/` 会漏放行一半。
    { pattern: /dsh-mcp-manager-ui[/.]/, why: 'localStorage 键（键名不影响功能，改了会丢用户设置）' },
    { pattern: /DSH_MCP_MANAGER_DISABLE_UPDATE_CHECK/, why: '既有环境变量名（改了会让用户已设的开关失效）' },
    // 指代旧包的说明文字：必须**同行**出现明确的指代词，光有包名不算。
    { pattern: /(?:旧包|旧版|让位|前者|migration|legacy|renamed|already registered|迁移|此前叫)/, why: '明确指代旧包的说明文字' },
    // 让位检测的测试夹具：它**故意**模拟「另一个（旧的）管理插件」，旧包名是它要匹配的目标。
    { pattern: /dsh-mcp-manager-ui-old/, why: '让位检测的测试夹具（模拟旧包）' },
    // 真机形态的夹具与断言：旧包的 loader `name` 就是旧包名本身（它与新包**共用同一个 patch id**，
    // 所以判据只能按 name）。这里必须是旧包名的**带引号字面量**，否则测不到 C2 那条缺陷。
    { pattern: /'dsh-mcp-manager-ui'/, why: '让位检测里「旧包真实 loader name」的夹具与断言' },
    // 「`name: <旧名>`」这种引用改名前的挂载名、用于说明的注释。
    { pattern: /name: dsh-mcp-manager-ui/, why: '注释里引用改名前的挂载名' },
    // 定义基准的测试自身：OLD_NAME 及其注释**必须**保留旧名（否则判据就失效了）。
    { pattern: /OLD_NAME/, why: '本测试自己的旧名基准常量' },
    { pattern: /整个仓库里剩下的/, why: '本测试的说明注释' },
    // 仓库本身的三个字段：仓库仍叫旧名（D13 双包同仓），这是**事实**，改了反而错。
    { pattern: /^(?:git\+https|https):\/\/github\.com\/Imzl-zl\/dsh-mcp-manager-ui/, why: '改名前的仓库坐标（历史链接与夹具；GitHub 对旧地址 301，删了等于假装那条线没存在过）' },
    // 曾经还有一条 `api.github.com/repos/Imzl-zl/dsh-mcp-manager-ui` 的豁免，理由是「更新检查
    // 走同一仓库」。1.6.2 起更新检查问的是**本包在 npm 上的 latest**（lib/index.js 的
    // updateLatestUrl），那条 URL 全仓已不再产生——豁免随之删掉：留一条永不命中的规则，
    // 等于把「为什么放行」记成一句假话。
    // 曾经还有一条「作者本地 checkout 路径」的豁免：文档里的本地开发示例已改成通用占位路径
    // （`C:\path\to\dsh-toolbox-ui`），旧路径不再出现在仓库里，豁免随之删掉。
    // 既装旧包的 source fixture（link:/file:/tgz）：正是被测对象要识别的输入。
    { pattern: /^(?:'|\s)*'?(?:link:|file:)[^']*dsh-mcp-manager-ui/, why: '「已装旧包」的 source 夹具' },
    // localStorage 键的两种分隔符写法已在上面覆盖；这里补「文档里举例说明键名」的行。
    { pattern: /dsh-mcp-manager-ui[./](?:entry|fab-pos|updateHint|whatsNew)/, why: '文档里举例说明 localStorage 键名' },
    // 迁移命令里要**卸掉**的正是旧包：这条命令写新名就等于没卸，旧插件会和本包同时在场。
    { pattern: /dsh plugin[^\n]*remove dsh-mcp-manager-ui/, why: '迁移命令里要被卸掉的旧包名（写新名就是错的）' },
    // 迁移说明里必须指出「你现在装的是旧包」才有意义（否则读者不知道自己该不该走这条路）。
    { pattern: /仍装着旧包|Still on the legacy package/, why: '迁移说明里指认读者当前装的是旧包' },
    // npm Trusted Publisher 的 repository 字段 = GitHub 仓库名（仍叫旧名）。
    // npm Trusted Publisher 的 repository 字段、以及 workflow 注释里的同一件事：
    // 值是 **GitHub 仓库名**（仓库仍叫旧名），分隔符按写法可能是 `=` 也可能被反引号包着。
    { pattern: /repository\s*[=:]?\s*`?dsh-mcp-manager-ui/, why: 'Trusted Publisher / workflow 里的 repository = 仓库名' },
    // 本测试自己的白名单模式行（它们**必须**含旧名字面量才起作用）。
    { pattern: /\{ pattern: \//, why: '本测试的模式定义行' },
    // 解释「仓库名 ≠ 包名」的注释：必须写出两个名字才能说明区别（仓库仍叫旧名）。
    { pattern: /仓库仍|仓库名(?:与包名|不变)|仓库不跟着改/, why: '解释仓库名与包名区别的注释' },
    // 解释「同一个仓库里两条产品线」的注释：同理必须同时写出两个包名。
    { pattern: /两条产品线|toolbox 线/, why: '解释同一仓库两条产品线的注释' },
  ]
  /** 这一行里旧包名的每一次出现，是否都落在某个可解释的上下文里。 */
  const excusable = (line) => {
    const occurrences = line.split(OLD_NAME).length - 1
    if (occurrences === 0) return true
    return reasons.some((entry) => entry.pattern.test(line))
  }

  const stragglers = []
  const files = []
  // ⚠️ 必须**递归**：首版只 readdir 一层，于是 `.github/` 下的子目录整个没被看过——
  // `.github/release-notes/v1.6.0.md` 把旧包名当成主安装路径（npm 上根本装不到这条线）、
  // `release.yml` 把 Release 标题写死成旧包名，两处都因此留了好几轮才被翻出来。
  // 这条闸的价值全在覆盖面，漏一个子目录就等于漏一整类文件。
  const walk = (dir) => {
    let entries
    try { entries = readdirSync(join(ROOT, dir), { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const relative = `${dir}/${entry.name}`
      if (entry.isDirectory()) { walk(relative); continue }
      if (/\.(?:js|mjs|md|ya?ml)$/.test(entry.name)) files.push(relative)
    }
  }
  for (const dir of ['lib', 'test', 'scripts', '.github', 'docs']) walk(dir)
  files.push('package.json', 'cordis.patch.yml', 'README.md', 'README.en.md', 'pnpm-workspace.yaml')

  let occurrences = 0
  for (const relative of files) {
    let text
    try { text = readFileSync(join(ROOT, relative), 'utf8') } catch { continue }
    // ⚠️ 历史设计文档**按文件**豁免：它记的是「当时（包还叫旧名）为什么这么决策」，
    // 改它等于改写历史记录。行级白名单表达不了这件事——它的每一行都只是普通叙述。
    if (relative.endsWith('mcp-market-design.md')) continue
    // 历史**发布稿**同理豁免：v1.5.x 及更早发的是旧包，稿子里的安装命令与 compare 链接
    // 是既成事实。但**当前版本**那份必须查——它就是这次要发出去的稿子。
    if (/^\.github\/release-notes\//.test(relative) && relative !== `.github/release-notes/v${packageJson.version}.md`) continue
    for (const line of text.split('\n')) {
      if (!line.includes(OLD_NAME)) continue
      occurrences += line.split(OLD_NAME).length - 1
      if (!excusable(line.trim())) stragglers.push(`${relative}: ${line.trim().slice(0, 110)}`)
    }
  }
  // 下界：改名后仍应保留相当数量的**事实性**引用（仓库 URL、旧包安装命令、迁移说明），
  // 否则说明这条用例的取样范围退化了（例如 files 列表空了，循环空转也会「通过」）。
  assert.ok(occurrences > 0, '一处旧包名都没有，取样范围疑似失效（这条用例会变成恒真）')
  assert.deepEqual(stragglers, [],
    `这些行仍以「身份」的方式使用旧包名（要么改掉，要么加进白名单并说明理由）：\n${stragglers.join('\n')}`)
})

test('the style class prefix is untouched, because it is not the package name', () => {
  // SPEC 约束 7：`dsh-mcp-*` 是**内部类名前缀**（16 处量级的样式命名），与包名无关。
  // 改了会与 main 大面积冲突，且 theme-contract 的类扫描正则写死这个前缀。
  // 下界用 500 而不是精确值：样式只会增，钉死数字会让每次加样式都要改测试。
  const classNames = (client.match(/dsh-mcp-(?!manager-ui)/g) ?? []).length
  assert.ok(classNames > 500, `客户端里的 dsh-mcp-* 类名前缀只剩 ${classNames} 处，疑似被改名波及`)
  // 反向：不得把**样式前缀**也改成新包名（那样与 main 大面积冲突，且 theme-contract 的
  // 类扫描正则写死 dsh-mcp-）。只在类名语境里查，不能写成 /dsh-toolbox-[a-z]/——
  // 新包名本身就是 dsh-toolbox-ui，那条恒真。
  assert.doesNotMatch(client, /className: '[^']*dsh-toolbox-/, '不得把样式类前缀改成新包名')
  assert.doesNotMatch(client, /\.dsh-toolbox-[a-z]/, '不得把样式选择器前缀改成新包名')
})
