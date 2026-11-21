/**
 * host half 的 apply() 冒烟测试（mock ctx）。
 *
 * 运行：node test/host.apply.test.mjs
 *
 * 验证点：
 *  1. 5 条路由都注册了正确的 path / methods，且都在官方 /api 前缀下；
 *  2. `list` 已实现（P1）：能组装真实响应；数据源不可读时 fail-loud（503）而非回空列表；
 *  3. 未实现的路由返回 501，不返回假成功；
 *  4. 每个注册都持有了 disposer，且 ctx.effect 的清理函数会逐个调用它们
 *     （这是与 archive-manager "丢弃 disposer" 相反的刻意做法）；
 *  5. connection.fetch 不可用时只告警、不抛错（不影响 DSH 启动）。
 */

import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  apply,
  API_PREFIX,
  name,
  readArchivedIds,
  readLiveHeaders,
  readPersistedItems,
  resolveTitles,
} from '../lib/index.js'
import { projectKey } from '../lib/paths.js'

// 整个文件共用的隔离归档根：任何用例都不得读到使用者**真实的** ~/.dsh/session-archive。
// 早前有个用例用裸 mockCtx() 并断言"回收站为空"，一旦真实回收站里有条目就会假失败。
const DEFAULT_ARCHIVE_ROOT = mkdtempSync(join(tmpdir(), 'sa-apply-root-'))
process.env.DSH_SESSION_ARCHIVE_ROOT = DEFAULT_ARCHIVE_ROOT

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
async function testAsync(label, fn) {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${label}`)
  } catch (error) {
    failed++
    console.error(`  ✗ ${label}\n      ${error.message}`)
  }
}

const hdr = (id, extra = {}) => ({ id, createdAt: 1000, updatedAt: 2000, cwd: '/w', ...extra })

/**
 * 造一个最小可用的 mock ctx。
 * @param {{withConnection?: boolean, registry?: object, sessions?: object, persistence?: object, withState?: boolean}} opts
 */
function mockCtx(opts = {}) {
  const {
    withConnection = true,
    withState = true,
    sessions,
    persistence,
  } = opts

  const registered = []
  const effects = []
  const logs = { info: [], warn: [], error: [] }

  // registry：忠实模拟真实实现（enqueueOperation 串行 + setState 双写）
  const baseState = opts.registry?.state ?? (withState
    ? { archivedSessionIds: ['a', 'b', 'ghost'] }
    : undefined)
  const setStateCalls = []
  const attachCalls = []
  const detachCalls = []
  const cacheDeleteCalls = []

  // 工作区实体（用于验证 删除 detach / 恢复 attach 的对称性）
  const workspaceEntities = (opts.workspaces ?? []).map((w) => ({
    id: w.id,
    record: { path: w.path, sessionIds: [...(w.sessionIds ?? [])] },
    async attachSession(sessionId) {
      if (!this.record.sessionIds.includes(sessionId)) this.record.sessionIds = [sessionId, ...this.record.sessionIds]
      w.sessionIds = this.record.sessionIds
      attachCalls.push(sessionId)
    },
    async detachSession(sessionId) {
      this.record.sessionIds = this.record.sessionIds.filter((id) => id !== sessionId)
      w.sessionIds = this.record.sessionIds
      detachCalls.push(sessionId)
    },
  }))

  // registry：忠实模拟真实实现（enqueueOperation 串行 + setState 双写 + 工作区实体）
  const registry = opts.registry === undefined && !withState
    ? {}
    : {
      ...(opts.registry ?? {}),
      state: baseState,
      global: {
        async set(state) { setStateCalls.push(structuredClone(state)) },
      },
      async setState(next) { await this.global.set(next); this.state = next },
      operationTail: Promise.resolve(),
      enqueueOperation(operation) {
        const result = this.operationTail.then(async () => operation())
        this.operationTail = result.then(() => {}, () => {})
        return result
      },
      list: () => workspaceEntities,
      get: (id) => workspaceEntities.find((w) => w.id === id),
      async resolveByPath(path) { return workspaceEntities.find((w) => w.record.path === path) },
    }

  const services = {
    connection: withConnection
      ? {
        fetch: {
          register(route) {
            registered.push(route)
            return () => { route.__disposed = true }
          },
        },
      }
      : undefined,
    workspaceRegistry: registry,
    sessions: sessions ?? { list: () => [], get: () => undefined },
    sessionPersistence: persistence ?? { list: async () => [] },
    sessionTitle: opts.sessionTitle,
    sessionQuery: opts.sessionQuery,
  }

  const ctx = {
    logger: {
      info: (m) => logs.info.push(m),
      warn: (m) => logs.warn.push(m),
      error: (m) => logs.error.push(m),
    },
    get: (serviceName) => services[serviceName],
    effect(factory) { effects.push(factory) },
  }
  return { ctx, registered, effects, logs, registry, setStateCalls, attachCalls, detachCalls, workspaceEntities, cacheDeleteCalls }
}

const post = (path) => new Request(`http://127.0.0.1${path}`, { method: 'POST' })
const postJson = (path, payload) => new Request(`http://127.0.0.1${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
})
console.log('\n[1] 路由注册')
{
  const { ctx, registered, logs } = mockCtx()
  apply(ctx)
  test('注册了 6 条路由', () => assert.equal(registered.length, 8))
  test('全部挂在官方 /api 前缀下', () => {
    for (const r of registered) assert.ok(r.path.startsWith('/api/'), `非 /api 前缀: ${r.path}`)
  })
  test('path 使用本插件前缀', () => {
    for (const r of registered) assert.ok(r.path.startsWith(API_PREFIX), `前缀不符: ${r.path}`)
  })
  test('全部只接受 POST', () => {
    for (const r of registered) assert.deepEqual(r.methods, ['POST'])
  })
  test('全部声明 requestBody=buffered', () => {
    for (const r of registered) assert.equal(r.requestBody, 'buffered')
  })
  test('路径集合与预期一致', () => {
    const paths = registered.map((r) => r.path).sort()
    assert.deepEqual(paths, [
      `${API_PREFIX}list`, `${API_PREFIX}purge`, `${API_PREFIX}restore`,
      `${API_PREFIX}trash`, `${API_PREFIX}unarchive`, `${API_PREFIX}delete`,
      `${API_PREFIX}purgeExpired`, `${API_PREFIX}repairOrphans`,
    ].sort())
  })
  test('挂载日志被记录', () => assert.ok(logs.info.some((m) => m.includes('已挂载 8/8'))))
}

console.log('\n[2] P1：list 组装真实响应')
await testAsync('返回 200 且带 items/summary/sources', async () => {
  const { ctx, registered } = mockCtx({
    sessions: { list: () => [{ header: hdr('a') }], get: () => undefined },
    persistence: { list: async () => [{ header: hdr('b') }] },
  })
  apply(ctx)
  const route = registered.find((r) => r.path === `${API_PREFIX}list`)
  const response = await route.fetch(post(`${API_PREFIX}list`))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.items.length, 3)
  assert.deepEqual(body.summary, { total: 3, ok: 2, missing: 1, live: 1, running: 0 })
  assert.equal(body.sources.archived, 'workspaceRegistry.state')
  assert.equal(body.sources.live, 1)
  assert.equal(body.sources.persisted, 1)
})
await testAsync('按活动时间降序、missing 排最后', async () => {
  const { ctx, registered } = mockCtx({
    registry: { state: { archivedSessionIds: ['old', 'new', 'ghost'] } },
    persistence: {
      list: async () => [hdr('old', { updatedAt: 100 }), hdr('new', { updatedAt: 300 })],
    },
  })
  apply(ctx)
  const route = registered.find((r) => r.path === `${API_PREFIX}list`)
  const body = await (await route.fetch(post(`${API_PREFIX}list`))).json()
  assert.deepEqual(body.items.map((i) => i.sessionId), ['new', 'old', 'ghost'])
  assert.equal(body.items[2].state, 'missing')
})
await testAsync('无响应体也可用（POST 无 body）', async () => {
  const { ctx, registered } = mockCtx()
  apply(ctx)
  const route = registered.find((r) => r.path === `${API_PREFIX}list`)
  const response = await route.fetch(post(`${API_PREFIX}list`))
  assert.equal(response.status, 200)
})

console.log('\n[3] fail-loud：数据源不可读必须报错，不得回空列表')
await testAsync('registry.state 不存在 → 503', async () => {
  const { ctx, registered, logs } = mockCtx({ withState: false })
  apply(ctx)
  const route = registered.find((r) => r.path === `${API_PREFIX}list`)
  const response = await route.fetch(post(`${API_PREFIX}list`))
  assert.equal(response.status, 503, '必须 fail-loud，而不是 200 + 空列表')
  const body = await response.json()
  assert.equal(body.error, 'state-unreadable')
  assert.ok(logs.error.some((m) => m.includes('列出归档失败')))
})
await testAsync('archivedSessionIds 不是数组 → 503', async () => {
  const { ctx, registered } = mockCtx({ registry: { state: { archivedSessionIds: 'oops' } } })
  apply(ctx)
  const route = registered.find((r) => r.path === `${API_PREFIX}list`)
  const response = await route.fetch(post(`${API_PREFIX}list`))
  assert.equal(response.status, 503)
})
await testAsync('registry 整个缺失 → 503（不是崩溃）', async () => {
  const { ctx, registered } = mockCtx({ registry: undefined, withState: false })
  apply(ctx)
  const route = registered.find((r) => r.path === `${API_PREFIX}list`)
  const response = await route.fetch(post(`${API_PREFIX}list`))
  assert.equal(response.status, 503)
})
await testAsync('sessions/persistence 缺失时仍能工作（降级为空来源）', async () => {
  const { ctx, registered } = mockCtx({ sessions: undefined, persistence: undefined })
  apply(ctx)
  const route = registered.find((r) => r.path === `${API_PREFIX}list`)
  const body = await (await route.fetch(post(`${API_PREFIX}list`))).json()
  assert.equal(body.summary.total, 3)
  assert.equal(body.summary.ok, 0)
  assert.equal(body.summary.missing, 3)
})
await testAsync('persistence.list() 抛错时降级，不影响整体', async () => {
  const { ctx, registered } = mockCtx({ persistence: { list: async () => { throw new Error('boom') } } })
  apply(ctx)
  const route = registered.find((r) => r.path === `${API_PREFIX}list`)
  const response = await route.fetch(post(`${API_PREFIX}list`))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.sources.persisted, 0)
})

console.log('\n[4] P3：回收站端点')
await testAsync('trash 列表为空时返回 200 + summary', async () => {
  const { ctx, registered } = mockCtx()
  apply(ctx)
  const route = registered.find((r) => r.path === `${API_PREFIX}trash`)
  const response = await route.fetch(post(`${API_PREFIX}trash`))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.deepEqual(body.entries, [])
  assert.equal(body.summary.total, 0)
  assert.ok(body.limits.maxEntries > 0)
})
await testAsync('delete 缺 sessionId → 400', async () => {
  const { ctx, registered } = mockCtx()
  apply(ctx)
  const route = registered.find((r) => r.path === `${API_PREFIX}delete`)
  assert.equal((await route.fetch(postJson(`${API_PREFIX}delete`, {}))).status, 400)
})
await testAsync('restore 条目不存在 → 404 entry-not-found', async () => {
  const { ctx, registered } = mockCtx()
  apply(ctx)
  const route = registered.find((r) => r.path === `${API_PREFIX}restore`)
  const response = await route.fetch(postJson(`${API_PREFIX}restore`, { sessionId: 'nope' }))
  assert.equal(response.status, 404)
  const body = await response.json()
  assert.equal(body.error, 'entry-not-found')
})
await testAsync('purge 条目不存在 → 404 entry-not-found', async () => {
  const { ctx, registered } = mockCtx()
  apply(ctx)
  const route = registered.find((r) => r.path === `${API_PREFIX}purge`)
  const response = await route.fetch(postJson(`${API_PREFIX}purge`, { sessionId: 'nope' }))
  assert.equal(response.status, 404)
  assert.equal((await response.json()).error, 'entry-not-found')
})
await testAsync('delete 对定位不到的会话 → 明确报错（绝不静默成功）', async () => {
  const { ctx, registered } = mockCtx({
    persistence: { list: async () => [] },
  })
  apply(ctx)
  const route = registered.find((r) => r.path === `${API_PREFIX}delete`)
  const response = await route.fetch(postJson(`${API_PREFIX}delete`, { sessionId: 'ghost' }))
  assert.ok(response.status >= 400, `应报错，实际 ${response.status}`)
  const body = await response.json()
  assert.ok(body.error !== undefined)
  assert.notEqual(response.status, 200, '绝不允许"看起来删了其实没删"')
})

console.log('\n[4b] P2：unarchive 端到端')

await testAsync('恢复成功：200 且集合已更新', async () => {
  const { ctx, registered, setStateCalls } = mockCtx({
    registry: { state: { archivedSessionIds: ['a', 'b'] } },
    // 会话确实存在，避免被判为陈旧标记
    sessions: { list: () => [{ header: hdr('a') }], get: (id) => (id === 'a' ? { id } : undefined) },
  })
  apply(ctx)
  const route = registered.find((r) => r.path === `${API_PREFIX}unarchive`)
  const response = await route.fetch(postJson(`${API_PREFIX}unarchive`, { sessionId: 'a' }))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.changed, true)
  assert.deepEqual(body.archivedSessionIds, ['b'])
  assert.equal(setStateCalls.length, 1, '应恰好写盘一次')
})
await testAsync('幂等：不在归档集合里 → 200 changed:false', async () => {
  const { ctx, registered } = mockCtx({ registry: { state: { archivedSessionIds: ['a'] } } })
  apply(ctx)
  const route = registered.find((r) => r.path === `${API_PREFIX}unarchive`)
  const body = await (await route.fetch(postJson(`${API_PREFIX}unarchive`, { sessionId: 'zzz' }))).json()
  assert.equal(body.ok, true)
  assert.equal(body.changed, false)
})
await testAsync('缺 sessionId → 400', async () => {
  const { ctx, registered } = mockCtx()
  apply(ctx)
  const route = registered.find((r) => r.path === `${API_PREFIX}unarchive`)
  assert.equal((await route.fetch(postJson(`${API_PREFIX}unarchive`, {}))).status, 400)
})
await testAsync('陈旧标记（会话不存在）→ 409，且未改状态', async () => {
  const { ctx, registered } = mockCtx({
    registry: { state: { archivedSessionIds: ['ghost'] } },
    sessions: { list: () => [], get: () => undefined },
    persistence: { list: async () => [] },
  })
  apply(ctx)
  const route = registered.find((r) => r.path === `${API_PREFIX}unarchive`)
  const response = await route.fetch(postJson(`${API_PREFIX}unarchive`, { sessionId: 'ghost' }))
  assert.equal(response.status, 409)
  const body = await response.json()
  assert.equal(body.error, 'session-gone')
})
await testAsync('陈旧标记 + allowStale:true → 200 并清除', async () => {
  const { ctx, registered } = mockCtx({
    registry: { state: { archivedSessionIds: ['ghost'] } },
    sessions: { list: () => [], get: () => undefined },
    persistence: { list: async () => [] },
  })
  apply(ctx)
  const route = registered.find((r) => r.path === `${API_PREFIX}unarchive`)
  const response = await route.fetch(postJson(`${API_PREFIX}unarchive`, { sessionId: 'ghost', allowStale: true }))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.deepEqual(body.archivedSessionIds, [])
})
await testAsync('会话在持久化里存在 → 正常恢复（不误判为陈旧）', async () => {
  const { ctx, registered } = mockCtx({
    registry: { state: { archivedSessionIds: ['s1'] } },
    sessions: { list: () => [], get: () => undefined },
    persistence: { list: async () => [{ header: hdr('s1') }] },
  })
  apply(ctx)
  const route = registered.find((r) => r.path === `${API_PREFIX}unarchive`)
  assert.equal((await route.fetch(postJson(`${API_PREFIX}unarchive`, { sessionId: 's1' }))).status, 200)
})
await testAsync('state 不可读 → 503 fail-loud', async () => {
  const { ctx, registered } = mockCtx({ withState: false })
  apply(ctx)
  const route = registered.find((r) => r.path === `${API_PREFIX}unarchive`)
  const response = await route.fetch(postJson(`${API_PREFIX}unarchive`, { sessionId: 'a' }))
  assert.equal(response.status, 503)
})
await testAsync('空请求体不炸（仍按缺参数处理）', async () => {
  const { ctx, registered } = mockCtx()
  apply(ctx)
  const route = registered.find((r) => r.path === `${API_PREFIX}unarchive`)
  const response = await route.fetch(new Request(`http://127.0.0.1${API_PREFIX}unarchive`, { method: 'POST' }))
  assert.equal(response.status, 400)
})
await testAsync('响应声明 no-store', async () => {
  const { ctx, registered } = mockCtx()
  apply(ctx)
  const route = registered.find((r) => r.path === `${API_PREFIX}list`)
  const response = await route.fetch(post(`${API_PREFIX}list`))
  assert.ok(response.headers.get('cache-control').includes('no-store'))
})

