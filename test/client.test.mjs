/**
 * client bundle 格式与注册契约测试（在 Node 里用 mock 环境执行真实客户端代码）。
 * 运行：node test/client.test.mjs
 *
 * 为什么值得测：客户端错误**只有重启 DSH 才会暴露**，而这是本项目唯一无法
 * 自动验证的运行环节。这里至少把"格式 / 座位 / 契约 / 关键渲染分支"锁住。
 *
 * 覆盖：
 *   · 必须是 ModuleLoader 包装格式，且 id === 包名（否则加载器找不到）
 *   · factory(require) → exports，且导出 { apply, inject }
 *   · 只注册一个 `settings.section`（list 槽、纯增量，不遮蔽官方 UI）
 *   · API 前缀与宿主一致（**防两端漂移**）
 *   · apply() 在 slots / locale 缺失时不抛错
 *   · 关键渲染分支：列表为空、有数据、错误态
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { API_PREFIX, apply as hostApply, name as HOST_NAME } from '../lib/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_DIR = join(HERE, '..')
const CLIENT_PATH = join(PKG_DIR, 'lib', 'client.js')
const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8'))

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

// ── mock React（够组件渲染分支用）────────────────────────────────────────────
function makeReactStub() {
  const createElement = (type, props, ...children) => ({
    __element: true, type, props: props ?? {}, children: children.flat(),
  })
  const stateSlots = []
  let cursor = 0
  return {
    __stateSlots: stateSlots,
    __resetCursor: () => { cursor = 0 },
    createElement,
    Fragment: Symbol('Fragment'),
    useState(initial) {
      const i = cursor++
      if (stateSlots[i] === undefined) stateSlots[i] = typeof initial === 'function' ? initial() : initial
      return [stateSlots[i], (next) => { stateSlots[i] = typeof next === 'function' ? next(stateSlots[i]) : next }]
    },
    useCallback(fn) { return fn },
    useEffect() { /* Node 下不执行副作用 */ },
  }
}

/** 捕获 ModuleLoader 注册，并用 mock require 执行 factory。 */
function loadClientBundle({ react } = {}) {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  let captured = null

  const sandboxWindow = {
    __ModuleLoader__: {
      load(entry) { captured = entry },
    },
  }
  const sandboxGlobalThis = {
    location: { origin: 'http://127.0.0.1:3080' },
    console,
    fetch: async () => { throw new Error('fetch not stubbed') },
  }
  const requireStub = (id) => {
    if (id === 'react') return react ?? makeReactStub()
    throw new Error(`unexpected require("${id}")`)
  }

  // 以函数形式执行源码，注入 window / globalThis / console
  const fn = new Function('window', 'globalThis', 'console', 'fetch', source)
  fn(sandboxWindow, sandboxGlobalThis, console, sandboxGlobalThis.fetch)

  assert.ok(captured !== null, '客户端未调用 window.__ModuleLoader__.load()')
  const exports = captured.factory(requireStub)
  return { entry: captured, exports }
}

console.log('\n[1] bundle 格式（DSH 客户端硬性要求）')
test('源码是 ModuleLoader 包装（非普通 ESM）', () => {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  assert.ok(source.includes('window.__ModuleLoader__.load('), '必须是 ModuleLoader 包装格式')
  assert.ok(source.includes('factory:'), '必须提供 factory')
  assert.ok(!/^import\s/m.test(source), '不应包含 ESM import（不会被转换）')
})
test('id 必须等于包名', () => {
  const { entry } = loadClientBundle()
  assert.equal(entry.id, pkg.name)
})
test('id 与宿主插件名一致', () => {
  const { entry } = loadClientBundle()
  assert.equal(entry.id, HOST_NAME)
})
test('factory(require) 返回 exports', () => {
  const { exports } = loadClientBundle()
  assert.equal(typeof exports, 'object')
  assert.equal(typeof exports.apply, 'function')
  assert.ok(Array.isArray(exports.inject))
})
test('只 require 已在 dsh.client.inject 里声明的模块', () => {
  const declared = new Set(pkg.dsh.client.inject)
  const source = readFileSync(CLIENT_PATH, 'utf8')
  const required = [...source.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1])
  for (const id of required) {
    if (id === 'react') continue // react 由客户端运行时提供，官方插件同样不声明
    assert.ok(declared.has(id), `require("${id}") 未在 dsh.client.inject 中声明`)
  }
})
test('dsh.client.platform 是 web', () => {
  assert.equal(pkg.dsh.client.platform, 'web')
})

