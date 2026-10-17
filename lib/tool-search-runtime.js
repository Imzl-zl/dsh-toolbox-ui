// MCP ToolSearch 运行时：遮罩、守卫、搜索工具、状态恢复。
//
// 机制采用参考实现（lordqyxz/dsh-tool-search）验证过的架构，按本插件定位改造：
//   - 遮罩做在 `system-prompt/assemble` waterfall：过滤 `resolved.tools`，全局族与项目族
//     （scoped 注册）通吃，且每次组装都过滤——晚连服务器的工具在首次出现的那次组装里就被滤掉，
//     不存在"先放行后补遮罩"的窗口（设计文档决策 8）。
//   - 自愈走 `tools.guard`：工具不 restrict（保持可解析），守卫对"未发现的延迟工具"返回带指引的
//     拒绝。guard 能触发正因工具没被 restrict——dsh-tools 的 prepareExecution 在
//     dispatchToolBody 抛 UNKNOWN_TOOL **之前**就跑 guardReason（:3241 vs :3307），
//     所以遮罩掉的工具同样能拿到带指引的拒绝。
//   - 延迟粒度是**按服务器**（deferServers），不是参考实现的"全延迟 + alwaysVisible 白名单"：
//     未列入 defer 的服务器工具天然稳定，不需要维护一份内置工具白名单，也与本插件的
//     per-server UI 开关一一对应（设计文档 §3.3 策略决策 B）。
//   - 恢复走派生消息：搜索结果带累积发现列表（protocol: dsh-tool-search/v1），render 时剥掉
//     不泄露进提示词；重建的 agent 从 `session.deriveMessages()` 还原。
//
// 本文件分两层：导出的是**纯决策函数**（不碰 DSH 服务，可单测）；installToolSearchRuntime 是
// 一层薄装配（register/guard/on），用夹具按宿主契约测。
//
// 结构：所有派生状态（managed 划分、目录、目录正文、遮罩集、阈值判定）都挂在**一个按
// revision 缓存的视图对象**上。三个调用点（assemble / guard / execute）只做"取视图 + 做自己
// 那一件事"，取视图包在同一个 fail-open 边界里。这样就不需要 agent/created 预热、
// tools/change 脏标记、agent/disposed 清理这三个订阅——视图按 revision 自愈，标志是要人
// 记得置的，漏置就是静默失配。

import { applyStem, buildCatalog, searchCatalog } from './tool-search-index.js'
import { revisionOf } from './mcp-registry.js'
import { chooseToolName, probeHost } from './tool-search-host.js'

/**
 * `tool_search` 的备选名（确定性顺序）：只在首选名已被别人占用时才用到（G4）。
 * 顺序是固定的而不是随机的——换名会出现在守卫指引与目录文案里，模型要能稳定记住它。
 */
const TOOL_NAME_CANDIDATES = ['deferred_tool_search', 'mcp_tool_search']

/** 配置缺省。阈值语义照抄 Claude Code 指南与参考实现：可延迟工具太少时不值得延迟。 */
export const DEFAULTS = Object.freeze({
  toolName: 'tool_search',
  /** 聚合阈值：本会话可延迟工具数达到它才启用整套机制。 */
  threshold: 15,
  /** per-server 下限：工具数不超过它的服务器整体不延迟（官方 "<10 tools less beneficial"）。 */
  minServerTools: 10,
  /**
   * 一次搜索返回的最大工具数。**10 而不是 5**：关键词排序对"抽象概念 → 具体工具名"的
   * 映射有天花板（BM25 只做词面匹配，bridging 不了 declared→declaration、
   * function→symbol 这类派生与同义关系），所以相关工具常散落在 4–10 名。实测两个真实
   * MCP 工具集（serena 28 工具 / chrome-devtools 32 工具）：top5 漏掉 serena 33% 的
   * 核心工具，top10 把它拉到 100%，而 chrome-devtools 两种限额都本就 100%——
   * 即抬高限额只在不漏的场合多花约 570 token，换来难查的服务器不再漏。
   * 别照抄"一次返回上百个 schema 没有意义"那条顾虑放到 10 上：那是针对全量枚举，
   * 而枚举该走目录 section 或 `select:`（那里本来就返回请求的全部名字）。
   */
  maxResults: 10,
  maxDiscovered: 20,
  /** 目录 section 最多列多少个名字；超出部分提示模型改用关键词/select: 查询。 */
  maxCatalogLines: 300,
  descriptionChars: 110,
  /**
   * 单复数归一（s-stemmer）。默认开：两个真实 MCP 工具集实测零误伤，且在最难的
   * 工具集（serena）上把核心工具进 top5 从 67% 提到 78%、top10 从 94% 到 100%；
   * chrome-devtools 上无变化（工具名即查询词，本来就能命中）。
   * 留成开关是因为 Harman 1991 证明 stemming 在某些语料上无提升——那种场景可以关掉。
   * 注意查询侧与文档侧必须同一个值（searchCatalog/buildCatalog 都从 config 取）。
   */
  stem: true,
  requireDiscovery: true,
})

