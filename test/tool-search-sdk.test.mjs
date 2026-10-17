import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as dshTools from '@deepseek-ai/dsh-tools'
import { RUN_CODE_TOOL } from '../lib/tool-search-host.js'
import { readSdkSchemas, rendererFor, trimSdkText } from '../lib/tool-search-sdk.js'

// SDK 手册裁剪：**只做决策**，不碰宿主服务（宿主那半在 runtime 的装配路径上）。
//
// 核心不变量（B2/B3）：先用官方导出的渲染器把**全集**重渲染一遍，与宿主段文本逐字节比。
// 相等才说明"我算出的输入 = 宿主渲染用的输入"；不等就用原文——最坏等于今天。
// ⚠️ 这个等式**不是**版本漂移探测器：我们 import 的是同一个包，官方升级时两边一起变。
// 它检测的是"输入或后处理不一致"（别的插件改写了 section、scope 取错、宿主加了后处理）。

const schema = (name, extra = {}) => ({
  name,
  description: `${name} does work`,
  parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
  output: { type: 'object', properties: { ok: { type: 'boolean' } } },
  ...extra,
})

const SCHEMAS = [schema('alpha'), schema('mcp__srv__tool_a'), schema('mcp__srv__tool_b')]
const hostText = (schemas) => dshTools.renderToolsSdk(schemas)

test('trimSdkText: 正常裁剪——删掉的名字不在结果里，保留的还在', () => {
  const full = hostText(SCHEMAS)
  const result = trimSdkText({
    hostText: full,
    schemas: SCHEMAS,
    drop: new Set(['mcp__srv__tool_a']),
    render: dshTools.renderToolsSdk,
  })
  assert.equal(result.ok, true, `裁剪失败：${result.reason}`)
  assert.equal(result.dropped, 1)
  assert.equal(result.text.includes('mcp__srv__tool_a'), false, '被延迟的工具不得出现在手册里')
  assert.ok(result.text.includes('mcp__srv__tool_b'), '未延迟的工具必须留在手册里')
  assert.ok(result.text.includes('alpha'))
  // 只可能变短：裁剪后体积必须真的更小（否则这个功能没有意义）。
  assert.ok(result.text.length < full.length)
})

