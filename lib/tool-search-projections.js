// 会话投影端口：两代宿主的 `sessionProjections` 注册/读取形状不同，这里收敛成一个入口。
//
// 旧宿主的注册返回同步 disposer，读值走 `stateOf(session, key)`。现代宿主返回
// thenable（也可能可调用）；必须先等到有效的 handle，才能从它读值并等待释放。
// 忽略 thenable 会用废弃的读取路径，并让异步注册失败看起来已经就绪。

/**
 * @typedef {object} ProjectionPort
 * @property {boolean} available - 宿主是否提供 sessionProjections。
 * @property {boolean} pending - 注册仍在进行，不能以空状态初始化恢复。
 * @property {Promise<{state: 'ready'|'failed'|'unavailable', reason?: string}>} ready - 注册结果，不拒绝。
 * @property {(session: object|undefined) => unknown} stateOf - 同步读；未就绪/不可用返回 undefined。
 * @property {() => (void|Promise<void>)} dispose - 释放（现代宿主等待注册及释放；旧宿主可同步）。
 * @property {() => object} status - 能力状态。
 */

/**
 * 安装发现集投影。
 *
 * @param {object} ctx - 插件 context（只需要可选的 `get`）。
 * @param {object} definition - 宿主 ProjectionDefinition（key/stateSchema/init/apply/stateVersion）。
 * @param {{key: string, onDiagnostic?: (event: object) => void}} options
 * @returns {ProjectionPort}
 */
export function installProjectionPort(ctx, definition, options) {
  const { key, onDiagnostic } = options
  const service = typeof ctx?.get === 'function' ? ctx.get('sessionProjections') : undefined
  const diagnostics = []
  const note = (event) => {
    diagnostics.push(event)
    onDiagnostic?.(event)
  }
  if (typeof service?.register !== 'function') {
    const unavailable = { state: 'unavailable', reason: 'ctx.sessionProjections.register() is unavailable' }
    return {
      available: false,
      pending: false,
      ready: Promise.resolve(unavailable),
      stateOf: () => undefined,
      dispose: () => {},
      status: () => ({ ...unavailable, legacy: false, diagnostics }),
    }
  }
  let status = { state: 'pending', reason: 'the projection handle is not ready yet' }
  let read, release, disposing
  let disposed = false
  let legacy = false
  const ready = (async () => {
    try {
      const registered = service.register(definition)
      // Note: Callable thenables still use the handle — .agents/notes/implemented/2026-11-23-toolsearch-recovery-and-ptc-receipts.md
      if (typeof registered === 'function' && typeof registered.then !== 'function') {
        legacy = true
        release = registered
        if (typeof service.stateOf !== 'function') throw new Error('the legacy projection registry exposes no stateOf()')
        read = (session) => service.stateOf(session, key)
      } else {
        const handle = await registered
        // Retain the release even if the read contract is invalid.
        if (typeof handle?.dispose === 'function') release = () => handle.dispose()
        if (typeof handle?.stateOf !== 'function' || release === undefined) {
          throw new Error('the projection handle must expose stateOf() and dispose()')
        }
        read = (session) => handle.stateOf(session)
      }
      status = { state: 'ready' }
    } catch (error) {
      const reason = error?.message ?? String(error)
      status = { state: 'failed', reason }
      note({ code: 'PROJECTION_REGISTER_FAILED', message: reason })
    }
    return status
  })()
  const releaseRegistered = () => {
    const report = (error) => note({ code: 'PROJECTION_DISPOSE_FAILED', message: error?.message ?? String(error) })
    try {
      const result = release?.()
      if (typeof result?.then === 'function') return Promise.resolve(result).catch(report)
    } catch (error) {
      report(error)
    }
  }

  return {
    available: true,
    get pending() { return !disposed && status.state === 'pending' },
    ready,
    stateOf: (session) => {
      if (session === undefined || disposed || status.state !== 'ready') return undefined
      try {
        return read(session)
      } catch (error) {
        note({ code: 'PROJECTION_READ_FAILED', message: error?.message ?? String(error) })
        return undefined
      }
    },
    dispose: () => {
      if (disposed) return disposing
      disposed = true
      // Preserve the immediate release of a synchronous legacy registration.
      disposing = legacy ? releaseRegistered() : ready.then(releaseRegistered)
      return disposing
    },
    status: () => ({ ...(disposed ? { state: 'disposed' } : status), legacy, diagnostics }),
  }
}
