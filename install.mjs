#!/usr/bin/env node
/**
 * dsh-session-archive —— profile 安装 / 卸载脚本（幂等）
 *
 * 两条挂载通道。本脚本每次都把「另一种通道」清干净：同一个包若从两个 Loader
 * 源出现，dsh-client-modules 会直接抛错（"resolves from multiple active
 * Loader sources"），甚至让 boot 失败。
 *
 *  A. 正规 bundle 通道（默认）
 *     · <profile>/package.json
 *         dependencies["dsh-session-archive"] = "link:<本包绝对路径>"
 *         dsh.profile.bundles 追加 "dsh-session-archive"
 *     · <profile>/node_modules/dsh-session-archive → 本包目录（符号链接）
 *     · 清掉 <profile>/cordis.patch.yml 里的手动 insert 段
 *     装配来源：本包内的 cordis.patch.yml（package.json 的 dsh.bundle.patch）。
 *
 *  B. 手动通道（--manual）
 *     只在 <profile>/cordis.patch.yml 里写一段带标记的绝对路径 insert 行；
 *     保留依赖声明（市场可见性），但把包从 dsh.profile.bundles 摘除。
 *
 * 用法：
 *   node install.mjs --dry-run          # 只打印将要做的改动，不落盘
 *   node install.mjs                    # 走正规 bundle 通道（自动备份）
 *   node install.mjs --manual           # 走手动通道
 *   node install.mjs --remove           # 卸载：两条通道都清
 *   node install.mjs --profile <目录>    # 默认 ~/.dsh/profiles/web
 *
 * 本插件的额外不变量（每次运行都校验，违反则拒绝写入）：
 *   任何 patch 层都**不得** disabled 原生行 workspace / session-projection-cache /
 *   ui-workspace。本项目的第一条设计约束就是"只消费、不替换原生服务"，
 *   一旦有人（包括未来的我）往任何 patch 层塞了这类 disable，脚本直接报错退出。
 *
 * 时序提醒：bundles / profile 装配都在启动时读取 ⇒ 需要重启 DSH；
 * 而摘除手动段会被 profile patch 层的 live watcher 立即应用（插件当场卸载），
 * 所以「手动 → 正规」切换后请尽快重启。
 */

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const NAME = 'dsh-session-archive'
const ROW_ID = 'session-archive'
const PKG_DIR = dirname(fileURLToPath(import.meta.url))
const BUNDLE_PATCH = join(PKG_DIR, 'cordis.patch.yml')
const HOST_HALF = join(PKG_DIR, 'lib', 'index.js')
const CLIENT_HALF = join(PKG_DIR, 'lib', 'client.js')
const BEGIN = `# ── ${NAME}:begin（本段由 install.mjs 生成/维护）`
const END = `# ── ${NAME}:end`
const SPEC = `link:${PKG_DIR}`

/** 绝不允许被任何 patch 层禁用的原生行。 */
const PROTECTED_NATIVE_ROWS = ['workspace', 'session-projection-cache', 'ui-workspace']

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run') || argv.includes('-n')
const remove = argv.includes('--remove')
const manual = argv.includes('--manual')
const profileFlag = argv.indexOf('--profile')
const PROFILE = resolve(
  profileFlag >= 0 && argv[profileFlag + 1] !== undefined
    ? argv[profileFlag + 1]
    : join(process.env.HOME ?? '/home/slzca', '.dsh', 'profiles', 'web'),
)
const MANIFEST = join(PROFILE, 'package.json')
const PATCH = join(PROFILE, 'cordis.patch.yml')
const LINK = join(PROFILE, 'node_modules', NAME)

const plan = []
const note = (line) => plan.push(line)
function fail(message) {
  console.error(`[${NAME}] ${message}`)
  process.exit(1)
}

if (!existsSync(MANIFEST)) fail(`找不到 profile manifest：${MANIFEST}（用 --profile 指定 profile 目录）`)
if (!remove) {
  if (!existsSync(BUNDLE_PATCH)) fail(`缺少 bundle 层 patch：${BUNDLE_PATCH}`)
  if (!existsSync(HOST_HALF)) fail(`缺少 host 半边：${HOST_HALF}`)
  if (!existsSync(CLIENT_HALF)) fail(`缺少 client 半边：${CLIENT_HALF}`)
}

// ── 读 manifest ─────────────────────────────────────────────────────────────
const manifestRaw = readFileSync(MANIFEST, 'utf8')
let manifest
try {
  manifest = JSON.parse(manifestRaw)
} catch (error) {
  fail(`profile manifest 不是合法 JSON：${String(error.message ?? error)}`)
}
if (manifest.dsh === undefined || manifest.dsh === null || typeof manifest.dsh !== 'object') manifest.dsh = {}
if (manifest.dsh.profile === undefined || manifest.dsh.profile === null || typeof manifest.dsh.profile !== 'object') {
  manifest.dsh.profile = {}
}
const deps = manifest.dependencies !== undefined && manifest.dependencies !== null && typeof manifest.dependencies === 'object'
  ? manifest.dependencies
  : (manifest.dependencies = {})