console.log('\n[4b2] ★ 删除策略：live 可删，running 拒绝（回归：打开过的归档会话删不掉）')
await testAsync('live 但非 running 的会话**不**被拒绝为 session-running', async () => {
  const sessionId = 'session-live-idle-0001'
  const sandbox = await mkdtemp(join(tmpdir(), 'sa-live-'))
  process.env.DSH_SESSION_ARCHIVE_ROOT = join(sandbox, 'archive')
  const sessionsRoot = join(sandbox, 'sessions')
  const cwd = '/home/slzca/deepseekwork/open'
  const dir = join(sessionsRoot, projectKey(cwd), sessionId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.v3.jsonl.zstd'), 'x'.repeat(32), 'utf8')

  const { ctx, registered } = mockCtx({
    registry: { state: { archivedSessionIds: [sessionId] } },
    // 会话是 live（在内存 store 里），但 agent 不存在/未运行
    sessions: { list: () => [{ header: hdr(sessionId) }], get: () => ({ id: sessionId }) },
    persistence: { list: async () => [{ header: { id: sessionId, cwd, createdAt: 1, updatedAt: 2 } }], root: sessionsRoot },
  })
  apply(ctx)
  const route = registered.find((r) => r.path === `${API_PREFIX}delete`)
  const res = await route.fetch(postJson(`${API_PREFIX}delete`, { sessionId }))
  assert.notEqual(res.status, 409, 'live 空闲会话不应被判为 session-running')
  const body = await res.json()
  assert.notEqual(body.error, 'session-running', `不应返回 session-running，实际 ${JSON.stringify(body)}`)

  process.env.DSH_SESSION_ARCHIVE_ROOT = DEFAULT_ARCHIVE_ROOT
  await rm(sandbox, { recursive: true, force: true })
})

console.log('\n[4c] ★ sessionKnown 的保守取向（防止误删用户归档标记）')
await testAsync('persistence.list() 抛错 → 保守认为存在 → 正常恢复（不误判为陈旧）', async () => {
  const { ctx, registered } = mockCtx({
    registry: { state: { archivedSessionIds: ['s1'] } },
    sessions: { list: () => [], get: () => undefined },
    persistence: { list: async () => { throw new Error('disk temporarily unavailable') } },
  })
  apply(ctx)
  const route = registered.find((r) => r.path === `${API_PREFIX}unarchive`)
  const response = await route.fetch(postJson(`${API_PREFIX}unarchive`, { sessionId: 's1' }))
  assert.equal(response.status, 200, '列举失败不能当成"会话不存在"，否则会清掉有效归档标记')
})
await testAsync('sessions.get() 抛错 → 保守认为存在 → 正常恢复', async () => {
  const { ctx, registered } = mockCtx({
    registry: { state: { archivedSessionIds: ['s1'] } },
    sessions: { list: () => [], get: () => { throw new Error('probe failed') } },
    persistence: { list: async () => [] },
  })
  apply(ctx)
  const route = registered.find((r) => r.path === `${API_PREFIX}unarchive`)
  const response = await route.fetch(postJson(`${API_PREFIX}unarchive`, { sessionId: 's1' }))
  assert.equal(response.status, 200, '探测失败应保守放行，而不是判定为陈旧')
})
await testAsync('确实不存在（两处都没有且都不报错）→ 判为陈旧 409', async () => {
  const { ctx, registered } = mockCtx({
    registry: { state: { archivedSessionIds: ['ghost'] } },
    sessions: { list: () => [], get: () => undefined },
    persistence: { list: async () => [] },
  })
  apply(ctx)
  const route = registered.find((r) => r.path === `${API_PREFIX}unarchive`)
  const response = await route.fetch(postJson(`${API_PREFIX}unarchive`, { sessionId: 'ghost' }))
  assert.equal(response.status, 409)
  assert.equal((await response.json()).error, 'session-gone')
})
await testAsync('非法 sessionId 类型 → 400', async () => {
  const { ctx, registered } = mockCtx()
  apply(ctx)
  const route = registered.find((r) => r.path === `${API_PREFIX}unarchive`)
  for (const bad of [null, 42, {}, '']) {
    const response = await route.fetch(postJson(`${API_PREFIX}unarchive`, { sessionId: bad }))
    assert.equal(response.status, 400, `应拒绝 ${JSON.stringify(bad)}`)
  }
})

console.log('\n[4d] 数据源适配器（含 fail-loud 形状校验）')
{
  test('readArchivedIds：正常读取', () => {
    const r = readArchivedIds({ state: { archivedSessionIds: ['a', 'b'] } })
    assert.equal(r.ok, true)
    assert.deepEqual(r.ids, ['a', 'b'])
    assert.equal(r.source, 'workspaceRegistry.state')
  })
  test('readArchivedIds：过滤非法元素', () => {
    const r = readArchivedIds({ state: { archivedSessionIds: ['a', null, '', 42, 'b'] } })
    assert.deepEqual(r.ids, ['a', 'b'])
  })
  test('★ readArchivedIds：registry / state / 数组形状不对 → 明确失败', () => {
    for (const bad of [
      undefined, null, {},
      { state: null },
      { state: 'oops' },
      { state: {} },
      { state: { archivedSessionIds: 'oops' } },
    ]) {
      const r = readArchivedIds(bad)
      assert.equal(r.ok, false, `应拒绝 ${JSON.stringify(bad)}`)
      assert.ok(typeof r.reason === 'string' && r.reason.length > 0)
    }
  })

  test('readLiveHeaders：正常与异常输入', () => {
    assert.deepEqual(readLiveHeaders({ list: () => [{ header: { id: 'x' } }] }), [{ id: 'x' }])
    assert.deepEqual(readLiveHeaders(undefined), [])
    assert.deepEqual(readLiveHeaders({}), [])
    assert.deepEqual(readLiveHeaders({ list: () => 'nope' }), [])
    assert.deepEqual(readLiveHeaders({ list: () => { throw new Error('boom') } }), [])
    // 过滤掉没有 header 的项
    assert.deepEqual(readLiveHeaders({ list: () => [null, {}, { header: null }, { header: { id: 'y' } }] }), [{ id: 'y' }])
  })

  await testAsync('readPersistedItems：正常与异常输入', async () => {
    assert.deepEqual(await readPersistedItems({ list: async () => [{ header: { id: 'a' } }] }), [{ header: { id: 'a' } }])
    assert.deepEqual(await readPersistedItems(undefined), [])
    assert.deepEqual(await readPersistedItems({}), [])
    assert.deepEqual(await readPersistedItems({ list: async () => 'nope' }), [])
    assert.deepEqual(await readPersistedItems({ list: async () => { throw new Error('boom') } }), [])
  })

  test('★ resolveTitles：正常取到标题', () => {
    const session = { id: 's1' }
    const titles = resolveTitles(
      { get: (s) => (s === session ? { title: '我的会话' } : undefined) },
      { get: (id) => (id === 's1' ? session : undefined) },
      [{ id: 's1' }],
    )
    assert.equal(titles.get('s1'), '我的会话')
  })
  test('resolveTitles：sessionTitle 缺失 → 空 Map（不抛错）', () => {
    assert.equal(resolveTitles(undefined, { get: () => ({}) }, [{ id: 'a' }]).size, 0)
    assert.equal(resolveTitles({}, { get: () => ({}) }, [{ id: 'a' }]).size, 0)
  })
  test('resolveTitles：sessions 缺失 → 空 Map', () => {
    assert.equal(resolveTitles({ get: () => ({ title: 't' }) }, undefined, [{ id: 'a' }]).size, 0)
    assert.equal(resolveTitles({ get: () => ({ title: 't' }) }, {}, [{ id: 'a' }]).size, 0)
  })
  test('resolveTitles：会话查不到 / 标题为空 / 抛错 → 跳过该条', () => {
    const t1 = resolveTitles({ get: () => ({ title: 't' }) }, { get: () => undefined }, [{ id: 'a' }])
    assert.equal(t1.size, 0)
    const t2 = resolveTitles({ get: () => ({ title: '' }) }, { get: () => ({}) }, [{ id: 'a' }])
    assert.equal(t2.size, 0)
    const t3 = resolveTitles({ get: () => ({ title: 't' }) }, { get: () => { throw new Error('x') } }, [{ id: 'a' }])
    assert.equal(t3.size, 0)
  })
  test('resolveTitles：逐条容错（一条抛错不影响其它条）', () => {
    const good = { id: 'good' }
    const titles = resolveTitles(
      { get: (s) => ({ title: s === good ? 'OK' : '' }) },
      { get: (id) => { if (id === 'bad') throw new Error('boom'); return id === 'good' ? good : undefined } },
      [{ id: 'bad' }, { id: 'good' }],
    )
    assert.equal(titles.get('good'), 'OK')
    assert.equal(titles.size, 1)
  })
}

console.log('\n[4e] ★ 删除/恢复必须对工作区记账对称（回归：恢复后会话消失）')
{
  const sandbox = await mkdtemp(join(tmpdir(), 'sa-attach-'))
  process.env.DSH_SESSION_ARCHIVE_ROOT = join(sandbox, 'archive')
  const sessionsRoot = join(sandbox, 'sessions')
  const cwd = '/home/slzca/deepseekwork/open'
  const sessionId = 'session-sym0001-0000-0000-0000-000000000001'
  const dir = join(sessionsRoot, projectKey(cwd), sessionId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.v3.jsonl.zstd'), 'x'.repeat(48), 'utf8')

  const ws = { id: 'ws-open', path: cwd, sessionIds: [sessionId, 'session-other'] }
  const header = { id: sessionId, cwd, createdAt: 1, updatedAt: 2 }
  const { ctx, registered, attachCalls, detachCalls } = mockCtx({
    registry: { state: { archivedSessionIds: [sessionId] } },
    workspaces: [ws],
    sessions: { list: () => [], get: () => undefined },
    persistence: { list: async () => [{ header }], root: sessionsRoot },
  })
  apply(ctx)
  const del = registered.find((r) => r.path === `${API_PREFIX}delete`)
  const restore = registered.find((r) => r.path === `${API_PREFIX}restore`)

  await testAsync('删除前：会话在工作区记账里', async () => {
    assert.ok(ws.sessionIds.includes(sessionId))
  })
  await testAsync('删除成功', async () => {
    const res = await del.fetch(postJson(`${API_PREFIX}delete`, { sessionId }))
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()))
  })
  await testAsync('★ 删除后：已从工作区记账摘除（否则会留幽灵行）', async () => {
    assert.equal(ws.sessionIds.includes(sessionId), false)
    assert.ok(detachCalls.includes(sessionId))
  })
  await testAsync('★ 恢复后：必须重新挂回工作区记账（否则侧边栏看不到）', async () => {
    const res = await restore.fetch(postJson(`${API_PREFIX}restore`, { sessionId }))
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()))
    const body = await res.clone().json()
    assert.equal(body.reattached, true, `应挂回成功，实际 via=${body.reattachVia} detail=${body.reattachDetail}`)
    assert.ok(ws.sessionIds.includes(sessionId),
      `恢复后会话必须回到工作区记账，实际 sessionIds=${JSON.stringify(ws.sessionIds)}`)
  })
  await testAsync('attachSession 确实被调用', async () => {
    assert.ok(attachCalls.includes(sessionId))
  })
  await testAsync('其它会话的记账未受影响', async () => {
    assert.ok(ws.sessionIds.includes('session-other'))
  })

  process.env.DSH_SESSION_ARCHIVE_ROOT = DEFAULT_ARCHIVE_ROOT
  await rm(sandbox, { recursive: true, force: true })
}

