/**
 * dsh-session-archive —— 回收站纯逻辑
 * ===========================================================================
 * 本模块**不做任何 I/O**：只负责布局、元数据、容量策略与**删除前的身份校验规则**。
 * 真正的文件操作在 lib/trash-io.js 与 lib/index.js 里，且每一步都必须
 * 先用本模块的校验函数确认"这真的是我要动的那个会话目录"，再动手。
 *
 * ## 布局
 *   ~/.dsh/session-archive/trash/
 *     └── <epochMillis>-<sessionId>/          # 时间戳前缀 = 删除序，天然有序
 *         ├── session.v<N>.jsonl[.zstd]       # 原会话目录整体搬入
 *         ├── session.lock
 *         └── .dsh-archive-meta.json          # 条目自带元数据（随目录走）
 *
 * **为什么元数据做成条目自带的 sidecar 而不是集中式索引**：
 * 条目自包含 ⇒ 单条可整体搬移/恢复/删除；索引损坏也能靠扫目录重建。
 * 这直接缓解了"元数据与实体不一致"那一类问题。
 *
 * **为什么回收站不能放在 sessions/ 内**：宿主扫描器不过滤点目录，且
 * `listArtifacts` 对重复 session id 会直接 throw —— 回收站里只要有一个 id
 * 在别处也存在，DSH 就起不来。详见 README。
 */

import { encodeSegment, parseGenerationLogFilename } from './paths.js'

/** sidecar 元数据文件名（点开头，避免被误当会话工件）。 */
export const META_FILENAME = '.dsh-archive-meta.json'

/** 元数据 schema 版本，供未来迁移。 */
export const META_SCHEMA = 1

/** 容量与保留策略默认值。**任何超限都不会自动删除**，只做统计与提示。 */
export const DEFAULT_LIMITS = Object.freeze({
  /** 回收站最多保留多少条 */
  maxEntries: 100,
  /** 回收站总体积上限（字节） */
  maxBytes: 2 * 1024 * 1024 * 1024,
  /** 条目保留时长（天）；超期只标记，不自动清理 */
  retentionDays: 30,
  /** 单条体积上限（字节）；超过则拒绝入回收站 */
  maxSingleBytes: 200 * 1024 * 1024,
})

/** 删除/恢复/清理的失败原因码（供 UI 分类提示）。 */
export const TRASH_ERROR = {
  BAD_REQUEST: 'bad-request',
  /** 会话正在运行，拒绝删除 */
  SESSION_RUNNING: 'session-running',
  /** 定位不到会话目录 */
  DIR_NOT_FOUND: 'dir-not-found',
  /** 目录存在但身份不符（**拒绝动手**，防误删） */
  IDENTITY_MISMATCH: 'identity-mismatch',
  /** 单条超过体积上限 */
  TOO_LARGE: 'too-large',
  /** 回收站已满（需人工清理，**不自动淘汰**） */
  TRASH_FULL: 'trash-full',
  /** 磁盘可用空间不足 */
  DISK_LOW: 'disk-low',
  /** 回收站里没有该条目 */
  ENTRY_NOT_FOUND: 'entry-not-found',
  /** 恢复时发现同 id 已被占用（原件已重建） */
  ID_REUSED: 'id-reused',
  /** 恢复时目标位置已被占 */
  TARGET_OCCUPIED: 'target-occupied',
  /** 文件操作失败 */
  IO_FAILED: 'io-failed',
  /** 宿主依赖不可读 */
  STATE_UNREADABLE: 'state-unreadable',
}

/**
 * 生成条目目录名：`<epochMillis>-<sessionId>`。
 *
 * 用固定宽度的时间戳前缀有两个好处：删除序可从目录名直接得出（无需解析 JSON
 * 即可排序/展示），且 sessionId 仍在名字里便于反查。
 *
 * @param {number} deletedAt epoch 毫秒
 * @param {string} sessionId
 * @returns {string}
 */
export function entryDirName(deletedAt, sessionId) {
  if (!Number.isFinite(deletedAt) || deletedAt < 0) throw new Error('entryDirName: deletedAt 必须是非负有限数')
  if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('entryDirName: sessionId 必填')
  // 用 encodeSegment 保证名字是安全单段（id 含 / 之类时不会逃出目录）
  return `${Math.floor(deletedAt)}-${encodeSegment(sessionId)}`
}

/**
 * 解析条目目录名。
 * @param {string} name
 * @returns {{deletedAt: number, encodedId: string} | null}
 */
