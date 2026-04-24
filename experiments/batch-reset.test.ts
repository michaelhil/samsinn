// ============================================================================
// Integration tests for reset-mode batches.
//
// These spawn real samsinn subprocesses — slow (~8s for 4 runs, ~30s+ for
// the 50-run soak). Gated behind SOAK=1 so `bun run test:unit` stays fast.
//
//   bun run test:unit                             # skips these
//   SOAK=1 bun test experiments/batch-reset.test.ts  # runs them
//
// Covers:
//   1. Reset mode spawns exactly one subprocess for N runs (vs. N for subprocess mode)
//   2. Agent/room names can be re-used across runs after reset
//   3. 50-run soak completes without degradation
// ============================================================================

import { describe, test, expect } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runBatch } from './batch.ts'
import type { ExperimentSpec } from './types.ts'

const SOAK_ENABLED = process.env.SOAK === '1'
const maybeTest = SOAK_ENABLED ? test : test.skip

const makeZeroAgentSpec = (
  overrides: Partial<ExperimentSpec> = {},
): ExperimentSpec => ({
  experiment: 'reset-integration',
  base: {
    room: { name: 'smoke' },
    trigger: { content: 'trigger', senderName: 'test' },
  },
  variants: [
    { name: 'a', agents: [] },
    { name: 'b', agents: [] },
  ],
  repeats: 2,
  wait: { quietMs: 200, timeoutMs: 3_000 },
  outputDir: '', // filled per-test
  isolation: 'reset',
  ...overrides,
})

describe('runBatch — reset mode (SOAK=1)', () => {
  maybeTest('spawns exactly one subprocess for a 4-run batch; agent/room name re-use works', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'samsinn-batch-reset-'))
    try {
      const spec = makeZeroAgentSpec({ outputDir: dir })
      let subprocessCount = 0
      let completedRuns = 0

      const summary = await runBatch(spec, {
        outputDir: dir,
        specDigest: 'testdigest',
        onSubprocessStarted: () => { subprocessCount++ },
        onRunFinished: () => { completedRuns++ },
      })

      expect(subprocessCount).toBe(1)
      expect(completedRuns).toBe(4)
      expect(summary.runCount).toBe(4)
      expect(summary.status).toBe('done')
      const allSucceeded = Object.values(summary.variantStats).every(s => s.succeeded > 0 && s.failed === 0 && s.timedOut === 0)
      expect(allSucceeded).toBe(true)

      // Verify each run file exists and has content
      const onDisk = JSON.parse(await readFile(join(dir, 'a-run000.json'), 'utf-8'))
      expect(onDisk.status).toBe('ok')
      expect(onDisk.export.messageCount).toBe(1)
    } finally {
      await rm(dir, { recursive: true })
    }
  }, 60_000)

  maybeTest('50-run soak — no degradation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'samsinn-batch-soak-'))
    try {
      const spec = makeZeroAgentSpec({
        outputDir: dir,
        variants: [{ name: 'soak', agents: [] }],
        repeats: 50,
      })
      let subprocessCount = 0
      const durations: number[] = []

      const summary = await runBatch(spec, {
        outputDir: dir,
        specDigest: 'soakdigest',
        onSubprocessStarted: () => { subprocessCount++ },
        onRunFinished: (r) => { durations.push(r.elapsedMs) },
      })

      expect(subprocessCount).toBe(1)
      expect(summary.runCount).toBe(50)
      expect(summary.variantStats.soak?.succeeded).toBe(50)
      expect(summary.variantStats.soak?.failed).toBe(0)

      // Sanity: late runs should not be dramatically slower than early ones
      // (catches timer leaks or growing state that bog the process down).
      const first10Avg = durations.slice(0, 10).reduce((a, b) => a + b, 0) / 10
      const last10Avg = durations.slice(-10).reduce((a, b) => a + b, 0) / 10
      expect(last10Avg).toBeLessThan(first10Avg * 3)  // generous threshold, catches 10x+ degradation
    } finally {
      await rm(dir, { recursive: true })
    }
  }, 300_000)
})
