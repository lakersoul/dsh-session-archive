/**
 * dsh-session-archive —— 回收站文件操作
 * ===========================================================================
 * 只做文件系统动作，不做策略判断。所有"能不能做"的判断在 lib/trash.js 里，
 * 调用方必须先跑过校验再进到这里。
 *
 * ## 搬运策略：逐文件 rename + 反向回滚
 *
 * 为什么不用"整目录 rename"：
 *   - sidecar 元数据必须随文件一起走，而元数据要在搬运**之前**就写好
 *     （否则搬运后崩溃就丢了"这是什么"的信息）；
 *   - 逐文件搬运让我们能在失败时**反向搬回**，把"两边都不在"的窗口压到最小；
 *   - 最终用 `rmdir`（非递归）收掉空壳目录 —— 如果目录里还有预期外的残留，
 *     `rmdir` 会失败，这恰好是一个我们需要知道的信号，而不是无声地 `rm -rf` 掉。
 *
 * 所有动作都**不吞异常**：失败必须向上传播，由调用方决定回滚与报错。
 */

import { mkdir, readdir, readFile, rename, rmdir, stat, writeFile, unlink, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { META_FILENAME, entryDirName, validateMeta } from './trash.js'

/**
 * 确保回收站根目录存在。
 * @param {string} trashRoot
 */
export async function ensureTrashRoot(trashRoot) {
  await mkdir(trashRoot, { recursive: true })
}

/**
 * 列出一个目录内的条目名（不存在时返回空数组，不抛错）。
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
export async function listDirNames(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.map((e) => e.name)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

/**
 * 列出一个目录内的**文件**名（用于身份校验）。
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
export async function listFileNames(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter((e) => e.isFile()).map((e) => e.name)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

/**
 * 取路径的存在性与类型（用于身份校验）。
 * @param {string} path
 * @returns {Promise<{exists: boolean, isDirectory: boolean, isSymbolicLink: boolean, mtimeMs: number|null}>}
 */
export async function statForVerify(path) {
  try {
    const info = await stat(path) // stat 跟随符号链接
    let isSymbolicLink = false
    try {
      const { lstat } = await import('node:fs/promises')
      isSymbolicLink = (await lstat(path)).isSymbolicLink()
    } catch {
      /* 拿不到 lstat 就按非链接处理，上面的 stat 已确认真实性 */
    }
    return {
      exists: true,
      isDirectory: info.isDirectory(),
      isSymbolicLink,
      mtimeMs: Number.isFinite(info.mtimeMs) ? info.mtimeMs : null,
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, isDirectory: false, isSymbolicLink: false, mtimeMs: null }
    throw error
  }
}

/**
 * 计算目录（含子项）的总字节数。
 * @param {string} dir
 * @returns {Promise<number>}
 */
export async function dirSizeBytes(dir) {
  let total = 0
  const walk = async (current) => {
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      const child = join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(child)
      } else if (entry.isFile()) {
        try {
          total += (await stat(child)).size
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error
        }
      }
    }
  }
  await walk(dir)
  return total
}

/**
 * 把会话目录搬入回收站。
 *
 * 步骤（失败即反向回滚已搬走的文件）：
 *   1. 建条目目录（在回收站根下，`<epoch>-<encodedId>`）
 *   2. 写入 sidecar 元数据（**先写**，保证搬运后任何时刻都能解释"这是什么"）
 *   3. 逐文件 rename 原目录 → 条目目录
 *   4. `rmdir` 收掉原目录空壳（非递归：有残留就失败，这是我们要知道的信号）
 *
 * @param {object} input
 * @param {string} input.sessionDir 原会话目录
 * @param {string} input.trashRoot 回收站根
 * @param {number} input.deletedAt
 * @param {string} input.sessionId
 * @param {object} input.meta sidecar 元数据（由 buildMeta 生成）
 * @returns {Promise<{ok: true, entryDir: string, movedFiles: string[]} | {ok: false, reason: string, detail: string, rolledBack: boolean}>}
 */
export async function moveSessionDirToTrash(input) {
  const { sessionDir, trashRoot, deletedAt, sessionId, meta } = input ?? {}
  const entryDir = join(trashRoot, entryDirName(deletedAt, sessionId))
  const moved = []

  try {
    await mkdir(entryDir, { recursive: true })
    await writeFile(join(entryDir, META_FILENAME), JSON.stringify(meta, null, 2), 'utf8')

    const names = await listDirNames(sessionDir)
    // 逐项搬运：目录项（若有）与文件项一视同仁，用 rename 保持原样
    for (const name of names) {
      if (name === META_FILENAME) continue
      await rename(join(sessionDir, name), join(entryDir, name))
      moved.push(name)
    }

    // 非递归 rmdir：若仍有预期外残留，这里会失败 —— 我们想知道
    await rmdir(sessionDir)

    return { ok: true, entryDir, movedFiles: moved }
  } catch (error) {
    // 反向回滚：把已搬走的文件搬回原位
    let rolledBack = true
    for (const name of moved.slice().reverse()) {
      try {
        await rename(join(entryDir, name), join(sessionDir, name))
      } catch {
        rolledBack = false
      }
    }
    if (rolledBack) {
      // 元数据也撤掉，并尝试收掉空条目目录
      try { await unlink(join(entryDir, META_FILENAME)) } catch { /* ignore */ }
      try { await rmdir(entryDir) } catch { /* ignore */ }
    }
    return {
      ok: false,
      reason: 'io-failed',
      detail: `搬入回收站失败：${String(error?.message ?? error)}`,
      rolledBack,
    }
  }
}