export function parseEntryDirName(name) {
  if (typeof name !== 'string') return null
  const m = /^(\d{1,16})-(.+)$/.exec(name)
  if (m === null) return null
  const deletedAt = Number(m[1])
  if (!Number.isSafeInteger(deletedAt) || deletedAt < 0) return null
  if (m[2].length === 0) return null
  return { deletedAt, encodedId: m[2] }
}

/**
 * 组装 sidecar 元数据。
 *
 * `original.sessionDir` 是**必须**记录的：会话目录名依赖宿主的路径编码
 * （`projectKey`/`encodeSegment`），一旦宿主改编码，`cwd → 目录` 就不再等价。
 * 记下实际路径，恢复时才可靠。
 *
 * `header.createdAt` 是**身份见证**：恢复时用来判断"这个 id 是否被复用"。
 *
 * @param {object} input
 * @returns {object}
 */
export function buildMeta(input) {
  const {
    sessionId, deletedAt, originalSessionDir, projectDir, header,
    title = null, sizeBytes = 0, logFileName = null, logMtimeMs = null,
    workspaceId = null, workspacePath = null,
  } = input ?? {}
  if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('buildMeta: sessionId 必填')
  if (typeof originalSessionDir !== 'string' || originalSessionDir.length === 0) {
    throw new Error('buildMeta: originalSessionDir 必填（恢复的目标位置）')
  }
  const cwd = header !== undefined && header !== null && typeof header.cwd === 'string' ? header.cwd : null
  const createdAt = header !== undefined && header !== null && typeof header.createdAt === 'number' ? header.createdAt : null
  return {
    schema: META_SCHEMA,
    sessionId,
    deletedAt: Number.isFinite(deletedAt) ? Math.floor(deletedAt) : Date.now(),
    original: {
      sessionDir: originalSessionDir,
      projectDir: typeof projectDir === 'string' && projectDir.length > 0 ? projectDir : null,
      // 删除时该会话所属的工作区。**恢复必须据此把它重新挂回工作区记账**，
      // 否则文件虽已回到原位，侧边栏却看不到它（删除时做了 detachSession，
      // 逆操作必须补上 attachSession）。
      workspaceId: typeof workspaceId === 'string' && workspaceId.length > 0 ? workspaceId : null,
      workspacePath: typeof workspacePath === 'string' && workspacePath.length > 0 ? workspacePath : null,
    },
    header: { cwd, createdAt, isSeeded: header?.isSeeded === true },
    title: typeof title === 'string' && title.length > 0 ? title : null,
    sizeBytes: Number.isFinite(sizeBytes) && sizeBytes >= 0 ? Math.floor(sizeBytes) : 0,
    logFileName: typeof logFileName === 'string' && logFileName.length > 0 ? logFileName : null,
    logMtimeMs: Number.isFinite(logMtimeMs) ? Math.floor(logMtimeMs) : null,
  }
}

/**
 * 校验 sidecar 元数据形状。坏掉的元数据**不能**参与恢复（宁可不做）。
 * @param {unknown} value
 * @returns {{ok: true, meta: object} | {ok: false, reason: string}}
 */
export function validateMeta(value) {
  if (value === null || typeof value !== 'object') return { ok: false, reason: 'meta 不是对象' }
  if (typeof value.sessionId !== 'string' || value.sessionId.length === 0) {
    return { ok: false, reason: 'meta.sessionId 缺失' }
  }
  const dir = value.original?.sessionDir
  if (typeof dir !== 'string' || dir.length === 0) {
    return { ok: false, reason: 'meta.original.sessionDir 缺失（无法确定恢复位置）' }
  }
  if (!Number.isFinite(value.deletedAt)) return { ok: false, reason: 'meta.deletedAt 非法' }
  return { ok: true, meta: value }
}

/**
 * ★ 删除前的身份校验 —— 本模块最重要的函数。
 *
 * 误删是不可逆的，所以在动手之前必须确认"这个目录确实属于我要处理的会话"。
 * 校验只依赖**结构性事实**，不读日志内容（读全文代价过大）：
 *
 *   1. 目录名必须是 `encodeSegment(sessionId)` —— 宿主就是这么命名的；
 *   2. 目录必须存在且**是目录**（不是符号链接 —— 防被诱导穿越）；
 *   3. 目录内必须至少有一个可识别的代际日志文件。
 *
 * 任何一条不成立都返回失败，调用方**必须放弃删除**（而不是"尽力而为"）。
 *
 * @param {object} input
 * @param {string} input.sessionId
 * @param {string} input.dirPath 候选目录绝对路径
 * @param {string} input.dirName 该目录的 basename
 * @param {boolean} input.exists
 * @param {boolean} input.isDirectory
 * @param {boolean} input.isSymbolicLink
 * @param {string[]} input.filenames 目录内文件名
 * @returns {{ok: true, logFileName: string} | {ok: false, reason: string, detail: string}}
 */
