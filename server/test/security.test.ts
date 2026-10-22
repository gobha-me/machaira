import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { buildApp } from '../src/app.ts'
import { parseHsts } from '../src/security.ts'

function assertSecurityHeaders(response: {
  headers: Record<string, string | string[] | undefined>
}, hsts = true): void {
  const headers = response.headers
  const csp = headers['content-security-policy']
  assert.equal(typeof csp, 'string')
  const directives = new Map((csp as string).split(';').map((directive) => {
    const [name, ...sources] = directive.trim().split(/\s+/)
    return [name, sources]
  }))
  assert.deepEqual(directives.get('default-src'), ["'self'"])
  assert.deepEqual(directives.get('script-src'), ["'self'"])
  assert.deepEqual(directives.get('script-src-attr'), ["'none'"])
  assert.deepEqual(directives.get('connect-src'), ["'self'"])
  assert.deepEqual(directives.get('media-src'), ["'self'", 'blob:'])
  assert.deepEqual(directives.get('style-src'), ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'])
  assert.deepEqual(directives.get('font-src'), ["'self'", 'https://fonts.gstatic.com'])
  for (const name of ['object-src', 'base-uri', 'frame-ancestors', 'frame-src']) {
    assert.deepEqual(directives.get(name), ["'none'"], name)
  }
  assert.deepEqual(directives.get('form-action'), ["'self'"])
  assert.ok(!csp?.includes('unsafe-eval'))
  assert.equal(directives.has('upgrade-insecure-requests'), hsts)
  assert.equal(headers['content-security-policy-report-only'], undefined)
  assert.equal(headers['x-frame-options'], 'DENY')
  assert.equal(headers['x-content-type-options'], 'nosniff')
  assert.equal(headers['referrer-policy'], 'strict-origin-when-cross-origin')
  assert.equal(headers['strict-transport-security'], hsts ? 'max-age=31536000' : undefined)
}

describe('security headers', () => {
  it('protects HTML, assets, API JSON, errors and raw SSE, including early failures', async () => {
    const clientPath = await mkdtemp(join(tmpdir(), 'machaira-security-'))
    await mkdir(join(clientPath, 'assets'))
    await writeFile(join(clientPath, 'index.html'), '<main>Security header fixture</main>')
    await writeFile(join(clientPath, 'assets', 'app.js'), 'export {}')
    const app = await buildApp({
      databasePath: ':memory:', secretKey: randomBytes(32), logger: false,
      registerFeatureRoutes: false, clientPath, production: true
    })
    // Exercise an unhandled handler failure through Fastify's real error path.
    app.get('/api/security-failure', async () => { throw new Error('Intentional failure') })
    try {
      const html = await app.inject('/')
      assert.equal(html.statusCode, 200)
      assert.match(html.headers['content-type'] ?? '', /^text\/html/)
      assertSecurityHeaders(html)

      const asset = await app.inject('/assets/app.js')
      assert.equal(asset.statusCode, 200)
      assertSecurityHeaders(asset)
      const cachedAsset = await app.inject({
        url: '/assets/app.js', headers: { 'if-none-match': String(asset.headers.etag) }
      })
      assert.equal(cachedAsset.statusCode, 304)
      assertSecurityHeaders(cachedAsset)
      assertSecurityHeaders(await app.inject({ method: 'HEAD', url: '/' }))

      const health = await app.inject('/api/health')
      assert.equal(health.statusCode, 200)
      assert.deepEqual(health.json(), { ok: true })
      assertSecurityHeaders(health)

      for (const url of ['/missing', '/assets/missing.js', '/.env', '/.git/config']) {
        const missing = await app.inject(url)
        assert.equal(missing.statusCode, 404, url)
        assertSecurityHeaders(missing)
      }
      const unauthorized = await app.inject('/api/semantic-index')
      assert.equal(unauthorized.statusCode, 401)
      assertSecurityHeaders(unauthorized)

      for (const [payload, status] of [['{', 400], [' '.repeat(1024 * 1024 + 1), 413]] as const) {
        const invalid = await app.inject({
          method: 'POST', url: '/api/auth/bootstrap',
          headers: { 'content-type': 'application/json' }, payload
        })
        assert.equal(invalid.statusCode, status)
        assertSecurityHeaders(invalid)
      }
      const bootstrap = await app.inject({
        method: 'POST', url: '/api/auth/bootstrap',
        payload: { username: 'Owner', password: 'correct horse battery staple' }
      })
      assert.equal(bootstrap.statusCode, 201)
      assertSecurityHeaders(bootstrap)
      const session = bootstrap.cookies.find((cookie) => cookie.name === 'machaira_session')
      assert.ok(session)
      const headers = { cookie: `${session.name}=${session.value}` }
      for (const [url, status] of [['/api/missing', 404], ['/api/security-failure', 500]] as const) {
        const failure = await app.inject({ url, headers })
        assert.equal(failure.statusCode, status)
        assertSecurityHeaders(failure)
      }

      // Missing provider configuration must still deliver an SSE error event,
      // then close the stream. This path bypasses Fastify's onSend entirely.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const stream = await app.inject({ method: 'POST', url: '/api/semantic-index/rebuild', headers })
        assertSecurityHeaders(stream)
        if (attempt === 2) {
          assert.equal(stream.statusCode, 429)
        } else {
          assert.equal(stream.statusCode, 200)
          assert.match(stream.headers['content-type'] ?? '', /^text\/event-stream/)
          assert.equal(stream.headers['x-accel-buffering'], 'no')
          assert.match(stream.body, /^event: error\ndata: .*provider.*\n\n$/i)
        }
      }
    } finally {
      await app.close()
      await rm(clientPath, { recursive: true, force: true })
    }
  })

  for (const options of [
    {}, { production: false }, { production: true },
    { production: true, hsts: false }, { production: false, hsts: true }
  ]) {
    it(`configures HSTS independently of untrusted forwarded headers: ${JSON.stringify(options)}`, async () => {
      const app = await buildApp({
        databasePath: ':memory:', secretKey: randomBytes(32), logger: false,
        registerFeatureRoutes: false, ...options
      })
      try {
        for (const protocol of ['http', 'https']) {
          const response = await app.inject({
            url: '/api/health', headers: { 'x-forwarded-proto': protocol }
          })
          assertSecurityHeaders(response, options.hsts ?? options.production ?? false)
        }
      } finally {
        await app.close()
      }
    })
  }

  it('defaults HSTS to production and rejects ambiguous environment overrides', () => {
    for (const production of [false, true]) {
      assert.equal(parseHsts(undefined, production), production)
      assert.equal(parseHsts('false', production), false)
      assert.equal(parseHsts('true', production), true)
      for (const value of ['', '0', '1', 'TRUE', 'False', 'false ', 'yes']) {
        assert.throws(() => parseHsts(value, production), /MACHAIRA_HSTS must be true or false/)
      }
    }
  })
})
