import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

async function createProfileFixture(content, extraEntries = []) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mcp-host-'))
  const rootConfig = join(root, 'cordis.yml')
  const patchPath = join(root, 'cordis.patch.yml')
  await writeFile(rootConfig, '[]\n')
  await writeFile(patchPath, content)
  const entries = [{ options: { id: 'include', name: 'cordis:include', config: { path: pathToFileURL(rootConfig).href } } }, ...extraEntries]
  // 真 loader 的 Entry 一定有 update()——setDisabled 与 update(spec) 改连接字段时在生产里就走它。
  // 桩上补一个最小实现（merge options，即 loader 的 replaceKeys 语义），否则这两条 RPC 路径
  // 在桩上会以 "entry.update is not a function" 炸掉，而那不是产品缺陷、是夹具不忠实。
  // entry.parent.remove(id) 同理：它是 loader 里"停掉并移除一个条目"的原语，removeServer 走它
  // （不走 ctx.loader.remove——那条对 include 子树条目是静默 no-op，见 lib/index.js 的注释）。
  const group = {
    remove: async (id) => {
      const index = entries.findIndex((entry) => entry.options.id === id)
      if (index >= 0) entries.splice(index, 1)
    },
  }
  for (const entry of entries) {
    entry.parent = group
    if (typeof entry.update !== 'function') {
      entry.update = async (options) => { Object.assign(entry.options, options ?? {}) }
    }
  }
  return {
    root,
    rootConfig,
    patchPath,
    entries,
    ctx: {
      // create/remove 同样必须补：add / removeServer / installBuiltins 靠它们在**运行中的
      // 进程**里增删 loader 条目（只写盘的那半是旧行为，已由 test/real-host-loader.test.mjs
      // 的真 loader 夹具覆盖连接效果）。桩上做同一份 entries 数组上的增删——稳定引用、
      // 可观测，与 entries() 是同一个真相源。
      loader: {
        entries: () => entries,
        create: async (options) => {
          const entry = { options: { ...options }, parent: group, update: async (next) => { Object.assign(entry.options, next ?? {}) } }
          entries.push(entry)
          return options.id
        },
        remove: async (id) => group.remove(id),
      },
      tools: { schemas: () => [] },
      get: () => undefined,
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true })
    },
  }
}
test('profile mutations use host-owned storage outside the session workspace', async () => {
  const { McpManagerGateway } = await import('../lib/index.js')
  const fixture = await createProfileFixture('[]\n')
  const sandboxedFs = {
    resolve: async (path) => ({ targetKey: path, displayPath: path }),
    stat: async () => ({ type: 'file', version: 'v1' }),
    readText: async () => await readFile(fixture.patchPath, 'utf8'),
    writeText: async () => { throw new Error('file access denied under workspace-write mode') },
  }
  const ctx = { ...fixture.ctx, get(name) { assert.equal(name, 'fs'); return sandboxedFs } }

  try {
    await McpManagerGateway.prototype.add.call({ ctx }, { name: 'demo', transport: 'stdio', command: 'node' })
    assert.match(await readFile(fixture.patchPath, 'utf8'), /serverName: demo/)
  } finally {
    await fixture.cleanup()
  }
})

test('host entry imports with declared runtime dependencies', async () => {
  const host = await import('../lib/index.js')
  assert.equal(typeof host.default, 'function')
  assert.equal(host.default, host.McpManagerGateway)
})

