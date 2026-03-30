import { describe, test, expect } from 'bun:test'
import { htmlToMarkdown } from './html-to-md.ts'

describe('htmlToMarkdown', () => {
  test('empty input', () => {
    const r = htmlToMarkdown('')
    expect(r.title).toBeUndefined()
    expect(r.markdown).toBe('')
    expect(r.charCount).toBe(0)
    expect(r.truncated).toBe(false)
  })

  test('plain text with no tags', () => {
    const r = htmlToMarkdown('Hello world')
    expect(r.markdown).toBe('Hello world')
    expect(r.truncated).toBe(false)
  })

  test('extracts title', () => {
    const r = htmlToMarkdown('<html><head><title>My Page</title></head><body>content</body></html>')
    expect(r.title).toBe('My Page')
  })

  test('title with HTML entities decoded', () => {
    const r = htmlToMarkdown('<title>Tom &amp; Jerry &mdash; Episode 1</title>')
    expect(r.title).toBe('Tom & Jerry — Episode 1')
  })

  test('title with inner tags stripped', () => {
    const r = htmlToMarkdown('<title><b>Bold</b> Title</title>')
    expect(r.title).toBe('Bold Title')
  })

  test('no title tag → title is undefined', () => {
    const r = htmlToMarkdown('<p>Just content</p>')
    expect(r.title).toBeUndefined()
  })

  test('strips script with contents', () => {
    const r = htmlToMarkdown('<p>Before</p><script>alert("evil")</script><p>After</p>')
    expect(r.markdown).not.toContain('alert')
    expect(r.markdown).toContain('Before')
    expect(r.markdown).toContain('After')
  })

  test('strips style with contents', () => {
    const r = htmlToMarkdown('<style>.foo { color: red }</style><p>text</p>')
    expect(r.markdown).not.toContain('color')
    expect(r.markdown).toContain('text')
  })

  test('strips nav with contents', () => {
    const r = htmlToMarkdown('<nav><a href="/">Home</a></nav><p>article</p>')
    expect(r.markdown).not.toContain('Home')
    expect(r.markdown).toContain('article')
  })

  test('strips footer with contents', () => {
    const r = htmlToMarkdown('<p>main</p><footer>Copyright 2024</footer>')
    expect(r.markdown).not.toContain('Copyright')
    expect(r.markdown).toContain('main')
  })

  // The critical ordering bug: links must be resolved before headings
  test('heading containing a link — link is preserved', () => {
    const r = htmlToMarkdown('<h2><a href="https://example.com">Section Title</a></h2>')
    expect(r.markdown).toContain('## [Section Title](https://example.com)')
  })

  test('h1 through h6', () => {
    const r = htmlToMarkdown('<h1>One</h1><h2>Two</h2><h3>Three</h3><h4>Four</h4><h5>Five</h5><h6>Six</h6>')
    expect(r.markdown).toContain('# One')
    expect(r.markdown).toContain('## Two')
    expect(r.markdown).toContain('### Three')
    expect(r.markdown).toContain('#### Four')
    expect(r.markdown).toContain('##### Five')
    expect(r.markdown).toContain('###### Six')
  })

  test('link with href', () => {
    const r = htmlToMarkdown('<p>See <a href="https://example.com">this page</a> for details.</p>')
    expect(r.markdown).toContain('[this page](https://example.com)')
  })

  test('link with no href — keep text only', () => {
    const r = htmlToMarkdown('<a>plain text link</a>')
    expect(r.markdown).toContain('plain text link')
    expect(r.markdown).not.toContain('[plain text link]')
  })

  test('anchor-only href #fragment — text preserved, no markdown link', () => {
    const r = htmlToMarkdown('<a href="#section">jump</a>')
    // anchor-only hrefs are stripped, text kept
    expect(r.markdown).toContain('jump')
    expect(r.markdown).not.toContain('](#section)')
  })

  test('image with alt text', () => {
    const r = htmlToMarkdown('<img src="photo.jpg" alt="A cat">')
    expect(r.markdown).toContain('[image: A cat]')
  })

  test('image without alt — discarded', () => {
    const r = htmlToMarkdown('<img src="photo.jpg"><p>text</p>')
    expect(r.markdown).not.toContain('photo.jpg')
    expect(r.markdown).toContain('text')
  })

  test('strong and em', () => {
    const r = htmlToMarkdown('<p><strong>bold</strong> and <em>italic</em></p>')
    expect(r.markdown).toContain('**bold**')
    expect(r.markdown).toContain('*italic*')
  })

  test('inline code', () => {
    const r = htmlToMarkdown('<p>Use <code>npm install</code> to install.</p>')
    expect(r.markdown).toContain('`npm install`')
  })

  test('pre+code block', () => {
    const r = htmlToMarkdown('<pre><code>const x = 1\nconst y = 2</code></pre>')
    expect(r.markdown).toContain('```')
    expect(r.markdown).toContain('const x = 1')
  })

  test('unordered list', () => {
    const r = htmlToMarkdown('<ul><li>First</li><li>Second</li><li>Third</li></ul>')
    expect(r.markdown).toContain('- First')
    expect(r.markdown).toContain('- Second')
    expect(r.markdown).toContain('- Third')
  })

  test('HTML entities decoded', () => {
    const r = htmlToMarkdown('<p>&amp; &lt; &gt; &quot; &nbsp; &mdash; &hellip;</p>')
    expect(r.markdown).toContain('& < > " ')
    expect(r.markdown).toContain('—')
    expect(r.markdown).toContain('…')
  })

  test('numeric entities decoded', () => {
    const r = htmlToMarkdown('<p>&#169; &#x2665;</p>')
    expect(r.markdown).toContain('©')
    expect(r.markdown).toContain('♥')
  })

  test('truncation at maxChars', () => {
    const content = '<p>' + 'a'.repeat(200) + '</p>'
    const r = htmlToMarkdown(content, 100)
    expect(r.truncated).toBe(true)
    expect(r.charCount).toBeGreaterThan(100)
    expect(r.markdown.length).toBeLessThanOrEqual(100 + 60)  // omission notice overhead
    expect(r.markdown).toContain('characters omitted')
  })

  test('no truncation when within limit', () => {
    const r = htmlToMarkdown('<p>Short content</p>', 1000)
    expect(r.truncated).toBe(false)
    expect(r.charCount).toBe(r.markdown.length)
  })

  test('real-world: article with nav and footer noise', () => {
    const html = `
      <html>
      <head><title>Test Article</title></head>
      <body>
        <nav><a href="/">Home</a> | <a href="/about">About</a></nav>
        <article>
          <h1>The Main Heading</h1>
          <p>This is the <strong>first paragraph</strong> with a <a href="https://example.com">link</a>.</p>
          <h2>Sub-section</h2>
          <ul><li>Item one</li><li>Item two</li></ul>
        </article>
        <footer>Copyright 2024. All rights reserved.</footer>
        <script>console.log('noise')</script>
      </body>
      </html>
    `
    const r = htmlToMarkdown(html)
    expect(r.title).toBe('Test Article')
    expect(r.markdown).not.toContain('Home')       // nav stripped
    expect(r.markdown).not.toContain('Copyright')  // footer stripped
    expect(r.markdown).not.toContain('console.log') // script stripped
    expect(r.markdown).toContain('# The Main Heading')
    expect(r.markdown).toContain('**first paragraph**')
    expect(r.markdown).toContain('[link](https://example.com)')
    expect(r.markdown).toContain('## Sub-section')
    expect(r.markdown).toContain('- Item one')
    expect(r.markdown).toContain('- Item two')
  })
})
