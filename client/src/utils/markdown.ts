import MarkdownIt, { type Env } from 'markdown-it'
import { findDisplayReferences } from '@machaira/scripture'

export interface MarkdownRenderOptions {
  scriptureLinks?: boolean
}

const explicitScheme = /^([a-z][a-z0-9+.-]*):/i
const externalHttpUrl = /^(?:https?:)?\/\//i
const safeSchemes = new Set(['http', 'https', 'mailto'])

const markdown = new MarkdownIt({
  html: false,
  linkify: false,
  typographer: false
})

interface MarkdownEnvironment extends Env {
  scriptureLinks?: boolean
}

// Work at the parsed-token layer so references inside code or an existing Markdown link are
// never rewritten. Each generated link carries only validated canonical target fields.
markdown.core.ruler.after('inline', 'scripture_references', (state) => {
  if (!(state.env as MarkdownEnvironment).scriptureLinks) return
  for (const block of state.tokens) {
    if (block.type !== 'inline' || !block.children) continue
    const rewritten: typeof block.children = []
    let linkDepth = 0
    for (const child of block.children) {
      if (child.type === 'link_open') linkDepth += 1
      if (child.type !== 'text' || linkDepth > 0) {
        rewritten.push(child)
      } else {
        let cursor = 0
        for (const match of findDisplayReferences(child.content)) {
          if (match.start > cursor) {
            const text = new state.Token('text', '', 0)
            text.content = child.content.slice(cursor, match.start)
            rewritten.push(text)
          }
          const open = new state.Token('link_open', 'a', 1)
          open.attrSet('href', '#')
          open.attrSet('class', 'scripture-reference')
          open.attrSet('data-scripture-book', match.target.book)
          open.attrSet('data-scripture-chapter', String(match.target.chapter))
          if (match.target.verseStart !== null) {
            open.attrSet('data-scripture-verse-start', String(match.target.verseStart))
            open.attrSet('data-scripture-verse-end', String(match.target.verseEnd))
          }
          const label = new state.Token('text', '', 0)
          label.content = match.label
          rewritten.push(open, label, new state.Token('link_close', 'a', -1))
          cursor = match.end
        }
        if (cursor < child.content.length) {
          const text = new state.Token('text', '', 0)
          text.content = child.content.slice(cursor)
          rewritten.push(text)
        }
      }
      if (child.type === 'link_close') linkDepth -= 1
    }
    block.children = rewritten
  }
})

// Images are deliberately outside the trusted display surface. Besides not being part of the
// supported Markdown contract, remote images could make viewing a note or response issue a
// third-party request without the user's intent.
markdown.disable('image')

markdown.validateLink = (url) => {
  let decoded: string
  try {
    decoded = decodeURIComponent(url.trim())
  } catch {
    return false
  }
  if (/[\u0000-\u001f\u007f]/.test(decoded)) return false
  const scheme = explicitScheme.exec(decoded)?.[1]?.toLowerCase()
  return !scheme || safeSchemes.has(scheme)
}

const defaultLinkOpen = markdown.renderer.rules.link_open
markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
  const href = String(tokens[index].attrGet('href') ?? '')
  if (externalHttpUrl.test(href)) {
    tokens[index].attrSet('target', '_blank')
    tokens[index].attrSet('rel', 'noopener noreferrer')
  }
  return defaultLinkOpen
    ? defaultLinkOpen(tokens, index, options, env, self)
    : self.renderToken(tokens, index, options)
}

export function renderMarkdown(source: string, options: MarkdownRenderOptions = {}): string {
  const environment: MarkdownEnvironment = { scriptureLinks: options.scriptureLinks }
  return markdown.render(source, environment)
}
