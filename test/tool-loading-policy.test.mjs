import assert from 'node:assert/strict'
import test from 'node:test'
import {
  REASONS,
  deferredNamesOf,
  normalizePolicyConfig,
  resolveToolLoadingPolicy,
  validatePolicyConfig,
} from '../lib/tool-loading-policy.js'

// 统一加载策略的纯决策层：不碰宿主、不读文件。
// 这组用例把"优先级链"与"保护边界"钉死——它们是整套机制唯一的事实来源，
// 目录、搜索、守卫、PTC 手册和面板全都读同一个结果。

const TOOLS = [
  { name: 'mcp__alpha__a', owner: 'alpha' },
  { name: 'mcp__alpha__b', owner: 'alpha' },
  { name: 'mcp__beta__c', owner: 'beta' },
  { name: 'read', owner: null },
  { name: 'edit', owner: null },
  { name: 'tool_search', owner: null },
]

const resolve = (input) => deferredNamesOf(resolveToolLoadingPolicy({ tools: TOOLS, ...input }))

test('legacy：保持既有行为——只有显式 defer 的服务器被延迟，非 MCP 工具一律常驻', () => {
  const deferred = resolve({ legacyDeferServers: ['alpha'] })
  assert.deepEqual([...deferred].sort(), ['mcp__alpha__a', 'mcp__alpha__b'])
  const none = resolve({})
  assert.equal(none.size, 0, '没配过 defer 时零干预（升级不改变任何现有行为）')
})

test('recommended：MCP 工具默认按需，非 MCP 工具仍常驻', () => {
  const deferred = resolve({ policy: { mode: 'recommended' } })
  assert.deepEqual([...deferred].sort(), ['mcp__alpha__a', 'mcp__alpha__b', 'mcp__beta__c'])
  assert.equal(deferred.has('read'), false, '非 MCP 工具来源不可证明，默认常驻（不猜）')
})

test('all-resident：整体关掉延迟，连老 defer 也不再生效', () => {
  const deferred = resolve({ policy: { mode: 'all-resident' }, legacyDeferServers: ['alpha'] })
  assert.equal(deferred.size, 0)
})

test('逐工具覆盖压过组与模式（全局与项目各一层，项目优先）', () => {
  const global = resolve({ policy: { mode: 'recommended', tools: { 'mcp__alpha__b': 'resident' } } })
  assert.equal(global.has('mcp__alpha__b'), false, '全局逐工具把它改回常驻')
  assert.equal(global.has('mcp__alpha__a'), true, '同服务器的其它工具仍按模式延迟')

  const project = resolve({
    policy: { mode: 'recommended', tools: { 'mcp__alpha__b': 'resident' } },
    projectPolicy: { tools: { 'mcp__alpha__b': 'deferred' } },
  })
  assert.equal(project.has('mcp__alpha__b'), true, '项目覆盖压过全局覆盖')

  const userBuiltin = resolve({ policy: { mode: 'recommended', tools: { edit: 'deferred' } } })
  assert.equal(userBuiltin.has('edit'), true, '非 MCP 工具默认常驻，但显式逐工具覆盖可把它改为延迟')
})

test('项目没有自己的方案时跟随全局（legacy 不是"覆盖成旧行为"）', () => {
  // 项目文件的读侧归一永远给出 `mode: legacy`。若把它当成显式覆盖，全局选了"推荐"，
  // 项目会话里却仍然按旧行为跑——用户会看到"全局开了、项目里没生效"。
  const deferred = resolve({
    policy: { mode: 'recommended' },
    projectPolicy: { mode: 'legacy' },
  })
  assert.deepEqual([...deferred].sort(), ['mcp__alpha__a', 'mcp__alpha__b', 'mcp__beta__c'])
})

test('组级覆盖先于模式与既有 defer', () => {
  const deferred = resolve({ policy: { mode: 'recommended', groups: { alpha: 'resident' } } })
  assert.deepEqual([...deferred].sort(), ['mcp__beta__c'])
  const legacy = resolve({ legacyDeferServers: ['alpha'], projectPolicy: { groups: { alpha: 'resident' } } })
  assert.equal(legacy.size, 0, '项目组覆盖压过老 defer')
})

test('非 MCP 工具默认常驻；只有显式设为可搜索才延迟', () => {
  const plain = resolveToolLoadingPolicy({ tools: TOOLS, policy: {} })
  assert.equal(plain.entries.get('read').policy, 'resident')
  assert.equal(plain.entries.get('read').reason, REASONS.DEFAULT_RESIDENT)

  const chosen = resolveToolLoadingPolicy({ tools: TOOLS, policy: { tools: { read: 'deferred' } } })
  assert.equal(chosen.entries.get('read').policy, 'deferred', '逐个点成"可搜索"才生效')
  assert.equal(chosen.entries.get('edit').policy, 'resident', '没点的保持常驻')
})