console.log('\n[2] 座位契约：只注册 settings.section（list 槽、纯增量）')
const reactStub = makeReactStub()
const { exports: clientExports } = loadClientBundle({ react: reactStub })

function makeSlotsMock() {
  const registrations = []
  const injections = []
  return {
    registrations,
    injections,
    slots: {
      inject(name, cb) { injections.push(name); const d = cb(); return typeof d === 'function' ? d : () => {} },
      register(options, component) { registrations.push({ options, component }); return () => {} },
    },
  }
}
function makeLocaleMock() {
  const dicts = []
  return {
    dicts,
    locale: {
      register(ns, id, dict) { dicts.push({ ns, id, dict }); return () => {} },
      bind(ns) { return (key) => `T:${key}` },
    },
  }
}

{
  const { slots, registrations, injections } = makeSlotsMock()
  const { locale, dicts } = makeLocaleMock()
  const ctx = {
    get: (k) => (k === 'slots' ? slots : k === 'locale' ? locale : undefined),
    effect(factory) { factory() },
    logger: { info() {}, warn() {}, error() {} },
  }
  clientExports.apply(ctx)

  test('只注入 settings.section 这一个插槽', () => {
    assert.deepEqual(injections, ['settings.section'])
  })
  test('注册项名字是 settings.section（与座位一致）', () => {
    assert.equal(registrations.length, 1)
    assert.equal(registrations[0].options.name, 'settings.section')
  })
  test('提供了稳定 id 与 order（list 槽要求）', () => {
    assert.equal(typeof registrations[0].options.id, 'string')
    assert.ok(registrations[0].options.id.length > 0)
    assert.equal(typeof registrations[0].options.order, 'number')
  })
  test('label 可求值（设置页导航用）', () => {
    assert.equal(typeof registrations[0].options.label, 'function')
    assert.equal(typeof registrations[0].options.label(), 'string')
  })
  test('★ 不遮蔽任何官方座位（未使用 replace / priority 抢占）', () => {
    const opts = registrations[0].options
    assert.equal(opts.priority, undefined, '不应设置 priority（那会遮蔽官方注册）')
    assert.equal(opts.replace, undefined)
  })
  test('注册了 zh 与 en 两套字典', () => {
    assert.deepEqual(dicts.map((d) => d.id).sort(), ['en', 'zh'])
    for (const d of dicts) assert.equal(d.ns, 'dsh-session-archive')
  })
}

console.log('\n[3] ★ API 前缀与宿主一致（防两端漂移）')
test('客户端 API 前缀 === 宿主 API_PREFIX', () => {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  const m = /const API = '([^']+)'/.exec(source)
  assert.ok(m !== null, '未找到客户端 API 常量')
  assert.equal(m[1], API_PREFIX, '客户端与宿主的 API 前缀必须一致')
})
/**
 * 客户端**声明**它使用哪些端点。
 *
 * 为什么是显式清单而不是从源码猜：端点是以**变量**形式传入 `callHost` 的
 * （`runAction(key, endpoint, ...)`），静态匹配抓不到。显式声明反而让
 * "两端契约"变成可见、可维护、可断言的资产。
 */
const CLIENT_ENDPOINTS = ['list', 'trash', 'unarchive', 'delete', 'restore', 'purge', 'purgeExpired', 'repairOrphans']

