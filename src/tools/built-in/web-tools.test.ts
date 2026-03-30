import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { createWebTools, webFetchTool, webExtractJsonTool } from './web-tools.ts'

// === Mock fetch helpers ===

type FetchMock = (url: string | URL | Request, init?: RequestInit) => Promise<Response>

const mockFetch = (impl: FetchMock) => {
  const original = globalThis.fetch
  globalThis.fetch = impl as typeof fetch
  return () => { globalThis.fetch = original }
}

const makeResponse = (body: string, options: { status?: number; contentType?: string } = {}): Response => {
  const { status = 200, contentType = 'text/html' } = options
  return new Response(body, {
    status,
    headers: { 'content-type': contentType },
  })
}

const makeJsonResponse = (data: unknown, status = 200): Response =>
  makeResponse(JSON.stringify(data), { status, contentType: 'application/json' })

const makeToolContext = (overrides: Partial<{ maxResultChars: number }> = {}) => ({
  callerId: 'test-agent',
  callerName: 'TestAgent',
  maxResultChars: overrides.maxResultChars,
})

// === createWebTools — registration ===

describe('createWebTools — registration', () => {
  test('no config → 2 tools (no web_search)', () => {
    const tools = createWebTools({})
    expect(tools.length).toBe(2)
    expect(tools.map(t => t.name)).toEqual(['web_fetch', 'web_extract_json'])
  })

  test('braveApiKey → 3 tools including web_search', () => {
    const tools = createWebTools({ braveApiKey: 'test-key' })
    expect(tools.length).toBe(3)
    expect(tools[0]!.name).toBe('web_search')
  })

  test('googleApiKey only (no cseId) → 2 tools (incomplete config)', () => {
    const tools = createWebTools({ googleApiKey: 'key' })
    expect(tools.length).toBe(2)
    expect(tools.map(t => t.name)).not.toContain('web_search')
  })

  test('googleApiKey + googleCseId → 3 tools including web_search', () => {
    const tools = createWebTools({ googleApiKey: 'key', googleCseId: 'cx' })
    expect(tools.length).toBe(3)
    expect(tools[0]!.name).toBe('web_search')
  })

  test('brave takes priority when both configured', () => {
    const tools = createWebTools({ braveApiKey: 'brave', googleApiKey: 'g', googleCseId: 'cx' })
    expect(tools.length).toBe(3)
    // Both would create web_search — brave wins (tried first in tryCreateSearchTool)
    expect(tools[0]!.name).toBe('web_search')
  })
})

// === web_fetch ===

describe('web_fetch — validation', () => {
  test('invalid URL → error result', async () => {
    const result = await webFetchTool.execute({ url: 'not-a-url' }, makeToolContext())
    expect(result.success).toBe(false)
    expect(result.error).toContain('Invalid URL')
  })

  test('non-http scheme → error result', async () => {
    const result = await webFetchTool.execute({ url: 'ftp://example.com' }, makeToolContext())
    expect(result.success).toBe(false)
    expect(result.error).toContain('http')
  })

  test('empty string → error result', async () => {
    const result = await webFetchTool.execute({ url: '' }, makeToolContext())
    expect(result.success).toBe(false)
  })
})

describe('web_fetch — HTTP errors', () => {
  let restore: () => void

  afterEach(() => restore?.())

  test('404 response → error result', async () => {
    restore = mockFetch(async () => makeResponse('Not found', { status: 404 }))
    const result = await webFetchTool.execute({ url: 'https://example.com/missing' }, makeToolContext())
    expect(result.success).toBe(false)
    expect(result.error).toContain('404')
  })

  test('403 response → access denied error', async () => {
    restore = mockFetch(async () => makeResponse('Forbidden', { status: 403 }))
    const result = await webFetchTool.execute({ url: 'https://example.com/private' }, makeToolContext())
    expect(result.success).toBe(false)
    expect(result.error).toContain('Access denied')
  })

  test('500 response → server error', async () => {
    restore = mockFetch(async () => makeResponse('Error', { status: 500 }))
    const result = await webFetchTool.execute({ url: 'https://example.com' }, makeToolContext())
    expect(result.success).toBe(false)
    expect(result.error).toContain('Server error')
  })
})

