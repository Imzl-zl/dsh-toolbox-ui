// C2 的配置面：三个**有实测依据**的参数，落点是插件自己 patch 行（`- id: mcp-manager-ui`）的
// `config.toolSearch`，不是新开一个设置文件。
//
// 这组用例钉三件事：
//   ① 配置 schema 在**宿主加载时**就拒绝非法值——包括已删除的键（`descriptionChars`）、
//      已被删除的门槛（`threshold` / `minServerTools`）与拼错的键。写错了要当场红，不是静默忽略。
//   ② 缺省值只有一个真源：DEFAULTS + `resolveRuntimeConfig` 的既有规则（`maxDiscovered` 的
//      下限抬到 `maxResults`）。这里不重新抄一遍数字。
//   ③ 落盘是**稀疏**的：与默认相同的值不写，所以将来默认值有实测依据再调整时，用户不会被
//      一个当年抄下来的数字钉住。写回时其它条目、注释、以及同一条目里的其它键原样保留。
import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULTS } from '../lib/tool-search-runtime.js'
import {
  TOOL_SEARCH_CONFIG_KEY,
  ToolSearchConfigSchema,
  effectiveToolSearchSettings,
  normalizeToolSearchSettings,
  readToolSearchSettings,
  readToolSearchSettingsFromPatch,
  setToolSearchSettingsInPatch,
} from '../lib/tool-search-settings.js'

const validate = (raw) => ToolSearchConfigSchema['~standard'].validate(raw)
const PLUGIN = 'dsh-toolbox-ui'

// ── ① 配置 schema ──────────────────────────────────────────────────────

test('配置 schema：没有 config 时也要通过（否则每个老 profile 升级后都起不来）', () => {
  // loader 对 `- id: mcp-manager-ui / name: dsh-toolbox-ui` 这种没有 config 的行传 undefined。
  // 若 schema 不接受 undefined，升级即等于面板消失——这是这条用例存在的唯一理由。
  const defaults = { maxResults: DEFAULTS.maxResults, maxCatalogLines: DEFAULTS.maxCatalogLines, maxDiscovered: DEFAULTS.maxDiscovered }
  for (const raw of [undefined, {}, { toolSearch: undefined }]) {
    const result = validate(raw)
    assert.equal(result.issues, undefined, `${JSON.stringify(raw)} 必须通过校验：${JSON.stringify(result.issues)}`)
    // 断言落在真正要保的东西上：这几种形状都得等于"全部跟随默认"（而不是某个具体的对象形状）。
    assert.deepEqual(effectiveToolSearchSettings(readToolSearchSettings(result.value)), defaults)
  }
})

test('cordis 的真实校验路径接受"没有 config"（存量 profile 的升级路径）', async () => {
  // 上面那条用的是 schema 自己的 `~standard`；这条换成**宿主会用的那段代码**：
  // cordis 导出的 `resolveConfig(runtime, config)`。链路是 loader 把 `entry.options.config`
  // 原样交给 cordis（cordis-plugin-loader:537 `this.ctx.registry.plugin(plugin, this.options.config)`），
  // cordis 再用它过我们的 `static Config`。存量 profile 的那条 patch 行没有 `config:`，
  // 所以传进来是 **undefined** —— 不接受它 = 所有用户升级后面板直接消失。
  //
  // 端到端那一步（真 loader 按包名加载本插件 + 该条目无 config）另做了一次一次性核对：
  // 插件加载成功、`mcpManager` 在、`tool_search` 已注册。那一步需要往 node_modules 里临时
  // 造一个 junction 让包名可解析，带副作用，所以不进用例；这里覆盖的是同一段校验代码。
  const { resolveConfig } = await import('@deepseek-ai/cordis')
  const { McpManagerGateway } = await import('../lib/index.js')
  assert.deepEqual(resolveConfig(McpManagerGateway, undefined), {})
  assert.deepEqual(resolveConfig(McpManagerGateway, {}), {})
  assert.deepEqual(resolveConfig(McpManagerGateway, { toolSearch: { maxResults: 20 } }), { toolSearch: { maxResults: 20 } })
  // 非法值在**加载期**就炸（不是等到第一次搜索），报错里带路径——这就是"写错了当场看得见"。
  assert.throws(() => resolveConfig(McpManagerGateway, { toolSearch: { maxResults: 0 } }), /invalid config/)
  assert.throws(() => resolveConfig(McpManagerGateway, { toolsearch: { maxResults: 20 } }), /invalid config/)
})