const bundles = Array.isArray(manifest.dsh.profile.bundles)
  ? manifest.dsh.profile.bundles
  : (manifest.dsh.profile.bundles = [])

// ── patch 文件（手动段）处理 ─────────────────────────────────────────────────
const patchRaw = existsSync(PATCH) ? readFileSync(PATCH, 'utf8') : ''
const crlf = (patchRaw.match(/\r\n/g) ?? []).length > (patchRaw.match(/(?<!\r)\n/g) ?? []).length
const patchText = crlf ? patchRaw.replace(/\r\n/g, '\n') : patchRaw
const hadBlock = patchText.includes(BEGIN)

const manualBlock = [
  BEGIN,
  '# 手动通道：把插件行写进 profile 自己的 patch 层（绝对路径）。',
  '# 走正规 bundle 通道时本段应当不存在 —— 两段同时生效会双挂。',
  '- insert:',
  `    - id: ${ROW_ID}`,
  `      name: '${HOST_HALF}'`,
  END,
].join('\n')

function stripBlock(text) {
  const beginAt = text.indexOf(BEGIN)
  if (beginAt < 0) return text
  const endAt = text.indexOf(END, beginAt)
  if (endAt < 0) return text
  let tail = endAt + END.length
  if (text[tail] === '\n') tail += 1
  const body = (text.slice(0, beginAt) + text.slice(tail)).replace(/\n+$/, '')
  return body === '' ? '' : `${body}\n`
}

// ── 不变量校验：任何 patch 层都不得禁用原生核心行 ───────────────────────────
{
  const layers = []
  if (existsSync(PATCH)) layers.push({ label: 'profile cordis.patch.yml', text: patchText })
  if (existsSync(BUNDLE_PATCH)) layers.push({ label: '本包 bundle patch', text: readFileSync(BUNDLE_PATCH, 'utf8') })
  const violations = []
  for (const layer of layers) {
    for (const rowId of PROTECTED_NATIVE_ROWS) {
      // 匹配「- id: <rowId>」之后紧跟「disabled: true」的行对
      const re = new RegExp(`-\\s*id:\\s*${rowId}\\s*\\n\\s*disabled:\\s*true`)
      if (re.test(layer.text)) violations.push(`${layer.label}: ${rowId}`)
    }
  }
  if (violations.length > 0) {
    fail(
      '检测到对原生核心行的禁用，违反本插件的不变量（只消费、不替换原生服务）：\n' +
      violations.map((v) => `    · ${v}`).join('\n') +
      '\n  请先移除这些 disable 再重试。',
    )
  }
}

// ── 目标状态 ────────────────────────────────────────────────────────────────
const wantBundle = !remove && !manual
const wantManual = !remove && manual
const wantDep = !remove
const wantLink = !remove

if (wantDep && deps[NAME] !== SPEC) note(`manifest dependencies["${NAME}"]: ${deps[NAME] ?? '(无)'} → ${SPEC}`)
if (!wantDep && deps[NAME] !== undefined) note(`manifest 删除 dependencies["${NAME}"]`)
if (wantDep) deps[NAME] = SPEC
else delete deps[NAME]

const inBundles = bundles.includes(NAME)
if (wantBundle && !inBundles) note(`dsh.profile.bundles 追加 "${NAME}"（置于末位）`)
if (!wantBundle && inBundles) note(`dsh.profile.bundles 移除 "${NAME}"`)
if (wantBundle && !inBundles) bundles.push(NAME)
if (!wantBundle) {
  const kept = bundles.filter((entry) => entry !== NAME)
  bundles.length = 0
  bundles.push(...kept)
}

if (wantManual && !hadBlock) note(`cordis.patch.yml 写入手动 insert 段（绝对路径）`)
if (!wantManual && hadBlock) note(`cordis.patch.yml 摘除手动 insert 段`)
if (wantManual && hadBlock) note(`cordis.patch.yml 原地替换手动 insert 段`)

/** 解析为真实路径；解析失败则返回原字面量（尽力而为，避免因缺失而误判）。 */
function tryRealpath(target) {
  try {
    return realpathSync(target)
  } catch {
    return target
  }
}

let linkState = 'absent'
try {
  const stat = lstatSync(LINK)
  // 比较**解析后的真实路径**，而不是链接字面量：
  // pnpm 会把 link: 依赖规范成相对链接 —— 字面量不同但解析结果相同，
  // 按字面量比较会误报"指向他处"，进而去改写一个本来完全正确的链接。
  if (!stat.isSymbolicLink()) {
    linkState = 'not-a-link'
  } else {
    const target = tryRealpath(LINK)
    linkState = target === tryRealpath(PKG_DIR) ? 'ok' : 'other'
  }
} catch {
  linkState = 'absent'
}
if (wantLink && linkState === 'absent') note(`建立符号链接 ${LINK} → ${PKG_DIR}`)
if (wantLink && linkState === 'other') note(`修正符号链接 ${LINK} → ${PKG_DIR}（原指向他处）`)
if (wantLink && linkState === 'not-a-link') fail(`已存在同名实体目录（非链接）：${LINK}，请先人工确认`)
if (!wantLink && linkState !== 'absent') note(`删除符号链接 ${LINK}`)