describe('web_fetch — content handling', () => {
  let restore: () => void

  afterEach(() => restore?.())

  test('HTML page → markdown result shape', async () => {
    restore = mockFetch(async () => makeResponse(
      '<html><head><title>Test Page</title></head><body><h1>Hello</h1><p>World</p></body></html>',
      { contentType: 'text/html' },
    ))
    const result = await webFetchTool.execute({ url: 'https://example.com' }, makeToolContext())
    expect(result.success).toBe(true)
    const data = result.data as { url: string; title: string; content: string; charCount: number; truncated: boolean }
    expect(data.title).toBe('Test Page')
    expect(data.content).toContain('# Hello')
    expect(data.content).toContain('World')
    expect(typeof data.charCount).toBe('number')
    expect(typeof data.truncated).toBe('boolean')
  })

  test('HTML via content sniffing (no content-type header)', async () => {
    restore = mockFetch(async () => new Response(
      '<!DOCTYPE html><html><body><p>Content</p></body></html>',
      { status: 200, headers: {} },
    ))
    const result = await webFetchTool.execute({ url: 'https://example.com' }, makeToolContext())
    expect(result.success).toBe(true)
    const data = result.data as { content: string }
    expect(data.content).toContain('Content')
  })

  test('HTML sniffing — <html> tag without doctype', async () => {
    restore = mockFetch(async () => new Response(
      '<html><body><p>old school</p></body></html>',
      { status: 200, headers: {} },
    ))
    const result = await webFetchTool.execute({ url: 'https://example.com' }, makeToolContext())
    expect(result.success).toBe(true)
    const data = result.data as { content: string }
    expect(data.content).toContain('old school')
  })

  test('JSON response → formatted text', async () => {
    restore = mockFetch(async () => makeJsonResponse({ name: 'Alice', age: 30 }))
    const result = await webFetchTool.execute({ url: 'https://api.example.com/user' }, makeToolContext())
    expect(result.success).toBe(true)
    const data = result.data as { content: string }
    expect(data.content).toContain('"name"')
    expect(data.content).toContain('"Alice"')
  })

  test('plain text response', async () => {
    restore = mockFetch(async () => makeResponse('Hello plain text', { contentType: 'text/plain' }))
    const result = await webFetchTool.execute({ url: 'https://example.com/readme.txt' }, makeToolContext())
    expect(result.success).toBe(true)
    const data = result.data as { content: string }
    expect(data.content).toBe('Hello plain text')
  })

  test('binary image → error', async () => {
    restore = mockFetch(async () => makeResponse('binary', { contentType: 'image/png' }))
    const result = await webFetchTool.execute({ url: 'https://example.com/photo.png' }, makeToolContext())
    expect(result.success).toBe(false)
    expect(result.error).toContain('binary')
  })

  test('PDF → informative error', async () => {
    restore = mockFetch(async () => makeResponse('%PDF-1.4', { contentType: 'application/pdf' }))
    const result = await webFetchTool.execute({ url: 'https://example.com/doc.pdf' }, makeToolContext())
    expect(result.success).toBe(false)
    expect(result.error).toContain('PDF')
  })

  test('respects context.maxResultChars — content truncated to budget', async () => {
    const longPage = '<p>' + 'x'.repeat(5000) + '</p>'
    restore = mockFetch(async () => makeResponse(longPage, { contentType: 'text/html' }))
    const result = await webFetchTool.execute(
      { url: 'https://example.com' },
      makeToolContext({ maxResultChars: 500 }),
    )
    expect(result.success).toBe(true)
    const data = result.data as { content: string; truncated: boolean }
    expect(data.truncated).toBe(true)
    expect(data.content.length).toBeLessThanOrEqual(500 + 70)  // truncation notice overhead
  })

  test('explicit maxChars param overrides context budget', async () => {
    restore = mockFetch(async () => makeResponse('<p>' + 'y'.repeat(3000) + '</p>', { contentType: 'text/html' }))
    const result = await webFetchTool.execute(
      { url: 'https://example.com', maxChars: 200 },
      makeToolContext({ maxResultChars: 10_000 }),
    )
    expect(result.success).toBe(true)
    const data = result.data as { truncated: boolean }
    expect(data.truncated).toBe(true)
  })
})

// === web_extract_json ===

