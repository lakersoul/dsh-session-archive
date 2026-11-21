/**
 * P5 加固测试。
 * 运行：node test/hardening.test.mjs
 *
 * 覆盖此前未验证的加固点：
 *   · **内容完整性** —— 删除→恢复一个"像真会话"的目录后，字节必须一致
 *   · 恢复时目标被占用 → 明确拒绝，绝不覆盖
 *   · `purgeExpired` **只执行已确认的清理**，绝不自行决定淘汰谁
 *   · 容量超限 → 明确报错而非静默丢弃
 *   · 坏条目（缺元数据）不参与恢复，但也不被悄悄删掉
 */

import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, API_PREFIX } from '../lib/index.js'
import { projectKey } from '../lib/paths.js'
import { listEntries } from '../lib/trash-io.js'

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

function mockCtx({ registryState, sessionsRoot, headers }) {
  const registered = []
  const setStateCalls = []
  const registry = {
    state: registryState,
    global: { async set(n) { setStateCalls.push(structuredClone(n)) } },
    async setState(n) { await this.global.set(n); this.state = n },
    operationTail: Promise.resolve(),
    enqueueOperation(fn) {
      const r = this.operationTail.then(async () => fn())
      this.operationTail = r.then(() => {}, () => {})
      return r
    },
    list: () => [],
  }
  const services = {
    connection: { fetch: { register(r) { registered.push(r); return () => {} } } },
    workspaceRegistry: registry,
    sessions: { list: () => [], get: () => undefined },
    sessionPersistence: { list: async () => headers.map((header) => ({ header })), root: sessionsRoot },
    sessionProjectionCache: { table: { async delete() { return true } } },
    agents: { get: () => undefined },
  }
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get: (k) => services[k],
    effect() {},
    emit() {},
  }
  return { ctx, registered, setStateCalls, registry }
}

const postJson = (p, payload) => new Request(`http://127.0.0.1${p}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
})
const post = (p) => new Request(`http://127.0.0.1${p}`, { method: 'POST' })

const CWD = '/home/slzca/deepseekwork/open'
/** 造一个"像真会话"的目录：可校验的字节内容。 */
async function makeRealSession(sessionsRoot, sessionId, payload) {
  const dir = join(sessionsRoot, projectKey(CWD), sessionId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.v3.jsonl.zstd'), payload, 'utf8')
  await writeFile(join(dir, 'session.lock'), '', 'utf8')
  return dir
}

console.log('\n[1] ★ 内容完整性：删除 → 恢复后字节必须一致')
{
  const sandbox = await mkdtemp(join(tmpdir(), 'sa-hard-'))
  process.env.DSH_SESSION_ARCHIVE_ROOT = join(sandbox, 'archive')
  const sessionsRoot = join(sandbox, 'sessions')
  const SID = 'session-40e1e744-f81a-4209-b840-e443b982d289'
  // 含多字节字符与换行，确认是"字节"而不是"字符串"层面一致
  const payload = JSON.stringify({ text: '中文内容 with emoji 🚀', n: 12345 }) + '\n'.repeat(3)
  const dir = await makeRealSession(sessionsRoot, SID, payload)
  const before = await readFile(join(dir, 'session.v3.jsonl.zstd'))

  const { ctx, registered } = mockCtx({
    registryState: { archivedSessionIds: [SID] },
    sessionsRoot,
    headers: [{ id: SID, cwd: CWD, createdAt: 1700000000000, updatedAt: 1700000001000 }],
  })
  apply(ctx)
  const del = registered.find((r) => r.path === `${API_PREFIX}delete`)
  const restore = registered.find((r) => r.path === `${API_PREFIX}restore`)

  await test('删除成功', async () => {
    const res = await del.fetch(postJson(`${API_PREFIX}delete`, { sessionId: SID }))
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()))
  })
  await test('恢复成功', async () => {
    const res = await restore.fetch(postJson(`${API_PREFIX}restore`, { sessionId: SID }))
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()))
  })
  await test('★ 恢复后字节完全一致（内容零损坏）', async () => {
    const after = await readFile(join(dir, 'session.v3.jsonl.zstd'))
    assert.deepEqual(after, before, '恢复后内容必须与删除前逐字节相同')
  })
  await test('session.lock 也被一并带回', async () => {
    assert.equal(existsSync(join(dir, 'session.lock')), true)
  })
  await test('恢复后目录里没有残留 sidecar', async () => {
    assert.equal(existsSync(join(dir, '.dsh-archive-meta.json')), false)
  })

  delete process.env.DSH_SESSION_ARCHIVE_ROOT
  await rm(sandbox, { recursive: true, force: true })
}

