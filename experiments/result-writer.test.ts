// ============================================================================
// Result-writer tests — atomic writes + filename derivation.
// ============================================================================

import { describe, test, expect } from 'bun:test'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runResultFilename, writeRunResult, writeSummary } from './result-writer.ts'
import type { BatchSummary, RunResult } from './types.ts'

const makeResult = (variant: string, runIndex: number, status: RunResult['status'] = 'ok'): RunResult => ({
  experiment: 'test',
  variant,
  runIndex,
  status,
  startedAt: 1_000,
  finishedAt: 2_000,
  elapsedMs: 1_000,
})

describe('runResultFilename', () => {
  test('zero-pads runIndex to 3 digits', () => {
    expect(runResultFilename({ variant: 'baseline', runIndex: 0 })).toBe('baseline-run000.json')
    expect(runResultFilename({ variant: 'warm', runIndex: 12 })).toBe('warm-run012.json')
    expect(runResultFilename({ variant: 'a', runIndex: 999 })).toBe('a-run999.json')
  })
})

describe('writeRunResult + writeSummary', () => {
  test('writes per-run JSON and summary atomically', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'samsinn-rw-test-'))
    try {
      const path = await writeRunResult(dir, makeResult('baseline', 0))
      const onDisk = JSON.parse(await readFile(path, 'utf-8'))
      expect(onDisk.variant).toBe('baseline')
      expect(onDisk.status).toBe('ok')

      const summary: BatchSummary = {
        experiment: 'test',
        specDigest: 'abc123',
        startedAt: 1_000,
        finishedAt: 2_000,
        totalElapsedMs: 1_000,
        variantStats: { baseline: { succeeded: 1, failed: 0, timedOut: 0, capped: 0 } },
        runCount: 1,
        status: 'done',
      }
      const sumPath = await writeSummary(dir, summary)
      const sumOnDisk = JSON.parse(await readFile(sumPath, 'utf-8'))
      expect(sumOnDisk.status).toBe('done')
      expect(sumOnDisk.variantStats.baseline.succeeded).toBe(1)

      // Only the final file is present — no .tmp leftover
      const entries = await readdir(dir)
      expect(entries.filter(e => e.includes('.tmp.'))).toHaveLength(0)
    } finally {
      await rm(dir, { recursive: true })
    }
  })

  test('overwrites existing summary on rewrite', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'samsinn-rw-test-'))
    try {
      const base: BatchSummary = {
        experiment: 'test',
        specDigest: 'abc123',
        startedAt: 1_000,
        finishedAt: null,
        totalElapsedMs: 500,
        variantStats: { a: { succeeded: 0, failed: 0, timedOut: 0, capped: 0 } },
        runCount: 0,
        status: 'running',
      }
      await writeSummary(dir, base)
      await writeSummary(dir, { ...base, runCount: 5, status: 'done', finishedAt: 3_000 })

      const onDisk = JSON.parse(await readFile(join(dir, 'summary.json'), 'utf-8'))
      expect(onDisk.runCount).toBe(5)
      expect(onDisk.status).toBe('done')
    } finally {
      await rm(dir, { recursive: true })
    }
  })
})