console.log('\n[4f] ★ 孤立会话检测与修复（回归：恢复后会话在整个界面消失）')
{
  const sandbox = await mkdtemp(join(tmpdir(), 'sa-orphan-'))
  process.env.DSH_SESSION_ARCHIVE_ROOT = join(sandbox, 'archive')
  const sessionsRoot = join(sandbox, 'sessions')
  const cwd = '/home/slzca/deepseekwork/open'
  const orphanId = 'session-orphan01-0000-0000-0000-000000000001'
  const ownedId = 'session-owned001-0000-0000-0000-000000000002'
  const noCwdId = 'session-nocwd001-0000-0000-0000-000000000003'
  for (const id of [orphanId, ownedId, noCwdId]) {
    const d = join(sessionsRoot, projectKey(cwd), id)
    await mkdir(d, { recursive: true })
    await writeFile(join(d, 'session.v3.jsonl.zstd'), 'x', 'utf8')
  }

  const headers = [
    { id: orphanId, cwd, createdAt: 3, updatedAt: 3 },
    { id: ownedId, cwd, createdAt: 2, updatedAt: 2 },
    { id: noCwdId, createdAt: 1, updatedAt: 1 }, // 无 cwd → 本就该未分组，不算孤立
  ]
  // ownedId 已在工作区记账里；orphanId 不在 —— 模拟"旧版本恢复后遗留"
  const ws = { id: 'ws-open', path: cwd, sessionIds: [ownedId] }

  const { ctx, registered, workspaceEntities } = mockCtx({
    registry: { state: { archivedSessionIds: [] } },
    workspaces: [ws],
    sessions: { list: () => [], get: () => undefined },
    persistence: { list: async () => headers.map((header) => ({ header })), root: sessionsRoot },
  })
  apply(ctx)
  const list = registered.find((r) => r.path === `${API_PREFIX}list`)
  const repair = registered.find((r) => r.path === `${API_PREFIX}repairOrphans`)

  await testAsync('★ list 报告出孤立会话（且只报"本该有归属"的）', async () => {
    const body = await (await list.fetch(post(`${API_PREFIX}list`))).json()
    const ids = (body.orphans ?? []).map((o) => o.sessionId)
    assert.deepEqual(ids, [orphanId],
      `应只报 ${orphanId}，实际 ${JSON.stringify(ids)}（ownedId 已记账、noCwdId 本无归属）`)
  })
  await testAsync('孤立条目带出 cwd 与所属工作区', async () => {
    const body = await (await list.fetch(post(`${API_PREFIX}list`))).json()
    const o = body.orphans[0]
    assert.equal(o.cwd, cwd)
    assert.equal(o.workspaceId, 'ws-open')
  })
  await testAsync('★ 修复后孤立会话被挂回工作区', async () => {
    const res = await repair.fetch(post(`${API_PREFIX}repairOrphans`))
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.repairedCount, 1, JSON.stringify(body))
    assert.equal(body.repaired[0].sessionId, orphanId)
    assert.ok(ws.sessionIds.includes(orphanId), `应回到记账，实际 ${JSON.stringify(ws.sessionIds)}`)
  })
  await testAsync('修复是幂等的（再跑一次不再报）', async () => {
    const body1 = await (await list.fetch(post(`${API_PREFIX}list`))).json()
    assert.deepEqual(body1.orphans, [], '修复后不应再有孤立会话')
    const res2 = await repair.fetch(post(`${API_PREFIX}repairOrphans`))
    const body2 = await res2.json()
    assert.equal(body2.repairedCount, 0)
    assert.equal(body2.failedCount, 0)
  })
  await testAsync('修复不会破坏已有记账', async () => {
    assert.ok(ws.sessionIds.includes(ownedId))
  })

  process.env.DSH_SESSION_ARCHIVE_ROOT = DEFAULT_ARCHIVE_ROOT
  await rm(sandbox, { recursive: true, force: true })
}

