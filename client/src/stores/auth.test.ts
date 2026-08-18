import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { api } from '../services/api'
import { useAuth } from './auth'

function response(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  })
}

describe('auth store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.restoreAllMocks()
  })

  it('discovers first-run bootstrap state', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ state: 'bootstrap' }))
    const auth = useAuth()

    await auth.initialize()

    expect(auth.state).toBe('bootstrap')
    expect(auth.user).toBeNull()
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/status',
      expect.objectContaining({ credentials: 'same-origin' })
    )
  })

  it('stores the authenticated owner after bootstrap', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({
      user: { id: 'owner-id', username: 'Owner', role: 'admin' }
    }, 201))
    const auth = useAuth()

    await auth.bootstrap('Owner', 'correct horse battery staple')

    expect(auth.authenticated).toBe(true)
    expect(auth.isAdmin).toBe(true)
    expect(auth.user?.username).toBe('Owner')
  })

  it('returns to login when an authenticated API request expires', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response({
        state: 'authenticated',
        user: { id: 'member-id', username: 'Reader', role: 'member' }
      }))
      .mockResolvedValueOnce(response({ error: 'Authentication required' }, 401))
    const auth = useAuth()
    await auth.initialize()
    expect(auth.authenticated).toBe(true)

    await expect(api.users()).rejects.toMatchObject({ status: 401 })

    expect(auth.state).toBe('anonymous')
    expect(auth.user).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('clears local identity even if logout cannot reach the server', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'))
    const auth = useAuth()
    auth.state = 'authenticated'
    auth.user = { id: 'owner-id', username: 'Owner', role: 'admin' }

    await expect(auth.logout()).resolves.toBeUndefined()

    expect(auth.state).toBe('anonymous')
    expect(auth.user).toBeNull()
  })
})