test('host builtin catalog is read-only and selected install skips other configuration layers', async () => {
  const { McpManagerGateway } = await import('../lib/index.js')
  const externalExa = {
    options: {
      id: 'mcp-tavily',
      name: '@deepseek-ai/dsh-mcp-client',
      config: { serverName: 'private-search', transport: 'streamable-http', url: 'https://mcp.exa.ai/mcp' },
    },
    disabled: false,
    fiber: null,
  }
  const groupedTavily = {
    options: {
      id: 'preset-tavily',
      group: 'agent-preset',
      name: '@deepseek-ai/dsh-mcp-client',
      config: { serverName: 'preset-search', transport: 'streamable-http', url: 'https://mcp.tavily.com/mcp/' },
    },
    disabled: false,
    fiber: null,
  }
  const fixture = await createProfileFixture('[]\n', [externalExa, groupedTavily])

  try {
    assert.equal(typeof McpManagerGateway.prototype.builtins, 'function')
    assert.equal(typeof McpManagerGateway.prototype.installBuiltins, 'function')

    const catalog = await McpManagerGateway.prototype.builtins.call({ ctx: fixture.ctx })
    assert.equal(catalog.builtins.find((item) => item.id === 'exa').installed, true)
    assert.deepEqual(catalog.builtins.find((item) => item.id === 'exa').installedAs, ['private-search'])
    assert.equal(catalog.builtins.find((item) => item.id === 'tavily').installed, true)
    assert.deepEqual(catalog.builtins.find((item) => item.id === 'tavily').installedAs, ['preset-search'])
    const listed = await McpManagerGateway.prototype.list.call({ ctx: fixture.ctx })
    assert.equal(listed.servers.some((server) => server.serverName === 'preset-search' && server.managed === false), true)
    await assert.rejects(
      McpManagerGateway.prototype.add.call({ ctx: fixture.ctx }, { name: 'preset-search', transport: 'stdio', command: 'node' }),
      /already exists/i,
    )
    const preview = await McpManagerGateway.prototype.previewImport.call({ ctx: fixture.ctx }, {
      mode: 'merge',
      json: { mcpServers: { 'preset-search': { type: 'http', url: 'https://mcp.tavily.com/mcp/' } } },
    })
    assert.deepEqual(preview.conflicts, ['preset-search'])
    assert.equal(await readFile(fixture.patchPath, 'utf8'), '[]\n')

    const installed = await McpManagerGateway.prototype.installBuiltins.call(
      { ctx: fixture.ctx },
      { ids: ['exa', 'tavily', 'playwright'] },
    )
    const first = await readFile(fixture.patchPath, 'utf8')
    const parsed = (await import('../lib/mcp-config.js')).readManagedMcpServers(first)
    assert.deepEqual(installed.added, ['playwright'])
    assert.deepEqual(installed.skipped, ['exa', 'tavily'])
    assert.deepEqual(parsed.servers.map((server) => server.name), ['playwright'])
    assert.equal(parsed.entryIds.playwright, 'mcp-playwright')
    assert.doesNotMatch(first, /serverName: exa/)

    const repeated = await McpManagerGateway.prototype.installBuiltins.call(
      { ctx: fixture.ctx },
      { ids: ['exa', 'tavily', 'playwright'] },
    )
    assert.deepEqual(repeated.added, [])
    assert.deepEqual(repeated.skipped, ['exa', 'tavily', 'playwright'])
    assert.equal(await readFile(fixture.patchPath, 'utf8'), first)

    await assert.rejects(
      McpManagerGateway.prototype.installBuiltins.call({ ctx: fixture.ctx }, { ids: ['unknown'] }),
      /未知.*unknown/i,
    )
    assert.equal(await readFile(fixture.patchPath, 'utf8'), first)
  } finally {
    await fixture.cleanup()
  }
})

test('builtin installation trusts the freshly read patch when the loader still has a removed entry', async () => {
  const { McpManagerGateway } = await import('../lib/index.js')
  const content = `- insert:\n    - id: mcp-firecrawl\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: firecrawl\n        transport: streamable-http\n        url: https://mcp.firecrawl.dev/v2/mcp\n`
  const staleEntry = {
    options: { id: 'mcp-firecrawl', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'firecrawl', transport: 'streamable-http', url: 'https://mcp.firecrawl.dev/v2/mcp' } },
    disabled: false,
    fiber: null,
  }
  const fixture = await createProfileFixture(content, [staleEntry])
  fixture.entries[0].subtree = { entries: () => [staleEntry] }

  try {
    await writeFile(fixture.patchPath, '[]\n')
    const result = await McpManagerGateway.prototype.installBuiltins.call({ ctx: fixture.ctx }, { ids: ['firecrawl'] })
    assert.deepEqual(result.added, ['firecrawl'])
    assert.deepEqual(result.skipped, [])
    assert.match(await readFile(fixture.patchPath, 'utf8'), /serverName: firecrawl/)
  } finally {
    await fixture.cleanup()
  }
})

