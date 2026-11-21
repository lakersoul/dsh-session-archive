/**
 * 归档列表解析单测。
 * 运行：node test/archive-list.test.mjs
 *
 * 重点覆盖会让前任插件栽跟头的那些边界：
 *  - 持久化项的两种形状（`{header}` 快照 vs 裸 header）—— session-manager 只认后者
 *  - 陈旧归档标记（归档集合里有、会话却不存在）—— 必须报告而**不得**擅自清理
 *  - 实时会话优先于持久化
 */

import { strict as assert } from 'node:assert'
import {
  STATE,
  activityOf,
  buildHeaderIndex,
  headerOf,
  resolveArchivedSessions,
} from '../lib/archive-list.js'

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
const hdr = (id, extra = {}) => ({ id, createdAt: 1000, updatedAt: 2000, cwd: '/w', ...extra })

console.log('\n[1] headerOf：两种持久化形状都要认')
test('接受 {header} 快照形状（0.1.5-rc.2）', () => {
  assert.equal(headerOf({ header: hdr('s1'), revision: 1 })?.id, 's1')
})
test('接受裸 header 形状（旧契约）', () => {
  assert.equal(headerOf(hdr('s2'))?.id, 's2')
})
test('拒绝 null / 非对象 / 缺 id / 空 id', () => {
  for (const bad of [null, undefined, 42, 'x', {}, { header: null }, { header: {} }, { id: '' }]) {
    assert.equal(headerOf(bad), null, `应拒绝 ${JSON.stringify(bad)}`)
  }
})
test('header 为 null 时退回裸对象自身', () => {
  // {header: null, id: 's3'} → candidate 取 item 自身
  assert.equal(headerOf({ header: null, id: 's3' })?.id, 's3')
})

console.log('\n[2] buildHeaderIndex：实时优先')
test('实时覆盖同 id 的持久化记录', () => {
  const idx = buildHeaderIndex([hdr('s1', { cwd: '/live' })], [{ header: hdr('s1', { cwd: '/disk' }) }])
  assert.equal(idx.get('s1').live, true)
  assert.equal(idx.get('s1').header.cwd, '/live')
})
test('只有持久化时 live=false', () => {
  const idx = buildHeaderIndex([], [{ header: hdr('s1') }])
  assert.equal(idx.get('s1').live, false)
})
test('忽略无法归一化的条目', () => {
  const idx = buildHeaderIndex([hdr('s1')], [null, {}, 'x', { header: {} }])
  assert.equal(idx.size, 1)
})

console.log('\n[3] activityOf')
test('优先 updatedAt', () => assert.equal(activityOf({ createdAt: 1, updatedAt: 9 }), 9))
test('退回 createdAt', () => assert.equal(activityOf({ createdAt: 5 }), 5))
test('都没有则 0', () => assert.equal(activityOf({}), 0))
test('非有限数视为缺失', () => assert.equal(activityOf({ updatedAt: NaN, createdAt: 3 }), 3))

console.log('\n[4] resolveArchivedSessions：主流程')
test('正常条目带出 title/cwd/时间', () => {
  const { items } = resolveArchivedSessions({
    archivedIds: ['s1'],
    persistedItems: [{ header: hdr('s1', { cwd: '/proj' }) }],
    titles: new Map([['s1', '我的会话']]),
  })
  assert.equal(items.length, 1)
  assert.equal(items[0].state, STATE.OK)
  assert.equal(items[0].title, '我的会话')
  assert.equal(items[0].cwd, '/proj')
  assert.equal(items[0].live, false)
})
test('titles 也接受普通对象', () => {
  const { items } = resolveArchivedSessions({ archivedIds: ['s1'], persistedItems: [hdr('s1')], titles: { s1: 'T' } })
  assert.equal(items[0].title, 'T')
})
test('实时会话标记 live=true', () => {
  const { items } = resolveArchivedSessions({ archivedIds: ['s1'], liveHeaders: [hdr('s1')] })
  assert.equal(items[0].live, true)
})

console.log('\n[5] 陈旧归档标记：必须报告，绝不擅自清理')
test('找不到的 id 标为 missing 并保留在结果里', () => {
  const { items, summary } = resolveArchivedSessions({ archivedIds: ['ghost'], persistedItems: [hdr('s1')] })
  assert.equal(items.length, 1)
  assert.equal(items[0].sessionId, 'ghost')
  assert.equal(items[0].state, STATE.MISSING)
  assert.equal(summary.missing, 1)
})
test('missing 条目的字段全部为安全空值', () => {
  const { items } = resolveArchivedSessions({ archivedIds: ['ghost'] })
  const it = items[0]
  assert.equal(it.title, null)
  assert.equal(it.cwd, null)
  assert.equal(it.createdAt, null)
  assert.equal(it.activityAt, 0)
  assert.equal(it.live, false)
})
test('解析结果里不含"删除标记"之类的副作用字段', () => {
  const { items } = resolveArchivedSessions({ archivedIds: ['ghost'] })
  assert.deepEqual(Object.keys(items[0]).sort(), [
    'activityAt', 'createdAt', 'cwd', 'live', 'running', 'sessionId', 'state', 'title', 'updatedAt',
  ])
})

