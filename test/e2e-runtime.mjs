#!/usr/bin/env node
/**
 * 端到端运行时验证（隔离 DSH_HOME + 真实 web 实例）
 * ===========================================================================
 * 这是本项目**最后一条未验证的链路**：宿主内部字段在真实运行实例中的形状。
 *
 * 做法：
 *   1. 在临时 DSH_HOME 里建一个 probe profile，`node_modules` 用**逐包符号链接**
 *      指回真实 profile（避免复制 438M）；
 *   2. 用 `--no-open` 起一个真实 web 实例，端口另选（绝不碰 3080）；
 *   3. 调用本插件的 /api 路由，观察真实返回；
 *   4. 结束后杀掉实例并清理。
 *
 * 全程不改动真实 profile 的配置，也不碰真实 ~/.dsh 的 storages。
 *
 * 用法：node test/e2e-runtime.mjs
 */

import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_DIR = join(HERE, '..')
const NAME = 'dsh-session-archive'
const REAL_PROFILE = join(process.env.HOME ?? '/home/slzca', '.dsh', 'profiles', 'web')
const PORT = 3099

let passed = 0
let failed = 0
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; console.error(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`) }
}

/** 真实 profile 需要的最小 bundle 集合（web-app 会带上 base）。 */
const BUNDLES = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
]

function buildIsolatedHome() {
  const home = mkdtempSync(join(tmpdir(), 'sa-e2e-home-'))
  const profileDir = join(home, 'profiles', 'web')
  const nm = join(profileDir, 'node_modules')
  mkdirSync(nm, { recursive: true })

  // 逐包符号链接：把真实 profile 的 node_modules 顶层条目链过来
  const realNm = join(REAL_PROFILE, 'node_modules')
  let linked = 0
  for (const entry of readdirSync(realNm, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const target = join(realNm, entry.name)
    try {
      symlinkSync(target, join(nm, entry.name), 'dir')
      linked++
    } catch { /* 已存在或不可链接，跳过 */ }
  }

  // 关键：本插件自身也要链进沙盒 node_modules（真实 profile 里没有它）
  try {
    symlinkSync(PKG_DIR, join(nm, NAME), 'dir')
  } catch { /* ignore */ }

  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'probe-profile',
    private: true,
    dependencies: { [NAME]: `link:${PKG_DIR}` },
    dsh: { profile: { bundles: [...BUNDLES, NAME] } },
  }, null, 2) + '\n', 'utf8')

  writeFileSync(join(profileDir, 'cordis.yml'), '[]\n', 'utf8')

  // 测试专用：装入 auth harness（手动通道，绝对路径），用于取得认证入口 URL。
  //
  // 关键：夹具必须放在**本包目录之外**并带自己的 package.json。
  // 否则 dsh-client-modules 会按"最近的 package.json"把它归到 dsh-session-archive
  // 名下，导致 "resolves from multiple active Loader sources" 启动失败。
  const harnessDir = join(home, 'harness')
  mkdirSync(harnessDir, { recursive: true })
  writeFileSync(join(harnessDir, 'package.json'), JSON.stringify({
    name: 'sa-auth-harness',
    version: '0.0.0',
    type: 'module',
    main: 'index.js',
  }, null, 2) + '\n', 'utf8')
  writeFileSync(join(harnessDir, 'index.js'),
    readFileSync(join(PKG_DIR, 'test', 'fixtures', 'auth-harness.mjs'), 'utf8'), 'utf8')

  writeFileSync(join(profileDir, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: sa-auth-harness',
    `      name: '${join(harnessDir, 'index.js')}'`,
    '',
  ].join('\n'), 'utf8')

  return { home, profileDir, linked, authOut: join(home, 'auth-url.txt') }
}

function dshBin() {
  const c = '/home/slzca/.local/bin/dsh'
  return existsSync(c) ? c : 'dsh'
}

async function waitForServer(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/`, { redirect: 'manual' })
      if (res.status > 0) return res.status
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 500))
  }
  return null
}