test('Remote projections redact secrets and preview omits normalized server configs', async () => {
  const { McpManagerGateway } = await import('../lib/index.js')
  const secret = 'super-secret-token'
  const content = `- insert:\n    - id: mcp-remote\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: remote\n        transport: streamable-http\n        url: https://example.test/mcp?token=${secret}\n        headers:\n          Authorization: Bearer ${secret}\n          X-From-Env: !!js process.env.SAFE_TOKEN\n          Bypass: !!js '"Bearer ${secret}" + process.env.NOOP'\n    - id: mcp-local\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: local\n        transport: stdio\n        command: node\n        args: [--token, ${secret}, -H, 'Authorization: Bearer ${secret}', --header, 'X-API-Key: ${secret}', 'https://example.test/mcp?token=${secret}']\n        env:\n          API_KEY: ${secret}\n`
  const remote = { options: { id: 'mcp-remote', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'remote', transport: 'streamable-http', url: `https://example.test/mcp?token=${secret}`, headers: { Authorization: `Bearer ${secret}`, 'X-From-Env': '!!js process.env.SAFE_TOKEN', Bypass: `!!js "Bearer ${secret}" + process.env.NOOP` } } }, disabled: false, fiber: null }
  const local = { options: { id: 'mcp-local', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'local', transport: 'stdio', command: 'node', args: ['--token', secret, '-H', `Authorization: Bearer ${secret}`, '--header', `X-API-Key: ${secret}`, `https://example.test/mcp?token=${secret}`], env: { API_KEY: secret } } }, disabled: false, fiber: null }
  const fixture = await createProfileFixture(content, [remote, local])

  try {
    const result = await McpManagerGateway.prototype.list.call({ ctx: fixture.ctx })
    const wire = JSON.stringify(result)
    assert.doesNotMatch(wire, new RegExp(secret))
    assert.equal(result.servers.find((server) => server.serverName === 'remote').headers.Authorization, '__DSH_MCP_REDACTED__')
    // 默认一律掩码：`!!js` 引用与明文一视同仁，内部表达式不得出现在线上投影里。
    assert.equal(result.servers.find((server) => server.serverName === 'remote').headers['X-From-Env'], '__DSH_MCP_REDACTED__')
    assert.equal(result.servers.find((server) => server.serverName === 'remote').headers.Bypass, '__DSH_MCP_REDACTED__')
    assert.equal(result.servers.find((server) => server.serverName === 'local').env.API_KEY, '__DSH_MCP_REDACTED__')
    assert.deepEqual(result.servers.find((server) => server.serverName === 'local').args, ['__DSH_MCP_REDACTED__'])
    assert.doesNotMatch(JSON.stringify(await McpManagerGateway.prototype.status.call({ ctx: fixture.ctx }, 'remote')), new RegExp(secret))

    const preview = await McpManagerGateway.prototype.previewImport.call({ ctx: fixture.ctx }, {
      mode: 'merge',
      json: { mcpServers: { imported: { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: `Bearer ${secret}` } } } },
    })
    assert.equal(Object.hasOwn(preview, 'servers'), false)
    assert.doesNotMatch(JSON.stringify(preview), new RegExp(secret))
  } finally {
    await fixture.cleanup()
  }
})

test('update preserves values represented by the Remote redaction sentinel', async () => {
  const { McpManagerGateway } = await import('../lib/index.js')
  const secret = 'super-secret-token'
  const content = `- insert:\n    - id: mcp-remote\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: remote\n        transport: streamable-http\n        url: https://example.test/mcp?token=${secret}\n        headers:\n          Authorization: Bearer ${secret}\n`
  const entry = { options: { id: 'mcp-remote', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'remote', transport: 'streamable-http', url: `https://example.test/mcp?token=${secret}`, headers: { Authorization: `Bearer ${secret}` } } }, disabled: false, fiber: null }
  const fixture = await createProfileFixture(content, [entry])

  try {
    const projected = (await McpManagerGateway.prototype.list.call({ ctx: fixture.ctx })).servers[0]
    await McpManagerGateway.prototype.update.call({ ctx: fixture.ctx }, {
      name: 'remote',
      transport: 'http',
      url: projected.url,
      headers: projected.headers,
    })
    const persisted = await readFile(fixture.patchPath, 'utf8')
    assert.match(persisted, new RegExp(secret))
    assert.doesNotMatch(persisted, /__DSH_MCP_REDACTED__/)
  } finally {
    await fixture.cleanup()
  }
})

test('sensitive args preserve as one opaque value and reject mixed edits', async () => {
  const { McpManagerGateway } = await import('../lib/index.js')
  const secret = 'super-secret-token'
  const content = `- insert:\n    - id: mcp-local\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: local\n        transport: stdio\n        command: node\n        args: [--token, ${secret}, --verbose]\n`
  const entry = { options: { id: 'mcp-local', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'local', transport: 'stdio', command: 'node', args: ['--token', secret, '--verbose'] } }, disabled: false, fiber: null }
  const fixture = await createProfileFixture(content, [entry])

  try {
    const projected = (await McpManagerGateway.prototype.list.call({ ctx: fixture.ctx })).servers[0]
    assert.deepEqual(projected.args, ['__DSH_MCP_REDACTED__'])
    await McpManagerGateway.prototype.update.call({ ctx: fixture.ctx }, { name: 'local', transport: 'stdio', command: 'node', args: projected.args })
    assert.match(await readFile(fixture.patchPath, 'utf8'), new RegExp(secret))
    await assert.rejects(
      McpManagerGateway.prototype.update.call({ ctx: fixture.ctx }, { name: 'local', transport: 'stdio', command: 'node', args: ['--debug', '__DSH_MCP_REDACTED__'] }),
      /敏感参数.*完整重填|保留原值标记.*混合/,
    )
  } finally {
    await fixture.cleanup()
  }
})

