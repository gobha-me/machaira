/** Keep each remote TTS request comfortably below the sidecar's long-request limit. */
export const MAX_SPEECH_CHARS = 500

export function splitSpeechText(input: string): string[] {
  let remaining = input.trim().replace(/\s+/g, ' ')
  const chunks: string[] = []
  while (remaining.length > MAX_SPEECH_CHARS) {
    const window = remaining.slice(0, MAX_SPEECH_CHARS + 1)
    const sentences = [...window.matchAll(/[.!?]["'”’)]*\s+/g)]
    const sentence = sentences.at(-1)
    let end = sentence ? sentence.index + sentence[0].length : window.lastIndexOf(' ')
    if (end <= 0 || end > MAX_SPEECH_CHARS) end = MAX_SPEECH_CHARS
    // A hard cut in an unbroken word must not split a UTF-16 surrogate pair.
    if (/[\uD800-\uDBFF]/.test(remaining[end - 1]!) && /[\uDC00-\uDFFF]/.test(remaining[end]!)) end -= 1
    chunks.push(remaining.slice(0, end).trim())
    remaining = remaining.slice(end).trimStart()
  }
  if (remaining) chunks.push(remaining)
  return chunks
}
