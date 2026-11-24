import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { renderClient } from '../scripts/build-client.mjs'
import { createHookRenderer } from '../test-support/hook-renderer.mjs'

// Drive the real client source and callbacks. Only React, time and the Host connection are fixtures.
const source = renderClient()
const marker = 'exports.inject = inject;'
assert.equal(source.split(marker).length, 2)
const instrumented = source.replace(marker, `${marker}
exports.audit = { McpTab, ScopeTabs, ServerList, GlobalServerList, Toggle, EyeToggle, Notice, SkillsPanel, SkillRow, SkillDetailPane };`)

function* nodes(tree) {
  if (Array.isArray(tree)) { for (const child of tree) yield* nodes(child); return }
  if (!tree || typeof tree !== 'object') return
  yield tree
  yield* nodes(tree.children ?? [])
}
function find(tree, predicate, message = 'expected element is present') {
  const result = [...nodes(tree)].find(predicate)
  assert.ok(result, message)
  return result
}
const hasClass = (node, cls) => node.props?.className?.split(' ').includes(cls)
const ofType = (tree, type) => find(tree, (node) => node.type === type)
const waitFor = () => new Promise((resolve) => setImmediate(resolve))

function fixture() {
  const renderer = createHookRenderer()
  const timeouts = []
  const polls = new Set()
  const document = {
    visibilityState: 'visible', querySelector: () => null,
    addEventListener() {}, removeEventListener() {},
  }
  const timer = {
    timeout(fn, ms) {
      const task = { fn, ms, cancelled: false }
      timeouts.push(task)
      return () => { task.cancelled = true }
    },
    interval(fn) {
      const poll = { fn }
      polls.add(poll)
      return () => polls.delete(poll)
    },
  }
  let client
  vm.runInNewContext(instrumented, {
    document, setTimeout, clearTimeout, localStorage: { getItem: () => null },
    window: { __ModuleLoader__: { load(definition) { client = definition.factory(() => renderer) } } },
  })
  const render = (component, props) => renderer.__render(component, props)
  const settle = async (component, props) => {
    await renderer.__settle()
    return render(component, props)
  }
  const mount = (component, props) => { render(component, props); return settle(component, props) }
  return { ...client.audit, render, settle, mount, timer, timeouts, polls, unmount: renderer.__unmount }
}

const wsPath = '/audit/project'
const server = (serverName, scope) => ({ serverName, scope, transport: 'stdio', enabled: true, status: 'connected', phase: 'connected', managed: true, toolCount: 1 })
const globalRow = server('global-only', 'global')
const projectRow = server('project-only', 'workspace')
const skill = (name) => ({ name, source: 'user-dsh', root: '/audit/skills', entry: name, kind: 'bundle', enabled: true })
function mcpPanel(fx) {
  const calls = []
  return {
    calls,
    props: {
      timer: fx.timer, floating: true, onClose() {},
      callSkills: async () => ({ ok: true, skills: [] }),
      async call(method, args) {
        calls.push({ method, args })
        if (method === 'listWorkspaces') return { ok: true, workspaces: [{ path: wsPath, name: 'Project', serverCount: 1 }], revision: 'workspaces-1' }
        if (method === 'list') return { ok: true, servers: [globalRow], revision: 'global-1' }
        if (method === 'getWorkspaceView') return { ok: true, servers: [projectRow], global: [], revision: 'project-1' }
        if (method === 'tools') return { ok: true, tools: [] }
        if (method === 'disable' || method === 'updateHint') return { ok: true }
        assert.fail(`unexpected RPC ${method}`)
      },
    },
  }
}

test('a dirty global write cannot refresh a project using the previous scope callback', async (t) => {
  const fx = fixture()
  const { props, calls } = mcpPanel(fx)
  const global = await fx.mount(fx.McpTab, props)
  t.after(() => fx.unmount(fx.McpTab))
  const list = ofType(global, fx.ServerList)
  await list.props.onToggle(list.props.servers[0])
  const refresh = fx.timeouts.find((task) => task.ms === 250)
  assert.ok(refresh, 'a completed write schedules a list read')
  ofType(global, fx.ScopeTabs).props.onSelect(wsPath)
  let project = await fx.settle(fx.McpTab, props)
  assert.equal(ofType(project, fx.ScopeTabs).props.active, wsPath)
  assert.equal(ofType(project, fx.ServerList).props.servers[0]?.serverName, projectRow.serverName)
  const start = calls.length
  if (!refresh.cancelled) await refresh.fn()
  project = await fx.settle(fx.McpTab, props)
  assert.equal(ofType(project, fx.ServerList).props.servers[0]?.serverName, projectRow.serverName)
  assert.ok(calls.slice(start).every(({ method }) => method !== 'list'), 'old refresh cannot issue a global read')
})

