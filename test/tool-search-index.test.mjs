import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyStem,
  buildCatalog,
  parseQuery,
  searchCatalog,
  stemToken,
  tokenize,
  toolNameVariants,
} from '../lib/tool-search-index.js'

// ---- stemToken / applyStem ----

test('stemToken: 只归单复数，不动派生后缀', () => {
  // 单复数
  assert.equal(stemToken('symbols'), 'symbol')
  assert.equal(stemToken('references'), 'reference')
  assert.equal(stemToken('files'), 'file')
  assert.equal(stemToken('tools'), 'tool')
  // -ies → -y
  assert.equal(stemToken('queries'), 'query')
  // -ses/-xes/-zes/-ches/-shes 去两个字符
  assert.equal(stemToken('classes'), 'class')
  assert.equal(stemToken('boxes'), 'box')
  // 已知边界（s-stemmer 固有，不修）：双写辅音 + es 的名词会差一个字符
  // （quizzes → quizz，而 quiz 原样）。后果只是这类词开不开 stem 都匹配不上，
  // 相对"不开 stem"没有回退；为它加规则要把 6 行变 15 行，收益近零，所以不加。
  assert.equal(stemToken('quizzes'), 'quizz')
  assert.equal(stemToken('quiz'), 'quiz')
  // 不该动的：ss/us/is 结尾、短词、以及派生后缀（那是 Porter 的活，会 overstem）
  assert.equal(stemToken('class'), 'class')
  assert.equal(stemToken('analysis'), 'analysis')
  assert.equal(stemToken('is'), 'is')
  assert.equal(stemToken('as'), 'as')
  assert.equal(stemToken('referencing'), 'referencing')
  assert.equal(stemToken('declared'), 'declared')
  assert.equal(stemToken('declaration'), 'declaration')
})

test('applyStem: 开关关闭时原样返回', () => {
  assert.deepEqual(applyStem(['symbols', 'tools'], false), ['symbols', 'tools'])
  assert.deepEqual(applyStem(['symbols', 'tools'], true), ['symbol', 'tool'])
})

test('buildCatalog/searchCatalog: stem 开关让单复数互相命中', () => {
  const schemas = [
    { name: 'mcp__s__find_symbol', description: 'Finds symbols by name path pattern', parameters: null },
    { name: 'mcp__s__list_files', description: 'Lists files in a directory', parameters: null },
  ]
  // 查询用单数、描述用复数：不开 stem 时 find_symbol 匹配不上 "symbol" 之外全靠名字，
  // 开了之后描述里的 "symbols" 也能贡献分数。
  const off = searchCatalog(buildCatalog(schemas, false), 'find symbol', 5, false)
  const on = searchCatalog(buildCatalog(schemas, true), 'find symbol', 5, true)
  assert.deepEqual(off.map((m) => m.name), ['mcp__s__find_symbol'])
  assert.deepEqual(on.map((m) => m.name), ['mcp__s__find_symbol'])

  // 反向：查询用复数。不开 stem 时完全匹配不上描述里的单数词。
  const offPlural = searchCatalog(buildCatalog(schemas, false), 'find symbols', 5, false)
  const onPlural = searchCatalog(buildCatalog(schemas, true), 'find symbols', 5, true)
  assert.deepEqual(offPlural.map((m) => m.name), ['mcp__s__find_symbol'], '名字仍命中（NAME_BONUS）')
  assert.deepEqual(onPlural.map((m) => m.name), ['mcp__s__find_symbol'])
})

test('buildCatalog/searchCatalog: 两侧 stem 不一致时不许比一致时更糟', () => {
  // 这条守的是不变量：查询侧与文档侧必须同一个开关。归一半会让 "symbols"（文档，已归）
  // 对不上 "symbols"（查询，未归）——比两边都不归更糟。
  // 工具名刻意**不含** symbol：否则名字那一次命中 + NAME_BONUS 会让"归一半"也蒙对，
  // 从而掩盖这条不变量被破坏时的静默空结果。
  const schemas = [
    { name: 'mcp__s__alpha', description: 'Finds symbols and code entities', parameters: null },
    { name: 'mcp__s__beta', description: 'Unrelated tool', parameters: null },
  ]
  const query = 'symbols'
  const both = searchCatalog(buildCatalog(schemas, true), query, 5, true)
  const neither = searchCatalog(buildCatalog(schemas, false), query, 5, false)
  const halfQuery = searchCatalog(buildCatalog(schemas, true), query, 5, false)
  const halfDoc = searchCatalog(buildCatalog(schemas, false), query, 5, true)
  assert.deepEqual(both.map((m) => m.name), ['mcp__s__alpha'], '两边都归：命中')
  assert.deepEqual(neither.map((m) => m.name), ['mcp__s__alpha'], '两边都不归：命中')
  assert.deepEqual(halfQuery.map((m) => m.name), [], '只归文档侧：查询词对不上，静默空结果')
  assert.deepEqual(halfDoc.map((m) => m.name), [], '只归查询侧：同样静默空结果')
})

