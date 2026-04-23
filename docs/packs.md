# Packs

A **pack** is a GitHub-hosted bundle of domain-specific skills and tools, installed with one command. Packs solve two problems:

1. They let you equip Samsinn with domain knowledge (air traffic control, driving, research, whatever) without authoring each skill and tool by hand.
2. They namespace their contents, so two packs can ship a tool called `plan` and coexist as `atc_plan` and `driving_plan` without collision.

## Installing a pack

Three equivalent phrasings of the source:

| Input                              | Resolves to                                  |
| ---------------------------------- | -------------------------------------------- |
| `atc`                              | `https://github.com/samsinn-packs/atc.git`   |
| `alice/my-pack`                    | `https://github.com/alice/my-pack.git`       |
| `https://github.com/foo/bar.git`   | as-is (any scheme: https/ssh/git/file://)    |

From an agent:

> *"install_pack atc"*

From the UI: click the **+** next to the Packs section in the sidebar and enter the source.

From REST:

```bash
curl -X POST http://localhost:3000/api/packs/install \
  -H 'Content-Type: application/json' \
  -d '{"source":"atc"}'
```

Installation is immediate — new tools and skills reach every running agent without restart. `update_pack` runs `git pull --ff-only` and re-registers. `uninstall_pack` unregisters and deletes the directory.

## Pack anatomy

A pack is a git repo laid out like this:

```
atc/                         ← directory basename is the canonical namespace
├── pack.json                ← optional manifest (name, description)
├── tools/                   ← optional; *.ts files, one tool per default export
│   ├── vatsim_connect.ts
│   └── plan.ts
└── skills/                  ← optional; one subdir per skill, each with SKILL.md
    ├── atc-controller/
    │   ├── SKILL.md
    │   └── tools/           ← optional; skill-scoped bundled tools
    │       └── lookup_airport.ts
    └── chart-reader/
        └── SKILL.md
```

Only the top-level directory is required. A pack can ship just tools, just skills, or both.

## pack.json

Minimal and entirely optional. All fields:

```json
{
  "name": "ATC",
  "description": "Air-traffic-control agents, tools, and skills"
}
```

Both fields are display-only. The **directory name** (`atc/`) is the authoritative namespace used for prefixing registered tools and skills.

## Namespacing

| Source            | Registry key       | Example                                                                         |
| ----------------- | ------------------ | ------------------------------------------------------------------------------- |
| Pack tool         | `<pack>_<name>`    | `atc_vatsim_connect`. The LLM-facing tool name matches.                         |
| Pack skill        | `<pack>/<name>`    | `atc/chart-reader`. Skill names aren't LLM-facing; slash reads well as a path.  |
| Built-in tool     | `<name>`           | `plan` — stays unprefixed. Pack tools never shadow built-ins.                   |
| External tool     | `<name>`           | `~/.samsinn/tools/my_thing.ts` → `my_thing`. Untouched by this feature.         |

Two packs that both define `plan` coexist as `atc_plan` and `driving_plan`. The unprefixed slot stays free for the built-in `plan` tool.

## Authoring a tool inside a pack

Identical to authoring any Samsinn tool, with one gotcha: **write the tool's `name` without the prefix**. The loader applies the namespace at registration time:

```ts
// tools/vatsim_connect.ts
export default {
  name: 'vatsim_connect',              // <-- unprefixed; registers as `<pack>_vatsim_connect`
  description: 'Connect to VATSIM and fetch current traffic',
  parameters: {
    type: 'object',
    properties: {
      region: { type: 'string', description: 'ICAO region code' },
    },
    required: ['region'],
  },
  execute: async ({ region }) => {
    const data = await fetch(`https://data.vatsim.net/v3/...`)
    return { success: true, data }
  },
}
```

See [docs/tools.md](tools.md) for the full tool contract.

## Authoring a skill inside a pack

Identical to authoring any skill — the `name:` frontmatter field stays unprefixed; the loader prefixes at registration:

```markdown
---
name: chart-reader
description: Interpret aviation charts and flight plans
---

When asked about an aviation chart, work through it systematically:
1. Identify the chart type (SID, STAR, approach, en-route)
2. Locate the primary airport ICAO code
3. ...
```

See [the Skills section](../README.md#skills) for the full skill format.

## Publishing a pack

1. Create a new GitHub repo under your account (or under `github.com/samsinn-packs` for the short-name install experience).
2. Put the pack layout at the repo root.
3. `git push`. That's it — no build, no release, no registry.

Users install via `install_pack <name>` (if published under `samsinn-packs`) or `install_pack <user>/<repo>`.

## Management operations

| Tool / Endpoint                         | What it does                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------- |
| `install_pack` / `POST /api/packs/install` | Clone into `~/.samsinn/packs/<ns>/`, register tools + skills, refresh agents. |
| `update_pack` / `POST /api/packs/update/:name` | `git pull --ff-only`, re-register.                                         |
| `uninstall_pack` / `DELETE /api/packs/:name` | Unregister, refresh agents, `rm -rf` the directory.                          |
| `list_packs` / `GET /api/packs`         | List installed packs with their registered tool and skill keys.                 |

All mutations emit a `packs_changed` WebSocket event so open UIs refresh without polling.

## Security model

Packs are arbitrary TypeScript. Installing one is equivalent to running its code — there is no sandbox. Only install packs from sources you trust. This matches the trust model of `~/.samsinn/tools/` and `~/.samsinn/skills/`: the filesystem itself is the permission boundary.

## Limitations

- `git` must be available on `PATH`. Missing git surfaces a clear error on first install attempt.
- Pack tools can only import from Bun's standard library and Node built-ins (no `node_modules`). Authors that need a third-party dep should vendor it inside the pack.
- In-flight tool calls during `uninstall_pack` keep their old closures (same behavior as the external-tools hot-reload path).
- MCP clients see updated pack tools only after reconnecting to the MCP server — same as existing behavior for runtime-registered tools.
