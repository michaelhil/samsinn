// Minimal one-real-agent example.
//
// Requires a provider API key in the environment (ANTHROPIC_API_KEY, etc.).
// Uses the cheapest current Anthropic model — swap to any provider/model
// available in your setup. Two variants differ only in temperature to
// illustrate the variant-comparison workflow.

import type { ExperimentSpec } from '../types.ts'

const spec: ExperimentSpec = {
  experiment: 'hello-world',
  base: {
    room: {
      name: 'greeting',
      roomPrompt: 'A room where agents greet people thoughtfully.',
    },
    trigger: {
      content: 'Say hello in one sentence and introduce yourself.',
      senderName: 'researcher',
    },
  },
  variants: [
    {
      name: 'cold',
      agents: [{
        name: 'greeter',
        model: 'anthropic:claude-haiku-4-5',
        persona: 'You are a warm, concise greeter.',
        temperature: 0.0,
        seed: 42,
      }],
    },
    {
      name: 'warm',
      agents: [{
        name: 'greeter',
        model: 'anthropic:claude-haiku-4-5',
        persona: 'You are a warm, concise greeter.',
        temperature: 1.0,
        seed: 42,
      }],
    },
  ],
  repeats: 2,
  wait: {
    quietMs: 5_000,
    timeoutMs: 60_000,
  },
  outputDir: 'experiments/out/hello-world',
}

export default spec
