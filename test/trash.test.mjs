/**
 * 回收站纯逻辑单测。
 * 运行：node test/trash.test.mjs
 *
 * 重点：
 *  - **删除前的身份校验** —— 误删不可逆，任何一条不成立都必须拒绝
 *  - 容量策略**绝不自动淘汰**，超限只报错
 *  - 恢复前的占用/id 复用检查（绝不覆盖已有数据）
 *  - 条目名与元数据的自包含性
 */

import { strict as assert } from 'node:assert'
import {
  DEFAULT_LIMITS,
  META_FILENAME,
  META_SCHEMA,
  TRASH_ERROR,
  buildMeta,
  checkCapacity,
  checkRestorable,
  entryDirName,
  parseEntryDirName,
  sortByDeleteOrder,
  suggestPurgeCandidates,
  summarizeTrash,
  validateMeta,
  verifyDeletableSessionDir,
} from '../lib/trash.js'

let passed = 0
let failed = 0
function test(label, fn) {
  try {
    fn()
    passed++
    console.log(`  ✓ ${label}`)
  } catch (error) {
    failed++
    console.error(`  ✗ ${label}\n      ${error.message}`)
  }
}

const SID = 'session-40e1e744-f81a-4209-b840-e443b982d289'
const goodDir = (over = {}) => ({
  sessionId: SID,
  dirPath: `/root/--proj--/${SID}`,
  dirName: SID,
  exists: true,
  isDirectory: true,
  isSymbolicLink: false,
  filenames: ['session.v3.jsonl.zstd', 'session.lock'],
  ...over,
})

console.log('\n[1] 条目目录名与解析')
test('生成 <epoch>-<id>', () => {
  assert.equal(entryDirName(1757890123456, SID), `1757890123456-${SID}`)
})
test('往返解析一致', () => {
  const name = entryDirName(1757890123456, SID)
  assert.deepEqual(parseEntryDirName(name), { deletedAt: 1757890123456, encodedId: SID })
})
test('小数时间戳向下取整', () => {
  assert.ok(entryDirName(1000.9, 'a').startsWith('1000-'))
})
test('非法输入抛错（不生成可疑名字）', () => {
  assert.throws(() => entryDirName(-1, SID), /非负/)
  assert.throws(() => entryDirName(NaN, SID), /非负/)
  assert.throws(() => entryDirName(1, ''), /sessionId/)
})
test('id 含斜杠时被编码，不会逃出目录', () => {
  const name = entryDirName(1, '../../etc')
  assert.ok(!name.includes('/'))
})
test('解析拒绝畸形名字', () => {
  for (const bad of ['', 'abc-1', '123', '-x', null, undefined, '99999999999999999999-x']) {
    assert.equal(parseEntryDirName(bad), null, `应拒绝 ${JSON.stringify(bad)}`)
  }
})

