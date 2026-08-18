import type { FastifyInstance, FastifyReply } from 'fastify'
import {
  AuthConflictError,
  AuthForbiddenError,
  AuthInputError,
  type AuthService,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  type UserRole
} from '../auth.js'

interface CredentialsBody {
  username?: string
  password?: string
}

interface PasswordBody {
  currentPassword?: string
  newPassword?: string
}

function requireFields(body: CredentialsBody): { username: string; password: string } {
  if (typeof body.username !== 'string' || typeof body.password !== 'string') {
    throw new AuthInputError('Username and password are required')
  }
  return { username: body.username, password: body.password }
}

function setSessionCookie(reply: FastifyReply, token: string, secure: boolean): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure,
    maxAge: SESSION_TTL_SECONDS
  })
}

function clearSessionCookie(reply: FastifyReply, secure: boolean): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, sameSite: 'strict', secure })
}

function statusFor(error: unknown): number {
  if (error instanceof AuthConflictError) return 409
  if (error instanceof AuthForbiddenError) return 403
  if (error instanceof AuthInputError) return 400
  return 500
}

function messageFor(error: unknown): string {
  if (
    error instanceof AuthConflictError
    || error instanceof AuthForbiddenError
    || error instanceof AuthInputError
  ) return error.message
  return 'Authentication request failed'
}

export async function registerAuth(
  app: FastifyInstance,
  auth: AuthService,
  secureCookies: boolean
): Promise<void> {
  app.get('/api/auth/status', async (request) => {
    const user = auth.authenticate(request.cookies[SESSION_COOKIE])
    if (user) return { state: 'authenticated' as const, user }
    return { state: auth.hasUsers() ? 'anonymous' as const : 'bootstrap' as const }
  })

  app.post<{ Body: CredentialsBody }>('/api/auth/bootstrap', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } }
  }, async (request, reply) => {
    try {
      const { username, password } = requireFields(request.body ?? {})
      const user = await auth.bootstrap(username, password)
      setSessionCookie(reply, auth.createSession(user.id), secureCookies)
      return reply.code(201).send({ user })
    } catch (error) {
      return reply.code(statusFor(error)).send({ error: messageFor(error) })
    }
  })

  app.post<{ Body: CredentialsBody }>('/api/auth/login', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } }
  }, async (request, reply) => {
    const { username, password } = request.body ?? {}
    if (typeof username !== 'string' || typeof password !== 'string') {
      return reply.code(400).send({ error: 'Username and password are required' })
    }
    const user = await auth.login(username, password)
    if (!user) return reply.code(401).send({ error: 'Invalid username or password' })
    setSessionCookie(reply, auth.createSession(user.id), secureCookies)
    return { user }
  })

  app.post('/api/auth/logout', async (request, reply) => {
    auth.revokeSession(request.cookies[SESSION_COOKIE])
    clearSessionCookie(reply, secureCookies)
    return reply.code(204).send()
  })

  app.post<{ Body: PasswordBody }>('/api/auth/password', async (request, reply) => {
    const currentPassword = request.body?.currentPassword
    const newPassword = request.body?.newPassword
    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
      return reply.code(400).send({ error: 'Current and new passwords are required' })
    }
    try {
      const token = await auth.changePassword(request.authUser!.id, currentPassword, newPassword)
      setSessionCookie(reply, token, secureCookies)
      return reply.code(204).send()
    } catch (error) {
      return reply.code(statusFor(error)).send({ error: messageFor(error) })
    }
  })

  app.get('/api/users', async (request, reply) => {
    if (request.authUser?.role !== 'admin') return reply.code(403).send({ error: 'Administrator access required' })
    return { users: auth.listUsers() }
  })

  app.post<{ Body: CredentialsBody & { role?: UserRole } }>('/api/users', async (request, reply) => {
    if (request.authUser?.role !== 'admin') return reply.code(403).send({ error: 'Administrator access required' })
    try {
      const { username, password } = requireFields(request.body ?? {})
      const user = await auth.createUser(username, password, request.body.role ?? 'member')
      return reply.code(201).send({ user })
    } catch (error) {
      return reply.code(statusFor(error)).send({ error: messageFor(error) })
    }
  })

  app.patch<{ Params: { id: string }; Body: { disabled?: boolean } }>('/api/users/:id', async (request, reply) => {
    if (request.authUser?.role !== 'admin') return reply.code(403).send({ error: 'Administrator access required' })
    if (typeof request.body?.disabled !== 'boolean') return reply.code(400).send({ error: 'Disabled state is required' })
    try {
      auth.setDisabled(request.authUser.id, request.params.id, request.body.disabled)
      return reply.code(204).send()
    } catch (error) {
      return reply.code(statusFor(error)).send({ error: messageFor(error) })
    }
  })

  app.post<{ Params: { id: string }; Body: { password?: string } }>('/api/users/:id/password', async (request, reply) => {
    if (request.authUser?.role !== 'admin') return reply.code(403).send({ error: 'Administrator access required' })
    if (request.authUser.id === request.params.id) {
      return reply.code(400).send({ error: 'Use Change password for your own account' })
    }
    if (typeof request.body?.password !== 'string') return reply.code(400).send({ error: 'Password is required' })
    try {
      await auth.resetPassword(request.params.id, request.body.password)
      return reply.code(204).send()
    } catch (error) {
      return reply.code(statusFor(error)).send({ error: messageFor(error) })
    }
  })
}
