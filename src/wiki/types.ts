// ============================================================================
// Wiki types — config + bindings + cached page shape.
//
// A "wiki" is a GitHub repo following the llm-wiki-skills convention:
//   wiki/index.md    catalog
//   wiki/scope.md    coverage map
//   wiki/<slug>.md   pages with YAML frontmatter + [[wikilinks]]
//
// v1: in-memory cache only (no on-disk mirror). Single shape (no wikiKind flag).
// ============================================================================

// === Config (persisted in ~/.samsinn/wikis.json) ===

export interface WikiConfig {
  readonly id: string                  // stable user-chosen ID, e.g. "nuclear"
  readonly owner: string               // GitHub owner/org
  readonly repo: string                // GitHub repo name
  readonly ref?: string                // branch or commit; default 'main'
  readonly displayName?: string        // optional pretty name; defaults to "{owner}/{repo}"
  readonly apiKey?: string             // optional GitHub PAT (repo:read)
  readonly enabled?: boolean           // default: true
}

export interface MergedWikiEntry {
  readonly id: string
  readonly owner: string
  readonly repo: string
  readonly ref: string                 // resolved (defaults to 'main')
  readonly displayName: string         // resolved
  readonly apiKey: string              // '' when none
  readonly maskedKey: string           // safe for UI / logs
  readonly enabled: boolean
}

// === Bindings (persisted in snapshot, not in wikis.json) ===

export type WikiBindingScope = 'room' | 'agent'

export interface WikiBinding {
  readonly scope: WikiBindingScope
  readonly subjectId: string           // roomId or agentId
  readonly wikiId: string
}

// === Parsed page shape (in-memory cache) ===

export interface WikiPageFrontmatter {
  readonly title: string
  readonly type?: string               // concept | entity | summary | comparison | scenario | ...
  readonly sources?: ReadonlyArray<string>
  readonly related?: ReadonlyArray<string>     // raw "[[slug]]" tokens
  readonly tags?: ReadonlyArray<string>
  readonly confidence?: 'high' | 'medium' | 'low'
  readonly created?: string
  readonly updated?: string
}

export interface WikiPage {
  readonly slug: string                // filename without .md
  readonly path: string                // wiki-relative path, e.g. "concepts/foo.md"
  readonly frontmatter: WikiPageFrontmatter
  readonly body: string                // markdown after frontmatter
  readonly wikilinks: ReadonlyArray<string>    // extracted [[slug]] targets
  readonly fetchedAt: number           // ms since epoch
}

// === Wiki state (per registered wiki, in-memory) ===

export interface WikiState {
  readonly id: string
  readonly displayName: string
  readonly indexMd?: string            // raw wiki/index.md
  readonly scopeMd?: string            // raw wiki/scope.md
  readonly pages: ReadonlyMap<string, WikiPage>  // slug → page
  readonly lastWarmAt?: number
  readonly lastError?: string
}