export function verifyDeletableSessionDir(input) {
  const { sessionId, dirPath, dirName, exists, isDirectory, isSymbolicLink, filenames } = input ?? {}

  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return { ok: false, reason: TRASH_ERROR.BAD_REQUEST, detail: 'sessionId 缺失' }
  }
  if (typeof dirPath !== 'string' || dirPath.length === 0) {
    return { ok: false, reason: TRASH_ERROR.DIR_NOT_FOUND, detail: '候选目录路径为空' }
  }
  if (exists !== true) {
    return { ok: false, reason: TRASH_ERROR.DIR_NOT_FOUND, detail: `目录不存在：${dirPath}` }
  }
  // 符号链接一律拒绝：宿主自己也拒绝，这里同样不冒险
  if (isSymbolicLink === true) {
    return { ok: false, reason: TRASH_ERROR.IDENTITY_MISMATCH, detail: `拒绝操作符号链接：${dirPath}` }
  }
  if (isDirectory !== true) {
    return { ok: false, reason: TRASH_ERROR.IDENTITY_MISMATCH, detail: `不是目录：${dirPath}` }
  }

  const expected = encodeSegment(sessionId)
  if (dirName !== expected) {
    return {
      ok: false,
      reason: TRASH_ERROR.IDENTITY_MISMATCH,
      detail: `目录名与 sessionId 不符：basename=${dirName}，期望 ${expected}`,
    }
  }

  const logs = (Array.isArray(filenames) ? filenames : []).filter((n) => parseGenerationLogFilename(n) !== null)
  if (logs.length === 0) {
    return {
      ok: false,
      reason: TRASH_ERROR.IDENTITY_MISMATCH,
      detail: `目录内没有可识别的会话日志：${dirPath}`,
    }
  }

  // 选版本最大者（与宿主 resolveGenerationInDirectory 的取向一致）
  const sorted = logs.slice().sort((a, b) => {
    const pa = parseGenerationLogFilename(a)
    const pb = parseGenerationLogFilename(b)
    return (pb?.version ?? 0) - (pa?.version ?? 0)
      || ((pa?.compression === 'zstd') ? -1 : 1)
  })
  return { ok: true, logFileName: sorted[0] }
}

/**
 * 容量检查：是否允许再放入一条。
 *
 * **刻意不做自动淘汰**：容量/期限只用于统计与提示，淘汰必须由人确认。
 * 一旦自动丢掉最旧条目，回收站就从"删错了能找回"退化成"随机抽奖"。
 *
 * @param {object} input
 * @param {{sizeBytes?: number}[]} input.entries 现有条目
 * @param {number} input.incomingBytes 本次要放入的体积
 * @param {number} [input.availableBytes] 磁盘可用空间（可选）
 * @param {object} [input.limits]
 * @returns {{ok: true} | {ok: false, reason: string, detail: string}}
 */
export function checkCapacity(input = {}) {
  const limits = { ...DEFAULT_LIMITS, ...(input.limits ?? {}) }
  const entries = Array.isArray(input.entries) ? input.entries : []
  const incoming = Number.isFinite(input.incomingBytes) && input.incomingBytes > 0 ? input.incomingBytes : 0

  if (incoming > limits.maxSingleBytes) {
    return {
      ok: false,
      reason: TRASH_ERROR.TOO_LARGE,
      detail: `单条 ${incoming} 字节超过上限 ${limits.maxSingleBytes}；请确认后硬删`,
    }
  }
  if (entries.length + 1 > limits.maxEntries) {
    return {
      ok: false,
      reason: TRASH_ERROR.TRASH_FULL,
      detail: `回收站已有 ${entries.length} 条，上限 ${limits.maxEntries}；请先人工清理`,
    }
  }
  const used = entries.reduce((sum, e) => sum + (Number.isFinite(e?.sizeBytes) ? e.sizeBytes : 0), 0)
  if (used + incoming > limits.maxBytes) {
    return {
      ok: false,
      reason: TRASH_ERROR.TRASH_FULL,
      detail: `回收站已用 ${used} 字节，加本次 ${incoming} 将超过上限 ${limits.maxBytes}；请先人工清理`,
    }
  }
  if (Number.isFinite(input.availableBytes) && input.availableBytes < incoming * 2) {
    // 留一倍余量：rename 本身不需空间，但恢复与后续操作需要
    return {
      ok: false,
      reason: TRASH_ERROR.DISK_LOW,
      detail: `磁盘可用 ${input.availableBytes} 字节，不足以安全接纳 ${incoming} 字节`,
    }
  }
  return { ok: true }
}

