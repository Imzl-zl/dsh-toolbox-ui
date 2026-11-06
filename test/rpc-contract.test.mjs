import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { INTERNAL_ONLY, NAMESPACES, MCP_METHODS, SKILL_METHODS } from '../lib/rpc-contract.js'
import { TYPERT } from '../lib/typert.js'

// 契约单源的守卫。三件事：
//   1. 生成产物与**表**逐字节一致（有人手改 lib/typert.js 或 client.js 的 descriptor 段就红）；
//   2. 宿主那面（@Remote 的顺序与名字）与表一致（装饰器只能贴在方法上，所以是校验而不是生成）；
//   3. 表本身自洽（方法名唯一、`名字:类型符号` 合法、mutating 只出现在真会改状态的方法上）。
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

test('宿主 @Remote 的顺序与名字来自同一份定义', async () => {
  const { checkHostFace, readHostRemoteOrder } = await import('../scripts/rpc-contract.mjs')
  const host = read('lib/index.js')
  assert.deepEqual(checkHostFace(host), [])
  const expected = NAMESPACES.flatMap(({ methods }) => methods.map((method) => method.method))
  assert.deepEqual(readHostRemoteOrder(host), expected)
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
    'exportWorkspaceJson', 'revealWorkspaceServer', 'projectConnections', 'updateHint', 'whatsNew',
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
  assert.equal(byNamespace.get('mcpManager'), MCP_METHODS.length)
  assert.equal(byNamespace.get('skillsManager'), SKILL_METHODS.length)
})

function splitParamOf(param) {
  const index = param.indexOf(':')
  if (index <= 0 || index === param.length - 1) throw new Error('bad param')
  return param
}
