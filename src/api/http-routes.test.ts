// ============================================================================
// HTTP Routes — integration tests exercising handleAPI directly.
// ============================================================================

import { describe, test, expect, beforeEach } from 'bun:test'
import { handleAPI } from './http-routes.ts'
import { createHouse } from '../core/house.ts'
import { createTeam } from '../agents/team.ts'
import { createToolRegistry } from '../core/tool-registry.ts'
import type { DeliverFn, LLMProvider, WSOutbound } from '../core/types.ts'
import type { System } from '../main.ts'

// === Helpers ===

const noopDeliver: DeliverFn = () => {}
const noopBroadcast = (_msg: WSOutbound): void => {}
const noopSubscribe = (_id: string, _name: string): void => {}

const makeSystem = (): System => {
  const house = createHouse(noopDeliver)
  const team = createTeam()
  const toolRegistry = createToolRegistry()
  const ollama: LLMProvider = {
    chat: async () => { throw new Error('Not available in tests') },
    models: async () => [],
    runningModels: async () => [],
  }
  return {
    house, team, toolRegistry, ollama,
    routeMessage: () => [],
    removeAgent: (id: string) => team.removeAgent(id),
    spawnAIAgent: async () => { throw new Error('Not implemented') },
    spawnHumanAgent: async () => { throw new Error('Not implemented') },
    setOnMessagePosted: () => {},
    setOnTurnChanged: () => {},
    setOnDeliveryModeChanged: () => {},
    setOnFlowEvent: () => {},
    setOnTodoChanged: () => {},
  } as unknown as System
}