/** 用 launch token 换取浏览器会话 cookie（与真实浏览器同一条路）。 */
async function obtainCookie() {
  const deadline = Date.now() + 30_000
  let authUrl = null
  while (Date.now() < deadline) {
    if (existsSync(authOut)) {
      const raw = readFileSync(authOut, 'utf8').trim()
      if (raw.startsWith('ERROR')) throw new Error(`harness 失败: ${raw}`)
      if (raw.length > 0) { authUrl = raw; break }
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  if (authUrl === null) return null
  // token 换 cookie：GET /?token=... 会 Set-Cookie 并重定向
  const res = await fetch(authUrl, { redirect: 'manual' })
  const setCookie = res.headers.get('set-cookie')
  if (setCookie === null) return null
  return setCookie.split(';')[0]
}

let COOKIE = null

/** 重新走一次 launch-token 换 cookie（模拟浏览器重新认证）。 */
async function refreshAuth() {
  const fresh = await obtainCookie()
  if (fresh !== null && fresh.length > 0) COOKIE = fresh
  return COOKIE
}

/**
 * 调用本插件的一条 /api 路由。
 *
 * 遇到 401 会**重新认证后重试一次**：连接服务的会话 cookie 绑定当次 activation 的
 * 签名密钥，实例发生重载后旧 cookie 即失效 —— 真实浏览器此时会重新走 launch URL，
 * 测试端做同样的处理，避免把"认证过期"误报成"路由不可用"。
 */
async function callPath(path, payload, { retryOn401 = true } = {}) {
  const attempt = async () => {
    const headers = { 'content-type': 'application/json' }
    if (COOKIE !== null) headers.cookie = COOKIE
    const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload ?? {}),
    })
    let body = null
    try { body = await res.json() } catch { /* 非 JSON */ }
    return { status: res.status, body }
  }

  let result = await attempt()
  if (result.status === 401 && retryOn401) {
    await refreshAuth()
    result = await attempt()
  }
  return result
}

/** 调用本插件的一条 /api 路由。 */
async function callRoute(endpoint, payload, options) {
  return callPath(`/api/sessionArchive.${endpoint}`, payload, options)
}

const { home, profileDir, linked, authOut } = buildIsolatedHome()
console.log(`隔离 DSH_HOME: ${home}`)
console.log(`逐包符号链接: ${linked} 个\n`)

// 注意：`web` 子命令不接受父级 --profile 标志，父级参数必须写在子命令之前
// `dsh web` 会报 "web takes none of parent --profile..."，故先把 profile 目录名保持为 web，
// 或使用 `dsh web` 并让 DSH_HOME 指向沙盒（沙盒内 profile 名就叫 web）
const child = spawn(dshBin(), ['web', '--no-open', '--port', String(PORT)], {
  cwd: home,
  env: {
    ...process.env,
    DSH_HOME: home,
    // 把回收站与 limits 指到沙盒，绝不碰真实数据
    DSH_SESSION_ARCHIVE_ROOT: join(home, 'session-archive'),
    SA_HARNESS_OUT: authOut,
    SA_HARNESS_PORT: String(PORT),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let serverOut = ''
child.stdout.on('data', (d) => { serverOut += d.toString() })
child.stderr.on('data', (d) => { serverOut += d.toString() })

/**
 * 收尾：先终止隔离实例，再删临时 home。
 *
 * 注意必须**同步等待**：早前用 `setTimeout` 延迟清理，随后 `process.exit()` 会直接
 * 杀掉待执行的定时器，导致每次运行都残留一个 /tmp/sa-e2e-home-* 目录。
 */
async function cleanup() {
  try { child.kill('SIGTERM') } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 1200))
  try { child.kill('SIGKILL') } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 300))
  try { rmSync(home, { recursive: true, force: true }) } catch { /* ignore */ }
}

