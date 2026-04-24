// Normalises LLM-generated Mermaid source to what Mermaid 11 actually accepts.
//
// Pure function. No DOM, no network, no side effects. All regex-heavy, so
// every branch should have a test case in normalise.test.ts.
//
// Rules applied in order:
//   1. Strip trailing `;` from each line. Accepted in older mermaid, rejected
//      in strict parses. Semicolons mid-line (e.g. in labels) are preserved.
//   2. Quote the body of `[...]`, `(...)`, `{...}` when it contains a char
//      Mermaid treats as control (`/ # < >`). Leaves already-quoted bodies
//      alone.
//   3. Convert bare quoted node references — `"Foo / Bar" --> X` — into
//      synthetic `nN["Foo / Bar"]` definitions with ID reuse for subsequent
//      mentions. Mermaid requires node refs to be identifiers, not quoted
//      strings. Edge-label quotes (`A -- "label" --> B`) are NOT rewritten.

const NEEDS_QUOTING = /[\/#<>]/

// Max source length accepted. Matches Mermaid's default `maxTextSize` so our
// cap doesn't lie ahead of mermaid's. Callers detect exceeds-cap and route
// to the fallback UI — normalise() itself still runs on oversized input
// (harmless; cheap), but callers should check first.
export const MAX_MERMAID_SOURCE = 50_000

export const normaliseMermaidSource = (src: string): string => {
  // 1. Strip trailing semicolons from each line.
  const lines = src.split('\n').map(line => line.replace(/;\s*$/, ''))
  let normalised = lines.join('\n')

  // 2. Quote label bodies that contain special chars. Matches [...], (...),
  //    {...}. Already-quoted bodies are left alone.
  normalised = normalised.replace(
    /(\[|\(|\{)([^\[\]\(\)\{\}"\n]+?)(\]|\)|\})/g,
    (match, open: string, body: string, close: string) => {
      const trimmed = body.trim()
      if (trimmed.startsWith('"') && trimmed.endsWith('"')) return match
      if (!NEEDS_QUOTING.test(body)) return match
      return `${open}"${body.trim()}"${close}`
    },
  )

  // 3. Bare-quoted references. Two-phase: mark every `"..."` with a sentinel,
  //    restore the ones that turn out to be inside brackets (produced by
  //    step 2), then expand the remaining sentinels into synthetic node
  //    definitions. Edge-label quotes (preceded by `-- ` or followed by
  //    ` -->`) are never marked in the first place.
  const labelToId = new Map<string, string>()
  const synthId = (label: string): string => {
    const existing = labelToId.get(label)
    if (existing) return existing
    const id = `n${labelToId.size + 1}`
    labelToId.set(label, id)
    return id
  }

  // An edge label sits between `--` and `--` (any number of dashes — covers
  // `-->`, `--x`, `-.->`, etc). A quoted string is a bare node reference
  // ONLY when it's NOT in that position. Check both neighbours at match
  // time rather than using variable-width lookbehind (portability + clarity).
  normalised = normalised.replace(
    /"([^"\n]+)"/g,
    (match, label: string, offset: number, full: string): string => {
      const before = full.slice(Math.max(0, offset - 6), offset)
      const after = full.slice(offset + match.length, offset + match.length + 6)
      const isEdgeStart = /--\s*$/.test(before)
      const isEdgeEnd = /^\s*--/.test(after)
      if (isEdgeStart && isEdgeEnd) return match  // edge label — leave alone
      return `__MM_LABEL__${synthId(label)}__MM_END__`
    },
  )

  // Restore bracketed sentinels to their original quoted form (step 2
  // produced `["Foo"]` which got sentinel-ified; restore).
  normalised = normalised.replace(
    /(\[|\(|\{)__MM_LABEL__n(\d+)__MM_END__(\]|\)|\})/g,
    (_m, open: string, n: string, close: string) => {
      const label = [...labelToId.entries()].find(([, id]) => id === `n${n}`)?.[0] ?? ''
      return `${open}"${label}"${close}`
    },
  )

  // Remaining sentinels are bare references — expand to `id["label"]` on
  // first occurrence, bare `id` on subsequent references.
  const definedIds = new Set<string>()
  normalised = normalised.replace(
    /__MM_LABEL__(n\d+)__MM_END__/g,
    (_m, id: string) => {
      const label = [...labelToId.entries()].find(([, v]) => v === id)?.[0] ?? ''
      if (definedIds.has(id)) return id
      definedIds.add(id)
      return `${id}["${label}"]`
    },
  )

  return normalised
}

// Truncate a source string for display in a fallback card. Mermaid sources
// get large enough to dominate a chat pane; keep the preview bounded.
export const truncateForDisplay = (src: string, max = 500): string => {
  if (src.length <= max) return src
  return `${src.slice(0, max)}\n… (truncated)`
}
