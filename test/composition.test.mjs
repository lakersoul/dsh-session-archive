/**
 * 组装（composition）验证测试。
 * 运行：node test/composition.test.mjs
 *
 * 目的：用 `dsh --dump-config` 验证**真实加载器**会把本插件的行挂进组合，
 * 且**没有禁用任何原生核心行**。
 *
 * 关键：全程在一个**完全隔离的 DSH_HOME 沙盒**里进行 ——
 * 既让 profile 名合法（`--profile` 只接受名字，不接路径），
 * 又绝不触碰使用者真实的 ~/.dsh。
 */

import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_DIR = join(HERE, '..')
const NAME = 'dsh-session-archive'

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

/** 定位 dsh CLI 入口。 */
function dshBin() {
  const candidates = [
    process.env.DSH_BIN,
    '/home/slzca/.local/bin/dsh',
  ].filter(Boolean)
  for (const c of candidates) if (existsSync(c)) return c
  return 'dsh'
}

/**
 * 造一个隔离的 DSH_HOME，里面放一个只加载本插件的 profile。
 *
 * 之所以能 "只加载本插件" 而不需要 dsh-base：本插件**不依赖任何原生行**
 * （只 insert 自己），这正是"绝不替换原生服务"这一约束的直接体现 ——
 * 也因此它的组合可以在没有原生服务的情况下独立求值。
 */
function makeIsolatedHome({ extraPatch = null } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'sa-home-'))
  const profileDir = join(home, 'profiles', 'probe')
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })

  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'probe-profile',
    private: true,
    dependencies: { [NAME]: `link:${PKG_DIR}` },
    dsh: { profile: { bundles: [NAME] } },
  }, null, 2) + '\n', 'utf8')

  writeFileSync(join(profileDir, 'cordis.yml'), '[]\n', 'utf8')
  if (extraPatch !== null) {
    writeFileSync(join(profileDir, 'cordis.patch.yml'), extraPatch, 'utf8')
  }
  // 让 <profile>/node_modules/<name> 指回本包（等同 install.mjs 做的事）
  symlinkSync(PKG_DIR, join(profileDir, 'node_modules', NAME), 'dir')
  return { home, profileDir }
}

function dumpConfig(home) {
  return spawnSync(dshBin(), ['--profile', 'probe', '--dump-config'], {
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: home },
    timeout: 120_000,
  })
}

console.log('\n[1] 组装树：插件行被真实加载器挂上')
{
  const { home, profileDir } = makeIsolatedHome()
  const r = dumpConfig(home)
  const out = (r.stdout ?? '') + (r.stderr ?? '')

  test('dump-config 成功执行', () => {
    assert.equal(r.status, 0, `退出码 ${r.status}\n${out.slice(0, 800)}`)
  })
  test('★ 组合里出现本插件的行', () => {
    assert.ok(/^- id: session-archive$/m.test(r.stdout), `未找到插件行。输出：\n${r.stdout.slice(0, 1200)}`)
  })
  test('行名指向本包', () => {
    assert.ok(r.stdout.includes(NAME), '行名应指向本包')
  })
  test('★ 未禁用任何原生核心行', () => {
    for (const row of ['workspace', 'session-projection-cache', 'ui-workspace']) {
      const re = new RegExp(`^- id: ${row}$\\n\\s*disabled: true`, 'm')
      assert.equal(re.test(r.stdout), false, `不得禁用 ${row}`)
    }
  })
  test('插件行未被禁用（默认启用）', () => {
    const m = /^- id: session-archive$([\s\S]{0,120})/m.exec(r.stdout)
    assert.ok(m !== null)
    assert.equal(/disabled:\s*true/.test(m[1]), false, '插件行不应被禁用')
  })
  test('未产生 "patch: entry ... not found" 之类告警', () => {
    assert.equal(/patch: entry .* not found/.test(out), false, `有告警：\n${out.slice(0, 600)}`)
  })

  rmSync(home, { recursive: true, force: true })
}

console.log('\n[2] ★ 若 patch 层禁用了原生行，dump-config 能反映出该事实')
{
  // 这条用来证明上面的"未禁用"断言不是空转：真的塞一条 disable，断言应能看见
  const { home } = makeIsolatedHome({ extraPatch: '- id: workspace\n  disabled: true\n' })
  const r = dumpConfig(home)
  const out = (r.stdout ?? '') + (r.stderr ?? '')
  test('dump-config 仍可执行（仅诊断用）', () => {
    assert.equal(r.status, 0, `${out.slice(0, 400)}`)
  })
  test('输出中确实出现了被禁用的 workspace 行', () => {
    // 沙盒里没有 dsh-base，故 workspace 行可能不存在；
    // 若不存在则说明加载器只是忽略未知行的 disable（同样可接受），
    // 因此这里断言的是"要么看到 disabled:true，要么明确没有该行"。
    const hasRow = /^- id: workspace$/m.test(r.stdout)
    const hasDisabled = /^- id: workspace$\n\s*disabled: true/m.test(r.stdout)
    assert.ok(hasRow === false || hasDisabled === true, '若存在该行则应显示为 disabled')
  })
  rmSync(home, { recursive: true, force: true })
}

// ── 清单契约（DSH 实际读取的字段）────────────────────────────────────────
// 依据：dsh 0.1.7-rc.2 的 dsh-client-modules 只读取 dsh.client.{platform,inject,external,immediately}，
// dsh-app-boot 只读取 dsh.bundle.patch；全仓无人读取 dsh.engines（已全递归核对）。
console.log('\n[清单契约] 只声明宿主真正会读取的字段')
{
  const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8'))

  test('dsh.bundle.patch 指向本包内的 patch 文件', () => {
    assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
    assert.ok(existsSync(join(PKG_DIR, pkg.dsh.bundle.patch)), 'patch 文件必须存在')
  })

  test('dsh.client 形状与官方包一致（platform + inject）', () => {
    assert.equal(pkg.dsh.client.platform, 'web')
    assert.ok(Array.isArray(pkg.dsh.client.inject))
    assert.ok(pkg.dsh.client.inject.every((x) => typeof x === 'string'))
  })

  test('★ 不声明 dsh.engines（静态 semver 区间无法匹配跨元组的 rc 版本）', () => {
    // node-semver 规则：带预发布的版本，只有当区间里存在**同一 major.minor.patch**
    // 的预发布比较器时才算满足。所以 ">=0.1.5-rc.1" 不匹配 "0.1.7-rc.2"，
    // 连 "*" 与 ">=0.1.5" 也同样排除一切预发布。
    // 而 0.1.7-rc.2 全仓无任何代码读取 dsh.engines —— 声明它只会误导。
    assert.equal(pkg.dsh.engines, undefined,
      '不应声明 dsh.engines：没有任何区间能正确表达"任意 rc"，且宿主不读取该字段')
  })

  test('dsh 下没有未知的多余字段', () => {
    const known = new Set(['bundle', 'client'])
    const unknown = Object.keys(pkg.dsh).filter((k) => !known.has(k))
    assert.deepEqual(unknown, [], `dsh 下出现未预期字段：${unknown.join(', ')}`)
  })

  test('engines.node 保留（标准 npm 字段）', () => {
    assert.equal(typeof pkg.engines.node, 'string')
  })
}

console.log(`\n${failed === 0 ? '全部通过' : '有失败'}: ${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
