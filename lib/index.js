/**
 * dsh-session-archive —— host half
 * ===========================================================================
 * 会话归档管理：恢复已归档会话 / 删除（进可恢复回收站）/ 手动管理回收站。
 *
 * 设计约束（每一条都来自此前三个同类插件在本机的实际故障）：
 *   1. **只消费原生服务，绝不替换**。不 disabled 任何原生行，不接管
 *      workspace / session-projection-cache / ui-workspace。最坏情况是功能缺失，
 *      而不是 DSH 起不来。
 *   2. **不自带更新器**。升级由使用者手动执行，冷却与审阅始终在人的手上。
 *   3. **不做 DOM 注入**。客户端只走官方 slot。
 *   4. **fail-soft 与 fail-loud 分离**：清理动作单个失败不阻断主流程；
 *      但"删除"必须要么真的删掉、要么返回明确错误，绝不允许"看起来删了其实没删"。
 *   5. **删除前必须 stat 复核**：路径推导见 lib/paths.js，那是唯一有误删风险的地方。
 *   6. **绝不静默丢弃回收站条目**：容量/期限只做统计与提示，淘汰必须由人确认。
 *
 * 本文件在 P0 阶段只建立骨架：装配、不变量自检、路由表占位。
 * 具体能力按计划分阶段填入（P1 只读列表 / P2 恢复 / P3 删除）。
 */

import { join } from 'node:path'
import { homedir } from 'node:os'
import { headerOf, resolveArchivedSessions } from './archive-list.js'
import { UNARCHIVE_ERROR, unarchiveSession } from './unarchive.js'
import {
  TRASH_ERROR,
  buildMeta,
  checkCapacity,
  checkRestorable,
  entryDirName,
  summarizeTrash,
  verifyDeletableSessionDir,
  suggestPurgeCandidates,
  DEFAULT_LIMITS,
} from './trash.js'
import {
  dirSizeBytes,
  ensureTrashRoot,
  listEntries,
  listFileNames,
  moveSessionDirToTrash,
  purgeEntry,
  restoreEntryFromTrash,
  statForVerify,
} from './trash-io.js'
import { candidateSessionDirs } from './paths.js'

/** Loader 显示名；需与 bundle id 及包名一致。 */
export const name = 'dsh-session-archive'

/**
 * 硬依赖只声明真正必需的；其余一律用 ctx.get() 可选读取，
 * 避免宿主缺某个服务时整行 pending 拖累启动。
 */
export const inject = ['connection', 'workspaceRegistry', 'sessionPersistence']

/** API 前缀：所有路由挂在官方 /api 围栏下（复用其 Host/Origin 认证）。 */
export const API_PREFIX = '/api/sessionArchive.'

/**
 * DSH home 目录。
 *
 * 刻意**不 import `@deepseek-ai/dsh-home-paths`**：那是传递依赖，从插件位置
 * 解析不到（实测 ERR_MODULE_NOT_FOUND），硬 import 会让插件启动即崩。
 * 改为读 DSH_HOME 环境变量 —— 与 dsh 自身优先使用 DSH_HOME 的行为一致。
 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return join(homedir(), '.dsh')
}

/** 回收站根目录；与 sessions/ 同级但**不在其内**（见 README 的启动安全说明）。
 *
 * 可用 `DSH_SESSION_ARCHIVE_ROOT` 覆盖（测试隔离 / 迁移到别的盘）。
 * 这是刻意的：插件不应把"数据放哪"写死，否则测试就得碰使用者真实的回收站。
 */
export function archiveRoot() {
  const override = process.env.DSH_SESSION_ARCHIVE_ROOT
  if (typeof override === 'string' && override.length > 0) return override
  return join(dshHome(), 'session-archive')
}

export function trashRoot() {
  return join(archiveRoot(), 'trash')
}

/**
 * 容量与保留策略（可在设置卡片里改）。
 *
 * 读取顺序：`DSH_SESSION_ARCHIVE_LIMITS`（JSON，供部署/测试覆盖）→ 默认值。
 * 非法输入一律**退回默认值**，绝不因为配置写错就把上限变成 0/NaN 而误伤数据。
 *
 * 注意：这些上限**只用于拦截与提示**，不会触发任何自动删除。
 */
export function archiveLimits() {
  const raw = process.env.DSH_SESSION_ARCHIVE_LIMITS
  if (typeof raw !== 'string' || raw.trim().length === 0) return { ...DEFAULT_LIMITS }
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return { ...DEFAULT_LIMITS }
    const out = { ...DEFAULT_LIMITS }
    for (const key of Object.keys(DEFAULT_LIMITS)) {
      const value = parsed[key]
      if (Number.isFinite(value) && value > 0) out[key] = value
    }
    return out
  } catch {
    return { ...DEFAULT_LIMITS }
  }
}

/**
 * 本插件的自检：确认我们**没有**、也不会去禁用原生核心行。
 * 这是一条运行时哨兵——如果将来有人往 patch 层塞 disable，启动日志里会留下痕迹，
 * 而不是等到某次"插件半装"时才以"启动中止"的形式暴露。
 */
const PROTECTED_NATIVE_ROWS = ['workspace', 'session-projection-cache', 'ui-workspace']

