// ============================================================================
// samsinn — HTTP + WebSocket Server
//
// Thin glue layer. Delegates REST to http-routes.ts, WebSocket to ws-handler.ts.
// Handles Bun.serve setup, static file serving, and WebSocket upgrade.
// ============================================================================

import type { System } from '../main.ts'
import type { Message } from '../core/types/messaging.ts'
import type { WSOutbound } from '../core/types/ws-protocol.ts'
import { DEFAULTS } from '../core/types/constants.ts'
import { ensureUniqueName } from '../core/names.ts'
import { authEnabled, isValidSession, sessionFromRequest } from './auth.ts'
import { handleAPI } from './http-routes.ts'
import { createWSManager, handleWSMessage, type WSData } from './ws-handler.ts'
import { resolve, normalize } from 'node:path'

// === Server Config ===

interface ServerConfig {
  readonly port?: number
  readonly uiPath?: string
  readonly onAutoSave?: () => void
  /**
   * Invoked by the reset endpoint after the 10-second countdown ends.
   * Implementation must dispose the autoSaver, wipe state directories,
   * and process.exit(0). Returns { ok: false, reason } if the wipe
   * fails so the route can broadcast reset_failed and stay alive.
   */
  readonly onResetCommit?: () => Promise<{ ok: true } | { ok: false; reason: string }>
}

// === Static file serving (path traversal protected) ===

// Served in place of dist.css when the file is missing. A valid stylesheet
// that paints a loud red banner across the top of the page with instructions
// for the developer to recover. Simpler and more visible than a 404 +
// console warning that nobody reads. `bun run start` chains `build:css`
// before boot, so the user should only see this if they bypassed the
// chained script (e.g. running `bun run src/main.ts` directly) or manually
// deleted dist.css while the server is running.
const MISSING_DIST_BANNER = `/* samsinn: dist.css missing — run "bun install && bun run build:css" */
body::before {
  content: "\u26a0 samsinn: CSS build missing. Run: bun install && bun run build:css";
  position: fixed;
  inset: 0 0 auto 0;
  padding: 10px 16px;
  background: #dc2626;
  color: #ffffff;
  font: 600 13px/1.3 system-ui, -apple-system, sans-serif;
  z-index: 2147483647;
  text-align: center;
}
body { padding-top: 40px; }
`