test('concurrent profile mutations are serialized without losing either update', async () => {
  const { McpManagerGateway } = await import('../lib/index.js')
  const { readManagedMcpServers } = await import('../lib/mcp-config.js')
  const fixture = await createProfileFixture('[]\n')

  try {
    await Promise.all([
      McpManagerGateway.prototype.add.call({ ctx: fixture.ctx }, { name: 'alpha', transport: 'stdio', command: 'node' }),
      McpManagerGateway.prototype.add.call({ ctx: fixture.ctx }, { name: 'beta', transport: 'stdio', command: 'node' }),
    ])
    const content = await readFile(fixture.patchPath, 'utf8')
    assert.deepEqual(readManagedMcpServers(content).servers.map((server) => server.name), ['alpha', 'beta'])
  } finally {
    await fixture.cleanup()
  }
})

test('guarded profile writes refuse to overwrite an external edit made after the read', async () => {
  const { McpManagerGateway } = await import('../lib/index.js')
  const external = `- insert:\n    - id: external\n      name: external-plugin\n`
  const fixture = await createProfileFixture('[]\n')
  const entries = fixture.entries
  let calls = 0
  fixture.ctx.loader.entries = () => {
    calls += 1
    if (calls === 3) writeFileSync(fixture.patchPath, external)
    return entries
  }

  try {
    await assert.rejects(
      McpManagerGateway.prototype.add.call({ ctx: fixture.ctx }, { name: 'demo', transport: 'stdio', command: 'node' }),
      /FS_STALE_VERSION/,
    )
    assert.equal(await readFile(fixture.patchPath, 'utf8'), external)
  } finally {
    await fixture.cleanup()
  }
})

test('enable repairs a disabled patch even when the live entry is already enabled', async () => {
  const { McpManagerGateway } = await import('../lib/index.js')
  const content = `- insert:\n    - id: mcp-one\n      name: '@deepseek-ai/dsh-mcp-client'\n      disabled: true\n      config:\n        serverName: one\n        transport: stdio\n        command: node\n`
  let updates = 0
  const entry = {
    options: { id: 'mcp-one', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'one', transport: 'stdio', command: 'node' } },
    disabled: false,
    fiber: null,
    update: async () => { updates += 1 },
  }
  const fixture = await createProfileFixture(content, [entry])

  try {
    await McpManagerGateway.prototype.setDisabled.call({ ctx: fixture.ctx }, 'one', false)
    assert.doesNotMatch(await readFile(fixture.patchPath, 'utf8'), /disabled: true/)
    assert.equal(updates, 0)
  } finally {
    await fixture.cleanup()
  }
})

test('profile writes target the official root include entry rather than the first nested include', async () => {
  const { McpManagerGateway } = await import('../lib/index.js')
  const fixture = await createProfileFixture('[]\n')
  const nestedRoot = await mkdtemp(join(fixture.root, 'nested-'))
  const nestedConfig = join(nestedRoot, 'cordis.yml')
  const nestedPatch = join(nestedRoot, 'cordis.patch.yml')
  await writeFile(nestedConfig, '[]\n')
  await writeFile(nestedPatch, '[]\n')
  fixture.entries.unshift({ options: { id: 'nested', name: 'cordis:include', config: { path: pathToFileURL(nestedConfig).href } } })

  try {
    await McpManagerGateway.prototype.add.call({ ctx: fixture.ctx }, { name: 'demo', transport: 'stdio', command: 'node' })
    assert.match(await readFile(fixture.patchPath, 'utf8'), /serverName: demo/)
    assert.equal(await readFile(nestedPatch, 'utf8'), '[]\n')
  } finally {
    await fixture.cleanup()
  }
})

test('failed live disable restores the previous persisted patch', async () => {
  const { McpManagerGateway } = await import('../lib/index.js')
  const content = `- insert:\n    - id: mcp-one\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: one\n        transport: stdio\n        command: node\n`
  const entry = {
    options: { id: 'mcp-one', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'one', transport: 'stdio', command: 'node' } },
    disabled: false,
    fiber: null,
    update: async () => { throw new Error('live update failed') },
  }
  const fixture = await createProfileFixture(content, [entry])

  try {
    await assert.rejects(
      McpManagerGateway.prototype.setDisabled.call({ ctx: fixture.ctx }, 'one', true),
      /live update failed/,
    )
    assert.equal(await readFile(fixture.patchPath, 'utf8'), content)
  } finally {
    await fixture.cleanup()
  }
})

