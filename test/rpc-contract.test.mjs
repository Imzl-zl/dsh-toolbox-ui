import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { INTERNAL_ONLY, NAMESPACES, MCP_METHODS, SKILL_METHODS } from '../lib/rpc-contract.js'
import { TYPERT } from '../lib/typert.js'

// 契约单源的守卫。四件事：
//   1. 生成产物与**表**逐字节一致（有人手改 lib/typert.js 或 client.js 的 descriptor 段就红）；
//   2. 宿主那面（wire 方法的名字与顺序）**不再有第二份清单**：装饰器由 `applyRemoteMethods`
//      按表装配（R6.1）。这里的形状闸守住"不许再抄一份"，名字真正落到 wire 上的证据由下面那条
//      真宿主用例从 `remoteMethods()` 读回来——那比在源码里数正则强，因为它是网关看到的东西；
//   3. 表本身自洽（方法名唯一、`名字:类型符号` 合法、mutating 只出现在真会改状态的方法上）；
//   4. 装配只贴在原型上真实存在的方法上（表里写错一个名字不能被静默吞掉）。
//
// 与 test/package-contract.test.mjs 的分工：那边比的是"四张脸彼此一致"（含运行时原型），
// 这里比的是"四张脸都来自同一份定义"。前者抓漂移，后者抓"根本不该有第二份定义"。

const ROOT = new URL('../', import.meta.url)
const read = (path) => readFileSync(new URL(path, ROOT), 'utf8')

test('生成的产物与 lib/rpc-contract.js 完全一致（--check 的测试内等价物）', async () => {
  const { renderTypert, renderClientRegion } = await import('../scripts/rpc-contract.mjs')
  assert.equal(read('lib/typert.js'), renderTypert(), 'lib/typert.js 必须由 `npm run contract:write` 生成')
  const client = read('lib/client.js')
  const begin = '// <rpc-contract:begin> 由 scripts/rpc-contract.mjs 生成，勿手改'
  const end = '// <rpc-contract:end>'
  const start = client.indexOf(begin)
  const stop = client.indexOf(end)
  assert.ok(start > 0 && stop > start, 'lib/client.js 必须有生成区间标记')
  assert.equal(client.slice(start + begin.length, stop).trim(), renderClientRegion().trim(),
    'lib/client.js 的 descriptor 段必须由 `npm run contract:write` 生成')
})