test('searchCatalog: +server 约束的词也过同一个 stemmer', () => {
  // 约束词与 nameTokens 必须同一个开关：服务器名是复数形式时，只归一侧会恒不匹配。
  // 只用约束词（无排序词）→ 走平权分支，返回该服务器全体，正好单独检验约束本身。
  const schemas = [
    { name: 'mcp__tools__a', description: 'first', parameters: null },
    { name: 'mcp__tools__b', description: 'second', parameters: null },
    { name: 'mcp__other__c', description: 'third', parameters: null },
  ]
  const on = searchCatalog(buildCatalog(schemas, true), '+tools', 5, true)
  assert.deepEqual(on.map((m) => m.name), ['mcp__tools__a', 'mcp__tools__b'])
  // 关掉时：约束词 'tools' 未归、nameTokens 也未归，仍能对上（同侧一致即可）。
  const off = searchCatalog(buildCatalog(schemas, false), '+tools', 5, false)
  assert.deepEqual(off.map((m) => m.name), ['mcp__tools__a', 'mcp__tools__b'])
})

// ---- tokenize ----

test('tokenize: 拉丁词按非字母数字切分并小写', () => {
  assert.deepEqual(tokenize('Browser Screenshot'), ['browser', 'screenshot'])
  assert.deepEqual(tokenize('mcp__jshook__browser_launch'), ['mcp', 'jshook', 'browser', 'launch'])
})

test('tokenize: CJK 走字符二元分词，单字原样', () => {
  assert.deepEqual(tokenize('浏览器'), ['浏览', '览器'])
  assert.deepEqual(tokenize('截图'), ['截图'])
  assert.deepEqual(tokenize('浏览器截图'), ['浏览', '览器', '器截', '截图'])
})

test('tokenize: 中英混排', () => {
  assert.deepEqual(tokenize('jshook 浏览器'), ['jshook', '浏览', '览器'])
})

test('tokenize: 空与缺省不炸', () => {
  assert.deepEqual(tokenize(''), [])
  assert.deepEqual(tokenize(undefined), [])
  assert.deepEqual(tokenize('   ***   '), [])
})

// ---- toolNameVariants ----

test('toolNameVariants: MCP 名给全名与裸名', () => {
  assert.deepEqual(toolNameVariants('mcp__jshook__browser_launch'), ['mcp__jshook__browser_launch', 'browser_launch'])
  assert.deepEqual(toolNameVariants('Read'), ['Read'])
})

// ---- buildCatalog ----

test('buildCatalog: 跳过非法条目，参数文本入索引', () => {
  const catalog = buildCatalog([
    { name: 'mcp__a__screenshot', description: 'take a screenshot', parameters: { properties: { quality: {} } } },
    { name: '', description: 'bad' },
    null,
    { description: 'no name' },
  ])
  assert.equal(catalog.size, 1)
  const entry = catalog.get('mcp__a__screenshot')
  assert.ok(entry.nameTokens.has('screenshot'))
  assert.ok(entry.documentTokens.includes('quality')) // 参数名参与索引
})

test('buildCatalog: 同名后者覆盖', () => {
  const catalog = buildCatalog([
    { name: 'x', description: 'first', parameters: null },
    { name: 'x', description: 'second', parameters: null },
  ])
  assert.equal(catalog.size, 1)
  assert.equal(catalog.get('x').description, 'second')
})

// ---- parseQuery ----

test('parseQuery: +约束按名字同一切词规则切成词集合', () => {
  // serverName 允许 - 和 _（mcp-client SERVER_NAME_PATTERN），而工具名按非字母数字切词，
  // 所以约束也必须切成词集合——否则 +chrome-devtools 永远匹配不上任何名字。
  assert.deepEqual(parseQuery('+slack send'), { kind: 'filter', requiredTokens: ['slack'], terms: ['send'], raw: '+slack send' })
  assert.deepEqual(parseQuery('+chrome-devtools snapshot'), { kind: 'filter', requiredTokens: ['chrome', 'devtools'], terms: ['snapshot'], raw: '+chrome-devtools snapshot' })
  assert.deepEqual(parseQuery('+my_server send'), { kind: 'filter', requiredTokens: ['my', 'server'], terms: ['send'], raw: '+my_server send' })
  // 约束词被完整剔除，不再作为排序词重复计分。
  assert.deepEqual(parseQuery('+jshook browser').terms, ['browser'])
})

