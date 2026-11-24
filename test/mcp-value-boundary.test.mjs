// Stakeholder regression #15: actual Host projection + actual generated client callbacks.
// React hooks/transport are fixtures here; real React/browser verification is separate.
import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { summarize, touchesConnection } from '../lib/mcp-rows.js'
import { REDACTED_VALUE } from '../lib/mcp-projection.js'
import { renderClient } from '../scripts/build-client.mjs'
import { createHookRenderer } from '../test-support/hook-renderer.mjs'

const OPTIONS = { timeout: 60000 }
const expr = (source) => ({ __jsExpr: source })
const inventory = { ambiguous: new Set(), counts: { expression_fixture: 1 }, revisions: {} }
function project(config, managed = null) {
  const entry = { options: { id: 'expression-fixture', config: { serverName: 'expression_fixture', transport: 'stdio', ...config } }, fiber: { state: 2 }, disabled: false }
  return summarize(entry, inventory, managed)
}
const marker = 'exports.inject = inject;'
const source = renderClient().replace(marker, `${marker}\nexports.valueAudit = { displayValue, toFormValue, ServerDetail, McpTab, ServerList, AddEditModal, Btn };`)
function client(t) {
  const renderer = createHookRenderer()
  let module
  vm.runInNewContext(source, {
    console, document: { visibilityState: 'visible', querySelector: () => null, addEventListener() {}, removeEventListener() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    localStorage: { getItem: () => null },
    window: { __ModuleLoader__: { load(definition) { module = definition.factory(() => renderer) } } },
  })
  const mounted = new Set()
  const render = (component, props) => { mounted.add(component); return renderer.__render(component, props) }
  const fx = { ...module.valueAudit, render, async settle(component, props) { await renderer.__settle(); return render(component, props) } }
  t.after(() => { for (const component of mounted) renderer.__unmount(component) })
  return fx
}
function* nodes(tree) {
  if (Array.isArray(tree)) { for (const child of tree) yield* nodes(child); return }
  if (!tree || typeof tree !== 'object') return
  yield tree
  yield* nodes(tree.children ?? [])
}
function find(tree, predicate) { const result = [...nodes(tree)].find(predicate); assert.ok(result); return result }

test('a lifecycle expression changed to a literal false still triggers reconciliation', OPTIONS, () => {
  const current = { disabled: '!!js ctx.fixture.disabled', command: 'node' }
  assert.equal(touchesConnection({ disabled: false, command: 'node' }, current), true)
  assert.equal(touchesConnection({ ...current, defer: true }, current), false)
  assert.equal(touchesConnection({ disabled: false, command: 'node', defer: true }, { command: 'node' }), false)
})

for (const field of ['command', 'cwd']) {
  test(`source expression ${field}: Host gives text instead of a React object`, OPTIONS, () => {
    const value = expr(field === 'command' ? 'process.execPath' : 'process.cwd()')
    const row = project({ command: 'node', [field]: value, args: [] })
    assert.equal(typeof row[field], 'string')
    assert.equal(row[field], `!!js ${value.__jsExpr}`)
    assert.equal(row.configValues?.[field]?.kind, 'expression')
    assert.equal(JSON.stringify(value), JSON.stringify({ __jsExpr: value.__jsExpr }), 'projection does not change source')
  })
}

test('literal number and boolean keep their original types including zero and false', OPTIONS, () => {
  const row = project({ command: 'node', args: [], toolCallTimeoutMs: 1000, failOnStartupError: false, defer: false })
  assert.equal(row.toolCallTimeoutMs, 1000)
  assert.equal(row.failOnStartupError, false)
  assert.equal(row.defer, false)
  assert.equal(typeof row.toolCallTimeoutMs, 'number')
  assert.equal(typeof row.failOnStartupError, 'boolean')
})

for (const field of ['toolCallTimeoutMs', 'failOnStartupError', 'defer']) {
  test(`non-text ${field}: an expression is explicit metadata, not a primitive or object truth value`, OPTIONS, () => {
    const row = project({ command: 'node', args: [], [field]: expr('ctx.fixture.value') })
    assert.equal(row.configValues?.[field]?.kind, 'expression')
    assert.ok(row[field] === undefined || row[field] === null, 'the expression has not been evaluated and has no literal value')
  })
}

test('unknown object gets an explicit diagnostic without dumping embedded values', OPTIONS, () => {
  const row = project({ command: { unsupported: 'DO_NOT_LEAK_UNKNOWN_VALUE' }, args: [] })
  assert.equal(row.configValues?.command?.kind, 'invalid')
  assert.equal(typeof row.command, 'string')
  assert.ok(!JSON.stringify(row).includes('DO_NOT_LEAK_UNKNOWN_VALUE'))
  assert.ok(!row.command.includes('[object Object]'))
})

test('whole-container expressions do not masquerade as map keys or empty argument arrays', OPTIONS, () => {
  const row = project({ command: 'node', args: expr('ctx.secretArguments'), env: expr('ctx.secretEnvironment'), headers: expr('ctx.secretHeaders') })
  for (const field of ['args', 'env', 'headers']) {
    assert.equal(row.configValues?.[field]?.kind, 'expression')
    assert.ok(!JSON.stringify(row).includes(`ctx.secret${field === 'args' ? 'Arguments' : field === 'env' ? 'Environment' : 'Headers'}`))
  }
  assert.ok(!Object.hasOwn(row.env ?? {}, '__jsExpr'))
  assert.ok(!Object.hasOwn(row.headers ?? {}, '__jsExpr'))
})

test('sensitive leaf values stay masked and URL expressions remain masked', OPTIONS, () => {
  const row = project({ command: 'node', args: ['SECRET_ARGUMENT'], env: { TOKEN: expr('ctx.secret') }, headers: { Authorization: 'SECRET_HEADER' }, url: expr('ctx.privateUrl') })
  assert.equal(row.env.TOKEN, REDACTED_VALUE)
  assert.equal(row.headers.Authorization, REDACTED_VALUE)
  assert.deepEqual(row.args, [REDACTED_VALUE])
  assert.equal(row.url, REDACTED_VALUE)
  assert.ok(!JSON.stringify(row).includes('SECRET_ARGUMENT'))
  assert.ok(!JSON.stringify(row).includes('SECRET_HEADER'))
})

test('text helpers preserve zero/false and do not pass raw objects into React', OPTIONS, (t) => {
  const fx = client(t)
  assert.equal(fx.toFormValue(0), '0')
  assert.equal(fx.toFormValue(false), 'false')
  assert.equal(fx.displayValue(0), '0')
  assert.equal(fx.displayValue(false), 'false')
  assert.equal(typeof fx.displayValue({ unknown: 'DO_NOT_LEAK_UNKNOWN_VALUE' }), 'string')
  assert.ok(!fx.displayValue({ unknown: 'DO_NOT_LEAK_UNKNOWN_VALUE' }).includes('DO_NOT_LEAK_UNKNOWN_VALUE'))
})

test('detail text stays renderable for an external expression row', OPTIONS, (t) => {
  const fx = client(t)
  const row = project({ command: expr('process.execPath'), args: [] })
  const tree = fx.ServerDetail({ server: row, tools: [], busy: false, onToggle() {}, onReconnect() {}, onEdit() {}, onRemove() {} })
  const bad = [...nodes(tree)].filter((node) => node.type === 'span' && node.children?.some((child) => child && typeof child === 'object' && Object.hasOwn(child, '__jsExpr')))
  assert.equal(bad.length, 0)
})

test('whole secret container expressions remain visible as hidden expressions in the overview', OPTIONS, (t) => {
  const fx = client(t)
  const row = project({ command: 'node', args: [], env: expr('ctx.secretEnvironment'), headers: expr('ctx.secretHeaders') })
  const tree = fx.ServerDetail({ server: row, tools: [], tab: 'overview', busy: false, onToggle() {}, onReconnect() {}, onEdit() {}, onRemove() {} })
  const overview = find(tree, (node) => node.props?.className === 'dsh-mcp-card')
  const text = (node) => typeof node === 'string' ? node : Array.isArray(node) ? node.map(text).join(' ') : node && typeof node === 'object' ? text(node.children ?? []) : ''
  const shown = text(overview)
  assert.match(shown, /环境变量/)
  assert.match(shown, /Headers/)
  assert.match(shown, /表达式.*隐藏/)
  assert.doesNotMatch(shown, /secretEnvironment|secretHeaders|__jsExpr/)
})

test('an unsupported owned configuration has a visible edit limitation in the overview', OPTIONS, (t) => {
  const fx = client(t)
  const row = project({ command: 'node', args: [] }, { name: 'expression_fixture', transport: 'stdio', command: { unsupported: true }, args: [] })
  const tree = fx.ServerDetail({ server: row, tools: [], tab: 'overview', busy: false, onToggle() {}, onReconnect() {}, onEdit() {}, onRemove() {} })
  const overview = find(tree, (node) => node.props?.className === 'dsh-mcp-card')
  const text = (node) => typeof node === 'string' ? node : Array.isArray(node) ? node.map(text).join(' ') : node && typeof node === 'object' ? text(node.children ?? []) : ''
  const shown = text(overview)
  assert.match(shown, /不支持|不受当前面板支持/)
  assert.doesNotMatch(shown, /当前 Web profile（可编辑）/)
})

test('MCP search uses projected text and can search a source expression without a TypeError', OPTIONS, async (t) => {
  const fx = client(t)
  const row = project({ command: expr('process.execPath'), args: [] })
  const props = { floating: true, onClose() {}, timer: { interval: () => () => {}, timeout: () => () => {} }, callSkills: async () => ({ ok: true, skills: [] }),
    call: async (method) => method === 'list' ? { ok: true, servers: [row], revision: 'expression-row-1' } : method === 'listWorkspaces' ? { ok: true, workspaces: [], revision: 'workspaces-1' } : { ok: true, tools: [] } }
  fx.render(fx.McpTab, props)
  let tree = await fx.settle(fx.McpTab, props)
  const list = find(tree, (node) => node.type === fx.ServerList)
  list.props.onQuery('process')
  assert.doesNotThrow(() => { tree = fx.render(fx.McpTab, props) })
  const filtered = find(tree, (node) => node.type === fx.ServerList)
  assert.equal(filtered.props.servers.length, 1)
})
