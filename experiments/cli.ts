// ============================================================================
// Experiment runner CLI.
//
// Usage:  bun run experiments/cli.ts <spec.ts>
//
// Spec path and spec.outputDir are both resolved against process.cwd().
// Exit code: 0 if ≥1 run succeeded, non-zero otherwise. Spec validation
// errors exit non-zero before any subprocess is spawned.
// ============================================================================

import { resolve, isAbsolute } from 'node:path'
import { loadSpec } from './spec-loader.ts'
import { runBatch } from './batch.ts'

const usage = (): never => {
  console.error('Usage: bun run experiments/cli.ts <spec.ts>')
  process.exit(2)
}

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2)
  if (argv.length !== 1) usage()

  const rawPath = argv[0]!
  const specPath = isAbsolute(rawPath) ? rawPath : resolve(process.cwd(), rawPath)

  let loaded
  try {
    loaded = await loadSpec(specPath)
  } catch (err) {
    console.error(`Failed to load spec: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }

  const { spec, specDigest } = loaded
  const outputDir = isAbsolute(spec.outputDir)
    ? spec.outputDir
    : resolve(process.cwd(), spec.outputDir)

  console.error(`[runner] experiment=${spec.experiment} digest=${specDigest}`)
  console.error(`[runner] variants=${spec.variants.length} repeats=${spec.repeats ?? 1} output=${outputDir}`)

  const summary = await runBatch(spec, {
    outputDir,
    specDigest,
    onRunFinished: (r) => {
      const tag = r.status === 'ok' ? 'OK' : r.status === 'timeout' ? 'TIMEOUT' : 'FAIL'
      console.error(`[runner] ${tag} ${r.variant}-run${r.runIndex} (${r.elapsedMs}ms)${r.error ? ': ' + r.error : ''}`)
    },
  })

  const totalSucceeded = Object.values(summary.variantStats).reduce((n, s) => n + s.succeeded, 0)
  const totalFailed = Object.values(summary.variantStats).reduce((n, s) => n + s.failed + s.timedOut, 0)
  console.error(`[runner] done — succeeded=${totalSucceeded} failed=${totalFailed} elapsed=${summary.totalElapsedMs}ms`)

  process.exit(totalSucceeded > 0 ? 0 : 1)
}

main().catch(err => {
  console.error('[runner] fatal:', err)
  process.exit(1)
})
