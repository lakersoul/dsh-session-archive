/**
 * 恢复归档（unarchive）单测。
 * 运行：node test/unarchive.test.mjs
 *
 * 重点：
 *  - 幂等性（不在归档集合里 = 已达成目标，不算错误）
 *  - **必须走 registry.enqueueOperation + setState**，不得直写 storageDomain
 *    （这正是 dsh-session-manager 丢失更新的根因）
 *  - 陈旧标记默认不清除，需显式 allowStale
 *  - 并发写不丢更新（在串行区内重读 state）
 */

import { strict as assert } from 'node:assert'
import {
  hasNativeUnarchive,
  UNARCHIVE_ERROR,
  persistArchivedIds,
  planUnarchive,
  planUnarchiveMany,
  unarchiveSession,
} from '../lib/unarchive.js'

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

/** 造一个忠实于真实实现的 registry mock（enqueueOperation 串行 + setState 双写）。 */
function mockRegistry(initialIds = ['a', 'b', 'c']) {
  const record = {
    persisted: [],
    calls: [],
    inSerial: 0,
    maxConcurrentSerial: 0,
  }
  const registry = {
    state: { initialized: true, workspaceIds: ['w1'], archivedSessionIds: [...initialIds] },
    global: {
      async set(state) { record.persisted.push(JSON.parse(JSON.stringify(state))) },
    },
    async setState(next) { await this.global.set(next); this.state = next },
    // 与宿主一致的串行队列实现
    operationTail: Promise.resolve(),
    enqueueOperation(operation) {
      record.calls.push('enqueueOperation')
      const result = this.operationTail.then(async () => {
        record.inSerial++
        record.maxConcurrentSerial = Math.max(record.maxConcurrentSerial, record.inSerial)
        try {
          return await operation()
        } finally {
          record.inSerial--
        }
      })
      this.operationTail = result.then(() => {}, () => {})
      return result
    },
  }
  return { registry, record }
}

console.log('\n[1] planUnarchive：纯函数边界')
test('正常移除', () => {
  const r = planUnarchive(['a', 'b'], 'a')
  assert.equal(r.ok, true)
  assert.deepEqual(r.next, ['b'])
  assert.equal(r.changed, true)
})
test('保持原有顺序', () => {
  const r = planUnarchive(['c', 'a', 'b'], 'a')
  assert.deepEqual(r.next, ['c', 'b'])
})
test('不在集合里 → changed:false（幂等，不算错误）', () => {
  const r = planUnarchive(['a'], 'zzz')
  assert.equal(r.ok, true)
  assert.equal(r.changed, false)
  assert.deepEqual(r.next, ['a'])
})
test('非数组 → registry-unreadable', () => {
  const r = planUnarchive('oops', 'a')
  assert.equal(r.ok, false)
  assert.equal(r.reason, UNARCHIVE_ERROR.REGISTRY_UNREADABLE)
})
test('非法 sessionId → not-archived', () => {
  for (const bad of ['', null, undefined, 42]) {
    const r = planUnarchive(['a'], bad)
    assert.equal(r.ok, false, `应拒绝 ${JSON.stringify(bad)}`)
  }
})
test('不修改入参数组', () => {
  const input = ['a', 'b']
  planUnarchive(input, 'a')
  assert.deepEqual(input, ['a', 'b'])
})

console.log('\n[2] planUnarchiveMany：批量')
test('移除多个并报告 removed', () => {
  const r = planUnarchiveMany(['a', 'b', 'c'], ['a', 'c'])
  assert.deepEqual(r.next, ['b'])
  assert.deepEqual(r.removed, ['a', 'c'])
  assert.equal(r.changed, true)
})
test('重复目标去重', () => {
  const r = planUnarchiveMany(['a', 'b'], ['a', 'a'])
  assert.deepEqual(r.removed, ['a'])
  assert.deepEqual(r.next, ['b'])
})
test('空目标 → changed:false', () => {
  const r = planUnarchiveMany(['a'], [])
  assert.equal(r.changed, false)
  assert.deepEqual(r.next, ['a'])
})
test('忽略非法目标', () => {
  const r = planUnarchiveMany(['a'], [null, '', 42])
  assert.deepEqual(r.removed, [])
})

