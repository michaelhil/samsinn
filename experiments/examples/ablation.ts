// Prompt-section ablation demo.
//
// One agent asked the same question across three variants differing ONLY in
// which system-prompt sections are included. Compares the effect of persona
// vs. skills on answer quality. Requires an Anthropic key.
//
//   bun run experiments/cli.ts experiments/examples/ablation.ts
//
// UI-label mapping for includePrompts keys:
//   "Agent persona"   → persona
//   "Room prompt"     → room
//   "System prompt"   → house           (global housePrompt)
//   "Response format" → responseFormat
//   "Skills"          → skills

import type { ExperimentSpec, AgentSpec } from '../types.ts'

const baseAgent = (includePrompts: AgentSpec['includePrompts']): AgentSpec => ({
  name: 'answerer',
  model: 'anthropic:claude-haiku-4-5',
  persona: 'You are a concise, careful answerer. Always cite your reasoning.',
  temperature: 0.0,
  seed: 42,
  ...(includePrompts !== undefined ? { includePrompts } : {}),
})

const spec: ExperimentSpec = {
  experiment: 'prompt-ablation',
  base: {
    room: {
      name: 'trial',
      roomPrompt: 'A trial room. Agents answer research questions.',
    },
    trigger: {
      content: 'In one paragraph: what makes a scientific claim falsifiable? End your answer with "— done".',
      senderName: 'researcher',
    },
  },
  variants: [
    // Baseline — every section included (defaults).
    { name: 'baseline', agents: [baseAgent(undefined)] },
    // No persona — see if the agent's answer generalizes without personality steering.
    { name: 'no_persona', agents: [baseAgent({ persona: false })] },
    // No skills section — see if the skills-scoped instructions matter.
    { name: 'no_skills', agents: [baseAgent({ skills: false })] },
    // Minimalist — every prompt section off, only the trigger is in context.
    { name: 'prompts_off', agents: [{
      ...baseAgent(undefined),
      promptsEnabled: false,
    }] },
  ],
  repeats: 3,
  wait: {
    quietMs: 4_000,
    timeoutMs: 30_000,
  },
  outputDir: 'experiments/out/prompt-ablation',
  isolation: 'reset',   // 4 variants × 3 repeats = 12 runs; reset mode pays off
}

export default spec
