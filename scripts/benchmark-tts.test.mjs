// Protocol/error-path tests against a loopback server; these are not inference measurements.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);
const script = fileURLToPath(new URL('./benchmark-tts.mjs', import.meta.url));

test('benchmark validation, timing and failure handling', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'machaira-tts-test-'));
  const downloads = join(directory, 'downloads');
  await mkdir(downloads);
  const invoke = (args, env = {}) => run(process.execPath, [script, ...args], {
    env: { ...process.env, TMPDIR: downloads, ...env }, timeout: 10000,
  });
  const serve = async (handler, check) => {
    const server = createServer(handler);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      await check(`http://127.0.0.1:${server.address().port}`);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      assert.deepEqual(await readdir(downloads), [], 'temporary audio must be removed even after failure');
    }
  };
  try {
    // Real decodable MP3 fixture: short silence, never presented as Kokoro output.
    const fixture = join(directory, 'fixture.mp3');
    await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono',
      '-t', '0.25', '-c:a', 'libmp3lame', fixture]);
    const mp3 = await readFile(fixture);
    const wavFixture = join(directory, 'fixture.wav');
    await run('ffmpeg', ['-v', 'error', '-i', fixture, wavFixture]);
    const wav = await readFile(wavFixture);

    await t.test('rejects invalid arguments before any network access', async () => {
      const invalid = [
        [], ['not-a-url'], ['file:///tmp/audio'], ['ftp://localhost'],
        ['http://user:password@localhost'], ['http://localhost?key=secret'], ['http://localhost#fragment'],
        ...['0', '-1', '1.5', 'NaN', '10001', '999999999999999999999'].map((n) => ['http://localhost', n]),
        ...['0', '-1', '1.5', '3601'].map((n) => ['http://localhost', '1', n]),
        ['http://localhost', '1', '1', 'extra'],
      ];
      for (const args of invalid) {
        await assert.rejects(invoke(args), (error) => error.code === 1 && error.stdout === '');
      }
    });

    await t.test('fails clearly when a required tool is absent', async () => {
      await assert.rejects(invoke(['http://localhost', '1'], { PATH: downloads }), /curl ENOENT/);
    });

    await t.test('counts requests, cycles KJV text and computes RTF from actual MP3 duration', async () => {
      const requests = [];
      await serve(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += chunk;
        requests.push({ method: req.method, path: req.url, body: JSON.parse(body) });
        res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
        res.end(mp3);
      }, async (base) => {
        const { stdout } = await invoke([`${base}/v1/`, '4']);
        const rows = stdout.trim().split('\n');
        assert.equal(rows.length, 5);
        for (const [index, line] of rows.slice(1).entries()) {
          const [request, latency, duration, rtf, bytes, text] = line.split('\t');
          assert.equal(Number(request), index + 1);
          assert.ok(Number(latency) > 0);
          assert.ok(Number(duration) >= 0.25 && Number(duration) < 0.5);
          assert.ok(Math.abs(Number(rtf) - Number(latency) / Number(duration)) <= 0.00051);
          assert.equal(Number(bytes), mp3.length);
          assert.equal(JSON.parse(text), requests[index].body.input);
        }
        assert.equal(requests.length, 4);
        for (const request of requests) {
          assert.equal(request.method, 'POST');
          assert.equal(request.path, '/v1/audio/speech');
          assert.equal(request.body.model, 'kokoro');
          assert.equal(request.body.voice, 'af_heart');
          assert.equal(request.body.response_format, 'mp3');
        }
        assert.equal(requests[0].body.input, 'In the beginning God created the heaven and the earth.');
        assert.equal(requests[3].body.input, requests[0].body.input);
        assert.equal(new Set(requests.slice(0, 3).map((r) => r.body.input)).size, 3);
      });
    });

    await t.test('accepts the one-request boundary and a root base URL', async () => {
      let requests = 0;
      await serve((req, res) => {
        requests += 1;
        assert.equal(req.url, '/v1/audio/speech');
        res.writeHead(200, { 'Content-Type': 'audio/mpeg; charset=binary' });
        res.end(mp3);
      }, async (base) => {
        const { stdout } = await invoke([base, '1']);
        assert.equal(stdout.trim().split('\n').length, 2);
        assert.equal(requests, 1);
      });
    });

    for (const scenario of [
      { name: 'HTTP 500', status: 500, type: 'application/json', body: '{"error":"unavailable"}' },
      { name: 'HTTP redirect', status: 302, type: 'audio/mpeg', body: mp3 },
      { name: 'HTTP 204', status: 204, type: 'audio/mpeg', body: '' },
      { name: 'JSON disguised as success', status: 200, type: 'application/json', body: '{}' },
      { name: 'empty MP3', status: 200, type: 'audio/mpeg', body: '' },
      { name: 'corrupt MP3', status: 200, type: 'audio/mpeg', body: 'invalid audio' },
      { name: 'WAV mislabeled as MP3', status: 200, type: 'audio/mpeg', body: wav },
    ]) {
      await t.test(`rejects ${scenario.name} without recording a successful row`, async () => {
        let requests = 0;
        await serve((_req, res) => {
          requests += 1;
          res.writeHead(scenario.status, { 'Content-Type': scenario.type });
          res.end(scenario.body);
        }, async (base) => {
          await assert.rejects(invoke([base, '2']), (error) => {
            assert.match(error.stderr, /Request 1 failed/);
            assert.equal(error.stdout.trim().split('\n').length, 1);
            return error.code === 1;
          });
          assert.equal(requests, 1, 'must stop on the first failure');
        });
      });
    }

    await t.test('bounds stalled requests with the supplied timeout', async () => {
      await serve(() => {}, async (base) => {
        await assert.rejects(invoke([base, '1', '1']), /timed out/i);
      });
    });

    await t.test('reports a dropped connection', async () => {
      await serve((req) => req.socket.destroy(), async (base) => {
        await assert.rejects(invoke([base, '1']), /Request 1 failed/);
      });
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
