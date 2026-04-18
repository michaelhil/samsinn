import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { System } from '../../../main.ts'
import type { AIAgent } from '../../../core/types/agent.ts'
import type { ToolContext } from '../../../core/types/tool.ts'
import { asAIAgent } from '../../../agents/shared.ts'
import { createListAgentsTool, createMuteAgentTool } from '../../../tools/built-in/agent-tools.ts'
import { textResult, errorResult, resolveAgent } from './helpers.ts'

const dummyContext: ToolContext = {
  callerId: 'mcp-client',
  callerName: 'mcp-client',
}

export const registerAgentTools = (mcpServer: McpServer, system: System): void => {
  const listAgents = createListAgentsTool(system.team)
  mcpServer.tool(
    listAgents.name,
    listAgents.description,
    {},
    async () => {
      try {
        const result = await listAgents.execute({}, dummyContext)
        if (!result.success) return errorResult(result.error ?? 'Failed to list agents')
        return textResult(result.data)
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Failed to list agents')
      }
    },
  )

  const muteAgent = createMuteAgentTool(system.team, system.house)
  mcpServer.tool(
    muteAgent.name,
    muteAgent.description,
    {
      roomName: z.string().describe('Name of the room'),
      agentName: z.string().describe('Name of the agent to mute or unmute'),
      muted: z.boolean().describe('true to mute, false to unmute'),
    },
    async ({ roomName, agentName, muted }) => {
      try {
        const result = await muteAgent.execute({ roomName, agentName, muted }, dummyContext)
        if (!result.success) return errorResult(result.error ?? 'Failed to set mute')
        return textResult(result.data)
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Failed to set mute')
      }
    },
  )

  mcpServer.tool(
    'create_agent',
    'Create a new AI agent (not added to any room by default)',
    {
      name: z.string().describe('Agent name'),
      model: z.string().describe('Ollama model name (e.g. llama3.2, qwen2.5:14b)'),
      systemPrompt: z.string().describe('System prompt defining the agent personality and behavior'),
      temperature: z.number().optional().describe('LLM temperature (0-1)'),
    },
    async ({ name, model, systemPrompt, temperature }) => {
      try {
        const agent = await system.spawnAIAgent({ name, model, systemPrompt, temperature })
        return textResult({ id: agent.id, name: agent.name })
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Failed to create agent')
      }
    },
  )

  mcpServer.tool(
    'get_agent',
    'Get detailed information about a specific agent',
    { name: z.string().describe('Agent name') },
    async ({ name }) => {
      try {
        const agent = resolveAgent(system, name)
        const detail: Record<string, unknown> = {
          id: agent.id, name: agent.name,
          kind: agent.kind, state: agent.state.get(),
          rooms: system.house.getRoomsForAgent(agent.id).map(r => r.profile.name),
        }
        const aiAgent = asAIAgent(agent)
        if (aiAgent) {
          detail.systemPrompt = aiAgent.getSystemPrompt()
          detail.model = aiAgent.getModel()
        }
        return textResult(detail)
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Agent not found')
      }
    },
  )

  mcpServer.tool(
    'remove_agent',
    'Remove an agent from the system',
    { name: z.string().describe('Agent name') },
    async ({ name }) => {
      try {
        const agent = resolveAgent(system, name)
        system.removeAgent(agent.id)
        return textResult({ removed: true })
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Failed to remove agent')
      }
    },
  )

  mcpServer.tool(
    'update_agent_prompt',
    'Update an AI agent system prompt',
    {
      name: z.string().describe('Agent name'),
      systemPrompt: z.string().describe('New system prompt'),
    },
    async ({ name, systemPrompt }) => {
      try {
        const agent = resolveAgent(system, name)
        if (agent.kind !== 'ai' || !('updateSystemPrompt' in agent)) {
          return errorResult('Only AI agents can be updated')
        }
        ;(agent as AIAgent).updateSystemPrompt(systemPrompt)
        return textResult({ updated: true, name: agent.name })
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Failed to update agent')
      }
    },
  )

  mcpServer.tool(
    'get_house_prompts',
    'Get the global house prompt and response format that guide all agents',
    {},
    async () => textResult({
      housePrompt: system.house.getHousePrompt(),
      responseFormat: system.house.getResponseFormat(),
    }),
  )

  mcpServer.tool(
    'set_house_prompts',
    'Update the global house prompt and/or response format',
    {
      housePrompt: z.string().optional().describe('Global behavioral guidance for all agents'),
      responseFormat: z.string().optional().describe('Response format instructions for agents'),
    },
    async ({ housePrompt, responseFormat }) => {
      if (housePrompt !== undefined) system.house.setHousePrompt(housePrompt)
      if (responseFormat !== undefined) system.house.setResponseFormat(responseFormat)
      return textResult({
        housePrompt: system.house.getHousePrompt(),
        responseFormat: system.house.getResponseFormat(),
      })
    },
  )
}
