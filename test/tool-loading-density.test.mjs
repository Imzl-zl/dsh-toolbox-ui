import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

// User feedback: the tool page wastes desktop width, repeats labels per row, and reads as
// one dense block of hairline-separated names. Layout constraints complement real browser
// measurements; they do not replace them.
const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const css = source.match(/const MCP_CSS = `([\s\S]*?)`;/)?.[1]
assert.ok(css, 'The actual client CSS must be available')

test('tool list uses two desktop columns instead of a full-width row per tool', () => {
  const list = css.match(/\.dsh-mcp-tool-list\{([^}]+)\}/)?.[1]
  assert.ok(list, 'The real tool list needs its own layout rule')
  assert.match(list, /display:grid/)
  assert.match(list, /grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/)
})

test('compact tool list returns to one column on narrow screens', () => {
  assert.match(css, /@media \(max-width:760px\)\{[^@]*?\.dsh-mcp-tool-list\{grid-template-columns:minmax\(0,1fr\)\}/)
  // 761–980px 这一档也很窄：两列会把 mcp__<server>__<tool> 压到只剩几个字。
  assert.match(css, /@media \(max-width:980px\)\{[^@]*?\.dsh-mcp-tool-list\{grid-template-columns:minmax\(0,1fr\)\}/)
})

test('tool rows are cards (border + radius + surface), not bare hairline-separated lines', () => {
  // 只看**顶层**规则（行首）：组内的 `.dsh-mcp-tool-group .dsh-mcp-tool-row{...}` 是性能微调，
  // 不是卡片的定义；不锚定行首会先命中那一条，断言就变成在测 content-visibility。
  const row = css.match(/(?:^|\n)\.dsh-mcp-tool-row\{([^}]+)\}/)?.[1]
  assert.ok(row, 'The tool row needs its own card rule')
  assert.match(row, /border:\.5px solid var\(--mcp-line\)/)
  assert.match(row, /border-radius:var\(--mcp-r-md\)/)
  assert.match(row, /background:var\(--mcp-bg-1\)/)
})

test('changed rows keep a visible accent marker so the dirty set is visible before scrolling to the save bar', () => {
  assert.match(css, /\.dsh-mcp-tool-row\.is-changed\{[^}]*border-color:var\(--mcp-accent\)/)
})

test('each tool picks resident/on-demand through an in-row segmented control, not a native dropdown', () => {
  assert.match(css, /\.dsh-mcp-tool-pick\{[^}]*display:inline-flex/)
  assert.match(css, /\.dsh-mcp-tool-pick button\[aria-pressed='true'\]\.is-resident/)
  assert.match(css, /\.dsh-mcp-tool-pick button\[aria-pressed='true'\]\.is-deferred/)
})

test('the save bar is a distinct surface with the change counter next to the actions', () => {
  const bar = css.match(/\.dsh-mcp-tool-save\{([^}]+)\}/)?.[1]
  assert.ok(bar, 'The save bar needs its own rule')
  assert.match(bar, /background:var\(--mcp-bg-2\)/)
  assert.match(css, /\.dsh-mcp-tool-save-dirty\{[^}]*border-radius:999px/)
})

test('tool groups are collapsible sections with sticky headers and an inline group control', () => {
  assert.match(css, /\.dsh-mcp-tool-group-head\{[^}]*position:sticky/, '组头必须常驻在滚动区顶部')
  assert.match(css, /\.dsh-mcp-tool-group-toggle\{[^}]*flex:1/, '组头主体是展开/收起按钮')
  assert.match(css, /\.dsh-mcp-tool-group \.dsh-mcp-tool-row\{[^}]*content-visibility:auto/, '展开 700 行时用 content-visibility 渐进省渲染')
})

test('the overview is a single row of chips, not four cards eating the first screen', () => {
  const overview = css.match(/(?:^|\n)\.dsh-mcp-tool-overview\{([^}]+)\}/)?.[1]
  assert.ok(overview, '概览条需要自己的规则')
  assert.match(overview, /display:flex/)
  assert.doesNotMatch(overview, /grid-template-columns:repeat\(4/)
})
