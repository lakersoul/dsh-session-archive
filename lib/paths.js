/**
 * dsh-session-archive —— 会话存储路径推导
 * ---------------------------------------------------------------------------
 * 这个模块是**唯一**有"误删"风险的代码，因此规则是：
 *   1. 逐字符复刻宿主的路径编码，并有单测对照磁盘上的真实目录名；
 *   2. 删除前必须由调用方做 stat 复核（见 index.js），本模块只负责"算路径"；
 *   3. 任何不确定都返回 null / 抛错，绝不"猜一个路径然后删它"。
 *
 * 复刻自 @deepseek-ai/dsh-session-persistence-jsonl（0.1.5-rc.2）：
 *   encodeSegment / projectKey / projectDir / sessionDir / logPath
 * 这些都是该包内部函数、**未导出**，所以只能复刻。若宿主升级改了编码，
 * 单测会立刻失败 —— 这正是把它独立成模块并带测试的原因。
 *
 * 为什么不能只用 header.cwd 现算：目录名依赖宿主编码，一旦编码变更，
 * cwd→目录 不再等价；因此删除时会把实际路径写进回收站元数据，
 * 恢复时以元数据为准（见 trash.js）。
 */

import { join } from 'node:path'

/** 会话格式版本，用于拼 `session.v<N>.jsonl[.zstd]`。 */
export const SESSION_FORMAT_VERSION = 3

/** 无 cwd 的会话落在该分组目录下（与宿主一致）。 */
export const NO_CWD_SEGMENT = '_no-cwd'

const SAFE_SEGMENT = /^[A-Za-z0-9._-]$/

/**
 * 复刻宿主 encodeSegment：把任意字符串编码为一个安全路径段。
 * `~` 与非安全码位转 `~XXXX`（大写十六进制、4 位补齐）。
 * @param {string} raw 原始段（会话 id）
 * @returns {string} 单段安全文件名
 */
export function encodeSegment(raw) {
  if (typeof raw !== 'string' || raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && SAFE_SEGMENT.test(ch)) out += ch
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

/**
 * 复刻宿主 projectKey：项目目录名。
 * 分隔符（`/` `\` `:`）折叠为单个 `-`；不安全码位转 `~XXXX`；
 * 结果包一层 `--…--`，去前导 `-`，截断到 251 字符（**有意有损**，与宿主一致）。
 * @param {string} cwd 项目的绝对路径
 * @returns {string} 项目目录名
 */
export function projectKey(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && SAFE_SEGMENT.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/**
 * 项目目录的绝对路径。
 * @param {string} root 会话根目录（持久化后端的 root）
 * @param {string|undefined|null} cwd 会话的 cwd；undefined/null 走 `_no-cwd`
 * @returns {string}
 */
export function projectDir(root, cwd) {
  if (typeof root !== 'string' || root.length === 0) throw new Error('root is required')
  if (cwd === undefined || cwd === null) return join(root, NO_CWD_SEGMENT)
  return join(root, projectKey(cwd))
}

/**
 * 单个会话独占的目录。
 * @param {string} root 会话根目录
 * @param {string|undefined} cwd 会话的 cwd
 * @param {string} id 会话 id
 * @returns {string}
 */
export function sessionDir(root, cwd, id) {
  return join(projectDir(root, cwd), encodeSegment(id))
}

/** 日志文件后缀（按压缩方式）。 */
export function compressionSuffix(compression) {
  return compression === 'zstd' ? '.zstd' : ''
}

/**
 * 当前代际的日志文件名。宿主用的是 `session.v<version>.jsonl[.zstd]`。
 * @param {number} version 会话格式版本
 * @param {string} compression `'zstd'` 或其它（不压缩）
 * @returns {string}
 */
export function generationLogFilename(version = SESSION_FORMAT_VERSION, compression = 'zstd') {
  return `session.v${version}.jsonl${compressionSuffix(compression)}`
}

/**
 * 从目录条目里识别"代际日志文件"。
 * 我们**不**假定版本号与压缩方式，而是接受任何 `session.v<digits>.jsonl[.zstd]`，
 * 这样宿主升级格式版本时本模块不会静默算错。
 * @param {string} filename
 * @returns {{version: number, compression: string} | null}
 */
export function parseGenerationLogFilename(filename) {
  if (typeof filename !== 'string') return null
  const m = /^session\.v([1-9][0-9]*)\.jsonl(\.zstd)?$/.exec(filename)
  if (m === null) return null
  return { version: Number(m[1]), compression: m[2] === '.zstd' ? 'zstd' : 'none' }
}

/**
 * 在同目录的多个代际文件中选"当前代际"：版本号最大者；同版本优先 zstd。
 * 与宿主的 `resolveGenerationInDirectory` 取向一致（选当前 generation）。
 * @param {string[]} filenames 目录下的文件名列表
 * @returns {string | null} 选中的文件名；无候选返回 null
 */
export function pickGenerationLog(filenames) {
  const candidates = []
  for (const name of filenames) {
    const parsed = parseGenerationLogFilename(name)
    if (parsed !== null) candidates.push({ name, ...parsed })
  }
  if (candidates.length === 0) return null
  candidates.sort((a, b) => b.version - a.version || (a.compression === 'zstd' ? -1 : 1))
  return candidates[0].name
}

/**
 * 由元数据推导会话目录的候选路径：优先用记录下来的绝对路径，退回 `cwd` 现算。
 * 返回数组而非单值，便于调用方**逐个 stat 校验**后再决定（绝不用第一个就直接删）。
 * @param {{root?: string, cwd?: string|null|undefined, sessionId: string, originalSessionDir?: string}} input
 * @returns {string[]} 去重后的候选绝对路径
 */
export function candidateSessionDirs(input) {
  const out = []
  const { root, cwd, sessionId, originalSessionDir } = input ?? {}
  if (typeof originalSessionDir === 'string' && originalSessionDir.length > 0) out.push(originalSessionDir)
  if (typeof root === 'string' && root.length > 0 && typeof sessionId === 'string' && sessionId.length > 0) {
    try {
      out.push(sessionDir(root, cwd === null ? undefined : cwd, sessionId))
    } catch {
      /* 算不出来就不加候选，交由调用方判定失败 */
    }
  }
  return [...new Set(out)]
}
