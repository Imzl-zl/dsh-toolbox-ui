import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { normalizeMcpImport } from '../lib/mcp-config.js'
import {
  evaluateEnvExpression,
  jsExpressionToTemplate,
  readWorkspaceConfig,
  specToMcpEntry,
  toMcpClientConfig,
  writeWorkspaceConfig,
} from '../lib/workspace-config.js'

test('jsExpressionToTemplate reverts every expressionValue form', () => {
  assert.equal(jsExpressionToTemplate('!!js process.env.API_KEY'), '${API_KEY}')
  assert.equal(jsExpressionToTemplate('!!js (process.env.TOKEN ?? "")'), '${TOKEN}')
  assert.equal(jsExpressionToTemplate('!!js (process.env.TOKEN ?? "fallback")'), '${TOKEN:-fallback}')
  assert.equal(jsExpressionToTemplate('!!js "Bearer " + (process.env.TOKEN ?? "")'), 'Bearer ${TOKEN}')
  assert.equal(jsExpressionToTemplate('!!js "a" + (process.env.X ?? "") + "b"'), 'a${X}b')
  assert.equal(jsExpressionToTemplate('!!js "C:\\\\tools\\\\" + (process.env.TOKEN ?? "") + "\\\\s.js"'), 'C:\\tools\\${TOKEN}\\s.js')
  assert.equal(jsExpressionToTemplate('npx'), 'npx')
  assert.equal(jsExpressionToTemplate(42), 42)
  assert.throws(() => jsExpressionToTemplate('!!js globalThis.exit()'), /无法安全写回/)
  assert.throws(() => jsExpressionToTemplate('!!js '), /空的 !!js/)
})

test('spec_to_entry roundtrips through normalizeMcpImport', () => {
  const spec = {
    name: 'local',
    transport: 'stdio',
    command: '!!js process.env.NPX',
    args: ['-y', 'example-mcp', '!!js (process.env.MODE ?? "")'],
    env: { API_KEY: '!!js process.env.API_KEY', GREETING: '!!js "hi " + (process.env.WHO ?? "you")' },
    cwd: 'C:\\proj',
    toolCallTimeoutMs: 30000,
    failOnStartupError: true,
    reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 },
    // 插件自己的项目级字段：必须原样往返，否则面板每次保存都会把它丢掉。
    idleTimeoutMs: 60000,
    disabled: false,
  }
  const entry = specToMcpEntry(spec)
  assert.deepEqual(entry, {
    command: '${NPX}',
    args: ['-y', 'example-mcp', '${MODE}'],
    env: { API_KEY: '${API_KEY}', GREETING: 'hi ${WHO:-you}' },
    cwd: 'C:\\proj',
    toolCallTimeoutMs: 30000,
    failOnStartupError: true,
    reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 },
    idleTimeoutMs: 60000,
    disabled: false,
  })
  const back = normalizeMcpImport({ mcpServers: { local: entry } }).servers[0]
  // 回读不是逐字复原：`${VAR}` 模板一律规范成带 `?? ""` 的表达式（裸引用在变量缺失时
  // 求值为 undefined，全局层会因此整棵插件树加载失败）。
  assert.deepEqual(back, {
    name: 'local',
    transport: 'stdio',
    command: '!!js (process.env.NPX ?? "")',
    args: ['-y', 'example-mcp', '!!js (process.env.MODE ?? "")'],
    env: {
      API_KEY: '!!js (process.env.API_KEY ?? "")',
      GREETING: '!!js "hi " + (process.env.WHO ?? "you")',
    },
    cwd: 'C:\\proj',
    toolCallTimeoutMs: 30000,
    failOnStartupError: true,
    reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 },
    idleTimeoutMs: 60000,
    disabled: false,
  })
})