/**
 * 恢复前检查：目标位置是否可用。
 *
 * 三种情形：
 *  - `TARGET_OCCUPIED`：原目录已存在且非空 ⇒ 拒绝（绝不覆盖）
 *  - `ID_REUSED`：同 id 的日志已存在于别处且 `createdAt` 与记录不符 ⇒ 拒绝
 *  - ok：可恢复
 *
 * @param {object} input
 * @param {object} input.meta 该条目的 sidecar 元数据
 * @param {boolean} input.targetExists 原 sessionDir 是否已存在
 * @param {number|null} [input.existingCreatedAt] 现存同 id 日志的 createdAt（若有）
 * @returns {{ok: true} | {ok: false, reason: string, detail: string}}
 */
export function checkRestorable(input = {}) {
  const { meta, targetExists, existingCreatedAt } = input
  if (targetExists === true) {
    return {
      ok: false,
      reason: TRASH_ERROR.TARGET_OCCUPIED,
      detail: `原位置已被占用：${meta?.original?.sessionDir ?? '(未知)'}`,
    }
  }
  const recorded = meta?.header?.createdAt
  if (Number.isFinite(recorded) && Number.isFinite(existingCreatedAt) && recorded !== existingCreatedAt) {
    return {
      ok: false,
      reason: TRASH_ERROR.ID_REUSED,
      detail: `同 id 的会话已以不同身份存在（记录 createdAt=${recorded}，现存 ${existingCreatedAt}）；拒绝覆盖`,
    }
  }
  return { ok: true }
}

/**
 * 统计回收站：条目数、总体积、超期条目。**只统计，不删除。**
 *
 * @param {object[]} entries 每个元素至少含 {sessionId, deletedAt, sizeBytes}
 * @param {object} [limits]
 * @param {number} [now]
 * @returns {{total: number, totalBytes: number, expiring: object[], overLimits: boolean, overEntries: boolean, overBytes: boolean}}
 */
export function summarizeTrash(entries = [], limits = {}, now = Date.now()) {
  const merged = { ...DEFAULT_LIMITS, ...limits }
  const list = Array.isArray(entries) ? entries : []
  const totalBytes = list.reduce((sum, e) => sum + (Number.isFinite(e?.sizeBytes) ? e.sizeBytes : 0), 0)
  const cutoff = merged.retentionDays * 24 * 60 * 60 * 1000

  const expiring = list
    .filter((e) => Number.isFinite(e?.deletedAt) && now - e.deletedAt > cutoff)
    .map((e) => ({ sessionId: e.sessionId, deletedAt: e.deletedAt, sizeBytes: e.sizeBytes ?? 0 }))
    .sort((a, b) => a.deletedAt - b.deletedAt)

  const overEntries = list.length > merged.maxEntries
  const overBytes = totalBytes > merged.maxBytes

  return {
    total: list.length,
    totalBytes,
    expiring,
    overEntries,
    overBytes,
    overLimits: overEntries || overBytes,
  }
}

/**
 * 按删除序排列条目（最旧在前），供 UI 展示与"清理最旧 N 条"候选生成。
 * @param {object[]} entries
 * @returns {object[]}
 */
export function sortByDeleteOrder(entries = []) {
  return (Array.isArray(entries) ? entries : [])
    .slice()
    .sort((a, b) => (a?.deletedAt ?? 0) - (b?.deletedAt ?? 0) || String(a?.sessionId).localeCompare(String(b?.sessionId)))
}

/**
 * 生成"清理候选"：最旧的 N 条。**仅生成建议，不执行删除。**
 * @param {object[]} entries
 * @param {number} count
 * @returns {object[]}
 */
export function suggestPurgeCandidates(entries = [], count = 1) {
  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 1
  return sortByDeleteOrder(entries).slice(0, n)
}