console.log('\n[4h] ★ 回收站条目也要有名称（回归：回收站里没有名称）')
{
  const sandbox = await mkdtemp(join(tmpdir(), 'sa-trash-title-'))
  process.env.DSH_SESSION_ARCHIVE_ROOT = join(sandbox, 'archive')
  const sessionsRoot = join(sandbox, 'sessions')
  const cwd = '/home/slzca/deepseekwork/open'
  const liveId = 'session-livetitle-0000-0000-0000-000000000001'
  const coldId = 'session-coldtitle-0000-0000-0000-000000000002'
  for (const id of [liveId, coldId]) {
    const d = join(sessionsRoot, projectKey(cwd), id)
    await mkdir(d, { recursive: true })
    await writeFile(join(d, 'session.v3.jsonl.zstd'), 'x'.repeat(32), 'utf8')
  }
  const headers = [
    { id: liveId, cwd, createdAt: 2, updatedAt: 2 },
    { id: coldId, cwd, createdAt: 1, updatedAt: 1 },
  ]

  const { ctx, registered, cacheDeleteCalls } = mockCtx({
    registry: { state: { archivedSessionIds: [liveId, coldId] } },
    workspaces: [],
    // liveId 是实时会话；coldId 是冷会话
    sessions: { list: () => [{ header: headers[0] }], get: (id) => (id === liveId ? { id, header: headers[0] } : undefined) },
    persistence: { list: async () => headers.map((header) => ({ header })), root: sessionsRoot },
    sessionTitle: { get: (session) => (session?.id === liveId ? { title: '实时会话标题' } : undefined) },
    sessionQuery: {
      async observeSession(id) {
        return {
          projections: { values: { title: id === coldId ? '冷会话标题' : null } },
          [Symbol.dispose]() {},
        }
      },
    },
  })
  apply(ctx)
  const del = registered.find((r) => r.path === `${API_PREFIX}delete`)
  const trash = registered.find((r) => r.path === `${API_PREFIX}trash`)

  await testAsync('删除实时会话', async () => {
    const res = await del.fetch(postJson(`${API_PREFIX}delete`, { sessionId: liveId }))
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()))
  })
  await testAsync('删除冷会话', async () => {
    const res = await del.fetch(postJson(`${API_PREFIX}delete`, { sessionId: coldId }))
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()))
  })
  await testAsync('★ 回收站里两条都带名称（实时走 sessionTitle、冷走 observeSession）', async () => {
    const body = await (await trash.fetch(post(`${API_PREFIX}trash`))).json()
    const byId = Object.fromEntries(body.entries.map((e) => [e.sessionId, e]))
    assert.equal(byId[liveId].title, '实时会话标题', `实时会话标题丢失：${JSON.stringify(byId[liveId])}`)
    assert.equal(byId[coldId].title, '冷会话标题', `冷会话标题丢失：${JSON.stringify(byId[coldId])}`)
  })
  await testAsync('★ 删除流程未调用投影缓存 delete（否则会毁掉标题投影）', async () => {
    assert.deepEqual(cacheDeleteCalls, [],
      '删除不得清投影缓存 —— 那一行里还存着 title，清掉会让侧边栏名称退化')
  })

  process.env.DSH_SESSION_ARCHIVE_ROOT = DEFAULT_ARCHIVE_ROOT
  await rm(sandbox, { recursive: true, force: true })
}

