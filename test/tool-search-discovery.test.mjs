import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDiscoveryStore } from '../lib/tool-search-discovery.js'

const store = (options = {}) => createDiscoveryStore({ maxDiscovered: 20, restore: () => undefined, ...options })

test('发现集按 agent 隔离：共享库存/策略不等于共享已发现集合', () => {
  // 用户报告过"A 会话搜到 15 个工具，别的工作区也变了"。这是最直接的回归：
  // 同一个 store（= 同一个 root/service 实例）下，两个 agent 的发现集必须互不可见。
  const discovery = store()
  const a = { id: 'agent-a' }
  const b = { id: 'agent-b' }
  discovery.discover(a, ['mcp__srv__x', 'mcp__srv__y'])
  assert.deepEqual(discovery.snapshot(a), ['mcp__srv__x', 'mcp__srv__y'])
  assert.deepEqual(discovery.snapshot(b), [], 'B 没有搜索过，就一个都不该发现')
  assert.equal(discovery.size(b), 0)
  // B 自己搜索只影响 B
  discovery.discover(b, ['mcp__srv__z'])
  assert.deepEqual(discovery.snapshot(a), ['mcp__srv__x', 'mcp__srv__y'])
  assert.deepEqual(discovery.snapshot(b), ['mcp__srv__z'])
})

test('恢复种子只在首次接触 agent 时用一次（有序替换，不是增量叠加）', () => {
  const seeds = new Map([['a', ['old-1', 'old-2']]])
  const discovery = store({ maxDiscovered: 3, restore: (agent) => seeds.get(agent.id) })
  const agent = { id: 'a' }
  assert.deepEqual(discovery.snapshot(agent), ['old-1', 'old-2'])
  // 之后的搜索是增量提交；再次取 state 不会重新播种（否则被淘汰的名字会复活）。
  discovery.discover(agent, ['new-1'])
  assert.deepEqual(discovery.snapshot(agent), ['old-1', 'old-2', 'new-1'])
  discovery.discover(agent, ['new-2'])
  // 淘汰走显式提交（与 runtime 一致），cap 3 淘汰最旧（old-1），恢复种子不会把它带回来。
  discovery.evict(agent)
  assert.equal(discovery.size(agent), 3)
  assert.deepEqual(discovery.snapshot(agent), ['old-2', 'new-1', 'new-2'])
})

test('恢复种子受运行期上限约束（上游有界上限比 maxDiscovered 大，不能借恢复超预算）', () => {
  const discovery = store({ maxDiscovered: 2, restore: () => ['1', '2', '3', '4'] })
  assert.deepEqual(discovery.snapshot({ id: 'a' }), ['3', '4'], '保留最新的这一段')
})

test('承诺保护：刚交给模型的工具不因下一次登录式淘汰被收回，直到真的被调用', () => {
  const discovery = store({ maxDiscovered: 2 })
  const agent = { id: 'a' }
  discovery.discover(agent, ['t1'])
  discovery.claim(agent, ['t1'])
  // 直接调用一次不相关的工具都不会淘汰它；只有下一次"发现提交"才会触发收敛。
  discovery.discover(agent, ['t2'])
  discovery.claim(agent, ['t2'])
  discovery.evict(agent)
  assert.deepEqual(discovery.snapshot(agent), ['t1', 't2'], '未使用的承诺不得被淘汰')
  // 真的用了 t1：承诺兑现，LRU 也刷新，此时它才回到可淘汰池。
  discovery.touch(agent, 't1')
  discovery.discover(agent, ['t3'])
  discovery.claim(agent, ['t3'])
  discovery.evict(agent)
  assert.deepEqual(discovery.snapshot(agent), ['t2', 't3'], 't2 仍被承诺保护；t1 已兑现承诺，是最冷的那个，先被淘汰')
})

test('touch 只刷新已发现的工具：把一次性试探记成热点是错的', () => {
  const discovery = store()
  const agent = { id: 'a' }
  discovery.discover(agent, ['a', 'b'])
  discovery.touch(agent, 'ghost')
  assert.deepEqual(discovery.snapshot(agent), ['a', 'b'])
  discovery.touch(agent, 'a')
  assert.deepEqual(discovery.snapshot(agent), ['b', 'a'], 'LRU 顺序跟着使用走')
})

test('evict 的 cap 抬到本批长度：一次 select 超过上限时不得淘汰本批', () => {
  const discovery = store({ maxDiscovered: 2 })
  const agent = { id: 'a' }
  const batch = ['1', '2', '3']
  const fresh = discovery.discover(agent, batch)
  discovery.claim(agent, batch)
  discovery.evict(agent, fresh.length)
  assert.deepEqual(discovery.snapshot(agent), ['1', '2', '3'], '本批在自己的结果里必须全部可用')
  // 下一批按正常上限回落：promise 保护最近 2 个，最旧的 1 被淘汰。
  discovery.discover(agent, ['4'])
  discovery.claim(agent, ['4'])
  discovery.evict(agent, 1)
  assert.equal(discovery.size(agent), 2)
  assert.deepEqual(discovery.snapshot(agent), ['3', '4'])
})