test('profile update persists edited MCP fields through host storage', async () => {
  const { McpManagerGateway } = await import('../lib/index.js')
  const content = `- insert:\n    - id: mcp-demo\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: demo\n        transport: stdio\n        command: node\n`
  const entry = {
    options: { id: 'mcp-demo', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'demo', transport: 'stdio', command: 'node' } },
    disabled: false,
    fiber: null,
  }
  const fixture = await createProfileFixture(content, [entry])

  try {
    await McpManagerGateway.prototype.update.call({ ctx: fixture.ctx }, { name: 'demo', transport: 'http', url: 'https://example.test/mcp' })
    const next = await readFile(fixture.patchPath, 'utf8')
    assert.match(next, /transport: streamable-http/)
    assert.match(next, /url: https:\/\/example\.test\/mcp/)
    assert.doesNotMatch(next, /command: node/)
  } finally {
    await fixture.cleanup()
  }
})

test('profile removal persists through host storage', async () => {
  const { McpManagerGateway } = await import('../lib/index.js')
  const content = `- insert:\n    - id: mcp-demo\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: demo\n        transport: stdio\n        command: node\n`
  const entry = {
    options: { id: 'mcp-demo', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'demo', transport: 'stdio', command: 'node' } },
    disabled: false,
    fiber: null,
  }
  const fixture = await createProfileFixture(content, [entry])

  try {
    await McpManagerGateway.prototype.removeServer.call({ ctx: fixture.ctx }, 'demo')
    assert.doesNotMatch(await readFile(fixture.patchPath, 'utf8'), /serverName: demo/)
  } finally {
    await fixture.cleanup()
  }
})

test('merge import updates named MCPs and preserves other managed entries', async () => {
  const { McpManagerGateway } = await import('../lib/index.js')
  const content = `- insert:\n    - id: mcp-keep\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: keep\n        transport: stdio\n        command: node\n    - id: mcp-update\n      name: '@deepseek-ai/dsh-mcp-client'\n      disabled: true\n      config:\n        serverName: update\n        transport: stdio\n        command: old\n`
  const keep = { options: { id: 'mcp-keep', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'keep', transport: 'stdio', command: 'node' } }, disabled: false, fiber: null }
  const update = { options: { id: 'mcp-update', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'update', transport: 'stdio', command: 'old' } }, disabled: true, fiber: null }
  const fixture = await createProfileFixture(content, [keep, update])

  try {
    await McpManagerGateway.prototype.importJson.call({ ctx: fixture.ctx }, {
      mode: 'merge',
      json: { mcpServers: {
        update: { type: 'http', url: 'https://example.test/mcp', directTools: true },
        added: { command: 'node', directTools: false },
      } },
    })
    const parsed = (await import('../lib/mcp-config.js')).readManagedMcpServers(await readFile(fixture.patchPath, 'utf8'))
    assert.deepEqual(parsed.servers.map((server) => server.name), ['keep', 'update', 'added'])
    assert.equal(parsed.servers.find((server) => server.name === 'update').disabled, undefined)
    assert.equal(parsed.servers.find((server) => server.name === 'added').disabled, true)
  } finally {
    await fixture.cleanup()
  }
})

test('replace import removes absent MCPs and applies directTools enablement mapping', async () => {
  const { McpManagerGateway } = await import('../lib/index.js')
  const content = `- insert:\n    - id: mcp-remove\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: remove\n        transport: stdio\n        command: node\n    - id: mcp-keep\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: keep\n        transport: stdio\n        command: node\n`
  const remove = { options: { id: 'mcp-remove', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'remove', transport: 'stdio', command: 'node' } }, disabled: false, fiber: null }
  const keep = { options: { id: 'mcp-keep', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'keep', transport: 'stdio', command: 'node' } }, disabled: false, fiber: null }
  const fixture = await createProfileFixture(content, [remove, keep])

  try {
    await McpManagerGateway.prototype.importJson.call({ ctx: fixture.ctx }, {
      mode: 'replace',
      json: { mcpServers: { keep: { command: 'updated', directTools: false } } },
    })
    const parsed = (await import('../lib/mcp-config.js')).readManagedMcpServers(await readFile(fixture.patchPath, 'utf8'))
    assert.deepEqual(parsed.servers.map((server) => server.name), ['keep'])
    assert.equal(parsed.servers[0].command, 'updated')
    assert.equal(parsed.servers[0].disabled, true)
  } finally {
    await fixture.cleanup()
  }
})

