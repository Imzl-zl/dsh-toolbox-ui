// issue #8 量化探针：用真实的 dsh-tools ToolRuntime.view()/schemas() 测成本。
// 只用真实的分层实现（ScopedLayers + NamedEntries）+ 真实的 view/schemas 代码路径，
// 不复制算法；层对象借用同一套 Entry 容器，admits 恒真（本插件不在此处加 restrict）。
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { AnonymousEntries, NamedEntries, ScopedLayers } from '@deepseek-ai/dsh-scope'

const GLOBAL_COUNT = 51
const SCOPED_COUNT = 207

function makeLayer() {
  return {
    tools: new NamedEntries((name) => new Error(`dup ${name}`)),
    restrictions: new AnonymousEntries(),
    guards: new AnonymousEntries(),
    mode: undefined,
    isEmpty() { return this.tools.isEmpty() && this.restrictions.isEmpty() && this.guards.isEmpty() && this.mode === undefined },
    admits() { return true },
  }
}

function makeDef(name) {
  const properties = {}
  for (let i = 0; i < 10; i += 1) {
    properties[`param_${i}`] = { type: 'string', description: `参数 ${i} 的说明文字，用来把 schema 撑到接近真实 MCP 工具的体积。` }
  }
  return { name, description: `tool ${name}`, parameters: { type: 'object', properties, required: ['param_0'] } }
}

const layers = new ScopedLayers(() => makeLayer(), () => {})
const scopeKey = Symbol('scope')
const scopedLayer = makeLayer()
layers.scoped.set(scopeKey, scopedLayer)

const globalNames = []
for (let i = 0; i < GLOBAL_COUNT; i += 1) {
  const name = `tool_global_${i}`
  globalNames.push(name)
  layers.global.tools.insert(name, makeDef(name))
}
const scopedNames = []
for (let i = 0; i < SCOPED_COUNT; i += 1) {
  const name = `mcp__example__tool_${i}`
  scopedNames.push(name)
  scopedLayer.tools.insert(name, makeDef(name))
}

const rt = Object.create(ToolRuntime.prototype)
rt.layers = layers
rt.defaultMode = 'native'
rt.maxParallelSubCalls = 10

const schemaBytes = Buffer.byteLength(JSON.stringify(rt.schemas(scopeKey)))
console.log(`工具总数=${GLOBAL_COUNT + SCOPED_COUNT}  作用域层=${SCOPED_COUNT}  schemas(scope) 序列化=${(schemaBytes / 1024).toFixed(0)} KB`)

function bench(label, fn, iterations) {
  for (let i = 0; i < Math.min(iterations, 5); i += 1) fn()
  const start = performance.now()
  for (let i = 0; i < iterations; i += 1) fn()
  const per = (performance.now() - start) / iterations
  console.log(`${label.padEnd(46)} ${per.toFixed(3)} ms/次`)
  return per
}

// 单次原语成本
const viewScoped = bench('view(scopeKey)                    ×1', () => rt.view(scopeKey), 300)
const viewGlobal = bench('view()                           ×1', () => rt.view(), 300)
const oneGet = bench('get(name, scopeKey)              ×1', () => rt.get(scopedNames[0], scopeKey), 300)
const schemasScoped = bench('schemas(scopeKey)（含深拷贝）    ×1', () => rt.schemas(scopeKey), 30)
const schemasGlobal = bench('schemas()（applyWorkspaceRestrict）', () => rt.schemas(), 30)

// 现路径：syncSessionProjectTools 的 1 次 schemas + N 次 get（sharedPrefix 时再 N 次全局 get）
function currentSync() {
  const schemas = rt.schemas(scopeKey).filter((s) => s.name.startsWith('mcp__example__'))
  let registered = 0
  for (const schema of schemas) {
    const def = rt.get(schema.name, scopeKey)
    if (def !== undefined && def === rt.get(schema.name)) continue
    registered += 1
  }
  return registered
}
// 建议路径：1 次作用域 view + 1 次全局 view，身份比较照旧
function proposedSync() {
  const scoped = rt.view(scopeKey)
  const global = rt.view()
  let registered = 0
  for (const [name, def] of scoped.visible) {
    if (!name.startsWith('mcp__example__')) continue
    if (def !== undefined && def === global.visible.get(name)) continue
    registered += 1
  }
  return registered
}

console.log('')
const cur = bench('现路径 syncSessionProjectTools（1+N+N）', currentSync, 30)
const prop = bench('建议路径（2 次 view）', proposedSync, 30)
console.log(`\n单次重算加速比 ≈ ${(cur / prop).toFixed(1)}×  节省 ≈ ${(cur - prop).toFixed(2)} ms`)

// 64 个存活会话：reconcileWorkspaceRestricts 对每个会话各跑一次 applyWorkspaceRestrict
const agents = 64
let start = performance.now()
for (let i = 0; i < agents; i += 1) rt.schemas()
const restrictBefore = performance.now() - start
start = performance.now()
for (let i = 0; i < agents; i += 1) rt.view()
const restrictAfter = performance.now() - start
console.log(`reconcileWorkspaceRestricts @ ${agents} 个存活会话：改前 ${restrictBefore.toFixed(1)} ms → 改后 ${restrictAfter.toFixed(1)} ms（每会话一次读面，不含 readWorkspaceConfig 的 stat）`)
console.log(`\n逐项核对：1 次 schemas(scope)=${schemasScoped.toFixed(2)}ms  1 次 schemas()=${schemasGlobal.toFixed(2)}ms  view(scope)=${viewScoped.toFixed(3)}ms  view()=${viewGlobal.toFixed(3)}ms  get=${oneGet.toFixed(3)}ms`)
