import { describe, expect, test } from 'bun:test'
import { toUIMessage, toUIRoomProfile, toAgentEntry, toUIArtifact } from './mappers.ts'
import type { Message, AgentProfile, RoomProfile as ServerRoomProfile } from '../../../core/types/messaging.ts'
import type { Artifact } from '../../../core/types/artifact.ts'

// These mappers are the only translation layer between the WS wire format
// (server types) and the UI's view types. If they silently drop or mistype
// a field, the DOM receives bad data — usually manifesting as a blank or
// broken row. Tests pin the shape + telemetry forwarding.

describe('toUIMessage', () => {
  const base: Message = {
    id: 'm1',
    senderId: 'agent-1',
    content: 'hello',
    timestamp: 1234,
    type: 'chat',
    roomId: 'room-1',
    generationMs: 500,
  }

  test('passes through the core fields', () => {
    const ui = toUIMessage(base)
    expect(ui.id).toBe('m1')
    expect(ui.senderId).toBe('agent-1')
    expect(ui.content).toBe('hello')
    expect(ui.timestamp).toBe(1234)
    expect(ui.type).toBe('chat')
    expect(ui.roomId).toBe('room-1')
    expect(ui.generationMs).toBe(500)
  })

  test('forwards telemetry number fields when present', () => {
    const ui = toUIMessage({
      ...base,
      promptTokens: 100,
      completionTokens: 50,
      contextMax: 8000,
    })
    expect(ui.promptTokens).toBe(100)
    expect(ui.completionTokens).toBe(50)
    expect(ui.contextMax).toBe(8000)
  })

  test('forwards provider + model strings when present', () => {
    const ui = toUIMessage({
      ...base,
      provider: 'ollama',
      model: 'llama3.2',
    })
    expect(ui.provider).toBe('ollama')
    expect(ui.model).toBe('llama3.2')
  })

  test('omits telemetry keys entirely when absent', () => {
    const ui = toUIMessage(base)
    expect('promptTokens' in ui).toBe(false)
    expect('model' in ui).toBe(false)
    expect('provider' in ui).toBe(false)
  })
})

describe('toUIRoomProfile', () => {
  test('narrows server profile to id + name only', () => {
    const server: ServerRoomProfile = {
      id: 'room-1',
      name: 'general',
      members: ['a', 'b'],
      deliveryMode: 'broadcast',
    } as ServerRoomProfile
    const ui = toUIRoomProfile(server)
    expect(ui).toEqual({ id: 'room-1', name: 'general' })
    // Server fields that don't belong to the UI view type must not leak:
    expect('members' in ui).toBe(false)
    expect('deliveryMode' in ui).toBe(false)
  })
})

describe('toAgentEntry', () => {
  test('always initializes state to idle', () => {
    const server: AgentProfile = {
      id: 'agent-1',
      name: 'Alice',
      kind: 'ai',
      model: 'gpt-4',
    } as AgentProfile
    const ui = toAgentEntry(server)
    expect(ui).toEqual({
      id: 'agent-1',
      name: 'Alice',
      kind: 'ai',
      model: 'gpt-4',
      state: 'idle',
    })
  })

  test('human kind survives the round-trip', () => {
    const ui = toAgentEntry({ id: 'h1', name: 'Bob', kind: 'human' } as AgentProfile)
    expect(ui.kind).toBe('human')
    expect(ui.state).toBe('idle')
  })
})

describe('toUIArtifact', () => {
  test('passes through every artifact field verbatim', () => {
    const server: Artifact = {
      id: 'art-1',
      type: 'task_list',
      title: 'My Tasks',
      description: 'testing',
      body: { tasks: [] },
      scope: ['room-1'],
      createdBy: 'agent-1',
      createdAt: 100,
      updatedAt: 200,
      resolution: 'completed',
      resolvedAt: 300,
    } as Artifact
    const ui = toUIArtifact(server)
    expect(ui.id).toBe('art-1')
    expect(ui.type).toBe('task_list')
    expect(ui.title).toBe('My Tasks')
    expect(ui.description).toBe('testing')
    expect(ui.body).toEqual({ tasks: [] })
    expect(ui.scope).toEqual(['room-1'])
    expect(ui.createdBy).toBe('agent-1')
    expect(ui.createdAt).toBe(100)
    expect(ui.updatedAt).toBe(200)
    expect(ui.resolution).toBe('completed')
    expect(ui.resolvedAt).toBe(300)
  })
})
