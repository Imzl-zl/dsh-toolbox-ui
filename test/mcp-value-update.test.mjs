import assert from 'node:assert/strict'
import test from 'node:test'
import * as config from '../lib/mcp-config.js'
import { parseDocument } from 'yaml'
import { JS_TAG, getNode } from '../lib/yaml-node.js'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const OPTIONS = { timeout: 60000 }
const MASK = '__DSH_MCP_REDACTED__'
const unsafe = '!!js process.execPath'
const original = `# unrelated metadata\n- insert:\n    - id: mcp-kept\n      name: '@deepseek-ai/dsh-mcp-client'\n      disabled: !!js process.platform === 'win32' # lifecycle expression\n      config:\n        serverName: kept\n        transport: stdio\n        command: !!js process.execPath # command source\n        args:\n          - !!js ctx.secretArguments # argument source\n        env:\n          TOKEN: !!js ctx.credentials.token # secret source\n          PLAIN: old\n        cwd: /old\n        defer: !!js ctx.toolPreference # defer source\n`

async function boundary() {
  const api = await import('../lib/mcp-update-values.js').catch((error) => {
    if (error.code === 'ERR_MODULE_NOT_FOUND') return {}
    throw error
  })
  assert.equal(typeof api.admitMcpUpdate, 'function', 'controlled update admission is available')
  return api
}
function server(content = original) { return config.readManagedMcpServers(content).servers[0] }
function node(content, path) {
  const doc = parseDocument(content)
  const entry = getNode(doc.contents.items[0], 'insert').items[0]
  let current = entry
  for (const part of path) current = getNode(current, part)
  return current
}

test('new imports reject preservation references instead of silently ignoring them', OPTIONS, () => {
  assert.throws(() => config.normalizeMcpImport({ mcpServers: { new: { command: 'node', preserveFields: ['command'] } } }), /preserveFields|保留/)
  assert.throws(() => config.normalizeMcpImport({ mcpServers: { new: { command: 'node', env: { TOKEN: MASK } } } }), /保留|marker/)
  assert.throws(() => config.normalizeMcpImport({ mcpServers: { new: { transport: { type: 'stdio', command: 'node', preserveFields: [] } } } }), /preserveFields|保留/)
})

test('new map objects are not converted into object-object command data', OPTIONS, () => {
  for (const field of ['env', 'headers']) {
    const spec = field === 'env' ? { command: 'node', env: { VALUE: { unknown: 'object' } } } : { url: 'https://example.test/mcp', headers: { VALUE: { __jsExpr: 'ctx.token' } } }
    assert.throws(() => config.normalizeMcpImport({ mcpServers: { new: spec } }), /对象|字符串|value|VALUE/)
  }
})

test('new whole reconnect expression objects are rejected instead of normalized to an empty policy', OPTIONS, () => {
  assert.throws(() => config.normalizeMcpImport({ mcpServers: { new: { command: 'node', reconnect: { __jsExpr: 'ctx.reconnectPolicy' } } } }), /reconnect|对象/)
})

test('the read path retains the actual lifecycle expression without inventing enabled-false', OPTIONS, () => {
  assert.equal(server().disabled, "!!js process.platform === 'win32'")
})

