/**
 * 幽灵回归测试（Ghost Regression）
 * ===========================================================================
 * 这是本项目存在的理由 —— 此前三个同类插件全部栽在同一个地方：
 * 删除后会话以「无工作区的幽灵」形态残留在侧边栏，或重启后复活。
 *
 * 幽灵的成因链（在 DSH 0.1.5-rc.1 上逐环节确认）：
 *   1. `ApiSessionList.list()` = `sessionQuery.listSessions()`
 *      = `listPersisted(磁盘) ∪ sessions.list()(内存)`；
 *   2. 持久化侧是**磁盘实时扫描**：宿主 `listArtifacts()` 遍历
 *      `sessions/<projectKey(cwd)>/<encodeSegment(id)>/`，并对
 *      **重复 session id 直接 throw**；
 *   3. 浏览器侧「删掉那一行」只由 `api-session/removed` 驱动。
 *
 * 所以"删除干净"等价于三个可验证的事实：
 *   A. 磁盘上**任何位置**都不再存在该 id 的会话目录（否则宿主扫描会复活它、
 *      甚至因重复 id 让启动失败）；
 *   B. 归档集合里不再有它；
 *   C. 发出了 api-session/removed。
 *
 * 本测试在**真实临时目录**上验证 A/B/C，并额外验证：
 *   · 回收站里的副本**不在 sessions 根内**（放到里面会让宿主扫描到 → 见 README）；
 *   · 反复删除幂等、不产生第二份副本。
 *
 * 运行：node test/ghost-regression.test.mjs
 */

import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, API_PREFIX, archiveRoot, trashRoot } from '../lib/index.js'
import { encodeSegment, projectKey } from '../lib/paths.js'
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

// ── mock ctx（含"记录事件"的能力，用于验证 api-session/removed）──────────────
function mockCtx({ registryState, sessionsRoot, header }) {
  const registered = []
  const emitted = []
  const setStateCalls = []

  const registry = {
    state: registryState,
    global: { async set(next) { setStateCalls.push(structuredClone(next)) } },
    async setState(next) { await this.global.set(next); this.state = next },
    operationTail: Promise.resolve(),
    enqueueOperation(fn) {
      const r = this.operationTail.then(async () => fn())
      this.operationTail = r.then(() => {}, () => {})
      return r
    },
    list: () => [],
  }

  // 投影缓存：记录 delete() 调用（用来断言"删除时**不**清缓存"）
  const cacheDeleteCalls = []
  const projectionCache = {
    table: {
      async delete(id) { cacheDeleteCalls.push(id); return true },
    },
  }

  const services = {
    connection: {
      fetch: {
        register(route) { registered.push(route); return () => { route.__disposed = true } },
      },
    },
    workspaceRegistry: registry,
    sessions: { list: () => [], get: () => undefined },
    sessionPersistence: { list: async () => [{ header }], root: sessionsRoot },
    sessionProjectionCache: projectionCache,
    agents: { get: () => undefined },
  }

  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get: (k) => services[k],
    effect() {},
    emit: (event, payload) => { emitted.push({ event, payload }) },
  }
  return { ctx, registered, emitted, setStateCalls, cacheDeleteCalls, registry }
}

/** 递归扫描 sessions 根，找出所有"看起来像该 sessionId 目录名"的路径。 */
async function findSessionDirsAnywhere(root, sessionId) {
  const hits = []
  const target = encodeSegment(sessionId)
  const walk = async (dir) => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const child = join(dir, e.name)
      if (e.name === target) hits.push(child)
      await walk(child)
    }
  }
  await walk(root)
  return hits
}

const SID = 'session-40e1e744-f81a-4209-b840-e443b982d289'
const CWD = '/home/slzca/deepseekwork/open'

