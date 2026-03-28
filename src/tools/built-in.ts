// ============================================================================
// Built-in Tools — shipped with the system for validation and basic utility.
// ============================================================================

import type { AIAgent, House, RoomConfig, Team, Tool, ToolContext, TodoStatus } from '../core/types.ts'

export const createListRoomsTool = (house: House): Tool => ({
  name: 'list_rooms',
  description: 'Lists all rooms with their names.',
  parameters: {},
  execute: async () => ({
    success: true,
    data: house.listAllRooms().map(r => ({ name: r.name })),
  }),
})

export const createGetTimeTool = (): Tool => ({
  name: 'get_time',
  description: 'Returns the current date and time in ISO format.',
  parameters: {},
  execute: async () => ({
    success: true,
    data: { time: new Date().toISOString() },
  }),
})

export const createQueryAgentTool = (team: Team): Tool => ({
  name: 'query_agent',
  description: 'Ask another AI agent a question and get their response. Use this to consult with specialists.',
  parameters: {
    type: 'object',
    properties: {
      agent: { type: 'string', description: 'Name of the agent to query' },
      question: { type: 'string', description: 'The question to ask' },
    },
    required: ['agent', 'question'],
  },
  execute: async (params: Record<string, unknown>, context: ToolContext) => {
    const agentName = params.agent as string | undefined
    const question = params.question as string | undefined

    if (!agentName || !question) {
      return { success: false, error: 'Both "agent" and "question" are required' }
    }

    const target = team.getAgent(agentName)
    if (!target) return { success: false, error: `Agent "${agentName}" not found` }
    if (target.kind !== 'ai') return { success: false, error: `Agent "${agentName}" is not an AI agent` }
    if (target.id === context.callerId) return { success: false, error: 'Cannot query yourself' }

    try {
      const response = await (target as AIAgent).query(question, context.callerId, context.callerName)
      return { success: true, data: { agent: agentName, response } }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Query failed' }
    }
  },
})

const resolveRoom = (house: House, params: Record<string, unknown>, context: ToolContext) => {
  const name = params.roomName as string | undefined
  if (name) return house.getRoom(name)
  if (context.roomId) return house.getRoom(context.roomId)
  return undefined
}

export const createListTodosTool = (house: House): Tool => ({
  name: 'list_todos',
  description: 'Lists all todo items in the current room with their status, assignee, and results.',
  parameters: {
    type: 'object',
    properties: {
      roomName: { type: 'string', description: 'Name of the room (omit to use current room)' },
    },
    required: [],
  },
  execute: async (params: Record<string, unknown>, context: ToolContext) => {
    const room = resolveRoom(house, params, context)
    if (!room) return { success: false, error: 'Room not found — provide roomName or call from a room context' }
    const todos = room.getTodos()
    return {
      success: true,
      data: todos.map(t => ({
        id: t.id,
        content: t.content,
        status: t.status,
        assignee: t.assignee,
        result: t.result,
        dependencies: t.dependencies,
      })),
    }
  },
})

export const createAddTodoTool = (house: House): Tool => ({
  name: 'add_todo',
  description: 'Adds a new todo item to the current room.',
  parameters: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'What needs to be done' },
      assignee: { type: 'string', description: 'Agent name to assign to (optional)' },
      roomName: { type: 'string', description: 'Name of the room (omit to use current room)' },
    },
    required: ['content'],
  },
  execute: async (params: Record<string, unknown>, context: ToolContext) => {
    const room = resolveRoom(house, params, context)
    if (!room) return { success: false, error: 'Room not found — provide roomName or call from a room context' }
    const todo = room.addTodo({
      content: params.content as string,
      assignee: params.assignee as string | undefined,
      createdBy: context.callerName,
    })
    return { success: true, data: { id: todo.id, content: todo.content, status: todo.status } }
  },
})

export const createUpdateTodoTool = (house: House): Tool => ({
  name: 'update_todo',
  description: 'Updates a todo item status, assignee, or adds a result.',
  parameters: {
    type: 'object',
    properties: {
      todoId: { type: 'string', description: 'ID of the todo to update' },
      status: { type: 'string', description: 'New status: pending, in_progress, completed, blocked' },
      assignee: { type: 'string', description: 'Reassign to agent name' },
      result: { type: 'string', description: 'Result/outcome (typically set when completing)' },
      roomName: { type: 'string', description: 'Name of the room (omit to use current room)' },
    },
    required: ['todoId'],
  },
  execute: async (params: Record<string, unknown>, context: ToolContext) => {
    const room = resolveRoom(house, params, context)
    if (!room) return { success: false, error: 'Room not found — provide roomName or call from a room context' }
    const updates: { status?: TodoStatus; assignee?: string; result?: string } = {}
    if (params.status) updates.status = params.status as TodoStatus
    if (params.assignee) updates.assignee = params.assignee as string
    if (params.result) updates.result = params.result as string
    const updated = room.updateTodo(params.todoId as string, updates)
    if (!updated) return { success: false, error: `Todo "${params.todoId}" not found` }
    return { success: true, data: { id: updated.id, content: updated.content, status: updated.status, result: updated.result } }
  },
})

