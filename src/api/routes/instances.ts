// ============================================================================
// Instances admin — list / create / switch / delete the per-tenant Houses.
//
// Surfaces the on-disk + in-memory registry to the UI's Instances modal under
// Settings. Reset of the *current* instance still goes through /api/system/reset
// (existing 10s-countdown UX). Delete here is a one-shot for non-current
// instances and refuses to delete the cookie-bound one — the user must switch
// or reset first.
//
// Create is rate-limited by remote IP (sliding 60-second window) so a
// drive-by spammer can't materialize thousands of instance directories.
// Cookieless callers always get a fresh id, so cookie-keyed limits would
// be useless against the abuse path — IP is the stable identifier.
// ============================================================================

import { json, errorResponse } from './helpers.ts'
import type { RouteEntry } from './types.ts'
import { getInstanceId } from '../instance-cookie.ts'

const REQUIRED = (msg = 'instances admin not wired') => errorResponse(msg, 501)

// --- Create rate limiter (per IP, sliding 60-second window) ---
//
// Tunable via env. Defaults aimed at single-user / small-team deploys
// where a real human creates maybe one instance per minute, never five.
const RATE_WINDOW_MS = Number(process.env.SAMSINN_CREATE_RATE_WINDOW_MS) || 60_000
const RATE_LIMIT_PER_WINDOW = Number(process.env.SAMSINN_CREATE_RATE_LIMIT) || 5

const createTimestamps = new Map<string, number[]>()

const checkRateLimit = (ip: string | undefined, now: number = Date.now()): { ok: true } | { ok: false; retryAfterMs: number } => {
  // No IP available (test/headless boundary) — fail open. Production traffic
  // always reaches us with an IP via Bun.serve.requestIP().
  if (!ip) return { ok: true }
  const stamps = createTimestamps.get(ip) ?? []
  const cutoff = now - RATE_WINDOW_MS
  const recent = stamps.filter(t => t > cutoff)
  if (recent.length >= RATE_LIMIT_PER_WINDOW) {
    const oldest = recent[0]!
    return { ok: false, retryAfterMs: oldest + RATE_WINDOW_MS - now }
  }
  recent.push(now)
  createTimestamps.set(ip, recent)
  // Garbage-collect: bound the map's growth by trimming entries with no
  // recent activity. Cheap O(N) sweep, runs only on accept paths.
  if (createTimestamps.size > 1024) {
    for (const [k, v] of createTimestamps) {
      if (v.every(t => t <= cutoff)) createTimestamps.delete(k)
    }
  }
  return { ok: true }
}

export const instanceRoutes: RouteEntry[] = [
  {
    method: 'GET',
    pattern: /^\/api\/instances$/,
    handler: async (req, _match, ctx) => {
      if (!ctx.instances) return REQUIRED()
      const onDisk = await ctx.instances.listOnDisk()
      const live = ctx.instances.liveIds()
      const current = getInstanceId(req)
      const out = onDisk.map(entry => ({
        id: entry.id,
        snapshotMtimeMs: entry.snapshotMtimeMs,
        snapshotSizeBytes: entry.snapshotSizeBytes,
        isLive: live.has(entry.id),
        isCurrent: entry.id === current,
      }))
      // Sort: current first, then live, then by mtime desc.
      out.sort((a, b) => {
        if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1
        if (a.isLive !== b.isLive) return a.isLive ? -1 : 1
        return b.snapshotMtimeMs - a.snapshotMtimeMs
      })
      return json({ instances: out, currentId: current })
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/instances$/,
    handler: async (_req, _match, ctx) => {
      if (!ctx.instances) return REQUIRED()
      const limit = checkRateLimit(ctx.remoteAddress)
      if (!limit.ok) {
        const retryS = Math.ceil(limit.retryAfterMs / 1000)
        return new Response(
          JSON.stringify({ error: `create rate limit — try again in ${retryS}s` }),
          {
            status: 429,
            headers: { 'Content-Type': 'application/json', 'Retry-After': String(retryS) },
          },
        )
      }
      const result = await ctx.instances.createNew()
      return json({ id: result.id }, 201)
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/instances\/([a-z0-9]{16})\/switch$/,
    handler: async (req, match, ctx) => {
      if (!ctx.instances) return REQUIRED()
      const targetId = match[1]!
      // Validate the target exists on disk (or is currently live). Refuses
      // arbitrary ids so a stray switch can't resurrect an empty instance
      // under a guessed id.
      const onDisk = await ctx.instances.listOnDisk()
      const live = ctx.instances.liveIds()
      if (!live.has(targetId) && !onDisk.some(e => e.id === targetId)) {
        return errorResponse(`instance "${targetId}" not found`, 404)
      }
      const setCookie = ctx.instances.buildSwitchCookie(targetId, req)
      return new Response(JSON.stringify({ ok: true, id: targetId }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Set-Cookie': setCookie },
      })
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/instances\/([a-z0-9]{16})$/,
    handler: async (req, match, ctx) => {
      if (!ctx.instances) return REQUIRED()
      const targetId = match[1]!
      const current = getInstanceId(req)
      if (current === targetId) {
        return errorResponse(
          'cannot delete the current instance — switch to another or use /api/system/reset',
          409,
        )
      }
      const result = await ctx.instances.delete(targetId)
      if (!result.ok) return errorResponse(result.reason, 400)
      return json({ deleted: true, id: targetId })
    },
  },
]