test('idleTimeoutMs is a project-level policy and never reaches the mcp-client config', () => {
  const spec = { name: 'local', transport: 'stdio', command: 'node', idleTimeoutMs: 0 }
  // 0 = 不回收：必须能被写出、也必须能被读回（0 是合法值，不能被当成“未设置”）。
  assert.equal(specToMcpEntry(spec).idleTimeoutMs, 0)
  const back = normalizeMcpImport({ mcpServers: { local: specToMcpEntry(spec) } }).servers[0]
  assert.equal(back.idleTimeoutMs, 0)
  // 它不下发给 mcp-client：那边是未知字段（配置 schema 会拒绝），生命周期由插件自己管。
  assert.equal('idleTimeoutMs' in toMcpClientConfig(back, '/ws'), false)
  assert.throws(() => normalizeMcpImport({ mcpServers: { local: { command: 'node', idleTimeoutMs: -1 } } }), /idleTimeoutMs 必须是非负整数/)
  assert.throws(() => normalizeMcpImport({ mcpServers: { local: { command: 'node', idleTimeoutMs: 1.5 } } }), /idleTimeoutMs 必须是非负整数/)
})

// env/headers 的**键**同样来自用户配置，而 `__proto__` 在对象字面量里会走原型 setter：从内部 spec
// → 文件 → 读回 → 下发给 mcp-client，四跳里任何一跳用普通赋值都会静默吃掉它。这里钉住四跳。
test('env keys named __proto__ survive every hop', async () => {
  // 真实来源就是 JSON（JSON.parse 建出来的是 own property），所以这里也用它构造。
  const spec = { name: 'local', transport: 'stdio', command: 'node', env: JSON.parse('{"__proto__":"literal"}') }
  const own = (value) => Object.getOwnPropertyDescriptor(value, '__proto__')?.value

  assert.equal(own(specToMcpEntry(spec).env), 'literal', 'specToMcpEntry 必须把 env 的键写成 own property')

  const written = {}
  await writeWorkspaceConfig('/ws', { servers: [spec], exclude: [] }, async (path, text) => { written.path = path; written.text = text }, async () => {})
  const fileEntry = JSON.parse(written.text).mcpServers.local
  assert.equal(own(fileEntry.env), 'literal', '落盘的文件里必须真的有这条')

  const back = normalizeMcpImport({ mcpServers: { local: fileEntry } }).servers[0]
  assert.equal(own(back.env), 'literal', '读回时不能被原型吃掉')
  assert.equal(own(toMcpClientConfig(back, '/ws').env), 'literal', '下发给 mcp-client 的那一份同样要带过去')
})

