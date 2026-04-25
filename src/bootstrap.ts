// ============================================================================
// Bootstrap — Startup logic for direct execution.
//
// Performs all initialization: env config, snapshot restore, tool loading,
// MCP client registration, signal handlers, then starts server or MCP stdio.
//
// Imported and called only when main.ts is run directly.
// ============================================================================

import { createSystem } from './main.ts'
import { createSharedRuntime } from './core/shared-runtime.ts'
import { DEFAULTS } from './core/types/constants.ts'
import { registerAllMCPServers } from './integrations/mcp/client.ts'
import { existsSync } from 'node:fs'
import { loadSnapshot, restoreFromSnapshot, createAutoSaver } from './core/snapshot.ts'
import { resolve } from 'node:path'
import { loadExternalTools } from './tools/loader.ts'
import { loadSkills } from './skills/loader.ts'
import { loadAllPacks } from './packs/loader.ts'
import { asAIAgent } from './agents/shared.ts'
import { parseProviderConfig, summariseProviderConfig } from './llm/providers-config.ts'
import { buildProvidersFromConfig, warmProviderModels } from './llm/providers-setup.ts'
import { loadProviderStore, mergeWithEnv } from './llm/providers-store.ts'
import { parseLogConfigFromEnv } from './logging/config.ts'
import { sharedPaths } from './core/paths.ts'

const DRAIN_TIMEOUT_MS = 5_000

