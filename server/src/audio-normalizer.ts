import { spawn } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MAX_DURATION_SECONDS = 60
const MAX_NORMALIZED_BYTES = 4 * 1024 * 1024
const PROCESS_TIMEOUT_MS = 30_000

const AUDIO_EXTENSIONS = new Map<string, string>([
  ['audio/webm', '.webm'],
  ['audio/ogg', '.ogg'],
  ['audio/mp4', '.mp4'],
  ['audio/mpeg', '.mp3'],
  ['audio/mp3', '.mp3'],
  ['audio/wav', '.wav'],
  ['audio/x-wav', '.wav'],
  ['audio/flac', '.flac']
])

export class AudioValidationError extends Error {}

function baseMime(value: string): string {
  return value.split(';', 1)[0].trim().toLowerCase()
}

function runProcess(command: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AudioValidationError('Transcription was cancelled'))
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      finish(new AudioValidationError('Audio conversion timed out'))
    }, PROCESS_TIMEOUT_MS)
    const onAbort = () => {
      child.kill('SIGKILL')
      finish(new AudioValidationError('Transcription was cancelled'))
    }
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve(stdout)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < 16_384) stdout += chunk.slice(0, 16_384 - stdout.length)
    })
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 16_384) stderr += chunk.slice(0, 16_384 - stderr.length)
    })
    child.once('error', (error) => {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
      finish(new AudioValidationError(missing
        ? `${command} is required for voice input`
        : `Could not inspect audio: ${error.message}`))
    })
    child.once('close', (code) => {
      if (code === 0) finish()
      else finish(new AudioValidationError(
        stderr.trim() ? `Audio could not be decoded: ${stderr.trim().slice(0, 500)}` : 'Audio could not be decoded'
      ))
    })
  })
}

export async function normalizeRecordedAudio(
  input: Buffer,
  mimetype: string,
  declaredDurationMs: number,
  signal?: AbortSignal
): Promise<{ audio: Buffer; durationMs: number }> {
  if (!Number.isSafeInteger(declaredDurationMs) || declaredDurationMs < 1 || declaredDurationMs > 60_000) {
    throw new AudioValidationError('Recording duration must be between 1 ms and 60 seconds')
  }
  const extension = AUDIO_EXTENSIONS.get(baseMime(mimetype))
  if (!extension) throw new AudioValidationError('Recording format is not supported')
  if (!input.length) throw new AudioValidationError('Recording is empty')

  const directory = await mkdtemp(join(tmpdir(), 'machaira-stt-'))
  const source = join(directory, `recording${extension}`)
  const normalized = join(directory, 'normalized.wav')
  try {
    await writeFile(source, input, { mode: 0o600 })
    const rawDuration = await runProcess('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      source
    ], signal)
    const durationSeconds = Number(rawDuration.trim())
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new AudioValidationError('Recording duration could not be determined')
    }
    if (durationSeconds > MAX_DURATION_SECONDS + 0.05) {
      throw new AudioValidationError('Recording cannot be longer than 60 seconds')
    }
    await runProcess('ffmpeg', [
      '-v', 'error', '-y', '-i', source,
      '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', normalized
    ], signal)
    await chmod(normalized, 0o600)
    const audio = await readFile(normalized)
    if (!audio.length || audio.length > MAX_NORMALIZED_BYTES) {
      throw new AudioValidationError('Normalized recording is invalid')
    }
    return { audio, durationMs: Math.ceil(durationSeconds * 1000) }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
