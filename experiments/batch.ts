// ============================================================================
// Batch loop — iterates variants × repeats sequentially.
//
// Two isolation modes:
//
//   'subprocess' (default) — one samsinn subprocess per run. Strongest
//     isolation; ~18s cold-start cost per run dominates wall time.
//
//   'reset' — one subprocess for the entire batch. Between runs, the
//     `reset_system` MCP tool clears rooms, agents, artifacts. Provider
//     router state (cooldowns, warmed model caches) persists by design.
//     Order-of-magnitude faster for large batches.
//
// Summary is rewritten after every run so partial batches produce useful
// data. SIGINT stops the batch after the in-flight run's write completes.
// ============================================================================

import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { BatchSummary, ExperimentSpec, RunResult, VariantStats } from './types.ts'
import { startSamsinn, type SamsinnHandle } from './driver.ts'
import { runOne } from './runner.ts'
import { ensureDir, writeRunResult, writeSummary } from './result-writer.ts'

export interface RunBatchOptions {
  readonly outputDir: string        // cwd-resolved path
  readonly specDigest: string
  // Fires after each run completes (success or failure). Used for CLI logs
  // and for tests observing progress.
  readonly onRunFinished?: (result: RunResult) => void
  // Fires whenever the batch spawns a new samsinn subprocess. In 'subprocess'
  // mode this fires once per run; in 'reset' mode it fires exactly once per
  // batch. Used by tests to assert the expected isolation behavior without
  // resorting to mocks.
  readonly onSubprocessStarted?: () => void
}

const emptyStats = (): VariantStats => ({ succeeded: 0, failed: 0, timedOut: 0 })

const tallyInto = (stats: VariantStats, result: RunResult): VariantStats => ({
  succeeded: stats.succeeded + (result.status === 'ok' ? 1 : 0),
  failed: stats.failed + (result.status === 'error' ? 1 : 0),
  timedOut: stats.timedOut + (result.status === 'timeout' ? 1 : 0),
})

const startupErrorResult = (
  spec: ExperimentSpec,
  variant: { name: string },
  runIndex: number,
  message: string,
): RunResult => {
  const now = Date.now()
  return {
    experiment: spec.experiment,
    variant: variant.name,
    runIndex,
    status: 'error',
    startedAt: now,
    finishedAt: now,
    elapsedMs: 0,
    error: message,
  }
}

// Reset-mode helper: calls reset_system on the persistent MCP client.
// Throws on MCP error so runBatch can switch to "mark remaining as error".
const resetSystem = async (client: Client): Promise<void> => {
  const result = await client.callTool({ name: 'reset_system', arguments: {} })
  const content = result.content as ReadonlyArray<{ type: string; text?: string }>
  if (!content || content.length === 0 || content[0]?.type !== 'text' || !content[0]?.text) {
    throw new Error('reset_system returned empty content')
  }
  const parsed = JSON.parse(content[0].text) as unknown
  if (parsed && typeof parsed === 'object' && 'error' in parsed && typeof (parsed as { error: unknown }).error === 'string') {
    throw new Error(`reset_system error: ${(parsed as { error: string }).error}`)
  }
}

export const runBatch = async (
  spec: ExperimentSpec,
  options: RunBatchOptions,
): Promise<BatchSummary> => {
  const startedAt = Date.now()
  await ensureDir(options.outputDir)

  const variantStats: Record<string, VariantStats> = {}
  for (const variant of spec.variants) variantStats[variant.name] = emptyStats()

  const snapshotSummary = (status: BatchSummary['status']): BatchSummary => ({
    experiment: spec.experiment,
    specDigest: options.specDigest,
    startedAt,
    finishedAt: status === 'done' ? Date.now() : null,
    totalElapsedMs: Date.now() - startedAt,
    variantStats: { ...variantStats },
    runCount: Object.values(variantStats).reduce((n, s) => n + s.succeeded + s.failed + s.timedOut, 0),
    status,
  })

  // Write initial summary so an interrupted batch still has a file.
  await writeSummary(options.outputDir, snapshotSummary('running'))

  const repeats = spec.repeats ?? 1
  const mode = spec.isolation ?? 'subprocess'
  let aborted = false
  const onSigint = () => { aborted = true }
  process.on('SIGINT', onSigint)

  const recordResult = async (variantName: string, result: RunResult): Promise<void> => {
    variantStats[variantName] = tallyInto(variantStats[variantName] ?? emptyStats(), result)
    await writeRunResult(options.outputDir, result)
    await writeSummary(options.outputDir, snapshotSummary('running'))
    options.onRunFinished?.(result)
  }

  try {
    if (mode === 'subprocess') {
      // Current behavior: one subprocess per run.
      for (const variant of spec.variants) {
        for (let runIndex = 0; runIndex < repeats; runIndex++) {
          if (aborted) break

          let handle: SamsinnHandle | null = null
          try {
            handle = await startSamsinn()
            options.onSubprocessStarted?.()
          } catch (err) {
            await recordResult(variant.name, startupErrorResult(
              spec, variant, runIndex,
              `samsinn subprocess startup failed: ${err instanceof Error ? err.message : String(err)}`,
            ))
            continue
          }

          try {
            const result = await runOne(spec, variant, runIndex, handle.client)
            await recordResult(variant.name, result)
          } finally {
            await handle.close()
          }
        }
        if (aborted) break
      }
    } else {
      // Reset mode: one subprocess, reset_system between runs.
      let handle: SamsinnHandle | null = null
      let resetFailure: string | null = null

      try {
        handle = await startSamsinn()
        options.onSubprocessStarted?.()
      } catch (err) {
        resetFailure = `samsinn subprocess startup failed: ${err instanceof Error ? err.message : String(err)}`
      }

      try {
        let firstRun = true
        outer: for (const variant of spec.variants) {
          for (let runIndex = 0; runIndex < repeats; runIndex++) {
            if (aborted) break outer

            // Reset state before every run except the first (subprocess starts clean).
            if (!firstRun && handle && !resetFailure) {
              try {
                await resetSystem(handle.client)
              } catch (err) {
                resetFailure = err instanceof Error ? err.message : String(err)
              }
            }
            firstRun = false

            if (resetFailure || !handle) {
              // Mark this run and fall through the rest of the batch.
              await recordResult(variant.name, startupErrorResult(
                spec, variant, runIndex,
                `batch aborted: ${resetFailure ?? 'no samsinn handle'}`,
              ))
              continue
            }

            const result = await runOne(spec, variant, runIndex, handle.client)
            await recordResult(variant.name, result)
          }
        }
      } finally {
        if (handle) await handle.close()
      }
    }
  } finally {
    process.off('SIGINT', onSigint)
  }

  const final = snapshotSummary('done')
  await writeSummary(options.outputDir, final)
  return final
}