export function apply(ctx) {
  ctx.logger.info(
    `[${name}] host half mounted; archiveRoot=${archiveRoot()}; ` +
    `不替换任何原生服务（保护行：${PROTECTED_NATIVE_ROWS.join(', ')}）`,
  )

  // ── 路由表（P1–P3 已全部实现）────────────────────────────────────────────
  // 传输通道：connection.fetch.register 注册精确 /api 路由，复用官方认证围栏。
  // 注意 registerFetchRoute 的 effect 由 connection 的 ctx 持有、随插件卸载撤销，
  // 因此这里必须持有返回的 disposer（与 archive-manager 丢弃 disposer 的做法相反）。
  const routes = [
    { path: `${API_PREFIX}list`, methods: ['POST'], handler: () => handleList(ctx) },
    { path: `${API_PREFIX}unarchive`, methods: ['POST'], handler: (request) => handleUnarchive(ctx, request) },
    { path: `${API_PREFIX}trash`, methods: ['POST'], handler: () => handleTrashList(ctx) },
    { path: `${API_PREFIX}delete`, methods: ['POST'], handler: (request) => handleDelete(ctx, request) },
    { path: `${API_PREFIX}restore`, methods: ['POST'], handler: (request) => handleRestore(ctx, request) },
    { path: `${API_PREFIX}purge`, methods: ['POST'], handler: (request) => handlePurge(ctx, request) },
    { path: `${API_PREFIX}purgeExpired`, methods: ['POST'], handler: (request) => handlePurgeMany(ctx, request) },
    { path: `${API_PREFIX}repairOrphans`, methods: ['POST'], handler: () => handleRepairOrphans(ctx) },
  ]

  const connection = ctx.get('connection')
  if (connection === undefined || connection.fetch === undefined) {
    ctx.logger.warn(`[${name}] connection.fetch 不可用，HTTP 通道未挂载（功能不可用，但不影响启动）`)
    return
  }

  const disposers = []
  for (const route of routes) {
    try {
      const disposer = connection.fetch.register({
        path: route.path,
        methods: route.methods,
        requestBody: 'buffered',
        fetch: route.handler,
      })
      if (typeof disposer === 'function') disposers.push(disposer)
    } catch (error) {
      // 单条路由失败不阻断其余；fail-loud 到日志，便于排查
      ctx.logger.error(`[${name}] 注册路由失败 ${route.path}: ${String(error?.message ?? error)}`)
    }
  }

  // 归属当前 fiber：插件卸载/更新时自动撤销，绝不残留路由
  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch (error) {
        ctx.logger.warn(`[${name}] 撤销路由失败: ${String(error?.message ?? error)}`)
      }
    }
  }, `${name}.routes`)

  ctx.logger.info(`[${name}] 已挂载 ${disposers.length}/${routes.length} 条 /api 路由`)
}

// ═══════════════════════════════════════════════════════════════════════════
// 数据源适配层
// ═══════════════════════════════════════════════════════════════════════════
// 所有"读宿主内部字段"的动作都集中在这里。这样宿主升级改形状时，
// 只需要改这一处，并且能给出**明确的降级信号**而不是静默返回空列表。

/**
 * 读权威归档集合。
 *
 * 依赖 `workspaceRegistry.state.archivedSessionIds` —— 这是**内部字段**（非公开 API），
 * 公开面只有 `archiveSession()`（单向）。所以这里做形状校验：
 * 拿不到就返回 `{ok:false, reason}`，由调用方转成明确错误，
 * **绝不**降级成"空归档列表"（那会让使用者以为归档丢了）。
 *
 * @returns {{ok: true, ids: string[], source: string} | {ok: false, reason: string}}
 */
export function readArchivedIds(registry) {
  if (registry === undefined || registry === null) {
    return { ok: false, reason: 'workspaceRegistry 不可用' }
  }
  const state = registry.state
  if (state === undefined || state === null || typeof state !== 'object') {
    return { ok: false, reason: 'workspaceRegistry.state 不可读（宿主内部形状可能已变）' }
  }
  const archived = state.archivedSessionIds
  if (!Array.isArray(archived)) {
    return { ok: false, reason: 'workspaceRegistry.state.archivedSessionIds 不是数组（宿主内部形状可能已变）' }
  }
  return { ok: true, ids: archived.filter((id) => typeof id === 'string' && id.length > 0), source: 'workspaceRegistry.state' }
}

/**
 * 读实时会话 header 列表（可选来源，失败只降级为空）。
 * @param {object|undefined} sessions
 * @returns {object[]}
 */
export function readLiveHeaders(sessions) {
  if (sessions === undefined || sessions === null || typeof sessions.list !== 'function') return []
  try {
    const list = sessions.list()
    if (!Array.isArray(list)) return []
    return list.map((s) => s?.header).filter((h) => h !== undefined && h !== null)
  } catch {
    return []
  }
}

/**
 * 读「正在运行」的会话 id 集合。
 *
 * 与 `live` 严格区分：`live` 只表示会话在宿主内存 store 里（打开过即有），
 * 而 `running` 表示其 agent 正在执行。只有后者才该阻止删除。
 *
 * @param {object|undefined} agents
 * @param {string[]} sessionIds 只查这些 id，避免遍历全部 agent
 * @returns {Set<string>}
 */
export function readRunningIds(agents, sessionIds) {
  const out = new Set()
  if (agents === undefined || agents === null || typeof agents.get !== 'function') return out
  for (const id of Array.isArray(sessionIds) ? sessionIds : []) {
    try {
      const agent = agents.get(id)
      if (agent?.status === 'running') out.add(id)
    } catch {
      /* 单个探测失败按"未运行"处理：删除仍会被后续步骤把关 */
    }
  }
  return out
}

/**
 * 读持久化快照列表（可选来源，失败只降级为空）。
 * 注意返回元素形状：0.1.5-rc.2 是 `{header, revision, sizeBytes}`，
 * 由 `archive-list.js` 的 `headerOf()` 统一归一。
 * @param {object|undefined} persistence
 * @returns {Promise<unknown[]>}
 */