test('http spec roundtrip keeps type/url/headers', () => {
  const spec = {
    name: 'remote',
    transport: 'streamable-http',
    url: 'https://example.test/mcp',
    headers: { Authorization: '!!js "Bearer " + (process.env.TOKEN ?? "")' },
  }
  const entry = specToMcpEntry(spec)
  assert.deepEqual(entry, { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer ${TOKEN}' } })
  const back = normalizeMcpImport({ mcpServers: { remote: entry } }).servers[0]
  assert.deepEqual(back, spec)
})

test('readWorkspaceConfig parses valid file and surfaces errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ws-'))
  const read = (path) => readFile(path, 'utf8')
  try {
    const configDir = join(root, '.dsh')
    await import('node:fs/promises').then((fs) => fs.mkdir(configDir, { recursive: true }))
    await writeFile(join(configDir, 'mcp.json'), JSON.stringify({
      mcpServers: {
        local: { command: 'npx', args: ['-y', 'demo'], env: { KEY: '${KEY}' } },
        remote: { type: 'http', url: 'https://example.test/mcp' },
      },
      exclude: ['github'],
    }, null, 2))
    const config = await readWorkspaceConfig(root, read)
    assert.equal(config.error, '')
    assert.deepEqual(config.servers.map((s) => s.name), ['local', 'remote'])
    assert.deepEqual(config.exclude, ['github'])
    assert.deepEqual(config.servers[0].env, { KEY: '!!js (process.env.KEY ?? "")' })

    const missing = await readWorkspaceConfig(join(root, 'nope'), read)
    assert.equal(missing.error, '')
    assert.equal(missing.missing, true)
    assert.deepEqual(missing.servers, [])

    const rootOnly = await mkdtemp(join(tmpdir(), 'dsh-ws-'))
    const rootOnlyDir = join(rootOnly, '.dsh')
    await import('node:fs/promises').then((fs) => fs.mkdir(rootOnlyDir, { recursive: true }))
    await writeFile(join(rootOnlyDir, 'mcp.json'), 'not json {')
    const invalid = await readWorkspaceConfig(rootOnly, read)
    assert.match(invalid.error, /不是合法 JSON/)
    assert.deepEqual(invalid.servers, [])

    const badEntry = await mkdtemp(join(tmpdir(), 'dsh-ws-'))
    const badEntryDir = join(badEntry, '.dsh')
    await import('node:fs/promises').then((fs) => fs.mkdir(badEntryDir, { recursive: true }))
    await writeFile(join(badEntryDir, 'mcp.json'), JSON.stringify({ mcpServers: { bad: { url: 'nope' } } }))
    const bad = await readWorkspaceConfig(badEntry, read)
    assert.match(bad.error, /配置无效/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a project file whose entries collide after normalization is rejected, not silently trimmed', async () => {
  // 文件是"一整份配置"：`"a"` 与 `" a"` 归一化后同名，说明这份文件自相矛盾，静默少一条更糟。
  // （导入一批来源/粘贴的取舍不同：那里只跳过重复项，不能让一条重名挡住其余条目。）
  const root = await mkdtemp(join(tmpdir(), 'dsh-ws-dup-'))
  const read = (path) => readFile(path, 'utf8')
  try {
    const dir = join(root, '.dsh')
    await import('node:fs/promises').then((fs) => fs.mkdir(dir, { recursive: true }))
    await writeFile(join(dir, 'mcp.json'), JSON.stringify({ mcpServers: { a: { command: 'node' }, ' a': { command: 'node' } } }))
    const config = await readWorkspaceConfig(root, read)
    assert.match(config.error, /归一化后同名/)
    assert.deepEqual(config.servers, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('writeWorkspaceConfig produces Claude-compatible JSON and roundtrips', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ws-'))
  const read = (path) => readFile(path, 'utf8')
  const write = (path, text) => writeFile(path, text)
  const mkdir = (path, opts) => import('node:fs/promises').then((fs) => fs.mkdir(path, opts))
  try {
    // `?? ""` 是 `${VAR}` 模板转换后的规范形式（裸的 `!!js process.env.X` 在变量缺失时
    // 会求值成 undefined，全局层会因此让整棵插件树加载失败）。写回文件仍是 `${VAR}`，
    // 所以「写→读」对规范形式是幂等的。
    const servers = [
      { name: 'local', transport: 'stdio', command: 'npx', args: ['-y', 'demo'], env: { KEY: '!!js (process.env.KEY ?? "")' } },
      { name: 'remote', transport: 'streamable-http', url: 'https://example.test/mcp', headers: { A: '!!js (process.env.T ?? "")' } },
    ]
    const { path } = await writeWorkspaceConfig(root, { servers, exclude: ['github'] }, write, mkdir)
    const text = await readFile(path, 'utf8')
    const parsed = JSON.parse(text)
    assert.deepEqual(parsed, {
      mcpServers: {
        local: { command: 'npx', args: ['-y', 'demo'], env: { KEY: '${KEY}' } },
        remote: { type: 'http', url: 'https://example.test/mcp', headers: { A: '${T}' } },
      },
      exclude: ['github'],
    })
    const config = await readWorkspaceConfig(root, read)
    assert.deepEqual(config.servers, servers)
    assert.deepEqual(config.exclude, ['github'])
    assert.equal(config.error, '')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('evaluateEnvExpression resolves runtime values', () => {
  const env = { TOKEN: 'abc', MISSING: undefined, EMPTY: '', WHO: 'world' }
  assert.equal(evaluateEnvExpression('!!js process.env.TOKEN', env), 'abc')
  assert.equal(evaluateEnvExpression('!!js (process.env.MISSING ?? "fb")', env), 'fb')
  assert.equal(evaluateEnvExpression('!!js (process.env.EMPTY ?? "fb")', env), '')
  assert.equal(evaluateEnvExpression('!!js "Bearer " + (process.env.TOKEN ?? "")', env), 'Bearer abc')
  assert.equal(evaluateEnvExpression('!!js "hi " + (process.env.WHO ?? "you")', env), 'hi world')
  assert.equal(evaluateEnvExpression('plain', env), 'plain')
  assert.throws(() => evaluateEnvExpression('!!js globalThis.exit()', env), /无法求值/)
})

test('toMcpClientConfig maps spec to official client config', () => {
  const env = { TOKEN: 'abc', DB_BIN: 'psql' }
  const config = toMcpClientConfig(
    {
      name: 'db',
      transport: 'stdio',
      command: '!!js process.env.DB_BIN',
      args: ['--url', '!!js (process.env.DB_URL ?? "default")'],
      env: { KEY: '!!js process.env.TOKEN' },
      cwd: '',
      toolCallTimeoutMs: 30000,
    },
    '/ws/a',
    env,
  )
  assert.equal(config.serverName, 'db')
  assert.equal(config.transport, 'stdio')
  assert.equal(config.command, 'psql')
  assert.deepEqual(config.args, ['--url', 'default'])
  assert.deepEqual(config.env, { KEY: 'abc' })
  assert.equal(config.cwd, '/ws/a')

  const http = toMcpClientConfig(
    { name: 'api', transport: 'streamable-http', url: 'https://api.test/mcp', headers: { A: '!!js process.env.TOKEN' } },
    '/ws/a',
    env,
  )
  assert.equal(http.url, 'https://api.test/mcp')
  assert.deepEqual(http.headers, { A: 'abc' })
})

test('writeWorkspaceConfig omits empty exclude', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ws-'))
  const write = (path, text) => writeFile(path, text)
  const mkdir = (path, opts) => import('node:fs/promises').then((fs) => fs.mkdir(path, opts))
  try {
    const { path } = await writeWorkspaceConfig(root, { servers: [], exclude: [] }, write, mkdir)
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    assert.deepEqual(parsed, { mcpServers: {} })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
test('toMcpClientConfig rejects empty resolved command/url', () => {
  assert.throws(
    () => toMcpClientConfig({ name: 'broken', transport: 'stdio', command: '!!js process.env.DSH_MCP_UNDEFINED_VAR_XYZ' }, '/ws'),
    /command 求值为空/,
  )
  assert.throws(
    () => toMcpClientConfig({ name: 'broken', transport: 'streamable-http', url: '!!js process.env.DSH_MCP_UNDEFINED_URL_XYZ' }, '/ws'),
    /url 求值为空/,
  )
})

// ── defer 字段往返（插件自有的 ToolSearch 开关，同 idleTimeoutMs 待遇） ──

test('specToMcpEntry: defer 原样往返，缺省不落键', () => {
  assert.equal(specToMcpEntry({ name: 'a', transport: 'stdio', command: 'x', defer: true }).defer, true)
  assert.equal(specToMcpEntry({ name: 'a', transport: 'stdio', command: 'x', defer: false }).defer, false)
  assert.equal('defer' in specToMcpEntry({ name: 'a', transport: 'stdio', command: 'x' }), false)
})

test('defer: 写盘再读回不丢（面板每次保存都走这条路）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-defer-'))
  try {
    const servers = [{ name: 'jshook', transport: 'stdio', command: 'npx jshook', defer: true }]
    await writeWorkspaceConfig(dir, { servers }, writeFile, (path) => mkdir(path, { recursive: true }))
    const config = await readWorkspaceConfig(dir, readFile)
    assert.equal(config.error, '')
    assert.equal(config.servers[0].defer, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
