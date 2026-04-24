// ============================================================================
// Single-run orchestrator.
//
// runOne drives one (variant, runIndex) through the full MCP sequence:
// create_room → (for each agent: create_agent + add_to_room) → post_message →
// wait_for_idle → export_room. Wraps failures into a RunResult with a status
// tag so the batch loop can continue past individual failures.
//
// wait_for_idle returning idle:false is NOT an error — it's `status: 'timeout'`
// with a truthy `timedOut` flag. Every other failure path produces
// `status: 'error'`.
// ============================================================================

import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { AgentSpec, ExperimentSpec, RunResult, Variant } from './types.ts'

// Tool results always arrive as a single text content block holding JSON.
// Surface samsinn's { error } envelope as a thrown Error so callers can rely
// on try/catch rather than duck-typing every return.
const callJsonTool = async <T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> => {
  const result = await client.callTool({ name, arguments: args })
  const content = result.content as ReadonlyArray<{ type: string; text?: string }>
  if (!content || content.length === 0 || content[0]?.type !== 'text' || !content[0]?.text) {
    throw new Error(`MCP tool "${name}" returned empty content`)
  }
  const parsed = JSON.parse(content[0].text) as unknown
  if (parsed && typeof parsed === 'object' && 'error' in parsed && typeof (parsed as { error: unknown }).error === 'string') {
    throw new Error(`MCP tool "${name}" error: ${(parsed as { error: string }).error}`)
  }
  return parsed as T
}

const createAgentArgs = (agent: AgentSpec): Record<string, unknown> => {
  const args: Record<string, unknown> = {
    name: agent.name,
    model: agent.model,
    persona: agent.persona,
  }
  if (agent.temperature !== undefined) args.temperature = agent.temperature
  if (agent.seed !== undefined) args.seed = agent.seed
  if (agent.tools !== undefined) args.tools = agent.tools
  return args
}

interface WaitForIdleResponse {
  readonly idle: boolean
  readonly messageCount: number
  readonly lastMessageAt: number | null
  readonly elapsedMs: number
}

export const runOne = async (
  spec: ExperimentSpec,
  variant: Variant,
  runIndex: number,
  client: Client,
): Promise<RunResult> => {
  const startedAt = Date.now()

  const base: Pick<RunResult, 'experiment' | 'variant' | 'runIndex' | 'startedAt'> = {
    experiment: spec.experiment,
    variant: variant.name,
    runIndex,
    startedAt,
  }

  try {
    // 1. Room
    await callJsonTool(client, 'create_room', {
      name: spec.base.room.name,
      ...(spec.base.room.roomPrompt !== undefined ? { roomPrompt: spec.base.room.roomPrompt } : {}),
    })

    // 2. Agents — base agents first, then variant-specific
    const allAgents: ReadonlyArray<AgentSpec> = [
      ...(spec.base.agents ?? []),
      ...variant.agents,
    ]
    for (const agent of allAgents) {
      await callJsonTool(client, 'create_agent', createAgentArgs(agent))
      await callJsonTool(client, 'add_to_room', {
        agentName: agent.name,
        roomName: spec.base.room.name,
      })
    }

    // 3. Trigger message — only if there's content to post
    if (spec.base.trigger.content.length > 0) {
      await callJsonTool(client, 'post_message', {
        roomNames: [spec.base.room.name],
        content: spec.base.trigger.content,
        ...(spec.base.trigger.senderName !== undefined ? { senderName: spec.base.trigger.senderName } : {}),
      })
    }

    // 4. Wait for conversation to settle
    const idleResult = await callJsonTool<WaitForIdleResponse>(client, 'wait_for_idle', {
      roomName: spec.base.room.name,
      quietMs: spec.wait.quietMs,
      timeoutMs: spec.wait.timeoutMs,
    })

    // 5. Export regardless of idle/timeout so partial conversations are captured
    const exported = await callJsonTool<RunResult['export']>(client, 'export_room', {
      roomName: spec.base.room.name,
    })

    const finishedAt = Date.now()
    return {
      ...base,
      status: idleResult.idle ? 'ok' : 'timeout',
      ...(idleResult.idle ? {} : { timedOut: true }),
      finishedAt,
      elapsedMs: finishedAt - startedAt,
      ...(exported ? { export: exported } : {}),
    }
  } catch (err) {
    const finishedAt = Date.now()
    return {
      ...base,
      status: 'error',
      finishedAt,
      elapsedMs: finishedAt - startedAt,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