export async function readPersistedItems(persistence) {
  if (persistence === undefined || persistence === null || typeof persistence.list !== 'function') return []
  try {
    const list = await persistence.list()
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

/**
 * 尽力而为地解析会话标题。
 *
 * 标题在 DSH 里是**投影**（`sessionTitle` 服务读日志折叠而来），需要 Session 对象；
 * 冷会话要为此装载整条日志，代价过大。所以这里只对**实时**会话尝试，
 * 其余返回 null，由 UI 退回显示 id。
 *
 * 已知限制：归档会话多为冷会话 → 标题常为 null。这是刻意取舍
 * （不让"列个表"变成"把每份日志都读一遍"）。后续若要标题，
 * 优先查投影缓存而非重放日志。
 *
 * @param {object|undefined} sessionTitle
 * @param {object|undefined} sessions
 * @param {object[]} liveHeaders
 * @returns {Map<string,string>}
 */
export function resolveTitles(sessionTitle, sessions, liveHeaders) {
  const out = new Map()
  if (sessionTitle === undefined || typeof sessionTitle.get !== 'function') return out
  if (sessions === undefined || typeof sessions.get !== 'function') return out
  for (const header of liveHeaders) {
    try {
      const session = sessions.get(header.id)
      if (session === undefined) continue
      const snapshot = sessionTitle.get(session)
      const title = snapshot?.title
      if (typeof title === 'string' && title.length > 0) out.set(header.id, title)
    } catch {
      /* 单个失败不影响整体 */
    }
  }
  return out
}

/**
 * 一次 list 调用最多为多少个会话做标题回填。
 *
 * 冷会话的标题只能通过 `sessionQuery.observeSession()` 取得，而它在缓存未命中时
 * 会**读整条日志**。为避免"打开一个页面就把几十份日志读一遍"，这里设上限：
 * 本次回到最前面 N 个，其余的等下次调用（组件的 5 秒轮询会逐步补齐）。
 */
const MAX_TITLE_LOOKUPS_PER_CALL = 24

/**
 * 解析归档会话标题：先取实时（权威），再为**冷会话**回填。
 *
 * 为什么必须回填冷会话：标题是投影，删除时我们会清掉投影缓存行（防幽灵摘要），
 * 恢复后该行不复存在 —— 若只认实时会话，循环一次「归档→删除→恢复」就会丢标题。
 * 而标题的**真源在会话日志里**（`session/title` 事件），`observeSession` 能把它折出来。
 *
 * @param {object} ctx
 * @param {string[]} sessionIds 需要标题的会话 id（按优先级）
 * @param {object[]} liveHeaders
 * @param {Map<string,string>} liveTitles 已由实时路径解析出的标题
 * @returns {Promise<{titles: Map<string,string>, looked: number, capped: boolean}>}
 */
async function backfillColdTitles(ctx, sessionIds, liveHeaders, liveTitles) {
  const titles = new Map(liveTitles)
  const query = ctx.get('sessionQuery')
  if (query === undefined || typeof query.observeSession !== 'function') {
    return { titles, looked: 0, capped: false }
  }

  const liveIds = new Set(liveHeaders.map((h) => h.id))
  const pending = sessionIds.filter((id) => !titles.has(id) && !liveIds.has(id))
  const capped = pending.length > MAX_TITLE_LOOKUPS_PER_CALL
  const batch = pending.slice(0, MAX_TITLE_LOOKUPS_PER_CALL)

  let looked = 0
  for (const id of batch) {
    try {
      const observation = await query.observeSession(id)
      const value = observation?.projections?.values?.title
      looked++
      if (typeof value === 'string' && value.length > 0) titles.set(id, value)
      // observation 必须释放，否则会占住观测资源
      if (observation !== null && typeof observation === 'object'
          && typeof observation[Symbol.dispose] === 'function') {
        observation[Symbol.dispose]()
      }
    } catch (error) {
      ctx.logger.warn(`[${name}] 解析标题失败 ${id}: ${String(error?.message ?? error)}`)
    }
  }
  return { titles, looked, capped }
}

/**
 * 解析单个会话的标题（用于写入回收站元数据）。
 *
 * 回收站里的条目也要显示名称，所以必须在**删除前**把标题取下来存进 sidecar ——
 * 因为删除后该会话就只剩回收站里那份文件，而它的标题投影可能已经不在缓存里。
 *
 * 优先实时会话（零开销）；冷会话退回 `observeSession()`。取不到就返回 null。
 *
 * @param {object} ctx
 * @param {string} sessionId
 * @param {object|undefined} liveSession
 * @returns {Promise<string|null>}
 */
async function resolveOneTitle(ctx, sessionId, liveSession) {
  const sessionTitle = ctx.get('sessionTitle')
  if (liveSession !== undefined && sessionTitle !== undefined && typeof sessionTitle.get === 'function') {
    try {
      const snapshot = sessionTitle.get(liveSession)
      if (typeof snapshot?.title === 'string' && snapshot.title.length > 0) return snapshot.title
    } catch { /* 落入下面的观测路径 */ }
  }
  const query = ctx.get('sessionQuery')
  if (query === undefined || typeof query.observeSession !== 'function') return null
  try {
    const observation = await query.observeSession(sessionId)
    try {
      const value = observation?.projections?.values?.title
      return typeof value === 'string' && value.length > 0 ? value : null
    } finally {
      if (observation !== null && typeof observation === 'object'
          && typeof observation[Symbol.dispose] === 'function') observation[Symbol.dispose]()
    }
  } catch {
    return null
  }
}

/**
 * 组装归档列表响应（P1）。
 * @param {object} ctx
 * @returns {Promise<Response>}
 */
async function handleList(ctx) {
  const registry = ctx.get('workspaceRegistry')
  const archived = readArchivedIds(registry)
  if (archived.ok === false) {
    // fail-loud：明说依赖不可用，而不是回一个"空列表"让人以为归档没了
    ctx.logger.error(`[${name}] 列出归档失败：${archived.reason}`)
    return json(503, { error: 'state-unreadable', reason: archived.reason, source: 'workspaceRegistry.state' })
  }

  const sessions = ctx.get('sessions')
  const persistence = ctx.get('sessionPersistence')
  const liveHeaders = readLiveHeaders(sessions)
  const persistedItems = await readPersistedItems(persistence)

  const liveTitles = resolveTitles(ctx.get('sessionTitle'), sessions, liveHeaders)

  // 冷会话标题回填：删除会清掉投影缓存行，只认实时会话会让标题在
  // 「归档→删除→恢复」循环后丢失。标题真源在日志里，这里按需折出来。
  const backfilled = await backfillColdTitles(
    ctx,
    archived.ids,
    liveHeaders,
    liveTitles,
  )
  const titles = backfilled.titles

  // running = 该会话的 agent 正在执行。与 live（在内存 store 里）是两件事：
  // 打开过某个归档会话会让它变 live，但那并不妨碍删除；只有正在跑才该拒绝。
  const runningIds = readRunningIds(ctx.get('agents'), archived.ids)

  const { items, summary } = resolveArchivedSessions({
    archivedIds: archived.ids,
    liveHeaders,
    persistedItems,
    titles,
    runningIds,
  })

  // 顺带报告"磁盘上有、但没有任何工作区记账"的会话（旧版本恢复留下的后果）
  const orphanReport = await detectOrphans(ctx).catch(() => ({ orphans: [] }))

  return json(200, {
    ok: true,
    items,
    summary,
    orphans: orphanReport.orphans ?? [],
    sources: {
      archived: archived.source,
      live: liveHeaders.length,
      persisted: persistedItems.length,
      titles: titles.size,
      titlesLiveOnly: liveTitles.size,
      titleLookups: backfilled.looked,
      titleCapped: backfilled.capped,
    },
  })
}

/**
 * 判断会话是否还存在（实时或持久化）。用于识别**陈旧归档标记**。
 *
 * 刻意保守：**只有确定不存在才返回 false**。持久化列举失败时返回 true，
 * 以免把"暂时读不到"误判成"已删除"从而清掉有效的归档标记。
 *
 * @param {object} ctx
 * @param {string} sessionId
 * @returns {Promise<boolean>}
 */
async function makeSessionKnown(ctx) {
  const sessions = ctx.get('sessions')
  const persistence = ctx.get('sessionPersistence')

  let persistedIds = null
  if (persistence !== undefined && typeof persistence.list === 'function') {
    try {
      const list = await persistence.list()
      if (Array.isArray(list)) {
        persistedIds = new Set()
        for (const item of list) {
          const header = headerOf(item)
          if (header !== null) persistedIds.add(header.id)
        }
      }
    } catch {
      persistedIds = null // 读不到 → 不下断言
    }
  }

  return (sessionId) => {
    if (sessions !== undefined && typeof sessions.get === 'function') {
      try {
        if (sessions.get(sessionId) !== undefined) return true
      } catch {
        return true // 探测失败 → 保守认为存在
      }
    }
    if (persistedIds === null) return true // 列举失败 → 保守认为存在
    return persistedIds.has(sessionId)
  }
}

/**
 * 恢复归档（P2）。
 * @param {object} ctx
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function handleUnarchive(ctx, request) {
  const body = await readJsonBody(request)
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : undefined
  if (sessionId === undefined || sessionId.length === 0) {
    return json(400, { error: 'bad-request', detail: 'sessionId required' })
  }

  const registry = ctx.get('workspaceRegistry')
  const sessionKnown = await makeSessionKnown(ctx)

  const result = await unarchiveSession(
    { registry, sessionKnown },
    sessionId,
    { allowStale: body?.allowStale === true },
  )

  if (result.ok === false) {
    const status = result.reason === UNARCHIVE_ERROR.REGISTRY_UNREADABLE ? 503
      : result.reason === UNARCHIVE_ERROR.SESSION_GONE ? 409
        : result.reason === UNARCHIVE_ERROR.PERSIST_FAILED ? 500
          : 400
    if (status >= 500) ctx.logger.error(`[${name}] 恢复失败 ${sessionId}: ${result.reason} ${result.detail ?? ''}`)
    return json(status, { error: result.reason, detail: result.detail ?? null, sessionId })
  }

  return json(200, {
    ok: true,
    sessionId,
    changed: result.changed,
    archivedSessionIds: result.next,
  })
}

/**
 * 读请求体 JSON。
 *
 * `registerFetchRoute` 声明了 `requestBody: 'buffered'`，但为稳妥起见
 * 仍然对空体/非法 JSON 容错 —— 无体时返回 undefined 而不是抛错。
 *
 * @param {Request} request
 * @returns {Promise<object | undefined>}
 */
async function readJsonBody(request) {
  try {
    if (typeof request?.text !== 'function') return undefined
    const text = await request.text()
    if (typeof text !== 'string' || text.trim().length === 0) return undefined
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 删除流水线（P3）
// ═══════════════════════════════════════════════════════════════════════════
// 时序是本项目最容易做错的地方，这里把顺序连同理由一起写下来。
//
//   [1] 前置检查：运行中会话拒绝删除；定位候选目录（多候选，逐个 stat）
//   [2] 身份校验：目录名必须是 encodeSegment(sessionId)、必须真的是目录、
//       必须非符号链接、必须含可识别的代际日志 —— 任何一条不成立即放弃
//   [3] 容量检查：超限则报错，**绝不自动淘汰**
//   [4] 写 sidecar 元数据 + 逐文件搬入回收站（可反向回滚）← **提交点**
//   [5] 发布浏览器移除通知
//   [6] 清投影缓存
//   [7] 摘除工作区归属
//   [8] 从归档集合移除（走 registry 串行队列）
//
// 关于 [4] 与 [5] 的顺序，**必须分实时/冷两条路**：
//
//   · 冷会话：**先发 api-session/removed，再搬文件**。
//     宿主真正的 dispose 生命周期（persistence.open → fromRestore →
//     enter/announce/detach）需要读日志，文件搬走之后就读不到了。
//     而直接 emit `api-session/removed` 不依赖文件，且这正是
//     archive-manager 在用的方式。搬完文件后该会话不在 sessions 也不在
//     持久化里，不会复活。
//
//   · 实时会话：**先搬文件，再走真正的 dispose**。
//     `sessions.detachEntered()` 只操作内存对象，需要文件已不在
//     （否则 stat 复核会认为"还活着"）。它同时发出 `session/disposed`
//     与 `api-session/removed`。
//
// [5]-[8] 全部 fail-soft：单个失败只告警，不阻断整体（否则会出现
// "文件已进回收站、UI 却还显示"的更糟状态）。

/**
 * 找出当前记账中包含该会话的工作区。
 * @param {object|undefined} registry
 * @param {string} sessionId
 * @returns {{id: string, path: string|null}|null}
 */
function findOwningWorkspace(registry, sessionId) {
  if (registry === undefined || typeof registry.list !== 'function') return null
  let list
  try { list = registry.list() } catch { return null }
  if (!Array.isArray(list)) return null
  for (const workspace of list) {
    const ids = workspace?.record?.sessionIds
    if (Array.isArray(ids) && ids.includes(sessionId)) {
      return { id: workspace.id ?? null, path: workspace.record?.path ?? null }
    }
  }
  return null
}

/**
 * 把恢复回来的会话**重新挂回工作区记账**。
 *
 * 这是删除路径 `detachFromWorkspaces()` 的逆操作，缺了它就会出现
 * "文件已恢复、侧边栏却看不到" —— 因为侧边栏按工作区成员渲染。
 *
 * 优先用删除时记录的 workspaceId；老条目没有该字段时退回按 cwd 解析。
 * `attachSession` 会读会话头校验 cwd，因此必须在**文件已搬回之后**调用。
 *
 * @param {object} ctx
 * @param {string} sessionId
 * @param {object} meta 该条目的 sidecar 元数据
 * @returns {Promise<{ok: boolean, via: string, detail?: string}>}
 */
async function reattachToWorkspace(ctx, sessionId, meta) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined || typeof registry.get !== 'function') {
    return { ok: false, via: 'none', detail: 'workspaceRegistry 不可用' }
  }

  // 已经挂回去了？（例如并发恢复或宿主自行重建了索引）
  if (findOwningWorkspace(registry, sessionId) !== null) {
    return { ok: true, via: 'already-attached' }
  }

  const recordedId = meta?.original?.workspaceId ?? null
  const cwd = meta?.header?.cwd ?? null

  let workspace = null
  let via = 'none'
  if (typeof recordedId === 'string' && recordedId.length > 0) {
    try {
      workspace = registry.get(recordedId) ?? null
      if (workspace !== null) via = 'recorded-workspace-id'
    } catch { /* 落回按路径解析 */ }
  }
  if (workspace === null && typeof cwd === 'string' && cwd.length > 0
      && typeof registry.resolveByPath === 'function') {
    try {
      workspace = await registry.resolveByPath(cwd)
      if (workspace !== undefined && workspace !== null) via = 'resolved-by-cwd'
    } catch (error) {
      return { ok: false, via: 'resolve-by-cwd', detail: String(error?.message ?? error) }
    }
  }
  if (workspace === undefined || workspace === null) {
    return { ok: false, via, detail: '找不到该会话原本所属的工作区' }
  }
  if (typeof workspace.attachSession !== 'function') {
    return { ok: false, via, detail: '工作区实体缺少 attachSession' }
  }

  try {
    await workspace.attachSession(sessionId)
  } catch (error) {
    return { ok: false, via, detail: `attachSession 失败：${String(error?.message ?? error)}` }
  }
  return { ok: true, via }
}

/**
 * 检测"磁盘上有、但没有任何工作区记账"的会话。
 *
 * 为什么需要它：删除会把会话从工作区记账里摘除（避免幽灵行），恢复时必须挂回。
 * 0.7.0 之前恢复漏了这一步，于是会话文件回到了原位、侧边栏却看不到 ——
 * 用户完全无从察觉（它不在回收站，也不在归档区，就是"消失"了）。
 * 这里把这类会话找出来，供 UI 明确提示并可一键修复。
 *
 * 只把**本应归属于某个工作区**的会话算作孤立：
 *   · cwd 缺失 → 跳过（这类会话本来就不挂工作区）
 *   · cwd 不对应任何工作区 → 跳过（本来就该显示为未分组）
 *
 * @param {object} ctx
 * @returns {Promise<{orphans: object[], checked: number, reason?: string}>}
 */
export async function detectOrphans(ctx) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined || typeof registry.list !== 'function') {
    return { orphans: [], checked: 0, reason: 'workspaceRegistry 不可用' }
  }

  const persistence = ctx.get('sessionPersistence')
  const persisted = await readPersistedItems(persistence)
  if (persisted.length === 0) return { orphans: [], checked: 0 }

  const accounted = new Set()
  let workspaces = []
  try { workspaces = registry.list() } catch { workspaces = [] }
  if (!Array.isArray(workspaces)) workspaces = []
  for (const workspace of workspaces) {
    const ids = workspace?.record?.sessionIds
    if (Array.isArray(ids)) for (const id of ids) accounted.add(id)
  }

  const orphans = []
  let checked = 0
  for (const item of persisted) {
    const header = headerOf(item)
    if (header === null) continue
    if (accounted.has(header.id)) continue
    const cwd = typeof header.cwd === 'string' && header.cwd.length > 0 ? header.cwd : null
    if (cwd === null) continue
    checked++
    // cwd 是否对应某个工作区？只有"本该有归属"的才算孤立
    let owner = null
    if (typeof registry.resolveByPath === 'function') {
      try { owner = await registry.resolveByPath(cwd) } catch { owner = null }
    }
    if (owner === undefined || owner === null) continue
    orphans.push({
      sessionId: header.id,
      cwd,
      workspaceId: owner.id ?? null,
      workspacePath: owner.record?.path ?? cwd,
      createdAt: typeof header.createdAt === 'number' ? header.createdAt : null,
    })
  }
  return { orphans, checked }
}

