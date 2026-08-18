import type { AuthUser } from './auth.js'

declare module 'fastify' {
  interface FastifyRequest {
    authUser: AuthUser | null
  }
}

export {}