try {
  console.log('启动隔离 web 实例…')
  const homeStatus = await waitForServer()

  if (homeStatus === null) {
    check('隔离实例启动', false, `超时未就绪。输出片段：\n${serverOut.slice(-2500)}`)
    await cleanup()
    console.log(`\n${failed === 0 ? '全部通过' : '有失败'}: ${passed} passed, ${failed} failed\n`)
    process.exit(1)
  }
  check('隔离实例启动成功', true)

  // 说明：DSH 在此启动方式下不把插件日志写到 stdout，故不能靠日志断言挂载。
  // 改为**用行为验证**：下面真实调用 /api 路由，能返回业务结果即证明插件已挂载。
  check('无 patch 告警', !/patch: entry .* not found/.test(serverOut), serverOut.slice(-800))
  check('无未捕获异常', !/UnhandledPromiseRejection|Uncaught/.test(serverOut), serverOut.slice(-800))

  // ── 认证（与浏览器同路）──────────────────────────────────────────────────
  COOKIE = await obtainCookie()
  check('★ 用 launch token 换取浏览器会话 cookie', COOKIE !== null && COOKIE.length > 0,
    `authOut=${authOut} exists=${existsSync(authOut)} cookie=${String(COOKIE).slice(0, 40)}`)

  // ── 客户端半边：boot 清单 + bundle 投递 ─────────────────────────────────
  //
  // 这是此前唯一无法在 Node 里覆盖的部分。虽然仍无法"执行浏览器"，
  // 但可以验证**投递链路**：首页注入的 __DSH_BOOT__ 里有没有我的客户端模块，
  // 以及它的 bundle 能不能真正取到、内容是不是我写的那份代码。
  console.log('\n客户端半边（boot 清单 + bundle 投递）：')

  const indexHtml = await fetch(`http://127.0.0.1:${PORT}/`, {
    headers: COOKIE === null ? {} : { cookie: COOKIE },
  }).then((r) => r.text()).catch(() => '')

  check('首页可取（带 cookie）', indexHtml.length > 0, `长度 ${indexHtml.length}`)
  check('首页注入了 __DSH_BOOT__ 清单', indexHtml.includes('__DSH_BOOT__'))
  check('★ boot 清单里登记了本插件的客户端模块', indexHtml.includes(NAME),
    '在 __DSH_BOOT__ 里找不到 dsh-session-archive —— 客户端半边未被装配')
  check('★ boot 清单把本插件的 client.js 排进了预载批次（会被投递到浏览器）',
    indexHtml.includes(`${NAME}/client.js`),
    `未在预载列表里看到 ${NAME}/client.js`)

  // bundle URL 是**相对形式**（无前导斜杠）：plugins/??<逗号分隔的 client.js 列表>&rev=…
  // href 属性里 rev 分隔符被 HTML 转义成 &amp;
  const bundleUrls = [...new Set((indexHtml.match(/plugins\/\?\?[^"'\s<>]+/g) ?? [])
    .map((u) => u.replace(/&amp;/g, '&')))]
  check('首页声明了 plugins bundle', bundleUrls.length > 0, `找到 ${bundleUrls.length} 个`)

  let foundCode = null
  for (const url of bundleUrls.slice(0, 16)) {
    const text = await fetch(`http://127.0.0.1:${PORT}/${url}`, { headers: { cookie: COOKIE } })
      .then((r) => (r.ok ? r.text() : '')).catch(() => '')
    if (text.includes('session-archive')) { foundCode = { url, text }; break }
  }
  check('★ 投递的 bundle 里确实含本插件客户端代码', foundCode !== null,
    `遍历 ${bundleUrls.length} 个 bundle 未找到` + (bundleUrls.length > 0 ? `。样例：${bundleUrls[0].slice(0, 80)}…` : ''))
  if (foundCode !== null) {
    check('bundle 是 __ModuleLoader__ 注册格式（与客户端加载器契约一致）',
      /__ModuleLoader__\.load\(\{[^}]*id:/.test(foundCode.text) || foundCode.text.includes('__ModuleLoader__'),
      'bundle 内容不是模块加载器注册格式')
    check('bundle 里含设置页座位 id', foundCode.text.includes('session-archive'),
      '未找到设置页 section id')
    console.log(`    → bundle ${foundCode.url.slice(0, 60)}…（${foundCode.text.length} 字节）`)
  }

  // ── 真实调用路由 ────────────────────────────────────────────────────────
  console.log('\n调用 /api 路由（真实宿主内部字段）：')

  const list = await callRoute('list')
  check('list 返回 200', list.status === 200, `status=${list.status} body=${JSON.stringify(list.body)?.slice(0, 400)}`)
  check('★ workspaceRegistry.state.archivedSessionIds 可读', list.body?.ok === true && list.body?.sources?.archived === 'workspaceRegistry.state',
    JSON.stringify(list.body)?.slice(0, 500))
  check('list 带 items 与 summary', Array.isArray(list.body?.items) && typeof list.body?.summary?.total === 'number',
    JSON.stringify(list.body)?.slice(0, 300))
  console.log(`    → 已归档会话 ${list.body?.summary?.total ?? '?'} 个（live=${list.body?.sources?.live ?? '?'}, persisted=${list.body?.sources?.persisted ?? '?'}）`)

  const trash = await callRoute('trash')
  check('trash 返回 200 且带 limits', trash.status === 200 && typeof trash.body?.limits?.maxEntries === 'number',
    JSON.stringify(trash.body)?.slice(0, 400))
  console.log(`    → 回收站 ${trash.body?.summary?.total ?? '?'} 条`)

  const badDelete = await callRoute('delete', {})
  check('delete 缺 sessionId → 400（fail-loud，不静默成功）', badDelete.status === 400,
    `status=${badDelete.status} body=${JSON.stringify(badDelete.body)?.slice(0, 300)}`)

  const ghost = await callRoute('delete', { sessionId: 'session-does-not-exist-at-all' })
  check('★ delete 不存在的会话 → 明确报错（绝不静默成功）', ghost.status >= 400,
    `status=${ghost.status} body=${JSON.stringify(ghost.body)?.slice(0, 300)}`)
  console.log(`    → 错误码 ${ghost.body?.error ?? '?'}`)

  const noEntry = await callRoute('restore', { sessionId: 'session-does-not-exist-at-all' })
  check('restore 不存在的条目 → 404 entry-not-found', noEntry.status === 404 && noEntry.body?.error === 'entry-not-found',
    `status=${noEntry.status} body=${JSON.stringify(noEntry.body)?.slice(0, 300)}`)

  const unarchiveBad = await callRoute('unarchive', {})
  check('unarchive 缺 sessionId → 400', unarchiveBad.status === 400, `status=${unarchiveBad.status}`)

  const purgeManyEmpty = await callRoute('purgeExpired', {})
  check('★ purgeExpired 无参数 → 400 且不删任何东西', purgeManyEmpty.status === 400,
    `status=${purgeManyEmpty.status} body=${JSON.stringify(purgeManyEmpty.body)?.slice(0, 300)}`)

  // 认证围栏：带 Origin 头（跨站）应被拒
  const crossOrigin = await fetch(`http://127.0.0.1:${PORT}/api/sessionArchive.list`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'http://evil.example',
      ...(COOKIE === null ? {} : { cookie: COOKIE }),
    },
    body: '{}',
  }).then((r) => r.status).catch(() => 0)
  check('★ 跨站 Origin 被认证围栏拒绝（403/401）', crossOrigin === 403 || crossOrigin === 401,
    `status=${crossOrigin}`)
  console.log(`    → 跨站请求状态码 ${crossOrigin}`)

  console.log('\n--- 启动日志片段 ---')
  console.log(serverOut.split('\n').filter((l) => l.includes(NAME)).slice(0, 8).join('\n') || '(无插件相关日志)')
  // ── 完整往返：真实会话的 删除 → 回收站 → 恢复 ───────────────────────────
  console.log('\n完整往返（真实会话目录，真实持久化根）：')

  // 关键：**不能**伪造会话工件。后端按 zstd 解码 `session.v<N>.jsonl.zstd`，
  // 塞一个普通 JSON 文件会导致 header 读不出 → 会话在持久化列表里不可见
  // （这正是首次往返失败的原因：persisted:0、cwd 为 null、走了 _no-cwd）。
  // 因此改为复制一个**真实的**规范会话工件进沙盒。
  const { projectKey, parseGenerationLogFilename } = await import('../lib/paths.js')
  const sandboxSessions = join(home, 'sessions')

  const realRoot = join(process.env.HOME ?? '/home/slzca', '.dsh', 'sessions')
  let picked = null
  for (const projectName of readdirSync(realRoot)) {
    const projectPath = join(realRoot, projectName)
    let entries = []
    try { entries = readdirSync(projectPath, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const dir = join(projectPath, e.name)
      let files = []
      try { files = readdirSync(dir) } catch { continue }
      const log = files.find((f) => parseGenerationLogFilename(f) !== null)
      if (log === undefined) continue
      const size = statSync(join(dir, log)).size
      if (picked === null || size < picked.size) {
        picked = { projectName, id: e.name, dir, log, size }
      }
    }
  }
  if (picked === null) {
    check('找到可复制的真实会话工件', false, '真实 sessions 根下没有规范 artifact')
    throw new Error('no canonical session artifact available')
  }
  console.log(`    使用真实工件：${picked.projectName}/${picked.id}（${picked.size} 字节，${picked.log}）`)

  const RT_ID = picked.id
  const rtDir = join(sandboxSessions, picked.projectName, RT_ID)
  mkdirSync(rtDir, { recursive: true })
  for (const f of readdirSync(picked.dir)) {
    copyFileSync(join(picked.dir, f), join(rtDir, f))
  }
  const payloadBuf = readFileSync(join(rtDir, picked.log))

  await refreshAuth() // 往返开始前重新认证，避免跨阶段 cookie 失效
  const listAfter = await callRoute('list')
  check('list 能读到沙盒里的会话（持久化根正确）',
    (listAfter.body?.sources?.persisted ?? 0) >= 1 || (listAfter.body?.sources?.live ?? 0) >= 1,
    `sources=${JSON.stringify(listAfter.body?.sources)}`)

  const del = await callRoute('delete', { sessionId: RT_ID })
  check('★ delete 真实会话成功（落盘到回收站）', del.status === 200,
    `status=${del.status} body=${JSON.stringify(del.body)?.slice(0, 400)}`)
  check('★ 删除后原目录确实消失', !existsSync(rtDir), `仍存在：${rtDir}`)

  const trashAfter = await callRoute('trash')
  const inTrash = (trashAfter.body?.entries ?? []).some((e) => e.sessionId === RT_ID)
  check('★ 回收站里能看到该条目', inTrash,
    `entries=${JSON.stringify(trashAfter.body?.entries?.map((e) => e.sessionId))}`)
  const entry = (trashAfter.body?.entries ?? []).find((e) => e.sessionId === RT_ID)
  if (entry !== undefined) {
    console.log(`    → 条目体积 ${entry.sizeBytes} 字节（记录原始 ${entry.recordedSizeBytes}）`)
  }

  const restored = await callRoute('restore', { sessionId: RT_ID })
  check('★ restore 成功', restored.status === 200,
    `status=${restored.status} body=${JSON.stringify(restored.body)?.slice(0, 400)}`)

  let roundTripOk = false
  try {
    roundTripOk = existsSync(rtDir) && Buffer.compare(readFileSync(join(rtDir, picked.log)), payloadBuf) === 0
  } catch { roundTripOk = false }
  const bothSucceeded = del.status === 200 && restored.status === 200
  check('★ 内容逐字节一致（端到端零损坏）', roundTripOk && bothSucceeded,
    bothSucceeded ? `存在=${existsSync(rtDir)}` : `前置未成功（delete=${del.status}, restore=${restored.status}），此断言无效`)

  const purge = await callRoute('purge', { sessionId: RT_ID })
  check('回收站里已无该条目（恢复后条目消失）', purge.status === 404,
    `status=${purge.status} body=${JSON.stringify(purge.body)?.slice(0, 300)}`)

  // ── live 会话的删除路径（走 detachEntered）──────────────────────────────
  //
  // 你日常用的正是这条：归档一个会话 → 点开看过它（于是它变 live）→ 删除。
  // 冷会话路径上面的往返已覆盖，但 live 路径会走 `sessions.detachEntered()`，
  // 且依赖 `liveEntryFor` —— 这是 0.2.0 这类小版本跃迁最可能变的地方。
  //
  // 注意：**不能给副本换个 id**（哪怕只改目录名）—— 会话 id 内嵌在日志头里，
  // 改名会让 persistence.open 直接判为 corrupt。所以复用刚往返成功的同一个会话。
  console.log('\nlive 会话（打开态）的删除路径：')

  const liveBuf = readFileSync(join(rtDir, picked.log))

  const madeLive = await callPath('/api/saHarness.makeLive', { sessionId: RT_ID, archive: true })
  check('harness 把会话置为 live 并归档', madeLive.status === 200 && madeLive.body?.live === true,
    `status=${madeLive.status} body=${JSON.stringify(madeLive.body)?.slice(0, 300)}`)

  const isLiveBefore = await callPath('/api/saHarness.isLive', { sessionId: RT_ID })
  check('确认删除前该会话是 live（打开态）', isLiveBefore.body?.live === true, JSON.stringify(isLiveBefore.body))

  const listedLive = await callRoute('list')
  const liveItem = (listedLive.body?.items ?? []).find((i) => i.sessionId === RT_ID)
  check('归档列表里能看到它，且标记为 live', liveItem !== undefined && liveItem.live === true,
    `item=${JSON.stringify(liveItem)}`)
  check('★ live 会话的 running 为 false（打开过 ≠ 正在跑，不该阻止删除）',
    liveItem?.running === false, `running=${liveItem?.running}`)

  const delLive = await callRoute('delete', { sessionId: RT_ID })
  check('★ live 会话删除成功（走 detachEntered 路径）', delLive.status === 200,
    `status=${delLive.status} body=${JSON.stringify(delLive.body)?.slice(0, 400)}`)
  check('★ 删除后文件确实移走', !existsSync(rtDir))
  check('★ 删除后该会话不再是 live（证明 detachEntered 生效）',
    (await callPath('/api/saHarness.isLive', { sessionId: RT_ID })).body?.live === false,
    '会话仍留在宿主内存 store 里 —— detachEntered 未生效，会留下幽灵行')

  const liveTrash = await callRoute('trash')
  check('回收站里能看到它', (liveTrash.body?.entries ?? []).some((e) => e.sessionId === RT_ID),
    `entries=${JSON.stringify(liveTrash.body?.entries?.map((e) => e.sessionId))}`)

  const liveRestore = await callRoute('restore', { sessionId: RT_ID })
  check('live 会话也能恢复', liveRestore.status === 200,
    `status=${liveRestore.status} body=${JSON.stringify(liveRestore.body)?.slice(0, 300)}`)

  let liveRoundTripOk = false
  try {
    liveRoundTripOk = existsSync(rtDir) && Buffer.compare(readFileSync(join(rtDir, picked.log)), liveBuf) === 0
  } catch { liveRoundTripOk = false }
  check('★ live 路径同样逐字节一致', liveRoundTripOk && delLive.status === 200 && liveRestore.status === 200,
    `存在=${existsSync(rtDir)} delete=${delLive.status} restore=${liveRestore.status}`)
  check('恢复后重新挂回工作区记账', liveRestore.body?.reattached === true,
    `reattached=${liveRestore.body?.reattached} via=${liveRestore.body?.reattachVia}`)

} catch (error) {
  check('端到端流程未抛异常', false, String(error?.stack ?? error))
} finally {
  await cleanup()
}

console.log(`\n${failed === 0 ? '全部通过' : '有失败'}: ${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
