// Same shape as zero-agent-reset.ts but explicit subprocess mode.
// Used purely for side-by-side perf comparison with the reset-mode variant.

import type { ExperimentSpec } from '../types.ts'

const spec: ExperimentSpec = {
  experiment: 'zero-agent-subprocess-smoke',
  base: {
    room: { name: 'smoke', roomPrompt: 'Empty-room smoke test — subprocess mode.' },
    trigger: { content: 'This message lands in an empty room.', senderName: 'smoke-runner' },
  },
  variants: [
    { name: 'baseline', agents: [] },
    { name: 'baseline_copy', agents: [] },
  ],
  repeats: 2,
  wait: { quietMs: 300, timeoutMs: 5_000 },
  outputDir: 'experiments/out/zero-agent-subprocess-smoke',
  isolation: 'subprocess',
}

export default spec
