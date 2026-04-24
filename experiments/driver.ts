// ============================================================================
// Samsinn subprocess driver.
//
// Spawns one ephemeral samsinn process per run and opens an MCP stdio client
// against it. The MCP SDK's StdioClientTransport manages the spawn itself;
// we just hand it the command + env. Readiness is signaled by the MCP
// initialize handshake completing — no stderr-string matching needed.
//
// close() calls client.close(), which terminates the subprocess cleanly.
// On connect failure we capture stderr for diagnostics before rethrowing.
// ============================================================================

import { resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

// Samsinn entry point — relative to this file's location, then absolute.
const SAMSINN_ENTRY = resolve(import.meta.dir, '../src/main.ts')

const CONNECT_TIMEOUT_MS = 30_000

export interface SamsinnHandle {
  readonly client: Client
  readonly close: () => Promise<void>
}

// env() builds the subprocess environment. We inherit process.env so provider
// API keys flow through, then force SAMSINN_EPHEMERAL so every run starts
// clean. Returns a Record<string,string> (StdioClientTransport's signature
// rejects undefined values).
const buildEnv = (): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') out[k] = v
  }
  out.SAMSINN_EPHEMERAL = '1'
  return out
}

export const startSamsinn = async (): Promise<SamsinnHandle> => {
  const transport = new StdioClientTransport({
    command: 'bun',
    args: ['run', SAMSINN_ENTRY, '--headless'],
    env: buildEnv(),
    stderr: 'pipe',
  })

  // Collect stderr in case connect fails; surface it in the thrown error.
  const stderrChunks: string[] = []
  const stderrStream = transport.stderr
  if (stderrStream) {
    stderrStream.on('data', (chunk: Buffer | string) => {
      stderrChunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf-8'))
      // Keep memory bounded — on long-running subprocesses we only care about
      // the tail if connect fails.
      if (stderrChunks.length > 200) stderrChunks.splice(0, stderrChunks.length - 200)
    })
  }

  const client = new Client(
    { name: 'samsinn-experiment-runner', version: '0.1.0' },
    { capabilities: {} },
  )

  const connectPromise = client.connect(transport)
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Samsinn subprocess did not become ready within ${CONNECT_TIMEOUT_MS}ms`)), CONNECT_TIMEOUT_MS),
  )

  try {
    await Promise.race([connectPromise, timeoutPromise])
  } catch (err) {
    // Best-effort teardown on startup failure
    try { await transport.close() } catch { /* ignore */ }
    const tail = stderrChunks.join('').split('\n').slice(-20).join('\n')
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Samsinn startup failed: ${msg}\n--- samsinn stderr (tail) ---\n${tail}`)
  }

  return {
    client,
    close: async () => {
      try {
        await client.close()
      } catch {
        // Client already disconnected or subprocess already gone — nothing to do.
      }
    },
  }
}
