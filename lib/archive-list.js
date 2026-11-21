/**
 * dsh-session-archive —— 归档列表解析（纯逻辑，可独立单测）
 * ===========================================================================
 * 本模块**不做任何 I/O、不引用宿主内部字段**，只接收已经取好的数据并做归并。
 * 这样归档列表的核心语义（陈旧标记识别、去重、排序、容错）可以完全单测覆盖，
 * 不依赖 DSH 运行时的重启验证。
 *
 * 调用方（lib/index.js）负责取三样东西：
 *   - archivedIds : workspaceRegistry.state.archivedSessionIds（权威归档集合）
 *   - liveHeaders : ctx.sessions.list().map(s => s.header)（可选，实时会话）
 *   - persisted   : sessionPersistence.list() 的结果（快照或裸 header 都接受）
 *   - titles      : Map<sessionId, string>（可选，标题解析由调用方负责）
 *
 * 关于"陈旧标记"：归档集合是**独立持久化**的，会话文件却可能已被外部删除。
 * 但删掉归档标记是不可逆的（原生没有 unarchive 入口，本插件 P2 才补上），
 * 所以本模块**只报告、绝不改状态** —— 是否清理由使用者决定。
 */

/** 条目的可读性状态。 */
export const STATE = {
  /** 能读到会话数据 */
  OK: 'ok',
  /** 归档集合里有该 id，但实时与持久化都找不到它 —— 陈旧标记 */
  MISSING: 'missing',
}

/**
 * 归一化一个"持久化项"为 header。兼容两种形状：
 *   - 0.1.5-rc.2 的 `SessionPersistenceSnapshot`：`{ header, revision, sizeBytes }`
 *   - 更早/更简的裸 header：元素本身就有 `id`
 * 这正是 dsh-session-manager 栽跟头的地方（它只认后者）。
 * @param {unknown} item
 * @returns {object | null}
 */
export function headerOf(item) {
  if (item === null || typeof item !== 'object') return null
  const candidate = item.header !== undefined && item.header !== null ? item.header : item
  if (candidate === null || typeof candidate !== 'object') return null
  if (typeof candidate.id !== 'string' || candidate.id.length === 0) return null
  return candidate
}

/**
 * 从多个来源归并出 header 查找表。**实时优先**（与宿主 sessionQuery 的取向一致）。
 * @param {object[]} liveHeaders
 * @param {unknown[]} persistedItems
 * @returns {Map<string, {header: object, live: boolean}>}
 */
export function buildHeaderIndex(liveHeaders = [], persistedItems = []) {
  const index = new Map()
  for (const item of persistedItems) {
    const header = headerOf(item)
    if (header === null) continue
    index.set(header.id, { header, live: false })
  }
  for (const item of liveHeaders) {
    const header = headerOf(item)
    if (header === null) continue
    index.set(header.id, { header, live: true })
  }
  return index
}

/**
 * 取会话的活动时间：`updatedAt` 优先，退回 `createdAt`，都没有则 0。
 * @param {object} header
 * @returns {number}
 */
export function activityOf(header) {
  const updated = header?.updatedAt
  if (typeof updated === 'number' && Number.isFinite(updated)) return updated
  const created = header?.createdAt
  if (typeof created === 'number' && Number.isFinite(created)) return created
  return 0
}

/**
 * 解析归档集合为展示用条目列表。
 *
 * 语义要点：
 *  - **去重**：归档集合理论上不该有重复，但一旦有，只出现一次。
 *  - **只报告、不改状态**：`MISSING` 条目原样保留在结果里带状态，
 *    绝不在这里从归档集合里删掉它（那需要使用者确认）。
 *  - **排序**：活动时间降序；同时间按 id 升序，保证结果稳定可测。
 *
 * @param {{archivedIds?: string[], liveHeaders?: object[], persistedItems?: unknown[], titles?: Map<string,string>|Record<string,string>, runningIds?: Set<string>|string[]}} input
 * @returns {{items: object[], summary: {total: number, ok: number, missing: number, live: number}}}
 */
export function resolveArchivedSessions(input = {}) {
  const archivedIds = Array.isArray(input.archivedIds) ? input.archivedIds : []
  const index = buildHeaderIndex(input.liveHeaders ?? [], input.persistedItems ?? [])
  const titles = input.titles
  // `running` 与 `live` 是两件事，必须分清：
  //   · live    —— 会话在宿主内存 store 里（例如你刚点开看过它）。**可以删除**，
  //                宿主会走 detachEntered 把它从 store 摘掉。
  //   · running —— 该会话的 agent 正在跑。删除会打断它，应拒绝。
  // 早前客户端把 live 当成禁止条件，导致"打开过的归档会话删不掉"。
  const runningIds = input.runningIds instanceof Set
    ? input.runningIds
    : new Set(Array.isArray(input.runningIds) ? input.runningIds : [])

  const titleOf = (sessionId) => {
    if (titles === undefined || titles === null) return null
    if (titles instanceof Map) {
      const v = titles.get(sessionId)
      return typeof v === 'string' && v.length > 0 ? v : null
    }
    if (typeof titles === 'object') {
      const v = titles[sessionId]
      return typeof v === 'string' && v.length > 0 ? v : null
    }
    return null
  }

  const seen = new Set()
  const items = []
  for (const rawId of archivedIds) {
    if (typeof rawId !== 'string' || rawId.length === 0) continue
    if (seen.has(rawId)) continue
    seen.add(rawId)

    const found = index.get(rawId)
    if (found === undefined) {
      items.push({
        sessionId: rawId,
        state: STATE.MISSING,
        live: false,
        running: false,
        title: null,
        cwd: null,
        createdAt: null,
        updatedAt: null,
        activityAt: 0,
      })
      continue
    }

    const { header, live } = found
    items.push({
      sessionId: rawId,
      state: STATE.OK,
      live,
      running: runningIds.has(rawId),
      title: titleOf(rawId),
      cwd: typeof header.cwd === 'string' ? header.cwd : null,
      createdAt: typeof header.createdAt === 'number' ? header.createdAt : null,
      updatedAt: typeof header.updatedAt === 'number' ? header.updatedAt : null,
      activityAt: activityOf(header),
    })
  }

  items.sort((a, b) => {
    if (b.activityAt !== a.activityAt) return b.activityAt - a.activityAt
    return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0
  })

  const summary = {
    total: items.length,
    ok: items.filter((i) => i.state === STATE.OK).length,
    missing: items.filter((i) => i.state === STATE.MISSING).length,
    live: items.filter((i) => i.live === true).length,
    running: items.filter((i) => i.running === true).length,
  }

  return { items, summary }
}
