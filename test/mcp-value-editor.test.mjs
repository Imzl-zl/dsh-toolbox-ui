import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { renderClient } from '../scripts/build-client.mjs'
import { createHookRenderer } from '../test-support/hook-renderer.mjs'
import { admitMcpUpdate } from '../lib/mcp-update-values.js'

const OPTIONS = { timeout: 60000 }
const source = renderClient().replace('exports.inject = inject;', 'exports.inject = inject; exports.editAudit = { AddEditModal, Btn };')
function* nodes(tree) {
  if (Array.isArray(tree)) { for (const child of tree) yield* nodes(child); return }
  if (!tree || typeof tree !== 'object') return
  yield tree
  yield* nodes(tree.children ?? [])
}
const find = (tree, predicate) => { const item = [...nodes(tree)].find(predicate); assert.ok(item); return item }
async function modal(t, initial, hostUpdate = null) {
  const renderer = createHookRenderer()
  let module
  vm.runInNewContext(source, { console, document: { querySelector: () => null }, setTimeout, clearTimeout, localStorage: { getItem: () => null }, window: { __ModuleLoader__: { load(definition) { module = definition.factory(() => renderer) } } } })
  const { AddEditModal, Btn } = module.editAudit
  const submissions = []
  const props = { initial, open: true, busy: false, scope: 'global', onClose() {}, onSubmit: (spec, onError) => { submissions.push(spec); return hostUpdate?.(spec, onError); } }
  renderer.__render(AddEditModal, props)
  await renderer.__settle()
  t.after(() => renderer.__unmount(AddEditModal))
  const tree = () => renderer.__render(AddEditModal, props)
  const save = () => find(tree(), (node) => node.type === Btn && node.props.cls === 'primary')
  return { tree, save, submissions, settle: renderer.__settle }
}
const base = { serverName: 'editable_source', transport: 'stdio', managed: true, enabled: true, command: 'node', args: [], toolCallTimeoutMs: 60000, failOnStartupError: false }
const expressionMeta = { kind: 'expression', preservable: true }

test('unmodified expression field is submitted as a field reference, not display text', OPTIONS, async (t) => {
  const fx = await modal(t, { ...base, command: '!!js process.execPath', configValues: { command: expressionMeta } })
  fx.save().props.onClick()
  assert.equal(fx.submissions.length, 1)
  const [spec] = fx.submissions
  assert.ok(spec.preserveFields?.includes('command'))
  assert.equal(Object.hasOwn(spec, 'command'), false, 'reference and new value cannot be mixed')
  assert.ok(!JSON.stringify(spec).includes('process.execPath'))
})

test('the user explicitly replaces an expression rather than silently editing a kept value', OPTIONS, async (t) => {
  const fx = await modal(t, { ...base, command: '!!js process.execPath', configValues: { command: expressionMeta } })
  const keep = find(fx.tree(), (node) => node.type === 'input' && node.props.name === 'preserve:command')
  const command = find(fx.tree(), (node) => node.type === 'input' && node.props.name === 'command')
  assert.equal(command.props.disabled, true)
  keep.props.onChange({ target: { checked: false } })
  const editable = find(fx.tree(), (node) => node.type === 'input' && node.props.name === 'command')
  assert.equal(editable.props.disabled, false)
  editable.props.onChange({ target: { value: 'node' } })
  fx.save().props.onClick()
  assert.equal(fx.submissions.length, 1)
  assert.equal(fx.submissions[0].command, 'node')
  assert.ok(!fx.submissions[0].preserveFields?.includes('command'))
})

test('non-text expressions preserve source rather than saving invented defaults', OPTIONS, async (t) => {
  const fx = await modal(t, { ...base, toolCallTimeoutMs: undefined, failOnStartupError: undefined, reconnect: undefined,
    configValues: { toolCallTimeoutMs: expressionMeta, failOnStartupError: expressionMeta, reconnect: expressionMeta } })
  fx.save().props.onClick()
  assert.equal(fx.submissions.length, 1)
  const [spec] = fx.submissions
  for (const field of ['toolCallTimeoutMs', 'failOnStartupError', 'reconnect']) {
    assert.ok(spec.preserveFields?.includes(field))
    assert.equal(Object.hasOwn(spec, field), false)
  }
})

for (const field of ['toolCallTimeoutMs', 'failOnStartupError', 'reconnect']) {
  test(`unchecking ${field} without providing a replacement cannot save defaults`, OPTIONS, async (t) => {
    const fx = await modal(t, { ...base, [field]: undefined, configValues: { [field]: expressionMeta } })
    const keep = find(fx.tree(), (node) => node.type === 'input' && node.props.name === `preserve:${field}`)
    keep.props.onChange({ target: { checked: false } })
    fx.save().props.onClick()
    assert.equal(fx.submissions.length, 0)
    assert.ok([...nodes(fx.tree())].some((node) => node.props?.className === 'dsh-mcp-d-err'))
  })
}

test('whole-container expression remains a reference rather than fabricated environment keys', OPTIONS, async (t) => {
  const fx = await modal(t, { ...base, env: {}, configValues: { env: expressionMeta } })
  fx.save().props.onClick()
  assert.equal(fx.submissions.length, 1)
  assert.ok(fx.submissions[0].preserveFields?.includes('env'))
  assert.equal(Object.hasOwn(fx.submissions[0], 'env'), false)
})