console.log('\n[2] 恢复时目标被占用 → 明确拒绝，绝不覆盖')
{
  const sandbox = await mkdtemp(join(tmpdir(), 'sa-hard-'))
  process.env.DSH_SESSION_ARCHIVE_ROOT = join(sandbox, 'archive')
  const sessionsRoot = join(sandbox, 'sessions')
  const SID = 'session-11111111-2222-3333-4444-555555555555'
  const dir = await makeRealSession(sessionsRoot, SID, 'original')

  const { ctx, registered } = mockCtx({
    registryState: { archivedSessionIds: [SID] },
    sessionsRoot,
    headers: [{ id: SID, cwd: CWD, createdAt: 1, updatedAt: 2 }],
  })
  apply(ctx)
  const del = registered.find((r) => r.path === `${API_PREFIX}delete`)
  const restore = registered.find((r) => r.path === `${API_PREFIX}restore`)
  await del.fetch(postJson(`${API_PREFIX}delete`, { sessionId: SID }))

  // 在他处重建同 id 的目录，制造"目标已被占"
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.v3.jsonl.zstd'), 'someone else took this spot', 'utf8')

  await test('恢复被拒绝且返回 409', async () => {
    const res = await restore.fetch(postJson(`${API_PREFIX}restore`, { sessionId: SID }))
    assert.equal(res.status, 409, `应拒绝，实际 ${res.status}`)
    const body = await res.json()
    assert.equal(body.error, 'target-occupied')
  })
  await test('★ 占用者内容未被覆盖', async () => {
    const content = await readFile(join(dir, 'session.v3.jsonl.zstd'), 'utf8')
    assert.equal(content, 'someone else took this spot')
  })
  await test('回收站里的副本仍在（未丢失）', async () => {
    const { entries } = await listEntries(join(sandbox, 'archive', 'trash'))
    assert.equal(entries.length, 1)
  })

  delete process.env.DSH_SESSION_ARCHIVE_ROOT
  await rm(sandbox, { recursive: true, force: true })
}

console.log('\n[3] ★ purgeExpired：只执行已确认的清理，绝不自行淘汰')
{
  const sandbox = await mkdtemp(join(tmpdir(), 'sa-hard-'))
  process.env.DSH_SESSION_ARCHIVE_ROOT = join(sandbox, 'archive')
  const sessionsRoot = join(sandbox, 'sessions')
  const ids = ['session-aaaa1111-0000-0000-0000-000000000001',
    'session-aaaa1111-0000-0000-0000-000000000002',
    'session-aaaa1111-0000-0000-0000-000000000003']
  const headers = []
  for (const id of ids) {
    await makeRealSession(sessionsRoot, id, 'x'.repeat(32))
    headers.push({ id, cwd: CWD, createdAt: 1, updatedAt: 2 })
  }
  const { ctx, registered } = mockCtx({
    registryState: { archivedSessionIds: [...ids] },
    sessionsRoot,
    headers,
  })
  apply(ctx)
  const del = registered.find((r) => r.path === `${API_PREFIX}delete`)
  const purgeMany = registered.find((r) => r.path === `${API_PREFIX}purgeExpired`)
  for (const id of ids) await del.fetch(postJson(`${API_PREFIX}delete`, { sessionId: id }))

  const trashDir = join(sandbox, 'archive', 'trash')

  await test('无参数 → 400，且**不删任何东西**', async () => {
    const before = (await listEntries(trashDir)).entries.length
    const res = await purgeMany.fetch(postJson(`${API_PREFIX}purgeExpired`, {}))
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.ok(body.detail.includes('绝不自行决定'))
    assert.equal((await listEntries(trashDir)).entries.length, before, '不应删除任何条目')
  })
  await test('oldestCount:1 → 只清理最旧 1 条', async () => {
    const before = (await listEntries(trashDir)).entries
    const sorted = before.slice().sort((a, b) => a.deletedAt - b.deletedAt)
    const oldest = sorted[0].sessionId
    const res = await purgeMany.fetch(postJson(`${API_PREFIX}purgeExpired`, { oldestCount: 1 }))
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.purgedCount, 1)
    assert.equal(body.purged[0].sessionId, oldest)
    const after = (await listEntries(trashDir)).entries
    assert.equal(after.length, before.length - 1)
    assert.ok(!after.some((e) => e.sessionId === oldest), '最旧那条应已消失')
  })
  await test('sessionIds 精确指定生效', async () => {
    const remaining = (await listEntries(trashDir)).entries
    const target = remaining[0].sessionId
    const res = await purgeMany.fetch(postJson(`${API_PREFIX}purgeExpired`, { sessionIds: [target] }))
    assert.equal(res.status, 200)
    assert.equal((await res.json()).purgedCount, 1)
    assert.ok(!(await listEntries(trashDir)).entries.some((e) => e.sessionId === target))
  })
  await test('★ 指定不存在的 id → 0 条，不误删别的', async () => {
    const before = (await listEntries(trashDir)).entries.length
    const res = await purgeMany.fetch(postJson(`${API_PREFIX}purgeExpired`, { sessionIds: ['session-nope'] }))
    assert.equal(res.status, 200)
    assert.equal((await res.json()).purgedCount, 0)
    assert.equal((await listEntries(trashDir)).entries.length, before)
  })

  delete process.env.DSH_SESSION_ARCHIVE_ROOT
  await rm(sandbox, { recursive: true, force: true })
}