test('duplicate cross-layer server names collapse into one row, and the profile-owned entry stays editable', async () => {
  // 语义：**同名条目有几条**是展示事实（conflict/duplicates），**能不能改**只看 id 是否属于
  // 本 profile（managed）。旧行为把两者合成一个开关（有冲突 ⇒ managed=null ⇒ 全灰），
  // 真机上表现为「一行、两条条目、无法编辑和卸载」——正是这次要修的死胡同。
  const { McpManagerGateway } = await import('../lib/index.js')
  const patch = `- insert:\n    - id: mcp-shared-profile\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: shared\n        transport: stdio\n        command: node\n`
  const external = { options: { id: 'mcp-shared-external', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'shared', transport: 'stdio', command: 'external' } }, disabled: false, fiber: null }
  const profile = { options: { id: 'mcp-shared-profile', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'shared', transport: 'stdio', command: 'node' } }, disabled: false, fiber: null }
  const fixture = await createProfileFixture(patch, [external, profile])
  fixture.entries[0].subtree = { entries: () => [profile] }

  try {
    const result = await McpManagerGateway.prototype.list.call({ ctx: fixture.ctx })
    // 一行：按 serverName 归组，用户眼里就是一台服务器。
    assert.equal(result.servers.length, 1)
    assert.equal(result.servers[0].serverName, 'shared')
    assert.equal(result.servers[0].conflict, true)
    assert.equal(result.servers[0].managed, true, '本 profile 拥有其中一条，就必须能改它')
    // 另一条不是「不存在」，而是「不是你的」：id 必须能说出来，否则用户没有任何线索。
    assert.deepEqual(result.servers[0].duplicates.map((other) => other.id), ['mcp-shared-external'])

    const gateway = { ctx: fixture.ctx }
    await McpManagerGateway.prototype.update.call(gateway, { name: 'shared', transport: 'stdio', command: 'node-edited' })
    assert.equal(profile.options.config.command, 'node-edited', '编辑必须落到自己那条上')
    assert.equal(external.options.config.command, 'external', '别的配置层的条目一个字节都不能动')

    // 导入仍然跳过同名：再写一行下去就是**第三条**同作用域条目，那才是真的制造冲突。
    const preview = await McpManagerGateway.prototype.previewImport.call(gateway, {
      mode: 'merge',
      json: { mcpServers: { shared: { command: 'updated' } } },
    })
    assert.deepEqual(preview.conflicts, ['shared'])
    // 被其他配置层占用不再让整批失败：跳过这一条、导入其余，并在预览与结果里都说明。
    // （外部层的条目不在本 patch 文件里，跳过它既不会覆盖也不会删掉它；硬写下去才是同作用域重名。）
    const imported = await McpManagerGateway.prototype.importJson.call(gateway, {
      mode: 'merge',
      json: { mcpServers: { shared: { command: 'updated' } } },
    })
    assert.deepEqual(imported.added, [])
    assert.ok(imported.warnings.some((warning) => warning.includes('已跳过被其他配置层占用的同名 MCP：shared')))
    assert.match(imported.note, /跳过 1 条同名条目：shared/)
    const written = await readFile(fixture.patchPath, 'utf8')
    assert.match(written, /serverName: shared/)
    assert.equal(written.includes('updated'), false, '被其他层占用的条目不得被覆盖')

    // 移除只删自己那条：别层的条目必须原样留着（它不在我们的 patch 里，也不归我们管），
    // 而且必须把「还剩下谁」说出来——否则删完仍看到失败日志，用户会以为移除没生效。
    const removed = await McpManagerGateway.prototype.removeServer.call(gateway, 'shared')
    assert.match(removed.note, /另有 1 条同名条目/)
    assert.match(removed.note, /mcp-shared-external/)
    const after = fixture.entries.filter((entry) => entry.options.name === '@deepseek-ai/dsh-mcp-client')
    assert.deepEqual(after.map((entry) => entry.options.id), ['mcp-shared-external'], '只有自己那条被移除')
    const rewritten = await readFile(fixture.patchPath, 'utf8')
    assert.equal(rewritten.includes('shared'), false, '移除后 patch 里不再有这一行')
  } finally {
    await fixture.cleanup()
  }
})

test('tool counts preserve server names containing double underscores', async () => {
  const { McpManagerGateway } = await import('../lib/index.js')
  const content = `- insert:\n    - id: mcp-foo-bar\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: foo__bar\n        transport: stdio\n        command: node\n`
  const entry = { options: { id: 'mcp-foo-bar', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'foo__bar', transport: 'stdio', command: 'node' } }, disabled: false, fiber: { state: 2 } }
  const fixture = await createProfileFixture(content, [entry])
  fixture.ctx.tools.schemas = () => [{ name: 'mcp__foo__bar__search', description: '' }]

  try {
    const result = await McpManagerGateway.prototype.list.call({ ctx: fixture.ctx })
    assert.equal(result.servers[0].toolCount, 1)
    assert.equal(result.servers[0].status, 'connected')
  } finally {
    await fixture.cleanup()
  }
})