console.log('\n[3] persistArchivedIds：必须走 registry 的串行队列')
await testAsync('调用 enqueueOperation 且写盘一次', async () => {
  const { registry, record } = mockRegistry(['a', 'b'])
  const r = await persistArchivedIds(registry, ['b'])
  assert.equal(r.ok, true)
  assert.equal(record.calls.filter((c) => c === 'enqueueOperation').length, 1)
  assert.equal(record.persisted.length, 1)
  assert.deepEqual(record.persisted[0].archivedSessionIds, ['b'])
  assert.equal(r.persistedVia, 'registry.enqueueOperation+setState')
})
await testAsync('同步更新内存 state（不是只写盘）', async () => {
  const { registry } = mockRegistry(['a', 'b'])
  await persistArchivedIds(registry, ['b'])
  assert.deepEqual(registry.state.archivedSessionIds, ['b'])
})
await testAsync('保留 state 的其它字段', async () => {
  const { registry, record } = mockRegistry(['a'])
  await persistArchivedIds(registry, [])
  assert.equal(record.persisted[0].initialized, true)
  assert.deepEqual(record.persisted[0].workspaceIds, ['w1'])
})
await testAsync('registry 缺失 → 明确失败，不抛错', async () => {
  for (const bad of [undefined, null]) {
    const r = await persistArchivedIds(bad, [])
    assert.equal(r.ok, false)
    assert.equal(r.reason, UNARCHIVE_ERROR.REGISTRY_UNREADABLE)
  }
})
await testAsync('缺少 enqueueOperation/setState → 明确失败（不退回直写）', async () => {
  const partial = { state: { archivedSessionIds: [] } }
  const r = await persistArchivedIds(partial, [])
  assert.equal(r.ok, false)
  assert.equal(r.reason, UNARCHIVE_ERROR.REGISTRY_UNREADABLE)
  assert.ok(r.detail.includes('enqueueOperation'))
})
await testAsync('setState 抛错 → persist-failed 且带原因', async () => {
  const { registry } = mockRegistry(['a'])
  registry.setState = async () => { throw new Error('disk full') }
  const r = await persistArchivedIds(registry, [])
  assert.equal(r.ok, false)
  assert.equal(r.reason, UNARCHIVE_ERROR.PERSIST_FAILED)
  assert.ok(r.detail.includes('disk full'))
})

console.log('\n[4] 并发写不丢更新（串行区内重读 state）')
await testAsync('两个并发恢复都生效', async () => {
  const { registry, record } = mockRegistry(['a', 'b', 'c'])
  // 模拟两个独立请求：各自先读 state 再写
  const p1 = unarchiveSession({ registry, sessionKnown: () => true }, 'a')
  const p2 = unarchiveSession({ registry, sessionKnown: () => true }, 'b')
  const [r1, r2] = await Promise.all([p1, p2])
  assert.equal(r1.ok, true)
  assert.equal(r2.ok, true)
  // 两次都从「当时的 state」算出 next，但串行区内会重读，故最终两个都被移除
  assert.deepEqual([...registry.state.archivedSessionIds].sort(), ['c'])
  assert.equal(record.maxConcurrentSerial, 1, '串行区内不应并发')
})

console.log('\n[5] unarchiveSession：整体流程')
await testAsync('正常恢复', async () => {
  const { registry } = mockRegistry(['a', 'b'])
  const r = await unarchiveSession({ registry, sessionKnown: () => true }, 'a')
  assert.equal(r.ok, true)
  assert.equal(r.changed, true)
  assert.deepEqual(r.next, ['b'])
})
await testAsync('幂等：本就不在归档集合里', async () => {
  const { registry, record } = mockRegistry(['a'])
  const r = await unarchiveSession({ registry, sessionKnown: () => true }, 'zzz')
  assert.equal(r.ok, true)
  assert.equal(r.changed, false)
  assert.equal(record.persisted.length, 0, '无变更时不应写盘')
})
await testAsync('陈旧标记：默认拒绝清除', async () => {
  const { registry, record } = mockRegistry(['ghost'])
  const r = await unarchiveSession({ registry, sessionKnown: () => false }, 'ghost')
  assert.equal(r.ok, false)
  assert.equal(r.reason, UNARCHIVE_ERROR.SESSION_GONE)
  assert.equal(record.persisted.length, 0, '拒绝时不应写盘')
})
await testAsync('陈旧标记：显式 allowStale 才清除', async () => {
  const { registry, record } = mockRegistry(['ghost'])
  const r = await unarchiveSession({ registry, sessionKnown: () => false }, 'ghost', { allowStale: true })
  assert.equal(r.ok, true)
  assert.equal(r.changed, true)
  assert.equal(record.persisted.length, 1)
  assert.deepEqual(registry.state.archivedSessionIds, [])
})
await testAsync('sessionKnown 抛错时按"不存在"保守处理', async () => {
  const { registry } = mockRegistry(['ghost'])
  const r = await unarchiveSession({ registry, sessionKnown: () => { throw new Error('boom') } }, 'ghost')
  assert.equal(r.ok, false)
  assert.equal(r.reason, UNARCHIVE_ERROR.SESSION_GONE)
})
await testAsync('未提供 sessionKnown 时不做存在性判断（直接执行）', async () => {
  const { registry } = mockRegistry(['a'])
  const r = await unarchiveSession({ registry }, 'a')
  assert.equal(r.ok, true)
})
await testAsync('state 形状不对 → registry-unreadable', async () => {
  const r = await unarchiveSession({ registry: { state: {} } }, 'a')
  assert.equal(r.ok, false)
  assert.equal(r.reason, UNARCHIVE_ERROR.REGISTRY_UNREADABLE)
})

