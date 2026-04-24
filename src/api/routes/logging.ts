// ============================================================================
// GET /api/logging      → current config + stats
// PUT /api/logging      → reconfigure (enabled, dir, sessionId, kinds)
//
// Thin wrapper over system.logging. No auth — consistent with
// /api/providers; deployments needing access control handle it at the
// network layer.
// ============================================================================

import { json, errorResponse, parseBody } from './helpers.ts'
import type { RouteEntry } from './types.ts'
import type { LogConfig } from '../../logging/types.ts'

export const loggingRoutes: RouteEntry[] = [
  {
    method: 'GET',
    pattern: /^\/api\/logging$/,
    handler: (_req, _match, { system }) => json(system.logging.get()),
  },
  {
    method: 'PUT',
    pattern: /^\/api\/logging$/,
    handler: async (req, _match, { system }) => {
      const body = await parseBody(req)
      const partial: Partial<LogConfig> = {
        ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
        ...(typeof body.dir === 'string' ? { dir: body.dir } : {}),
        ...(typeof body.sessionId === 'string' ? { sessionId: body.sessionId } : {}),
        ...(Array.isArray(body.kinds) ? { kinds: body.kinds as string[] } : {}),
      }
      try {
        await system.logging.configure(partial)
        return json(system.logging.get())
      } catch (err) {
        return errorResponse(err instanceof Error ? err.message : 'Failed to configure logging')
      }
    },
  },
]