/**
 * 读取单个条目的 sidecar 元数据。
 * @param {string} entryDir
 * @returns {Promise<{ok: true, meta: object} | {ok: false, reason: string, detail: string}>}
 */
export async function readEntryMeta(entryDir) {
  try {
    const raw = await readFile(join(entryDir, META_FILENAME), 'utf8')
    const parsed = JSON.parse(raw)
    const verdict = validateMeta(parsed)
    if (verdict.ok === false) return { ok: false, reason: 'io-failed', detail: `元数据无效：${verdict.reason}` }
    return { ok: true, meta: verdict.meta }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { ok: false, reason: 'io-failed', detail: `条目缺少 ${META_FILENAME}（无法安全恢复）` }
    }
    return { ok: false, reason: 'io-failed', detail: `读取元数据失败：${String(error?.message ?? error)}` }
  }
}

/**
 * 列出回收站全部条目（含体积与元数据）。坏条目**跳过并记录**，不阻断整体。
 *
 * @param {string} trashRoot
 * @returns {Promise<{entries: object[], broken: object[]}>}
 */
export async function listEntries(trashRoot) {
  const names = await listDirNames(trashRoot)
  const entries = []
  const broken = []

  for (const name of names) {
    const entryDir = join(trashRoot, name)
    let isDir = false
    try {
      isDir = (await stat(entryDir)).isDirectory()
    } catch {
      continue
    }
    if (!isDir) continue

    const metaResult = await readEntryMeta(entryDir)
    if (metaResult.ok === false) {
      // 缺元数据的目录无法安全恢复，但也不该被悄悄删掉 —— 如实报告
      broken.push({ dirName: name, detail: metaResult.detail })
      continue
    }
    const sizeBytes = await dirSizeBytes(entryDir).catch(() => 0)
    // 两个体积含义不同，必须分清：
    //   · sizeBytes          —— 该条目**当前占用的实际字节**（含 sidecar 元数据）
    //                           用于"回收站现在占了多少盘"的展示与容量核对
    //   · recordedSizeBytes  —— **入站时记录的原始会话体积**（不含 sidecar）
    //                           由 buildMeta 写入，不随元数据自身大小变化
    // 若用前者做容量策略，同一条目每次列举都会缓慢"变大"；若用后者展示，
    // 又会低估实际占用。所以两个都给出。
    entries.push({
      dirName: name,
      entryDir,
      sessionId: metaResult.meta.sessionId,
      deletedAt: metaResult.meta.deletedAt,
      sizeBytes,
      recordedSizeBytes: Number.isFinite(metaResult.meta.sizeBytes) ? metaResult.meta.sizeBytes : null,
      title: metaResult.meta.title ?? null,
      cwd: metaResult.meta.header?.cwd ?? null,
      originalSessionDir: metaResult.meta.original?.sessionDir ?? null,
      // 归属工作区：恢复时据此把会话挂回侧边栏（老条目可能为 null）
      workspaceId: metaResult.meta.original?.workspaceId ?? null,
      workspacePath: metaResult.meta.original?.workspacePath ?? null,
      createdAt: metaResult.meta.header?.createdAt ?? null,
    })
  }

  return { entries, broken }
}

/**
 * 从回收站恢复到原位置。
 *
 * 逐文件搬回 + `rmdir` 收条目空壳；失败则反向搬回条目目录（保持"还在回收站"）。
 *
 * @param {object} input
 * @param {string} input.entryDir
 * @param {string} input.targetDir 原会话目录
 * @returns {Promise<{ok: true, restoredFiles: string[]} | {ok: false, reason: string, detail: string, rolledBack: boolean}>}
 */
export async function restoreEntryFromTrash(input) {
  const { entryDir, targetDir } = input ?? {}
  const moved = []

  try {
    await mkdir(targetDir, { recursive: true })
    const names = await listDirNames(entryDir)
    for (const name of names) {
      if (name === META_FILENAME) continue
      await rename(join(entryDir, name), join(targetDir, name))
      moved.push(name)
    }
    // 条目目录此时应只剩 sidecar；删掉它再收空壳
    try { await unlink(join(entryDir, META_FILENAME)) } catch { /* ignore */ }
    await rmdir(entryDir)
    return { ok: true, restoredFiles: moved }
  } catch (error) {
    // 反向回滚：把已搬回的再搬回条目目录
    let rolledBack = true
    for (const name of moved.slice().reverse()) {
      try {
        await rename(join(targetDir, name), join(entryDir, name))
      } catch {
        rolledBack = false
      }
    }
    return {
      ok: false,
      reason: 'io-failed',
      detail: `从回收站恢复失败：${String(error?.message ?? error)}`,
      rolledBack,
    }
  }
}

/**
 * 彻底清除一个条目（**不可逆**）。调用方必须已经得到使用者的明确确认。
 * @param {string} entryDir
 * @returns {Promise<{ok: true} | {ok: false, reason: string, detail: string}>}
 */
export async function purgeEntry(entryDir) {
  try {
    await rm(entryDir, { recursive: true, force: true })
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: 'io-failed', detail: `彻底清除失败：${String(error?.message ?? error)}` }
  }
}
