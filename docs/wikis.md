# Wikis — vetted knowledge for agents

Samsinn agents can ground answers on **LLM-wikis**: GitHub-hosted, structured
markdown knowledge bases that follow the
[`llm-wiki-skills`](https://github.com/michaelhil/llm-wiki-skills) convention.
A wiki is a repo containing:

- `wiki/index.md` — catalog of pages (entries are `[[slug]]` wikilinks)
- `wiki/scope.md` — coverage map (optional but recommended)
- `wiki/<slug>.md` — pages with YAML frontmatter (`title`, `type`, `tags`,
  `confidence`, `related`, …) and `[[wikilinks]]` between them

Examples shipped by the same author: `nuclear-wiki`, `ai-human-factors-wiki`.

## How agents use wikis

When a wiki is **bound** to a room (or to a specific agent), every agent in
that room sees a `WIKIS` section in its system prompt with each wiki's
`index.md` + `scope.md` and three read-only tools:

| Tool | Purpose |
|---|---|
| `wiki_list` | Enumerate available wikis with page counts and last-warm timestamps |
| `wiki_search` | Search by query / tag / type — returns ranked snippets |
| `wiki_get_page` | Fetch the full markdown of one page by slug |

The injected catalog tells the agent to cite results with `[[slug]]` and to
ground answers on returned text rather than paraphrasing from memory
("medium grounding"). Hard validation (post-processing flagged claims) is
not enforced in v1.

## Setup

### Add a wiki via UI

Open **Settings → Wikis** in the sidebar, click **+ Add**, and enter:

- `id` — short kebab-case handle (e.g. `nuclear`)
- `owner` / `repo` — GitHub coordinates (e.g. `michaelhil` / `nuclear-wiki`)
- `ref` — branch or commit (defaults to `main`)
- PAT — optional GitHub token; **strongly recommended** for wikis with
  more than ~50 pages, since unauthenticated GitHub allows only 60 requests
  per hour and warming a wiki fetches every page listed in `index.md`.

Once added the wiki is warmed in the background; the row shows page count
and a refresh button (↻) when ready.

### Add a wiki via REST

```bash
curl -X POST http://localhost:3000/api/wikis \
  -H 'Content-Type: application/json' \
  -d '{"id":"nuclear","owner":"michaelhil","repo":"nuclear-wiki"}'
```

### Bind to rooms

In the Wikis modal, each wiki row shows a "Bound to rooms" line with a
checkbox per room. Toggle to bind/unbind. Or use REST:

```bash
curl -X PUT http://localhost:3000/api/rooms/reactor-ops/wikis \
  -H 'Content-Type: application/json' \
  -d '{"wikiIds":["nuclear"]}'
```

Per-agent overrides (added on top of the room's bindings):

```bash
curl -X PUT http://localhost:3000/api/agents/<agentId>/wikis \
  -H 'Content-Type: application/json' \
  -d '{"wikiIds":["aviation-checklists"]}'
```

The agent's effective binding set = room's bindings ∪ agent's bindings.

## Multi-account / private wikis

Each wiki entry stores its own optional PAT. Use a fine-grained personal
access token with the `repo:read` scope (private repos) or just the public
metadata scope (public repos that you want raised to the 5000 req/hr ceiling).
Tokens are stored at `~/.samsinn/wikis.json` mode 0600, never logged, and
masked as `•••last4` in the UI.

`wikis.json` is a separate file from `providers.json` — the same lesson as
commit `75a17ce` (don't reuse one PAT for unrelated purposes).

## Cache + freshness

The wiki cache is **in-memory only** (no on-disk mirror). Warm fetches every
page on register and on manual refresh; subsequent reads are served from
cache until TTL (24h default for index/scope, 1h for pages — though both
re-fetch on manual refresh anyway).

A server restart clears the cache. The first agent turn after restart
re-warms in the background; expect a brief delay if no PAT is configured.

## REST surface

```
GET    /api/wikis                            list configured wikis
POST   /api/wikis                            register a wiki
PUT    /api/wikis/:id                        edit
DELETE /api/wikis/:id                        unregister (also clears bindings)
POST   /api/wikis/:id/refresh                force re-warm
GET    /api/rooms/:name/wikis                list bindings on a room
PUT    /api/rooms/:name/wikis                replace room bindings
PUT    /api/agents/:id/wikis                 replace agent overrides
```

`wiki_changed` WS events signal the UI panel to refresh.

## What v1 does NOT do

- **No on-disk mirror** — first-touch cost is paid every cold start. Mitigate
  with a PAT for big wikis.
- **No write-back** — agents can read but not edit. Human users still file
  feedback through the wiki's own per-section `💬` icon (see
  [llm-wiki-skills](https://github.com/michaelhil/llm-wiki-skills)).
- **No public registry browse** — operator adds wikis manually. A curated
  `samsinn-wikis-index` registry (mirroring the packs registry) is a likely
  v2.
- **No hard grounding validator** — tool results are annotated with "ground
  on this", but the agent's output is not post-validated. v2.
- **Only the `llm-wiki-skills` shape is supported** — frontmatter parser is
  tolerant, but it expects `wiki/index.md` to list page slugs as
  `[[wikilinks]]`. Other shapes will not warm correctly.
