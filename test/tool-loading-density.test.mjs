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
})

test('tool rows are cards (border + radius + surface), not bare hairline-separated lines', () => {
  const row = css.match(/\.dsh-mcp-tool-row\{([^}]+)\}/)?.[1]
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