test('file selection sends the actual document to the current skill target', async (t) => {
  const fx = fixture()
  const target = { source: 'user-dsh', root: '/audit/skills', scope: 'user', writable: true }
  const requests = []
  const props = { workspaces: [], async call(method, args) {
    if (method === 'skillTargets') return { ok: true, targets: [target] }
    if (method === 'list') return { ok: true, skills: [] }
    if (method === 'importSkill') { requests.push(args); return { ok: true } }
    return { ok: true, categories: [] }
  } }
  const tree = await fx.mount(fx.SkillsPanel, props)
  t.after(() => fx.unmount(fx.SkillsPanel))
  const chooser = find(tree, (node) => node.type === 'input' && node.props.type === 'file')
  const content = '---\nname: local-audit\ndescription: Local file fixture\n---\n'
  const file = new File([content], 'local-audit.md', { type: 'text/markdown' })
  const input = { value: file.name, files: [file] }
  assert.doesNotThrow(() => chooser.props.onChange({ target: input }))
  await fx.settle(fx.SkillsPanel, props)
  assert.equal(input.value, '', 'choosing the same file again must work')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].content, await file.text())
  assert.equal(requests[0].source, target.source)
  assert.equal(requests[0].root, target.root)
})

test('a late skill detail response cannot replace the new selection body', async (t) => {
  const fx = fixture()
  const skills = [skill('alpha'), skill('beta')]
  const pending = new Map()
  const props = { workspaces: [], async call(method, args) {
    if (method === 'list') return { ok: true, skills }
    if (method === 'detail') return new Promise((resolve) => pending.set(args.name, resolve))
    return { ok: true, targets: [] }
  } }
  const tree = await fx.mount(fx.SkillsPanel, props)
  t.after(() => fx.unmount(fx.SkillsPanel))
  const second = find(tree, (node) => node.type === fx.SkillRow && node.props.row.name === skills[1].name)
  second.props.onSelect(second.props.row)
  const firstBody = { content: 'alpha document' }
  const secondBody = { content: 'beta document' }
  assert.ok(pending.has(skills[0].name) && pending.has(skills[1].name))
  pending.get(skills[1].name)({ ok: true, skill: secondBody })
  let detail = ofType(await fx.settle(fx.SkillsPanel, props), fx.SkillDetailPane)
  assert.equal(detail.props.body.text, secondBody.content)
  pending.get(skills[0].name)({ ok: true, skill: firstBody })
  detail = ofType(await fx.settle(fx.SkillsPanel, props), fx.SkillDetailPane)
  assert.equal(detail.props.row.name, skills[1].name)
  assert.equal(detail.props.body.text, secondBody.content)
})

test('an existing skill selection reloads its pending detail when the RPC source changes', async (t) => {
  const fx = fixture()
  const selected = skill('alpha')
  const initial = Promise.withResolvers()
  const fresh = Promise.withResolvers()
  const requests = []
  const call = (body) => async (method, args) => {
    if (method === 'list') return { ok: true, skills: [selected] }
    if (method === 'detail') { requests.push(args); return body.promise }
    return { ok: true, targets: [] }
  }
  const props = { workspaces: [], call: call(initial) }
  await fx.mount(fx.SkillsPanel, props)
  t.after(() => fx.unmount(fx.SkillsPanel))
  assert.equal(requests.length, 1)
  const reconnected = { ...props, call: call(fresh) }
  await fx.mount(fx.SkillsPanel, reconnected)
  assert.equal(requests.length, 2, 'the existing selection should load from the new source')
  const content = 'new source document'
  fresh.resolve({ ok: true, skill: { content } })
  await fx.settle(fx.SkillsPanel, reconnected)
  initial.resolve({ ok: true, skill: { content: 'old source document' } })
  const detail = ofType(await fx.settle(fx.SkillsPanel, reconnected), fx.SkillDetailPane)
  assert.equal(detail.props.row.name, selected.name)
  assert.equal(detail.props.body.text, content)
})

test('skills do not re-fetch because an unchanged workspace list was polled', async (t) => {
  const fx = fixture()
  const { props } = mcpPanel(fx)
  const opened = await fx.mount(fx.McpTab, props)
  t.after(() => fx.unmount(fx.McpTab))
  const tick = [...fx.polls][0]
  assert.ok(tick, 'the active MCP face has a polling timer')
  find(opened, (node) => node.type === 'button' && node.props?.key === 'skills').props.onClick()
  const skillsProps = ofType(await fx.settle(fx.McpTab, props), fx.SkillsPanel).props
  tick.fn()
  const nextProps = ofType(await fx.settle(fx.McpTab, props), fx.SkillsPanel).props
  assert.strictEqual(nextProps.workspaces, skillsProps.workspaces, 'identical workspace paths must not trigger dependent reads')
})

