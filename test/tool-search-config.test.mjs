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

test('deferServersOf: 只取 defer=true 的服务器', () => {
  const ctx = createCtx([
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
