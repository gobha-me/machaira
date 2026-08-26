import MarkdownIt from 'markdown-it'

const explicitScheme = /^([a-z][a-z0-9+.-]*):/i
const externalHttpUrl = /^(?:https?:)?\/\//i
const safeSchemes = new Set(['http', 'https', 'mailto'])

const markdown = new MarkdownIt({
  html: false,
  linkify: false,
  typographer: false
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

export function renderMarkdown(source: string): string {
  return markdown.render(source)
}