test('unchanged legacy command, args and lifecycle expressions keep original YAML nodes and comments', OPTIONS, async () => {
  const { admitMcpUpdate } = await boundary()
  const current = server()
  const { spec } = admitMcpUpdate({ name: current.name, transport: 'stdio', preserveFields: ['command', 'args'], env: { TOKEN: MASK, PLAIN: 'new' }, cwd: '/new' }, current)
  assert.equal(spec.command, current.command)
  assert.equal(spec.disabled, current.disabled)
  assert.deepEqual(spec.args, current.args)
  assert.equal(spec.env.TOKEN, current.env.TOKEN)
  assert.equal(spec.env.PLAIN, 'new')
  const saved = config.updateManagedMcpPatch(original, [spec])
  for (const path of [['config', 'command'], ['disabled']]) {
    const before = node(original, path), after = node(saved, path)
    assert.equal(after.tag, JS_TAG)
    assert.equal(after.value, before.value)
    assert.equal(after.comment, before.comment)
  }
  const beforeToken = getNode(node(original, ['config', 'env']), 'TOKEN')
  const afterToken = getNode(node(saved, ['config', 'env']), 'TOKEN')
  assert.equal(afterToken.tag, beforeToken.tag)
  assert.equal(afterToken.value, beforeToken.value)
  assert.equal(afterToken.comment, beforeToken.comment)
  assert.match(saved, /# secret source/)
  assert.match(saved, /# argument source/)
  assert.match(saved, /# defer source/)
  assert.ok(!saved.includes('[object Object]'))
  assert.equal(config.readManagedMcpServers(saved).servers[0].cwd, '/new')
})

test('a retained canonical spec cannot create a missing entry in a different patch', OPTIONS, async () => {
  const { admitMcpUpdate } = await boundary()
  const current = { name: 'kept', transport: 'stdio', command: unsafe }
  const { spec } = admitMcpUpdate({ name: 'kept', transport: 'stdio', preserveFields: ['command'] }, current)
  assert.throws(() => config.updateManagedMcpPatch('[]\n', [spec]), /保留|引用|新增|当前/)
})

test('literal references retain an empty reconnect policy without filling absent optional defaults', OPTIONS, async () => {
  const { admitMcpUpdate } = await boundary()
  const current = { name: 'literal', transport: 'stdio', command: 'node', reconnect: {} }
  const { spec } = admitMcpUpdate({ name: 'literal', transport: 'stdio', preserveFields: ['command', 'reconnect'] }, current)
  assert.deepEqual(spec, current)
  for (const field of ['toolCallTimeoutMs', 'failOnStartupError', 'defer', 'disabled', 'args', 'env']) assert.equal(Object.hasOwn(spec, field), false)
  assert.throws(() => admitMcpUpdate({ name: 'literal', command: 'node', preserveFields: ['toolCallTimeoutMs'] }, current), /没有可保留|当前值/)
})

test('workspace literal zero budgets and false booleans retain their source meanings', OPTIONS, async () => {
  const { admitMcpUpdate } = await boundary()
  const current = { name: 'zero', transport: 'stdio', command: 'node', idleTimeoutMs: 0, readyTimeoutMs: 0, defer: false, disabled: false }
  const { spec } = admitMcpUpdate({ name: 'zero', transport: 'stdio', preserveFields: ['command', 'idleTimeoutMs', 'readyTimeoutMs'] }, current, { scope: 'workspace' })
  assert.deepEqual(spec, current)
  assert.equal(typeof spec.idleTimeoutMs, 'number')
  assert.equal(typeof spec.defer, 'boolean')
})

test('retained values reject a same-named different patch with changed protected root or leaf', OPTIONS, async () => {
  const { admitMcpUpdate } = await boundary()
  const current = server()
  const { spec: rootSpec } = admitMcpUpdate({ name: 'kept', transport: 'stdio', preserveFields: ['command'] }, current)
  const otherRoot = original.replace('command: !!js process.execPath', 'command: !!js process.argv[0]')
  assert.throws(() => config.updateManagedMcpPatch(otherRoot, [rootSpec]), /保留字段 command.*更改|重新读取/)
  const { spec: leafSpec } = admitMcpUpdate({ name: 'kept', transport: 'stdio', command: 'node', env: { TOKEN: MASK, PLAIN: 'new' } }, current)
  const otherLeaf = original.replace('TOKEN: !!js ctx.credentials.token', 'TOKEN: !!js ctx.otherCredentials.token')
  assert.throws(() => config.updateManagedMcpPatch(otherLeaf, [leafSpec]), /保留字段 env.TOKEN.*更改|重新读取/)
})

test('same protected source retains the destination own node comments rather than copying an earlier patch node', OPTIONS, async () => {
  const { admitMcpUpdate } = await boundary()
  const { spec } = admitMcpUpdate({ name: 'kept', transport: 'stdio', preserveFields: ['command'], cwd: '/new' }, server())
  const destination = original.replace('# command source', '# destination command source')
  const saved = config.updateManagedMcpPatch(destination, [spec])
  assert.equal(node(saved, ['config', 'command']).comment, node(destination, ['config', 'command']).comment)
  assert.equal(node(saved, ['config', 'command']).tag, node(destination, ['config', 'command']).tag)
  assert.equal(node(saved, ['config', 'command']).value, node(destination, ['config', 'command']).value)
})

test('preserving one secret leaf cannot admit unsafe new sibling expressions', OPTIONS, async () => {
  const { admitMcpUpdate } = await boundary()
  const current = { name: 'kept', transport: 'stdio', command: 'node', env: { TOKEN: '!!js ctx.credentials.token', PLAIN: 'old' } }
  const kept = admitMcpUpdate({ name: 'kept', transport: 'stdio', command: 'node', env: { TOKEN: MASK, PLAIN: 'new' } }, current).spec
  assert.equal(kept.env.TOKEN, current.env.TOKEN)
  assert.equal(kept.env.PLAIN, 'new')
  for (const env of [{ TOKEN: MASK, PLAIN: '!!js process.exit()' }, { OTHER: MASK }, { TOKEN: { __jsExpr: 'ctx.newSecret' } }, { TOKEN: '!!js ctx.newSecret' }]) {
    assert.throws(() => admitMcpUpdate({ name: 'kept', command: 'node', env }, current), /允许|保留|字符串|对象/)
  }
})

test('preserved roots must exist, fit the transport, and cannot also receive replacement values', OPTIONS, async () => {
  const { admitMcpUpdate } = await boundary()
  const current = { name: 'kept', transport: 'stdio', command: unsafe, cwd: '/old' }
  for (const request of [
    { preserveFields: ['command'], command: 'node' },
    { preserveFields: ['url'] },
    { preserveFields: ['command'], transport: 'streamable-http', url: 'https://example.test/mcp' },
    { preserveFields: ['name'] },
    { preserveFields: ['disabled'] },
    { preserveFields: ['env.TOKEN'] },
    { preserveFields: ['missing'] },
    { preserveFields: 'command' },
    { preserveFields: null, command: 'node' },
    { preserveFields: ['command', 'command'] },
  ]) assert.throws(() => admitMcpUpdate({ name: 'kept', transport: 'stdio', ...request }, current), /保留|preserve|字段|引用/)
})

test('workspace retention only keeps environment templates, including inside lists and sensitive leaves', OPTIONS, async () => {
  const { admitMcpUpdate } = await boundary()
  const scope = { scope: 'workspace' }
  const current = { name: 'kept', transport: 'stdio', command: 'node', env: { TOKEN: '!!js ctx.credentials.token' }, args: ['!!js ctx.secretArgument'] }
  assert.throws(() => admitMcpUpdate({ name: 'kept', command: 'node', env: { TOKEN: MASK } }, current, scope), /项目|模板|允许/)
  assert.throws(() => admitMcpUpdate({ name: 'kept', command: 'node', preserveFields: ['args'] }, current, scope), /项目|模板|允许/)
})

test('controlled updates reject non-string identity selectors before normalization can retarget a retained value', OPTIONS, async () => {
  const { admitMcpUpdate } = await boundary()
  const current = { name: 'source', transport: 'stdio', command: 'node', env: { SOURCE: 'keep source' } }
  const neighboringPatch = `- insert:\n    - id: mcp-neighbor\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: neighbor\n        transport: stdio\n        command: node\n        env:\n          NEIGHBOR: keep-neighbor\n`
  assert.throws(() => {
    const { spec } = admitMcpUpdate({ name: 'source', serverName: ['neighbor'], transport: 'stdio', preserveFields: ['command'] }, current)
    config.updateManagedMcpPatch(neighboringPatch, [spec])
  }, /serverName|名称|字符串/)
  for (const value of [['source'], { toString: () => 'source' }, 123, null]) {
    assert.throws(() => admitMcpUpdate({ name: value, transport: 'stdio', command: 'node' }, current), /name|名称|字符串/)
    assert.throws(() => admitMcpUpdate({ name: 'source', serverName: value, transport: 'stdio', command: 'node' }, current, { scope: 'workspace' }), /serverName|名称|字符串/)
  }
})

test('controlled updates choose one transport and reject conflicting aliases before admitting preserved fields', OPTIONS, async () => {
  const { admitMcpUpdate } = await boundary()
  const current = { name: 'source', transport: 'stdio', command: 'node', env: { TOKEN: 'old' } }
  assert.throws(() => admitMcpUpdate({ name: 'source', transport: 'stdio', type: 'http', url: 'https://example.test/mcp', preserveFields: ['env'] }, current), /传输|transport|type|冲突/)
  for (const field of ['transport', 'type']) for (const value of [{ type: 'stdio', command: 'node' }, ['stdio'], null, false]) {
    assert.throws(() => admitMcpUpdate({ name: 'source', command: 'node', [field]: value }, current), /传输|transport|type|字符串/)
  }
})

test('controlled URL aliases cannot supply a replacement alongside a preservation reference', OPTIONS, async () => {
  const { admitMcpUpdate } = await boundary()
  const current = { name: 'source', transport: 'streamable-http', url: 'https://old.example.test/mcp' }
  for (const field of ['serverUrl', 'server_url']) {
    assert.throws(() => admitMcpUpdate({ name: 'source', transport: 'http', preserveFields: ['url'], [field]: 'https://new.example.test/mcp' }, current), /保留|冲突|url|URL/)
    assert.throws(() => admitMcpUpdate({ name: 'source', transport: 'http', url: current.url, [field]: 'https://new.example.test/mcp' }, current), /冲突|url|URL/)
  }
})

test('scalar workspace rename and coherent aliases remain supported without import-style coercion', OPTIONS, async () => {
  const { admitMcpUpdate } = await boundary()
  const current = { name: 'source', transport: 'stdio', command: 'node' }
  const renamed = admitMcpUpdate({ name: 'source', serverName: 'neighbor', transport: 'stdio', command: 'node' }, current, { scope: 'workspace' }).spec
  assert.equal(renamed.name, 'neighbor')
  assert.equal(renamed.transport, 'stdio')
  const http = admitMcpUpdate({ name: 'source', type: 'http', transport: 'streamable-http', serverUrl: 'https://example.test/mcp' }, current).spec
  assert.equal(http.name, 'source')
  assert.equal(http.transport, 'streamable-http')
  assert.equal(http.url, 'https://example.test/mcp')
  assert.equal(Object.hasOwn(http, 'type'), false)
  assert.equal(Object.hasOwn(http, 'serverUrl'), false)
  const imported = config.normalizeMcpImport({ mcpServers: { legacy: { transport: { type: 'stdio', command: 'node' } } } }).servers[0]
  assert.equal(imported.name, 'legacy')
  assert.equal(imported.transport, 'stdio')
  assert.equal(imported.command, 'node')
})

test('preservation cannot copy one server old values into an alias or rename target', OPTIONS, async () => {
  const { admitMcpUpdate } = await boundary()
  const current = { name: 'kept', transport: 'stdio', command: unsafe }
  assert.throws(() => admitMcpUpdate({ name: 'kept', serverName: 'other', transport: 'stdio', preserveFields: ['command'] }, current), /name|名称|改名|同一/)
  assert.throws(() => admitMcpUpdate({ name: 'other', transport: 'stdio', preserveFields: ['command'] }, current), /name|名称|改名|同一/)
})

test('new unsafe JS remains rejected even with a forged JSON preservation bag', OPTIONS, async () => {
  const { admitMcpUpdate } = await boundary()
  const current = { name: 'kept', transport: 'stdio', command: 'node' }
  assert.throws(() => admitMcpUpdate({ name: 'kept', command: unsafe, preservedValues: { command: unsafe } }, current), /允许|字段|preserved/)
  assert.throws(() => config.normalizeMcpImport({ mcpServers: { kept: { command: unsafe } } }, { preservedValues: { command: unsafe } }), /Map|保留/)
  const accepted = config.normalizeMcpImport({ mcpServers: { kept: { command: 'node', env: { NUM: 0, BOOL: false, NIL: null } } } })
  assert.deepEqual(accepted.servers[0].env, { NUM: '0', BOOL: 'false', NIL: '' })
})

test('the global Host update uses current-entry references and preserves lifecycle source', OPTIONS, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-value-host-'))
  const path = join(root, 'cordis.patch.yml'), base = join(root, 'cordis.yml')
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(base, '[]\n')
  await writeFile(path, original)
  const entry = { options: { id: 'mcp-kept', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'kept', transport: 'stdio', command: { __jsExpr: 'process.execPath' } } }, disabled: false, fiber: { state: 2 } }
  const entries = [{ options: { id: 'include', name: 'cordis:include', config: { path: pathToFileURL(base).href } } }, entry]
  const loader = { entries: () => entries }
  const ctx = { loader, tools: { schemas: () => [] }, get: (name) => name === 'loader' ? loader : undefined }
  const { McpManagerGateway } = await import('../lib/index.js')
  const payload = { name: 'kept', transport: 'stdio', preserveFields: ['command', 'args'], env: { TOKEN: MASK, PLAIN: 'changed' }, cwd: '/changed' }
  const result = await McpManagerGateway.prototype.update.call({ ctx }, payload)
  assert.equal(result.persisted, 'applied')
  const content = await readFile(path, 'utf8')
  assert.equal(node(content, ['config', 'command']).tag, JS_TAG)
  assert.equal(node(content, ['config', 'command']).value, 'process.execPath')
  assert.equal(node(content, ['disabled']).value, "process.platform === 'win32'")
  assert.equal(config.readManagedMcpServers(content).servers[0].env.TOKEN, server().env.TOKEN)
  assert.equal(config.readManagedMcpServers(content).servers[0].cwd, payload.cwd)
  const beforeReject = content
  await assert.rejects(McpManagerGateway.prototype.update.call({ ctx }, { name: 'kept', command: '!!js process.exit()' }), /允许|process\.env/)
  assert.equal(await readFile(path, 'utf8'), beforeReject)
  await assert.rejects(McpManagerGateway.prototype.update.call({ ctx }, { name: 'foreign', preserveFields: ['command'] }), /profile|编辑/)
  assert.equal(await readFile(path, 'utf8'), beforeReject)
})

test('the immutable field registry owns the masked-field subset without opening every preservation reference to markers', OPTIONS, async () => {
  const schema = await import('../lib/mcp-value-schema.js')
  assert.equal(Array.isArray(schema.MASKED_FIELDS), true, 'read and update share an explicit masked-field subset')
  assert.equal(Object.isFrozen(schema.MASKED_FIELDS), true)
  assert.deepEqual(schema.MASKED_FIELDS, Object.keys(schema.MCP_FIELD_SCHEMA).filter((field) => schema.MCP_FIELD_SCHEMA[field].redaction !== undefined))
  assert.ok(schema.MASKED_FIELDS.length > 0)
  assert.equal(schema.MCP_FIELD_SCHEMA.command.redaction, undefined)
  assert.equal(schema.MCP_FIELD_SCHEMA.disabled.redaction, undefined)
  for (const field of schema.MASKED_FIELDS) assert.ok(['url', 'list', 'map'].includes(schema.MCP_FIELD_SCHEMA[field].redaction))
})

test('field schema recognizes raw and internal expressions without evaluating them', OPTIONS, async () => {
  const schema = await import('../lib/mcp-value-schema.js').catch((error) => error.code === 'ERR_MODULE_NOT_FOUND' ? {} : Promise.reject(error))
  assert.equal(typeof schema.expressionText, 'function')
  assert.equal(schema.expressionText({ __jsExpr: 'process.execPath' }), unsafe)
  assert.equal(schema.expressionText(unsafe), unsafe)
  assert.equal(schema.expressionText(Object.create({ __jsExpr: 'process.execPath' })), undefined)
  assert.equal(schema.expressionText({ __jsExpr: 1 }), undefined)
  assert.equal(schema.fieldKind('command'), 'text')
  assert.equal(schema.fieldKind('defer'), 'boolean')
  assert.equal(schema.fieldKind('toolCallTimeoutMs'), 'positiveInteger')
  assert.equal(schema.fieldKind('unknownField'), undefined)
  assert.equal(schema.fieldApplies('__proto__', 'stdio'), false)
  assert.equal(schema.fieldApplies('constructor', 'stdio'), false)
})