console.log('\n[6] 去重与排序')
test('重复 id 只出现一次', () => {
  const { items, summary } = resolveArchivedSessions({ archivedIds: ['s1', 's1', 's1'], persistedItems: [hdr('s1')] })
  assert.equal(items.length, 1)
  assert.equal(summary.total, 1)
})
test('忽略非字符串 / 空串 id', () => {
  const { items } = resolveArchivedSessions({ archivedIds: [null, 42, '', 's1'], persistedItems: [hdr('s1')] })
  assert.equal(items.length, 1)
})
test('按活动时间降序', () => {
  const { items } = resolveArchivedSessions({
    archivedIds: ['old', 'new', 'mid'],
    persistedItems: [
      hdr('old', { updatedAt: 100 }),
      hdr('new', { updatedAt: 300 }),
      hdr('mid', { updatedAt: 200 }),
    ],
  })
  assert.deepEqual(items.map((i) => i.sessionId), ['new', 'mid', 'old'])
})
test('同活动时间按 id 升序（结果稳定）', () => {
  const { items } = resolveArchivedSessions({
    archivedIds: ['b', 'a', 'c'],
    persistedItems: [hdr('a', { updatedAt: 5 }), hdr('b', { updatedAt: 5 }), hdr('c', { updatedAt: 5 })],
  })
  assert.deepEqual(items.map((i) => i.sessionId), ['a', 'b', 'c'])
})
test('missing 条目 activityAt=0，排在最后', () => {
  const { items } = resolveArchivedSessions({
    archivedIds: ['ghost', 'real'],
    persistedItems: [hdr('real', { updatedAt: 1 })],
  })
  assert.deepEqual(items.map((i) => i.sessionId), ['real', 'ghost'])
})

console.log('\n[7] summary 计数')
test('ok / missing / live 分别计数', () => {
  const { summary } = resolveArchivedSessions({
    archivedIds: ['a', 'b', 'c', 'ghost'],
    liveHeaders: [hdr('a')],
    persistedItems: [hdr('b'), hdr('c')],
  })
  assert.deepEqual(summary, { total: 4, ok: 3, missing: 1, live: 1, running: 0 })
})
test('空输入不炸', () => {
  const { items, summary } = resolveArchivedSessions()
  assert.deepEqual(items, [])
  assert.deepEqual(summary, { total: 0, ok: 0, missing: 0, live: 0, running: 0 })
})
test('archivedIds 非数组时按空处理', () => {
  const { summary } = resolveArchivedSessions({ archivedIds: 'not-an-array' })
  assert.equal(summary.total, 0)
})

console.log('\n[8] 无 cwd 的会话（_no-cwd 分组）')
test('cwd 缺失时归一为 null 而不是 undefined', () => {
  const { items } = resolveArchivedSessions({ archivedIds: ['s1'], persistedItems: [hdr('s1', { cwd: undefined })] })
  assert.equal(items[0].cwd, null)
})

console.log('\n[9] ★ running 与 live 必须区分（回归：打开过的归档会话删不掉）')
test('live 会话的 running 默认为 false', () => {
  const { items } = resolveArchivedSessions({ archivedIds: ['s1'], liveHeaders: [hdr('s1')] })
  assert.equal(items[0].live, true)
  assert.equal(items[0].running, false, 'live 不等于 running —— 打开过不阻碍删除')
})
test('runningIds 命中时 running 为 true', () => {
  const { items } = resolveArchivedSessions({
    archivedIds: ['s1', 's2'],
    liveHeaders: [hdr('s1'), hdr('s2')],
    runningIds: new Set(['s2']),
  })
  const byId = Object.fromEntries(items.map((i) => [i.sessionId, i]))
  assert.equal(byId.s1.running, false)
  assert.equal(byId.s2.running, true)
})
test('runningIds 接受数组形式', () => {
  const { items } = resolveArchivedSessions({ archivedIds: ['s1'], liveHeaders: [hdr('s1')], runningIds: ['s1'] })
  assert.equal(items[0].running, true)
})
test('runningIds 为 undefined 时全部 false（不误判）', () => {
  const { items } = resolveArchivedSessions({ archivedIds: ['s1'], liveHeaders: [hdr('s1')] })
  assert.equal(items[0].running, false)
})
test('missing 条目 running 恒为 false', () => {
  const { items } = resolveArchivedSessions({ archivedIds: ['ghost'], runningIds: new Set(['ghost']) })
  assert.equal(items[0].running, false, '不存在的会话谈不上"正在运行"')
})
test('summary.running 计数正确', () => {
  const { summary } = resolveArchivedSessions({
    archivedIds: ['a', 'b'],
    liveHeaders: [hdr('a'), hdr('b')],
    runningIds: new Set(['a']),
  })
  assert.equal(summary.running, 1)
  assert.equal(summary.live, 2)
})

console.log(`\n${failed === 0 ? '全部通过' : '有失败'}: ${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