export const bootstrap = async (): Promise<void> => {
  const headless = process.argv.includes('--headless')
  // SAMSINN_EPHEMERAL=1 → batch/experiment mode: no snapshot load, no auto-save,
  // no shutdown flush. Every run starts clean and leaves no trace on disk.
  const ephemeral = process.env.SAMSINN_EPHEMERAL === '1'

  // In headless mode, redirect console.log to stderr (stdout is reserved for MCP protocol)
  if (headless) {
    const stderrLog = (...args: unknown[]) => console.error(...args)
    console.log = stderrLog
    console.info = stderrLog
  }

  // Load stored provider config (file-backed, user-editable via UI).
  const providersStorePath = sharedPaths.providers()
  const { data: storeData, warnings: storeWarnings } = await loadProviderStore(providersStorePath)
  for (const w of storeWarnings) console.warn(`[providers.json] ${w}`)
  const fileStore = mergeWithEnv(storeData)

  const providerConfig = parseProviderConfig({ fileStore })
  const providerSetup = buildProvidersFromConfig(providerConfig)
  // Build the shared runtime once. Phase D will pass this to many
  // createSystem calls (one per cookie-bound instance). Today bootstrap
  // creates a single instance from it — but the wiring is right.
  const shared = createSharedRuntime({ providerConfig, providerSetup })
  const system = createSystem({ shared })

  const pkg = await Bun.file(`${import.meta.dir}/../package.json`).json() as { version: string }
  console.log(`Samsinn v${pkg.version}${headless ? ' (headless)' : ''}`)
  if (ephemeral) console.log('[bootstrap] ephemeral mode — snapshot disabled')
  console.log(summariseProviderConfig(providerConfig))

  // Observational logging — env vars seed boot config. When enabled=false
  // (default), the sink isn't opened but dir/sessionId/kinds are still
  // stored so a later PUT /api/logging {enabled:true} respects the
  // deployment's SAMSINN_LOG_DIR etc. Runtime reconfigure via
  // PUT /api/logging or configure_logging MCP tool.
  const bootLogConfig = parseLogConfigFromEnv()
  try {
    await system.logging.configure(bootLogConfig)
    if (bootLogConfig.enabled) {
      const state = system.logging.get()
      console.log(`[logging] enabled — session=${state.sessionId} dir=${state.dir}`)
    }
  } catch (err) {
    console.error(`[logging] failed to apply boot config: ${err instanceof Error ? err.message : String(err)}`)
  }

  // Load filesystem tools and skills before snapshot restore so restored agents get them
  await loadExternalTools(system.toolRegistry)
  await loadSkills(resolve(process.cwd(), 'skills'), system.skillStore, system.toolRegistry)
  await loadSkills(system.skillsDir, system.skillStore, system.toolRegistry)
  await loadAllPacks(system.packsDir, system.toolRegistry, system.skillStore)

  // Restore from snapshot if available (skipped entirely in ephemeral mode).
  const snapshotPath = resolve(import.meta.dir, '../data/snapshot.json')
  const snapshot = ephemeral ? null : await loadSnapshot(snapshotPath)
  if (snapshot) {
    await restoreFromSnapshot(system, snapshot)
    console.log(`Restored from snapshot: ${snapshot.rooms.length} rooms, ${snapshot.agents.length} agents`)
  } else if (!ephemeral) {
    console.log('Fresh start — no snapshot found.')
  }

  // Ensure at least one room always exists
  if (system.house.listAllRooms().length === 0) {
    system.house.createRoomSafe({ name: 'general', createdBy: 'system' })
    console.log('Created default room: general')
  }

  // Register MCP client tools from config (external tool servers)
  const mcpConfigPath = `${import.meta.dir}/../mcp-servers.json`
  const mcpResult = existsSync(mcpConfigPath)
    ? await registerAllMCPServers(system.toolRegistry, await Bun.file(mcpConfigPath).json())
    : { totalTools: 0, disconnect: async (): Promise<void> => {} }

  console.log(`Tools: ${system.toolRegistry.list().map(t => t.name).join(', ')}`)

  // Warm availableModels cache across all providers before the first chat
  // call, so the router's model-filter logic doesn't optimistically hit
  // providers that don't serve the requested model.
  const warmResults = await warmProviderModels(providerSetup.gateways)
  for (const [name, result] of Object.entries(warmResults)) {
    if (result.status === 'ok') {
      console.log(`  ${name}: ${result.count} models available`)
    } else {
      console.warn(`  ${name}: warm-up failed — ${result.message}`)
    }
  }

  // Auto-save: debounced save on state changes
  const autoSaver = createAutoSaver(system, snapshotPath)

  // Graceful shutdown: drain in-flight evaluations in parallel, then flush snapshot, then disconnect MCP
  const shutdown = async () => {
    console.log('Shutting down, saving snapshot...')
    const timeout = new Promise<void>(res => setTimeout(res, DRAIN_TIMEOUT_MS))
    const aiAgents = system.team.listAgents().flatMap(a => { const ai = asAIAgent(a); return ai ? [ai] : [] })
    await Promise.all(aiAgents.map(a => Promise.race([a.whenIdle(), timeout])))
    if (!ephemeral) {
      try {
        await autoSaver.flush()
        console.log('Snapshot saved.')
      } catch (err) {
        console.error('Failed to save snapshot on shutdown:', err)
      }
    }
    // Flush + close the logging sink (emits session.end). Never throws.
    try {
      await system.logging.configure({ enabled: false })
    } catch (err) {
      console.error('Failed to close log sink:', err)
    }
    await mcpResult.disconnect()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  if (headless) {
    // Headless mode: MCP server on stdio, no HTTP server
    const { createMCPServer, wireEventNotifications, startMCPServerStdio } = await import('./integrations/mcp/server.ts')
    const mcpServer = createMCPServer(system, pkg.version)
    wireEventNotifications(system, mcpServer)
    await startMCPServerStdio(mcpServer)
    console.log('MCP server running on stdio')
  } else {
    // Full mode: HTTP + WebSocket server with browser UI.
    // In ephemeral mode, pass undefined for onAutoSave so per-change writes
    // don't hit disk either.

    // Reset commit: dispose autoSaver, drain agents, wipe state dirs, exit.
    // We bypass the SIGTERM shutdown handler (which would re-flush a fresh
    // snapshot via autoSaver and undo the wipe). systemd respawns the
    // server within ~5s and clients reconnect to a fresh state.
    const onResetCommit = async (): Promise<{ ok: true } | { ok: false; reason: string }> => {
      try {
        autoSaver.dispose()
        // Drain in-flight evals (best-effort, same timeout as shutdown).
        const timeout = new Promise<void>(res => setTimeout(res, DRAIN_TIMEOUT_MS))
        const aiAgents = system.team.listAgents().flatMap(a => { const ai = asAIAgent(a); return ai ? [ai] : [] })
        await Promise.all(aiAgents.map(a => Promise.race([a.whenIdle(), timeout])))

        const targets = [
          snapshotPath,
          // Memory dir: still under shared root for now. Phase H/I move to
          // per-instance, at which point this path becomes per-cookie.
          sharedPaths.memoryLegacy(),
          sharedPaths.packs(),
          sharedPaths.skills(),
          sharedPaths.tools(),
        ]
        const { rm } = await import('node:fs/promises')
        for (const t of targets) {
          await rm(t, { recursive: true, force: true })
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        console.error('Reset commit failed:', reason)
        return { ok: false, reason }
      }
      // Exit on next tick so the route can flush its 200 response first.
      setTimeout(() => process.exit(0), 100)
      return { ok: true }
    }

    const { createServer } = await import('./api/server.ts')
    createServer(system, {
      port: parseInt(process.env.PORT ?? String(DEFAULTS.port), 10),
      ...(ephemeral ? {} : { autoSaver }),
      onResetCommit,
    })
  }
}
