/**
 * 测试入口：按顺序跑全部测试，任一失败即非零退出。
 * 运行：node test/run.mjs
 */

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))

const SUITES = [
  ['路径编码（硬编码期望值）', 'paths.test.mjs'],
  ['路径编码（真实磁盘交叉验证）', 'paths.disk.test.mjs'],
  ['归档列表解析', 'archive-list.test.mjs'],
  ['恢复归档（含并发不丢更新）', 'unarchive.test.mjs'],
  ['回收站纯逻辑（防误删校验/容量策略）', 'trash.test.mjs'],
  ['回收站文件操作（含失败回滚）', 'trash-io.test.mjs'],
  ['host half apply 冒烟 + P3 端到端', 'host.apply.test.mjs'],
  ['★ 幽灵回归（删除后不再复活）', 'ghost-regression.test.mjs'],
  ['client bundle 格式与座位契约', 'client.test.mjs'],
  ['P5 加固（内容完整性/容量拦截/手动清理）', 'hardening.test.mjs'],
  ['install.mjs 生命周期（沙盒 profile）', 'install.test.mjs'],
  ['组装树（隔离 DSH_HOME，真实加载器）', 'composition.test.mjs'],
]

let failedSuites = 0

for (const [label, file] of SUITES) {
  console.log(`\n${'═'.repeat(60)}\n▶ ${label}  (${file})\n${'═'.repeat(60)}`)
  const result = spawnSync(process.execPath, [join(HERE, file)], { stdio: 'inherit' })
  if (result.status !== 0) {
    failedSuites++
    console.error(`\n✗ ${label} 失败（退出码 ${result.status}）`)
  }
}

console.log(`\n${'═'.repeat(60)}`)
if (failedSuites === 0) {
  console.log(`全部测试套件通过 ✓（共 ${SUITES.length} 套）`)
  process.exit(0)
}
console.error(`有 ${failedSuites}/${SUITES.length} 套测试失败 ✗`)
process.exit(1)
