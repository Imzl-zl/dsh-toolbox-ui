// 发现集状态：LRU 记录（B7/B8/B9/B10）+ 会话投影 fold（C4）。
//
// 两套状态刻意分开：
//   - **运行期**状态 `{ tick, version, discovered: Map<name, tick> }` 是按 agent 的
//     （`WeakMap<agent, state>`，在 runtime 里），带 LRU 时间戳；
//   - **投影**状态 `{ discovered: string[] }` 是按 session 的、纯 JSON、有界，只用来
//     "下次恢复时播种"。它不带 lastUsed（首版不持久化，恢复后按发现顺序播种会自愈）。
// 混成一份会带来两个错：投影会跟着 agent 的 LRU 抖动（宿主按引用变化触发下游工作），
// 而运行期状态会变成"一会话多 agent 共享"。

/**
 * 搜索结果的协议标记。协议、解析器、fold 必须同时改，所以它们住在一起——
 * 三者分开写在三个文件里时，"改了一处忘另一处"是静默失败（老结果被当成新格式解析）。
 */
export const META_PROTOCOL = 'dsh-tool-search/v1'

/** 投影键。宿主按 key 注册/计数，命名跟宿主一等公民同风格（camelCase）。 */
export const PROJECTION_KEY = 'toolSearchDiscoveries'

/**
 * 新的运行期发现集状态。
 * @returns {{tick: number, version: number, discovered: Map<string, number>}}
 */
export function createState() {
  return { tick: 0, version: 0, discovered: new Map() }
}

/**
 * 恢复播种：按名字列表的顺序给 tick（最旧的在前）。只在首次接触 agent 时调用一次。
 * @param {object} state - createState() 的产物。
 * @param {Iterable<string>} names - 从旧到新的发现顺序。
 * @returns {void}
 */
export function seed(state, names) {
  for (const name of names ?? []) {
    if (typeof name !== 'string' || state.discovered.has(name)) continue
    state.discovered.set(name, ++state.tick)
  }
  if (state.discovered.size > 0) state.version += 1
}

/**
 * 记一批新的发现（B8：**发现即播种 lastUsed**，所以刚发现的一批一定排在最新端）。
 * @param {object} state - 运行期状态。
 * @param {Iterable<string>} names - 本次结果里命中的名字。
 * @returns {string[]} 真正新增的名字（已发现的不算）。
 */
export function discover(state, names) {
  const fresh = []
  for (const name of names ?? []) {
    if (typeof name !== 'string' || state.discovered.has(name)) continue
    state.discovered.set(name, ++state.tick)
    fresh.push(name)
  }
  if (fresh.length > 0) state.version += 1
  return fresh
}

/**
 * LRU 刷新：只对**已发现**的名字生效（调用点用它记录"模型真的用了这个工具"）。
 * 不推进 version——成员没变，目录文本不该失效。
 * @param {object} state - 运行期状态。
 * @param {string} name - 刚被执行的工具名。
 * @returns {void}
 */
export function touch(state, name) {
  if (!state.discovered.has(name)) return
  state.discovered.set(name, ++state.tick)
}

/**
 * 淘汰到上限（B9）：`remove = min(size − cap, max(1, floor(size / 2)))`，
 * 按 tick 从小到大取（最冷的先走）。
 *
 * 为什么不是"踢到 cap 为止"就够：cap 从 100 调到 20 时那会一次踢掉 80 个，其中包含
 * 模型还在用的。为什么不是"每次踢一半"：30 个、cap 20 时只该踢 10——「不超过一半」
 * 是上限，不是步长（DECISIONS §2.1 的修正）。
 * @param {object} state - 运行期状态。
 * @param {number} cap - 上限。
 * @returns {string[]} 被淘汰的名字（调用点不记账：淘汰是正常的上限维护，不是失败）。
 */
export function evict(state, cap) {
  const size = state.discovered.size
  if (size <= cap) return []
  const half = Math.max(1, Math.floor(size / 2))
  const remove = Math.min(size - cap, half)
  const oldest = [...state.discovered.entries()]
    .sort((left, right) => left[1] - right[1])
    .slice(0, remove)
    .map(([name]) => name)
  for (const name of oldest) state.discovered.delete(name)
  if (oldest.length > 0) state.version += 1
  return oldest
}

/** 目录文本缓存键的一部分：成员变化才变。 */
export function versionOf(state) {
  return state.version
}

/** 发现集大小。 */
export function sizeOf(state) {
  return state.discovered.size
}

/**
 * 投影状态的有界上限：`max(maxDiscovered * 4, 100)`。
 * 乘 4 是给"上限被调小"留缓冲（运行集会自己收敛，投影只做恢复种子，宁可多留一点）；
 * 下限 100 是因为太小的上限会让恢复集比运行集还小——恢复完立刻被淘汰，等于没恢复。
 * @param {number} maxDiscovered - 运行期发现集上限。
 * @returns {number}
 */
export function projectionBound(maxDiscovered) {
  return Math.max(maxDiscovered * 4, 100)
}

/**
 * 从搜索结果值里解析累积发现列表。协议不符返回 undefined（别人的工具结果，不认）。
 * @param {unknown} value - 工具结果对象。
 * @returns {string[]|undefined}
 */
