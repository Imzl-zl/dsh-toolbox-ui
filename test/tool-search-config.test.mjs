import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deferServersOf, serverNamesOf, toolSearchDisabled } from '../lib/tool-search-config.js'

// 夹具：loader.entries() 产出 mcp-client 条目（契约同 mcp-registry.allMcpEntries）。
function createCtx(entries) {
  return { loader: { entries: () => entries } }
}

const entry = (serverName, config) => ({ options: { name: '@deepseek-ai/dsh-mcp-client', config: { serverName, ...config } } })
const otherPlugin = () => ({ options: { name: 'some-other-plugin', config: { serverName: 'nope' } } })

test('serverNamesOf: 全部已知服务器，去重', () => {
  const ctx = createCtx([
    entry('jshook', { defer: true }),
    entry('firecrawl', {}),
    entry('jshook', {}),
    otherPlugin(),
    { options: { name: '@deepseek-ai/dsh-mcp-client', config: {} } }, // 无 serverName
  ])
  assert.deepEqual(serverNamesOf(ctx).sort(), ['firecrawl', 'jshook'])
})

test('serverDeferTable: 同名条目的 defer 是 OR，且与条目顺序无关', () => {
  // DSH 0.1.5 起各注册作用域允许同名（文件头与 serverDeferTable 的注释都按 OR 描述）。
  // 旧实现全局族走 `table.set(name, defer === true)`——后写覆盖，于是同名的两条里
  // 谁生效取决于 ctx.loader.entries() 的顺序：面板上一模一样的配置，顺序一变就翻转。
  // 这条钉住"顺序无关"，也是全局族与项目族用同一条合并规则的证明。
  const on = createCtx([entry('dup', { defer: false }), entry('dup', { defer: true })])
  const reversed = createCtx([entry('dup', { defer: true }), entry('dup', { defer: false })])
  assert.deepEqual(deferServersOf(on), ['dup'], '任一全局条目 defer=true 即该名字 defer')
  assert.deepEqual(deferServersOf(reversed), ['dup'], '反过来排列必须得到同一个结论')
})

test('deferServersOf: 只取 defer=true 的服务器', () => {  const ctx = createCtx([
    entry('jshook', { defer: true }),
    entry('firecrawl', { defer: false }),
    entry('plain', {}),
  ])
  assert.deepEqual(deferServersOf(ctx), ['jshook'])
})

test('deferServersOf: 总开关置 off 时整体短路', () => {
  const previous = process.env.DSH_MCP_TOOL_SEARCH
  try {
    process.env.DSH_MCP_TOOL_SEARCH = 'off'
    assert.equal(toolSearchDisabled(), true)
    const ctx = createCtx([entry('jshook', { defer: true })])
    assert.deepEqual(deferServersOf(ctx), [])
    // 大小写与空白不敏感
    process.env.DSH_MCP_TOOL_SEARCH = ' OFF '
    assert.equal(toolSearchDisabled(), true)
    process.env.DSH_MCP_TOOL_SEARCH = 'on'
    assert.equal(toolSearchDisabled(), false)
  } finally {
    if (previous === undefined) delete process.env.DSH_MCP_TOOL_SEARCH
    else process.env.DSH_MCP_TOOL_SEARCH = previous
  }
})

test('deferServersOf: 未设开关时正常返回', () => {
  const previous = process.env.DSH_MCP_TOOL_SEARCH
  try {
    delete process.env.DSH_MCP_TOOL_SEARCH
    assert.equal(toolSearchDisabled(), false)
    const ctx = createCtx([entry('jshook', { defer: true })])
    assert.deepEqual(deferServersOf(ctx), ['jshook'])
  } finally {
    if (previous !== undefined) process.env.DSH_MCP_TOOL_SEARCH = previous
  }
})
