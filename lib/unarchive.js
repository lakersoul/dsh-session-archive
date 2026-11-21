/**
 * dsh-session-archive —— 归档集合变更（纯逻辑 + 受控持久化）
 * ===========================================================================
 * 恢复归档（unarchive）。
 *
 * **优先使用原生入口**：DSH 0.2.x 起 `WorkspaceRegistry` 公开了
 * `unarchiveSession(sessionId)`，它在写状态前会发出
 * `workspace/session-unarchiving` 并行事件（worktree 服务用它取消进行中的
 * 工作树回收）。因此正常情况下本模块只做一层薄封装 —— 直接调用它。
 *
 * 只有在原生入口缺席时（更早的 DSH）才回退到自己实现的
 * `enqueueOperation + setState` 路径，保持向后兼容。
 *
 * 本模块提供：
 *   1. `planUnarchive()` / `planUnarchiveMany()` —— **纯函数**，可完整单测；
 *   2. `unarchiveSession()` —— 完整流程（原生优先，回退自实现）；
 *   3. `mutateArchivedIds()` / `persistArchivedIds()` —— 回退路径与兼容入口。
 *
 * ## 为什么必须走 registry.setState + enqueueOperation
 *
 * 官方 `archiveSession()` 的写法是：
 *     this.enqueueOperation(async () => { ... await this.setState(next) })
 * 而 `setState(state)` = `await this.global.set(state); this.state = state;`
 * —— 一次写盘 + 同步更新内存。
 *
 * 失败的做法（dsh-session-manager 就是这么写的）：
 *     storageDomain.get('workspace').global.set(next); registry.state = next
 * 它绕过了 `enqueueOperation` 的串行队列，与宿主自身的归档/恢复并发时
 * 是典型的 read-modify-write 丢失更新；而且它还得手工补一句
 * 「stale registry cache」兜底来修内存漂移 —— 那本身就是这个 bug 的症状。
 *
 * 本模块只做「读当前 state → 算新 state → 交给 registry 串行持久化」，
 * 绝不自己碰 storageDomain。
 */

/** 变更失败的原因码（供 UI 分类提示）。 */
export const UNARCHIVE_ERROR = {
  /** registry 不可用或形状已变 */
  REGISTRY_UNREADABLE: 'registry-unreadable',
  /** 想取消一个不在归档集合里的会话 */
  NOT_ARCHIVED: 'not-archived',
  /** 会话已不存在（陈旧标记），且未显式要求强制清除 */
  SESSION_GONE: 'session-gone',
  /** 持久化失败 */
  PERSIST_FAILED: 'persist-failed',
}

/**
 * 纯函数：算出取消归档后的新集合。
 * 不触碰任何 I/O，便于完整覆盖边界。
 *
 * @param {string[]} currentIds 当前归档集合
 * @param {string} sessionId 目标会话
 * @returns {{ok: true, next: string[], changed: boolean} | {ok: false, reason: string}}
 */
export function planUnarchive(currentIds, sessionId) {
  if (!Array.isArray(currentIds)) return { ok: false, reason: UNARCHIVE_ERROR.REGISTRY_UNREADABLE }
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return { ok: false, reason: UNARCHIVE_ERROR.NOT_ARCHIVED }
  }
  if (!currentIds.includes(sessionId)) {
    // 幂等：不在集合里就是目标状态，不算错误（避免"看起来失败其实已成功"）
    return { ok: true, next: [...currentIds], changed: false }
  }
  return { ok: true, next: currentIds.filter((id) => id !== sessionId), changed: true }
}

/**
 * 纯函数：把若干 id 从归档集合里移除（批量恢复）。
 * @param {string[]} currentIds
 * @param {string[]} sessionIds
 * @returns {{ok: true, next: string[], removed: string[], changed: boolean} | {ok: false, reason: string}}
 */
export function planUnarchiveMany(currentIds, sessionIds) {
  if (!Array.isArray(currentIds)) return { ok: false, reason: UNARCHIVE_ERROR.REGISTRY_UNREADABLE }
  const targets = new Set(
    (Array.isArray(sessionIds) ? sessionIds : []).filter((id) => typeof id === 'string' && id.length > 0),
  )
  const removed = currentIds.filter((id) => targets.has(id))
  const next = currentIds.filter((id) => !targets.has(id))
  return { ok: true, next, removed, changed: removed.length > 0 }
}

