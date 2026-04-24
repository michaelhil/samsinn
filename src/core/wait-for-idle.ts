// ============================================================================
// Room-idle detector — batch-runner completion signal.
//
// Returns when BOTH the room has been quiet for quietMs AND every in-room
// AI agent resolves whenIdle(), or timeoutMs elapses. Combining the two
// prevents a false-idle during long thinking or long tool loops, where the
// last posted message is old but an agent is still mid-generation.
//
// Pure helper — takes a Room and a function returning the AI agents currently
// in that room. Used by the `wait_for_idle` MCP tool; exported separately so
// unit tests can drive it directly.
// ============================================================================

import type { Room } from './types/room.ts'
import type { AIAgent } from './types/agent.ts'

export interface WaitForIdleOptions {
  readonly quietMs: number
  readonly timeoutMs: number
  // Supplier of AI agents currently in the room. Called each poll tick so
  // membership changes mid-wait are picked up.
  readonly inRoomAIAgents: () => ReadonlyArray<AIAgent>
  // Poll interval in ms. Default 500; overridable so tests can run faster.
  readonly pollMs?: number
  // Hard cap on room message count. When reached the call returns
  // immediately with `capped: true`. Prevents runaway agent-to-agent loops
  // burning tokens. Counts EVERY message in the room (seed + trigger +
  // responses) — see experiments/README for the counting semantic.
  readonly maxMessages?: number
}

export interface WaitForIdleResult {
  readonly idle: boolean
  readonly capped: boolean
  readonly messageCount: number
  readonly lastMessageAt: number | null
  readonly elapsedMs: number
}

const DEFAULT_POLL_MS = 500

export const waitForRoomIdle = async (
  room: Room,
  options: WaitForIdleOptions,
): Promise<WaitForIdleResult> => {
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS
  const start = Date.now()

  const lastMessageTs = (): number | undefined => {
    const recent = room.getRecent(1)
    return recent.length > 0 ? recent[0]!.timestamp : undefined
  }
  const messageCount = (): number => room.getRecent(Number.MAX_SAFE_INTEGER).length

  while (true) {
    const elapsedMs = Date.now() - start
    const lastTs = lastMessageTs()
    const quietFor = lastTs === undefined ? Infinity : Date.now() - lastTs
    const count = messageCount()

    // Cap check fires first — if we've already hit the cap we don't wait out
    // the quiet period; batch runner wants the fast termination.
    if (options.maxMessages !== undefined && count >= options.maxMessages) {
      return {
        idle: false,
        capped: true,
        messageCount: count,
        lastMessageAt: lastTs ?? null,
        elapsedMs,
      }
    }

    if (quietFor >= options.quietMs) {
      // Message-timestamp quiescence reached; now confirm no agent is mid-generation.
      await Promise.all(options.inRoomAIAgents().map(a => a.whenIdle()))
      // Re-check after whenIdle: an agent may have posted a fresh message while we waited.
      const lastTsAfter = lastMessageTs()
      const quietForAfter = lastTsAfter === undefined ? Infinity : Date.now() - lastTsAfter
      if (quietForAfter >= options.quietMs) {
        return {
          idle: true,
          capped: false,
          messageCount: messageCount(),
          lastMessageAt: lastTsAfter ?? null,
          elapsedMs: Date.now() - start,
        }
      }
    }

    if (elapsedMs >= options.timeoutMs) {
      return {
        idle: false,
        capped: false,
        messageCount: count,
        lastMessageAt: lastTs ?? null,
        elapsedMs,
      }
    }

    await new Promise(res => setTimeout(res, pollMs))
  }
}
