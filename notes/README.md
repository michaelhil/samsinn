# notes/

Scratch space for design exploration, research framing, and outlines that are
**not** user-facing documentation.

These files describe what we considered, what we abandoned, or what's still
pending — not how the shipped system works. Keep them out of `docs/` so
people who read the docs don't mistake a discarded sketch for the truth.

## Contents

- [`research/future-turn-taking.md`](research/future-turn-taking.md) —
  early staleness-based turn-order proposal. Superseded by the shipped
  manual delivery mode + per-step macro overlay.
- [`research/planning-survey.md`](research/planning-survey.md) — survey
  of planning approaches in LLM systems (ReAct, Plan-and-Execute, ToT, …).
  Background reading for the todo / macro design.
- [`research/paper-outline.md`](research/paper-outline.md) — academic
  paper outline on coordination & turn-taking in multi-agent human-AI
  systems. Lives here, not on a journal portal.

If something graduates to "this is how it works now," move the relevant
parts into a `docs/` page and trim the original.