export function resolveRuntimeConfig(config = {}) {
  const toolName = typeof config.toolName === 'string' && config.toolName.trim() !== ''
    ? config.toolName.trim()
    : DEFAULTS.toolName
  const maxResults = positiveInt(config.maxResults, DEFAULTS.maxResults, 'maxResults')
  // deferServers/serverNames 接受**函数**（活配置：每次视图重建重新读，配置改了不用重装）
  // 或可迭代对象（测试与静态配置）。函数形态不在这里校验——来源是本插件自己的配置桥。
  const deferServersOf = typeof config.deferServers === 'function' ? config.deferServers : () => [...(config.deferServers ?? [])]
  const serverNamesOf = typeof config.serverNames === 'function' ? config.serverNames : () => [...(config.serverNames ?? [])]
  return {
    toolName,
    deferServersOf,
    serverNamesOf,
    threshold: positiveInt(config.threshold, DEFAULTS.threshold, 'threshold'),
    minServerTools: positiveInt(config.minServerTools, DEFAULTS.minServerTools, 'minServerTools'),
    maxResults,
    // 累积发现集的上限：它决定"有多少份 schema 长期常驻请求"，不设会随长会话长回全量基线。
    // 注意它**不是**一次搜索能返回多少名字的上限——关键词形态受 maxResults 管，而 `select:`
    // 形态按目录 section 的指引按名字取，一次能返回请求的全部名字，可以超过这个数。
    // 所以淘汰必须避开**本次刚返回的**那批（execute 里把下限抬到本批长度），否则模型刚拿到
    // "按名字直接调"的指令与完整 schema，下一次调用就被守卫拒——本期修掉的正是这个自相矛盾。
    maxDiscovered: Math.max(maxResults, positiveInt(config.maxDiscovered, DEFAULTS.maxDiscovered, 'maxDiscovered')),
    maxCatalogLines: positiveInt(config.maxCatalogLines, DEFAULTS.maxCatalogLines, 'maxCatalogLines'),
    descriptionChars: positiveInt(config.descriptionChars, DEFAULTS.descriptionChars, 'descriptionChars'),
    // 布尔不走 positiveInt：显式 false 必须能关掉词干化（上面 DEFAULTS.stem 的取舍）。
    stem: typeof config.stem === 'boolean' ? config.stem : DEFAULTS.stem,
    requireDiscovery: config.requireDiscovery ?? DEFAULTS.requireDiscovery,
  }
}