console.log('\n[1] 删除后磁盘上不再存在该会话（幽灵防治核心）')
{
  const sandbox = await mkdtemp(join(tmpdir(), 'sa-ghost-'))
  process.env.DSH_SESSION_ARCHIVE_ROOT = join(sandbox, 'archive')

  const sessionsRoot = join(sandbox, 'sessions')
  const sessionDir = join(sessionsRoot, projectKey(CWD), SID)
  await mkdir(sessionDir, { recursive: true })
  await writeFile(join(sessionDir, 'session.v3.jsonl.zstd'), 'x'.repeat(64), 'utf8')
  await writeFile(join(sessionDir, 'session.lock'), '', 'utf8')

  const header = { id: SID, cwd: CWD, createdAt: 1700000000000, updatedAt: 1700000001000 }
  const { ctx, registered, emitted, setStateCalls, cacheDeleteCalls } = mockCtx({
    registryState: { archivedSessionIds: [SID] },
    sessionsRoot,
    header,
  })
  apply(ctx)

  const del = registered.find((r) => r.path === `${API_PREFIX}delete`)
  const postJson = (p, payload) => new Request(`http://127.0.0.1${p}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  })

  await test('删除前：目录确实存在（先证明测试基线成立）', async () => {
    assert.equal(existsSync(sessionDir), true)
    assert.equal((await findSessionDirsAnywhere(sessionsRoot, SID)).length, 1)
  })

  const res = await del.fetch(postJson(`${API_PREFIX}delete`, { sessionId: SID }))

  await test('删除请求成功', async () => {
    const body = await res.clone().json()
    assert.equal(res.status, 200, JSON.stringify(body))
  })
  await test('★ A. 磁盘上任何位置都不再有该会话目录', async () => {
    const hits = await findSessionDirsAnywhere(sessionsRoot, SID)
    assert.deepEqual(hits, [], `仍存在：${hits.join(', ')}`)
  })
  await test('原目录已消失', async () => {
    assert.equal(existsSync(sessionDir), false)
  })
  await test('★ B. 已从归档集合移除（走 registry 串行队列）', async () => {
    assert.equal(setStateCalls.length, 1)
    assert.deepEqual(setStateCalls[0].archivedSessionIds, [])
  })
  await test('★ C. 发出了 api-session/removed（浏览器据此删行）', async () => {
    const removals = emitted.filter((e) => e.event === 'api-session/removed')
    assert.equal(removals.length >= 1, true, '必须发出移除事件')
    assert.equal(removals[0].payload, SID)
  })
  await test('★ 投影缓存**不**被清理（保留 title 等派生数据；缓存行无法让已删会话复活）', async () => {
    // 会话列表只由 sessionQuery.listSessions()（磁盘 ∪ 内存）产生，
    // 投影缓存仅用于给"已在列表里的条目"补充投影 —— 清它既无必要，
    // 又会毁掉 title/sessionListMetadata，导致恢复后侧边栏名称退化。
    assert.deepEqual(cacheDeleteCalls, [], '删除流程不应调用投影缓存的 delete()')
  })

  delete process.env.DSH_SESSION_ARCHIVE_ROOT
  await rm(sandbox, { recursive: true, force: true })
}

console.log('\n[2] ★ 回收站必须在 sessions 根之外（否则宿主扫描到 = 启动失败）')
{
  const sandbox = await mkdtemp(join(tmpdir(), 'sa-ghost-'))
  process.env.DSH_SESSION_ARCHIVE_ROOT = join(sandbox, 'archive')

  const sessionsRoot = join(sandbox, 'sessions')
  const sessionDir = join(sessionsRoot, projectKey(CWD), SID)
  await mkdir(sessionDir, { recursive: true })
  await writeFile(join(sessionDir, 'session.v3.jsonl.zstd'), 'x'.repeat(64), 'utf8')

  const header = { id: SID, cwd: CWD, createdAt: 1, updatedAt: 2 }
  const { ctx, registered } = mockCtx({ registryState: { archivedSessionIds: [SID] }, sessionsRoot, header })
  apply(ctx)
  const del = registered.find((r) => r.path === `${API_PREFIX}delete`)
  await del.fetch(new Request(`http://127.0.0.1${API_PREFIX}delete`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: SID }),
  }))

  await test('回收站根不在 sessions 根内', async () => {
    const sessionsReal = join(sessionsRoot)
    assert.equal(trashRoot().startsWith(sessionsReal + '/'), false,
      `回收站 ${trashRoot()} 不能位于 sessions 根 ${sessionsReal} 内`)
  })
  await test('★ sessions 根内扫描不到被删会话（宿主 listArtifacts 不会复活它）', async () => {
    assert.deepEqual(await findSessionDirsAnywhere(sessionsRoot, SID), [])
  })
  await test('条目确实进了回收站（不是凭空消失）', async () => {
    const { entries } = await listEntries(trashRoot())
    assert.equal(entries.length, 1)
    assert.equal(entries[0].sessionId, SID)
  })

  delete process.env.DSH_SESSION_ARCHIVE_ROOT
  await rm(sandbox, { recursive: true, force: true })
}

console.log('\n[3] 幂等：重复删除不产生第二份副本')
{
  const sandbox = await mkdtemp(join(tmpdir(), 'sa-ghost-'))
  process.env.DSH_SESSION_ARCHIVE_ROOT = join(sandbox, 'archive')

  const sessionsRoot = join(sandbox, 'sessions')
  const sessionDir = join(sessionsRoot, projectKey(CWD), SID)
  await mkdir(sessionDir, { recursive: true })
  await writeFile(join(sessionDir, 'session.v3.jsonl.zstd'), 'x'.repeat(64), 'utf8')

  const header = { id: SID, cwd: CWD, createdAt: 1, updatedAt: 2 }
  const { ctx, registered } = mockCtx({ registryState: { archivedSessionIds: [SID] }, sessionsRoot, header })
  apply(ctx)
  const del = registered.find((r) => r.path === `${API_PREFIX}delete`)
  const body = JSON.stringify({ sessionId: SID })
  const mk = () => new Request(`http://127.0.0.1${API_PREFIX}delete`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body,
  })

  const first = await del.fetch(mk())
  const second = await del.fetch(mk())

  await test('第一次成功', async () => { assert.equal(first.status, 200) })
  await test('第二次明确失败（不是静默成功）', async () => {
    assert.ok(second.status >= 400, `应报错，实际 ${second.status}`)
  })
  await test('回收站里仍只有一份副本', async () => {
    const { entries } = await listEntries(trashRoot())
    assert.equal(entries.length, 1)
  })

  delete process.env.DSH_SESSION_ARCHIVE_ROOT
  await rm(sandbox, { recursive: true, force: true })
}

console.log('\n[4] 归档集合与外层来源的一致性')
{
  const sandbox = await mkdtemp(join(tmpdir(), 'sa-ghost-'))
  process.env.DSH_SESSION_ARCHIVE_ROOT = join(sandbox, 'archive')
  await test('archiveRoot 尊重环境变量覆盖（测试隔离的基础）', async () => {
    assert.equal(archiveRoot(), join(sandbox, 'archive'))
  })
  await test('trashRoot 是 archiveRoot 的子目录', async () => {
    assert.equal(trashRoot(), join(sandbox, 'archive', 'trash'))
  })
  delete process.env.DSH_SESSION_ARCHIVE_ROOT
  await rm(sandbox, { recursive: true, force: true })
}

console.log(`\n${failed === 0 ? '全部通过' : '有失败'}: ${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