/**
 * 把所有孤立会话挂回它们所属的工作区。**幂等**。
 * @param {object} ctx
 * @returns {Promise<{repaired: object[], failed: object[], checked: number, reason?: string}>}
 */
export async function repairOrphans(ctx) {
  const { orphans, checked, reason } = await detectOrphans(ctx)
  if (reason !== undefined) return { repaired: [], failed: [], checked: 0, reason }
  const repaired = []
  const failed = []
  for (const orphan of orphans) {
    const result = await reattachToWorkspace(ctx, orphan.sessionId, {
      original: { workspaceId: orphan.workspaceId },
      header: { cwd: orphan.cwd },
    })
    if (result.ok) repaired.push({ ...orphan, via: result.via })
    else failed.push({ ...orphan, detail: result.detail ?? null })
  }
  return { repaired, failed, checked }
}

/**
 * 从所有工作区的记账里摘除该会话。
 * 用公开的 `WorkspaceEntity.detachSession(id)`；缺失时退回 `mutate`。
 * @param {object} ctx
 * @param {string} sessionId
 */
async function detachFromWorkspaces(ctx, sessionId) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined || typeof registry.list !== 'function') return
  let list
  try {
    list = registry.list()
  } catch {
    return
  }
  if (!Array.isArray(list)) return
  for (const workspace of list) {
    try {
      const ids = workspace?.record?.sessionIds
      if (!Array.isArray(ids) || !ids.includes(sessionId)) continue
      if (typeof workspace.detachSession === 'function') {
        await workspace.detachSession(sessionId)
      } else if (typeof workspace.mutate === 'function') {
        await workspace.mutate((record) => ({
          ...record,
          sessionIds: (Array.isArray(record.sessionIds) ? record.sessionIds : []).filter((id) => id !== sessionId),
        }))
      }
    } catch (error) {
      ctx.logger.warn(`[${name}] 摘除工作区归属失败 ${sessionId}: ${String(error?.message ?? error)}`)
    }
  }
}