const serveStatic = async (pathname: string, uiPath: string, transpiler: Bun.Transpiler): Promise<Response | null> => {
  if (pathname === '/' || pathname === '/index.html') {
    const file = Bun.file(`${uiPath}/index.html`)
    if (await file.exists()) {
      return new Response(file, { headers: { 'Content-Type': 'text/html' } })
    }
    return new Response('<h1>samsinn</h1><p>UI coming soon.</p>', {
      headers: { 'Content-Type': 'text/html' },
    })
  }

  if ((pathname.startsWith('/modules/') || pathname.startsWith('/lib/')) && pathname.endsWith('.ts')) {
    const filePath = normalize(`${uiPath}${pathname}`)
    if (!filePath.startsWith(uiPath)) {
      return new Response('Forbidden', { status: 403 })
    }
    const file = Bun.file(filePath)
    if (await file.exists()) {
      const source = await file.text()
      const js = transpiler.transformSync(source)
      return new Response(js, {
        headers: { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache' },
      })
    }
  }

  if (pathname === '/dist.css') {
    const file = Bun.file(`${uiPath}/dist.css`)
    if (await file.exists()) {
      return new Response(file, { headers: { 'Content-Type': 'text/css', 'Cache-Control': 'no-cache' } })
    }
    return new Response(MISSING_DIST_BANNER, {
      status: 200,
      headers: { 'Content-Type': 'text/css', 'Cache-Control': 'no-store' },
    })
  }

  return null
}

// === Server Factory ===

export const createServer = (system: System, config?: ServerConfig) => {
  const port = config?.port ?? DEFAULTS.port
  const uiPath = resolve(config?.uiPath ?? `${import.meta.dir}/../ui`)
  const transpiler = new Bun.Transpiler({ loader: 'ts' })

  const wsManager = createWSManager(system)

  const triggerAutoSave = config?.onAutoSave ?? (() => {})

  // Wraps a callback to trigger auto-save after it runs
  const withAutoSave = <T extends unknown[]>(fn: (...args: T) => void) =>
    (...args: T): void => { fn(...args); triggerAutoSave() }

  // Wire room event callbacks to WebSocket broadcast
  // All messages posted to any room are broadcast to all WS clients (UI always sees everything)
  system.setOnMessagePosted(withAutoSave((_roomId, message) => {
    wsManager.broadcast({ type: 'message', message })
  }))

  system.setOnTurnChanged((roomId, agentId, waitingForHuman) => {
    const room = system.house.getRoom(roomId)
    const agent = (typeof agentId === 'string') ? system.team.getAgent(agentId) : undefined
    wsManager.broadcast({
      type: 'turn_changed',
      roomName: room?.profile.name ?? roomId,
      agentName: agent?.name,
      waitingForHuman,
    })
  })

  system.setOnDeliveryModeChanged(withAutoSave((roomId, mode) => {
    const room = system.house.getRoom(roomId)
    wsManager.broadcast({
      type: 'delivery_mode_changed',
      roomName: room?.profile.name ?? roomId,
      mode,
      paused: room?.paused ?? false,
    })
  }))

  system.setOnMacroEvent(withAutoSave((roomId, event, detail) => {
    const room = system.house.getRoom(roomId)
    const roomName = room?.profile.name ?? roomId
    // TS can't narrow the generic event/detail pair at this call site — narrow manually.
    switch (event) {
      case 'started':
        wsManager.broadcast({ type: 'macro_event', roomName, event, detail: detail as { readonly macroId: string; readonly agentName: string } | undefined })
        break
      case 'step':
        wsManager.broadcast({ type: 'macro_event', roomName, event, detail: detail as { readonly macroId: string; readonly stepIndex: number; readonly agentName: string } | undefined })
        break
      case 'completed':
      case 'cancelled':
        wsManager.broadcast({ type: 'macro_event', roomName, event, detail: detail as { readonly macroId: string } | undefined })
        break
    }
  }))

  system.setOnArtifactChanged(withAutoSave((action, artifact) => {
    wsManager.broadcast({ type: 'artifact_changed', action, artifact })
  }))

  system.setOnModeAutoSwitched((roomId, toMode, reason) => {
    const room = system.house.getRoom(roomId)
    wsManager.broadcast({
      type: 'mode_auto_switched',
      roomName: room?.profile.name ?? roomId,
      toMode,
      reason,
    })
  })

  system.setOnMacroSelectionChanged(withAutoSave((roomId, macroArtifactId) => {
    const room = system.house.getRoom(roomId)
    wsManager.broadcast({
      type: 'macro_selection_changed',
      roomName: room?.profile.name ?? roomId,
      macroArtifactId,
    })
  }))

  // Bookmark mutations arrive via REST; the callback only needs to schedule
  // a snapshot save — there is no WS broadcast (single-user admin surface,
  // panel refetches on open).
  system.setOnBookmarksChanged(withAutoSave(() => {}))

  const server = Bun.serve<WSData>({
    port,

    async fetch(req, server) {
      const url = new URL(req.url)
      const pathname = url.pathname

      // WebSocket upgrade
      if (pathname === '/ws') {
        // Auth gate (deploy mode only). Cookie is set by /api/auth.
        if (authEnabled() && !isValidSession(sessionFromRequest(req))) {
          return new Response('Unauthorized', { status: 401 })
        }
        const name = url.searchParams.get('name')
        if (!name) return new Response('name query parameter required', { status: 400 })

        const sessionToken = url.searchParams.get('session') ?? crypto.randomUUID()

        // Session token reconnect (same browser tab, brief disconnect)
        if (wsManager.sessions.has(sessionToken)) {
          const upgraded = server.upgrade(req, { data: { sessionToken, reconnect: true } })
          return upgraded ? undefined : new Response('WebSocket upgrade failed', { status: 500 })
        }

        // Name-based reclaim: find inactive human agent with same name
        const existingAgent = system.team.listAgents().find(a =>
          a.kind === 'human' && a.name === name && a.inactive,
        )
        if (existingAgent) {
          // Find and reuse the old session for this agent
          let reclaimedToken: string | undefined
          for (const [token, session] of wsManager.sessions) {
            if (session.agent.id === existingAgent.id) {
              reclaimedToken = token
              break
            }
          }
          const useToken = reclaimedToken ?? sessionToken
          const upgraded = server.upgrade(req, { data: { sessionToken: useToken, reconnect: true, name } })
          return upgraded ? undefined : new Response('WebSocket upgrade failed', { status: 500 })
        }

        // New connection — create fresh agent (auto-rename on collision with active agents)
        const activeNames = system.team.listAgents().filter(a => !a.inactive).map(a => a.name)
        const assignedName = activeNames.includes(name) ? ensureUniqueName(name, activeNames) : name

        const upgraded = server.upgrade(req, { data: { sessionToken, name: assignedName } })
        return upgraded ? undefined : new Response('WebSocket upgrade failed', { status: 500 })
      }

      // API routes — resolve client IP for endpoints that gate source-serving.
      const remoteAddress = server.requestIP(req)?.address
      const apiResponse = await handleAPI(req, pathname, system, wsManager.broadcast, wsManager.subscribeAgentState, wsManager.unsubscribeAgentState, remoteAddress, config?.onResetCommit)
      if (apiResponse) return apiResponse

      // Static files
      const staticResponse = await serveStatic(pathname, uiPath, transpiler)
      if (staticResponse) return staticResponse

      return new Response('Not found', { status: 404 })
    },

    websocket: {
      async open(ws) {
        if (ws.data.reconnect) {
          const session = wsManager.sessions.get(ws.data.sessionToken)
          if (!session) return
          const newTransport = (msg: Message) => {
            ws.send(JSON.stringify({ type: 'message', message: msg } satisfies WSOutbound))
          }
          session.agent.setTransport(newTransport)
          // Reactivate if was inactive (name-based reclaim)
          if (session.agent.inactive) {
            session.agent.setInactive?.(false)
            wsManager.broadcast({ type: 'agent_joined', agent: {
              id: session.agent.id, name: session.agent.name,
              kind: session.agent.kind,
            }})
          }
          session.lastActivity = Date.now()
          wsManager.wsConnections.set(ws.data.sessionToken, ws)
          ws.send(JSON.stringify(wsManager.buildSnapshot(session.agent.id)))
          return
        }

        const agent = await system.spawnHumanAgent(
          { name: ws.data.name! },
          (msg: Message) => {
            ws.send(JSON.stringify({ type: 'message', message: msg } satisfies WSOutbound))
          },
        )

        const session = { agent, lastActivity: Date.now() }
        wsManager.sessions.set(ws.data.sessionToken, session)
        wsManager.wsConnections.set(ws.data.sessionToken, ws)

        ws.send(JSON.stringify(wsManager.buildSnapshot(agent.id, ws.data.sessionToken)))
      },

      async message(ws, raw) {
        const session = wsManager.sessions.get(ws.data.sessionToken)
        if (!session) return
        session.lastActivity = Date.now()
        await handleWSMessage(ws, session, typeof raw === 'string' ? raw : raw.toString(), system, wsManager)
      },

      close(ws) {
        const session = wsManager.sessions.get(ws.data.sessionToken)
        if (session?.agent.kind === 'human') {
          session.agent.setInactive?.(true)
          // Remove from all rooms to prevent phantom member accumulation
          for (const room of system.house.getRoomsForAgent(session.agent.id)) {
            room.removeMember(session.agent.id)
          }
          wsManager.broadcast({ type: 'agent_removed', agentName: session.agent.name })
        }
        wsManager.wsConnections.delete(ws.data.sessionToken)
        if (session) wsManager.unsubscribeOllamaMetrics(session.agent.id)
      },
    },
  })

  console.log(`Server listening on http://localhost:${port}`)
  console.log(`WebSocket: ws://localhost:${port}/ws?name=YourName`)
  console.log(`API: http://localhost:${port}/api/rooms`)

  return server
}