console.log('\n[2] ★ 删除前的身份校验（防误删核心）')
test('正常目录通过，并选出代际日志', () => {
  const r = verifyDeletableSessionDir(goodDir())
  assert.equal(r.ok, true)
  assert.equal(r.logFileName, 'session.v3.jsonl.zstd')
})
test('多代际时选版本最大', () => {
  const r = verifyDeletableSessionDir(goodDir({ filenames: ['session.v2.jsonl.zstd', 'session.v5.jsonl'] }))
  assert.equal(r.ok, true)
  assert.equal(r.logFileName, 'session.v5.jsonl')
})
test('目录不存在 → dir-not-found（不猜、不建）', () => {
  const r = verifyDeletableSessionDir(goodDir({ exists: false }))
  assert.equal(r.ok, false)
  assert.equal(r.reason, TRASH_ERROR.DIR_NOT_FOUND)
})
test('★ 目录名与 sessionId 不符 → identity-mismatch', () => {
  const r = verifyDeletableSessionDir(goodDir({ dirName: 'session-something-else' }))
  assert.equal(r.ok, false)
  assert.equal(r.reason, TRASH_ERROR.IDENTITY_MISMATCH)
  assert.ok(r.detail.includes('不符'))
})
test('★ 符号链接一律拒绝（防诱导穿越）', () => {
  const r = verifyDeletableSessionDir(goodDir({ isSymbolicLink: true }))
  assert.equal(r.ok, false)
  assert.equal(r.reason, TRASH_ERROR.IDENTITY_MISMATCH)
  assert.ok(r.detail.includes('符号链接'))
})
test('★ 不是目录 → 拒绝', () => {
  const r = verifyDeletableSessionDir(goodDir({ isDirectory: false }))
  assert.equal(r.ok, false)
  assert.equal(r.reason, TRASH_ERROR.IDENTITY_MISMATCH)
})
test('★ 目录内没有会话日志 → 拒绝（可能是空壳/别人的目录）', () => {
  const r = verifyDeletableSessionDir(goodDir({ filenames: ['session.lock', 'notes.txt'] }))
  assert.equal(r.ok, false)
  assert.equal(r.reason, TRASH_ERROR.IDENTITY_MISMATCH)
  assert.ok(r.detail.includes('没有可识别的会话日志'))
})
test('sessionId 缺失 → bad-request', () => {
  const r = verifyDeletableSessionDir(goodDir({ sessionId: '' }))
  assert.equal(r.ok, false)
  assert.equal(r.reason, TRASH_ERROR.BAD_REQUEST)
})
test('路径为空 → dir-not-found', () => {
  const r = verifyDeletableSessionDir(goodDir({ dirPath: '' }))
  assert.equal(r.ok, false)
  assert.equal(r.reason, TRASH_ERROR.DIR_NOT_FOUND)
})
test('空输入不抛错', () => {
  const r = verifyDeletableSessionDir()
  assert.equal(r.ok, false)
})
test('真实的 encodeSegment 不动点：普通 id 目录名原样匹配', () => {
  // 宿主就是用 encodeSegment(id) 做目录名的；这里确认校验用的是同一规则
  const r = verifyDeletableSessionDir(goodDir({ dirName: SID }))
  assert.equal(r.ok, true)
})

console.log('\n[3] 元数据：构造与校验')
test('buildMeta 产出完整结构', () => {
  const meta = buildMeta({
    sessionId: SID,
    deletedAt: 1757890123456,
    originalSessionDir: `/root/--proj--/${SID}`,
    projectDir: '/root/--proj--',
    header: { cwd: '/home/slzca/deepseekwork/open', createdAt: 1757, isSeeded: false },
    title: '标题',
    sizeBytes: 12345,
    logFileName: 'session.v3.jsonl.zstd',
    logMtimeMs: 1757000,
  })
  assert.equal(meta.schema, META_SCHEMA)
  assert.equal(meta.sessionId, SID)
  assert.equal(meta.original.sessionDir, `/root/--proj--/${SID}`)
  assert.equal(meta.header.cwd, '/home/slzca/deepseekwork/open')
  assert.equal(meta.header.createdAt, 1757)
  assert.equal(meta.sizeBytes, 12345)
})
test('buildMeta 缺 sessionId / originalSessionDir 时抛错', () => {
  assert.throws(() => buildMeta({ sessionId: '', originalSessionDir: '/x' }), /sessionId/)
  assert.throws(() => buildMeta({ sessionId: 'a' }), /originalSessionDir/)
})
test('buildMeta 对缺失 cwd 归一为 null', () => {
  const meta = buildMeta({ sessionId: 'a', deletedAt: 1, originalSessionDir: '/x', header: {} })
  assert.equal(meta.header.cwd, null)
  assert.equal(meta.header.createdAt, null)
})
test('buildMeta 不含未声明的副作用字段', () => {
  const meta = buildMeta({ sessionId: 'a', deletedAt: 1, originalSessionDir: '/x', header: {} })
  assert.deepEqual(Object.keys(meta).sort(), [
    'deletedAt', 'header', 'logFileName', 'logMtimeMs', 'original', 'schema', 'sessionId', 'sizeBytes', 'title',
  ])
})
test('validateMeta 接受合法元数据', () => {
  const meta = buildMeta({ sessionId: 'a', deletedAt: 1, originalSessionDir: '/x', header: {} })
  assert.equal(validateMeta(meta).ok, true)
})
test('validateMeta 拒绝坏数据（宁可不恢复）', () => {
  const cases = [
    null, {}, { sessionId: 'a' },
    { sessionId: 'a', deletedAt: 1 },
    { sessionId: 'a', deletedAt: 1, original: {} },
    { sessionId: 'a', deletedAt: 'x', original: { sessionDir: '/x' } },
  ]
  for (const bad of cases) {
    assert.equal(validateMeta(bad).ok, false, `应拒绝 ${JSON.stringify(bad)}`)
  }
})
test('sidecar 文件名以点开头（避免被误当会话工件）', () => {
  assert.ok(META_FILENAME.startsWith('.'))
})

