/**
 * dsh-session-archive —— client half（浏览器半边）
 * ===========================================================================
 * 在官方设置页 `settings.section` 注册一个「会话归档」页，提供：
 *   · 已归档会话列表 → 恢复
 *   · 删除（进可恢复回收站）
 *   · 回收站列表 → 恢复 / 彻底清除
 *
 * ## 为什么选 `settings.section`
 * 它是 **list 槽**、`replaceRisk: none` —— 纯增量注册，不遮蔽任何官方 UI。
 * 这正是与 archive-manager（用 priority -0.5 遮蔽 `sidebar.workspaces`）最本质的
 * 区别：本项目不做任何 UI 接管，因此不存在"插件一坏、侧栏就打不开"的耦合。
 *
 * ## 与宿主通信的确切形状
 * 宿主侧用 `connection.fetch.register` 注册**精确 /api 路由**（复用官方认证围栏：
 * `isTrustedApiRequest` + cookie/process-token）。客户端因此就是普通同源 fetch：
 *
 *     const base = globalThis.location?.origin
 *     const url = new URL('/api/sessionArchive.list', base ?? 'http://dsh.internal')
 *     await fetch(url, { method: 'POST', credentials: 'include',
 *                        headers: { 'content-type': 'application/json' },
 *                        body: JSON.stringify(payload) })
 *
 * `credentials: 'include'` 是必需的 —— 官方 `dsh-client-file-upload` 也是这么发的。
 * 这个形状取自官方样例 `dsh-session-log-export`（`hostBase()`）与
 * `dsh-client-file-upload`（`credentials: 'include'`）。
 *
 * ## 格式说明（重要）
 * DSH 的客户端 bundle **不是普通 ESM**，必须是
 * `window.__ModuleLoader__.load({ id, factory: (require) => exports })`，
 * 其中 id 必须等于包名。依赖通过 factory 收到的 require 获取，
 * 且必须在 package.json 的 `dsh.client.inject` 里声明。
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-archive',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    /** 与包名一致的 locale 命名空间。 */
    const NS = 'dsh-session-archive'

    /** API 前缀，必须与宿主 `lib/index.js` 的 API_PREFIX 一致。 */
    const API = '/api/sessionArchive.'

    const LOCALES = ['zh', 'en']

    const DICT = {
      zh: {
        nav: '会话归档',
        title: '会话归档',
        intro: '管理已归档会话，以及删除后的回收站。删除进入回收站后仍可恢复。',
        tabArchived: '已归档',
        tabTrash: '回收站',
        empty: '没有已归档的会话。',
        emptyTrash: '回收站是空的。',
        loading: '加载中…',
        loadFailed: '加载失败',
        retry: '重试',
        restore: '恢复',
        archiveDelete: '删除',
        purge: '彻底清除',
        purgeConfirm: '再点一次确认彻底清除（不可恢复）',
        deleteConfirm: '再点一次确认删除到回收站',
        missing: '（会话文件已不存在）',
        running: '（运行中，需先暂停）',
        opened: '（已打开）',
        cancelled: '已取消',
        noTitle: '（无标题）',
        total: '共',
        unit: '条',
        unknownCwd: '无工作区',
        purgeHint: '彻底清除不可恢复',
        stats: '占用',
        expiring: '待清理',
        overLimit: '回收站已超出上限',
        orphanWarn: '发现磁盘上存在但未被任何工作区记账的会话',
        orphanUnit: '个',
        repair: '修复',
        orphanHint: '（多为旧版本恢复遗留：文件在，但侧边栏看不到）',
        repairedOk: '已修复',
        nothingToRepair: '没有需要修复的会话',
        purgeExpired: '清理已超期',
        purgeOldest: '清理最旧',
        purgeExpiredConfirm: '再点一次确认清理全部已超期条目（不可恢复）',
        purgeOldestConfirm: '再点一次确认清理最旧的 10 条（不可恢复）',
        nothingToPurge: '没有可清理的条目',
      },
      en: {
        nav: 'Session Archive',
        title: 'Session Archive',
        intro: 'Manage archived sessions and the trash that deletions go into. Deletions stay recoverable.',
        tabArchived: 'Archived',
        tabTrash: 'Trash',
        empty: 'No archived sessions.',
        emptyTrash: 'The trash is empty.',
        loading: 'Loading…',
        loadFailed: 'Failed to load',
        retry: 'Retry',
        restore: 'Restore',
        archiveDelete: 'Delete',
        purge: 'Delete forever',
        purgeConfirm: 'Click again to delete forever (unrecoverable)',
        deleteConfirm: 'Click again to move to trash',
        missing: '(session file is gone)',
        running: '(running — pause it first)',
        opened: '(open)',
        cancelled: 'Cancelled',
        noTitle: '(untitled)',
        total: 'Total',
        unit: '',
        unknownCwd: 'No workspace',
        purgeHint: 'Deleting forever cannot be undone',
        stats: 'Used',
        expiring: 'Expiring',
        overLimit: 'Trash is over its limits',
        orphanWarn: 'Sessions exist on disk but are not accounted by any workspace',
        orphanUnit: '',
        repair: 'Repair',
        orphanHint: '(usually left by an older restore: files exist but the sidebar cannot see them)',
        repairedOk: 'Repaired',
        nothingToRepair: 'Nothing to repair',
        purgeExpired: 'Purge expired',
        purgeOldest: 'Purge oldest',
        purgeExpiredConfirm: 'Click again to purge ALL expired entries (unrecoverable)',
        purgeOldestConfirm: 'Click again to purge the 10 oldest entries (unrecoverable)',
        nothingToPurge: 'Nothing to purge',
      },
    }

    /** 浏览器半边无硬依赖：slots / locale 都按可选读取。 */
    const inject = []

    // ── 传输层 ────────────────────────────────────────────────────────────
    /** 解析 Host base（与官方 `dsh-session-log-export` 的 `hostBase()` 同形）。 */
    function hostBase() {
      const origin = globalThis.location?.origin
      return origin !== undefined && origin !== null && origin !== 'null' ? origin : 'http://dsh.internal'
    }

    /**
     * 调一条本插件的 /api 路由。
     * @param {string} endpoint 例如 'list'
     * @param {object} [payload]
     * @returns {Promise<{ok: true, status: number, body: any} | {ok: false, status: number, error: string, detail?: string}>}
     */
    async function callHost(endpoint, payload) {
      const url = new URL(`${API}${endpoint}`, hostBase())
      let response
      try {
        response = await fetch(url, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload ?? {}),
        })
      } catch (error) {
        return { ok: false, status: 0, error: 'network', detail: String(error?.message ?? error) }
      }
      let body
      try {
        body = await response.json()
      } catch {
        body = undefined
      }
      if (!response.ok) {
        return {
          ok: false,
          status: response.status,
          error: body?.error ?? `http-${response.status}`,
          detail: body?.detail ?? undefined,
        }
      }
      return { ok: true, status: response.status, body }
    }

    // ── 展示辅助 ──────────────────────────────────────────────────────────
    function formatBytes(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
      const units = ['B', 'KB', 'MB', 'GB']
      let value = bytes
      let i = 0
      while (value >= 1024 && i < units.length - 1) { value /= 1024; i++ }
      return `${value < 10 && i > 0 ? value.toFixed(1) : Math.round(value)} ${units[i]}`
    }

    function formatTime(ms, active) {
      if (!Number.isFinite(ms) || ms <= 0) return '—'
      try {
        return new Date(ms).toLocaleString(active, { dateStyle: 'short', timeStyle: 'short' })
      } catch {
        return new Date(ms).toLocaleString()
      }
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      const locale = ctx.get('locale')
      const disposers = []

      // ── 字典注册：失败只降级为原文，不阻断 ────────────────────────────────
      if (locale !== undefined && typeof locale.register === 'function') {
        for (const id of LOCALES) {
          try {
            const dispose = locale.register(NS, id, DICT[id] ?? DICT.en)
            if (typeof dispose === 'function') disposers.push(dispose)
          } catch (error) {
            console.warn(`[${NS}] locale.register(${id}) 失败（降级为原文）:`, error)
          }
        }
      }

      const translate = (key) => {
        if (locale !== undefined && typeof locale.bind === 'function') {
          try { return locale.bind(NS)(key) } catch { /* 落入兜底 */ }
        }
        return DICT.zh[key] ?? DICT.en[key] ?? key
      }

      if (slots === undefined) {
        console.warn(`[${NS}] slots 服务不可用，设置页未注册（其余功能不受影响）`)
        return
      }

      /**
       * 请求宿主侧「核心会话列表」重新拉取。
       *
       * 为什么需要：删除时宿主会发 `api-session/removed`，浏览器立刻删行；
       * 但**恢复**出来的会话对核心列表是全新条目 —— 没有对应的 added 信号，
       * 侧边栏就不会出现它（只能手动刷新页面）。
       * 官方客户端会话服务提供 `refresh()`（内部即 `refreshList()`，走
       * `session.list` 全量重列，且单飞），调用它即可让新恢复的会话立即可见。
       *
       * 该成员未在 `ISessions` 公开契约里，故全程可选链 + try/catch 降级：
       * 拿不到就退化为「需要手动刷新」，不影响其它功能。
       */
      const refreshCoreSessions = async () => {
        const sessions = ctx.get('sessions')
        if (sessions === undefined || sessions === null || typeof sessions.refresh !== 'function') return false
        try {
          await sessions.refresh()
          return true
        } catch (error) {
          console.warn(`[${NS}] sessions.refresh() 失败（可手动刷新页面）:`, error)
          return false
        }
      }

      // ── 注册设置页（list 槽，纯增量）────────────────────────────────────
      try {
        const dispose = slots.inject('settings.section', () => slots.register(
          {
            name: 'settings.section',
            id: 'session-archive',
            order: 62,
            label: () => translate('nav'),
            locale: NS,
          },
          ArchiveSection,
        ))
        if (typeof dispose === 'function') disposers.push(dispose)
      } catch (error) {
        console.error(`[${NS}] 注册设置页失败:`, error)
      }

      // 归属当前 fiber：卸载/更新时撤销注册与字典
      ctx.effect(() => () => {
        for (const dispose of disposers) {
          try { dispose() } catch (error) { console.warn(`[${NS}] 撤销注册失败:`, error) }
        }
      }, `${NS}.contributions`)

      console.log(`[${NS}] client half mounted（座位：settings.section）`)

      // ── 主组件 ──────────────────────────────────────────────────────────
      function ArchiveSection() {
        const t = translate
        const [tab, setTab] = React.useState('archived')
        const [archived, setArchived] = React.useState(null)
        const [trash, setTrash] = React.useState(null)
        const [error, setError] = React.useState(null)
        const [busy, setBusy] = React.useState(null)
        const [confirming, setConfirming] = React.useState(null)
        const [notice, setNotice] = React.useState(null)

        const loadArchived = React.useCallback(async () => {
          setError(null)
          const r = await callHost('list')
          if (r.ok) setArchived(r.body)
          else setError({ where: 'archived', ...r })
        }, [])

        const loadTrash = React.useCallback(async () => {
          setError(null)
          const r = await callHost('trash')
          if (r.ok) setTrash(r.body)
          else setError({ where: 'trash', ...r })
        }, [])

        React.useEffect(() => {
          if (tab === 'archived') void loadArchived()
          else void loadTrash()
        }, [tab, loadArchived, loadTrash])

        const refreshBoth = React.useCallback(async () => {
          await loadArchived()
          await loadTrash()
        }, [loadArchived, loadTrash])

        const runAction = React.useCallback(async (key, endpoint, payload, afterMessage) => {
          setBusy(key)
          setNotice(null)
          try {
            const r = await callHost(endpoint, payload)
            if (r.ok) {
              setNotice({ kind: 'ok', message: afterMessage })
              await refreshBoth()
              // 恢复出来的会话对核心列表是全新条目，必须让它重列才会出现在侧边栏
              await refreshCoreSessions()
            } else {
              setNotice({
                kind: 'error',
                message: `${r.error}${r.detail !== undefined ? ` — ${r.detail}` : ''}`,
              })
            }
          } finally {
            setBusy(null)
            setConfirming(null)
          }
        }, [refreshBoth])

        // 二次点击确认：不引入弹层组件依赖，同时保证"不可逆操作必须手滑两次"
        const confirmThen = (confirmKey, action) => {
          if (confirming === confirmKey) {
            void action()
            return
          }
          setConfirming(confirmKey)
          setNotice({
            kind: 'warn',
            message: confirmKey.startsWith('purge') ? t('purgeConfirm') : t('deleteConfirm'),
          })
        }

        const s = {
          wrap: { padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px', minHeight: 0 },
          h: { margin: 0, fontSize: '16px' },
          p: { margin: 0, opacity: 0.75, fontSize: '13px' },
          tabs: { display: 'flex', gap: '8px', borderBottom: '1px solid var(--dsw-alias-border-l4, #3333)', paddingBottom: '8px' },
          tab: (active) => ({
            padding: '4px 10px',
            borderRadius: '6px',
            cursor: 'pointer',
            fontSize: '13px',
            border: '1px solid transparent',
            background: active ? 'var(--dsw-alias-interactive-bg-hover, #8882)' : 'transparent',
            color: 'inherit',
          }),
          bar: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', opacity: 0.7, flexWrap: 'wrap' },
          list: { display: 'flex', flexDirection: 'column', gap: '6px', overflowY: 'auto', minHeight: 0 },
          row: {
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            padding: '8px 10px',
            border: '1px solid var(--dsw-alias-border-l4, #3333)',
            borderRadius: '8px',
          },
          grow: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' },
          name: { fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          meta: { fontSize: '11px', opacity: 0.65, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          btn: (danger, pending = false) => ({
            padding: '4px 10px',
            borderRadius: '6px',
            cursor: 'pointer',
            fontSize: '12px',
            border: pending
              ? '2px solid var(--dsw-alias-label-primary, #fff)'
              : '1px solid var(--dsw-alias-border-l4, #3333)',
            background: danger ? 'var(--dsw-alias-bg-danger, #c33232)' : 'transparent',
            color: danger ? '#fff' : 'inherit',
            opacity: busy !== null ? 0.6 : 1,
            fontWeight: pending ? 600 : 'inherit',
          }),
          notice: (kind) => ({
            fontSize: '12px',
            padding: '6px 10px',
            borderRadius: '6px',
            background: kind === 'error'
              ? 'var(--dsw-alias-bg-danger, #c33232)'
              : 'var(--dsw-alias-interactive-bg-hover, #8882)',
            color: kind === 'error' ? '#fff' : 'inherit',
          }),
          small: { fontSize: '11px', margin: 0, opacity: 0.7 },
        }

        const archivedItems = archived?.items ?? []
        const trashItems = trash?.entries ?? []
        const brokenItems = trash?.broken ?? []

        const header = React.createElement('div', null,
          React.createElement('h2', { style: s.h }, t('title')),
          React.createElement('p', { style: s.p }, t('intro')),
        )

        const tabs = React.createElement('div', { style: s.tabs },
          React.createElement('button', {
            type: 'button',
            style: s.tab(tab === 'archived'),
            onClick: () => { setTab('archived'); setNotice(null) },
          }, `${t('tabArchived')}${archived !== null ? ` (${archived.summary?.total ?? 0})` : ''}`),
          React.createElement('button', {
            type: 'button',
            style: s.tab(tab === 'trash'),
            onClick: () => { setTab('trash'); setNotice(null) },
          }, `${t('tabTrash')}${trash !== null ? ` (${trashItems.length})` : ''}`),
        )

        const noticeBar = notice !== null
          ? React.createElement('div', { style: s.notice(notice.kind) }, notice.message)
          : null

        const errorBar = error !== null
          ? React.createElement('div', { style: s.notice('error') },
            `${t('loadFailed')}：${error.error}${error.detail !== undefined ? ` — ${error.detail}` : ''}`,
            React.createElement('button', {
              type: 'button',
              style: { ...s.btn(false), marginLeft: '8px' },
              onClick: () => { void (tab === 'archived' ? loadArchived() : loadTrash()) },
            }, t('retry')),
          )
          : null

        const orphanBar = (archived?.orphans?.length ?? 0) > 0
          ? React.createElement('div', { style: s.bar },
            React.createElement('span', { style: { color: 'var(--dsw-alias-bg-danger, #c33232)' } },
              `⚠ ${t('orphanWarn')}：${archived.orphans.length} ${t('orphanUnit')}`.trim()),
            React.createElement('span', { style: s.small }, t('orphanHint')),
            React.createElement('button', {
              type: 'button',
              style: s.btn(false, confirming === 'repairOrphans'),
              disabled: busy !== null,
              onClick: () => confirmThen('repairOrphans', () => runAction(
                'repairOrphans',
                'repairOrphans',
                {},
                `${t('repairedOk')} ✓`,
              )),
            }, confirming === 'repairOrphans' ? t('repairedOk') : t('repair')),
          )
          : null

        const archivedPane = React.createElement(React.Fragment, null,
          orphanBar,
          React.createElement('div', { style: s.bar },
            React.createElement('span', null, `${t('total')} ${archived?.summary?.total ?? 0} ${t('unit')}`.trim()),
            (archived?.summary?.missing ?? 0) > 0
              ? React.createElement('span', null, `· ${archived.summary.missing} ${t('missing')}`)
              : null,
          ),
          archivedItems.length === 0
            ? React.createElement('p', { style: s.p }, t('empty'))
            : React.createElement('div', { style: s.list },
              archivedItems.map((item) => React.createElement('div', {
                key: item.sessionId,
                style: s.row,
              },
              React.createElement('div', { style: s.grow },
                React.createElement('span', { style: s.name, title: item.sessionId }, item.title ?? item.sessionId),
                React.createElement('span', { style: s.meta },
                  [
                    item.cwd ?? t('unknownCwd'),
                    formatTime(item.activityAt, true),
                    item.state === 'missing' ? t('missing') : null,
                    // live 只是"在内存 store 里"（打开过就有），可删；
                    // running 才是"agent 正在跑"，不可删。
                    item.running ? t('running') : (item.live ? t('opened') : null),
                  ].filter(Boolean).join(' · ')),
              ),
              React.createElement('button', {
                type: 'button',
                style: s.btn(false),
                disabled: busy !== null || item.state === 'missing',
                title: item.state === 'missing' ? t('missing') : t('restore'),
                onClick: () => {
                  void runAction(`u:${item.sessionId}`, 'unarchive', { sessionId: item.sessionId }, `${t('restore')} ✓`)
                },
              }, t('restore')),
              React.createElement('button', {
                type: 'button',
                style: s.btn(true, confirming === `delete:${item.sessionId}`),
                // 只因 running 而禁用：live 会话（打开过）删除是安全的，
                // 宿主会走 detachEntered 把它从内存 store 摘掉。
                disabled: busy !== null || item.state === 'missing' || item.running,
                title: item.running ? t('running') : (confirming === `delete:${item.sessionId}` ? t('deleteConfirm') : t('archiveDelete')),
                onClick: () => confirmThen(`delete:${item.sessionId}`, () => runAction(
                  `d:${item.sessionId}`,
                  'delete',
                  { sessionId: item.sessionId },
                  `${t('archiveDelete')} ✓`,
                )),
              }, confirming === `delete:${item.sessionId}` ? t('deleteConfirm') : t('archiveDelete')),
              )),
            ),
        )

        const trashPane = React.createElement(React.Fragment, null,
          React.createElement('div', { style: s.bar },
            React.createElement('span', null,
              `${t('total')} ${trash?.summary?.total ?? 0} / ${trash?.limits?.maxEntries ?? '—'} ${t('unit')}`.trim()),
            React.createElement('span', null,
              `· ${t('stats')} ${formatBytes(trash?.summary?.totalBytes ?? 0)} / ${formatBytes(trash?.limits?.maxBytes ?? 0)}`),
            (trash?.summary?.expiring?.length ?? 0) > 0
              ? React.createElement('span', null, `· ${t('expiring')} ${trash.summary.expiring.length}`)
              : null,
          ),
          React.createElement('p', { style: s.small }, t('purgeHint')),
          // 容量告警 + **手动**清理入口。绝不自动淘汰 —— 清理必须由使用者点两次确认。
          (trash?.summary?.overLimits === true || (trash?.summary?.expiring?.length ?? 0) > 0)
            ? React.createElement('div', { style: s.bar },
              trash?.summary?.overLimits === true
                ? React.createElement('span', { style: { color: 'var(--dsw-alias-bg-danger, #c33232)' } }, `⚠ ${t('overLimit')}`)
                : null,
              (trash?.summary?.expiring?.length ?? 0) > 0
                ? React.createElement('button', {
                  type: 'button',
                  style: s.btn(true, confirming === 'purgeExpired'),
                  disabled: busy !== null,
                  onClick: () => confirmThen('purgeExpired', () => runAction(
                    'purgeExpired',
                    'purgeExpired',
                    { onlyExpired: true },
                    `${t('purgeExpired')} ✓`,
                  )),
                }, confirming === 'purgeExpired' ? t('purgeExpiredConfirm') : `${t('purgeExpired')} (${trash.summary.expiring.length})`)
                : null,
              trash?.summary?.overLimits === true
                ? React.createElement('button', {
                  type: 'button',
                  style: s.btn(true, confirming === 'purgeOldest'),
                  disabled: busy !== null,
                  onClick: () => confirmThen('purgeOldest', () => runAction(
                    'purgeOldest',
                    'purgeExpired',
                    { oldestCount: 10 },
                    `${t('purgeOldest')} ✓`,
                  )),
                }, confirming === 'purgeOldest' ? t('purgeOldestConfirm') : t('purgeOldest'))
                : null,
            )
            : null,
          trashItems.length === 0
            ? React.createElement('p', { style: s.p }, t('emptyTrash'))
            : React.createElement('div', { style: s.list },
              trashItems.map((item) => React.createElement('div', {
                key: item.sessionId,
                style: s.row,
              },
              React.createElement('div', { style: s.grow },
                React.createElement('span', { style: s.name, title: item.sessionId }, item.title ?? item.sessionId),
                React.createElement('span', { style: s.meta },
                  [
                    item.cwd ?? t('unknownCwd'),
                    formatTime(item.deletedAt, true),
                    formatBytes(item.sizeBytes ?? 0),
                  ].filter(Boolean).join(' · ')),
              ),
              React.createElement('button', {
                type: 'button',
                style: s.btn(false),
                disabled: busy !== null,
                onClick: () => {
                  void runAction(`r:${item.sessionId}`, 'restore', { sessionId: item.sessionId }, `${t('restore')} ✓`)
                },
              }, t('restore')),
              React.createElement('button', {
                type: 'button',
                style: s.btn(true, confirming === `purge:${item.sessionId}`),
                disabled: busy !== null,
                onClick: () => confirmThen(`purge:${item.sessionId}`, () => runAction(
                  `p:${item.sessionId}`,
                  'purge',
                  { sessionId: item.sessionId },
                  `${t('purge')} ✓`,
                )),
              }, confirming === `purge:${item.sessionId}` ? t('purgeConfirm') : t('purge')),
              )),
            ),
          brokenItems.length > 0
            ? React.createElement('div', { style: s.bar },
              React.createElement('span', null,
                `⚠ ${brokenItems.length} ${t('loadFailed')}: ${brokenItems.map((b) => b.dirName).join(', ')}`),
            )
            : null,
        )

        const loading = React.createElement('p', { style: s.p }, t('loading'))

        const body = tab === 'archived'
          ? (archived === null && error === null ? loading : archivedPane)
          : (trash === null && error === null ? loading : trashPane)

        return React.createElement('div', { style: s.wrap }, header, tabs, noticeBar, errorBar, body)
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
