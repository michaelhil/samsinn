// ============================================================================
// System-scoped MCP tools.
//
// Currently exposes only `reset_system`, which clears all rooms, agents, and
// artifacts from the running instance while leaving tool registry, skill
// store, provider router, and snapshot wiring untouched. Intended for the
// experiment runner's persistent-process mode — one subprocess serving many
// independent runs, with cheap state reset between them.
// ============================================================================

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { System } from '../../../main.ts'
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
}