console.log('\n[4] 容量策略：绝不自动淘汰')
test('正常可放入', () => {
  assert.equal(checkCapacity({ entries: [], incomingBytes: 1000 }).ok, true)
})
test('单条超限 → too-large（不是静默截断）', () => {
  const r = checkCapacity({ entries: [], incomingBytes: DEFAULT_LIMITS.maxSingleBytes + 1 })
  assert.equal(r.ok, false)
  assert.equal(r.reason, TRASH_ERROR.TOO_LARGE)
})
test('条目数超限 → trash-full，且提示"请先人工清理"', () => {
  const entries = Array.from({ length: DEFAULT_LIMITS.maxEntries }, () => ({ sizeBytes: 1 }))
  const r = checkCapacity({ entries, incomingBytes: 1 })
  assert.equal(r.ok, false)
  assert.equal(r.reason, TRASH_ERROR.TRASH_FULL)
  assert.ok(r.detail.includes('人工清理'))
})
test('总体积超限 → trash-full', () => {
  const r = checkCapacity({
    entries: [{ sizeBytes: DEFAULT_LIMITS.maxBytes - 10 }],
    incomingBytes: 100,
  })
  assert.equal(r.ok, false)
  assert.equal(r.reason, TRASH_ERROR.TRASH_FULL)
})
test('磁盘不足 → disk-low', () => {
  const r = checkCapacity({ entries: [], incomingBytes: 1000, availableBytes: 500 })
  assert.equal(r.ok, false)
  assert.equal(r.reason, TRASH_ERROR.DISK_LOW)
})
test('可自定义上限', () => {
  const r = checkCapacity({ entries: [{ sizeBytes: 1 }], incomingBytes: 1, limits: { maxEntries: 1 } })
  assert.equal(r.ok, false)
  assert.equal(r.reason, TRASH_ERROR.TRASH_FULL)
})
test('不修改入参数组', () => {
  const entries = [{ sizeBytes: 1 }]
  checkCapacity({ entries, incomingBytes: 1 })
  assert.equal(entries.length, 1)
})

console.log('\n[5] 恢复前检查：绝不覆盖')
test('目标空闲 → 可恢复', () => {
  assert.equal(checkRestorable({ meta: { original: { sessionDir: '/x' } }, targetExists: false }).ok, true)
})
test('目标已存在 → target-occupied', () => {
  const r = checkRestorable({ meta: { original: { sessionDir: '/x' } }, targetExists: true })
  assert.equal(r.ok, false)
  assert.equal(r.reason, TRASH_ERROR.TARGET_OCCUPIED)
})
test('★ id 被复用（createdAt 不符）→ id-reused', () => {
  const r = checkRestorable({
    meta: { original: { sessionDir: '/x' }, header: { createdAt: 100 } },
    targetExists: false,
    existingCreatedAt: 999,
  })
  assert.equal(r.ok, false)
  assert.equal(r.reason, TRASH_ERROR.ID_REUSED)
})
test('createdAt 一致则放行（同一会话的合法恢复）', () => {
  const r = checkRestorable({
    meta: { original: { sessionDir: '/x' }, header: { createdAt: 100 } },
    targetExists: false,
    existingCreatedAt: 100,
  })
  assert.equal(r.ok, true)
})
test('记录里没有 createdAt 时不做复用断言（放行）', () => {
  const r = checkRestorable({
    meta: { original: { sessionDir: '/x' }, header: { createdAt: null } },
    targetExists: false,
    existingCreatedAt: 999,
  })
  assert.equal(r.ok, true)
})