/**
 * 受控写入：把「读当前集合 → 算新集合 → 写回」**整体**放进宿主的串行队列。
 *
 * 这一步是本模块的关键。两种错误写法：
 *
 *   A. 直写 storageDomain（dsh-session-manager 的写法）——
 *      绕过 `enqueueOperation`，与宿主自身的归档并发时丢失更新。
 *
 *   B. 在**进队列之前**算好 `next` 再交给 `setState`（本模块的初版）——
 *      看起来用了串行队列，但两个并发请求都基于同一份旧 state 计算，
 *      后者会用陈旧结果覆盖前者。**必须把读也包括进串行区。**
 *
 * 因此这里传的是「变更函数」而不是「结果数组」。
 *
 * @param {object} registry
 * @param {(currentIds: string[]) => {ok: true, next: string[], changed: boolean} | {ok: false, reason: string, detail?: string}} compute
 * @returns {Promise<{ok: true, changed: boolean, next: string[], persistedVia?: string}
 *                  | {ok: false, reason: string, detail?: string}>}
 */
export async function mutateArchivedIds(registry, compute) {
  if (registry === undefined || registry === null) {
    return { ok: false, reason: UNARCHIVE_ERROR.REGISTRY_UNREADABLE, detail: 'registry 缺失' }
  }
  if (typeof registry.enqueueOperation !== 'function' || typeof registry.setState !== 'function') {
    return {
      ok: false,
      reason: UNARCHIVE_ERROR.REGISTRY_UNREADABLE,
      detail: 'registry 缺少 enqueueOperation/setState（宿主内部形状可能已变）',
    }
  }

  let outcome = null
  try {
    await registry.enqueueOperation(async () => {
      // ★ 在串行区内读取当前集合：排队期间可能已被别的写者改过
      const latest = registry.state
      if (latest === undefined || latest === null || typeof latest !== 'object') {
        outcome = { ok: false, reason: UNARCHIVE_ERROR.REGISTRY_UNREADABLE, detail: 'registry.state 不可读' }
        return
      }
      const currentIds = latest.archivedSessionIds
      if (!Array.isArray(currentIds)) {
        outcome = { ok: false, reason: UNARCHIVE_ERROR.REGISTRY_UNREADABLE, detail: 'archivedSessionIds 不是数组' }
        return
      }

      const plan = compute(currentIds)
      if (plan.ok === false) {
        outcome = plan
        return
      }
      if (plan.changed === false) {
        outcome = { ok: true, changed: false, next: plan.next }
        return
      }
      await registry.setState({ ...latest, archivedSessionIds: plan.next })
      outcome = { ok: true, changed: true, next: plan.next, persistedVia: 'registry.enqueueOperation+setState' }
    })
  } catch (error) {
    return { ok: false, reason: UNARCHIVE_ERROR.PERSIST_FAILED, detail: String(error?.message ?? error) }
  }

  return outcome ?? { ok: false, reason: UNARCHIVE_ERROR.PERSIST_FAILED, detail: '未产生结果（异常路径）' }
}

/**
 * 兼容入口：直接用完整的新集合持久化（**不**参与读-改-写事务）。
 *
 * 仅供"我刚刚读过 state，且确信期间没有别的写者"的场景，例如：
 * 由 `mutateArchivedIds` 之外的显式流程，或在串行区内已经算好。
 * 一般业务请用 `mutateArchivedIds()`。
 *
 * @param {object} registry
 * @param {string[]} nextIds
 * @returns {Promise<{ok: true, persistedVia: string} | {ok: false, reason: string, detail?: string}>}
 */
export async function persistArchivedIds(registry, nextIds) {
  return mutateArchivedIds(registry, () => ({ ok: true, next: nextIds, changed: true }))
}

/**
 * 完整恢复流程。
 *
 * 读、存在性判定、算、写全部在 `mutateArchivedIds` 的串行区内完成，
 * 因此并发恢复不会互相覆盖。
 *
 * @param {object} deps
 * @param {object} deps.registry workspaceRegistry
 * @param {(id: string) => boolean} [deps.sessionKnown] 会话是否存在（用于识别陈旧标记）
 * @param {string} sessionId
 * @param {{allowStale?: boolean}} [options] allowStale=true 时允许清除陈旧标记
 */
/**
 * 原生是否提供取消归档入口。
 * @param {object|undefined} registry
 * @returns {boolean}
 */
export function hasNativeUnarchive(registry) {
  return registry !== undefined && registry !== null
    && typeof registry.unarchiveSession === 'function'
}

