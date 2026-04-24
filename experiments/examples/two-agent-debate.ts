// Two-agent debate — multi-agent primitives demo.
//
// An optimist and a pessimist agent are placed in a room, given a debate
// topic, and allowed to exchange arguments until they either converge or the
// maxMessages cap fires. Requires an Anthropic key (or swap to another
// provider). Expect runs to end with status: 'capped' once the cap is hit.
//
//   bun run experiments/cli.ts experiments/examples/two-agent-debate.ts

import type { ExperimentSpec } from '../types.ts'

const spec: ExperimentSpec = {
  experiment: 'two-agent-debate',
  base: {
    room: {
      name: 'debate',
      roomPrompt: 'A rigorous debate room. Speakers build on each other\'s arguments.',
    },
    trigger: {
      content: 'Topic: "Strong AI will be net-positive for humanity." Optimist opens. Keep replies to 2–3 sentences.',
      senderName: 'moderator',
    },
    agents: [
      {
        name: 'Optimist',
        model: 'anthropic:claude-haiku-4-5',
        persona: 'You argue for the motion. Be specific, cite plausible mechanisms, and respond to the Pessimist directly by name when they speak.',
        temperature: 0.7,
      },
      {
        name: 'Pessimist',
        model: 'anthropic:claude-haiku-4-5',
        persona: 'You argue against the motion. Be specific, point to failure modes, and respond to the Optimist directly by name when they speak.',
        temperature: 0.7,
      },
    ],
  },
  // One variant. For a real experiment you'd vary temperature, personas, or
  // models across variants — this file demos the primitives, not the science.
  variants: [
    { name: 'default', agents: [] },
  ],
  repeats: 1,
  wait: {
    quietMs: 8_000,
    timeoutMs: 180_000,
    maxMessages: 8,   // 1 trigger + up to 7 agent turns before capped
  },
  outputDir: 'experiments/out/two-agent-debate',
  isolation: 'subprocess',   // safer for real-LLM runs; swap to 'reset' for big batches
}

export default spec
