// ============================================================================
// Shared-token auth for the deploy mode. Disabled when SAMSINN_TOKEN env is
// unset OR empty — preserves the laptop UX. When set, every HTTP request and
// every WS upgrade must present an HttpOnly session cookie issued by
// /api/auth.
//
// The session is in-memory only; restart invalidates all sessions and any
// connected client gets bounced to the token prompt. Acceptable for the
// sandbox use case — the operator restarts rarely.
// ============================================================================

const validSessions = new Set<string>()

const SESSION_COOKIE = 'samsinn_session'
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000  // 30 days

// Token check is constant-time to keep timing-leak surface tiny.
const constantTimeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false
  let mismatch = 0
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return mismatch === 0
}

const requiredToken = (): string | null => {
  const raw = process.env.SAMSINN_TOKEN
  if (!raw || raw.length === 0) return null
  return raw
}

export const authEnabled = (): boolean => requiredToken() !== null

export const validateToken = (candidate: string): boolean => {
  const required = requiredToken()
  if (required === null) return true  // dev passthrough
  return constantTimeEqual(candidate, required)
}

export const issueSession = (): string => {
  const id = crypto.randomUUID()
  validSessions.add(id)
  return id
}

export const isValidSession = (id: string | null): boolean => {
  if (!authEnabled()) return true  // dev passthrough
  if (!id) return false
  return validSessions.has(id)
}

// Parse a single cookie value out of the Cookie header. Tiny; avoids a dep.
export const parseCookie = (header: string | null, name: string): string | null => {
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const k = part.slice(0, eq).trim()
    if (k !== name) continue
    return part.slice(eq + 1).trim()
  }
  return null
}

// Build a Set-Cookie header value. HttpOnly + Secure + SameSite=Strict.
export const buildSessionCookie = (sessionId: string): string =>
  `${SESSION_COOKIE}=${sessionId}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`

export const sessionCookieName = SESSION_COOKIE

// Read session id from a request's Cookie header.
export const sessionFromRequest = (req: Request): string | null =>
  parseCookie(req.headers.get('cookie'), SESSION_COOKIE)