/**
 * 通知浏览器"这个会话没了"。
 *
 * 实时会话走宿主真正的 dispose 生命周期（同时发 session/disposed 与
 * api-session/removed）；冷会话直接 emit `api-session/removed`，因为它的
 * 日志可能已经被搬走、无法再 restore 成 Session。
 *
 * @param {object} ctx
 * @param {string} sessionId
 * @param {{filesMoved: boolean}} options
 */
async function publishSessionRemoved(ctx, sessionId, options = {}) {
  const sessions = ctx.get('sessions')

  // 实时会话：文件已搬走，走 detachEntered（只需内存对象）
  if (options.filesMoved === true && sessions !== undefined && typeof sessions.get === 'function') {
    let live
    try {
      live = sessions.get(sessionId)
    } catch {
      live = undefined
    }
    if (live !== undefined && typeof sessions.liveEntryFor === 'function' && typeof sessions.detachEntered === 'function') {
      try {
        const entry = sessions.liveEntryFor(live)
        if (entry !== undefined) {
          sessions.detachEntered(entry)
          return
        }
      } catch (error) {
        ctx.logger.warn(`[${name}] detachEntered 失败 ${sessionId}: ${String(error?.message ?? error)}`)
      }
    }
  }

  // 冷会话 / 兜底：直接发移除事件（不依赖文件是否还在）
  try {
    ctx.emit('api-session/removed', sessionId)
  } catch (error) {
    ctx.logger.warn(`[${name}] 发布 api-session/removed 失败 ${sessionId}: ${String(error?.message ?? error)}`)
  }
}