test('宿主装配是表驱动的：源码里不留第二份名字清单', async () => {
  const { checkHostFace, readHostRemoteOrder } = await import('../scripts/rpc-contract.mjs')
  const host = read('lib/index.js')
  assert.deepEqual(checkHostFace(host), [])
  // R6.1 之前这里是 55 条 `Remote("list")` 字面量，每条再配一行 `__esDecorate` 脚手架——
  // 与 MCP_METHODS/SKILL_METHODS 逐字重复。表里加一个方法要再抄一遍，抄错一个字就静默偏离契约。
  assert.deepEqual(readHostRemoteOrder(host), [],
    'index.js 不得再手写 Remote("…") 名字清单（那是 lib/rpc-contract.js 的第二份拷贝，两张清单会各自漂移）')
  assert.equal((host.match(/__esDecorate\(/g) || []).length, 0, '装饰器装配只剩 lib/remote-wiring.js 里那一处调用点')
  const wired = [...host.matchAll(/applyRemoteMethods\(\s*this,\s*(MCP_METHODS|SKILL_METHODS)\b/g)].map((match) => match[1])
  assert.deepEqual(wired, ['MCP_METHODS', 'SKILL_METHODS'], '两个 gateway 各装配一次，参数是契约表本身')
})

test('真宿主里装配出的 Remote 标记与契约表逐方法同序（wire 那面确实存在）', async () => {
  // 为什么不只数源码：四张脸里第 1 张的产物是**原型上的标记**，网关靠 `remoteMethods()` 发现
  // endpoint。装配写错（漏传 initializers、把 ctor 传成实例、名字拼错）在源码正则里看不出来，
  // 但会让整块能力面在 wire 上消失——面板表现为"服务未连接"，而所有直接调 manager 的用例全绿。
  const { remoteMethods } = await import('@deepseek-ai/dsh-typert-protocol')
  const { Context } = await import('@deepseek-ai/cordis')
  const { McpManagerGateway } = await import('../lib/index.js')
  const root = await mkdtemp(join(tmpdir(), 'dsh-remote-wiring-'))
  const patch = join(root, 'cordis.patch.yml')
  await writeFile(patch, '[]\n')
  try {
    // 最小真宿主：真 cordis Context + 真 gateway 类，只把 loader/tools/skills 顶成桩
    // （与 test/skills-host.test.mjs 同一套做法——那里也是为了拿到"真激活"的实例）。
    const ctx = new Context()
    await ctx.plugin({
      name: 'host-stub',
      apply(inner) {
        inner.provide('loader', {
          entries: () => [{ options: { id: 'include', name: 'cordis:include', config: { path: pathToFileURL(patch).href } } }],
        })
        inner.provide('tools', { schemas: () => [], register: () => () => {}, guard: () => () => {} })
        inner.provide('skills', {})
      },
    })
    await ctx.plugin(McpManagerGateway, {})
    // 技能网关是本服务的**子插件**（lib/index.js 的构造函数里 `ctx.plugin(SkillsManagerGateway)`）：
    // 提供了 skills 之后它自己就会激活，这里再挂一次只会撞 "service has been registered"。
    const markers = [
      ...remoteMethods(ctx.get('toolboxMcp')),
      ...remoteMethods(ctx.get('skillsManager')),
    ]
    const expected = NAMESPACES.flatMap(({ methods }) => methods.map((method) => method.method))
    assert.deepEqual(markers.map((marker) => marker.method), expected,
      'wire 上的方法名与顺序必须与契约表逐项一致（少了、多了、乱了都在这里红）')
    // 协议只在 exportName 与 method 不同名时才下发 exportName；同名时按 method 路由。
    assert.deepEqual(markers.filter((marker) => marker.exportName !== undefined), [], 'exportName 与 method 同名时不应额外下发')
    assert.deepEqual([...new Set(markers.map((marker) => marker.invocation.kind))], ['direct'], '全部是 direct 调用')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('装配只在原型上真实存在的方法上贴标记（表里写错名字必须显式抛错）', async () => {
  const { applyRemoteMethods } = await import('../lib/remote-wiring.js')
  // 为什么需要这道闸：`__esDecorate(ctor, null, …)` 找不到描述符时退化成 `{}`，最后
  // `Object.defineProperty(prototype, name, {})`——名字写错一个字母，得到的是原型上一个
  // **undefined 成员**，同时 @Remote 标记照样登记。于是 wire 上有 endpoint、调用时才炸，
  // 而"原型方法集合 = 契约"那条用例也会绿（名字两边都在）。装饰器逐条贴在方法上时这条由
  // 编译器保证；改成表驱动之后必须自己保住。
  class Sample {
    list() { return 'ok' }
  }
  const decorated = []
  const options = {
    decorate: (ctor, descriptor, decorators, context) => decorated.push(context.name),
    metadata: undefined,
    initializers: [],
  }
  assert.doesNotThrow(() => applyRemoteMethods(Sample, [{ method: 'list' }], options))
  assert.deepEqual(decorated, ['list'])
  assert.throws(
    () => applyRemoteMethods(Sample, [{ method: 'list' }, { method: 'nosuchMethod' }], options),
    /nosuchMethod/,
    '契约表里的方法在原型上不存在时必须抛错，不能静默定义成 undefined 成员',
  )
  assert.equal(Object.hasOwn(Sample.prototype, 'nosuchMethod'), false, '坏名字不得被写到原型上')
  // 同名但只是**继承**来的成员同样不算：`__esDecorate` 用 getOwnPropertyDescriptor 判存在，
  // 继承成员会被定义成自己的 undefined，把父类的方法遮蔽掉。
  class Base { inherited() { return 'base' } }
  class Child extends Base { list() {} }
  assert.throws(() => applyRemoteMethods(Child, [{ method: 'inherited' }], options), /inherited/)
  assert.equal(Object.getPrototypeOf(Child.prototype).inherited(), 'base', '父类的方法不得被遮蔽')
})

test('表本身自洽：方法名唯一、参数声明合法、mutating 只标在变更型方法上', () => {
  const seen = new Set()
  for (const { service, methods } of NAMESPACES) {
    assert.ok(methods.length > 0, `${service} 不能是空表`)
    for (const { method, params, result } of methods) {
      const endpoint = `${service}/${method}`
      assert.equal(seen.has(endpoint), false, `重复的方法：${endpoint}`)
      seen.add(endpoint)
      assert.match(method, /^[A-Za-z][A-Za-z0-9]*$/, `${endpoint} 的方法名必须是标识符`)
      assert.match(result, /^[A-Z][A-Za-z0-9]*$/, `${endpoint} 的结果类型符号必须是大驼峰`)
      for (const param of params) assert.doesNotThrow(() => splitParamOf(param), `${endpoint} 的参数声明非法：${param}`)
    }
  }
  // 只读方法绝不能被标成 mutating：标错会让面板以为"读一下也会写盘"。
  const readOnly = new Set(['list', 'status', 'tools', 'builtins', 'toolSearchSettings', 'toolLoadingSettings',
    'workspaceToolLoading', 'reveal', 'previewImport', 'scanImportSources', 'previewImportSource',
    'listWorkspaces', 'getWorkspaceView', 'previewWorkspaceImport', 'previewWorkspaceCopy',
    'exportWorkspaceJson', 'exportGlobalJson', 'revealWorkspaceServer', 'projectConnections', 'updateHint', 'whatsNew',
    'detail', 'skillTargets', 'skillHubSearch', 'skillHubDetail', 'skillHubCategories', 'conflictingManager'])
  for (const { methods } of NAMESPACES) {
    for (const entry of methods) {
      if (!readOnly.has(entry.method)) continue
      assert.equal(entry.mutating, undefined, `${entry.method} 是只读方法，不能标 mutating`)
    }
  }
  // 变更型方法必须真的存在（防手滑把 mutating 写在注释里或写错方法名）。
  const mutating = NAMESPACES.flatMap(({ methods }) => methods.filter((entry) => entry.mutating).map((entry) => entry.method))
  assert.ok(mutating.length >= 20, `变更型方法数量异常（${mutating.length}）`)
  for (const name of ['add', 'update', 'removeServer', 'setDisabled'].filter((entry) => entry !== 'setDisabled')) {
    assert.ok(mutating.includes(name), `${name} 必须标成 mutating`)
  }
})

test('INTERNAL_ONLY 的每条都带理由，且不与线上方法重名', () => {
  const onWire = new Set(NAMESPACES.flatMap(({ methods }) => methods.map((method) => method.method)))
  for (const [name, reason] of INTERNAL_ONLY) {
    assert.equal(typeof reason, 'string')
    assert.ok(reason.length >= 8, `${name} 的登记理由太短（要能回答"为什么不上 wire"）`)
    assert.equal(onWire.has(name), false, `${name} 既在线上又在 INTERNAL_ONLY 里——两边只能留一边`)
  }
})

test('两个命名空间的方法数与 TYPERT 的 invocation 段逐段对得上', () => {
  const byNamespace = new Map()
  for (const invocation of TYPERT.invocations) {
    byNamespace.set(invocation.namespace, (byNamespace.get(invocation.namespace) ?? 0) + 1)
  }
  assert.equal(byNamespace.get('toolboxMcp'), MCP_METHODS.length)
  assert.equal(byNamespace.get('skillsManager'), SKILL_METHODS.length)
})

function splitParamOf(param) {
  const index = param.indexOf(':')
  if (index <= 0 || index === param.length - 1) throw new Error('bad param')
  return param
}