test('trimSdkText: 前提自检失败就退回原文（不猜、不发坏文本）', () => {
  // 宿主段文本被别处改写一个字符：这说明"我算出的输入"和"宿主渲染用的输入"不一致，
  // 此时裁剪的落点不可信——必须原样放行。
  const tampered = hostText(SCHEMAS).replace('alpha', 'alphx')
  const result = trimSdkText({
    hostText: tampered,
    schemas: SCHEMAS,
    drop: new Set(['mcp__srv__tool_a']),
    render: dshTools.renderToolsSdk,
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'premise-mismatch')
  assert.equal(result.text, undefined, '失败时不得给出文本——调用方用自己的原文')
})

test('trimSdkText: 没有可删的就报 no-drop（不做无谓的替换）', () => {
  const result = trimSdkText({
    hostText: hostText(SCHEMAS),
    schemas: SCHEMAS,
    drop: new Set(['not-visible-here']),
    render: dshTools.renderToolsSdk,
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'no-drop')
})

test('trimSdkText: 拿不到 schema 或渲染器抛错都只报错不抛', () => {
  assert.equal(trimSdkText({ hostText: 'x', schemas: [], drop: new Set(), render: dshTools.renderToolsSdk }).reason, 'no-schemas')
  assert.equal(trimSdkText({ hostText: 'x', schemas: undefined, drop: new Set(), render: dshTools.renderToolsSdk }).reason, 'no-schemas')
  assert.equal(trimSdkText({ hostText: 'x', schemas: SCHEMAS, drop: new Set(), render: () => { throw new Error('boom') } }).reason, 'render-threw')
  assert.equal(trimSdkText({ hostText: 'x', schemas: SCHEMAS, drop: new Set(), render: undefined }).reason, 'render-threw')
})

test('trimSdkText: programFormat 必须真被转发（否则 0.2.1 上自检必失败）', () => {
  // 0.2.1 起 `renderToolsSdk(schemas, programFormat)`：宿主 sdkSection 传的是
  // `runtime.programFormat`。我们这边不转发，重渲染出来的就是另一种文本 → 自检失败 →
  // **静默退化成不裁**。这条用例用一个"把格式写进文本"的渲染器把这个差别放大：
  // 转发 → 自检通过；不转发 → premise-mismatch。
  const render = (schemas, programFormat) => `${programFormat}|${schemas.map((s) => s.name).join(',')}`
  const replHostText = render(SCHEMAS, 'repl')

  const forwarded = trimSdkText({
    hostText: replHostText,
    schemas: SCHEMAS,
    drop: new Set(['alpha']),
    render,
    programFormat: 'repl',
  })
  assert.equal(forwarded.ok, true, `转发 programFormat 后必须通过自检：${forwarded.reason}`)
  assert.equal(forwarded.text, 'repl|mcp__srv__tool_a,mcp__srv__tool_b')

  const notForwarded = trimSdkText({
    hostText: replHostText,
    schemas: SCHEMAS,
    drop: new Set(['alpha']),
    render,
  })
  assert.equal(notForwarded.ok, false)
  assert.equal(notForwarded.reason, 'premise-mismatch', '不转发就必须在自检这一步红，而不是悄悄发一份别的文本')
})

test('trimSdkText: Python 渲染器同样适用（语言无关）', () => {
  const py = dshTools.renderToolsSdkPy
  const full = py(SCHEMAS)
  const result = trimSdkText({ hostText: full, schemas: SCHEMAS, drop: new Set(['mcp__srv__tool_b']), render: py })
  assert.equal(result.ok, true, `Python 路径裁剪失败：${result.reason}`)
  assert.equal(result.text.includes('mcp__srv__tool_b'), false)
  assert.ok(result.text.includes('mcp__srv__tool_a'))
  assert.ok(result.text.length < full.length)
})

test('rendererFor: 按运行时语言选渲染器，未知语言走 TS（宿主也只认两种）', () => {
  assert.equal(rendererFor('typescript'), dshTools.renderToolsSdk)
  assert.equal(rendererFor('python'), dshTools.renderToolsSdkPy)
})

// ── 取数：公开 API 优先，sdkSchemas 只作快路径（F22）──

/** 宿主 tools 替身：只实现取数那四个公开/半公开方法。 */
function fakeTools({ schemas = SCHEMAS, sdkSchemas, outputs = {} } = {}) {
  const tools = {
    schemas: () => schemas.map(({ output, ...rest }) => rest),
    get: (name) => {
      const found = schemas.find((entry) => entry.name === name)
      if (found === undefined) return undefined
      return { name, output: { schema: outputs[name] ?? found.output } }
    },
  }
  if (sdkSchemas !== undefined) tools.sdkSchemas = () => sdkSchemas
  return tools
}

test('readSdkSchemas: sdkSchemas 可用时走快路径', () => {
  const tools = fakeTools({ sdkSchemas: SCHEMAS })
  const read = readSdkSchemas(tools, undefined, { sdkSchemas: true })
  assert.equal(read.via, 'sdkSchemas')
  assert.deepEqual(read.schemas, SCHEMAS, '快路径的产物就是宿主给的那批（不重排、不改写）')
})

test('readSdkSchemas: 没有 sdkSchemas 时用公开 API 重建，且与快路径逐字节等价', () => {
  // 这是本轮最重要的降级：private `sdkSchemas` 从"必需"降成"快路径"（F22 实测逐字节相等）。
  const fast = readSdkSchemas(fakeTools({ sdkSchemas: SCHEMAS }), undefined, { sdkSchemas: true })
  const slow = readSdkSchemas(fakeTools(), undefined, { sdkSchemas: false })
  assert.equal(slow.via, 'public')
  assert.equal(dshTools.renderToolsSdk(slow.schemas), dshTools.renderToolsSdk(fast.schemas),
    '公开路径重建的输入必须渲染出与快路径逐字节相同的文本')
})

test('readSdkSchemas: run_code 不在手册里（宿主的 sdkSchemas 同样排除它）', () => {
  // 两条路径都必须排除：`run_code` 是 PTC 的载体工具，手册里多一条它就是多一份不属于
  // 模型的签名，而且会让前提自检失败。
  const withRunCode = [...SCHEMAS, schema(RUN_CODE_TOOL, { description: 'run a program' })]
  const slow = readSdkSchemas(fakeTools({ schemas: withRunCode }), undefined, { sdkSchemas: false })
  assert.equal(slow.schemas.some((entry) => entry.name === RUN_CODE_TOOL), false)
  assert.equal(readSdkSchemas(fakeTools({ sdkSchemas: [SCHEMAS[0]] }), undefined, { sdkSchemas: true }).schemas
    .some((entry) => entry.name === RUN_CODE_TOOL), false)
  // 常量取自宿主导出（S1 里只为一个字符串没有 import dsh-tools，这里钉住它没写错）。
  assert.equal(RUN_CODE_TOOL, dshTools.RUN_CODE_NAME)
})

test('readSdkSchemas: 工具缺 output.schema 时放弃重建（不静默少一条签名）', () => {
  // 少一条签名的手册 = 模型看不见那个工具的返回类型。宁可整段不裁（最坏 = 今天），
  // 也不能发一份"看起来裁好了、其实少了一条"的手册。
  const tools = fakeTools()
  tools.schemas = () => [{ name: 'alpha', description: 'd', parameters: { type: 'object' } }]
  tools.get = () => ({ name: 'alpha', output: undefined })
  const read = readSdkSchemas(tools, undefined, { sdkSchemas: false })
  assert.equal(read.schemas, undefined)
  assert.equal(read.via, 'incomplete')
})

test('readSdkSchemas: 宿主连 schemas/get 都没有时不崩，报 none', () => {
  assert.equal(readSdkSchemas({}, undefined, { sdkSchemas: false }).via, 'none')
  assert.equal(readSdkSchemas(undefined, undefined, { sdkSchemas: true }).via, 'none')
})
