// ============================================================================
// Batch loop — iterates variants × repeats sequentially.
//
// Each run spawns its own samsinn subprocess (ephemeral). Summary is rewritten
// after every run so partial batches produce useful data. SIGINT handling
// finishes the in-flight run's write before exiting — no partial rewrites
// mid-run.
// ============================================================================

import type { BatchSummary, ExperimentSpec, RunResult, VariantStats } from './types.ts'
import { startSamsinn } from './driver.ts'
import { runOne } from './runner.ts'
import { ensureDir, writeRunResult, writeSummary } from './result-writer.ts'

export interface RunBatchOptions {
  readonly outputDir: string        // cwd-resolved path
  readonly specDigest: string
  // Hook fired after each run completes (success or failure). Tests use this
  // to observe progress without subscribing to filesystem events.
  readonly onRunFinished?: (result: RunResult) => void
}

const emptyStats = (): VariantStats => ({ succeeded: 0, failed: 0, timedOut: 0 })

const tallyInto = (stats: VariantStats, result: RunResult): VariantStats => ({
  succeeded: stats.succeeded + (result.status === 'ok' ? 1 : 0),
  failed: stats.failed + (result.status === 'error' ? 1 : 0),
  timedOut: stats.timedOut + (result.status === 'timeout' ? 1 : 0),
})

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
  let aborted = false
  const onSigint = () => { aborted = true }
  process.on('SIGINT', onSigint)

  try {
    for (const variant of spec.variants) {
      for (let runIndex = 0; runIndex < repeats; runIndex++) {
        if (aborted) break

        let result: RunResult
        const handle = await (async () => {
          try {
            return await startSamsinn()
          } catch (err) {
            return { startupError: err instanceof Error ? err.message : String(err) }
          }
        })()

        if ('startupError' in handle) {
          const now = Date.now()
          result = {
            experiment: spec.experiment,
            variant: variant.name,
            runIndex,
            status: 'error',
            startedAt: now,
            finishedAt: now,
            elapsedMs: 0,
            error: `samsinn subprocess startup failed: ${handle.startupError}`,
          }
        } else {
          try {
            result = await runOne(spec, variant, runIndex, handle.client)
          } finally {
            await handle.close()
          }
        }

        variantStats[variant.name] = tallyInto(variantStats[variant.name] ?? emptyStats(), result)
        await writeRunResult(options.outputDir, result)
        await writeSummary(options.outputDir, snapshotSummary('running'))
        options.onRunFinished?.(result)
      }
      if (aborted) break
    }
  } finally {
    process.off('SIGINT', onSigint)
  }

  const final = snapshotSummary('done')
  await writeSummary(options.outputDir, final)
  return final
}
