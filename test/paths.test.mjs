/**
 * 路径编码单测。
 *
 * 运行：node test/paths.test.mjs
 *
 * 这些断言的期望值直接取自本机 `~/.dsh/sessions/` 下的**真实目录名**，
 * 所以它能真正证明"我的复刻与宿主一致"，而不只是"我的复刻自洽"。
 * 若宿主升级改了编码，这里会立刻红 —— 这正是本文件存在的意义。
 */

import { strict as assert } from 'node:assert'
import {
  compressionSuffix,
  encodeSegment,
  generationLogFilename,
  parseGenerationLogFilename,
  pickGenerationLog,
  projectDir,
  projectKey,
  sessionDir,
  candidateSessionDirs,
} from '../lib/paths.js'

let passed = 0
let failed = 0

function test(label, fn) {
  try {
    fn()
    passed++
    console.log(`  ✓ ${label}`)
  } catch (error) {
    failed++
    console.error(`  ✗ ${label}`)
    console.error(`      ${error.message}`)
  }
}

console.log('\n[1] projectKey 对照本机真实项目目录名')
const REAL_PROJECT_DIRS = [
  ['/home/slzca', '--home-slzca--'],
  ['/home/slzca/.local/bin', '--home-slzca-.local-bin--'],
  ['/home/slzca/deepseekwork/one', '--home-slzca-deepseekwork-one--'],
  ['/home/slzca/deepseekwork/two', '--home-slzca-deepseekwork-two--'],
  ['/home/slzca/deepseekwork/open', '--home-slzca-deepseekwork-open--'],
]
for (const [cwd, expected] of REAL_PROJECT_DIRS) {
  test(`${cwd} → ${expected}`, () => assert.equal(projectKey(cwd), expected))
}

console.log('\n[2] projectKey 边界')
test('分隔符折叠：连续斜杠只产生一个 -', () => {
  assert.equal(projectKey('/a//b'), projectKey('/a/b'))
})
test('前导分隔符被 strip 后由 -- 前缀兜住', () => {
  assert.equal(projectKey('/home'), '--home--')
})
test('纯分隔符退回 root 标记', () => {
  assert.equal(projectKey('/'), '--root--')
})
test('中文码位转 ~XXXX 大写四位', () => {
  // 中 = U+4E2D, 文 = U+6587
  assert.equal(projectKey('/文档'), '--~6587~6863--'.replace('~6587~6863', '~6587~6863'))
})
test('空 cwd 抛错（不返回可疑路径）', () => {
  assert.throws(() => projectKey(''), /empty project path/)
})
test('长度截断到 251 + 前后缀', () => {
  const key = projectKey('/' + 'a'.repeat(500))
  assert.equal(key.length, 2 + 251 + 2)
})

console.log('\n[3] encodeSegment')
test('普通会话 id 原样通过', () => {
  const id = 'session-40e1e744-f81a-4209-b840-e443b982d289'
  assert.equal(encodeSegment(id), id)
})
test('子代理数字 id 原样通过', () => {
  assert.equal(encodeSegment('71855897-1c8e-4bcd-bbd0-56eebdd6d532'), '71855897-1c8e-4bcd-bbd0-56eebdd6d532')
})
test('. 与 .. 被转义（防目录穿越）', () => {
  assert.equal(encodeSegment('.'), '~002E')
  assert.equal(encodeSegment('..'), '~002E~002E')
})
test('斜杠被转义（防逃出目录）', () => {
  assert.equal(encodeSegment('a/b'), 'a~002Fb')
  // `.` 属安全字符无需转义，但 `/` 必须转义 —— 失去分隔符后无法再穿越
  assert.equal(encodeSegment('../../etc'), '..~002F..~002Fetc')
})
test('波浪号自身被转义', () => {
  assert.equal(encodeSegment('a~b'), 'a~007Eb')
})
test('空串抛错', () => {
  assert.throws(() => encodeSegment(''), /empty path segment/)
})

console.log('\n[4] 目录与日志文件拼装')
test('projectDir 正常', () => {
  assert.equal(projectDir('/root', '/home/slzca/deepseekwork/open'),
    '/root/--home-slzca-deepseekwork-open--')
})
test('projectDir 无 cwd 走 _no-cwd（与宿主一致）', () => {
  assert.equal(projectDir('/root', undefined), '/root/_no-cwd')
})
test('projectDir 在 null 时按无 cwd 处理', () => {
  assert.equal(projectDir('/root', null), '/root/_no-cwd')
})
test('sessionDir 组合正确', () => {
  assert.equal(
    sessionDir('/root', '/home/slzca', 'session-abc'),
    '/root/--home-slzca--/session-abc',
  )
})
test('日志文件名与本机磁盘一致', () => {
  assert.equal(generationLogFilename(3, 'zstd'), 'session.v3.jsonl.zstd')
  assert.equal(generationLogFilename(3, 'none'), 'session.v3.jsonl')
})
test('压缩后缀', () => {
  assert.equal(compressionSuffix('zstd'), '.zstd')
  assert.equal(compressionSuffix('none'), '')
})

console.log('\n[5] 代际日志识别与选择（不硬编码版本号）')
test('接受 v3 zstd', () => {
  assert.deepEqual(parseGenerationLogFilename('session.v3.jsonl.zstd'), { version: 3, compression: 'zstd' })
})
test('接受未来版本 v12', () => {
  assert.deepEqual(parseGenerationLogFilename('session.v12.jsonl'), { version: 12, compression: 'none' })
})
test('拒绝 v0 / 前导零 / 大写 / 临时名', () => {
  for (const bad of ['session.v0.jsonl', 'session.v03.jsonl', 'session.v3.jsonl.ZSTD', 'session.v3.jsonl.tmp', 'session.lock', 'random']) {
    assert.equal(parseGenerationLogFilename(bad), null, `应拒绝 ${bad}`)
  }
})
test('多代际时选版本最大', () => {
  assert.equal(pickGenerationLog(['session.v2.jsonl.zstd', 'session.v3.jsonl.zstd']), 'session.v3.jsonl.zstd')
})
test('同版本优先 zstd', () => {
  assert.equal(pickGenerationLog(['session.v3.jsonl', 'session.v3.jsonl.zstd']), 'session.v3.jsonl.zstd')
})
test('无候选返回 null（调用方须据此拒绝删除）', () => {
  assert.equal(pickGenerationLog(['session.lock', 'notes.txt']), null)
})

console.log('\n[6] candidateSessionDirs：候选而非单值')
test('优先返回记录的原始路径', () => {
  const out = candidateSessionDirs({ root: '/root', cwd: '/a', sessionId: 's1', originalSessionDir: '/x/y/s1' })
  assert.equal(out[0], '/x/y/s1')
  assert.ok(out.includes('/root/--a--/s1'))
})
test('无原始路径时退回现算', () => {
  assert.deepEqual(candidateSessionDirs({ root: '/root', cwd: '/a', sessionId: 's1' }), ['/root/--a--/s1'])
})
test('去重', () => {
  const out = candidateSessionDirs({ root: '/root', cwd: '/a', sessionId: 's1', originalSessionDir: '/root/--a--/s1' })
  assert.equal(out.length, 1)
})
test('没有任何可用输入时返回空数组（调用方须拒绝删除）', () => {
  assert.deepEqual(candidateSessionDirs({ sessionId: 's1' }), [])
})

console.log(`\n${failed === 0 ? '全部通过' : '有失败'}: ${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