test('parseQuery: 中文关键词', () => {
  // 空格分隔的两段 CJK 各自二元分词（跨段不成组）。
  assert.deepEqual(parseQuery('浏览器 截图'), { kind: 'keywords', terms: ['浏览', '览器', '截图'], raw: '浏览器 截图' })
})

// ---- searchCatalog ----

const SCHEMAS = [
  { name: 'mcp__jshook__browser_screenshot', description: 'Take a screenshot of the current page in a browser.', parameters: { properties: { fullPage: { type: 'boolean' } } } },
  { name: 'mcp__jshook__browser_launch', description: 'Launch a browser instance with a profile.', parameters: { properties: { headless: { type: 'boolean' } } } },
  { name: 'mcp__firecrawl__firecrawl_scrape', description: 'Scrape a webpage and return markdown content.', parameters: { properties: { url: { type: 'string' } } } },
  { name: 'mcp__jshook__network_http_request', description: 'Send an HTTP request over the network.', parameters: { properties: { method: { type: 'string' } } } },
]

test('searchCatalog: 空目录返回空', () => {
  assert.deepEqual(searchCatalog(buildCatalog([]), 'browser', 5), [])
})

test('searchCatalog: select 精确取，缺失也回报，保序去重', () => {
  const catalog = buildCatalog(SCHEMAS)
  const matches = searchCatalog(catalog, 'select:mcp__jshook__browser_launch,mcp__nope__gone,mcp__firecrawl__firecrawl_scrape,mcp__jshook__browser_launch', 5)
  assert.equal(matches.length, 3)
  assert.equal(matches[0].name, 'mcp__jshook__browser_launch')
  assert.equal(matches[0].found, true)
  assert.equal(matches[1].name, 'mcp__nope__gone')
  assert.equal(matches[1].found, false)
  assert.equal(matches[2].name, 'mcp__firecrawl__firecrawl_scrape')
})

test('searchCatalog: 名字命中压过描述命中（非精确名形态）', () => {
  // M3 的闸门：**查询词不能等于工具全名/裸名**。等名形态会走 isExactName 的 Infinity 分支，
  // 把 NAME_BONUS 短路掉——旧的 'screenshot' 用例正是这样，于是 NAME_BONUS 12→0 时全量仍绿。
  // 这里两个文档命中同一个词，只有名字命中侧拿 bonus：
  //   mcp__srv__browser_launch 描述里没有 "browser"，名字里有 → nameHit
  //   mcp__srv__page_open      名字里没有 "browser"，描述里密集出现 → tf 再高也不能翻盘
  const catalog = buildCatalog([
    { name: 'mcp__srv__browser_launch', description: 'Start a new instance of the application under test.', parameters: null },
    { name: 'mcp__srv__page_open', description: 'Open a browser page. The browser context decides browser behaviour.', parameters: null },
  ])
  assert.equal(searchCatalog(catalog, 'browser', 5)[0].name, 'mcp__srv__browser_launch',
    '名字命中必须压过纯描述命中——没有 NAME_BONUS 时 tf 更密的那条会反超')
})

test('searchCatalog: 多词查询里名字命中同样压过参数/描述命中', () => {
  // 命中的是参数文本里的词，而名字恰好含 "encode" 的那条连 query 都没碰上，
  // 却因名字命中拿 bonus——两条路径都得压住，否则参数文本权重一高就反超。
  const catalog = buildCatalog([
    { name: 'mcp__srv__encode', description: 'Convert a document into a compact form.', parameters: { properties: { format: { type: 'string', description: 'Output format.' } } } },
    { name: 'mcp__srv__doc_convert', description: 'Convert a document into a compact form.', parameters: { properties: { encoding: { type: 'string', description: 'Text encoding.' } } } },
  ])
  assert.equal(searchCatalog(catalog, 'encode document', 5)[0].name, 'mcp__srv__encode')
})

test('searchCatalog: 关键词 top-N 限制生效', () => {
  const catalog = buildCatalog(SCHEMAS)
  const matches = searchCatalog(catalog, 'browser', 2)
  assert.equal(matches.length, 2)
  assert.ok(matches.every((match) => match.name.includes('browser')))
})