console.log('\n[4g] ★ 冷会话标题回填（回归：循环「归档→删除→恢复」后标题丢失）')
{
  const sandbox = await mkdtemp(join(tmpdir(), 'sa-title-'))
  process.env.DSH_SESSION_ARCHIVE_ROOT = join(sandbox, 'archive')
  const sessionsRoot = join(sandbox, 'sessions')
  const cwd = '/home/slzca/deepseekwork/open'
  const ids = ['session-titleA-0000-0000-0000-000000000001',
    'session-titleB-0000-0000-0000-000000000002']
  for (const id of ids) {
    const d = join(sessionsRoot, projectKey(cwd), id)
    await mkdir(d, { recursive: true })
    await writeFile(join(d, 'session.v3.jsonl.zstd'), 'x', 'utf8')
  }
  const headers = ids.map((id, i) => ({ id, cwd, createdAt: 10 - i, updatedAt: 10 - i }))

  const observed = []
  const sessionQuery = {
    async observeSession(id) {
      observed.push(id)
      if (id === ids[1]) throw new Error('corrupt log')
      return {
        header: headers[0],
        projections: { asOfSeq: 1, values: { title: '会话标题 A' } },
        [Symbol.dispose]() { /* 释放 */ },
      }
    },
  }

  const { ctx, registered } = mockCtx({
    registry: { state: { archivedSessionIds: [...ids] } },
    workspaces: [],
    sessions: { list: () => [], get: () => undefined },
    persistence: { list: async () => headers.map((header) => ({ header })), root: sessionsRoot },
    sessionQuery,
  })
  apply(ctx)
  const list = registered.find((r) => r.path === `${API_PREFIX}list`)

  await testAsync('★ 冷会话也能拿到标题（不再只认实时会话）', async () => {
    const body = await (await list.fetch(post(`${API_PREFIX}list`))).json()
    const byId = Object.fromEntries(body.items.map((i) => [i.sessionId, i]))
    assert.equal(byId[ids[0]].title, '会话标题 A', `冷会话应回填标题，实际 ${JSON.stringify(byId[ids[0]])}`)
  })
  await testAsync('sources 区分"实时标题数"与"回填查询数"', async () => {
    const body = await (await list.fetch(post(`${API_PREFIX}list`))).json()
    assert.equal(body.sources.titlesLiveOnly, 0, '本场景没有实时会话')
    assert.ok(body.sources.titleLookups >= 1)
  })
  await testAsync('单个会话观测失败不影响整体（fail-soft）', async () => {
    const body = await (await list.fetch(post(`${API_PREFIX}list`))).json()
    const byId = Object.fromEntries(body.items.map((i) => [i.sessionId, i]))
    assert.equal(byId[ids[1]].title, null, '取不到标题应为 null，而不是让整次 list 失败')
    assert.equal(body.items.length, 2)
  })
  await testAsync('确实查询了这些冷会话（每次 list 各观测一次；宿主侧有 revision 缓存）', async () => {
    assert.deepEqual([...new Set(observed)].sort(), [...ids].sort())
  })
  await testAsync('sessionQuery 不可用时降级（不回填、不报错）', async () => {
    const { ctx: ctx2, registered: reg2 } = mockCtx({
      registry: { state: { archivedSessionIds: [ids[0]] } },
      workspaces: [],
      sessions: { list: () => [], get: () => undefined },
      persistence: { list: async () => [{ header: headers[0] }], root: sessionsRoot },
    })
    apply(ctx2)
    const route2 = reg2.find((r) => r.path === `${API_PREFIX}list`)
    const res = await route2.fetch(post(`${API_PREFIX}list`))
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.items[0].title, null, '无 sessionQuery 时应降级为 null')
    assert.equal(body.sources.titleLookups, 0)
  })

  process.env.DSH_SESSION_ARCHIVE_ROOT = DEFAULT_ARCHIVE_ROOT
  await rm(sandbox, { recursive: true, force: true })
}