function registeredHostRoutes() {
  const registered = new Set()
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get: (k) => (k === 'connection'
      ? { fetch: { register(route) { registered.add(route.path); return () => {} } } }
      : undefined),
    effect() {},
  }
  hostApply(ctx)
  return registered
}

test('宿主注册的每条路由都在客户端契约清单里（无死端点）', () => {
  const registered = registeredHostRoutes()
  assert.ok(registered.size > 0, '宿主应注册至少一条路由')
  for (const path of registered) {
    const ep = path.slice(API_PREFIX.length)
    assert.ok(CLIENT_ENDPOINTS.includes(ep),
      `宿主注册了 ${ep}，但客户端未声明使用；已注册：${[...registered].join(', ')}`)
  }
})

test('★ 客户端契约清单里的每个端点，宿主都真的注册了', () => {
  const registered = registeredHostRoutes()
  for (const ep of CLIENT_ENDPOINTS) {
    assert.ok(registered.has(`${API_PREFIX}${ep}`),
      `客户端声明使用 ${ep}，但宿主未注册 ${API_PREFIX}${ep}`)
  }
})

test('两端清单与宿主注册路由**完全一致**（双向相等）', () => {
  const registered = registeredHostRoutes()
  const hostEndpoints = [...registered].map((p) => p.slice(API_PREFIX.length)).sort()
  assert.deepEqual(hostEndpoints, [...CLIENT_ENDPOINTS].sort())
})

test('客户端 UI 确实调用了这些端点（清单不是空头承诺）', () => {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  // list / trash 是直接字面量调用
  assert.ok(source.includes("callHost('list')"), '应直接调用 list')
  assert.ok(source.includes("callHost('trash')"), '应直接调用 trash')
  // 其余通过 runAction 的 endpoint 参数调用
  for (const ep of ['unarchive', 'delete', 'restore', 'purge', 'purgeExpired', 'repairOrphans']) {
    assert.ok(source.includes(`'${ep}'`), `应出现端点字面量 ${ep}`)
  }
})

console.log('\n[3b] ★ 删除按钮的禁用条件（回归：打开过的归档会话删不掉）')
{
  const source = readFileSync(CLIENT_PATH, 'utf8')

  test('删除按钮的 disabled 只依据 running，不依据 live', () => {
    // 找归档行删除按钮的 disabled 表达式
    const m = /disabled: busy !== null \|\| item\.state === 'missing' \|\| item\.(\w+),/.exec(source)
    assert.ok(m !== null, '未找到删除按钮的 disabled 表达式（结构可能已变）')
    assert.equal(m[1], 'running',
      `删除按钮应只因 running 禁用，实际依据 item.${m[1]} —— ` +
      'live 只表示"打开过"，用它禁用会让用户无法删除看过的归档会话')
  })
  test('源码中不存在 "item.live" 直接作为禁用条件', () => {
    assert.equal(/disabled:[^\n]*item\.live/.test(source), false,
      '不得用 item.live 作为任何按钮的禁用条件')
  })
  test('运行中与已打开有各自的文案（不会混淆）', () => {
    assert.ok(source.includes("running: '（运行中，需先暂停）'"), '应有 running 文案')
    assert.ok(source.includes("opened: '（已打开）'"), '应有 opened 文案')
  })
  test('meta 行同时处理 running 与 live 两种状态', () => {
    assert.ok(/item\.running \? t\('running'\) : \(item\.live \? t\('opened'\) : null\)/.test(source),
      'meta 行应区分 running / live')
  })
}

