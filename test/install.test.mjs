/**
 * install.mjs 生命周期测试（沙盒 profile）。
 * 运行：node test/install.test.mjs
 *
 * 为什么值得测：安装/卸载会**改写使用者的 profile manifest 与 patch 层**，
 * 而这是本项目唯一会动到 profile 配置的操作。此前只做过 --dry-run，
 * 真实落盘路径（备份、符号链接、幂等、卸载、不变量拦截）都还没验证。
 *
 * 测试全部在临时目录里进行，**绝不触碰真实 profile**。
 */

import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_DIR = join(HERE, '..')
const INSTALL = join(PKG_DIR, 'install.mjs')
const NAME = 'dsh-session-archive'
const ROW_ID = 'session-archive'

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

/** 造一个与真实 profile 同构的沙盒。 */
function makeSandbox({ patchBody = null, manifestExtra = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sa-install-'))
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  const manifest = {
    name: 'sandbox-profile',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    ...manifestExtra,
  }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  if (patchBody !== null) writeFileSync(join(dir, 'cordis.patch.yml'), patchBody, 'utf8')
  return dir
}

function runInstaller(sandbox, args = []) {
  return spawnSync(process.execPath, [INSTALL, '--profile', sandbox, ...args], {
    encoding: 'utf8',
    cwd: PKG_DIR,
  })
}

function readManifest(sandbox) {
  return JSON.parse(readFileSync(join(sandbox, 'package.json'), 'utf8'))
}

console.log('\n[1] dry-run 不落盘')
{
  const sandbox = makeSandbox()
  const before = readFileSync(join(sandbox, 'package.json'), 'utf8')
  const r = runInstaller(sandbox, ['--dry-run'])
  test('退出码 0', () => assert.equal(r.status, 0, r.stderr))
  test('manifest 未被改写', () => {
    assert.equal(readFileSync(join(sandbox, 'package.json'), 'utf8'), before)
  })
  test('未建立符号链接', () => {
    assert.equal(existsSync(join(sandbox, 'node_modules', NAME)), false)
  })
  test('输出里说明了将要做的改动', () => {
    assert.ok(r.stdout.includes('计划改动'))
    assert.ok(r.stdout.includes('dsh.profile.bundles 追加'))
  })
  test('输出里声明了不变量', () => {
    assert.ok(r.stdout.includes('未禁用任何原生核心行'))
  })
  rmSync(sandbox, { recursive: true, force: true })
}

console.log('\n[2] 正规 bundle 通道：安装')
{
  const sandbox = makeSandbox({ patchBody: '- id: hmr\n  disabled: false\n' })
  const r = runInstaller(sandbox)
  test('退出码 0', () => assert.equal(r.status, 0, r.stderr))

  const manifest = readManifest(sandbox)
  test('dependencies 记录 link: 规格', () => {
    assert.equal(manifest.dependencies[NAME], `link:${PKG_DIR}`)
  })
  test('bundles 追加了包名（置于末位）', () => {
    const bundles = manifest.dsh.profile.bundles
    assert.equal(bundles[bundles.length - 1], NAME)
  })
  test('建立符号链接指向本包目录', () => {
    const link = join(sandbox, 'node_modules', NAME)
    assert.equal(lstatSync(link).isSymbolicLink(), true)
    assert.equal(readlinkSync(link), PKG_DIR)
  })
  test('manifest 备份已生成', () => {
    const backups = readdirSync(sandbox).filter((f) => f.startsWith('package.json.bak-'))
    assert.ok(backups.length >= 1, '应生成备份')
  })
  test('★ 不变量：未 disabled 任何原生核心行', () => {
    const patch = readFileSync(join(sandbox, 'cordis.patch.yml'), 'utf8')
    for (const row of ['workspace', 'session-projection-cache', 'ui-workspace']) {
      const re = new RegExp(`-\\s*id:\\s*${row}\\s*\\n\\s*disabled:\\s*true`)
      assert.equal(re.test(patch), false, `不得禁用 ${row}`)
    }
  })
  rmSync(sandbox, { recursive: true, force: true })
}

console.log('\n[3] 幂等：重复安装不产生重复条目')
{
  const sandbox = makeSandbox()
  runInstaller(sandbox)
  const first = readFileSync(join(sandbox, 'package.json'), 'utf8')
  const r2 = runInstaller(sandbox)
  const second = readFileSync(join(sandbox, 'package.json'), 'utf8')

  test('第二次退出码 0', () => assert.equal(r2.status, 0, r2.stderr))
  test('manifest 完全未变', () => assert.equal(second, first))
  test('提示已是目标状态', () => assert.ok(r2.stdout.includes('已是目标状态')))
  test('bundles 里只有一条', () => {
    const bundles = readManifest(sandbox).dsh.profile.bundles
    assert.equal(bundles.filter((b) => b === NAME).length, 1)
  })
  rmSync(sandbox, { recursive: true, force: true })
}

console.log('\n[3b] ★ 相对符号链接：解析正确即视为已就绪（防误报"指向他处"）')
{
  const sandbox = makeSandbox()
  runInstaller(sandbox)
  // 把绝对链接改写成**相对**链接 —— 这正是 pnpm 规范化 link: 依赖后的形态。
  // 字面量变了，但解析结果不变，因此不应被视为需要改动。
  const link = join(sandbox, 'node_modules', NAME)
  rmSync(link, { force: true })
  const rel = relative(dirname(link), PKG_DIR)
  symlinkSync(rel, link, 'dir')

  const literal = readlinkSync(link)
  test('链接字面量确实是相对的', () => assert.ok(!literal.startsWith('/'), literal))
  test('但解析后指向本包目录', () => assert.equal(realpathSync(link), realpathSync(PKG_DIR)))

  const r = runInstaller(sandbox)
  test('退出码 0', () => assert.equal(r.status, 0, r.stderr))
  test('★ 不误报需要改动', () => {
    assert.ok(!r.stdout.includes('指向他处'), `不该报"指向他处"：\n${r.stdout}`)
    assert.ok(r.stdout.includes('已是目标状态'), r.stdout)
  })
  test('链接未被改写（仍是相对的）', () => assert.equal(readlinkSync(link), literal))

  rmSync(sandbox, { recursive: true, force: true })
}

console.log('\n[4] 卸载：两条通道都清')
{
  const sandbox = makeSandbox()
  runInstaller(sandbox)
  const r = runInstaller(sandbox, ['--remove'])

  test('退出码 0', () => assert.equal(r.status, 0, r.stderr))
  const manifest = readManifest(sandbox)
  test('dependencies 条目已移除', () => assert.equal(manifest.dependencies[NAME], undefined))
  test('bundles 条目已移除', () => {
    assert.equal(manifest.dsh.profile.bundles.includes(NAME), false)
  })
  test('符号链接已删除', () => {
    assert.equal(existsSync(join(sandbox, 'node_modules', NAME)), false)
  })
  test('其它 bundle 未受影响', () => {
    assert.ok(manifest.dsh.profile.bundles.includes('@deepseek-ai/dsh-base'))
  })
  rmSync(sandbox, { recursive: true, force: true })
}

console.log('\n[5] ★ 不变量拦截：patch 层若禁用原生行，安装必须被拒绝')
{
  const sandbox = makeSandbox({ patchBody: '- id: workspace\n  disabled: true\n' })
  const before = readFileSync(join(sandbox, 'package.json'), 'utf8')
  const r = runInstaller(sandbox)

  test('退出码非 0', () => assert.equal(r.status, 1, '必须拒绝写入'))
  test('报错说明了违反的不变量', () => {
    assert.ok(r.stderr.includes('检测到对原生核心行的禁用'), r.stderr)
    assert.ok(r.stderr.includes('workspace'))
  })
  test('★ manifest 未被改写（拒绝时不半写）', () => {
    assert.equal(readFileSync(join(sandbox, 'package.json'), 'utf8'), before)
  })
  test('未建立符号链接', () => {
    assert.equal(existsSync(join(sandbox, 'node_modules', NAME)), false)
  })
  rmSync(sandbox, { recursive: true, force: true })
}

console.log('\n[6] 三种原生行逐一拦截')
{
  for (const row of ['workspace', 'session-projection-cache', 'ui-workspace']) {
    const sandbox = makeSandbox({ patchBody: `- id: ${row}\n  disabled: true\n` })
    const r = runInstaller(sandbox)
    test(`禁用 ${row} → 被拒绝`, () => {
      assert.equal(r.status, 1, `应拒绝 ${row}`)
      assert.ok(r.stderr.includes(row))
    })
    rmSync(sandbox, { recursive: true, force: true })
  }
}

console.log('\n[7] 手动通道：写入手动段并摘除 bundle 条目')
{
  const sandbox = makeSandbox({ patchBody: '# profile patch\n- id: hmr\n  disabled: false\n' })
  const r = runInstaller(sandbox, ['--manual'])

  test('退出码 0', () => assert.equal(r.status, 0, r.stderr))
  const patch = readFileSync(join(sandbox, 'cordis.patch.yml'), 'utf8')
  test('patch 里出现本插件的手动段标记', () => {
    assert.ok(patch.includes(`${NAME}:begin`))
    assert.ok(patch.includes(`${NAME}:end`))
  })
  test('手动段引用 host 绝对路径', () => {
    assert.ok(patch.includes(join(PKG_DIR, 'lib', 'index.js')))
  })
  test('bundles 里**没有**本包（避免双挂）', () => {
    assert.equal(readManifest(sandbox).dsh.profile.bundles.includes(NAME), false)
  })
  test('原有 patch 内容未被破坏', () => {
    assert.ok(patch.includes('# profile patch'))
    assert.ok(patch.includes('- id: hmr'))
  })

  // 再切回正规通道：手动段应被摘除
  const r2 = runInstaller(sandbox)
  const patch2 = readFileSync(join(sandbox, 'cordis.patch.yml'), 'utf8')
  test('切回正规通道后手动段被摘除', () => {
    assert.equal(r2.status, 0, r2.stderr)
    assert.equal(patch2.includes(`${NAME}:begin`), false)
  })
  test('切回后 bundles 里有本包', () => {
    assert.ok(readManifest(sandbox).dsh.profile.bundles.includes(NAME))
  })
  rmSync(sandbox, { recursive: true, force: true })
}

console.log('\n[8] 边界：manifest 缺失 / 非法 JSON')
{
  const empty = mkdtempSync(join(tmpdir(), 'sa-install-'))
  const r = runInstaller(empty)
  test('缺 manifest → 明确报错并退出 1', () => {
    assert.equal(r.status, 1)
    assert.ok(r.stderr.includes('找不到 profile manifest'))
  })
  rmSync(empty, { recursive: true, force: true })

  const bad = mkdtempSync(join(tmpdir(), 'sa-install-'))
  writeFileSync(join(bad, 'package.json'), '{not json', 'utf8')
  const r2 = runInstaller(bad)
  test('非法 JSON → 明确报错并退出 1', () => {
    assert.equal(r2.status, 1)
    assert.ok(r2.stderr.includes('不是合法 JSON'))
  })
  rmSync(bad, { recursive: true, force: true })
}

console.log(`\n${failed === 0 ? '全部通过' : '有失败'}: ${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
