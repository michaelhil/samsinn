// Zero-agent smoke spec — reset-mode variant.
//
// Same shape as zero-agent.ts but runs all variants against a single persistent
// samsinn subprocess, reset via `reset_system` between runs. Used to verify
// (a) reset-mode end-to-end correctness, (b) that reset-mode wall time is
// meaningfully faster than subprocess-mode, (c) that re-using the same
// agent/room names across runs works cleanly after a reset.

import type { ExperimentSpec } from '../types.ts'

const spec: ExperimentSpec = {
  experiment: 'zero-agent-reset-smoke',
  base: {
    room: {
      name: 'smoke',
      roomPrompt: 'Empty-room smoke test — reset mode.',
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
  repeats: 2,            // 2 variants × 2 repeats = 4 runs to demonstrate speed
  wait: {
    quietMs: 300,
    timeoutMs: 5_000,
  },
  outputDir: 'experiments/out/zero-agent-reset-smoke',
  isolation: 'reset',
}

export default spec
