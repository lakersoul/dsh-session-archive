/**
 * 覆盖率分析（基于 V8 精确覆盖）。
 * 运行：node test/coverage.mjs
 *
 * 目的：客观暴露"哪些代码从未被任何测试执行过"。未覆盖的分支就是残余风险所在，
 * 尤其在**删除/恢复**这类不可逆路径上（本项目最容易出事的地方）。
 *
 * 只统计 lib/ 下的插件自身代码；测试文件不计入。
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_DIR = join(HERE, '..')
const LIB_DIR = join(PKG_DIR, 'lib')

/** 逐套件执行，收集 V8 覆盖。 */
const SUITES = [
  'paths.test.mjs',
  'paths.disk.test.mjs',
  'archive-list.test.mjs',
  'unarchive.test.mjs',
  'trash.test.mjs',
  'trash-io.test.mjs',
  'hardening.test.mjs',
  'host.apply.test.mjs',
  'ghost-regression.test.mjs',
  'client.test.mjs',
  'install.test.mjs',
  'composition.test.mjs',
]

/**
 * 用 `--experimental-test-coverage` 不行（我们不是 node:test），改用 inspector。
 * 做法：在子进程里启用 NODE_V8_COVERAGE，跑完读 JSON。
 */
function runSuiteWithCoverage(suite) {
  const dir = mkdtempSync(join(tmpdir(), 'coverage-'))
  const result = spawnSync(process.execPath, [join(HERE, suite)], {
    cwd: PKG_DIR,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_V8_COVERAGE: dir,
      // 组装树测试需要隔离 DSH_HOME（它自己会造）
    },
    timeout: 180_000,
  })
  return { dir, status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/** 从 V8 覆盖记录里累加每个脚本的区间命中情况。 */
function accumulate(coverageDir, totals) {
  let files = []
  try {
    files = readdirSync(coverageDir)
  } catch {
    return
  }
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    let json
    try {
      json = JSON.parse(readFileSync(join(coverageDir, file), 'utf8'))
    } catch {
      continue
    }
    for (const script of json.result ?? []) {
      const url = script.url ?? ''
      if (!url.startsWith('file://')) continue
      const path = url.slice('file://'.length)
      if (!path.startsWith(LIB_DIR)) continue
      const key = relative(LIB_DIR, path)
      if (!totals.has(key)) totals.set(key, { ranges: new Map(), text: null })
      const entry = totals.get(key)
      if (entry.text === null) {
        try { entry.text = readFileSync(path, 'utf8') } catch { /* ignore */ }
      }
      // 合并区间：同一位置只要命中过一次就算覆盖
      for (const fn of script.functions ?? []) {
        for (const range of fn.ranges ?? []) {
          const id = `${range.startOffset}-${range.endOffset}`
          const prev = entry.ranges.get(id)
          if (prev === undefined || range.count > prev) entry.ranges.set(id, range.count)
        }
      }
    }
  }
}

/** 把区间覆盖折算成"行是否被执行过"的近似（用最内层区间判定）。 */
function lineCoverage(entry) {
  const { text, ranges } = entry
  if (text === null || ranges.size === 0) return { total: 0, covered: 0, lines: [] }
  const lines = text.split('\n')
  let offset = 0
  const lineStarts = lines.map((l) => {
    const start = offset
    offset += l.length + 1
    return start
  })

  // 对每个字符位置取"包含它的最小区间"的 count
  const hitAt = (pos) => {
    let best = null
    for (const [id, count] of ranges) {
      const [s, e] = id.split('-').map(Number)
      if (pos >= s && pos < e) {
        const width = e - s
        if (best === null || width < best.width) best = { width, count }
      }
    }
    return best === null ? null : best.count
  }

  const result = []
  let total = 0
  let covered = 0
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const trimmed = raw.trim()
    // 跳过空行与纯注释，避免污染覆盖率
    if (trimmed.length === 0 || trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) {
      continue
    }
    total++
    const hit = hitAt(lineStarts[i] + (raw.length - raw.trimStart().length))
    const isHit = hit !== null && hit > 0
    if (isHit) covered++
    else result.push({ line: i + 1, text: trimmed.slice(0, 90) })
  }
  return { total, covered, lines: result }
}

console.log('跑全部套件并采集覆盖…\n')
const totals = new Map()
const suiteFailures = []
for (const suite of SUITES) {
  const { dir, status, stdout } = runSuiteWithCoverage(suite)
  accumulate(dir, totals)
  rmSync(dir, { recursive: true, force: true })
  const skipped = (stdout ?? '').includes('跳过')
  process.stdout.write(`  ${status === 0 ? '✓' : '✗'} ${suite}${skipped ? '（含跳过）' : ''}\n`)
  if (status !== 0) suiteFailures.push(suite)
}

console.log('\n' + '='.repeat(72))
console.log('lib/ 行覆盖率')
console.log('='.repeat(72))

let grandTotal = 0
let grandCovered = 0
const uncoveredDetail = []

for (const [file, entry] of [...totals.entries()].sort()) {
  const { total, covered, lines } = lineCoverage(entry)
  grandTotal += total
  grandCovered += covered
  const pct = total === 0 ? 0 : Math.round((covered / total) * 1000) / 10
  console.log(`  ${file.padEnd(20)} ${String(covered).padStart(4)}/${String(total).padEnd(4)}  ${String(pct).padStart(5)}%`)
  if (lines.length > 0) uncoveredDetail.push({ file, lines })
}

const grandPct = grandTotal === 0 ? 0 : Math.round((grandCovered / grandTotal) * 1000) / 10
console.log('-'.repeat(72))
console.log(`  ${'合计'.padEnd(19)} ${String(grandCovered).padStart(4)}/${String(grandTotal).padEnd(4)}  ${String(grandPct).padStart(5)}%`)

if (uncoveredDetail.length > 0) {
  console.log('\n未覆盖的行（残余风险）：')
  for (const { file, lines } of uncoveredDetail) {
    console.log(`\n  ${file}（${lines.length} 行）`)
    for (const l of lines.slice(0, 25)) console.log(`    ${String(l.line).padStart(4)}: ${l.text}`)
    if (lines.length > 25) console.log(`    … 另有 ${lines.length - 25} 行`)
  }
}

if (suiteFailures.length > 0) {
  console.error(`\n有套件失败：${suiteFailures.join(', ')}`)
  process.exit(1)
}
console.log('')