// ── 结果文本与校验 ──────────────────────────────────────────────────────────
const nextManifest = `${JSON.stringify(manifest, null, 2)}\n`
const patchBody = stripBlock(patchText)
const nextPatch = wantManual
  ? `${patchBody === '' ? '' : `${patchBody}\n`}${manualBlock}\n`
  : patchBody

/** 若 profile 里能解析到 yaml，就校验 patch 结果仍是合法数组。 */
function validatePatch(text) {
  let YAML
  try {
    YAML = createRequire(join(PROFILE, 'package.json'))('yaml')
  } catch {
    return { checked: false, reason: 'profile 内无 yaml 解析器，跳过校验' }
  }
  try {
    const parsed = YAML.parse(text)
    if (!Array.isArray(parsed)) return { checked: true, ok: false, reason: '顶层不是数组' }
    const manualRows = parsed.filter((entry) => entry !== null && typeof entry === 'object'
      && Array.isArray(entry.insert)
      && entry.insert.some((row) => row !== null && typeof row === 'object' && row.id === ROW_ID)).length
    const forbidden = []
    for (const entry of parsed) {
      if (entry === null || typeof entry !== 'object') continue
      if (PROTECTED_NATIVE_ROWS.includes(entry.id) && entry.disabled === true) forbidden.push(entry.id)
    }
    if (forbidden.length > 0) return { checked: true, ok: false, reason: `写入后含对原生行的禁用：${forbidden.join(', ')}` }
    return { checked: true, ok: true, entries: parsed.length, manualRows }
  } catch (error) {
    return { checked: true, ok: false, reason: String(error.message ?? error) }
  }
}
const verdict = validatePatch(nextPatch)
if (verdict.checked && verdict.ok === false) {
  fail(`写入后 patch 文件校验失败，已中止（未写入内容）：${verdict.reason}`)
}

console.log(`[${NAME}] profile : ${PROFILE}`)
console.log(`[${NAME}] 通道    : ${remove ? '卸载（两条通道都清）' : wantManual ? '手动（cordis.patch.yml insert 段）' : '正规 bundle 通道'}`)
console.log(`[${NAME}] 不变量  : 未禁用任何原生核心行（${PROTECTED_NATIVE_ROWS.join(' / ')}）✓`)
console.log(`[${NAME}] 计划改动:`)
if (plan.length === 0) console.log('  （已是目标状态，无需改动）')
for (const line of plan) console.log(`  · ${line}`)
console.log(`[${NAME}] patch 校验: ${verdict.checked ? `合法数组，共 ${verdict.entries} 条，手动段 ${verdict.manualRows} 处` : verdict.reason}`)

if (dryRun) {
  console.log('\n----- 将要写入的 <profile>/package.json -----\n')
  console.log(nextManifest)
  if (plan.length !== 0 || hadBlock) {
    console.log('----- 将要写入的 <profile>/cordis.patch.yml -----\n')
    console.log(nextPatch)
  }
  console.log('----- 结束（--dry-run 未落盘）-----')
  process.exit(0)
}

if (plan.length === 0) {
  console.log(`[${NAME}] 已是目标状态，未写入。`)
  process.exit(0)
}

// ── 备份 + 落盘 ─────────────────────────────────────────────────────────────
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const manifestBackup = `${MANIFEST}.bak-${NAME}-${stamp}`
copyFileSync(MANIFEST, manifestBackup)
console.log(`[${NAME}] 已备份 manifest → ${manifestBackup}`)
writeFileSync(MANIFEST, nextManifest, 'utf8')

if (existsSync(PATCH) || wantManual) {
  if (existsSync(PATCH)) {
    const patchBackup = `${PATCH}.bak-${NAME}-${stamp}`
    copyFileSync(PATCH, patchBackup)
    console.log(`[${NAME}] 已备份 patch → ${patchBackup}`)
  }
  writeFileSync(PATCH, crlf ? nextPatch.replace(/\n/g, '\r\n') : nextPatch, 'utf8')
}

if (wantLink) {
  if (linkState === 'absent') mkdirSync(dirname(LINK), { recursive: true })
  if (linkState === 'other') rmSync(LINK, { force: true })
  if (linkState !== 'ok') symlinkSync(PKG_DIR, LINK)
} else if (linkState === 'ok' || linkState === 'other') {
  rmSync(LINK, { force: true })
}

console.log(`[${NAME}] 已写入 ✓`)
console.log('')
if (wantManual) {
  console.log('当前为手动通道。想换成正规 bundle 通道：node install.mjs（然后重启 DSH）。')
} else {
  console.log('当前为正规 bundle 通道：由 dsh.profile.bundles 在启动时装配本包内的 cordis.patch.yml。')
  console.log('需要重启 DSH 才会生效。')
}
console.log('建议随后在 profile 目录跑一次 `pnpm install --lockfile-only`，让锁文件记录这条 link 依赖。')