test('服务器芯片的三态：true=延迟、false=明确常驻、缺席=跟随', () => {
  const withTrue = resolveToolLoadingPolicy({ tools: TOOLS, legacyDeferServers: ['alpha'] })
  assert.equal(withTrue.entries.get('mcp__alpha__a').policy, 'deferred')
  assert.equal(withTrue.entries.get('mcp__alpha__a').reason, REASONS.LEGACY_DEFER)

  const withFalse = resolveToolLoadingPolicy({ tools: TOOLS, legacyResidentServers: ['alpha'] })
  assert.equal(withFalse.entries.get('mcp__alpha__a').policy, 'resident')
  assert.equal(withFalse.entries.get('mcp__alpha__a').reason, REASONS.LEGACY_RESIDENT)

  // 明确"全量"必须压过整体方案：否则点芯片像没反应。
  const beatsMode = resolveToolLoadingPolicy({ tools: TOOLS, policy: { mode: 'recommended' }, legacyResidentServers: ['alpha'] })
  assert.equal(beatsMode.entries.get('mcp__alpha__a').policy, 'resident')
})

test('保护名单优先于任何用户设置（搜索入口不能被自己藏掉）', () => {
  const resolution = resolveToolLoadingPolicy({
    tools: TOOLS,
    policy: { mode: 'recommended', tools: { tool_search: 'deferred' } },
    projectPolicy: { tools: { tool_search: 'deferred' } },
    protectedNames: ['tool_search'],
  })
  assert.equal(resolution.entries.get('tool_search').policy, 'resident')
  assert.equal(resolution.entries.get('tool_search').reason, REASONS.PROTECTED)
})

test('每个决策都带可解释的理由码（面板据此回答"为什么")', () => {
  const resolution = resolveToolLoadingPolicy({
    tools: TOOLS,
    policy: { mode: 'recommended', tools: { read: 'deferred' } },
    projectPolicy: { groups: { beta: 'resident' } },
    legacyDeferServers: ['alpha'],
  })
  assert.equal(resolution.entries.get('mcp__alpha__a').reason, REASONS.LEGACY_DEFER)
  assert.equal(resolution.entries.get('mcp__beta__c').reason, REASONS.PROJECT_GROUP)
  assert.equal(resolution.entries.get('read').reason, REASONS.GLOBAL_TOOL)
  assert.equal(resolution.entries.get('edit').reason, REASONS.DEFAULT_RESIDENT)
})

test('normalizePolicyConfig：坏文件读成可变状态，而不是让整页打不开', () => {
  assert.deepEqual(normalizePolicyConfig(undefined), { mode: 'legacy', groups: {}, tools: {} })
  assert.deepEqual(normalizePolicyConfig('nope'), { mode: 'legacy', groups: {}, tools: {} })
  assert.deepEqual(
    normalizePolicyConfig({ mode: 'bogus', groups: { a: 'deferred', b: 'nope' }, tools: [] }),
    { mode: 'legacy', groups: { a: 'deferred' }, tools: {} },
  )
})

test('validatePolicyConfig：写侧严格拒绝未知键、非法取值与 legacy', () => {
  assert.deepEqual(validatePolicyConfig({ mode: 'recommended' }), { mode: 'recommended', groups: {}, tools: {} })

  // manageBuiltin 是从未生效过的死字段：写侧现在明确拒绝（不是静默忽略）
  assert.throws(() => validatePolicyConfig({ mode: 'recommended', manageBuiltin: true }), /manageBuiltin/)
  assert.throws(() => validatePolicyConfig({ mode: 'legacy' }), /mode/)
  assert.throws(() => validatePolicyConfig({ mode: 'recommended', mode2: 'x' }), /mode2/)
  assert.throws(() => validatePolicyConfig({ mode: 'recommended', groups: { a: 'inherit' } }), /groups\.a/)
  assert.throws(() => validatePolicyConfig({ mode: 'recommended', tools: { '': 'resident' } }), /空名字/)
  assert.throws(() => validatePolicyConfig(null), /对象/)
})

test('总开关 off：所有策略路径统一常驻，且**不删偏好**', () => {
  // DSH_MCP_TOOL_SEARCH=off 是排障出口：它必须压过全局/项目/旧 defer/逐工具覆盖，
  // 否则"关掉之后仍有工具被藏"——那会让人以为开关坏了。同时它绝不修改配置对象本身。
  const policy = { mode: 'recommended', groups: { beta: 'deferred' }, tools: { 'mcp__alpha__b': 'deferred' } }
  const projectPolicy = { mode: 'recommended', tools: { 'mcp__alpha__a': 'deferred' } }
  const snapshot = JSON.stringify({ policy, projectPolicy })
  const on = resolveToolLoadingPolicy({
    tools: TOOLS,
    policy,
    projectPolicy,
    legacyDeferServers: ['alpha'],
    masterSwitch: 'on',
  })
  assert.ok(deferredNamesOf(on).size > 0, '开关开着时策略照常生效')

  const off = resolveToolLoadingPolicy({
    tools: TOOLS,
    policy,
    projectPolicy,
    legacyDeferServers: ['alpha'],
    protectedNames: ['tool_search'],
    masterSwitch: 'off',
  })
  assert.equal(deferredNamesOf(off).size, 0, 'off 时一个工具都不能被延迟')
  // 理由要能说清"为什么它是常驻"：不是"默认常驻"，是总开关。
  assert.equal(off.entries.get('mcp__alpha__b').reason, REASONS.MASTER_SWITCH)
  assert.equal(off.entries.get('tool_search').reason, REASONS.PROTECTED, '保护项仍是保护项（理由更靠前）')
  assert.equal(JSON.stringify({ policy, projectPolicy }), snapshot, '关掉展示优化不得改配置一个字')
})
