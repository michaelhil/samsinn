// ============================================================================
// MCP Client — Connects to MCP servers and registers their tools.
//
// One function: registerMCPServer. Spawns a server process, discovers its
// tools via the MCP protocol, and registers each as a Tool in the global
// ToolRegistry. Agents see MCP tools alongside built-in tools — no special
// handling needed.
//
// Config format matches Claude Desktop's mcp config for familiarity.
// ============================================================================

import { Client } from '@modelcontextprotocol/sdk/client'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { ToolRegistry } from '../../core/types.ts'

export interface MCPServerConfig {
  readonly command: string
  readonly args?: ReadonlyArray<string>
  readonly env?: Record<string, string>
}

export interface MCPConfig {
  readonly mcpServers?: Record<string, MCPServerConfig>
}

interface MCPConnection {
  readonly name: string
  readonly client: Client
  readonly transport: StdioClientTransport
  readonly toolCount: number
}

const activeConnections: MCPConnection[] = []

export const registerMCPServer = async (
  registry: ToolRegistry,
  serverName: string,
  config: MCPServerConfig,
): Promise<number> => {
  const client = new Client({ name: `talking-agents-${serverName}`, version: '1.0.0' })
  const transport = new StdioClientTransport({
    command: config.command,
    args: [...(config.args ?? [])],
    env: config.env ? { ...process.env, ...config.env } as Record<string, string> : undefined,
    stderr: 'pipe',
  })

  await client.connect(transport)

  const { tools } = await client.listTools()
  let registered = 0

  for (const tool of tools) {
    const toolName = `${serverName}__${tool.name}`

    registry.register({
      name: toolName,
      description: tool.description ?? tool.name,
      parameters: tool.inputSchema?.properties
        ? Object.fromEntries(
            Object.entries(tool.inputSchema.properties).map(([k, v]) => [
              k,
              (v as Record<string, unknown>).description ?? (v as Record<string, unknown>).type ?? 'unknown',
            ]),
          )
        : {},
      execute: async (params) => {
        try {
          const result = await client.callTool({ name: tool.name, arguments: params })
          const isError = result.isError ?? false
          // Extract text content from MCP response
          const textParts = (result.content as ReadonlyArray<{ type: string; text?: string }>)
            .filter(c => c.type === 'text' && c.text)
            .map(c => c.text!)
          const data = textParts.join('\n')
          return isError ? { success: false, error: data } : { success: true, data }
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : 'MCP tool call failed' }
        }
      },
    })
    registered++
  }

  activeConnections.push({ name: serverName, client, transport, toolCount: registered })
  return registered
}

export const registerAllMCPServers = async (
  registry: ToolRegistry,
  config: MCPConfig,
): Promise<void> => {
  const servers = config.mcpServers ?? {}

  for (const [name, serverConfig] of Object.entries(servers)) {
    try {
      const count = await registerMCPServer(registry, name, serverConfig)
      console.log(`MCP "${name}": ${count} tools registered`)
    } catch (err) {
      console.error(`MCP "${name}" failed to connect:`, err instanceof Error ? err.message : err)
    }
  }
}

export const disconnectAllMCPServers = async (): Promise<void> => {
  for (const conn of activeConnections) {
    try {
      await conn.client.close()
    } catch { /* ignore cleanup errors */ }
  }
  activeConnections.length = 0
}