const req = (method: string, path: string, body?: unknown): Request => {
  const url = `http://localhost${path}`
  if (!body) return new Request(url, { method })
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const call = (system: System, r: Request, path: string) =>
  handleAPI(r, path, system, noopBroadcast, noopSubscribe)

// === Tests ===

describe('HTTP Routes', () => {
  let system: System

  beforeEach(() => {
    system = makeSystem()
    system.house.createRoom({ name: 'TestRoom', visibility: 'public', createdBy: 'system' })
  })

  // --- Health ---

  test('GET /health returns ok', async () => {
    const res = await call(system, req('GET', '/health'), '/health')
    expect(res?.status).toBe(200)
    const data = await res!.json()
    expect(data.status).toBe('ok')
    expect(typeof data.rooms).toBe('number')
  })

  // --- Rooms ---

  test('GET /api/rooms returns all rooms', async () => {
    const res = await call(system, req('GET', '/api/rooms'), '/api/rooms')
    expect(res?.status).toBe(200)
    const data = await res!.json()
    expect(Array.isArray(data)).toBe(true)
    expect(data).toHaveLength(1)
    expect(data[0].name).toBe('TestRoom')
  })

  test('POST /api/rooms creates room with 201', async () => {
    const res = await call(system, req('POST', '/api/rooms', { name: 'NewRoom', visibility: 'public' }), '/api/rooms')
    expect(res?.status).toBe(201)
    const data = await res!.json()
    expect(data.value.profile.name).toBe('NewRoom')
  })

  test('POST /api/rooms missing name returns 400', async () => {
    const res = await call(system, req('POST', '/api/rooms', { visibility: 'public' }), '/api/rooms')
    expect(res?.status).toBe(400)
  })

  test('GET /api/rooms/:name returns room', async () => {
    const res = await call(system, req('GET', '/api/rooms/TestRoom'), '/api/rooms/TestRoom')
    expect(res?.status).toBe(200)
    const data = await res!.json()
    expect(data.profile.name).toBe('TestRoom')
    expect(Array.isArray(data.messages)).toBe(true)
  })

  test('GET /api/rooms/:name unknown room returns 404', async () => {
    const res = await call(system, req('GET', '/api/rooms/Ghost'), '/api/rooms/Ghost')
    expect(res?.status).toBe(404)
  })

  test('DELETE /api/rooms/:name removes room', async () => {
    const res = await call(system, req('DELETE', '/api/rooms/TestRoom'), '/api/rooms/TestRoom')
    expect(res?.status).toBe(200)
    expect(system.house.getRoom('TestRoom')).toBeUndefined()
  })

  // --- Pause ---

  test('PUT /api/rooms/:name/pause with true pauses room', async () => {
    const res = await call(system, req('PUT', '/api/rooms/TestRoom/pause', { paused: true }), '/api/rooms/TestRoom/pause')
    expect(res?.status).toBe(200)
    const data = await res!.json()
    expect(data.paused).toBe(true)
  })

  test('PUT /api/rooms/:name/pause with false unpauses room', async () => {
    const room = system.house.getRoom('TestRoom')!
    room.setPaused(true)
    const res = await call(system, req('PUT', '/api/rooms/TestRoom/pause', { paused: false }), '/api/rooms/TestRoom/pause')
    expect(res?.status).toBe(200)
    expect((await res!.json()).paused).toBe(false)
  })

  test('PUT /api/rooms/:name/pause with string value returns 400', async () => {
    const res = await call(system, req('PUT', '/api/rooms/TestRoom/pause', { paused: 'yes' }), '/api/rooms/TestRoom/pause')
    expect(res?.status).toBe(400)
  })

  test('PUT /api/rooms/:name/pause missing paused field returns 400', async () => {
    const res = await call(system, req('PUT', '/api/rooms/TestRoom/pause', {}), '/api/rooms/TestRoom/pause')
    expect(res?.status).toBe(400)
  })

  // --- Mute ---

  test('PUT /api/rooms/:name/mute with non-boolean muted returns 400', async () => {
    const res = await call(system, req('PUT', '/api/rooms/TestRoom/mute', { agentName: 'Bot', muted: 'true' }), '/api/rooms/TestRoom/mute')
    expect(res?.status).toBe(400)
  })

  test('PUT /api/rooms/:name/mute with missing agentName returns 400', async () => {
    const res = await call(system, req('PUT', '/api/rooms/TestRoom/mute', { muted: true }), '/api/rooms/TestRoom/mute')
    expect(res?.status).toBe(400)
  })

  // --- Todos ---

  test('GET /api/rooms/:name/todos returns empty array initially', async () => {
    const res = await call(system, req('GET', '/api/rooms/TestRoom/todos'), '/api/rooms/TestRoom/todos')
    expect(res?.status).toBe(200)
    expect(await res!.json()).toHaveLength(0)
  })

  test('POST /api/rooms/:name/todos creates todo', async () => {
    const res = await call(system, req('POST', '/api/rooms/TestRoom/todos', { content: 'Write tests', createdBy: 'tester' }), '/api/rooms/TestRoom/todos')
    expect(res?.status).toBe(201)
    const data = await res!.json()
    expect(data.content).toBe('Write tests')
    expect(data.status).toBe('pending')
    expect(typeof data.id).toBe('string')
  })

  test('POST /api/rooms/:name/todos missing content returns 400', async () => {
    const res = await call(system, req('POST', '/api/rooms/TestRoom/todos', {}), '/api/rooms/TestRoom/todos')
    expect(res?.status).toBe(400)
  })

  test('PUT /api/rooms/:name/todos/:id updates todo status', async () => {
    const room = system.house.getRoom('TestRoom')!
    const todo = room.addTodo({ content: 'Original', createdBy: 'tester' })
    const path = `/api/rooms/TestRoom/todos/${todo.id}`
    const res = await call(system, req('PUT', path, { status: 'completed', result: 'Done' }), path)
    expect(res?.status).toBe(200)
    const data = await res!.json()
    expect(data.status).toBe('completed')
    expect(data.result).toBe('Done')
  })

  test('PUT /api/rooms/:name/todos/:id unknown id returns 404', async () => {
    const path = '/api/rooms/TestRoom/todos/no-such-id'
    const res = await call(system, req('PUT', path, { status: 'completed' }), path)
    expect(res?.status).toBe(404)
  })

  test('DELETE /api/rooms/:name/todos/:id removes todo', async () => {
    const room = system.house.getRoom('TestRoom')!
    const todo = room.addTodo({ content: 'To delete', createdBy: 'tester' })
    const path = `/api/rooms/TestRoom/todos/${todo.id}`
    const res = await call(system, req('DELETE', path), path)
    expect(res?.status).toBe(200)
    expect(room.getTodos()).toHaveLength(0)
  })

  test('DELETE /api/rooms/:name/todos/:id unknown id returns 404', async () => {
    const path = '/api/rooms/TestRoom/todos/no-such-id'
    const res = await call(system, req('DELETE', path), path)
    expect(res?.status).toBe(404)
  })

  // --- Flows ---

  test('POST /api/rooms/:name/flows creates flow', async () => {
    const res = await call(system, req('POST', '/api/rooms/TestRoom/flows', {
      name: 'MyFlow',
      steps: [{ agentId: 'a-1', agentName: 'Alpha' }],
      loop: false,
    }), '/api/rooms/TestRoom/flows')
    expect(res?.status).toBe(201)
    const data = await res!.json()
    expect(data.name).toBe('MyFlow')
    expect(data.steps).toHaveLength(1)
  })

  test('POST /api/rooms/:name/flows missing name returns 400', async () => {
    const res = await call(system, req('POST', '/api/rooms/TestRoom/flows', { steps: [] }), '/api/rooms/TestRoom/flows')
    expect(res?.status).toBe(400)
  })

  test('POST /api/rooms/:name/flows non-array steps returns 400', async () => {
    const res = await call(system, req('POST', '/api/rooms/TestRoom/flows', { name: 'Flow', steps: 'bad' }), '/api/rooms/TestRoom/flows')
    expect(res?.status).toBe(400)
  })

  test('GET /api/rooms/:name/flows lists flows', async () => {
    const room = system.house.getRoom('TestRoom')!
    room.addFlow({ name: 'F1', steps: [{ agentId: 'a-1', agentName: 'Alpha' }], loop: false })
    const res = await call(system, req('GET', '/api/rooms/TestRoom/flows'), '/api/rooms/TestRoom/flows')
    expect(res?.status).toBe(200)
    const data = await res!.json()
    expect(data).toHaveLength(1)
    expect(data[0].name).toBe('F1')
  })

  // --- Unknown route returns null ---

  test('unknown route returns null', async () => {
    const res = await call(system, req('GET', '/no-such-route'), '/no-such-route')
    expect(res).toBeNull()
  })
})
