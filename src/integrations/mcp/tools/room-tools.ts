import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { System } from '../../../main.ts'
import type { ToolContext } from '../../../core/types/tool.ts'
import {
  createListRoomsTool,
  createCreateRoomTool,
  createDeleteRoomTool,
  createSetRoomPromptTool,
  createPauseRoomTool,
  createSetDeliveryModeTool,
  createAddToRoomTool,
  createRemoveFromRoomTool,
} from '../../../tools/built-in/room-tools.ts'
import { textResult, errorResult, resolveRoom } from './helpers.ts'

const dummyContext: ToolContext = {
  callerId: 'mcp-client',
  callerName: 'mcp-client',
}

export const registerRoomTools = (mcpServer: McpServer, system: System): void => {
  const listRooms = createListRoomsTool(system.house)
  mcpServer.tool(
    listRooms.name,
    listRooms.description,
    {},
    async () => {
      try {
        const result = await listRooms.execute({}, dummyContext)
        if (!result.success) return errorResult(result.error ?? 'Failed to list rooms')
        return textResult(result.data)
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Failed to list rooms')
      }
    },
  )

  const createRoom = createCreateRoomTool(system.house, system.addAgentToRoom)
  mcpServer.tool(
    createRoom.name,
    createRoom.description,
    {
      name: z.string().describe('Name for the new room'),
      roomPrompt: z.string().optional().describe('Optional system prompt for the room'),
    },
    async ({ name, roomPrompt }) => {
      try {
        const result = await createRoom.execute(
          { name, ...(roomPrompt !== undefined ? { roomPrompt } : {}) },
          dummyContext,
        )
        if (!result.success) return errorResult(result.error ?? 'Failed to create room')
        return textResult(result.data)
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Failed to create room')
      }
    },
  )

  const deleteRoom = createDeleteRoomTool(system.removeRoom, system.house)
  mcpServer.tool(
    deleteRoom.name,
    deleteRoom.description,
    { roomName: z.string().describe('Name of the room to delete') },
    async ({ roomName }) => {
      try {
        const result = await deleteRoom.execute({ roomName }, dummyContext)
        if (!result.success) return errorResult(result.error ?? 'Failed to delete room')
        return textResult(result.data)
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Failed to delete room')
      }
    },
  )

  const setRoomPrompt = createSetRoomPromptTool(system.house)
  mcpServer.tool(
    setRoomPrompt.name,
    setRoomPrompt.description,
    {
      roomName: z.string().describe('Name of the room to update'),
      prompt: z.string().describe('The new room prompt text'),
    },
    async ({ roomName, prompt }) => {
      try {
        const result = await setRoomPrompt.execute({ roomName, prompt }, dummyContext)
        if (!result.success) return errorResult(result.error ?? 'Failed to set room prompt')
        return textResult(result.data)
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Failed to set room prompt')
      }
    },
  )

  const pauseRoom = createPauseRoomTool(system.house)
  mcpServer.tool(
    pauseRoom.name,
    pauseRoom.description,
    {
      roomName: z.string().describe('Name of the room'),
      paused: z.boolean().describe('true to pause, false to unpause'),
    },
    async ({ roomName, paused }) => {
      try {
        const result = await pauseRoom.execute({ roomName, paused }, dummyContext)
        if (!result.success) return errorResult(result.error ?? 'Failed to set paused')
        return textResult(result.data)
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Failed to set paused')
      }
    },
  )

  const setDeliveryMode = createSetDeliveryModeTool(system.house)
  mcpServer.tool(
    setDeliveryMode.name,
    setDeliveryMode.description,
    { roomName: z.string().describe('Name of the room to update') },
    async ({ roomName }) => {
      try {
        const result = await setDeliveryMode.execute({ roomName }, dummyContext)
        if (!result.success) return errorResult(result.error ?? 'Failed to set delivery mode')
        return textResult(result.data)
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Failed to set delivery mode')
      }
    },
  )

  const addToRoom = createAddToRoomTool(system.team, system.house, system.addAgentToRoom)
  mcpServer.tool(
    addToRoom.name,
    addToRoom.description,
    {
      agentName: z.string().describe('Name of the agent to add (use own name to join)'),
      roomName: z.string().describe('Name of the room to join'),
    },
    async ({ agentName, roomName }) => {
      try {
        const result = await addToRoom.execute({ agentName, roomName }, dummyContext)
        if (!result.success) return errorResult(result.error ?? 'Failed to add to room')
        return textResult(result.data)
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Failed to add to room')
      }
    },
  )

  const removeFromRoom = createRemoveFromRoomTool(system.team, system.house, system.removeAgentFromRoom)
  mcpServer.tool(
    removeFromRoom.name,
    removeFromRoom.description,
    {
      agentName: z.string().describe('Name of the agent to remove (use own name to leave)'),
      roomName: z.string().describe('Name of the room'),
    },
    async ({ agentName, roomName }) => {
      try {
        const result = await removeFromRoom.execute({ agentName, roomName }, dummyContext)
        if (!result.success) return errorResult(result.error ?? 'Failed to remove from room')
        return textResult(result.data)
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Failed to remove from room')
      }
    },
  )

  mcpServer.tool(
    'get_room',
    'Get room details and recent messages',
    {
      name: z.string().describe('Room name'),
      messageLimit: z.number().default(50).describe('Max messages to return'),
    },
    async ({ name, messageLimit }) => {
      try {
        const room = resolveRoom(system, name)
        return textResult({ profile: room.profile, messages: room.getRecent(messageLimit), deliveryMode: room.deliveryMode })
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Room not found')
      }
    },
  )
}