test('配置 schema：只认三个键，非法值与未知键当场报错', () => {
  const ok = validate({ toolSearch: { maxResults: 20, maxCatalogLines: 120, maxDiscovered: 30 } })
  assert.equal(ok.issues, undefined)
  assert.deepEqual(ok.value, { toolSearch: { maxResults: 20, maxCatalogLines: 120, maxDiscovered: 30 } })

  // 数值必须是指数级正整数：0 / 负数 / 小数 / 字符串都不接受（resolveRuntimeConfig 同样拒）。
  for (const bad of [0, -1, 1.5, '10', null]) {
    const result = validate({ toolSearch: { maxResults: bad } })
    assert.ok(result.issues?.length > 0, `maxResults=${JSON.stringify(bad)} 必须被拒`)
    assert.equal(result.issues[0].path.join('.'), 'toolSearch.maxResults')
  }

  // 已删除的键必须报错，而不是"写了但没人读"——descriptionChars 与两道门槛都属这一类。
  for (const removed of ['descriptionChars', 'threshold', 'minServerTools']) {
    const result = validate({ toolSearch: { [removed]: 1 } })
    assert.ok(result.issues?.length > 0, `${removed} 已删除，写进配置必须报错`)
  }
  // 拼错的外层键同样报错（否则用户以为配上了）。
  assert.ok(validate({ toolsearch: { maxResults: 20 } }).issues?.length > 0)
})

// ── ② 缺省值与派生规则 ────────────────────────────────────────────────

test('生效值：缺省跟随 DEFAULTS，maxDiscovered 的下限抬到 maxResults（同一条规则）', () => {
  assert.deepEqual(effectiveToolSearchSettings({}), {
    maxResults: DEFAULTS.maxResults,
    maxCatalogLines: DEFAULTS.maxCatalogLines,
    maxDiscovered: DEFAULTS.maxDiscovered,
  })
  // 规则不在本模块重抄：maxDiscovered 低于 maxResults 时按 runtime 的同一规则抬上去。
  assert.equal(effectiveToolSearchSettings({ maxResults: 30, maxDiscovered: 5 }).maxDiscovered, 30)
})

test('读侧：从插件 config 取出稀疏值，未知顶层键不进入生效值', () => {
  assert.deepEqual(readToolSearchSettings(undefined), {})
  assert.deepEqual(readToolSearchSettings({}), {})
  assert.deepEqual(readToolSearchSettings({ toolSearch: { maxResults: 20 } }), { maxResults: 20 })
  // 未提供的键不补默认值：稀疏是"用户显式改过什么"，默认由 effective 负责组合。
  assert.deepEqual(readToolSearchSettings({ toolSearch: { maxCatalogLines: 50 } }), { maxCatalogLines: 50 })
})

test('写侧归一：与默认相同的值不落盘（否则将来调整默认值会被老数字钉住）', () => {
  assert.deepEqual(normalizeToolSearchSettings({}), {})
  assert.deepEqual(
    normalizeToolSearchSettings({ maxResults: DEFAULTS.maxResults, maxCatalogLines: 7 }),
    { maxCatalogLines: 7 },
  )
  // maxDiscovered 与默认相同（20）而 maxResults 抬高时不重复写 20；抬到 30 之后写 30——
  // 因为它此刻确实不是默认值，读回来必须还是 30。
  assert.deepEqual(normalizeToolSearchSettings({ maxResults: 30 }), { maxResults: 30, maxDiscovered: 30 })
  // 非法值在这一层就抛（与 resolveRuntimeConfig 的报错同一来源）。
  assert.throws(() => normalizeToolSearchSettings({ maxResults: 0 }), /maxResults/)
})

// ── ③ patch 落盘 ───────────────────────────────────────────────────────

const PATCH = [
  '# profile patch —— 注释必须原样保留',
  '- insert:',
  '  - id: mcp-manager-ui',
  `    name: ${PLUGIN}`,
  '  - id: mcp-filesystem',
  "    name: '@deepseek-ai/dsh-mcp-client'",
  '    config:',
  '      transport: stdio',
  '      serverName: fs',
  '',
].join('\n')