/**
 * 定位并校验会话目录。多候选逐个 stat，**第一个通过校验的才用**。
 * @param {object} ctx
 * @param {string} sessionId
 * @param {string|null} cwd
 * @param {string|undefined} root
 * @returns {Promise<{ok: true, dirPath: string, dirName: string, logFileName: string} | {ok: false, reason: string, detail: string}>}
 */
async function locateVerifiedSessionDir(ctx, sessionId, cwd, root) {
  const candidates = candidateSessionDirs({
    root,
    cwd,
    sessionId,
    originalSessionDir: undefined,
  })
  if (candidates.length === 0) {
    return { ok: false, reason: TRASH_ERROR.DIR_NOT_FOUND, detail: '无法推导候选目录（缺少 root 与 cwd）' }
  }

  const failures = []
  for (const dirPath of candidates) {
    let info
    try {
      info = await statForVerify(dirPath)
    } catch (error) {
      failures.push(`${dirPath}: stat 失败 ${String(error?.message ?? error)}`)
      continue
    }
    const filenames = info.exists && info.isDirectory ? await listFileNames(dirPath).catch(() => []) : []
    const verdict = verifyDeletableSessionDir({
      sessionId,
      dirPath,
      dirName: dirPath.split('/').pop(),
      exists: info.exists,
      isDirectory: info.isDirectory,
      isSymbolicLink: info.isSymbolicLink,
      filenames,
    })
    if (verdict.ok === true) {
      return { ok: true, dirPath, dirName: dirPath.split('/').pop(), logFileName: verdict.logFileName }
    }
    failures.push(`${dirPath}: ${verdict.detail}`)
  }

  return {
    ok: false,
    reason: TRASH_ERROR.IDENTITY_MISMATCH,
    detail: `没有候选目录通过身份校验：\n  ${failures.join('\n  ')}`,
  }
}

/**
 * 删除一个已归档会话到回收站。
 * @param {object} ctx
 * @param {string} sessionId
 * @param {{limits?: object, now?: number}} [options]
 * @returns {Promise<object>}
 */