console.log('\n[4] 容量超限 → 明确报错，绝不静默丢弃')
{
  const sandbox = await mkdtemp(join(tmpdir(), 'sa-hard-'))
  process.env.DSH_SESSION_ARCHIVE_ROOT = join(sandbox, 'archive')
  process.env.DSH_SESSION_ARCHIVE_LIMITS = JSON.stringify({ maxEntries: 1 })
  const sessionsRoot = join(sandbox, 'sessions')
  const ids = ['session-bbbb1111-0000-0000-0000-000000000001',
    'session-bbbb1111-0000-0000-0000-000000000002']
  const headers = []
  for (const id of ids) {
    await makeRealSession(sessionsRoot, id, 'x'.repeat(32))
    headers.push({ id, cwd: CWD, createdAt: 1, updatedAt: 2 })
  }
  const { ctx, registered } = mockCtx({
    registryState: { archivedSessionIds: [...ids] },
    sessionsRoot,
    headers,
  })
  apply(ctx)
  const del = registered.find((r) => r.path === `${API_PREFIX}delete`)
  const trash = registered.find((r) => r.path === `${API_PREFIX}trash`)

  await test('第一条删除成功', async () => {
    const res = await del.fetch(postJson(`${API_PREFIX}delete`, { sessionId: ids[0] }))
    assert.equal(res.status, 200)
  })
  await test('env 覆盖生效：limits.maxEntries === 1', async () => {
    const body = await (await trash.fetch(post(`${API_PREFIX}trash`))).json()
    assert.equal(body.limits.maxEntries, 1)
    assert.equal(body.summary.total, 1)
  })
  await test('★ 超出上限时删除被拦截（trash-full），而不是静默丢弃', async () => {
    const res = await del.fetch(postJson(`${API_PREFIX}delete`, { sessionId: ids[1] }))
    assert.equal(res.status, 507, `应返回 507，实际 ${res.status}`)
    const body = await res.json()
    assert.equal(body.error, 'trash-full')
  })
  await test('★ 被拦截的会话原封不动留在原地', async () => {
    const dir = join(sessionsRoot, projectKey(CWD), ids[1])
    assert.equal(existsSync(dir), true, '拦截后会话目录必须还在')
  })
  await test('非法 limits 配置退回默认值（不误伤）', async () => {
    process.env.DSH_SESSION_ARCHIVE_LIMITS = '{not json'
    const body = await (await trash.fetch(post(`${API_PREFIX}trash`))).json()
    assert.ok(body.limits.maxEntries > 1, `应退回默认值，实际 ${body.limits.maxEntries}`)
    process.env.DSH_SESSION_ARCHIVE_LIMITS = JSON.stringify({ maxEntries: 1 })
  })
  delete process.env.DSH_SESSION_ARCHIVE_LIMITS
  delete process.env.DSH_SESSION_ARCHIVE_ROOT
  await rm(sandbox, { recursive: true, force: true })
}

console.log('\n[5] 坏条目：不参与恢复，但也不被悄悄删掉')
{
  const sandbox = await mkdtemp(join(tmpdir(), 'sa-hard-'))
  process.env.DSH_SESSION_ARCHIVE_ROOT = join(sandbox, 'archive')
  const trashDir = join(sandbox, 'archive', 'trash')
  await mkdir(join(trashDir, '1000-broken-entry'), { recursive: true })
  await writeFile(join(trashDir, '1000-broken-entry', 'session.v3.jsonl.zstd'), 'x', 'utf8')

  const { ctx, registered } = mockCtx({
    registryState: { archivedSessionIds: [] },
    sessionsRoot: join(sandbox, 'sessions'),
    headers: [],
  })
  apply(ctx)
  const trash = registered.find((r) => r.path === `${API_PREFIX}trash`)

  await test('坏条目被如实报告在 broken 里', async () => {
    const body = await (await trash.fetch(post(`${API_PREFIX}trash`))).json()
    assert.equal(body.broken.length, 1)
    assert.equal(body.broken[0].dirName, '1000-broken-entry')
  })
  await test('★ 坏条目仍留在磁盘上（没有被静默清理）', async () => {
    assert.equal(existsSync(join(trashDir, '1000-broken-entry')), true)
  })

  delete process.env.DSH_SESSION_ARCHIVE_ROOT
  await rm(sandbox, { recursive: true, force: true })
}

console.log(`\n${failed === 0 ? '全部通过' : '有失败'}: ${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
