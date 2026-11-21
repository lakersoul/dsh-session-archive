/**
 * 回收站文件操作集成测试（真实临时目录）。
 * 运行：node test/trash-io.test.mjs
 *
 * 这是 P3 里风险最高的一段代码 —— 它真的在搬文件。
 * 因此测试重点是**失败路径**：搬运中途失败必须能反向回滚，
 * 绝不留下"两边都不在"的状态。
 */

import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { META_FILENAME, buildMeta } from '../lib/trash.js'
import {
  dirSizeBytes,
  ensureTrashRoot,
  listEntries,
  listFileNames,
  moveSessionDirToTrash,
  purgeEntry,
  readEntryMeta,
  restoreEntryFromTrash,
  statForVerify,
} from '../lib/trash-io.js'

let passed = 0
let failed = 0
async function test(label, fn) {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${label}`)
  } catch (error) {
    failed++
    console.error(`  ✗ ${label}\n      ${error.message}`)
  }
}

/** 造一个形似真实会话目录的 fixture。 */
async function makeSessionDir(root, sessionId, { extraFiles = {} } = {}) {
  const dir = join(root, sessionId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.v3.jsonl.zstd'), 'x'.repeat(128), 'utf8')
  await writeFile(join(dir, 'session.lock'), '', 'utf8')
  for (const [name, content] of Object.entries(extraFiles)) {
    await writeFile(join(dir, name), content, 'utf8')
  }
  return dir
}

function metaFor(sessionId, sessionDir, deletedAt = 1757890123456) {
  return buildMeta({
    sessionId,
    deletedAt,
    originalSessionDir: sessionDir,
    projectDir: join(sessionDir, '..'),
    header: { cwd: '/home/slzca/deepseekwork/open', createdAt: 1700000000000 },
    sizeBytes: 128,
    logFileName: 'session.v3.jsonl.zstd',
  })
}

const SID = 'session-40e1e744-f81a-4209-b840-e443b982d289'

console.log('\n[1] statForVerify / listFileNames / dirSizeBytes')
{
  const root = await mkdtemp(join(tmpdir(), 'sa-io-'))
  await test('存在且是目录', async () => {
    const dir = await makeSessionDir(root, SID)
    const info = await statForVerify(dir)
    assert.equal(info.exists, true)
    assert.equal(info.isDirectory, true)
    assert.equal(info.isSymbolicLink, false)
  })
  await test('不存在时 exists=false 而不抛错', async () => {
    const info = await statForVerify(join(root, 'nope'))
    assert.equal(info.exists, false)
  })
  await test('列出文件名（不含子目录）', async () => {
    const dir = await makeSessionDir(root, 's2', { extraFiles: { 'a.txt': 'a' } })
    await mkdir(join(dir, 'subdir'), { recursive: true })
    const names = (await listFileNames(dir)).sort()
    assert.deepEqual(names, ['a.txt', 'session.lock', 'session.v3.jsonl.zstd'])
  })
  await test('体积统计正确', async () => {
    const dir = await makeSessionDir(root, 's3')
    // 128 字节日志 + 空 lock
    assert.equal(await dirSizeBytes(dir), 128)
  })
  await test('体积统计：目录不存在返回 0', async () => {
    assert.equal(await dirSizeBytes(join(root, 'nope')), 0)
  })
  await rm(root, { recursive: true, force: true })
}

console.log('\n[2] 搬入回收站：成功路径')
{
  const root = await mkdtemp(join(tmpdir(), 'sa-io-'))
  const trashRoot = join(root, 'trash')
  await ensureTrashRoot(trashRoot)
  const srcDir = await makeSessionDir(root, SID)
  const beforeNames = (await listFileNames(srcDir)).sort()

  const result = await moveSessionDirToTrash({
    sessionDir: srcDir,
    trashRoot,
    deletedAt: 1757890123456,
    sessionId: SID,
    meta: metaFor(SID, srcDir),
  })

  await test('返回成功且报告搬走的文件', async () => {
    assert.equal(result.ok, true, result.detail ?? '')
    assert.deepEqual(result.movedFiles.sort(), beforeNames)
  })
  await test('原目录已被收掉（rmdir 成功）', async () => {
    assert.equal(existsSync(srcDir), false)
  })
  await test('条目目录含 sidecar 元数据', async () => {
    assert.equal(existsSync(join(result.entryDir, META_FILENAME)), true)
  })
  await test('元数据内容可读回且一致', async () => {
    const r = await readEntryMeta(result.entryDir)
    assert.equal(r.ok, true)
    assert.equal(r.meta.sessionId, SID)
    assert.equal(r.meta.original.sessionDir, srcDir)
  })
  await test('会话文件已完整搬入', async () => {
    const names = (await listFileNames(result.entryDir)).sort()
    assert.deepEqual(names, [...beforeNames, META_FILENAME].sort())
  })
  await rm(root, { recursive: true, force: true })
}

console.log('\n[3] ★ 失败路径：必须反向回滚，不留"两边都不在"')
{
  const root = await mkdtemp(join(tmpdir(), 'sa-io-'))
  const trashRoot = join(root, 'trash')
  await ensureTrashRoot(trashRoot)
  const srcDir = await makeSessionDir(root, SID, { extraFiles: { 'zzz-last.txt': 'z' } })

  // 制造一个会在搬运途中失败的场景：让目标条目目录里预先存在同名**非空目录**，
  // rename 文件到一个已存在的非空目录上会失败（ENOTEMPTY/EISDIR）。
  const deletedAt = 1757890123456
  const entryDir = join(trashRoot, `${deletedAt}-${SID}`)
  await mkdir(join(entryDir, 'zzz-last.txt', 'blocker'), { recursive: true })

  const result = await moveSessionDirToTrash({
    sessionDir: srcDir,
    trashRoot,
    deletedAt,
    sessionId: SID,
    meta: metaFor(SID, srcDir, deletedAt),
  })

  await test('返回失败且不是静默成功', async () => {
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'io-failed')
  })
  await test('报告已回滚', async () => {
    assert.equal(result.rolledBack, true, '应完成反向回滚')
  })
  await test('★ 原目录仍在，且文件一个不少', async () => {
    assert.equal(existsSync(srcDir), true, '原目录必须还在')
    const names = (await listFileNames(srcDir)).sort()
    assert.deepEqual(names, ['session.lock', 'session.v3.jsonl.zstd', 'zzz-last.txt'])
  })
  await rm(root, { recursive: true, force: true })
}

console.log('\n[4] rmdir 收不掉时的行为（有预期外残留）')
{
  const root = await mkdtemp(join(tmpdir(), 'sa-io-'))
  const trashRoot = join(root, 'trash')
  await ensureTrashRoot(trashRoot)
  const srcDir = await makeSessionDir(root, SID)
  // 放一个子目录：会被 listDirNames 一并搬走，故 rmdir 仍应成功
  await mkdir(join(srcDir, 'subdir'), { recursive: true })
  await writeFile(join(srcDir, 'subdir', 'f.txt'), 'f', 'utf8')

  const result = await moveSessionDirToTrash({
    sessionDir: srcDir,
    trashRoot,
    deletedAt: 1,
    sessionId: SID,
    meta: metaFor(SID, srcDir, 1),
  })
  await test('子目录也被一并搬走，rmdir 成功', async () => {
    assert.equal(result.ok, true, result.detail ?? '')
    assert.equal(existsSync(join(result.entryDir, 'subdir', 'f.txt')), true)
    assert.equal(existsSync(srcDir), false)
  })
  await rm(root, { recursive: true, force: true })
}

console.log('\n[5] listEntries：坏条目跳过但如实报告')
{
  const root = await mkdtemp(join(tmpdir(), 'sa-io-'))
  const trashRoot = join(root, 'trash')
  await ensureTrashRoot(trashRoot)

  // 一条正常
  const srcDir = await makeSessionDir(root, SID)
  await moveSessionDirToTrash({
    sessionDir: srcDir, trashRoot, deletedAt: 1000, sessionId: SID, meta: metaFor(SID, srcDir, 1000),
  })
  // 一条缺元数据（模拟被外部破坏）
  await mkdir(join(trashRoot, '2000-broken'), { recursive: true })
  await writeFile(join(trashRoot, '2000-broken', 'session.v3.jsonl.zstd'), 'x', 'utf8')
  // 一个非目录文件（应被忽略）
  await writeFile(join(trashRoot, 'stray.txt'), 'x', 'utf8')

  const { entries, broken } = await listEntries(trashRoot)
  await test('正常条目被列出且带体积', async () => {
    assert.equal(entries.length, 1)
    assert.equal(entries[0].sessionId, SID)
    assert.ok(entries[0].sizeBytes > 0)
    assert.equal(entries[0].deletedAt, 1000)
  })
  await test('★ 缺元数据的条目被如实报告，而非静默丢弃', async () => {
    assert.equal(broken.length, 1)
    assert.equal(broken[0].dirName, '2000-broken')
    assert.ok(broken[0].detail.includes(META_FILENAME))
  })
  await test('非目录文件被忽略', async () => {
    assert.equal(entries.length + broken.length, 2)
  })
  await rm(root, { recursive: true, force: true })
}

console.log('\n[6] 恢复：成功路径与目标占用')
{
  const root = await mkdtemp(join(tmpdir(), 'sa-io-'))
  const trashRoot = join(root, 'trash')
  await ensureTrashRoot(trashRoot)
  const srcDir = await makeSessionDir(root, SID)
  const meta = metaFor(SID, srcDir)
  const moved = await moveSessionDirToTrash({
    sessionDir: srcDir, trashRoot, deletedAt: 1000, sessionId: SID, meta,
  })

  await test('恢复成功，文件回到原位置', async () => {
    const r = await restoreEntryFromTrash({ entryDir: moved.entryDir, targetDir: srcDir })
    assert.equal(r.ok, true, r.detail ?? '')
    assert.deepEqual(r.restoredFiles.sort(), ['session.lock', 'session.v3.jsonl.zstd'])
    assert.equal(existsSync(join(srcDir, 'session.v3.jsonl.zstd')), true)
  })
  await test('条目目录已被清掉', async () => {
    assert.equal(existsSync(moved.entryDir), false)
  })
  await test('恢复后目录内不再有 sidecar（元数据不该进会话目录）', async () => {
    const names = await listFileNames(srcDir)
    assert.equal(names.includes(META_FILENAME), false)
  })
  await rm(root, { recursive: true, force: true })
}

console.log('\n[7] 彻底清除（不可逆）')
{
  const root = await mkdtemp(join(tmpdir(), 'sa-io-'))
  const trashRoot = join(root, 'trash')
  await ensureTrashRoot(trashRoot)
  const srcDir = await makeSessionDir(root, SID)
  const moved = await moveSessionDirToTrash({
    sessionDir: srcDir, trashRoot, deletedAt: 1000, sessionId: SID, meta: metaFor(SID, srcDir),
  })

  await test('purge 后条目彻底消失', async () => {
    const r = await purgeEntry(moved.entryDir)
    assert.equal(r.ok, true)
    assert.equal(existsSync(moved.entryDir), false)
  })
  await test('purge 不存在的条目也不抛错', async () => {
    const r = await purgeEntry(join(trashRoot, 'nope'))
    assert.equal(r.ok, true)
  })
  await rm(root, { recursive: true, force: true })
}

console.log('\n[8] readEntryMeta：缺/坏元数据都明确失败')
{
  const root = await mkdtemp(join(tmpdir(), 'sa-io-'))
  await test('缺元数据 → 明确失败（提示无法安全恢复）', async () => {
    const dir = join(root, 'no-meta')
    await mkdir(dir, { recursive: true })
    const r = await readEntryMeta(dir)
    assert.equal(r.ok, false)
    assert.ok(r.detail.includes(META_FILENAME))
  })
  await test('坏 JSON → 明确失败', async () => {
    const dir = join(root, 'bad-json')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, META_FILENAME), '{not json', 'utf8')
    assert.equal((await readEntryMeta(dir)).ok, false)
  })
  await test('字段缺失 → 明确失败', async () => {
    const dir = join(root, 'bad-shape')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, META_FILENAME), JSON.stringify({ sessionId: 'a' }), 'utf8')
    const r = await readEntryMeta(dir)
    assert.equal(r.ok, false)
    assert.ok(r.detail.includes('无效'))
  })
  await rm(root, { recursive: true, force: true })
}


console.log('\n[9] ★ 恢复失败时的反向回滚（把已搬回的再搬回条目目录）')
{
  const root = await mkdtemp(join(tmpdir(), 'sa-io-'))
  const trashRoot = join(root, 'trash')
  await ensureTrashRoot(trashRoot)
  const SID2 = 'session-99999999-8888-7777-6666-555555555555'
  const srcDir = await makeSessionDir(root, SID2)
  const moved = await moveSessionDirToTrash({
    sessionDir: srcDir, trashRoot, deletedAt: 1000, sessionId: SID2, meta: metaFor(SID2, srcDir),
  })
  await test('前置：搬入成功', async () => {
    assert.equal(moved.ok, true, moved.detail ?? '')
  })

  // 制造恢复失败：目标路径被一个**普通文件**占据 → mkdir 抛 ENOTDIR
  const blocker = join(root, 'blocked-target')
  await writeFile(blocker, 'i am a file, not a directory', 'utf8')

  const result = await restoreEntryFromTrash({ entryDir: moved.entryDir, targetDir: blocker })

  await test('恢复失败且明确报错', async () => {
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'io-failed')
  })
  await test('★ 报告已回滚（或明确报告未回滚）', async () => {
    assert.equal(typeof result.rolledBack, 'boolean')
  })
  await test('★ 条目目录仍在，会话文件未丢', async () => {
    assert.equal(existsSync(moved.entryDir), true, '条目目录必须还在')
    const names = (await listFileNames(moved.entryDir)).sort()
    assert.ok(names.includes('session.v3.jsonl.zstd'), `日志应仍在条目里，实际: ${names.join(', ')}`)
  })
  await test('失败后仍可从回收站成功恢复（状态未被破坏）', async () => {
    const good = await restoreEntryFromTrash({ entryDir: moved.entryDir, targetDir: srcDir })
    assert.equal(good.ok, true, good.detail ?? '')
    assert.equal(existsSync(join(srcDir, 'session.v3.jsonl.zstd')), true)
  })
  await rm(root, { recursive: true, force: true })
}

console.log('\n[10] ★ 搬入失败时的整批回滚（零残留）')
{
  const root = await mkdtemp(join(tmpdir(), 'sa-io-'))
  const trashRoot = join(root, 'trash')
  // 让 trashRoot 被一个普通文件占据 → mkdir 抛 ENOTDIR，从一开始就失败
  await writeFile(trashRoot, 'not a dir', 'utf8')

  const SID3 = 'session-12121212-3434-5656-7878-909090909090'
  const srcDir = await makeSessionDir(root, SID3)
  const before = (await listFileNames(srcDir)).sort()

  const result = await moveSessionDirToTrash({
    sessionDir: srcDir, trashRoot, deletedAt: 1000, sessionId: SID3, meta: metaFor(SID3, srcDir),
  })

  await test('搬入失败且明确报错', async () => {
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'io-failed')
  })
  await test('★ 原目录完好，文件一个不少', async () => {
    assert.equal(existsSync(srcDir), true)
    assert.deepEqual((await listFileNames(srcDir)).sort(), before)
  })
  await test('报告已回滚（此项无需回滚，rolledBack 为 true）', async () => {
    assert.equal(result.rolledBack, true)
  })
  await rm(root, { recursive: true, force: true })
}

console.log(`\n${failed === 0 ? '全部通过' : '有失败'}: ${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