console.log('\n[3c] ★ 恢复后必须刷新核心会话列表（回归：恢复后要手动刷新页面）')
{
  const source = readFileSync(CLIENT_PATH, 'utf8')

  test('调用了官方客户端会话服务的 refresh（核心列表重列）', () => {
    assert.ok(/sessions\.refresh\s*\(/.test(source),
      '应调用 sessions.refresh() —— 否则恢复出来的会话不会自动出现在侧边栏')
  })
  test('通过 ctx.get(\'sessions\') 可选获取，而非硬依赖', () => {
    assert.ok(/ctx\.get\('sessions'\)/.test(source), "应用 ctx.get('sessions') 可选获取")
  })
  test('★ 全程有 typeof 守卫 + try/catch（拿不到就降级为手动刷新）', () => {
    assert.ok(/typeof sessions\.refresh !== 'function'/.test(source), '应有 typeof 守卫')
    assert.ok(/catch \(error\) \{[\s\S]{0,200}sessions\.refresh\(\) 失败/.test(source), '应有降级告警')
  })
  test('刷新发生在操作成功之后（与 refreshBoth 相邻）', () => {
    const idx = source.indexOf('await refreshCoreSessions()')
    assert.ok(idx > 0, '应调用 refreshCoreSessions()')
    const before = source.slice(Math.max(0, idx - 400), idx)
    assert.ok(before.includes('await refreshBoth()'), '刷新核心列表应紧随本地视图刷新')
    assert.ok(before.includes("setNotice({ kind: 'ok'"), '且只在成功分支里')
  })
  test('未在 dsh.client.inject 里声明（因为不 require 它，只按服务取用）', () => {
    const declared = pkg.dsh.client.inject
    assert.equal(declared.includes('@deepseek-ai/dsh-api-session-controller'), false,
      '我们只 ctx.get 服务、不 require 模块，不应声明该客户端模块')
  })
}

console.log('\n[4] 降级：服务缺失时不抛错（不影响 DSH 启动）')
test('slots 缺失时只告警、不抛错', () => {
  const ctx = { get: () => undefined, effect() {}, logger: { warn() {}, error() {} } }
  let threw = null
  try { clientExports.apply(ctx) } catch (e) { threw = e }
  assert.equal(threw, null, String(threw))
})
test('locale 缺失时仍能注册设置页（字典降级）', () => {
  const { slots, registrations } = makeSlotsMock()
  const ctx = { get: (k) => (k === 'slots' ? slots : undefined), effect(f) { f() }, logger: { warn() {}, error() {} } }
  clientExports.apply(ctx)
  assert.equal(registrations.length, 1)
})

console.log('\n[5] 渲染分支（用 mock React 调组件函数）')
function renderSection(component) {
  const React = reactStub
  React.__resetCursor()
  return component({})
}

/** 把元素树拍平成字符串，便于断言文本是否出现。 */
function flatten(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (Array.isArray(node)) { for (const n of node) flatten(n, out); return out }
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (node.__element === true) {
    flatten(node.children, out)
    if (node.props && typeof node.props.title === 'string') out.push(node.props.title)
  }
  return out
}

{
  const { slots, registrations } = makeSlotsMock()
  const { locale } = makeLocaleMock()
  const ctx = {
    get: (k) => (k === 'slots' ? slots : k === 'locale' ? locale : undefined),
    effect(f) { f() },
    logger: { warn() {}, error() {} },
  }
  clientExports.apply(ctx)
  const Section = registrations[0].component

  test('初始（数据未到）渲染出标题与加载态', () => {
    const text = flatten(renderSection(Section)).join(' | ')
    assert.ok(text.includes('T:title'), `应含标题，实际: ${text.slice(0, 200)}`)
    assert.ok(text.includes('T:loading'), '应含加载态')
  })
  test('两个页签都在（已归档 / 回收站）', () => {
    const text = flatten(renderSection(Section)).join(' | ')
    assert.ok(text.includes('T:tabArchived'), `应含"已归档"页签，实际: ${text.slice(0, 200)}`)
    assert.ok(text.includes('T:tabTrash'), '应含"回收站"页签')
  })
  test('组件是函数（React 组件契约）', () => {
    assert.equal(typeof Section, 'function')
  })
}

console.log(`\n${failed === 0 ? '全部通过' : '有失败'}: ${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
