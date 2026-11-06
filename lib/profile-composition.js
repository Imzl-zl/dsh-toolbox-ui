// profile 组合的**唯一 live 变更入口**。
//
// 为什么要有这一层：MCP 的每一条配置行都住在 profile 的 `cordis.patch.yml` 里，而"盘上写了"
// 与"运行中生效"是两件事。插件自己拼 loader 条目（`loader.create` / `entry.update` /
// `entry.parent.remove`）时，等于把宿主的组合语义抄了第二份——写盘的行、运行中的条目、面板
// 读到的策略三者迟早漂移（本轮面板 bug 就是这种漂移：同一个事实三处各算一次）。
//
// 现在只有一条路：官方 `@deepseek-ai/dsh-app-boot` 的
//   readProfilePatches(name, profileContext)      → 完整有序组合（bundle → profile → home → CLI overlay → telemetry）
//   composeEntries([patches])                     → 最终有效配置（判定"我写的那行到底算不算数"）
//   reconcileProfilePatches(root, patches, name, requiredIds)
//                                                → 把整份组合应用到根 Include，并判定激活结果
// 与官方配置编辑器（`packages/boot/config-editor`）用的是同一组函数、同一个顺序。
//
// 失败语义（写盘成功 ≠ 生效）：
//   1. 写盘失败            → 抛错，`persisted: 'failed'`，一个字节都不改；
//   2. 组合里我的行不算数  → 写盘已发生，回滚到上一份 content 并 reconcile 恢复 live，然后抛错；
//   3. reconcile 失败      → 同上（回滚 + 恢复 live），错误里带两份失败原因；
//   4. 部署没有 profile 启动器（无 profileContext / 无 app-boot）→ **如实**报 `live: 'skipped'`，
//      不假装热生效，也不偷偷跳过写盘。
//
// 只读的 `createLiveEntries` / `restoreLiveEntry` 之类的旁路已经删掉：同一件事只有这一个实现。

const API_PACKAGE = '@deepseek-ai/dsh-app-boot'
// profile 的 bin 名：只影响诊断前缀，与启动器一致即可（宿主 CLI 也叫 dsh）。
const BIN_NAME = 'dsh'
// 组合层真正用到的那几个导出。少一个就不假装可用——缺函数时 reconcile 会半途抛错。
const API_FUNCTIONS = ['composeEntries', 'loadProfileDirectory', 'readProfilePatches', 'reconcileProfilePatches']

// 按 app 缓存（同一个 ctx 上只解析一次模块）。失败不缓存：HMR/重装之后可能就装上了。
const apiPromises = new WeakMap()

/**
 * 宿主组合 API 认的永远是**根 context**。
 *
 * app-boot 的 `bootstrapIncludes` 是 `WeakMap<Context, Entry>`：启动器拿根 ctx 挂的 include，
 * 拿插件自己的派生 ctx 去取必然取不到（会报 "profile reload requires the root Include entry"）。
 * 官方配置编辑器也是用 `this.ownerContext.root` 调的——这里必须一致。
 *
 * @param {object} ctx
 * @returns {object}
 */
function rootContextOf(ctx) {
  return ctx?.root ?? ctx
}

/**
 * 定位本 profile 的组合能力。
 *
 * `profileContext` 由宿主启动器 provide（见 `@deepseek-ai/dsh` 的 profile-boot）；`app-boot`
 * 走 `loader.import`，因为它在宿主的安装树里，而不是本插件的依赖（peer 声明只表达"宿主提供"）。
 *
 * @param {object} ctx - 插件 context（只需要 `get`）。
 * @returns {Promise<{api?: object, profileContext?: object, reason?: string}>}
 */