export function parseDiscoveredMeta(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  if (value.protocol !== META_PROTOCOL) return undefined
  for (const key of ['allDiscoveredTools', 'discoveredTools']) {
    const list = value[key]
    if (Array.isArray(list) && list.every((item) => typeof item === 'string')) return [...list]
  }
  if (Array.isArray(value.matches)) {
    return value.matches
      .filter((match) => match !== null && typeof match === 'object' && typeof match.name === 'string' && match.found !== false)
      .map((match) => match.name)
  }
  return []
}

/**
 * 从会话派生消息还原发现集（投影缺席时的退路；PTC 下它是空操作，见 F18）。
 * 只认本工具的成功结果：扫 role==='tool' 消息里的 protocol JSON。走**受支持的**
 * `session.deriveMessages()`，而不是已废弃的 `snapshotEvents()`（F20）。
 * @param {unknown[]} messages - deriveMessages() 的产物。
 * @returns {Set<string>}
 */
export function discoveredFromMessages(messages) {
  const discovered = new Set()
  for (const message of messages ?? []) {
    if (message?.role !== 'tool' || message.isError === true) continue
    const block = Array.isArray(message.content) ? message.content[0] : undefined
    if (block?.type !== 'text' || typeof block.text !== 'string') continue
    let value
    try { value = JSON.parse(block.text) } catch { continue }
    for (const name of parseDiscoveredMeta(value) ?? []) discovered.add(name)
  }
  return discovered
}

/**
 * 从一条会话事件里抽出本工具的 JSON 结果文本。
 *
 * 两条路径都要认（F19 实测）：
 * - native：`tool/result` → `data.message.content[0].text`；
 * - PTC：程序内部派发 → `tool/ptc-dispatch`，`data.name` 是子调用名、`data.content` 是结果块。
 *   它**不是** surface 事件（`SURFACE_EVENT_TYPES` 不含它），所以 deriveMessages 看不到。
 * @param {object} event - 会话事件。
 * @param {string} toolName - 本插件的搜索工具名。
 * @returns {string|undefined}
 */
function eventText(event, toolName) {
  if (event === null || typeof event !== 'object') return undefined
  const data = event.data
  if (data === null || typeof data !== 'object') return undefined
  let blocks
  if (event.type === 'tool/result') {
    if (data.message?.isError === true) return undefined
    blocks = data.message?.content
  } else if (event.type === 'tool/ptc-dispatch') {
    if (data.name !== toolName || data.isError === true) return undefined
    blocks = data.content
  } else return undefined
  const block = Array.isArray(blocks) ? blocks[0] : undefined
  return block?.type === 'text' && typeof block.text === 'string' ? block.text : undefined
}

/**
 * 投影 apply：上一条投影状态 + 一条会话事件 → 下一条。
 *
 * 三条不变量（C4）：
 * - **恒返回状态对象**（写成 `=> undefined` 会把宿主状态设成 undefined，探针里踩过）；
 * - 没有新名字时返回**同一引用**（宿主按 `Object.is` 判变化，否则每个事件都产生下游工作）；
 * - 结果**有界**（按 `max` 从旧到新剪枝），长会话不能无限长。
 *
 * @param {{discovered: string[]}} state - 上一条投影状态。
 * @param {object} event - 会话事件。
 * @param {{toolName: string, max: number}} opts - 搜索工具名与有界上限。
 * @returns {{discovered: string[]}} 新状态或同一个引用。
 */
export function foldEvent(state, event, opts) {
  const prev = Array.isArray(state?.discovered) ? state.discovered : []
  const text = eventText(event, opts?.toolName)
  if (text === undefined) return state
  let value
  try { value = JSON.parse(text) } catch { return state }
  const names = parseDiscoveredMeta(value)
  if (names === undefined || names.length === 0) return state
  const seen = new Set(prev)
  const fresh = []
  for (const name of names) {
    if (seen.has(name)) continue
    seen.add(name)
    fresh.push(name)
  }
  if (fresh.length === 0) return state
  const merged = [...prev, ...fresh]
  const max = Number.isSafeInteger(opts?.max) && opts.max > 0 ? opts.max : merged.length
  return { discovered: merged.length > max ? merged.slice(-max) : merged }
}

/**
 * 发现集的宿主内部投影定义（`ctx.sessionProjections.register`，无 `wire` 重载）。
 *
 * @param {{z: object, toolName: string, max: number}} options - zod 命名空间、搜索工具名、有界上限。
 * @returns {object} 宿主 `ProjectionDefinition` 形状。
 */
export function discoveryProjection({ z, toolName, max }) {
  return {
    key: PROJECTION_KEY,
    // 纯 JSON：宿主按 (sessionId, key, ver, seq, val) 持久化，并在恢复时 parse 一次。
    stateSchema: z.object({ discovered: z.array(z.string()) }),
    init: () => ({ discovered: [] }),
    apply: (state, event) => foldEvent(state, event, { toolName, max }),
    // 折叠语义或字段变了才递增；变了就等于旧持久化行作废（宿主会丢弃它们）。
    stateVersion: 1,
  }
}