test('overlapping server-name prefixes are reported as ambiguous instead of misattributed', async () => {
  const { McpManagerGateway } = await import('../lib/index.js')
  const content = `- insert:\n    - id: mcp-foo\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: foo\n        transport: stdio\n        command: node\n    - id: mcp-foo-bar\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: foo__bar\n        transport: stdio\n        command: node\n`
  const foo = { options: { id: 'mcp-foo', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'foo', transport: 'stdio', command: 'node' } }, disabled: false, fiber: { state: 2 } }
  const fooBar = { options: { id: 'mcp-foo-bar', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'foo__bar', transport: 'stdio', command: 'node' } }, disabled: false, fiber: { state: 2 } }
  const fixture = await createProfileFixture(content, [foo, fooBar])
  fixture.ctx.tools.schemas = () => [{ name: 'mcp__foo__bar__search', description: '' }]

  try {
    const result = await McpManagerGateway.prototype.list.call({ ctx: fixture.ctx })
    for (const server of result.servers) {
      assert.equal(server.toolCount, 0)
      assert.equal(server.toolCountAmbiguous, true)
      assert.equal(server.status, 'unknown')
    }
    const tools = await McpManagerGateway.prototype.tools.call({ ctx: fixture.ctx }, { name: 'foo' })
    assert.deepEqual(tools.tools, [])
    assert.equal(tools.ambiguous, true)
  } finally {
    await fixture.cleanup()
  }
})

test('list revision changes when the projected managed config changes', async () => {
  const { McpManagerGateway } = await import('../lib/index.js')
  const content = `- insert:\n    - id: mcp-demo\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: demo\n        transport: stdio\n        command: node\n`
  const entry = {
    options: { id: 'mcp-demo', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'demo', transport: 'stdio', command: 'node' } },
    disabled: false,
    fiber: null,
  }
  const fixture = await createProfileFixture(content, [entry])

  try {
    const before = await McpManagerGateway.prototype.list.call({ ctx: fixture.ctx })
    await McpManagerGateway.prototype.update.call(
      { ctx: fixture.ctx },
      { name: 'demo', transport: 'stdio', command: 'python' },
    )
    const after = await McpManagerGateway.prototype.list.call({ ctx: fixture.ctx })

    assert.equal(before.servers[0].command, 'node')
    assert.equal(after.servers[0].command, 'python')
    assert.notEqual(after.revision, before.revision)
  } finally {
    await fixture.cleanup()
  }
})

test('opaque reveal revision follows effective runtime secrets without exposing them', async () => {
  const { McpManagerGateway } = await import('../lib/index.js')
  const content = `- insert:\n    - id: mcp-sec\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: sec\n        transport: stdio\n        command: node\n        env:\n          API_KEY: first-secret\n`
  const entry = {
    options: { id: 'mcp-sec', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'sec', transport: 'stdio', command: 'node', env: { API_KEY: 'first-secret' } } },
    disabled: false,
    fiber: null,
  }
  const fixture = await createProfileFixture(content, [entry])

  try {
    const before = await McpManagerGateway.prototype.list.call({ ctx: fixture.ctx })
    entry.options.config.env.API_KEY = 'second-secret'
    const after = await McpManagerGateway.prototype.list.call({ ctx: fixture.ctx })

    assert.equal(after.revision, before.revision)
    assert.equal(typeof before.revealRevision, 'string')
    assert.notEqual(after.revealRevision, before.revealRevision)
    assert.doesNotMatch(JSON.stringify(after), /first-secret|second-secret/)
  } finally {
    await fixture.cleanup()
  }
})

test('tool revision changes when only the parameter schema changes', async () => {
  const { McpManagerGateway } = await import('../lib/index.js')
  const content = `- insert:\n    - id: mcp-demo\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: demo\n        transport: stdio\n        command: node\n`
  const entry = {
    options: { id: 'mcp-demo', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'demo', transport: 'stdio', command: 'node' } },
    disabled: false,
    fiber: { state: 2 },
  }
  const fixture = await createProfileFixture(content, [entry])
  let parameters = { type: 'object', properties: { before: { type: 'string' } } }
  fixture.ctx.tools.schemas = () => [{ name: 'mcp__demo__tool', description: 'same description', parameters }]

  try {
    const before = await McpManagerGateway.prototype.list.call({ ctx: fixture.ctx })
    parameters = { type: 'object', properties: { after: { type: 'number' } } }
    const after = await McpManagerGateway.prototype.list.call({ ctx: fixture.ctx })
    const tools = await McpManagerGateway.prototype.tools.call({ ctx: fixture.ctx }, { name: 'demo' })

    assert.deepEqual(tools.tools[0].parameters, parameters)
    assert.notEqual(after.servers[0].toolRevision, before.servers[0].toolRevision)
    assert.notEqual(after.revision, before.revision)
  } finally {
    await fixture.cleanup()
  }
})

