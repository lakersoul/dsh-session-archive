/**
 * 测试专用插件（e2e harness）——**只用于端到端验证**，不属于产品代码。
 *
 * 它做两件事：
 *  1. 把本进程的认证入口 URL（含 launch token）写到文件，让测试端能像浏览器那样
 *     「用 token 换 cookie」，从而真正调用 /api 路由。launch token 只存在于进程内存
 *     （`processLaunchToken`），不落盘也不打印，没有它就只能收到 401。
 *  2. 提供一条测试路由，把某个**冷会话变成 live**（打开态）并归档它 ——
 *     这样 e2e 才能覆盖「打开过的归档会话被删除」这条真实路径
 *     （走 `detachEntered`，而你日常用的就是这条）。
 *
 * 只使用**服务方法**（`sessions.prepare/enter/announce`），不 import 任何宿主包 ——
 * 插件在 profile 之外时 `@deepseek-ai/dsh-*` 无法从本包解析。
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export const name = 'session-archive-harness'

const API = '/api/saHarness'

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

export function apply(ctx) {
  const out = process.env.SA_HARNESS_OUT
  if (typeof out === 'string' && out.length > 0) {
    ctx.inject(['connection'], (c) => {
      const connection = c.get('connection')
      if (connection === undefined || typeof connection.authenticatedUrl !== 'function') return
      try {
        const url = connection.authenticatedUrl(`http://127.0.0.1:${process.env.SA_HARNESS_PORT ?? '3099'}`)
        mkdirSync(dirname(out), { recursive: true })
        writeFileSync(out, url, 'utf8')
      } catch (error) {
        try { writeFileSync(out, `ERROR ${String(error?.message ?? error)}`, 'utf8') } catch { /* ignore */ }
      }
    })
  }

  // 测试路由：把冷会话变成 live（打开态），可选同时归档它
  ctx.inject(['connection'], (c) => {
    const connection = c.get('connection')
    if (connection === undefined || connection.fetch === undefined) return

    const register = (path, handler) => {
      try {
        connection.fetch.register({
          path,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: handler,
        })
      } catch (error) {
        ctx.logger.warn(`[${name}] 注册 ${path} 失败: ${String(error?.message ?? error)}`)
      }
    }

    register(`${API}.makeLive`, async (request) => {
      const body = await request.json().catch(() => undefined)
      const sessionId = body?.sessionId
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        return json(400, { error: 'bad-request' })
      }
      const sessions = c.get('sessions')
      const persistence = c.get('sessionPersistence')
      if (sessions === undefined || persistence === undefined) return json(503, { error: 'no-service' })

      try {
        // 归档（可选）：直接写 workspaceRegistry，与真实删除路径同一权威源
        if (body?.archive === true) {
          const registry = c.get('workspaceRegistry')
          if (registry !== undefined && typeof registry.enqueueOperation === 'function') {
            await registry.enqueueOperation(() => {
              const ids = registry.state?.archivedSessionIds ?? []
              if (!ids.includes(sessionId)) {
                return registry.setState({ ...registry.state, archivedSessionIds: [...ids, sessionId] })
              }
              return undefined
            })
          }
        }

        // 已 live 就不重复进入
        if (sessions.get(sessionId) !== undefined) return json(200, { ok: true, live: true, already: true })

        const handle = await persistence.open(sessionId, 'read')
        const header = handle.header
        let session
        try {
          // 让某个工作区记账该会话 —— 这是现实中的状态（否则侧边栏根本不会显示它），
          // 也是删除时能记录归属、恢复时能挂回的前提。
          const registry = c.get('workspaceRegistry')
          if (registry !== undefined && typeof header?.cwd === 'string' && header.cwd.length > 0) {
            let workspace = typeof registry.resolveByPath === 'function'
              ? await registry.resolveByPath(header.cwd)
              : undefined
            if (workspace === undefined && typeof registry.createCanonical === 'function') {
              workspace = await registry.createCanonical(header.cwd)
            }
            if (workspace !== undefined && workspace !== null
                && !(workspace.record?.sessionIds ?? []).includes(sessionId)) {
              await workspace.attachSession(sessionId)
            }
          }

          session = sessions.prepare(sessionId, {
            seed: [],
            meta: header,
            inheritedEventCount: 0,
            eventState: 'detached',
          })
        } finally {
          if (typeof handle.close === 'function') await handle.close()
        }
        sessions.enter(session)
        // announce 才会发出 session/created → api-session/added，
        // 与浏览器打开会话时的序列一致；detachEntered 也只对 announced 的条目发 disposed。
        if (typeof sessions.announce === 'function') sessions.announce(session)
        return json(200, {
          ok: true,
          live: true,
          workspaceId: (await (c.get('workspaceRegistry')?.resolveByPath?.(header?.cwd) ?? Promise.resolve(undefined)))?.id ?? null,
        })
      } catch (error) {
        return json(500, { error: 'harness-failed', detail: String(error?.message ?? error) })
      }
    })

    register(`${API}.isLive`, async (request) => {
      const body = await request.json().catch(() => undefined)
      const sessions = c.get('sessions')
      const live = sessions !== undefined && typeof sessions.get === 'function'
        ? sessions.get(body?.sessionId) !== undefined
        : false
      return json(200, { ok: true, live })
    })
  })
}
