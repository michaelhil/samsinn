// ============================================================================
// html-to-md — Zero-dependency HTML → Markdown converter.
//
// Designed for LLM consumption: strips noise (nav, scripts, ads), converts
// semantic structure (headings, links, lists, code) to Markdown, decodes
// entities, normalises whitespace, and truncates to a configurable limit.
//
// Limitations: regex-based, not a full HTML parser. Handles real-world
// article content well; deeply nested or malformed HTML may degrade
// gracefully. The function signature is stable — internals can be replaced
// with a proper parser without changing callers.
// ============================================================================

export interface HtmlToMdResult {
  readonly title: string | undefined  // extracted from <title> tag
  readonly markdown: string           // cleaned Markdown content
  readonly charCount: number          // length before truncation
  readonly truncated: boolean
}

// HTML entity map — covers the most common named entities.
const ENTITY_MAP: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
  '&nbsp;': ' ', '&mdash;': '—', '&ndash;': '–', '&hellip;': '…',
  '&copy;': '©', '&reg;': '®', '&trade;': '™', '&laquo;': '«',
  '&raquo;': '»', '&lsquo;': '\u2018', '&rsquo;': '\u2019',
  '&ldquo;': '\u201C', '&rdquo;': '\u201D', '&bull;': '•',
}

const decodeEntities = (s: string): string =>
  s
    .replace(/&[a-zA-Z]+;/g, (m) => ENTITY_MAP[m] ?? m)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))

const stripTags = (s: string): string => s.replace(/<[^>]+>/g, '')

export const htmlToMarkdown = (html: string, maxChars = 8_000): HtmlToMdResult => {
  let s = html

  // Step 1 — Extract page title (before any stripping)
  const titleMatch = s.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const extractedTitle = titleMatch ? decodeEntities(stripTags(titleMatch[1]!)).trim() || undefined : undefined

  // Step 2 — Strip whole elements with their contents
  const stripElements = [
    'script', 'style', 'nav', 'header', 'footer', 'aside',
    'iframe', 'noscript', 'form', 'button', 'select', 'dialog',
  ]
  for (const tag of stripElements) {
    s = s.replace(new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), '')
  }
  // Self-closing tags with no useful content
  s = s.replace(/<(?:meta|link|input)[^>]*\/?>/gi, '')
  // HTML comments
  s = s.replace(/<!--[\s\S]*?-->/g, '')

  // Step 3 — Block code (before inline code to avoid double-wrapping)
  s = s.replace(/<pre[^>]*>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi, '\n```\n$1\n```\n')
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n')

  // Step 4 — Links (BEFORE headings — headings frequently contain links)
  s = s.replace(/<a[^>]+href="([^"#][^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
  s = s.replace(/<a[^>]+href='([^'#][^']*)'[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
  s = s.replace(/<a[^>]*>([\s\S]*?)<\/a>/gi, '$1')  // no href — keep text

  // Step 5 — Images (alt text only)
  s = s.replace(/<img[^>]+alt="([^"]+)"[^>]*\/?>/gi, '[image: $1]')
  s = s.replace(/<img[^>]*\/?>/gi, '')

  // Step 6 — Headings (links already resolved above)
  s = s.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n\n# $1\n')
  s = s.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n\n## $1\n')
  s = s.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n\n### $1\n')
  s = s.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n\n#### $1\n')
  s = s.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, '\n\n##### $1\n')
  s = s.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, '\n\n###### $1\n')

  // Step 7 — Inline formatting
  s = s.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**')
  s = s.replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, '**$1**')
  s = s.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '*$1*')
  s = s.replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, '*$1*')
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
  s = s.replace(/<s[^>]*>([\s\S]*?)<\/s>/gi, '~~$1~~')
  s = s.replace(/<mark[^>]*>([\s\S]*?)<\/mark>/gi, '$1')

  // Step 8 — List items (before stripping ul/ol wrappers)
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n- $1')

  // Step 9 — Block elements → newlines
  s = s.replace(/<\/?(p|div|section|article|main|ul|ol|dl|dd|dt|table|tbody|thead|tfoot|tr|blockquote)[^>]*>/gi, '\n')
  s = s.replace(/<td[^>]*>/gi, ' | ')
  s = s.replace(/<th[^>]*>/gi, ' | ')
  s = s.replace(/<br[^>]*\/?>/gi, '\n')
  s = s.replace(/<hr[^>]*\/?>/gi, '\n---\n')

  // Step 10 — Strip all remaining tags
  s = s.replace(/<[^>]+>/g, '')

  // Step 11 — Decode HTML entities
  s = decodeEntities(s)

  // Step 12 — Whitespace normalisation
  s = s.replace(/\t/g, '  ')
  s = s.split('\n').map(line => line.trimEnd()).join('\n')
  s = s.replace(/\n{3,}/g, '\n\n')
  s = s.trim()

  // Step 13 — Truncate
  const charCount = s.length
  const truncated = s.length > maxChars
  const markdown = truncated
    ? `${s.slice(0, maxChars)}\n\n[... ${charCount - maxChars} characters omitted]`
    : s

  return { title: extractedTitle, markdown, charCount, truncated }
}
