// ============================================================================
// Wiki errors — typed discriminated union surfaced by adapter + registry.
// Tools translate these into "wiki unavailable" messages for agents instead
// of letting the turn crash.
// ============================================================================

export type WikiErrorKind =
  | 'unavailable'        // network failure, DNS, timeout
  | 'not_found'          // 404 — page or repo doesn't exist
  | 'rate_limited'       // 403 with rate-limit header, or 429
  | 'unauthorized'       // 401 / 403 (non-rate-limit) — bad/missing PAT
  | 'parse_error'        // response body wasn't what we expected
  | 'unknown'

export interface WikiError extends Error {
  readonly kind: WikiErrorKind
  readonly status?: number
  readonly retryAfterMs?: number
  readonly wikiId?: string
}

export const createWikiError = (
  kind: WikiErrorKind,
  message: string,
  extra: { status?: number; retryAfterMs?: number; wikiId?: string; cause?: unknown } = {},
): WikiError => {
  const err = new Error(message) as WikiError & { kind: WikiErrorKind }
  ;(err as { kind: WikiErrorKind }).kind = kind
  if (extra.status !== undefined) (err as { status?: number }).status = extra.status
  if (extra.retryAfterMs !== undefined) (err as { retryAfterMs?: number }).retryAfterMs = extra.retryAfterMs
  if (extra.wikiId !== undefined) (err as { wikiId?: string }).wikiId = extra.wikiId
  if (extra.cause !== undefined) (err as { cause?: unknown }).cause = extra.cause
  return err
}

export const isWikiError = (err: unknown): err is WikiError =>
  err instanceof Error && typeof (err as { kind?: unknown }).kind === 'string'

// Map an HTTP response to a WikiError. Honors GitHub's rate-limit headers.
export const wikiErrorFromResponse = (res: Response, wikiId?: string): WikiError => {
  const status = res.status
  if (status === 404) return createWikiError('not_found', `not found (404)`, { status, wikiId })
  if (status === 401) return createWikiError('unauthorized', `unauthorized (401)`, { status, wikiId })
  if (status === 429) {
    const retryAfter = res.headers.get('retry-after')
    const retryAfterMs = retryAfter ? Number.parseInt(retryAfter, 10) * 1000 : undefined
    return createWikiError('rate_limited', `rate limited (429)`, { status, retryAfterMs, wikiId })
  }
  if (status === 403) {
    const remaining = res.headers.get('x-ratelimit-remaining')
    if (remaining === '0') {
      const reset = res.headers.get('x-ratelimit-reset')
      const resetMs = reset ? Number.parseInt(reset, 10) * 1000 : undefined
      const retryAfterMs = resetMs ? Math.max(0, resetMs - Date.now()) : undefined
      return createWikiError('rate_limited', `rate limited (403, x-ratelimit-remaining=0)`, { status, retryAfterMs, wikiId })
    }
    return createWikiError('unauthorized', `forbidden (403)`, { status, wikiId })
  }
  return createWikiError('unknown', `unexpected status ${status}`, { status, wikiId })
}
