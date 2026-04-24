// ============================================================================
// Observational logging — types.
//
// Append-only event stream for research analysis (control-room studies,
// usage audits, debugging). Separate from the experiment runner, which
// ships its own per-run JSONs. Both use the same underlying data (Message
// telemetry, toolTrace) but target different consumers.
// ============================================================================

// === Event envelope ===

export interface LogActor {
  readonly kind: 'human' | 'ai' | 'system' | 'researcher' | 'unknown'
  readonly id?: string
  readonly name?: string
}

export interface LogEvent {
  readonly ts: number          // ms epoch
  readonly kind: string        // dotted: 'message.posted', 'agent.eval_event', 'room.created'
  readonly session: string     // opaque session id
  readonly actor?: LogActor
  readonly roomId?: string
  readonly payload: Record<string, unknown>
}

// === Sink contract ===

export interface LogSink {
  // Non-blocking enqueue. Sink owns its own backpressure policy (drop vs. block).
  readonly write: (event: LogEvent) => void
  // Best-effort drain + persist. Safe to call multiple times.
  readonly flush: () => Promise<void>
  // Flush + stop any background timers. Sink is unusable after close().
  readonly close: () => Promise<void>
  // Observable counters — used by GET /api/logging.
  readonly stats: () => LogSinkStats
}

export interface LogSinkStats {
  readonly eventCount: number      // events successfully written
  readonly droppedCount: number    // events dropped due to overflow or error
  readonly queuedCount: number     // events in-memory awaiting flush
  readonly currentFile: string | null
  readonly currentFileBytes: number
}

// === Runtime config ===

export interface LogConfig {
  readonly enabled: boolean
  readonly dir: string
  readonly sessionId: string
  // Glob-style kind filter. `*` matches everything. `message.*` matches
  // `message.posted`, `message.deleted`, etc. Comma-separated patterns = union.
  readonly kinds: ReadonlyArray<string>
}

export interface LogConfigState extends LogConfig {
  readonly currentFile: string | null
  readonly stats: LogSinkStats
}