describe('web_extract_json — validation', () => {
  test('invalid URL → error', async () => {
    const result = await webExtractJsonTool.execute({ url: 'not-a-url' }, makeToolContext())
    expect(result.success).toBe(false)
    expect(result.error).toContain('Invalid URL')
  })
})

describe('web_extract_json — happy path', () => {
  let restore: () => void

  afterEach(() => restore?.())

  test('whole response when no path', async () => {
    restore = mockFetch(async () => makeJsonResponse({ a: 1, b: 2 }))
    const result = await webExtractJsonTool.execute({ url: 'https://api.example.com/data' }, makeToolContext())
    expect(result.success).toBe(true)
    const data = result.data as { data: { a: number; b: number } }
    expect(data.data).toEqual({ a: 1, b: 2 })
  })

  test('nested object path', async () => {
    restore = mockFetch(async () => makeJsonResponse({ user: { name: 'Alice', score: 42 } }))
    const result = await webExtractJsonTool.execute(
      { url: 'https://api.example.com', path: 'user.name' },
      makeToolContext(),
    )
    expect(result.success).toBe(true)
    const data = result.data as { data: string }
    expect(data.data).toBe('Alice')
  })

  test('array index navigation with "0"', async () => {
    restore = mockFetch(async () => makeJsonResponse({ results: [{ title: 'First' }, { title: 'Second' }] }))
    const result = await webExtractJsonTool.execute(
      { url: 'https://api.example.com', path: 'results.0.title' },
      makeToolContext(),
    )
    expect(result.success).toBe(true)
    const data = result.data as { data: string }
    expect(data.data).toBe('First')
  })

  test('top-level array with index', async () => {
    restore = mockFetch(async () => makeJsonResponse(['alpha', 'beta', 'gamma']))
    const result = await webExtractJsonTool.execute(
      { url: 'https://api.example.com', path: '1' },
      makeToolContext(),
    )
    expect(result.success).toBe(true)
    const data = result.data as { data: string }
    expect(data.data).toBe('beta')
  })

  test('empty string path → returns whole response', async () => {
    restore = mockFetch(async () => makeJsonResponse({ x: 1 }))
    const result = await webExtractJsonTool.execute(
      { url: 'https://api.example.com', path: '   ' },  // whitespace-only treated as no path
      makeToolContext(),
    )
    expect(result.success).toBe(true)
    const data = result.data as { data: { x: number } }
    expect(data.data).toEqual({ x: 1 })
  })

  test('respects context.maxResultChars', async () => {
    const large = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`key${i}`, 'value'.repeat(20)]))
    restore = mockFetch(async () => makeJsonResponse(large))
    const result = await webExtractJsonTool.execute(
      { url: 'https://api.example.com' },
      makeToolContext({ maxResultChars: 300 }),
    )
    expect(result.success).toBe(true)
    const data = result.data as { truncated: boolean; data: string }
    expect(data.truncated).toBe(true)
    expect(typeof data.data).toBe('string')  // truncated → string, not object
  })
})

describe('web_extract_json — error paths', () => {
  let restore: () => void

  afterEach(() => restore?.())

  test('missing key in path', async () => {
    restore = mockFetch(async () => makeJsonResponse({ a: 1 }))
    const result = await webExtractJsonTool.execute(
      { url: 'https://api.example.com', path: 'a.b.c' },
      makeToolContext(),
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('b')
  })

  test('array index out of bounds', async () => {
    restore = mockFetch(async () => makeJsonResponse([1, 2, 3]))
    const result = await webExtractJsonTool.execute(
      { url: 'https://api.example.com', path: '10' },
      makeToolContext(),
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('out of bounds')
  })

  test('non-JSON response → informative error', async () => {
    restore = mockFetch(async () => makeResponse('<html>Login page</html>', { contentType: 'text/html' }))
    const result = await webExtractJsonTool.execute({ url: 'https://api.example.com' }, makeToolContext())
    expect(result.success).toBe(false)
    expect(result.error).toContain('JSON')
    expect(result.error).toContain('text/html')
  })

  test('HTTP 404 → error', async () => {
    restore = mockFetch(async () => makeResponse('not found', { status: 404 }))
    const result = await webExtractJsonTool.execute({ url: 'https://api.example.com/gone' }, makeToolContext())
    expect(result.success).toBe(false)
    expect(result.error).toContain('404')
  })
})
