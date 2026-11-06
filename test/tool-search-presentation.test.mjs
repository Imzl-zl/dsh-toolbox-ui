import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deferredOf, maskSection, presentAssembly, visibleTools } from '../lib/tool-search-presentation.js'

const OPTIONS = { guidanceSection: 'tool-search:guidance', catalogSection: 'tool-search:catalog' }

function snapshot({ mode = 'native', managed = ['mcp__srv__a', 'mcp__srv__b'], discovered = [], requireDiscovery = true } = {}) {
  return {
    mode,
    config: { toolName: 'tool_search', requireDiscovery },
    view: { managed: new Map(managed.map((name) => [name, { name }],)), catalog: new Map() },
    state: { discovered: new Map(discovered.map((name, index) => [name, index])) },
  }
}

const handlers = (overrides = {}) => ({
  catalogText: (_snapshot, deferred) => `catalog:${[...deferred].join(',')}`,
  ...overrides,
})

const assembly = () => ({
  tools: [{ name: 'Read' }, { name: 'mcp__srv__a' }, { name: 'mcp__srv__b' }, { name: 'tool_search' }],
  sections: [{ name: 'persona', text: 'x' }, { name: 'tool-search:guidance', text: 'deferred tools exist' }],
  contexts: [],
})

test('deferredOf / visibleTools / maskSection：三处共用同一条集合语义', () => {
  const managed = new Map([['a', {}], ['b', {}]])
  const discovered = new Map([['a', 1]])
  assert.deepEqual([...deferredOf(managed, discovered)], ['b'])
  assert.deepEqual(visibleTools([{ name: 'a' }, { name: 'b' }, { name: 'c' }], managed, discovered).map((tool) => tool.name), ['a', 'c'])
  // 没有该段时原样返回（零干预必须可观察）
  const sections = [{ name: 'persona', text: 'x' }]
  assert.equal(maskSection(sections, 'tool-search:guidance'), sections)
  const masked = maskSection([...sections, { name: 'tool-search:guidance', text: 'y' }], 'tool-search:guidance')
  assert.equal(masked[1].text, '')
  assert.equal(masked[0], sections[0], '其余段对象保持原引用')
})

test('presentAssembly: mode=both 原样放行（两条投影都有效时不碰任何一处）', async () => {
  const input = assembly()
  const output = await presentAssembly(input, snapshot({ mode: 'both' }), handlers(), OPTIONS)
  assert.equal(output, input)
})

test('presentAssembly: managed=∅ 只摘引导段，不追加目录', async () => {
  const input = assembly()
  const output = await presentAssembly(input, snapshot({ managed: [] }), handlers(), OPTIONS)
  assert.notEqual(output, input)
  assert.deepEqual(output.tools, input.tools, '工具一个都不许动')
  assert.equal(output.sections.length, 2)
  assert.equal(output.sections.find((section) => section.name === 'tool-search:guidance').text, '')
  assert.equal(output.sections.some((section) => section.name === 'tool-search:catalog'), false)
})

test('presentAssembly: D=∅（全部已发现）时目录与引导段一起消失', async () => {
  const input = assembly()
  const output = await presentAssembly(input, snapshot({ discovered: ['mcp__srv__a', 'mcp__srv__b'] }), handlers(), OPTIONS)
  assert.deepEqual(output.tools, input.tools)
  assert.equal(output.sections.some((section) => section.name === 'tool-search:catalog'), false)
  assert.equal(output.sections.find((section) => section.name === 'tool-search:guidance').text, '')
})

test('presentAssembly: 只摘未发现的受管工具，目录段按剩余延迟集生成且不插值', async () => {
  const input = assembly()
  const output = await presentAssembly(input, snapshot({ discovered: ['mcp__srv__a'] }), handlers(), OPTIONS)
  assert.deepEqual(output.tools.map((tool) => tool.name), ['Read', 'mcp__srv__a', 'tool_search'])
  const catalog = output.sections.find((section) => section.name === 'tool-search:catalog')
  assert.equal(catalog.text, 'catalog:mcp__srv__b')
  assert.equal(catalog.interpolate, false, '目录正文嵌第三方描述：不许插值')
  // 输入不被就地修改
  assert.equal(input.tools.length, 4)
  assert.equal(input.sections.length, 2)
})

test('presentAssembly: PTC 才裁 SDK；裁剪失败必须沿用原文', async () => {
  const input = { ...assembly(), sections: [...assembly().sections, { name: 'tools:sdk', text: 'sdk-full' }] }
  const calls = []
  const trim = async (_snapshot, deferred, sections) => {
    calls.push([...deferred])
    return sections.map((section) => (section.name === 'tools:sdk' ? { ...section, text: 'sdk-trimmed' } : section))
  }
  const native = await presentAssembly(input, snapshot({ mode: 'native' }), handlers({ trimSdk: trim }), OPTIONS)
  assert.equal(calls.length, 0, 'native 没有可裁的手册段，不许调裁剪')
  assert.equal(native.sections.find((section) => section.name === 'tools:sdk').text, 'sdk-full')

  const ptc = await presentAssembly(input, snapshot({ mode: 'ptc' }), handlers({ trimSdk: trim }), OPTIONS)
  assert.deepEqual(calls, [['mcp__srv__a', 'mcp__srv__b']])
  assert.equal(ptc.sections.find((section) => section.name === 'tools:sdk').text, 'sdk-trimmed')

  const failing = await presentAssembly(input, snapshot({ mode: 'ptc' }), handlers({
    trimSdk: () => { throw new Error('renderer exploded') },
  }), OPTIONS)
  assert.equal(failing.sections.find((section) => section.name === 'tools:sdk').text, 'sdk-full')
})

test('presentAssembly: assembly 没有 tools 时原样放行并报诊断（不许把它当成空集覆盖）', async () => {
  const input = { sections: [{ name: 'persona', text: 'x' }] }
  const diagnostics = []
  const output = await presentAssembly(input, snapshot(), handlers(), { ...OPTIONS, onDiagnostic: (event) => diagnostics.push(event) })
  assert.equal(output, input)
  assert.deepEqual(diagnostics.map((event) => event.code), ['ASSEMBLY_WITHOUT_TOOLS'])
})