test('list exposes derived status and lastError from mcp-client log records', async () => {
  const { McpManagerGateway } = await import('../lib/index.js')
  const content = `- insert:\n    - id: mcp-broken\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: broken\n        transport: streamable-http\n        url: http://127.0.0.1:8787/mcp\n    - id: mcp-ok\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: ok\n        transport: stdio\n        command: node\n`
  const logSecret = 'log-super-secret-token'
  const brokenFiber = { state: 2 }
  const broken = { options: { id: 'mcp-broken', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'broken', transport: 'streamable-http', url: 'http://127.0.0.1:8787/mcp' } }, disabled: false, fiber: brokenFiber }
  const ok = { options: { id: 'mcp-ok', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'ok', transport: 'stdio', command: 'node' } }, disabled: false, fiber: { state: 2 } }
  const fixture = await createProfileFixture(content, [broken, ok])
  let cleanupCapture
  const logger = {
    buffer: [
      { name: 'mcp-broken', type: 'warn', ts: Date.now(), args: [`connection attempt failed: ECONNREFUSED 127.0.0.1:8787 https://example.test/mcp?token=${logSecret} Authorization: Bearer ${logSecret}`], fiber: { deref: () => brokenFiber } },
      { name: 'mcp-broken', type: 'error', ts: Date.now(), args: [{ message: 'giving up after 10 consecutive failed reconnect attempts', args: ['--config', logSecret], env: { CUSTOM: logSecret } }], fiber: { deref: () => brokenFiber } },
    ],
    exporters: new Map(),
    _snExporter: 0,
  }
  fixture.ctx.root = fixture.ctx
  fixture.ctx.logger = logger
  fixture.ctx.effect = (factory, label) => {
    assert.equal(label, 'mcpManager.logCapture')
    cleanupCapture = factory()
    return cleanupCapture
  }
  fixture.ctx.tools.schemas = () => [
    { name: 'mcp__ok__search', description: '' },
  ]

  try {
    const result = await McpManagerGateway.prototype.list.call({ ctx: fixture.ctx })
    const byName = Object.fromEntries(result.servers.map((server) => [server.serverName, server]))
    assert.equal(byName.broken.status, 'failed')
    assert.match(byName.broken.lastError, /consecutive failed reconnect/)
    assert.doesNotMatch(JSON.stringify(result), new RegExp(logSecret))
    assert.equal(byName.ok.status, 'connected')
    assert.equal(byName.ok.lastError, null)
    assert.equal(logger.exporters.size, 1)
    const managerExporterId = [...logger.exporters.keys()][0]
    const foreignExporterId = ++logger._snExporter
    logger.exporters.set(foreignExporterId, { foreign: true })
    cleanupCapture()
    assert.equal(logger.exporters.has(managerExporterId), false)
    assert.equal(logger.exporters.has(foreignExporterId), true)
    await McpManagerGateway.prototype.list.call({ ctx: fixture.ctx })
    assert.equal(logger.exporters.size, 2)
  } finally {
    await fixture.cleanup()
  }
})

test('reveal returns the stored value for managed servers only', async () => {
  const { McpManagerGateway } = await import('../lib/index.js')
  const secret = 'super-secret-token'
  const content = `- insert:\n    - id: mcp-sec\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: sec\n        transport: stdio\n        command: node\n        env:\n          API_KEY: !!js process.env.TEST_MCP_SECRET\n`
  const entry = { options: { id: 'mcp-sec', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'sec', transport: 'stdio', command: 'node', env: { API_KEY: secret } } }, disabled: false, fiber: null }
  const fixture = await createProfileFixture(content, [entry])

  try {
    const revealed = await McpManagerGateway.prototype.reveal.call({ ctx: fixture.ctx }, { name: 'sec', field: 'env', key: 'API_KEY' })
    assert.equal(revealed.value, secret)
    const whole = await McpManagerGateway.prototype.reveal.call({ ctx: fixture.ctx }, { name: 'sec', field: 'env' })
    assert.deepEqual(whole.value, { API_KEY: secret })
    await assert.rejects(
      McpManagerGateway.prototype.reveal.call({ ctx: fixture.ctx }, { name: 'missing', field: 'env', key: 'API_KEY' }),
      /不能读取配置/,
    )
  } finally {
    await fixture.cleanup()
  }
})
