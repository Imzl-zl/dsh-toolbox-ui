// 自定义分组的数据层：读侧宽容、写侧严格、成员唯一。
//
// 为什么值得单测：这三条规则一旦漂移，表现分别是——坏文件让面板打不开（读侧太严）、
// 写坏值落盘后没人读（写侧太松）、同一个工具被两个组管（成员不唯一）。
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  customGroupList,
  groupMembershipOf,
  normalizeCustomGroups,
  validateCustomGroups,
} from '../lib/tool-grouping.js'

test('normalize：合法分组原样保留，策略可省略', () => {
  const { groups, diagnostics } = normalizeCustomGroups({
    表格工具: { policy: 'deferred', tools: ['xlsx_read', 'xlsx_write'] },
    网页: { tools: ['web_fetch'] },
  })
  assert.deepEqual(groups, {
    表格工具: { policy: 'deferred', tools: ['xlsx_read', 'xlsx_write'] },
    网页: { tools: ['web_fetch'] },
  })
  assert.deepEqual(diagnostics, [], '合法配置不该产生诊断')
})

test('normalize：坏输入不抛错，按"没配"或"丢这一条"处理并留下诊断', () => {
  assert.deepEqual(normalizeCustomGroups(undefined), { groups: {}, diagnostics: [] })
  assert.deepEqual(normalizeCustomGroups('nope').groups, {})
  assert.equal(normalizeCustomGroups('nope').diagnostics[0].code, 'not-object')

  const { groups, diagnostics } = normalizeCustomGroups({
    '  ': { tools: ['a'] },
    坏策略: { policy: 'maybe', tools: ['b'] },
    坏成员: { tools: 'c' },
    有未知键: { policy: 'resident', typo: true, tools: ['d'] },
    含空名: { tools: ['', 'e', 'e'] },
  })
  assert.equal(Object.hasOwn(groups, '  '), false, '空组名丢弃')
  assert.deepEqual(groups['坏策略'], { tools: ['b'] }, '坏 policy 丢字段、不丢整组')
  assert.equal(Object.hasOwn(groups, '坏成员'), false, 'tools 不是数组时整组丢弃')
  assert.deepEqual(groups['有未知键'], { policy: 'resident', tools: ['d'] }, '未知键只记诊断')
  assert.deepEqual(groups['含空名'], { tools: ['e'] }, '空名丢弃、组内重复去重')
  const codes = diagnostics.map((item) => item.code)
  for (const code of ['empty-name', 'bad-policy', 'bad-tools', 'unknown-key', 'bad-tool', 'duplicate-in-group']) {
    assert.ok(codes.includes(code), `缺少诊断 ${code}`)
  }
})

test('normalize：同一工具跨组时先出现的胜，并留诊断', () => {
  const { groups, diagnostics } = normalizeCustomGroups({
    A: { policy: 'deferred', tools: ['read', 'edit'] },
    B: { policy: 'resident', tools: ['read'] },
  })
  assert.deepEqual(groups.A.tools, ['read', 'edit'])
  assert.deepEqual(groups.B.tools, [], '后出现的组保留，但重复成员被移除')
  assert.ok(diagnostics.some((item) => item.code === 'duplicate-across-groups'))
  assert.equal(groupMembershipOf(groups).get('read'), 'A')
})

test('validate：写侧严格拒绝，不静默过滤', () => {
  assert.deepEqual(validateCustomGroups({ A: { policy: 'deferred', tools: ['x'] } }), {
    A: { policy: 'deferred', tools: ['x'] },
  })
  assert.deepEqual(validateCustomGroups({}), {})
  assert.throws(() => validateCustomGroups(null), /对象/)
  assert.throws(() => validateCustomGroups({ '': { tools: ['x'] } }), /不能为空/)
  assert.throws(() => validateCustomGroups({ A: { tools: ['x'], typo: 1 } }), /未知字段/)
  assert.throws(() => validateCustomGroups({ A: { policy: 'inherit', tools: [] } }), /policy/)
  assert.throws(() => validateCustomGroups({ A: { tools: 'x' } }), /数组/)
  assert.throws(() => validateCustomGroups({ A: { tools: [''] } }), /空的工具名/)
  assert.throws(() => validateCustomGroups({ A: { tools: ['x', 'x'] } }), /出现两次/)
  assert.throws(() => validateCustomGroups({ A: { tools: ['x'] }, B: { tools: ['x'] } }), /已在分组「A」中/)
})

test('validate：组名与成员去掉首尾空白，落盘不留两种写法', () => {
  assert.deepEqual(validateCustomGroups({ ' A ': { tools: [' x '] } }), { A: { tools: ['x'] } })
  // trim 后重名 = 重名：否则盘上会出现两个看起来一样的组
  assert.throws(() => validateCustomGroups({ A: { tools: ['x'] }, ' A ': { tools: ['y'] } }), /重复/)
})

test('groupMembershipOf / customGroupList：同一份事实的两种读法', () => {
  const groups = { A: { policy: 'deferred', tools: ['x', 'y'] }, B: { tools: ['z'] } }
  const membership = groupMembershipOf(groups)
  assert.deepEqual([...membership.entries()].sort(), [['x', 'A'], ['y', 'A'], ['z', 'B']])
  assert.deepEqual(customGroupList(groups), [
    { name: 'A', tools: ['x', 'y'] },
    { name: 'B', tools: ['z'] },
  ])
  assert.deepEqual(groupMembershipOf(undefined).size, 0, '没有分组时不能抛错')
})