async function deleteSessionToTrash(ctx, sessionId, options = {}) {
  const now = options.now ?? Date.now()
  const limits = options.limits ?? archiveLimits()
  const registry = ctx.get('workspaceRegistry')
  const sessions = ctx.get('sessions')
  const persistence = ctx.get('sessionPersistence')

  // [1] 前置检查：运行中拒绝
  if (sessions !== undefined && typeof sessions.get === 'function') {
    const live = sessions.get(sessionId)
    const agents = ctx.get('agents')
    const agent = agents !== undefined && typeof agents.get === 'function' ? agents.get(sessionId) : undefined
    if (agent?.status === 'running' || (live !== undefined && agent?.status === 'running')) {
      return { ok: false, reason: TRASH_ERROR.SESSION_RUNNING, detail: '会话正在运行，请先暂停后再删除' }
    }
  }

  // 取 header（用于 cwd / createdAt 与元数据）
  let header = null
  try {
    const list = persistence !== undefined && typeof persistence.list === 'function' ? await persistence.list() : []
    for (const item of Array.isArray(list) ? list : []) {
      const h = headerOf(item)
      if (h !== null && h.id === sessionId) { header = h; break }
    }
  } catch {
    header = null
  }
  if (header === null && sessions !== undefined && typeof sessions.get === 'function') {
    const live = sessions.get(sessionId)
    if (live?.header !== undefined) header = live.header
  }

  const root = await resolvePersistenceRoot(persistence)
  const located = await locateVerifiedSessionDir(ctx, sessionId, header?.cwd ?? null, root)
  if (located.ok === false) return located

  // [3] 容量检查（绝不自动淘汰）
  const { entries } = await listEntries(trashRoot()).catch(() => ({ entries: [] }))
  const sizeBytes = await dirSizeBytes(located.dirPath).catch(() => 0)
  const capacity = checkCapacity({ entries, incomingBytes: sizeBytes, limits })
  if (capacity.ok === false) return capacity

  // [4] 写元数据 + 搬运（提交点）
  // 记录归属工作区：删除会把它从工作区记账里摘掉，恢复时必须据此挂回
  const owner = findOwningWorkspace(registry, sessionId)

  // 删除前取下标题：回收站条目也要显示名称
  const liveSession = sessions !== undefined && typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined
  const title = await resolveOneTitle(ctx, sessionId, liveSession)

  await ensureTrashRoot(trashRoot())
  const meta = buildMeta({
    sessionId,
    deletedAt: now,
    originalSessionDir: located.dirPath,
    projectDir: located.dirPath.split('/').slice(0, -1).join('/'),
    header: header ?? {},
    title,
    sizeBytes,
    logFileName: located.logFileName,
    logMtimeMs: null,
    workspaceId: owner?.id ?? null,
    workspacePath: owner?.path ?? null,
  })

  const moved = await moveSessionDirToTrash({
    sessionDir: located.dirPath,
    trashRoot: trashRoot(),
    deletedAt: now,
    sessionId,
    meta,
  })
  if (moved.ok === false) {
    // 未搬成功 → 什么都没变，如实报错
    return { ok: false, reason: TRASH_ERROR.IO_FAILED, detail: moved.detail, rolledBack: moved.rolledBack }
  }

  // [5] 通知浏览器（实时会话此时文件已搬走，走 detachEntered）
  await publishSessionRemoved(ctx, sessionId, { filesMoved: true })

  // [6] **刻意不清投影缓存**
  //
  // 删除时清缓存曾被当作"防幽灵摘要"的安全措施，但经过核对它是**不必要**的：
  // 会话列表只由 `sessionQuery.listSessions()`（磁盘 ∪ 内存）产生，投影缓存
  // 仅用于**给已在列表里的条目补充投影**（summaryFor / summarizeCold），
  // 无法凭空造出一个已删会话。
  //
  // 而它是有害的：同一行缓存里还存着 `title`、`sessionListMetadata` 等派生数据。
  // 清掉之后，恢复回来的会话在宿主列表里就**没有投影**了 —— 侧边栏名称退化成
  // 工作区/项目名，且要点开、甚至硬刷新页面才恢复（因为客户端拿不到标题投影）。
  // 缓存行本身是按 identity/revision 绑定的，同 id 换一份日志会自动失效，所以留着安全。

  // [7] 摘除工作区归属
  await detachFromWorkspaces(ctx, sessionId)

  // [8] 从归档集合移除（走 registry 串行队列）
  let unarchived = null
  try {
    unarchived = await unarchiveSession({ registry }, sessionId, { allowStale: true })
  } catch (error) {
    ctx.logger.warn(`[${name}] 从归档集合移除失败 ${sessionId}: ${String(error?.message ?? error)}`)
  }

  return {
    ok: true,
    sessionId,
    entryDir: moved.entryDir,
    movedFiles: moved.movedFiles,
    sizeBytes,
    unarchived: unarchived?.ok === true ? unarchived.changed : null,
    detachedFromWorkspace: owner?.id ?? null,
  }
}

/**
 * 解析持久化后端的 root（用于推导会话目录）。
 *
 * `root` 是 jsonl 后端的**内部字段**，故做能力探测：拿不到就返回 undefined，
 * 由 `locateVerifiedSessionDir` 明确报"无法推导候选目录"而不是瞎猜路径。
 *
 * @param {object|undefined} persistence
 * @returns {Promise<string|undefined>}
 */
async function resolvePersistenceRoot(persistence) {
  if (persistence === undefined || persistence === null) return undefined
  const root = persistence.root
  return typeof root === 'string' && root.length > 0 ? root : undefined
}

// ── 路由处理器 ────────────────────────────────────────────────────────────

/** 列出回收站（P3）。 */
async function handleTrashList(ctx) {
  const limits = archiveLimits()
  const { entries, broken } = await listEntries(trashRoot())
  const summary = summarizeTrash(entries, limits)
  return json(200, { ok: true, entries, broken, summary, limits })
}

/** 删除一个已归档会话到回收站（P3）。 */
async function handleDelete(ctx, request) {
  const body = await readJsonBody(request)
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : undefined
  if (sessionId === undefined || sessionId.length === 0) {
    return json(400, { error: TRASH_ERROR.BAD_REQUEST, detail: 'sessionId required' })
  }
  const result = await deleteSessionToTrash(ctx, sessionId)
  if (result.ok === false) {
    const status = result.reason === TRASH_ERROR.SESSION_RUNNING ? 409
      : result.reason === TRASH_ERROR.DIR_NOT_FOUND ? 404
        : result.reason === TRASH_ERROR.IDENTITY_MISMATCH ? 409
          : result.reason === TRASH_ERROR.TRASH_FULL || result.reason === TRASH_ERROR.TOO_LARGE || result.reason === TRASH_ERROR.DISK_LOW ? 507
            : 500
    ctx.logger.error(`[${name}] 删除失败 ${sessionId}: ${result.reason} ${result.detail ?? ''}`)
    return json(status, { error: result.reason, detail: result.detail ?? null, sessionId })
  }
  return json(200, { ok: true, ...result })
}