/** 读当前归档集合；形状不对时返回错误对象。 */
function readArchivedIds(registry) {
  let state
  try {
    state = registry.state
  } catch (error) {
    return { ok: false, reason: UNARCHIVE_ERROR.REGISTRY_UNREADABLE, detail: String(error?.message ?? error) }
  }
  if (state === undefined || state === null || typeof state !== 'object') {
    return { ok: false, reason: UNARCHIVE_ERROR.REGISTRY_UNREADABLE, detail: 'registry.state 不可读' }
  }
  const ids = state.archivedSessionIds
  if (!Array.isArray(ids)) {
    return { ok: false, reason: UNARCHIVE_ERROR.REGISTRY_UNREADABLE, detail: 'archivedSessionIds 不是数组' }
  }
  return { ok: true, ids, state }
}

/**
 * 走原生 `registry.unarchiveSession()`。
 *
 * 注意：原生方法内部自己 `enqueueOperation`，所以**绝不可**把它包进我们的
 * `enqueueOperation` —— 那会自等待死锁。这里的两次 `state` 读取都在队列之外，
 * 仅用于：判定幂等、执行陈旧守卫、以及尽力给出 `changed`/`next`。
 * 真正的写入是原生的原子操作，不受这两次读取影响。
 */
async function unarchiveViaNative(registry, sessionId, options, sessionKnown) {
  const before = readArchivedIds(registry)
  if (before.ok === false) return before

  const currentIds = before.ids
  if (!currentIds.includes(sessionId)) {
    // 幂等：不在集合里就是目标状态
    return { ok: true, changed: false, next: [...currentIds], persistedVia: 'registry.unarchiveSession' }
  }

  // 陈旧守卫（保留原语义）：会话已不存在时默认不清除标记，需显式 allowStale
  if (options.allowStale !== true && typeof sessionKnown === 'function') {
    let known = false
    try {
      known = sessionKnown(sessionId) === true
    } catch {
      known = false
    }
    if (known === false) {
      return {
        ok: false,
        reason: UNARCHIVE_ERROR.SESSION_GONE,
        detail: '会话已不存在；如需清除陈旧标记请显式允许',
      }
    }
  }

  try {
    await registry.unarchiveSession(sessionId)
  } catch (error) {
    return {
      ok: false,
      reason: UNARCHIVE_ERROR.PERSIST_FAILED,
      detail: String(error?.message ?? error),
    }
  }

  const after = readArchivedIds(registry)
  const next = after.ok === true ? [...after.ids] : currentIds.filter((id) => id !== sessionId)
  return {
    ok: true,
    changed: !next.includes(sessionId),
    next,
    // 标明实际走的是哪条路径，便于排查与测试断言
    persistedVia: 'registry.unarchiveSession',
  }
}

/**
 * 完整恢复流程。
 *
 * 优先走原生 `registry.unarchiveSession()`（会发 `workspace/session-unarchiving`）；
 * 原生入口缺席时回退到自实现的串行读-改-写。
 *
 * @param {object} deps
 * @param {object} deps.registry workspaceRegistry
 * @param {(id: string) => boolean} [deps.sessionKnown] 会话是否存在（用于识别陈旧标记）
 * @param {string} sessionId
 * @param {{allowStale?: boolean}} [options] allowStale=true 时允许清除陈旧标记
 */
export async function unarchiveSession(deps, sessionId, options = {}) {
  const { registry, sessionKnown } = deps ?? {}
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return { ok: false, reason: UNARCHIVE_ERROR.NOT_ARCHIVED, detail: 'sessionId 非法' }
  }

  if (hasNativeUnarchive(registry)) {
    return unarchiveViaNative(registry, sessionId, options, sessionKnown)
  }

  return mutateArchivedIds(registry, (currentIds) => {
    if (!currentIds.includes(sessionId)) {
      // 幂等：不在集合里就是目标状态
      return { ok: true, next: [...currentIds], changed: false }
    }
    // 会话不存在 ⇒ 陈旧标记。默认不清除（不可逆），需显式 allowStale。
    if (options.allowStale !== true && typeof sessionKnown === 'function') {
      let known = false
      try {
        known = sessionKnown(sessionId) === true
      } catch {
        known = false
      }
      if (known === false) {
        return {
          ok: false,
          reason: UNARCHIVE_ERROR.SESSION_GONE,
          detail: '会话已不存在；如需清除陈旧标记请显式允许',
        }
      }
    }
    return { ok: true, next: currentIds.filter((id) => id !== sessionId), changed: true }
  })
}
