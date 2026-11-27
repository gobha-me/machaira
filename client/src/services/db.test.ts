// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { openDB } from 'idb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Note } from './api'

const connections = new Set<IDBDatabase>()

beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
  const factory = new IDBFactory()
  const open = factory.open.bind(factory)
  vi.spyOn(factory, 'open').mockImplementation((name, version) => {
    const request = open(name, version)
    request.addEventListener('success', () => connections.add(request.result))
    return request
  })
  vi.stubGlobal('indexedDB', factory)
})

afterEach(() => {
  for (const connection of connections) connection.close()
  connections.clear()
  localStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function note(id: string, updatedAt: number, extra: Partial<Note> = {}): Note {
  return { id, title: id, body: 'A local note', tags: [], refs: [], createdAt: 1, updatedAt, ...extra }
}

describe('local IndexedDB persistence (in-memory API model)', () => {
  it('shares one pending connection across concurrent and subsequent reads', async () => {
    const { legacyPersonalData, readingPlanDb } = await import('./db')
    await Promise.all([legacyPersonalData(), readingPlanDb.get(), legacyPersonalData()])
    expect(indexedDB.open).toHaveBeenCalledTimes(1)
    await readingPlanDb.get()
    expect(indexedDB.open).toHaveBeenCalledTimes(1)
  })

  it('creates the fresh schema and returns honest empty legacy data', async () => {
    const { legacyPersonalData, readingPlanDb } = await import('./db')
    expect(await legacyPersonalData()).toEqual({ notes: [], highlights: [] })
    expect(await readingPlanDb.get()).toBeUndefined()
    const database = await openDB('sword', 2)
    expect([...database.objectStoreNames]).toEqual(['highlights', 'notes', 'readingPlan'])
    const notes = database.transaction('notes').store
    expect(notes.keyPath).toBe('id')
    expect(notes.index('by-updated').keyPath).toBe('updatedAt')
    expect(database.transaction('highlights').store.keyPath).toBe('key')
    expect(database.transaction('readingPlan').store.keyPath).toBe('id')
  })

  it('upgrades v1 without losing notes or highlights and reads newest notes first', async () => {
    const older = note('z-first', 100)
    const newest = note('a-second', 300, { tags: ['saved'], refs: ['John 3:16'] })
    const middle = note('m-third', 200)
    const highlight = { key: 'WEB/John/3/16', color: '#aabbcc' }
    const previous = await openDB('sword', 1, {
      upgrade(database) {
        database.createObjectStore('notes', { keyPath: 'id' }).createIndex('by-updated', 'updatedAt')
        database.createObjectStore('highlights', { keyPath: 'key' })
      }
    })
    const writing = previous.transaction(['notes', 'highlights'], 'readwrite')
    await Promise.all([
      ...[older, newest, middle].map((value) => writing.objectStore('notes').put(value)),
      writing.objectStore('highlights').put(highlight)
    ])
    await writing.done
    previous.close()

    const { legacyPersonalData, readingPlanDb } = await import('./db')
    expect(await legacyPersonalData()).toEqual({ notes: [newest, middle, older], highlights: [highlight] })
    expect(await readingPlanDb.get()).toBeUndefined()
    const upgraded = await openDB('sword', 2)
    expect(upgraded.version).toBe(2)
    expect([...upgraded.objectStoreNames]).toEqual(['highlights', 'notes', 'readingPlan'])
  })

  it('preserves an existing reading-plan store during the additive upgrade', async () => {
    const plan = { id: 'plan' as const, enabled: true, startDate: 100, completed: ['Gen/1', 'John/3'] }
    const previous = await openDB('sword', 1, {
      upgrade(database) {
        database.createObjectStore('readingPlan', { keyPath: 'id' })
      }
    })
    await previous.put('readingPlan', plan)
    previous.close()
    const { readingPlanDb, legacyPersonalData } = await import('./db')
    expect(await readingPlanDb.get()).toEqual(plan)
    expect(await legacyPersonalData()).toEqual({ notes: [], highlights: [] })
  })

  it('persists and replaces the single plan record across module reloads', async () => {
    const first = { id: 'plan' as const, enabled: true, startDate: 100, completed: ['Gen/1'] }
    const replacement = { id: 'plan' as const, enabled: false, startDate: null, completed: [] }
    const { readingPlanDb } = await import('./db')
    await readingPlanDb.save(first)
    expect(await readingPlanDb.get()).toEqual(first)
    await readingPlanDb.save(replacement)
    vi.resetModules()
    const reloaded = await import('./db')
    expect(await reloaded.readingPlanDb.get()).toEqual(replacement)
    const database = await openDB('sword', 2)
    expect(await database.count('readingPlan')).toBe(1)
  })

  it('tracks import completion per account using only the exact true marker', async () => {
    const { legacyImportComplete, markLegacyImportComplete } = await import('./db')
    expect(legacyImportComplete('owner')).toBe(false)
    for (const value of ['', 'false', 'True', '1', ' true', 'true ']) {
      localStorage.setItem('sword.personal-data-imported.v1.owner', value)
      expect(legacyImportComplete('owner')).toBe(false)
    }
    markLegacyImportComplete('owner')
    expect(localStorage.getItem('sword.personal-data-imported.v1.owner')).toBe('true')
    expect(legacyImportComplete('owner')).toBe(true)
    expect(legacyImportComplete('reader')).toBe(false)
    expect(legacyImportComplete('owner.extra')).toBe(false)
  })

  it('exports an empty library with no plan and a reproducible export timestamp', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(123456789)
    const { exportAll } = await import('./db')
    const exported = await exportAll([], [])
    expect(exported.markdown).toBe('')
    expect(JSON.parse(exported.json)).toEqual({ notes: [], highlights: [], readingPlan: null, exportedAt: 123456789 })
  })

  it('exports supplied data and persisted plan with portable Markdown metadata', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(987654321)
    const { exportAll, readingPlanDb } = await import('./db')
    const plan = { id: 'plan' as const, enabled: true, startDate: 100, completed: ['John/3'] }
    await readingPlanDb.save(plan)
    const notes = [
      note('first', Date.UTC(2026, 10, 23, 23, 59), {
        title: 'Study μάχαιρα', body: '**Keep**\nthis paragraph.', tags: ['grace', 'study'], refs: ['John 3:16', 'Rom 8:1']
      }),
      note('second', Date.UTC(2026, 10, 24), { title: 'No metadata', body: 'A second note.' })
    ]
    const highlights = [{ key: 'WEB/John/3/16', color: '#aabbcc' }]
    const exported = await exportAll(notes, highlights)
    expect(JSON.parse(exported.json)).toEqual({ notes, highlights, readingPlan: plan, exportedAt: 987654321 })
    expect(exported.markdown).toBe(
      '# Study μάχαιρα\n_2026-11-23_\nRefs: John 3:16, Rom 8:1\nTags: #grace #study\n\n**Keep**\nthis paragraph.\n' +
      '\n---\n\n# No metadata\n_2026-11-24_\n\nA second note.\n'
    )
    expect(notes[0].tags).toEqual(['grace', 'study'])
    expect(notes[0].refs).toEqual(['John 3:16', 'Rom 8:1'])
  })
})