/** 从回收站恢复到原位置（P3）。 */
async function handleRestore(ctx, request) {
  const body = await readJsonBody(request)
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : undefined
  if (sessionId === undefined || sessionId.length === 0) {
    return json(400, { error: TRASH_ERROR.BAD_REQUEST, detail: 'sessionId required' })
  }

  const { entries } = await listEntries(trashRoot())
  const entry = entries.find((e) => e.sessionId === sessionId)
  if (entry === undefined) {
    return json(404, { error: TRASH_ERROR.ENTRY_NOT_FOUND, detail: `回收站里没有 ${sessionId}`, sessionId })
  }

  const targetDir = entry.originalSessionDir
  if (typeof targetDir !== 'string' || targetDir.length === 0) {
    return json(500, { error: TRASH_ERROR.IO_FAILED, detail: '条目缺少原始路径，无法恢复', sessionId })
  }

  // 恢复前检查：目标是否被占 / id 是否被复用
  const targetInfo = await statForVerify(targetDir).catch(() => ({ exists: false }))
  const verdict = checkRestorable({
    meta: { original: { sessionDir: targetDir }, header: { createdAt: entry.createdAt } },
    targetExists: targetInfo.exists === true,
    existingCreatedAt: undefined,
  })
  if (verdict.ok === false) {
    return json(409, { error: verdict.reason, detail: verdict.detail, sessionId })
  }

  const restored = await restoreEntryFromTrash({ entryDir: entry.entryDir, targetDir })
  if (restored.ok === false) {
    return json(500, { error: TRASH_ERROR.IO_FAILED, detail: restored.detail, sessionId })
  }

  // ★ 关键：把会话重新挂回工作区记账。
  // 删除时做了 detachSession，若这里不 attachSession，文件虽回到原位，
  // 侧边栏却不会显示它 —— 表现为"恢复后会话不见了"。
  const reattached = await reattachToWorkspace(ctx, sessionId, {
    original: { workspaceId: entry.workspaceId ?? null },
    header: { cwd: entry.cwd ?? null },
  })
  if (reattached.ok === false) {
    ctx.logger.warn(`[${name}] 恢复 ${sessionId} 后未能挂回工作区（${reattached.via}）：${reattached.detail ?? ''}`)
  }

  return json(200, {
    ok: true,
    sessionId,
    restoredFiles: restored.restoredFiles,
    targetDir,
    reattached: reattached.ok,
    reattachVia: reattached.via,
    ...(reattached.ok ? {} : { reattachDetail: reattached.detail ?? null }),
  })
}

/** 修复孤立会话：把它们挂回所属工作区（幂等、非破坏）。 */
async function handleRepairOrphans(ctx) {
  const result = await repairOrphans(ctx)
  if (result.reason !== undefined) {
    return json(503, { error: 'state-unreadable', detail: result.reason })
  }
  if (result.repaired.length > 0) {
    ctx.logger.info(`[${name}] 修复了 ${result.repaired.length} 个孤立会话`)
  }
  return json(200, {
    ok: true,
    repairedCount: result.repaired.length,
    failedCount: result.failed.length,
    repaired: result.repaired,
    failed: result.failed,
  })
}

/** 彻底清除回收站条目（不可逆）。 */
async function handlePurge(ctx, request) {
  const body = await readJsonBody(request)
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : undefined
  if (sessionId === undefined || sessionId.length === 0) {
    return json(400, { error: TRASH_ERROR.BAD_REQUEST, detail: 'sessionId required' })
  }

  const { entries } = await listEntries(trashRoot())
  const entry = entries.find((e) => e.sessionId === sessionId)
  if (entry === undefined) {
    return json(404, { error: TRASH_ERROR.ENTRY_NOT_FOUND, detail: `回收站里没有 ${sessionId}`, sessionId })
  }

  const purged = await purgeEntry(entry.entryDir)
  if (purged.ok === false) {
    ctx.logger.error(`[${name}] 彻底清除失败 ${sessionId}: ${purged.detail}`)
    return json(500, { error: TRASH_ERROR.IO_FAILED, detail: purged.detail, sessionId })
  }
  return json(200, { ok: true, sessionId, purged: true, freedBytes: entry.sizeBytes })
}

/**
 * 批量彻底清除 —— **仅在使用者显式确认后**执行。
 *
 * 为什么必须显式：回收站的全部意义就是"删错了还能找回来"。若它在用户不知情时
 * 自动丢掉最旧条目，等于把恢复能力变成随机抽奖。所以本端点只做"执行确认过的
 * 清理"，绝不自己做淘汰决策。
 *
 * 两种选择方式（二选一）：
 *   · `sessionIds: string[]` —— 精确指定（UI 的逐条确认）
 *   · `oldestCount: number`  —— 清理最旧的 N 条（UI 的"清理最旧 N 条"按钮）
 * 另可传 `onlyExpired: true` 只清理已超期条目。
 *
 * @param {object} ctx
 * @param {Request} request
 */
async function handlePurgeMany(ctx, request) {
  const body = await readJsonBody(request)
  const limits = archiveLimits()
  const { entries } = await listEntries(trashRoot())
  const summary = summarizeTrash(entries, limits)

  let targets = []
  if (Array.isArray(body?.sessionIds)) {
    const wanted = new Set(body.sessionIds.filter((id) => typeof id === 'string' && id.length > 0))
    targets = entries.filter((e) => wanted.has(e.sessionId))
  } else if (body?.onlyExpired === true) {
    const expired = new Set(summary.expiring.map((e) => e.sessionId))
    targets = entries.filter((e) => expired.has(e.sessionId))
  } else if (Number.isFinite(body?.oldestCount) && body.oldestCount > 0) {
    targets = suggestPurgeCandidates(entries, body.oldestCount)
  } else {
    return json(400, {
      error: TRASH_ERROR.BAD_REQUEST,
      detail: '需要 sessionIds、oldestCount 或 onlyExpired 之一（本端点绝不自行决定淘汰谁）',
    })
  }

  const purged = []
  const failures = []
  for (const entry of targets) {
    const result = await purgeEntry(entry.entryDir)
    if (result.ok === true) purged.push({ sessionId: entry.sessionId, freedBytes: entry.sizeBytes })
    else failures.push({ sessionId: entry.sessionId, detail: result.detail })
  }

  return json(200, {
    ok: true,
    purgedCount: purged.length,
    failedCount: failures.length,
    purged,
    failures,
  })
}

function json(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}
