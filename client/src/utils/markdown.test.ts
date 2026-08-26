import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './markdown'

describe('Markdown rendering', () => {
  it('renders the supported prose and code structures', () => {
    const html = renderMarkdown(`# Heading

Paragraph with **bold**, *emphasis*, and \`inline code\`.

- first
- second

1. one
2. two

> quoted

\`\`\`ts
const answer = 42
\`\`\``)

    expect(html).toContain('<h1>Heading</h1>')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<em>emphasis</em>')
    expect(html).toContain('<code>inline code</code>')
    expect(html).toContain('<ul>')
    expect(html).toContain('<ol>')
    expect(html).toContain('<blockquote>')
    expect(html).toContain('<pre><code class="language-ts">const answer = 42')
  })

  it('keeps raw HTML inert and rejects unsafe or unknown protocols', () => {
    const html = renderMarkdown(`<script>alert('no')</script>

<span onclick="alert('no')">unsafe HTML</span>

[javascript](javascript:alert(1))
[data](data:text/html,unsafe)
[file](file:///tmp/secret)
[custom](custom:payload)
[entity](jav&#x61;script:alert(1))
[encoded](javascript%3Aalert(1))
[control](java%0ascript:alert(1))

![remote](https://example.com/tracker.png)`)

    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<span onclick=')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('href="javascript:')
    expect(html).not.toContain('href="data:')
    expect(html).not.toContain('href="file:')
    expect(html).not.toContain('href="custom:')
    expect(html).not.toContain('href="javascript%3A')
    expect(html).not.toContain('href="java%0a')
    expect(html).toContain('&lt;script&gt;')
  })

  it('opens external web links safely while preserving local and mail links', () => {
    const html = renderMarkdown(`[web](https://example.com/path)
[protocol relative](//example.com/path)
[local](/journal)
[fragment](#notes)
[mail](mailto:reader@example.com)`)

    expect(html).toContain('href="https://example.com/path" target="_blank" rel="noopener noreferrer"')
    expect(html).toContain('href="//example.com/path" target="_blank" rel="noopener noreferrer"')
    expect(html).toContain('<a href="/journal">local</a>')
    expect(html).toContain('<a href="#notes">fragment</a>')
    expect(html).toContain('<a href="mailto:reader@example.com">mail</a>')
  })
})
