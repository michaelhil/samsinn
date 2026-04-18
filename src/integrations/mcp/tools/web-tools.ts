// ============================================================================
// MCP Web Tools — Wrappers for web_search, web_fetch, and web_extract_json.
//
// Delegates to the built-in web tools. web_search is only registered when
// a search provider API key is available (same env vars as the built-in tools).
// ============================================================================

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { createWebTools } from '../../../tools/built-in/web-tools.ts'
import type { ToolContext } from '../../../core/types/tool.ts'
import { textResult, errorResult } from './helpers.ts'

const dummyContext: ToolContext = {
  callerId: 'mcp-client',
  callerName: 'mcp-client',
}

export const registerWebTools = (mcpServer: McpServer): void => {
  const tools = createWebTools({
    braveApiKey: process.env.BRAVE_API_KEY,
    googleApiKey: process.env.GOOGLE_CSE_API_KEY,
    googleCseId: process.env.GOOGLE_CSE_ID,
  })

  const webFetch = tools.find(t => t.name === 'web_fetch')
  const webExtractJson = tools.find(t => t.name === 'web_extract_json')
  const webSearch = tools.find(t => t.name === 'web_search')

  if (webFetch) {
    mcpServer.tool(
      'web_fetch',
      webFetch.description,
      {
        url: z.string().describe('URL to fetch'),
        maxChars: z.number().optional().describe('Max characters of content to return (default: 8000, max 32000)'),
      },
      async ({ url, maxChars }) => {
        try {
          const result = await webFetch.execute({ url, ...(maxChars !== undefined ? { maxChars } : {}) }, dummyContext)
          if (!result.success) return errorResult(result.error ?? 'Fetch failed')
          return textResult(result.data)
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : 'Fetch failed')
        }
      },
    )
  }

  if (webExtractJson) {
    mcpServer.tool(
      'web_extract_json',
      webExtractJson.description,
      {
        url: z.string().describe('URL of the JSON API endpoint'),
        path: z.string().optional().describe('Dot-notation path to a nested value (e.g. "results.0.title")'),
      },
      async ({ url, path }) => {
        try {
          const result = await webExtractJson.execute({ url, ...(path !== undefined ? { path } : {}) }, dummyContext)
          if (!result.success) return errorResult(result.error ?? 'Extract failed')
          return textResult(result.data)
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : 'Extract failed')
        }
      },
    )
  }

  if (webSearch) {
    mcpServer.tool(
      'web_search',
      webSearch.description,
      {
        query: z.string().describe('The search query'),
        count: z.number().optional().describe('Number of results to return (default 5, max 10)'),
      },
      async ({ query, count }) => {
        try {
          const result = await webSearch.execute({ query, ...(count !== undefined ? { count } : {}) }, dummyContext)
          if (!result.success) return errorResult(result.error ?? 'Search failed')
          return textResult(result.data)
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : 'Search failed')
        }
      },
    )
  }
}