console.log('\n[5] 生命周期：必须持有并撤销 disposer')
{
  const { ctx, effects, registered } = mockCtx()
  apply(ctx)
  test('注册了 1 个 ctx.effect 用于清理', () => assert.equal(effects.length, 1))
  const cleanup = effects[0]()
  test('清理函数可调用', () => assert.equal(typeof cleanup, 'function'))
  test('调用清理前路由未被标记撤销', () => {
    assert.ok(registered.every((r) => r.__disposed !== true))
  })
  cleanup()
  test('调用清理后每条路由都被撤销（无残留）', () => {
    assert.ok(registered.every((r) => r.__disposed === true), '存在未撤销的路由')
  })
}

console.log('\n[6] connection.fetch 不可用时：只告警，不抛错')
{
  const { ctx, logs } = mockCtx({ withConnection: false })
  let threw = null
  try {
    apply(ctx)
  } catch (error) {
    threw = error
  }
  test('apply 未抛错（不影响 DSH 启动）', () => assert.equal(threw, null, String(threw)))
  test('留下了明确告警', () => assert.ok(logs.warn.some((m) => m.includes('connection.fetch 不可用'))))
}

console.log('\n[7] 不变量：宿主半边不触碰原生服务替换')
{
  const { ctx, logs } = mockCtx()
  apply(ctx)
  test('挂载日志声明"不替换任何原生服务"', () => {
    assert.ok(logs.info.some((m) => m.includes('不替换任何原生服务')))
  })
  test('插件名与包名一致', () => assert.equal(name, 'dsh-session-archive'))
}


