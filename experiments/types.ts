// ============================================================================
// Experiment runner types.
//
// Shared vocabulary for specs, runs, and results. Lives outside samsinn core.
// Intentionally decoupled from AIAgentConfig so spec authors see a minimal
// surface — only fields meaningful for variation experiments.
// ============================================================================

import type { Message } from '../src/core/types/messaging.ts'

// --- Inputs ---

export interface AgentSpec {
  readonly name: string
  readonly model: string
  readonly persona: string
  readonly temperature?: number
  readonly seed?: number
  readonly tools?: ReadonlyArray<string>
}

export interface RoomSpec {
  readonly name: string
  readonly roomPrompt?: string
}

export interface TriggerSpec {
  readonly content: string
  readonly senderName?: string
}

export interface WaitConfig {
  readonly quietMs: number
  readonly timeoutMs: number
}

export interface Variant {
  // Must match /^[a-zA-Z0-9_-]+$/ — used as part of result filename.
  readonly name: string
  readonly agents: ReadonlyArray<AgentSpec>
}

export type IsolationMode = 'subprocess' | 'reset'

export interface ExperimentSpec {
  readonly experiment: string
  readonly base: {
    readonly room: RoomSpec
    readonly trigger: TriggerSpec
    // Common agents added to every variant (in addition to variant.agents).
    readonly agents?: ReadonlyArray<AgentSpec>
  }
  readonly variants: ReadonlyArray<Variant>
  readonly repeats?: number
  readonly wait: WaitConfig
  // Resolved against process.cwd() by the CLI before any filesystem work.
  readonly outputDir: string
  // How runs are isolated from each other.
  //   'subprocess' (default) — one samsinn subprocess per run. Bulletproof,
  //     ~18s cold start cost per run.
  //   'reset' — one subprocess for the whole batch; `reset_system` MCP tool
  //     clears state between runs. Order-of-magnitude faster for large
  //     batches, but provider-router state (cooldowns, warmed model caches)
  //     persists across runs by design.
  readonly isolation?: IsolationMode
}

// --- Outputs ---

export type RunStatus = 'ok' | 'error' | 'timeout'

// The shape mirrors what `export_room` returns plus run metadata. Kept as
// Record<string, unknown> for the export body so type drift on samsinn's
// Message is transparent to the runner — the runner does not introspect the
// export, only persists it.
export interface RunResult {
  readonly experiment: string
  readonly variant: string
  readonly runIndex: number
  readonly status: RunStatus
  readonly startedAt: number
  readonly finishedAt: number
  readonly elapsedMs: number
  readonly export?: {
    readonly roomId: string
    readonly roomName: string
    readonly exportedAt: number
    readonly messageCount: number
    readonly messages: ReadonlyArray<Message>
  }
  readonly error?: string
  readonly timedOut?: boolean
}

export interface VariantStats {
  readonly succeeded: number
  readonly failed: number
  readonly timedOut: number
}

export interface BatchSummary {
  readonly experiment: string
  readonly specDigest: string
  readonly startedAt: number
  readonly finishedAt: number | null
  readonly totalElapsedMs: number
  readonly variantStats: Readonly<Record<string, VariantStats>>
  readonly runCount: number
  readonly status: 'running' | 'done'
}
