// ============================================================================
// Result writer — atomic JSON writes for runs + incremental summary.
//
// Every write goes via temp+rename so a crash mid-write can't corrupt a file.
// Summary is rewritten after every run (F-M from stress-test) so partial
// batches produce a valid summary.json.
// ============================================================================

import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { BatchSummary, RunResult } from './types.ts'

export const ensureDir = async (path: string): Promise<void> => {
  await mkdir(path, { recursive: true })
}

const atomicWrite = async (path: string, data: string): Promise<void> => {
  await ensureDir(dirname(path))
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`
  await writeFile(tmp, data, 'utf-8')
  await rename(tmp, path)
}

export const runResultFilename = (result: Pick<RunResult, 'variant' | 'runIndex'>): string =>
  `${result.variant}-run${String(result.runIndex).padStart(3, '0')}.json`

export const writeRunResult = async (outputDir: string, result: RunResult): Promise<string> => {
  const path = join(outputDir, runResultFilename(result))
  await atomicWrite(path, JSON.stringify(result, null, 2))
  return path
}

export const writeSummary = async (outputDir: string, summary: BatchSummary): Promise<string> => {
  const path = join(outputDir, 'summary.json')
  await atomicWrite(path, JSON.stringify(summary, null, 2))
  return path
}
