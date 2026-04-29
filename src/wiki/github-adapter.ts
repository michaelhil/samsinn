// ============================================================================
// GitHub adapter — fetch wiki pages from a GitHub repo via the raw content
// CDN, with the Contents API as fallback for tree listing. Honors an optional
// PAT (Bearer auth). Returns typed WikiError on any non-2xx response.
//
// Public files: raw.githubusercontent.com is unmetered and avoids the 60/hr
// anonymous Contents-API limit. We only hit api.github.com for tree listing.
// ============================================================================

import type { MergedWikiEntry } from './types.ts'
import { createWikiError, wikiErrorFromResponse, isWikiError } from './errors.ts'

const RAW_BASE = 'https://raw.githubusercontent.com'
const API_BASE = 'https://api.github.com'

const buildHeaders = (apiKey: string, accept = 'application/vnd.github.raw'): Record<string, string> => {
  const headers: Record<string, string> = {
    'accept': accept,
    'user-agent': 'samsinn-wiki/1',
  }
  if (apiKey) headers.authorization = `Bearer ${apiKey}`
  return headers
}

const fetchText = async (url: string, apiKey: string, wikiId: string): Promise<string> => {
  let res: Response
  try {
    res = await fetch(url, { headers: buildHeaders(apiKey) })
  } catch (cause) {
    throw createWikiError('unavailable', `network error: ${(cause as Error).message}`, { wikiId, cause })
  }
  if (!res.ok) throw wikiErrorFromResponse(res, wikiId)
  try {
    return await res.text()
  } catch (cause) {
    throw createWikiError('parse_error', `failed to read body: ${(cause as Error).message}`, { wikiId, cause })
  }
}

export interface WikiAdapter {
  readonly fetchIndex: () => Promise<string>
  readonly fetchScope: () => Promise<string | undefined>     // missing scope.md is non-fatal
  readonly fetchPage: (slug: string) => Promise<{ path: string; body: string }>
  readonly listWikiTree: () => Promise<ReadonlyArray<string>>  // wiki-relative .md paths
}

export const createGithubAdapter = (wiki: MergedWikiEntry): WikiAdapter => {
  const { id, owner, repo, ref, apiKey } = wiki
  const rawUrl = (path: string): string =>
    `${RAW_BASE}/${owner}/${repo}/${encodeURIComponent(ref)}/${path}`

  const fetchIndex = async (): Promise<string> =>
    fetchText(rawUrl('wiki/index.md'), apiKey, id)

  const fetchScope = async (): Promise<string | undefined> => {
    try {
      return await fetchText(rawUrl('wiki/scope.md'), apiKey, id)
    } catch (err) {
      if (isWikiError(err) && err.kind === 'not_found') return undefined
      throw err
    }
  }

  // Resolve a slug to its actual path under wiki/ by trying the flat path first,
  // then walking the tree for a match. Most slugs land on wiki/<slug>.md.
  const fetchPage = async (slug: string): Promise<{ path: string; body: string }> => {
    const flatPath = `wiki/${slug}.md`
    try {
      const body = await fetchText(rawUrl(flatPath), apiKey, id)
      return { path: flatPath, body }
    } catch (err) {
      if (!isWikiError(err) || err.kind !== 'not_found') throw err
      // Slug may live in a subdirectory (e.g. wiki/concepts/foo.md). Walk tree.
      const tree = await listWikiTree()
      const target = tree.find((p) => p === `wiki/${slug}.md` || p.endsWith(`/${slug}.md`))
      if (!target) throw err
      const body = await fetchText(rawUrl(target), apiKey, id)
      return { path: target, body }
    }
  }

  let cachedTree: ReadonlyArray<string> | undefined

  const listWikiTree = async (): Promise<ReadonlyArray<string>> => {
    if (cachedTree) return cachedTree
    const url = `${API_BASE}/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`
    let res: Response
    try {
      res = await fetch(url, { headers: buildHeaders(apiKey, 'application/vnd.github+json') })
    } catch (cause) {
      throw createWikiError('unavailable', `network error: ${(cause as Error).message}`, { wikiId: id, cause })
    }
    if (!res.ok) throw wikiErrorFromResponse(res, id)
    let json: unknown
    try { json = await res.json() } catch (cause) {
      throw createWikiError('parse_error', `tree response not JSON`, { wikiId: id, cause })
    }
    const tree = (json as { tree?: Array<{ path?: string; type?: string }> }).tree
    if (!Array.isArray(tree)) throw createWikiError('parse_error', `tree response missing 'tree' array`, { wikiId: id })
    const paths = tree
      .filter((e) => e.type === 'blob' && typeof e.path === 'string' && e.path.startsWith('wiki/') && e.path.endsWith('.md'))
      .map((e) => e.path as string)
    cachedTree = paths
    return paths
  }

  return { fetchIndex, fetchScope, fetchPage, listWikiTree }
}
