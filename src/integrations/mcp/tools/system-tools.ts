// ============================================================================
// System-scoped MCP tools.
//
// Currently exposes only `reset_system`, which clears all rooms, agents, and
// artifacts from the running instance while leaving tool registry, skill
// store, provider router, and snapshot wiring untouched. Intended for the
// experiment runner's persistent-process mode — one subprocess serving many
// independent runs, with cheap state reset between them.
// ============================================================================

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { System } from '../../../main.ts'
import type { LogConfig } from '../../../logging/types.ts'
import { textResult, errorResult } from './helpers.ts'

export const registerSystemTools = (mcpServer: McpServer, system: System): void => {
  mcpServer.tool(
    'reset_system',
    'Clear all rooms, agents, and artifacts from the running samsinn instance. Preserves tool registry, skills, provider router state, and stored keys. Intended for experiment runners in persistent-process mode. Returns {reset: true, removed: {rooms, agents, artifacts}}.',
    {},
    async () => {
      try {
        const removed = await system.resetState()
        return textResult({ reset: true, removed })
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'reset_system failed')
      }
    },
  )

  mcpServer.tool(
    'configure_logging',
    'Turn observational logging on/off, change log directory, start a new session, or adjust kind filter — without restarting samsinn. Omitted fields keep current values. Returns the resulting config + stats.',
    {
      enabled: z.boolean().optional().describe('true to enable logging, false to disable (drains + closes current sink)'),
      dir: z.string().optional().describe('Output directory for JSONL files. Creates if missing.'),
      sessionId: z.string().optional().describe('Session identifier used as filename. Filesystem-safe: [a-zA-Z0-9._-]. Changing this starts a new file with session.start.'),
      kinds: z.array(z.string()).optional().describe('Glob patterns for kinds to include (e.g. ["message.*","agent.*"]). Default ["*"].'),
    },
    async (args) => {
      try {
        const partial: Partial<LogConfig> = {
          ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
          ...(args.dir !== undefined ? { dir: args.dir } : {}),
          ...(args.sessionId !== undefined ? { sessionId: args.sessionId } : {}),
          ...(args.kinds !== undefined ? { kinds: args.kinds } : {}),
        }
        await system.logging.configure(partial)
        return textResult(system.logging.get())
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'configure_logging failed')
      }
    },
  )

  mcpServer.tool(
    'get_logging',
    'Return current logging config + stats (eventCount, droppedCount, currentFile).',
    {},
    async () => {
      try {
        return textResult(system.logging.get())
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'get_logging failed')
      }
    },
  )
}
