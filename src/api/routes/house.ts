import { json, parseBody } from '../http-routes.ts'
import type { RouteEntry } from './types.ts'

export const houseRoutes: RouteEntry[] = [
  {
    method: 'GET',
    pattern: /^\/health$/,
    handler: (_req, _match, { system }) => {
      const health = system.ollama.getHealth()
      return json({
        status: 'ok',
        ollama: health.status !== 'down',
        ollamaStatus: health.status,
        ollamaLatencyMs: health.latencyMs,
        rooms: system.house.listAllRooms().length,
        agents: system.team.listAgents().length,
      })
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/tools$/,
    handler: (_req, _match, { system }) =>
      json(system.toolRegistry.list().map(t => ({ name: t.name, description: t.description }))),
  },
  {
    method: 'GET',
    pattern: /^\/api\/skills$/,
    handler: (_req, _match, { system }) =>
      json(system.skillStore.list().map(s => ({
        name: s.name, description: s.description,
        scope: s.scope.length > 0 ? s.scope : 'global',
        tools: s.tools,
      }))),
  },
  {
    method: 'GET',
    pattern: /^\/api\/models$/,
    handler: async (_req, _match, { system }) => {
      try {
        const [running, all] = await Promise.all([
          (system.ollama.runningModels?.() ?? Promise.resolve([] as string[])).catch(() => [] as string[]),
          system.ollama.models().catch(() => [] as string[]),
        ])
        const runningSet = new Set(running)
        const available = all.filter(m => !runningSet.has(m))
        return json({ running, available })
      } catch {
        return json({ running: [], available: [] })
      }
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/house\/prompts$/,
    handler: (_req, _match, { system }) =>
      json({
        housePrompt: system.house.getHousePrompt(),
        responseFormat: system.house.getResponseFormat(),
      }),
  },
  {
    method: 'PUT',
    pattern: /^\/api\/house\/prompts$/,
    handler: async (req, _match, { system }) => {
      const body = await parseBody(req)
      if (typeof body.housePrompt === 'string') system.house.setHousePrompt(body.housePrompt)
      if (typeof body.responseFormat === 'string') system.house.setResponseFormat(body.responseFormat)
      return json({
        housePrompt: system.house.getHousePrompt(),
        responseFormat: system.house.getResponseFormat(),
      })
    },
  },
]
