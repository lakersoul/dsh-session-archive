/**
 * 真实磁盘交叉验证：直接读 ~/.dsh/sessions 下的目录名，
 * 反向验证 projectKey / encodeSegment / sessionDir 的推导结果。
 *
 * 与 paths.test.mjs 的区别：那里是硬编码期望值（会随我写错而一起错），
 * 这里是从**宿主实际创建的目录**反推，属于独立证据。
 *
 * 运行：node test/paths.disk.test.mjs
 * 若 ~/.dsh/sessions 不存在或为空，则以退出码 0 跳过（便于 CI/异机运行）。
 */

import { strict as assert } from 'node:assert'
import { readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { encodeSegment, parseGenerationLogFilename, pickGenerationLog, projectKey, sessionDir } from '../lib/paths.js'

const ROOT = join(homedir(), '.dsh', 'sessions')

if (!existsSync(ROOT)) {
  console.log(`跳过：${ROOT} 不存在`)
  process.exit(0)
}

const projectDirs = readdirSync(ROOT, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)

if (projectDirs.length === 0) {
  console.log(`跳过：${ROOT} 下没有项目目录`)
  process.exit(0)
}

let checked = 0
let failed = 0
const failures = []

// 1) 每个真实项目目录名，必须能由某个 cwd 推导出来；用目录内会话的 header 无从读取，
//    改为验证「目录名符合 projectKey 的形状契约」：--…-- 包裹、无路径分隔符、无 '~' 孤立。
for (const name of projectDirs) {
  checked++
  if (!name.startsWith('--') || !name.endsWith('--')) {
    failed++
    failures.push(`${name}: 不符合 --…-- 包裹形状`)
    continue
  }
  const inner = name.slice(2, -2)
  if (inner.length === 0) {
    failed++
    failures.push(`${name}: 内层为空`)
    continue
  }
  if (inner.includes('/') || inner.includes('\\')) {
    failed++
    failures.push(`${name}: 仍含路径分隔符`)
    continue
  }
}

// 2) 每个真实会话目录名，必须满足 encodeSegment 的幂等性：
//    encodeSegment(目录名) === 目录名（说明它本身就是一个 encodeSegment 的不动点）。
for (const project of projectDirs) {
  const projectPath = join(ROOT, project)
  if (!statSync(projectPath).isDirectory()) continue
  for (const entry of readdirSync(projectPath, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    checked++
    const name = entry.name
    let encoded
    try {
      encoded = encodeSegment(name)
    } catch (error) {
      failed++
      failures.push(`${project}/${name}: encodeSegment 抛错 ${error.message}`)
      continue
    }
    if (encoded !== name) {
      failed++
      failures.push(`${project}/${name}: encodeSegment 非不动点 → ${encoded}`)
    }
  }
}

// 3) 逐会话目录：必须能识别出代际日志文件，且命中真实存在的文件。
let withLog = 0
for (const project of projectDirs) {
  const projectPath = join(ROOT, project)
  for (const entry of readdirSync(projectPath, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(projectPath, entry.name)
    const files = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name)
    const picked = pickGenerationLog(files)
    if (picked === null) continue
    withLog++
    if (!files.includes(picked)) {
      failed++
      failures.push(`${project}/${entry.name}: 选中了不存在的文件 ${picked}`)
    }
    if (parseGenerationLogFilename(picked) === null) {
      failed++
      failures.push(`${project}/${entry.name}: 选中的文件无法解析 ${picked}`)
    }
  }
}

// 4) 用真实 project 目录名反推：把某个 cwd 编码后应落在同一个项目目录。
//    这里用本机已知的真实映射做一次端到端拼装验证。
const knownMapping = [
  ['/home/slzca', '--home-slzca--'],
  ['/home/slzca/.local/bin', '--home-slzca-.local-bin--'],
  ['/home/slzca/deepseekwork/one', '--home-slzca-deepseekwork-one--'],
  ['/home/slzca/deepseekwork/two', '--home-slzca-deepseekwork-two--'],
  ['/home/slzca/deepseekwork/open', '--home-slzca-deepseekwork-open--'],
]
for (const [cwd, dirName] of knownMapping) {
  if (!projectDirs.includes(dirName)) continue // 该工作区当前无会话，跳过
  checked++
  const derived = projectKey(cwd)
  if (derived !== dirName) {
    failed++
    failures.push(`projectKey(${cwd}) = ${derived}，但磁盘上是 ${dirName}`)
  }
}

// 5) sessionDir 端到端：对每个真实会话目录，验证
//    sessionDir(ROOT, cwd, id) 能算出该目录（cwd 由目录名反解不可行，
//    故只验证"任意已知 cwd + 真实 id"能落在其所属项目目录下）。
for (const project of projectDirs) {
  const projectPath = join(ROOT, project)
  const sessions = readdirSync(projectPath, { withFileTypes: true }).filter((e) => e.isDirectory())
  if (sessions.length === 0) continue
  const sample = sessions[0].name
  const mapped = knownMapping.find(([, dirName]) => dirName === project)
  if (mapped === undefined) continue
  checked++
  const derived = sessionDir(ROOT, mapped[0], sample)
  if (derived !== join(projectPath, sample)) {
    failed++
    failures.push(`sessionDir 拼装不符: ${derived} ≠ ${join(projectPath, sample)}`)
  }
}

console.log(`磁盘交叉验证：项目目录 ${projectDirs.length} 个，检查点 ${checked}，其中含日志的会话目录 ${withLog}`)
if (failed > 0) {
  console.error(`\n有 ${failed} 项失败：`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}
assert.ok(true)
console.log('全部通过 ✓\n')