export async function profileSources(ctx) {
  const root = rootContextOf(ctx)
  const profileContext = typeof root?.get === 'function' ? root.get('profileContext') : undefined
  if (profileContext === undefined) {
    return { reason: 'profileContext 服务不存在（这个部署没有 dsh profile 启动器）' }
  }
  let api
  let pending = apiPromises.get(root)
  if (pending === undefined) {
    pending = (async () => {
      const loader = typeof root?.get === 'function' ? root.get('loader') : undefined
      const attempts = [
        // 宿主自己的解析面（桌面壳把它重定向到 app 根；CLI 树里就是 profile 的安装树）。
        async () => {
          if (typeof loader?.import !== 'function') throw new Error('loader.import() 不可用')
          return await loader.import(API_PACKAGE)
        },
        // 兜底：从本插件自己的解析位置 import（宿主没给 loader.import 时的最后一条路）。
        async () => await import(API_PACKAGE),
      ]
      const failures = []
      for (const attempt of attempts) {
        let candidate
        try {
          candidate = await attempt()
        } catch (error) {
          failures.push(String(error?.message ?? error))
          continue
        }
        if (await probeComposition(rootContextOf(ctx), candidate)) return candidate
        failures.push('组合 API 来自另一份模块实例（app-boot 的根 Include 登记表是模块内 WeakMap）')
      }
      throw new Error(failures.join('；'))
    })()
    apiPromises.set(root, pending)
    pending.catch(() => apiPromises.delete(root))
  }
  try {
    api = await pending
  } catch (error) {
    return { profileContext, reason: `${API_PACKAGE} 不可用：${error?.message ?? error}` }
  }
  const missing = API_FUNCTIONS.filter((name) => typeof api?.[name] !== 'function')
  if (missing.length > 0) {
    return { profileContext, reason: `${API_PACKAGE} 缺少 ${missing.join(' / ')}（这个宿主版本的组合 API 不完整）` }
  }
  return { api, profileContext }
}

/** 忘记已解析的 API（测试/HMR 用）。 */
export function resetProfileSources(ctx) {
  apiPromises.delete(rootContextOf(ctx))
}

/**
 * 这个模块实例是不是**宿主那一份**组合 API。
 *
 * 为什么需要探一次：app-boot 用模块内的 `WeakMap<Context, Entry>` 记住启动器挂的根 Include。
 * 依赖树里一旦出现两份 app-boot（插件自带一份、宿主一份），我们就会拿到一个"函数齐全、
 * 但没有那个 WeakMap"的副本——它的 reconcile 会报 `requires the root Include entry`。
 * 不探就只会在**写盘之后**才发现，那时代码得回滚一次；探一次是幂等的（组合没变，
 * reconcile 不会重启任何东西），之后按 ctx 缓存结论。
 *
 * 只把那一类**结构性**错误判成"实例不对"：其它错误（某个既有条目起不来之类）不该否定 API 本身。
 *
 * @param {object} ctx - 根 context。
 * @param {object} api - 候选模块。
 * @returns {boolean}
 */
async function probeComposition(ctx, api) {
  const profileContext = typeof ctx?.get === 'function' ? ctx.get('profileContext') : undefined
  if (profileContext === undefined) return false
  try {
    const patches = api.readProfilePatches(BIN_NAME, profileContext)
    await api.reconcileProfilePatches(ctx, patches, BIN_NAME)
    return true
  } catch (error) {
    return !/root Include entry/.test(String(error?.message ?? error))
  }
}

/**
 * 最终有效配置里的那一行（官方 `composeEntries` 的判定结果，不是我们自己扫 patch 文件）。
 *
 * @param {object} api - app-boot 模块。
 * @param {object[]} patches - 完整有序 patch 列表。
 * @param {string} entryId - loader 条目 id。
 * @returns {object|undefined} 组合后的 EntryOptions（组内的行也会被展开）。
 */
export function composedRow(api, patches, entryId) {
  const stack = [...api.composeEntries([patches])]
  while (stack.length > 0) {
    const row = stack.pop()
    if (row?.id === entryId) return row
    if (Array.isArray(row?.config)) stack.push(...row.config)
  }
  return undefined
}

/**
 * 判定"我写的那一行在最终组合里算不算数"。
 *
 * 不是锦上添花：home patch 或 CLI overlay 可以覆盖/禁用同一个 id，那时写盘成功、运行中的行为
 * 却仍是旧的——面板会显示"已保存"，用户拿到的是反的。所以这一步失败必须回滚。
 *
 * @param {object} api
 * @param {object[]} patches
 * @param {string} entryId
 * @param {{present: boolean, disabled?: boolean}} expect
 * @returns {{ok: true}|{ok: false, reason: string}}
 */
export function checkComposedRow(api, patches, entryId, expect) {
  const row = composedRow(api, patches, entryId)
  if (expect.present === false) {
    return row === undefined ? { ok: true } : { ok: false, reason: `条目 ${entryId} 仍被更高层配置层（home patch / CLI overlay）插入，删不掉` }
  }
  if (row === undefined) return { ok: false, reason: `条目 ${entryId} 不在最终有效配置里（被更高层覆盖或未插入）` }
  const disabled = row.disabled === true
  if (expect.disabled !== undefined && disabled !== expect.disabled) {
    return { ok: false, reason: `条目 ${entryId} 在最终有效配置里${disabled ? '被禁用' : '被启用'}（期望${expect.disabled ? '禁用' : '启用'}），写入被更高层覆盖` }
  }
  return { ok: true }
}