test('searchCatalog: +约束只保留名字含该词的', () => {
  const catalog = buildCatalog(SCHEMAS)
  const matches = searchCatalog(catalog, '+jshook browser', 5)
  assert.ok(matches.length >= 2)
  assert.ok(matches.every((match) => match.name.startsWith('mcp__jshook__')))
})

test('searchCatalog: +约束对含连字符/下划线的服务器名生效', () => {
  // SERVER_NAME_PATTERN 允许 - 与 _；内置目录 47 个里 11 个含 -（chrome-devtools、brave-search…）。
  const catalog = buildCatalog([
    { name: 'mcp__chrome-devtools__take_snapshot', description: 'Take a snapshot of the current page.', parameters: null },
    { name: 'mcp__brave-search__web_search', description: 'Search the web for a query.', parameters: null },
    { name: 'mcp__my_server__send', description: 'Send a message.', parameters: null },
  ])
  assert.deepEqual(searchCatalog(catalog, '+chrome-devtools snapshot', 5).map((m) => m.name), ['mcp__chrome-devtools__take_snapshot'])
  assert.deepEqual(searchCatalog(catalog, '+brave-search', 5).map((m) => m.name), ['mcp__brave-search__web_search'])
  assert.deepEqual(searchCatalog(catalog, '+my_server send', 5).map((m) => m.name), ['mcp__my_server__send'])
  // 约束词不匹配时返回空（不再误伤全部候选）。
  assert.deepEqual(searchCatalog(catalog, '+nope snapshot', 5), [])
})

test('searchCatalog: 整条查询恰是工具全名时确定性置顶', () => {
  const catalog = buildCatalog(SCHEMAS)
  const matches = searchCatalog(catalog, 'screenshot', 5)
  assert.equal(matches[0].name, 'mcp__jshook__browser_screenshot')
})

test('searchCatalog: 平手按 code-unit 序（locale 无关，目录字节稳定）', () => {
  // localeCompare 对混合大小写给出与 code-unit 不同的序，目录因此不是字节稳定的，
  // 也与宿主自己的工具排序（dsh-system-prompt compareToolNames）不一致。
  // **输入序刻意与期望序相反**：两条分数严格相等，没有 tie-break 时 V8 的稳定排序
  // 会原样保留输入序，用例就变成恒真（旧 fixture 的 alpha 在前正是这个形状）。
  const catalog = buildCatalog([
    { name: 'mcp__srv__alpha', description: 'identical description text', parameters: null },
    { name: 'mcp__srv__Beta', description: 'identical description text', parameters: null },
  ])
  assert.deepEqual(searchCatalog(catalog, 'identical description text', 5).map((m) => m.name), ['mcp__srv__Beta', 'mcp__srv__alpha'])
})

test('searchCatalog: 只有约束词时平权返回全部候选', () => {
  const catalog = buildCatalog(SCHEMAS)
  const matches = searchCatalog(catalog, '+firecrawl', 5)
  assert.equal(matches.length, 1)
  assert.equal(matches[0].name, 'mcp__firecrawl__firecrawl_scrape')
})

test('searchCatalog: 中文查询命中中文描述', () => {
  const catalog = buildCatalog([
    { name: 'mcp__a__shot', description: '对当前页面截图，保存为 PNG', parameters: null },
    { name: 'mcp__b__launch', description: '启动一个浏览器实例', parameters: null },
  ])
  const matches = searchCatalog(catalog, '截图', 5)
  assert.equal(matches[0].name, 'mcp__a__shot')
})

test('searchCatalog: 无命中返回空', () => {
  const catalog = buildCatalog(SCHEMAS)
  assert.deepEqual(searchCatalog(catalog, 'zzzznotfound', 5), [])
})

test('searchCatalog: 精确全名查询直接置顶（模型从目录 section 抄名字的场景）', () => {
  const catalog = buildCatalog(SCHEMAS)
  const matches = searchCatalog(catalog, 'mcp__firecrawl__firecrawl_scrape', 5)
  assert.equal(matches[0].name, 'mcp__firecrawl__firecrawl_scrape')
  assert.equal(matches[0].score, Infinity)
})

test('searchCatalog: maxResults 非法值兜底为 1', () => {
  const catalog = buildCatalog(SCHEMAS)
  assert.equal(searchCatalog(catalog, 'browser', 0).length, 1)
  assert.equal(searchCatalog(catalog, 'browser', -3).length, 1)
})