console.log('\n[8] P3 端到端：真实临时目录 + 隔离回收站根')
{
  // 把回收站根指到临时目录，绝不碰使用者真实的 ~/.dsh/session-archive
  const sandbox = await mkdtemp(join(tmpdir(), 'sa-e2e-'))
  process.env.DSH_SESSION_ARCHIVE_ROOT = join(sandbox, 'archive')

  const sessionsRoot = join(sandbox, 'sessions')
  const cwd = '/home/slzca/deepseekwork/open'
  const sessionId = 'session-40e1e744-f81a-4209-b840-e443b982d289'
  const projectDir = join(sessionsRoot, projectKey(cwd))
  const sessionDir = join(projectDir, sessionId)
  await mkdir(sessionDir, { recursive: true })
  await writeFile(join(sessionDir, 'session.v3.jsonl.zstd'), 'x'.repeat(64), 'utf8')
  await writeFile(join(sessionDir, 'session.lock'), '', 'utf8')

  const header = { id: sessionId, cwd, createdAt: 1700000000000, updatedAt: 1700000001000 }

  const { ctx, registered, setStateCalls } = mockCtx({
    registry: { state: { archivedSessionIds: [sessionId] } },
    sessions: { list: () => [], get: () => undefined },
    persistence: { list: async () => [{ header }], root: sessionsRoot },
  })
  apply(ctx)
  const del = registered.find((r) => r.path === `${API_PREFIX}delete`)
  const trash = registered.find((r) => r.path === `${API_PREFIX}trash`)
  const restore = registered.find((r) => r.path === `${API_PREFIX}restore`)
  const purge = registered.find((r) => r.path === `${API_PREFIX}purge`)

  await testAsync('删除成功：会话目录已移入回收站', async () => {
    const res = await del.fetch(postJson(`${API_PREFIX}delete`, { sessionId }))
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()))
    assert.equal(existsSync(sessionDir), false, '原目录应已消失')
  })
  await testAsync('★ 幽灵防治：已从归档集合移除（走 registry 串行队列）', async () => {
    assert.equal(setStateCalls.length, 1)
    assert.deepEqual(setStateCalls[0].archivedSessionIds, [])
  })
  await testAsync('回收站列表能看到该条目，且两种体积语义都正确', async () => {
    const body = await (await trash.fetch(post(`${API_PREFIX}trash`))).json()
    assert.equal(body.entries.length, 1)
    assert.equal(body.entries[0].sessionId, sessionId)
    // 入站时记录的原始体积（不含 sidecar）
    assert.equal(body.entries[0].recordedSizeBytes, 64)
    // 当前实际占用（含 sidecar 元数据）—— 必然大于原始体积
    assert.ok(body.entries[0].sizeBytes > 64, `实际占用应含元数据，得到 ${body.entries[0].sizeBytes}`)
    assert.equal(body.entries[0].cwd, cwd)
  })
  await testAsync('恢复：文件回到原位', async () => {
    const res = await restore.fetch(postJson(`${API_PREFIX}restore`, { sessionId }))
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()))
    assert.equal(existsSync(join(sessionDir, 'session.v3.jsonl.zstd')), true)
  })
  await testAsync('删除后再删一次 → 明确报错（不是静默成功）', async () => {
    const first = await del.fetch(postJson(`${API_PREFIX}delete`, { sessionId }))
    assert.equal(first.status, 200)
    const second = await del.fetch(postJson(`${API_PREFIX}delete`, { sessionId }))
    assert.ok(second.status >= 400, `第二次应报错，实际 ${second.status}`)
  })
  await testAsync('彻底清除：条目消失', async () => {
    const res = await purge.fetch(postJson(`${API_PREFIX}purge`, { sessionId }))
    assert.equal(res.status, 200)
    const body = await (await trash.fetch(post(`${API_PREFIX}trash`))).json()
    assert.deepEqual(body.entries, [])
  })

  process.env.DSH_SESSION_ARCHIVE_ROOT = DEFAULT_ARCHIVE_ROOT
  await rm(sandbox, { recursive: true, force: true })
}

// 必须**同步**删除：紧随其后的 process.exit() 会中断异步 IO，导致临时目录残留
try {
  rmSync(DEFAULT_ARCHIVE_ROOT, { recursive: true, force: true })
} catch { /* 忽略 */ }

console.log(`\n${failed === 0 ? '全部通过' : '有失败'}: ${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