function liveEntries(ctx, entryId) {
  return [...ctx.loader.entries()].filter((entry) => entry.options.id === entryId)
}

/**
 * 把"整份组合"落到运行中的根 Include 上。
 *
 * 为什么先给 doomed 行打 `disabled`：rc.5 的 loader（1.0.6）在插件卸载时会
 * `fiber.entry.parent.tree.write()`，对 include 子树条目就是 `Include.write()`——而它写的是
 * **已应用树**（base + patch 行），于是"删一台服务器"会把其余 patch 行烙进 `cordis.yml`，
 * 下次启动 base 一份 + patch insert 一份 = 重复条目。卸载钩子唯一的早退判据就是
 * `fiber.entry.disabled`，所以移除前先置位（这一行本来就要消失，不改变任何可见语义）。
 * rc.1 的 include 换成了 journal（按 patch/文件归属回写），不需要这个补丁，置位也无害。
 *
 * @param {object} ctx
 * @param {object} sources - `profileSources()` 的结果（需要 api）。
 * @param {string[]} doomedIds - 这次会从组合里消失的条目 id。
 * @param {string[]} requiredIds - 激活失败时必须报错的行。
 * @returns {Promise<object[]>} 实际应用的完整 patch 列表。
 */
async function applyPatches(ctx, sources, doomedIds, requiredIds) {
  for (const entryId of doomedIds) {
    for (const entry of liveEntries(ctx, entryId)) entry.options.disabled = true
  }
  const patches = sources.api.readProfilePatches(BIN_NAME, sources.profileContext)
  await sources.api.reconcileProfilePatches(rootContextOf(ctx), patches, BIN_NAME, requiredIds)
  return patches
}

/**
 * 一次"写入 + 应用"事务的结果。字段是所有变更型 RPC 的共同契约（面板据此显示
 * "已保存但未生效"这类状态）。
 *
 * @typedef {object} ProfileMutationResult
 * @property {'applied'|'unchanged'|'rolled-back'|'failed'} persisted - 盘上的事实。
 * @property {'applied'|'unchanged'|'skipped'|'failed'} live - 运行中的事实。
 * @property {{code: string, message: string}[]} diagnostics - 可展示的诊断。
 * @property {string} [liveReason] - `live` 不是 `applied` 时的具体原因。
 */

/** 写盘/生效失败的统一错误形态：message 给人看，result 给面板与测试读。 */
export class ProfileMutationError extends Error {
  /**
   * @param {string} message
   * @param {ProfileMutationResult & {cause?: unknown}} result
   */
  constructor(message, result) {
    super(message, result?.cause === undefined ? undefined : { cause: result.cause })
    this.name = 'ProfileMutationError'
    this.result = result
  }
}

/**
 * 写盘 + 生效（**唯一入口**）。
 *
 * @param {object} ctx - 插件 context。
 * @param {{content: string, version?: string, write: (content: string) => Promise<{version: string}>}} patch
 *   写盘前的快照与唯一的写盘函数（带 stale 版本校验、HMR 锁的由调用方提供）。
 * @param {string} nextContent - 新的 profile patch 内容。
 * @param {object} [options]
 * @param {string} [options.label] - 诊断里的动作名（"MCP 新增"…）。
 * @param {string} [options.entryId] - 本次动作涉及的那一行（用于生效性判定与激活判定）。
 * @param {{present: boolean, disabled?: boolean}} [options.expect] - 期望在最终组合里看到的状态。
 * @param {string[]} [options.requiredIds] - 激活失败时必须报错的行（= 本次要"真的跑起来"的行）。
 * @param {() => void|Promise<void>} [options.applyLive] - 覆盖默认的 reconcile。只给**不改变行生命周期**
 *   的活值用（例如 defer 遮罩：它不参与连接，为它重启 mcp-client 是纯代价）。事务语义不变：
 *   它抛错同样回滚。
 * @param {(entries: object[]) => void} [options.verifyLive] - reconcile 之后对运行中条目的额外断言。
 * @returns {Promise<ProfileMutationResult>}
 */