test('写 patch：config.toolSearch 写进我们自己那条条目，其它条目与注释原样', () => {
  const written = setToolSearchSettingsInPatch(PATCH, { maxResults: 20 }, { name: PLUGIN })
  assert.match(written, /# profile patch —— 注释必须原样保留/)
  assert.match(written, /id: mcp-manager-ui/)
  assert.match(written, /serverName: fs/, '别的条目一个字都不该动')
  assert.deepEqual(readToolSearchSettingsFromPatch(written, { name: PLUGIN }), { maxResults: 20 })
  // 往返幂等：同样的值再写一次，内容不变（不重复追加、不重排）。
  assert.equal(setToolSearchSettingsInPatch(written, { maxResults: 20 }, { name: PLUGIN }), written)
})

test('写 patch：值回到默认时把键删掉，config 空了就连 config 一起删（不留空壳）', () => {
  const withValues = setToolSearchSettingsInPatch(PATCH, { maxResults: 20, maxCatalogLines: 50 }, { name: PLUGIN })
  const back = setToolSearchSettingsInPatch(withValues, { maxResults: DEFAULTS.maxResults, maxCatalogLines: DEFAULTS.maxCatalogLines }, { name: PLUGIN })
  assert.deepEqual(readToolSearchSettingsFromPatch(back, { name: PLUGIN }), {})
  assert.doesNotMatch(back, /toolSearch/, '三个都回到默认后不得留下空对象')
  // 我们那条条目原先没有 config 键——删空之后 config 也不该留下。
  assert.doesNotMatch(back, /name: dsh-toolbox-ui\n\s+config:/)
  // 其它条目仍带着自己的 config。
  assert.match(back, /serverName: fs/)
})

test('写 patch：条目里本来就有别的 config 键时只动 toolSearch', () => {
  const withOther = PATCH.replace(`    name: ${PLUGIN}`, `    name: ${PLUGIN}\n    config:\n      someOther: 1`)
  const written = setToolSearchSettingsInPatch(withOther, { maxResults: 20 }, { name: PLUGIN })
  assert.match(written, /someOther: 1/, '同一条目里的其它配置键必须保留')
  assert.deepEqual(readToolSearchSettingsFromPatch(written, { name: PLUGIN }), { maxResults: 20 })
})

test('写 patch：patch 里没有我们这条条目时抛错，不凭空新建', () => {
  // 既没有 insert 条目、又没给出条目 id 时**不能猜**：猜一个 id 就是写一份自己没被挂载的配置，
  // 用户看到的永远是"改了没反应"。
  assert.throws(
    () => setToolSearchSettingsInPatch(PATCH, { maxResults: 20 }, { name: 'not-this-plugin' }),
    /找不到/,
  )
})

// ── 真实安装形态：`dsh plugin add` 把插件装成 bundle ──────────────────────
//
// 这是**主要**安装路径，也是真机验证时才发现的缺陷形态：插件的 patch 行住在
// `<包>/cordis.patch.yml`（bundle 层），用户 profile 的 patch 文件里**根本没有**那条 insert。
// 早期实现要求用户 patch 里存在这条，于是面板保存必然失败（而 `call()` 不抛错，失败被吞成
// 一次"成功"的 toast）。正确落点是宿主的 **id 定向覆盖**：用户 patch 里加一条
// `- id: mcp-manager-ui` + `config:`，宿主的 patch 语义把它合并进 bundle 层那条条目。
const BUNDLE_PATCH = [
  '# 用户自己的 patch：只有别的东西，没有我们的条目',
  '- id: ui-settings-general',
  '  name: "@deepseek-ai/dsh-client-ui-settings-general"',
  '  config:',
  '    welcomeNoticeVersion: 2026-09-28.1',
  '',
].join('\n')
const ENTRY = { name: PLUGIN, id: 'mcp-manager-ui' }

test('写 patch：插件按 bundle 安装时（用户 patch 里没有这条）追加一条 id 定向覆盖', () => {
  const written = setToolSearchSettingsInPatch(BUNDLE_PATCH, { maxResults: 20 }, ENTRY)
  assert.match(written, /# 用户自己的 patch：只有别的东西/, '注释与既有条目原样保留')
  assert.match(written, /- id: mcp-manager-ui/, '必须以 id 定向覆盖的形式落盘（bundle 层那条不在这里）')
  assert.doesNotMatch(written, /name: dsh-toolbox-ui/, '不是 insert 一条新插件——那会挂第二个实例')
  assert.match(written, /toolSearch:\s*\n\s+maxResults: 20/)
  assert.deepEqual(readToolSearchSettingsFromPatch(written, ENTRY), { maxResults: 20 })
  // 幂等：再写一次不变（不重复追加第二条覆盖）。
  assert.equal(setToolSearchSettingsInPatch(written, { maxResults: 20 }, ENTRY), written)
})

test('写 patch：已有 id 定向覆盖时只改 toolSearch，别的键保留；全回默认时整条删掉', () => {
  const withOverride = setToolSearchSettingsInPatch(BUNDLE_PATCH, { maxResults: 20 }, ENTRY)
  // 用户手写/其他版本可能在那条覆盖里放了别的键
  const withOther = withOverride.replace('  config:', '  config:\n    someOther: 1')
  const written = setToolSearchSettingsInPatch(withOther, { maxResults: 30, maxDiscovered: 30 }, ENTRY)
  assert.match(written, /someOther: 1/, '同一条覆盖里的其它键必须保留')
  assert.deepEqual(readToolSearchSettingsFromPatch(written, ENTRY), { maxResults: 30, maxDiscovered: 30 })

  const back = setToolSearchSettingsInPatch(written, {}, ENTRY)
  assert.doesNotMatch(back, /mcp-manager-ui/, '全回默认后这条覆盖没有存在的理由了（不留空壳）')
  assert.match(back, /welcomeNoticeVersion/, '别人的条目不受影响')
  assert.deepEqual(readToolSearchSettingsFromPatch(back, ENTRY), {})
})

test('写 patch：非法值不落盘（先校验再动 YAML）', () => {
  assert.throws(() => setToolSearchSettingsInPatch(PATCH, { maxResults: 0 }, { name: PLUGIN }), /maxResults/)
})

test('配置键名是稳定的：toolSearch（面板与文档都引用它）', () => {
  assert.equal(TOOL_SEARCH_CONFIG_KEY, 'toolSearch')
})