test('unchanged literal fields are retained instead of reconstructing them from the view', OPTIONS, async (t) => {
  const fx = await modal(t, { ...base, reconnect: {} })
  fx.save().props.onClick()
  assert.equal(fx.submissions.length, 1)
  for (const field of ['command', 'args', 'toolCallTimeoutMs', 'failOnStartupError', 'reconnect']) {
    assert.ok(fx.submissions[0].preserveFields?.includes(field))
    assert.equal(Object.hasOwn(fx.submissions[0], field), false)
  }
})

test('saving without editing does not materialize absent source fields as default values', OPTIONS, async (t) => {
  const initial = { serverName: 'editable_source', transport: 'stdio', managed: true, enabled: true, command: 'node' }
  const fx = await modal(t, initial)
  fx.save().props.onClick()
  assert.equal(fx.submissions.length, 1)
  for (const field of ['toolCallTimeoutMs', 'failOnStartupError', 'reconnect']) assert.equal(Object.hasOwn(fx.submissions[0], field), false)
})

test('editor and common Host admission accept decimal delays but reject wrong ordering', OPTIONS, async (t) => {
  const current = { name: 'editable_source', transport: 'stdio', command: 'node', args: [], toolCallTimeoutMs: 60000, failOnStartupError: false }
  const accepted = []
  const fx = await modal(t, base, (spec, onError) => { try { accepted.push(admitMcpUpdate(spec, current).spec) } catch (error) { onError(error.message) } })
  const input = (name) => find(fx.tree(), (node) => node.type === 'input' && node.props.name === name)
  input('reconnect.initialDelayMs').props.onChange({ target: { value: '1.5' } })
  input('reconnect.maxDelayMs').props.onChange({ target: { value: '2.5' } })
  fx.save().props.onClick()
  assert.equal(accepted.length, 1)
  assert.equal(accepted[0].reconnect.initialDelayMs, 1.5)
  assert.equal(accepted[0].reconnect.maxDelayMs, 2.5)
  input('reconnect.initialDelayMs').props.onChange({ target: { value: '4.5' } })
  fx.save().props.onClick()
  assert.equal(accepted.length, 1, 'invalid ordering never reaches accepted Host mutation')
  assert.ok([...nodes(fx.tree())].some((node) => node.props?.className === 'dsh-mcp-d-err'))
})

for (const field of ['env', 'headers']) {
  test(`actual editor callback and Host admission keep an own prototype-shaped ${field} key`, OPTIONS, async (t) => {
    const http = field === 'headers'
    const initial = { ...base, transport: http ? 'http' : 'stdio', ...(http ? { url: 'https://example.test/mcp' } : {}), [field]: { A: 'old' } }
    const current = { name: base.serverName, transport: http ? 'streamable-http' : 'stdio', ...(http ? { url: initial.url } : { command: base.command, args: [] }), toolCallTimeoutMs: 60000, failOnStartupError: false, [field]: { A: 'old' } }
    const accepted = []
    const fx = await modal(t, initial, (spec) => accepted.push(admitMcpUpdate(spec, current).spec))
    let row = find(fx.tree(), (node) => node.props?.className === 'dsh-mcp-kv-edit')
    row.children[0].props.onChange({ target: { value: '__proto__' } })
    row = find(fx.tree(), (node) => node.props?.className === 'dsh-mcp-kv-edit')
    row.children[1].props.onChange({ target: { value: 'new-own-value' } })
    fx.save().props.onClick()
    assert.equal(accepted.length, 1)
    assert.equal(Object.hasOwn(fx.submissions[0][field], '__proto__'), true)
    assert.equal(Object.hasOwn(accepted[0][field], '__proto__'), true)
    assert.equal(accepted[0][field].__proto__, 'new-own-value')
    assert.equal(Object.getPrototypeOf(accepted[0][field]), Object.prototype)
  })
}

test('an explicitly unsupported configuration is visible but cannot submit placeholder text', OPTIONS, async (t) => {
  const fx = await modal(t, { ...base, command: 'Unsupported configuration value', configValues: { command: { kind: 'invalid' } } })
  assert.equal(fx.save().props.disabled, true)
  fx.save().props.onClick()
  assert.equal(fx.submissions.length, 0)
  assert.ok([...nodes(fx.tree())].some((node) => node.props?.className === 'dsh-mcp-d-err'))
})

test('an external read-only entry stays read-only even if modal is invoked directly', OPTIONS, async (t) => {
  const fx = await modal(t, { ...base, managed: false })
  assert.equal(fx.save().props.disabled, true)
  fx.save().props.onClick()
  assert.equal(fx.submissions.length, 0)
})

test('editing does not reflect effective disabled state back over the original source', OPTIONS, async (t) => {
  const fx = await modal(t, { ...base, enabled: false, configValues: { disabled: { kind: 'expression', preservable: false } } })
  fx.save().props.onClick()
  assert.equal(fx.submissions.length, 1)
  assert.equal(Object.hasOwn(fx.submissions[0], 'disabled'), false)
  assert.ok(!fx.submissions[0].preserveFields?.includes('disabled'))
})