// ── 原生入口优先 ───────────────────────────────────────────────────────────
// DSH 0.2.x 的 WorkspaceRegistry 公开了 unarchiveSession()，它在写状态前会发
// `workspace/session-unarchiving` 并行事件（worktree 服务据此取消进行中的回收）。
// 本插件曾经自己实现 setState 绕过它 —— 那是当年"公开面没有 unarchive 入口"的
// 遗留做法，现已改为原生优先。
console.log('\n[原生入口优先] registry.unarchiveSession()')
{
  /** 造一个带原生入口的 registry；记录各路径是否被调用。 */
  const nativeRegistry = (ids, { throws = false } = {}) => {
    const calls = { native: [], setState: 0, enqueue: 0 }
    const reg = {
      state: { archivedSessionIds: [...ids] },
      calls,
      async unarchiveSession(sessionId) {
        calls.native.push(sessionId)
        if (throws) throw new Error('native boom')
        this.state = {
          ...this.state,
          archivedSessionIds: this.state.archivedSessionIds.filter((id) => id !== sessionId),
        }
      },
      async enqueueOperation(fn) { calls.enqueue++; return fn() },
      async setState(next) { calls.setState++; this.state = next },
    }
    return reg
  }

  test('hasNativeUnarchive 形状判定', () => {
    assert.equal(hasNativeUnarchive({ unarchiveSession() {} }), true)
    assert.equal(hasNativeUnarchive({}), false)
    assert.equal(hasNativeUnarchive(undefined), false)
    assert.equal(hasNativeUnarchive(null), false)
  })

  await testAsync('★ 有原生入口时优先调用它，且不再自己 setState', async () => {
    const reg = nativeRegistry(['a', 'b'])
    const r = await unarchiveSession({ registry: reg }, 'a')
    assert.equal(r.ok, true)
    assert.equal(r.changed, true)
    assert.deepEqual(reg.calls.native, ['a'], '必须调用 registry.unarchiveSession')
    assert.equal(reg.calls.setState, 0, '不得再走自实现 setState 路径')
    assert.equal(reg.calls.enqueue, 0, '不得嵌套 enqueueOperation（会与原生内部队列死锁）')
    assert.deepEqual(r.next, ['b'])
    assert.equal(r.persistedVia, 'registry.unarchiveSession')
  })

  test('原生路径同样幂等：不在集合里就不调用', async () => {
    const reg = nativeRegistry(['b'])
    return unarchiveSession({ registry: reg }, 'a').then((r) => {
      assert.equal(r.ok, true)
      assert.equal(r.changed, false)
      assert.deepEqual(reg.calls.native, [], '未归档的会话不应触发写入')
    })
  })

  await testAsync('★ 陈旧守卫在原生路径同样生效（默认不清除）', async () => {
    // 守卫只在提供 sessionKnown 探针时生效（与回退路径一致）
    const reg = nativeRegistry(['gone'])
    const r = await unarchiveSession({ registry: reg, sessionKnown: () => false }, 'gone', {})
    assert.equal(r.ok, false)
    assert.equal(r.reason, UNARCHIVE_ERROR.SESSION_GONE)
    assert.deepEqual(reg.calls.native, [], '被守卫拦下时不得写入')
  })
  await testAsync('探针抛错按"不存在"处理（保守）', async () => {
    const reg = nativeRegistry(['gone'])
    const r = await unarchiveSession({ registry: reg, sessionKnown: () => { throw new Error('probe') } }, 'gone', {})
    assert.equal(r.ok, false)
    assert.equal(r.reason, UNARCHIVE_ERROR.SESSION_GONE)
  })

  await testAsync('allowStale=true 时放行', async () => {
    const reg = nativeRegistry(['gone'])
    const r = await unarchiveSession({ registry: reg }, 'gone', { allowStale: true })
    assert.equal(r.ok, true)
    assert.equal(r.changed, true)
    assert.deepEqual(reg.calls.native, ['gone'])
  })

  await testAsync('sessionKnown 返回 true 时放行', async () => {
    const reg = nativeRegistry(['alive'])
    const r = await unarchiveSession({ registry: reg, sessionKnown: () => true }, 'alive', {})
    assert.equal(r.ok, true)
    assert.equal(r.changed, true)
  })

  await testAsync('原生抛错 → persist-failed，不伪装成功', async () => {
    const reg = nativeRegistry(['a'], { throws: true })
    const r = await unarchiveSession({ registry: reg }, 'a')
    assert.equal(r.ok, false)
    assert.equal(r.reason, UNARCHIVE_ERROR.PERSIST_FAILED)
    assert.match(r.detail, /native boom/)
  })

  await testAsync('原生入口缺席 → 回退自实现（向后兼容）', async () => {
    const reg = {
      state: { archivedSessionIds: ['a', 'b'] },
      setStateCalls: 0,
      async enqueueOperation(fn) { return fn() },
      async setState(next) { this.setStateCalls++; this.state = next },
    }
    const r = await unarchiveSession({ registry: reg }, 'a')
    assert.equal(r.ok, true)
    assert.equal(r.changed, true)
    assert.equal(reg.setStateCalls, 1, '回退路径应走 setState')
    assert.equal(r.persistedVia, 'registry.enqueueOperation+setState')
  })
}

console.log(`\n${failed === 0 ? '全部通过' : '有失败'}: ${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
