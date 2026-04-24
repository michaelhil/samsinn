// Zero-agent smoke spec — no LLM calls, no API keys needed.
//
// Creates a room, posts a trigger with no agents present, waits briefly for
// idle (satisfied immediately since no agents can post), exports the room
// (containing just the trigger message).
//
// Used as the integration-test fixture for the runner end-to-end path. Every
// primitive is exercised except LLM generation.

import type { ExperimentSpec } from '../types.ts'

const spec: ExperimentSpec = {
  experiment: 'zero-agent-smoke',
  base: {
    room: {
      name: 'smoke',
      roomPrompt: 'Empty-room smoke test.',
    },
    trigger: {
      content: 'This message lands in an empty room.',
      senderName: 'smoke-runner',
    },
  },
  variants: [
    { name: 'baseline', agents: [] },
    { name: 'baseline_copy', agents: [] },
  ],
  repeats: 1,
  wait: {
    quietMs: 300,
    timeoutMs: 5_000,
  },
  outputDir: 'experiments/out/zero-agent-smoke',
}

export default spec