console.log('\n[6] 统计：只统计不删除')
const now = 1_800_000_000_000
const day = 24 * 60 * 60 * 1000
test('正常统计条数与体积', () => {
  const s = summarizeTrash([
    { sessionId: 'a', deletedAt: now - day, sizeBytes: 100 },
    { sessionId: 'b', deletedAt: now - 2 * day, sizeBytes: 200 },
  ], {}, now)
  assert.equal(s.total, 2)
  assert.equal(s.totalBytes, 300)
  assert.equal(s.expiring.length, 0)
  assert.equal(s.overLimits, false)
})
test('超期条目被列出（按最久优先）', () => {
  const s = summarizeTrash([
    { sessionId: 'newer', deletedAt: now - 31 * day, sizeBytes: 1 },
    { sessionId: 'older', deletedAt: now - 90 * day, sizeBytes: 1 },
  ], {}, now)
  assert.equal(s.expiring.length, 2)
  assert.equal(s.expiring[0].sessionId, 'older')
})
test('★ 统计**不**删除任何东西（入参不变）', () => {
  const entries = [{ sessionId: 'a', deletedAt: now - 999 * day, sizeBytes: 1 }]
  const snapshot = JSON.stringify(entries)
  summarizeTrash(entries, {}, now)
  assert.equal(JSON.stringify(entries), snapshot)
})
test('超条目数 → overEntries 标记', () => {
  const entries = Array.from({ length: 3 }, () => ({ deletedAt: now, sizeBytes: 1 }))
  const s = summarizeTrash(entries, { maxEntries: 2 }, now)
  assert.equal(s.overEntries, true)
  assert.equal(s.overLimits, true)
})
test('超体积 → overBytes 标记', () => {
  const s = summarizeTrash([{ deletedAt: now, sizeBytes: 100 }], { maxBytes: 50 }, now)
  assert.equal(s.overBytes, true)
})
test('空输入不炸', () => {
  const s = summarizeTrash()
  assert.equal(s.total, 0)
  assert.equal(s.totalBytes, 0)
})

console.log('\n[7] 清理候选：只生成建议')
test('按删除序最旧在前', () => {
  const sorted = sortByDeleteOrder([
    { sessionId: 'c', deletedAt: 3 },
    { sessionId: 'a', deletedAt: 1 },
    { sessionId: 'b', deletedAt: 2 },
  ])
  assert.deepEqual(sorted.map((e) => e.sessionId), ['a', 'b', 'c'])
})
test('建议最旧 N 条', () => {
  const c = suggestPurgeCandidates([
    { sessionId: 'c', deletedAt: 3 },
    { sessionId: 'a', deletedAt: 1 },
    { sessionId: 'b', deletedAt: 2 },
  ], 2)
  assert.deepEqual(c.map((e) => e.sessionId), ['a', 'b'])
})
test('不修改入参数组', () => {
  const entries = [{ sessionId: 'b', deletedAt: 2 }, { sessionId: 'a', deletedAt: 1 }]
  const snapshot = JSON.stringify(entries)
  sortByDeleteOrder(entries)
  suggestPurgeCandidates(entries, 1)
  assert.equal(JSON.stringify(entries), snapshot)
})
test('同时间戳按 id 稳定排序', () => {
  const sorted = sortByDeleteOrder([{ sessionId: 'b', deletedAt: 1 }, { sessionId: 'a', deletedAt: 1 }])
  assert.deepEqual(sorted.map((e) => e.sessionId), ['a', 'b'])
})

console.log(`\n${failed === 0 ? '全部通过' : '有失败'}: ${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
