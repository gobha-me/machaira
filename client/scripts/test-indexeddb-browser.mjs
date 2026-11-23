// Install only the needed browser with: npx playwright install --only-shell chromium
// Run from the repository root: npm -w client run test:indexeddb:browser
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const notes = [
  { id: 'z-older', title: 'First note', body: 'Older text.', tags: [], refs: [], createdAt: 1, updatedAt: Date.UTC(2026, 10, 23) },
  { id: 'm-newer', title: 'Study μάχαιρα', body: '**Keep**\nthis paragraph.', tags: ['grace', 'study'], refs: ['John 3:16', 'Rom 8:1'], createdAt: 1, updatedAt: Date.UTC(2026, 10, 25) },
  { id: 'a-middle', title: 'Middle note', body: 'Middle text.', tags: [], refs: [], createdAt: 1, updatedAt: Date.UTC(2026, 10, 24) }
]
const highlights = [{ key: 'WEB/John/3/16', color: '#aabbcc' }]
const plan = { id: 'plan', enabled: true, startDate: 100, completed: ['Gen/1', 'John/3'] }

await test('IndexedDB contracts in real Chromium', { timeout: 30_000 }, async (t) => {
  let serverPromise
  let listeningPromise
  let browserPromise
  let closingBrowser
  let closingServer
  async function cleanup() {
    // Test cancellation must close the browser even when page.evaluate is still pending.
    const ownedBrowser = await browserPromise?.catch(() => undefined)
    try {
      if (ownedBrowser) await (closingBrowser ??= ownedBrowser.close())
    } finally {
      const ownedServer = await serverPromise?.catch(() => undefined)
      await listeningPromise?.catch(() => undefined)
      if (ownedServer) await (closingServer ??= ownedServer.close())
    }
  }
  t.after(cleanup)
  try {
    serverPromise = createServer({
      configFile: false,
      root: fileURLToPath(new URL('../', import.meta.url)),
      appType: 'custom',
      logLevel: 'error',
      optimizeDeps: { noDiscovery: true, include: ['idb'] },
      server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
      plugins: [{
        name: 'indexeddb-test-page',
        configureServer(vite) {
          vite.middlewares.use((request, response, next) => {
            if (request.url !== '/') return next()
            response.setHeader('Content-Type', 'text/html')
            response.end('<!doctype html><html><head><title>IndexedDB test</title></head><body></body></html>')
          })
        }
      }]
    })
    const server = await serverPromise
    t.signal.throwIfAborted()
    assert.ok(server.httpServer)
    // Vite 6 treats configuration port 0 as its default; bind the owned server directly.
    listeningPromise = new Promise((resolve, reject) => {
      server.httpServer.once('error', reject)
      server.httpServer.listen(0, '127.0.0.1', () => {
        server.httpServer.removeListener('error', reject)
        resolve()
      })
    })
    await listeningPromise
    t.signal.throwIfAborted()
    const address = server.httpServer.address()
    assert.ok(address && typeof address === 'object')
    const origin = `http://127.0.0.1:${address.port}`
    browserPromise = chromium.launch({ headless: true, timeout: 10_000 })
    const browser = await browserPromise
    t.signal.throwIfAborted()
    t.diagnostic(`Chromium ${browser.version()}; module /src/services/db.ts; isolated localhost origin`)

    async function withPage(run) {
      const context = await browser.newContext({ serviceWorkers: 'block' })
      const externalRequests = []
      try {
        await context.route('**/*', (route) => {
          if (new URL(route.request().url()).origin === origin) return route.continue()
          externalRequests.push(route.request().url())
          return route.abort()
        })
        const page = await context.newPage()
        page.setDefaultTimeout(10_000)
        await page.goto(origin, { waitUntil: 'domcontentloaded' })
        assert.deepEqual(await page.evaluate(() => indexedDB.databases()), [], 'each context starts with no databases')
        assert.equal(await page.evaluate(() => indexedDB.open.toString().includes('[native code]')), true)
        await run(page)
        assert.deepEqual(externalRequests, [], 'the harness makes no external page requests')
      } finally {
        await context.close()
      }
    }

    await t.test('fresh schema has empty data and no saved plan', async () => withPage(async (page) => {
      const result = await page.evaluate(async () => {
        const db = await import('/src/services/db.ts')
        return {
          legacy: await db.legacyPersonalData(),
          plan: await db.readingPlanDb.get(),
          exported: await db.exportAll([], [])
        }
      })
      assert.deepEqual(result.legacy, { notes: [], highlights: [] })
      assert.equal(result.plan, undefined)
      assert.equal(result.exported.markdown, '')
      const exported = JSON.parse(result.exported.json)
      assert.deepEqual({ ...exported, exportedAt: 0 }, { notes: [], highlights: [], readingPlan: null, exportedAt: 0 })
      assert.ok(Number.isSafeInteger(exported.exportedAt) && exported.exportedAt > 0)
    }))

    await t.test('v1 upgrade, reload persistence, account markers and export', async () => withPage(async (page) => {
      await page.evaluate(({ notes, highlights }) => new Promise((resolve, reject) => {
        const request = indexedDB.open('sword', 1)
        request.onblocked = () => reject(new Error('v1 seed unexpectedly blocked'))
        request.onerror = () => reject(request.error)
        request.onupgradeneeded = () => {
          const db = request.result
          db.createObjectStore('notes', { keyPath: 'id' }).createIndex('by-updated', 'updatedAt')
          db.createObjectStore('highlights', { keyPath: 'key' })
        }
        request.onsuccess = () => {
          const db = request.result
          const transaction = db.transaction(['notes', 'highlights'], 'readwrite')
          transaction.oncomplete = () => { db.close(); resolve() }
          transaction.onabort = () => { db.close(); reject(transaction.error) }
          transaction.onerror = () => { db.close(); reject(transaction.error) }
          for (const note of notes) transaction.objectStore('notes').put(note)
          for (const highlight of highlights) transaction.objectStore('highlights').put(highlight)
        }
      }), { notes, highlights })

      const upgraded = await page.evaluate(async (plan) => {
        const db = await import('/src/services/db.ts')
        const legacy = await db.legacyPersonalData()
        const initialPlan = await db.readingPlanDb.get()
        await db.readingPlanDb.save(plan)
        db.markLegacyImportComplete('owner')
        const schema = await new Promise((resolve, reject) => {
          const request = indexedDB.open('sword')
          request.onerror = () => reject(request.error)
          request.onblocked = () => reject(new Error('schema inspection unexpectedly blocked'))
          request.onsuccess = () => {
            const connection = request.result
            const index = connection.transaction('notes').objectStore('notes').index('by-updated')
            resolve({ version: connection.version, stores: [...connection.objectStoreNames], index: index.keyPath })
            connection.close()
          }
        })
        return { legacy, initialPlan, schema }
      }, plan)
      const orderedNotes = [notes[1], notes[2], notes[0]]
      assert.deepEqual(upgraded.legacy, { notes: orderedNotes, highlights })
      assert.equal(upgraded.initialPlan, undefined)
      assert.deepEqual(upgraded.schema, { version: 2, stores: ['highlights', 'notes', 'readingPlan'], index: 'updatedAt' })

      await page.reload({ waitUntil: 'domcontentloaded' })
      const reloaded = await page.evaluate(async () => {
        const db = await import('/src/services/db.ts')
        const legacy = await db.legacyPersonalData()
        return {
          legacy, plan: await db.readingPlanDb.get(),
          ownerImported: db.legacyImportComplete('owner'),
          readerImported: db.legacyImportComplete('reader'),
          exported: await db.exportAll(legacy.notes, legacy.highlights)
        }
      })
      assert.deepEqual(reloaded.legacy, { notes: orderedNotes, highlights })
      assert.deepEqual(reloaded.plan, plan)
      assert.equal(reloaded.ownerImported, true)
      assert.equal(reloaded.readerImported, false)
      const exported = JSON.parse(reloaded.exported.json)
      assert.deepEqual({ ...exported, exportedAt: 0 }, { notes: orderedNotes, highlights, readingPlan: plan, exportedAt: 0 })
      assert.ok(Number.isSafeInteger(exported.exportedAt) && exported.exportedAt > 0)
      assert.equal(reloaded.exported.markdown,
        '# Study μάχαιρα\n_2026-11-25_\nRefs: John 3:16, Rom 8:1\nTags: #grace #study\n\n**Keep**\nthis paragraph.\n' +
        '\n---\n\n# Middle note\n_2026-11-24_\n\nMiddle text.\n' +
        '\n---\n\n# First note\n_2026-11-23_\n\nOlder text.\n')
    }))
  } finally {
    await cleanup()
  }
})