function positiveInt(value, fallback, path) {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${path} must be a safe integer >= 1`)
  return value
}

/**
 * 工具名归属判定：前缀命中且**唯一**。serverName 含 `__` 时裸前缀匹配会误伤
 * （mcp__a__b__x 同时像 a 和 a__b 的工具），所以必须要求唯一 owner——与
 * mcp-registry.toolInventory / workspace-runtime.applyWorkspaceRestrict 同一条规则。
 */
export function uniqueOwner(schemaName, serverNames) {
  let owner = null
  for (const server of serverNames) {
    if (!schemaName.startsWith(`mcp__${server}__`)) continue
    if (owner !== null) return null
    owner = server
  }
  return owner
}

/**
 * 把会话可见的 schema 分成"被本机制管理（可延迟）"与"稳定（永可见）"两部分。
 * 搜索工具自身永远稳定——它不能被自己延迟掉。
 * 入参 serverNames / deferServers 是 Set（由调用方从活配置物化）。
 */
export function partitionSchemas(schemas, { toolName, serverNames, deferServers }) {
  const managed = new Map()
  const stable = new Set()
  const ownerOf = new Map()
  for (const schema of schemas ?? []) {
    if (!schema || typeof schema.name !== 'string') continue
    if (schema.name === toolName) {
      stable.add(schema.name)
      continue
    }
    const owner = uniqueOwner(schema.name, serverNames)
    if (owner !== null) {
      ownerOf.set(schema.name, owner)
      if (deferServers.has(owner)) managed.set(schema.name, schema)
      else stable.add(schema.name)
    } else stable.add(schema.name)
  }
  return { managed, stable, ownerOf }
}

/**
 * per-server 下限：工具数不超过 minTools 的服务器整体不延迟。官方原话是 <10 工具
 * "less beneficial"——每轮必付一次搜索往返，纯赔。这是**服务器属性**判定，与聚合阈值正交。
 */
export function applyServerFloor(managed, ownerOf, minTools) {
  const counts = new Map()
  for (const name of managed.keys()) {
    const owner = ownerOf.get(name)
    if (owner === undefined) continue
    counts.set(owner, (counts.get(owner) ?? 0) + 1)
  }
  const kept = new Map()
  const droppedServers = new Set()
  for (const [name, schema] of managed) {
    const owner = ownerOf.get(name)
    if (owner === undefined || (counts.get(owner) ?? 0) > minTools) kept.set(name, schema)
    else droppedServers.add(owner)
  }
  return { managed: kept, droppedServers }
}

/**
 * 过滤 assembly 的工具列表：**只摘本机制管理的**（被延迟且未发现），其余一概不动。
 * 刻意不用"稳定集+已发现"的白名单——assembly 里可能有非本注册表来源的工具
 * （其他插件的 toolProvider 等），白名单会把它们误删。per-server 延迟的语义是
 * "只延迟这些服务器的工具，对别的工具没有意见"，黑名单正是这个语义。
 */
export function filterManagedTools(tools, managed, discovered) {
  return (tools ?? []).filter((tool) => !managed.has(tool.name) || discovered.has(tool.name))
}

/**
 * 守卫决策：返回拒绝原因（字符串）或放行（undefined）。
 * 只管"本机制管理的、未发现的"工具；其他策略（如 workspace exclude）拒掉的工具不在
 * managed 里，守卫不置词——取交集，绝不放宽（设计文档决策 8 附带属性）。
 */
export function guardDecision(name, { managed, discovered }, config) {
  if (name === config.toolName) return undefined
  if (!config.requireDiscovery) return undefined
  if (!managed.has(name)) return undefined
  if (discovered.has(name)) return undefined
  return `tool ${JSON.stringify(name)} is deferred; call ${config.toolName} with the exact name ${JSON.stringify(name)} as the query to load its schema, then call it directly`
}

/**
 * 淘汰最旧的发现直到满足上限。Set 迭代序即插入序，最新的（含本次搜索刚返回的）存活。
 * 返回被淘汰的名字数（当前无消费者：调用点刻意不记账——淘汰是正常的上限维护，不是失败）。
 */
export function clampDiscovered(discovered, cap) {
  let evicted = 0
  for (const name of discovered) {
    if (discovered.size <= cap) return evicted
    discovered.delete(name)
    evicted += 1
  }
  return evicted
}

const META_PROTOCOL = 'dsh-tool-search/v1'

/** 从搜索结果值里解析累积发现列表。协议不符返回 undefined（别人的工具结果，不认）。 */
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
 * 从会话派生消息还原发现集（resume 用）。只认本工具的成功结果：扫 role==='tool' 消息里
 * 的 protocol JSON。走**受支持的** `session.deriveMessages()`，而不是已废弃的
 * `snapshotEvents()`——后者在 dsh-session 上标注 "new calls are prohibited"，且需要自己
 * 做 tool/call↔tool/result 配对与 ptc-dispatch 特例；派生消息里 render 的文本本就带
 * protocol 与 discoveredTools，一条扫描就够（已用真 Session 验证两条路径等价）。
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

/** 视图 revision：工具可见面内容 + 全部影响划分的配置。变了才重建，否则复用缓存。 */
export function viewRevision(schemas, config) {
  return revisionOf({
    toolName: config.toolName,
    tools: (schemas ?? []).map((schema) => [schema?.name, schema?.description, schema?.parameters ?? null]),
    defer: [...config.deferServersOf()].sort(),
    servers: [...config.serverNamesOf()].sort(),
    threshold: config.threshold,
    minServerTools: config.minServerTools,
    maxCatalogLines: config.maxCatalogLines,
    descriptionChars: config.descriptionChars,
    // stem 进 revision：开关翻转要能让缓存失效、视图重建，否则改了不生效。
    stem: config.stem,
  })
}

/**
 * 构建一次视图。纯函数：同样输入同样输出，所以可以按 revision 放心缓存。
 * maskedSections 是"还有未发现工具的服务器"——它的指令段在模型看得见那些工具之前不该占上下文。
 */
export function buildToolSearchView(schemas, config) {
  const sets = {
    toolName: config.toolName,
    serverNames: new Set(config.serverNamesOf()),
    deferServers: new Set(config.deferServersOf()),
  }
  const { managed: all, ownerOf } = partitionSchemas(schemas, sets)
  const { managed } = applyServerFloor(all, ownerOf, config.minServerTools)
  const catalog = buildCatalog([...managed.values()], config.stem)
  const { text, truncated } = catalogSectionText(catalog, config)
  const managedByServer = new Map()
  for (const name of managed.keys()) {
    const owner = ownerOf.get(name)
    if (owner === undefined) continue
    if (!managedByServer.has(owner)) managedByServer.set(owner, new Set())
    managedByServer.get(owner).add(name)
  }
  return {
    managed,
    ownerOf,
    catalog,
    catalogText: text,
    catalogTruncated: truncated,
    managedByServer,
    deferring: managed.size >= config.threshold,
  }
}

/**
 * 还有未发现工具的服务器——它们的 `mcp:<server>` 指令段要被遮掉。
 * 返回 section 名（不是服务器名），调用方直接喂给 maskInstructionSections。
 */
export function activeMaskedServers(view, discovered) {
  const masked = new Set()
  for (const [server, names] of view.managedByServer) {
    for (const name of names) {
      if (!discovered.has(name)) { masked.add(`mcp:${server}`); break }
    }
  }
  return masked
}

/**
 * 清空被延迟服务器的指令段。**返回新对象**：assembly 的段对象可能被别处共享，
 * mutate 会把改动泄漏到其他消费者。只动 text，name/order 原样带走。
 */
export function maskInstructionSections(sections, maskedServers) {
  if (maskedServers.size === 0) return sections
  return (sections ?? []).map((section) => (
    section?.name !== undefined && maskedServers.has(section.name) ? { ...section, text: '' } : section
  ))
}

/**
 * 没有东西被延迟时清空静态引导段。**返回新对象**（理由同 maskInstructionSections）；
 * 段里没有它时原样返回——"没事情可做就不碰 assembly"是本文件既有惯例
 * （maskInstructionSections 的 size===0 早退同此），调用方因此能保持零干预。
 */
export function maskGuidanceSection(sections) {
  if (!(sections ?? []).some((section) => section?.name === GUIDANCE_SECTION_NAME)) return sections
  return sections.map((section) => (
    section?.name === GUIDANCE_SECTION_NAME ? { ...section, text: '' } : section
  ))
}

/** 目录 section 的正文：每工具一行"名字 — 截断目的"，按 code-unit 名序（字节稳定，利于缓存）。 */
function catalogSectionLines(catalog, config) {
  const all = [...catalog.values()].sort((left, right) => compareNames(left.name, right.name))
  const limit = config.maxCatalogLines
  const lines = all.slice(0, limit).map((tool) => {
    const description = tool.description.replace(/\s+/g, ' ').trim()
    const truncated = description.length > config.descriptionChars
      ? description.slice(0, config.descriptionChars - 1) + '…'
      : description
    return `- ${tool.name} — ${truncated}`
  })
  return { lines, truncated: Math.max(0, all.length - limit) }
}

/** Code-unit 名字比较——与区域无关，同一输入在任何机器上给出同一顺序（同宿主 compareToolNames）。 */
function compareNames(a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

export function catalogSectionText(catalog, config) {
  const { lines, truncated } = catalogSectionLines(catalog, config)
  const body = [
    '## Deferred tool catalog',
    '',
    `The tools below stay deferred: only their names and purposes are listed here; their full parameter schemas are not loaded. When one fits the task, call ${config.toolName} with a capability query — it returns the most relevant tools with complete schemas — then call the chosen tool directly by its exact name.`,
    '',
    ...lines,
  ]
  if (truncated > 0) {
    body.push('', `(${truncated} more deferred tools are not listed here. Search with capability keywords, or use "select:<exact name>" once you know the name.)`)
  }
  return { text: body.join('\n'), truncated }
}

/**
 * 提示词 section：第三方文本（MCP 描述）绝不被插值，否则一个 {{var}} 就让每步组装抛错。
 * `order` 只有走 `systemPrompt.section()` 注册时才需要（那个入口要求有限数）；
 * 在 assemble waterfall 里直接追加的 section 不需要。
 */
const GUIDANCE_SECTION_ORDER = 140
/** 静态引导段的段名。组装层要按名字把它摘掉，所以提成常量（两处共用）。 */
const GUIDANCE_SECTION_NAME = 'tool-search:guidance'

function promptSection(name, text, order) {
  return order === undefined ? { name, text, interpolate: false } : { name, text, interpolate: false, order }
}

/** 搜索工具的结果 schema：宽松对象，具体形状由 execute 决定（render 只做文本投影）。 */
const RESULT_SCHEMA = { type: 'object', additionalProperties: true }

/**
 * 视图算不出来时的零干预视图：回到 feature 前的全量可见行为。
 * **每次新造一份**而不是共享单例——它的集合若被将来某处误改，共享单例会把这个改动
 * 泄漏给所有 agent；新造一份让"视图是只读派生状态"这条不变量有结构性保证。
 */
function inertView() {
  return {
    managed: new Map(),
    ownerOf: new Map(),
    catalog: new Map(),
    catalogText: '',
    catalogTruncated: 0,
    managedByServer: new Map(),
    deferring: false,
  }
}

/**
 * 装配到宿主。返回 cleanup。ctx 契约：tools（register/guard/schemas）、on、effect、logger?。
 * agent 契约：agent.ctx.tools.schemas(agent)、agent.session.deriveMessages()。
 */
export function installToolSearchRuntime(ctx, config = {}) {
  // 硬校验（同 installAgentRuntime 对 ctx.on 的风格）：tools 服务的 register/guard 是本功能的
  // 地基，缺任何一样都不是"降级运行"能表达的——装一半比不装更坏。真实宿主恒提供二者
  // （dsh-tools 服务契约）；缺了即是宿主契约破坏，立刻炸掉好过日志沉底。
  if (typeof ctx.tools?.register !== 'function' || typeof ctx.tools?.guard !== 'function') {
    throw new Error('tool-search: 宿主 tools 服务不完整（缺 register/guard），无法装配')
  }
  const resolved = resolveRuntimeConfig(config)
  // 宿主能力探测：装一次，之后不再探测。缺项只记一次日志（warnOnce），不抛错——
  // 那是"少了优化"，不是"装不上"。结果从 S4 起进入装配路径。
  probeHost(ctx)
  // 重名预检（G4）：宿主的 NamedEntries.insert 对重名直接抛错，而这是构造函数里的同步
  // 路径——一个同名工具就会让整个 mcp-manager 装不上。换名 + 日志，好过装不上。
  const chosen = chooseToolName(ctx.tools, resolved.toolName, TOOL_NAME_CANDIDATES, { ctx })
  // toolName 参与视图划分（搜索工具自身永远稳定）与全部对外文案，换名后必须整体用它。
  // resolved 是 resolveRuntimeConfig 刚造出的局部对象，此处改写一个字段是与"换名"这件事
  // 最直接的表达——再拷贝一份反而会造出两个 toolName。
  if (chosen.renamed) resolved.toolName = chosen.name
  // per-agent 状态只剩"发现集"——它和视图正交，不该混在视图里。
  const discoveredStates = new WeakMap()
  // per-agent 视图缓存：revision 不变就复用。revision 由视图自己的输入算出来，
  // 所以不需要任何"脏标记"订阅——漏置标志导致静默不遮这一类失配不可能发生。
  const viewCache = new WeakMap()

  const stateFor = (agent) => {
    let state = discoveredStates.get(agent)
    if (state === undefined) {
      state = { discovered: new Set(), restored: false }
      discoveredStates.set(agent, state)
    }
    if (!state.restored) {
      // resume：从会话派生消息还原。只在首次接触这个 agent 时做一次。
      const messages = typeof agent.session?.deriveMessages === 'function' ? agent.session.deriveMessages() : []
      for (const name of discoveredFromMessages(messages)) state.discovered.add(name)
      clampDiscovered(state.discovered, resolved.maxDiscovered)
      state.restored = true
    }
    return state
  }

  /**
   * 取（或按 revision 重建）视图。**唯一的错误边界**：ToolSearch 是优化不是正确性机制，
   * 宿主视图不可用、配置读不了都退回全量可见并记账，绝不让 assemble/guard 抛错——
   * 那会否决建会话或让 agent loop 每步失败。
   */
  const viewFor = (agent) => {
    try {
      const schemas = agent.ctx.tools.schemas(agent)
      const revision = viewRevision(schemas, resolved)
      const cached = viewCache.get(agent)
      if (cached !== undefined && cached.revision === revision) return cached.view
      const view = buildToolSearchView(schemas, resolved)
      viewCache.set(agent, { revision, view })
      return view
    } catch (error) {
      ctx.logger?.error?.(`mcp-manager: ToolSearch 视图不可用，本轮退回全量可见：${error?.message ?? error}`)
      return inertView()
    }
  }

  const disposeTool = ctx.tools.register({
    name: resolved.toolName,
    // 描述刻意不列服务器清单：那是活数据，会过期；活库存由目录 section 按组装承载（决策 9）。
    // 末句是语言提示：索引对工具名与描述做英文词面匹配，中文等查询会静默零命中。
    // 调用者就是模型自己，它完全能先译成英文——提示一句省掉一轮无效查询
    // （真机观测：不提示时模型先试中文拿 0 命中，再自己换英文才成功）。
    description: 'Search deferred tools by capability. Only tool names and purposes are listed upfront; this returns the full parameter schemas of the most relevant tools so they can be called directly. Query in English capability words — the index matches English tool names and descriptions, so translate a non-English query into English keywords first.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Capability query in English words. Forms: "select:<name>[,<name>...]" for exact names; "+<server> <words>" to require a server; plain keywords otherwise. Translate non-English queries into English keywords first.',
        },
        max_results: {
          type: 'integer',
          description: `Maximum tools to return (1-${resolved.maxResults}); defaults to ${resolved.maxResults}.`,
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      schema: RESULT_SCHEMA,
      // 累积发现列表只进 meta，render 剥掉——否则每次搜索都把不断增长的发现表泄回提示词。
      render: (_args, value) => {
        const rendered = { ...value }
        delete rendered.allDiscoveredTools
        return [{ type: 'text', text: JSON.stringify(rendered) }]
      },
      presentationMeta: (_args, value) => ({
        protocol: META_PROTOCOL,
        allDiscoveredTools: value.allDiscoveredTools ?? [],
      }),
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error(`${resolved.toolName} requires an agent-scoped execution`)
      const view = viewFor(exec.agent)
      const state = stateFor(exec.agent)
      const query = typeof args.query === 'string' ? args.query.trim() : ''
      if (query === '') throw new Error('query must not be empty')
      const limit = Math.min(Math.max(Number(args.max_results) || resolved.maxResults, 1), resolved.maxResults)
      const matches = view.deferring ? searchCatalog(view.catalog, query, limit, resolved.stem) : []
      const discoveredNow = []
      for (const match of matches) {
        if (!match.found || state.discovered.has(match.name)) continue
        state.discovered.add(match.name)
        discoveredNow.push(match.name)
      }
      // 无界发现会让请求 schema 随长会话长回全量基线；上限淘汰最旧的。
      // 下限抬到**本批长度**：`select:` 一次返回的名字数不受 maxResults 限制（见 DEFAULTS/
      // resolveRuntimeConfig 注释），若按 maxDiscovered 硬砍，本批靠前的名字会被当场淘汰并
      // 在结果里自相矛盾（matches=30 而 discoveredCount=20），下一次调用必被守卫拒。
      // 代价：单次超量 select 会让累积集临时超过上限；那批 schema 本就已经在提示词里了，
      // 下一次搜索按正常上限淘汰最旧，集合自然回落。
      clampDiscovered(state.discovered, Math.max(resolved.maxDiscovered, discoveredNow.length))
      return {
        protocol: META_PROTOCOL,
        query,
        // 刻意**不带 score**：它是内部排序产物（精确命中时是 Infinity），而工具输出要过
        // `snapshotToolValue` 的无损 JSON 校验——`JSON.stringify(Infinity)` 得到 null，
        // 整个结果会被判成 INVALID_TOOL_OUTPUT，`select:` 这个主查询形态就此报错。
        // 排序已由数组顺序表达，模型不需要这个数。
        matches: matches.map((match) => (match.found
          ? { name: match.name, description: match.description, parameters: match.parameters }
          : { name: match.name, found: false })),
        discoveredTools: discoveredNow,
        discoveredCount: state.discovered.size,
        catalogTools: view.catalog.size,
        allDiscoveredTools: [...state.discovered].sort(),
        instruction: matches.length > 0
          ? 'Call any returned tool directly by its exact name with arguments matching the returned parameters schema.'
          : 'No tool matched. Rephrase the query with exact capability words, or consult the deferred tool catalog section of the prompt.',
      }
    },
  })

  const disposeGuard = ctx.tools.guard((execution) => {
    if (execution.agent === undefined) return undefined
    const view = viewFor(execution.agent)
    if (!view.deferring) return undefined
    return guardDecision(execution.name, { managed: view.managed, discovered: stateFor(execution.agent).discovered }, resolved)
  })

  // 引导 section（静态：是什么/怎么用）。活的库存目录按组装推送（每个 agent 的可见集不同）。
  // 服务访问走 ctx.get 而非属性：cordis 对未注入服务的属性访问直接抛错，而 system-prompt
  // 不属于本插件的硬依赖（缺它时只损失静态引导段，目录 section 与过滤照常）。
  const systemPrompt = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : undefined
  const disposeSection = typeof systemPrompt?.section === 'function'
    ? systemPrompt.section(promptSection(GUIDANCE_SECTION_NAME,
      `Some tools are deferred: the prompt lists every deferred tool with a one-line purpose, but not its parameter schema. When a deferred tool fits the task, call ${resolved.toolName} with a capability query to load the full schemas of the most relevant tools, then call the chosen tool directly by its exact name. Do not claim a capability is unavailable before searching.`,
      GUIDANCE_SECTION_ORDER))
    : undefined

  const disposeAssemble = ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const resolvedAssembly = await next()
    const agent = context?.agent
    if (agent === undefined) return resolvedAssembly
    const view = viewFor(agent)
    // 引导段与活库存目录是同一句话的两半：没有服务器被延迟时，目录段不会追加
    // （只有 deferring 为真才走到下面那段），引导段（"Some tools are deferred…"）
    // 留着就是在教模型去调 tool_search 找一批并不存在的延迟工具。所以一起摘掉。
    //
    // 条件判断放在**组装层**而不是注册层：defer 是活状态（用户在面板翻开关、服务器
    // 可能晚连），而 systemPrompt.section() 是启动时一次性注册。视图按 revision 自愈、
    // 每次组装重算，所以判断放这里才跟着活状态走，也不需要任何新的订阅——
    // agent/created、tools/change 那类订阅正是本功能刻意不用的（漏置标志就是静默失配）。
    //
    // 清空文本而不是从数组里删掉：宿主 renderPrompt 会把空文本的 section 丢掉
    // （`.filter(text => text.length > 0)`），效果等于不注入，而段列表形状不变，
    // 与下面 maskInstructionSections 清空 mcp:<server> 指令段是同一种做法。
    if (!view.deferring) {
      const sections = maskGuidanceSection(resolvedAssembly.sections)
      return sections === resolvedAssembly.sections ? resolvedAssembly : { ...resolvedAssembly, sections }
    }
    const state = stateFor(agent)
    const tools = filterManagedTools(resolvedAssembly.tools, view.managed, state.discovered)
    const sections = maskInstructionSections(
      [...(resolvedAssembly.sections ?? []), promptSection('tool-search:catalog', view.catalogText)],
      activeMaskedServers(view, state.discovered),
    )
    return { ...resolvedAssembly, tools, sections }
  }, { prepend: true })

  return () => {
    for (const dispose of [disposeAssemble, disposeSection, disposeGuard, disposeTool]) {
      try { dispose?.() } catch { /* noop：cleanup 幂等，单个失败不阻断其余 */ }
    }
  }
}
