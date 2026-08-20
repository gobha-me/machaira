export type VoiceTier = 'browser' | 'local' | 'cloud'

const TIERS = new Set<VoiceTier>(['browser', 'local', 'cloud'])

export class VoiceConfigError extends Error {}

export function voiceString(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new VoiceConfigError(`${name} is required`)
  const result = value.trim()
  if (result.length > max) throw new VoiceConfigError(`${name} is too long`)
  return result
}

export function voiceProviderUrl(value: unknown): string {
  const raw = voiceString(value, 'Base URL', 2048)
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new VoiceConfigError('Base URL must be a valid HTTP or HTTPS URL')
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new VoiceConfigError('Base URL must use HTTP or HTTPS')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new VoiceConfigError('Base URL cannot include credentials, a query, or a fragment')
  }
  url.pathname = url.pathname.replace(/\/+$/, '')
  return url.toString().replace(/\/$/, '')
}

export function voiceEndpoint(baseUrl: string, suffix: string): string {
  const url = new URL(baseUrl)
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${suffix.replace(/^\/+/, '')}`
  return url.toString()
}

export function parseVoiceOrder(value: unknown): VoiceTier[] {
  if (!Array.isArray(value) || value.length > 3) {
    throw new VoiceConfigError('Provider order must be an array with at most three entries')
  }
  const order = value.map((entry) => {
    if (typeof entry !== 'string' || !TIERS.has(entry as VoiceTier)) {
      throw new VoiceConfigError('Provider order contains an invalid tier')
    }
    return entry as VoiceTier
  })
  if (new Set(order).size !== order.length) {
    throw new VoiceConfigError('Provider order cannot contain duplicates')
  }
  return order
}

export async function limitedProviderError(response: Response): Promise<string> {
  if (!response.body) return response.statusText || `HTTP ${response.status}`
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  try {
    while (text.length < 2000) {
      const { done, value } = await reader.read()
      text += decoder.decode(value, { stream: !done })
      if (done) break
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  return text.slice(0, 2000).trim() || response.statusText || `HTTP ${response.status}`
}