export async function commitProfilePatches(ctx, patch, nextContent, options = {}) {
  const label = options.label ?? 'profile 配置'
  const changed = nextContent !== patch.content
  const sources = await profileSources(ctx)
  const diagnostics = []
  let write
  try {
    write = changed ? await patch.write(nextContent) : { version: patch.version }
  } catch (error) {
    throw new ProfileMutationError(`${label}写入失败：${error?.message ?? error}`, {
      persisted: 'failed', live: 'skipped',
      diagnostics: [{ code: 'PROFILE_WRITE_FAILED', message: String(error?.message ?? error) }],
      cause: error,
    })
  }
  // 活值路径（defer 遮罩这类"不改变行生命周期"的值）：不需要组合 API，也不重建任何条目。
  // 但事务语义照样成立——它抛错就把盘上的内容写回上一份。
  if (typeof options.applyLive === 'function') {
    try {
      await options.applyLive()
      return { persisted: changed ? 'applied' : 'unchanged', live: 'applied', diagnostics, version: write?.version }
    } catch (error) {
      const failures = [error]
      diagnostics.push({ code: 'PROFILE_LIVE_FAILED', message: String(error?.message ?? error) })
      if (changed) {
        try {
          await patch.write(patch.content, write?.version)
        } catch (rollbackError) {
          failures.push(rollbackError)
          diagnostics.push({ code: 'PROFILE_ROLLBACK_WRITE_FAILED', message: String(rollbackError?.message ?? rollbackError) })
        }
      }
      const detail = failures.map((failure) => failure?.message ?? String(failure)).join('；')
      throw new ProfileMutationError(`${label}失败，已回滚：${detail}`, {
        persisted: changed ? 'rolled-back' : 'failed', live: 'failed', diagnostics,
        cause: failures.length > 1 ? new AggregateError(failures, detail) : error,
      })
    }
  }
  // 没有 live 入口的部署：写盘是既成事实，但**不宣称生效**。
  if (sources.api === undefined) {
    diagnostics.push({ code: 'PROFILE_LIVE_UNAVAILABLE', message: sources.reason })
    return { persisted: changed ? 'applied' : 'unchanged', live: 'skipped', liveReason: sources.reason, diagnostics }
  }
  const doomedIds = options.doomedIds ?? []
  try {
    if (options.entryId !== undefined && options.expect !== undefined) {
      const composed = sources.api.readProfilePatches(BIN_NAME, sources.profileContext)
      const verdict = checkComposedRow(sources.api, composed, options.entryId, options.expect)
      if (!verdict.ok) throw new Error(verdict.reason)
    }
    await applyPatches(ctx, sources, doomedIds, options.requiredIds ?? [])
    if (typeof options.verifyLive === 'function') options.verifyLive(liveEntries(ctx, options.entryId))
    return {
      persisted: changed ? 'applied' : 'unchanged',
      live: 'applied',
      diagnostics,
      version: write?.version,
    }
  } catch (error) {
    const failures = [error]
    diagnostics.push({ code: 'PROFILE_LIVE_FAILED', message: String(error?.message ?? error) })
    // 回滚：先把盘上的内容写回上一份，再用**恢复后的**完整组合 reconcile 一次。
    if (changed) {
      try {
        await patch.write(patch.content, write?.version)
      } catch (rollbackError) {
        failures.push(rollbackError)
        diagnostics.push({ code: 'PROFILE_ROLLBACK_WRITE_FAILED', message: String(rollbackError?.message ?? rollbackError) })
      }
    }
    try {
      const restored = sources.api.readProfilePatches(BIN_NAME, sources.profileContext)
      await sources.api.reconcileProfilePatches(rootContextOf(ctx), restored, BIN_NAME)
    } catch (recoveryError) {
      failures.push(recoveryError)
      diagnostics.push({ code: 'PROFILE_ROLLBACK_LIVE_FAILED', message: String(recoveryError?.message ?? recoveryError) })
    }
    const detail = failures.map((failure) => failure?.message ?? String(failure)).join('；')
    throw new ProfileMutationError(failures.length > 1 ? `${label}失败，且状态恢复不完整：${detail}` : `${label}失败，已回滚：${detail}`, {
      persisted: changed ? 'rolled-back' : 'failed',
      live: 'failed',
      diagnostics,
      cause: failures.length > 1 ? new AggregateError(failures, detail) : error,
    })
  }
}
