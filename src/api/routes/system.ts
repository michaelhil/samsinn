// ============================================================================
// System-level admin routes — currently just shutdown.
//
// POST /api/system/shutdown triggers a graceful shutdown so a supervisor
// (bun --watch, docker, systemd) can respawn with fresh env + providers.json.
// Samsinn doesn't self-respawn; the user's orchestrator is responsible.
// ============================================================================

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { json, errorResponse, parseBody } from './helpers.ts'
import type { RouteEntry } from './types.ts'
import { authEnabled, buildSessionCookie, issueSession, validateToken } from '../auth.ts'

// Cached on first read. package.json doesn't change at runtime.
let cachedInfo: { version: string; repoUrl: string } | null = null

const normalizeRepoUrl = (raw: unknown): string => {
  if (typeof raw === 'string') return raw.replace(/^git\+/, '').replace(/\.git$/, '')
  if (raw && typeof raw === 'object' && 'url' in raw) {
    return normalizeRepoUrl((raw as { url: string }).url)
  }
  return ''
}

const readPackageInfo = async (): Promise<{ version: string; repoUrl: string }> => {
  if (cachedInfo) return cachedInfo
  try {
    const raw = await readFile(resolve(process.cwd(), 'package.json'), 'utf-8')
    const pkg = JSON.parse(raw) as { version?: string; repository?: unknown }
    cachedInfo = {
      version: pkg.version ?? '0.0.0',
      repoUrl: normalizeRepoUrl(pkg.repository),
    }
  } catch {
    cachedInfo = { version: '0.0.0', repoUrl: '' }
  }
  return cachedInfo
}

export const systemRoutes: RouteEntry[] = [
  {
    method: 'GET',
    pattern: /^\/api\/system\/info$/,
    handler: async () => json(await readPackageInfo()),
  },
  {
    // Auth status — used by the UI to decide whether to show the token prompt.
    // Always succeeds; the body says whether auth is required and whether the
    // current request carries a valid session cookie.
    method: 'GET',
    pattern: /^\/api\/auth$/,
    handler: async (req) => {
      const enabled = authEnabled()
      if (!enabled) return json({ authEnabled: false, authenticated: true })
      const { sessionFromRequest, isValidSession } = await import('../auth.ts')
      const session = sessionFromRequest(req)
      return json({ authEnabled: true, authenticated: isValidSession(session) })
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/auth$/,
    handler: async (req) => {
      if (!authEnabled()) {
        // Dev / unset-token mode — pretend success so the UI flow still runs.
        return json({ ok: true })
      }
      const body = await parseBody(req)
      const candidate = typeof body.token === 'string' ? body.token : ''
      if (!validateToken(candidate)) return errorResponse('invalid token', 401)
      const sessionId = issueSession()
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Set-Cookie': buildSessionCookie(sessionId),
        },
      })
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/system\/shutdown$/,
    handler: async (_req, _match, _ctx) => {
      // Schedule exit on the next tick so the response is flushed first.
      // SIGTERM triggers the drain/snapshot-save shutdown handler in
      // bootstrap.ts, reusing the existing graceful path.
      setTimeout(() => {
        try { process.kill(process.pid, 'SIGTERM') } catch { process.exit(0) }
      }, 100)
      return json({ shuttingDown: true, pid: process.pid })
    },
  },
]
