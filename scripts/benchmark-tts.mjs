#!/usr/bin/env node
// Sequential Kokoro requests; no warm-up is hidden or excluded from the output.
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const sentences = [
  'In the beginning God created the heaven and the earth.', // Genesis 1:1 KJV
  'The LORD is my shepherd; I shall not want.', // Psalm 23:1 KJV
  'Jesus wept.', // John 11:35 KJV
];
const usage = 'Usage: node scripts/benchmark-tts.mjs BASE_URL [N=10] [TIMEOUT_SECONDS=120]';

async function main() {
  const [baseUrl, count = '10', timeout = '120', ...extra] = process.argv.slice(2);
  if (!baseUrl || extra.length || !/^[1-9]\d*$/.test(count) || Number(count) > 10000
    || !/^[1-9]\d*$/.test(timeout) || Number(timeout) > 3600) {
    throw new Error(`${usage}\nN must be 1..10000; TIMEOUT_SECONDS must be 1..3600.`);
  }
  const endpoint = new URL(baseUrl);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password
    || endpoint.search || endpoint.hash) {
    throw new Error(`${usage}\nBASE_URL must be HTTP(S), without credentials, query or fragment.`);
  }
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '') || '/v1'}/audio/speech`;

  // Check tools before contacting the endpoint (even for a one-request run).
  await run('curl', ['--version']);
  await run('ffprobe', ['-version']);
  const directory = await mkdtemp(join(tmpdir(), 'machaira-tts-'));
  try {
    const audio = join(directory, 'speech.mp3');
    console.log('request\tlatency_s\taudio_s\trtf\tbytes\ttext');
    for (let index = 0; index < Number(count); index += 1) {
      const input = sentences[index % sentences.length];
      try {
        const { stdout } = await run('curl', [
          '--disable', // Ignore ~/.curlrc so local retries/options cannot skew the benchmark.
          '--silent', '--show-error', '--fail', '--connect-timeout', '10',
          '--max-time', timeout, '--request', 'POST',
          '--header', 'Content-Type: application/json',
          '--data-binary', JSON.stringify({ model: 'kokoro', voice: 'af_heart', input, response_format: 'mp3' }),
          '--output', audio,
          '--write-out', '%{http_code}\t%{time_total}\t%{content_type}\t%{size_download}',
          endpoint.href,
        ]);
        const [status, latency, contentType, bytes] = stdout.trim().split('\t');
        if (status !== '200' || contentType?.split(';')[0].trim().toLowerCase() !== 'audio/mpeg'
          || !Number.isFinite(Number(latency)) || Number(latency) <= 0 || !(Number(bytes) > 0)) {
          throw new Error(`Expected 200 audio/mpeg with nonempty audio; got ${stdout.trim()}`);
        }
        const { stdout: probe } = await run('ffprobe', [
          '-v', 'error', '-show_entries', 'format=duration,format_name', '-of', 'json', audio,
        ]);
        const format = JSON.parse(probe).format;
        const seconds = Number(format?.duration);
        if (format?.format_name !== 'mp3' || !Number.isFinite(seconds) || seconds <= 0) {
          throw new Error('Expected MP3 audio with a finite, positive duration');
        }
        console.log([
          index + 1, latency, seconds.toFixed(6), (Number(latency) / seconds).toFixed(3),
          bytes, JSON.stringify(input),
        ].join('\t'));
      } catch (error) {
        throw new Error(`Request ${index + 1} failed: ${error.message}`);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