test('the background MCP face does not poll its view while skills are open', async (t) => {
  const fx = fixture()
  const { props, calls } = mcpPanel(fx)
  const opened = await fx.mount(fx.McpTab, props)
  t.after(() => fx.unmount(fx.McpTab))
  find(opened, (node) => node.type === 'button' && node.props?.key === 'skills').props.onClick()
  await fx.settle(fx.McpTab, props)
  const start = calls.length
  for (const poll of fx.polls) poll.fn()
  await waitFor()
  assert.ok(calls.slice(start).every(({ method }) => method !== 'list' && method !== 'getWorkspaceView'))
})

test('an explicit MCP retry still works from another face with polling paused', async (t) => {
  const fx = fixture()
  const { props } = mcpPanel(fx)
  const fallback = props.call
  let reads = 0
  props.call = async (method, args) => {
    if (method === 'list' && ++reads === 1) return { ok: false, error: 'fixture offline' }
    return fallback(method, args)
  }
  const opened = await fx.mount(fx.McpTab, props)
  t.after(() => fx.unmount(fx.McpTab))
  find(opened, (node) => node.type === 'button' && node.props?.key === 'skills').props.onClick()
  const skills = await fx.settle(fx.McpTab, props)
  const error = find(skills, (node) => node.type === fx.Notice && node.props.key === 'load-failed')
  const retry = error.props.actions.find((action) => action.props.key === 'retry')
  await retry.props.onClick()
  const recovered = await fx.settle(fx.McpTab, props)
  assert.equal(reads, 2, 'explicit retry reads MCP even when background polling is paused')
  assert.ok(![...nodes(recovered)].some((node) => node.type === fx.Notice && node.props.key === 'load-failed'))
})

test('scope controls, including overflow, are native keyboard buttons', async (t) => {
  const fx = fixture()
  const scopes = [{ key: 'global', label: 'Global' }, { key: wsPath, label: 'Long project label for overflow' }]
  const selections = []
  const props = { tabs: scopes, active: 'global', onSelect: (scope) => selections.push(scope) }
  let tree = fx.render(fx.ScopeTabs, props)
  t.after(() => fx.unmount(fx.ScopeTabs))
  find(tree, (node) => hasClass(node, 'dsh-mcp-tabs')).props.ref.current = { clientWidth: 150 }
  tree = await fx.settle(fx.ScopeTabs, props)
  const active = find(tree, (node) => node.props?.key === 'global')
  assert.equal(active.type, 'button')
  assert.equal(active.props['aria-pressed'], true)
  const more = find(tree, (node) => hasClass(node, 'more'))
  assert.equal(more.type, 'button')
  assert.equal(more.props['aria-expanded'], false)
  more.props.onClick({ stopPropagation() {} })
  tree = fx.render(fx.ScopeTabs, props)
  const hidden = find(tree, (node) => node.props?.key === wsPath)
  assert.equal(hidden.type, 'button')
  hidden.props.onClick({ stopPropagation() {} })
  assert.deepEqual(selections, [wsPath])
})

test('leaving the scopes overflow by keyboard dismisses it without pulling focus back', async (t) => {
  const fx = fixture()
  const props = { tabs: [{ key: 'global', label: 'Global' }, { key: wsPath, label: 'Long label for overflow' }], active: 'global', onSelect() {} }
  let tree = fx.render(fx.ScopeTabs, props)
  t.after(() => fx.unmount(fx.ScopeTabs))
  find(tree, (node) => hasClass(node, 'dsh-mcp-tabs')).props.ref.current = { clientWidth: 128 }
  tree = await fx.settle(fx.ScopeTabs, props)
  find(tree, (node) => hasClass(node, 'more')).props.onClick()
  tree = fx.render(fx.ScopeTabs, props)
  assert.ok([...nodes(tree)].some((node) => node.props?.key === wsPath))
  const next = {}
  tree.props.onBlur?.({ currentTarget: { contains: () => false }, relatedTarget: next })
  tree = fx.render(fx.ScopeTabs, props)
  assert.ok(![...nodes(tree)].some((node) => node.props?.key === wsPath))
  assert.equal(find(tree, (node) => hasClass(node, 'more')).props['aria-expanded'], false)
})

test('list rows keep selection separate from the MCP and skill switches', () => {
  const fx = fixture()
  for (const [row, Control] of [
    [find(fx.ServerList({ servers: [globalRow] }), (node) => hasClass(node, 'dsh-mcp-item')), fx.Toggle],
    [find(fx.render(fx.GlobalServerList, { servers: [globalRow] }), (node) => hasClass(node, 'dsh-mcp-item')), fx.EyeToggle],
    [fx.SkillRow({ row: skill('alpha'), onToggle() {} }), fx.Toggle],
  ]) {
    assert.notEqual(row.props.role, 'button', 'wrapping two actions in a button hides the child semantics')
    assert.equal(row.props.onKeyDown, undefined, 'row cannot cancel a descendant button default action')
    const control = ofType(row, Control)
    const pick = find(row, (node) => node.type === 'button' && node.props?.['aria-pressed'] !== undefined)
    assert.ok(![...nodes(pick)].includes(control), 'selection and switch are independent controls')
  }
})