// --- Room management tools ---

type AddToRoomFn = (agentId: string, roomId: string, invitedBy?: string) => Promise<void>
type RemoveFromRoomFn = (agentId: string, roomId: string, removedBy?: string) => void
type RemoveRoomFn = (roomId: string) => boolean

export const createCreateRoomTool = (house: House, addAgentToRoom: AddToRoomFn): Tool => ({
  name: 'create_room',
  description: 'Creates a new room and adds the calling agent to it.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Name for the new room' },
      roomPrompt: { type: 'string', description: 'Optional system prompt for the room' },
    },
    required: ['name'],
  },
  execute: async (params: Record<string, unknown>, context: ToolContext) => {
    const name = params.name as string | undefined
    if (!name) return { success: false, error: 'name is required' }
    try {
      const config: RoomConfig = {
        name,
        roomPrompt: params.roomPrompt as string | undefined,
        createdBy: context.callerId,
      }
      const result = house.createRoomSafe(config)
      await addAgentToRoom(context.callerId, result.value.profile.id)
      return {
        success: true,
        data: { name: result.assignedName, id: result.value.profile.id, renamed: result.assignedName !== result.requestedName },
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Failed to create room' }
    }
  },
})

export const createDeleteRoomTool = (removeRoom: RemoveRoomFn, house: House): Tool => ({
  name: 'delete_room',
  description: 'Deletes a room by name.',
  parameters: {
    type: 'object',
    properties: {
      roomName: { type: 'string', description: 'Name of the room to delete' },
    },
    required: ['roomName'],
  },
  execute: async (params: Record<string, unknown>) => {
    const roomName = params.roomName as string | undefined
    if (!roomName) return { success: false, error: 'roomName is required' }
    const room = house.getRoom(roomName)
    if (!room) return { success: false, error: `Room "${roomName}" not found` }
    removeRoom(room.profile.id)
    return { success: true, data: { removed: roomName } }
  },
})

export const createAddToRoomTool = (team: Team, house: House, addAgentToRoom: AddToRoomFn): Tool => ({
  name: 'add_to_room',
  description: 'Adds an agent (self or another) to a room.',
  parameters: {
    type: 'object',
    properties: {
      agentName: { type: 'string', description: 'Name of the agent to add (use own name to join)' },
      roomName: { type: 'string', description: 'Name of the room to join' },
    },
    required: ['agentName', 'roomName'],
  },
  execute: async (params: Record<string, unknown>, context: ToolContext) => {
    const agentName = params.agentName as string | undefined
    const roomName = params.roomName as string | undefined
    if (!agentName || !roomName) return { success: false, error: 'agentName and roomName are required' }
    const agent = team.getAgent(agentName)
    if (!agent) return { success: false, error: `Agent "${agentName}" not found` }
    const room = house.getRoom(roomName)
    if (!room) return { success: false, error: `Room "${roomName}" not found` }
    const isSelf = agent.id === context.callerId
    await addAgentToRoom(agent.id, room.profile.id, isSelf ? undefined : context.callerName)
    return { success: true, data: { agentName: agent.name, roomName: room.profile.name } }
  },
})

export const createRemoveFromRoomTool = (team: Team, house: House, removeAgentFromRoom: RemoveFromRoomFn): Tool => ({
  name: 'remove_from_room',
  description: 'Removes an agent (self or another) from a room.',
  parameters: {
    type: 'object',
    properties: {
      agentName: { type: 'string', description: 'Name of the agent to remove (use own name to leave)' },
      roomName: { type: 'string', description: 'Name of the room' },
    },
    required: ['agentName', 'roomName'],
  },
  execute: async (params: Record<string, unknown>, context: ToolContext) => {
    const agentName = params.agentName as string | undefined
    const roomName = params.roomName as string | undefined
    if (!agentName || !roomName) return { success: false, error: 'agentName and roomName are required' }
    const agent = team.getAgent(agentName)
    if (!agent) return { success: false, error: `Agent "${agentName}" not found` }
    const room = house.getRoom(roomName)
    if (!room) return { success: false, error: `Room "${roomName}" not found` }
    const isSelf = agent.id === context.callerId
    removeAgentFromRoom(agent.id, room.profile.id, isSelf ? undefined : context.callerName)
    return { success: true, data: { agentName: agent.name, roomName: room.profile.name } }
  },
})
