import type { FastifyInstance, RouteHandlerMethod } from 'fastify'

export async function registerBodilessPost(
  app: FastifyInstance,
  path: string,
  handler: RouteHandlerMethod
): Promise<void> {
  await app.register(async (route) => {
    // Older clients sent JSON content-type without a body. Scope compatibility to
    // this bodiless POST so routes requiring JSON keep Fastify's empty-body error.
    const parseJson = route.getDefaultJsonParser('error', 'error')
    route.removeContentTypeParser('application/json')
    route.addContentTypeParser<string>('application/json', { parseAs: 'string' }, (request, body, done) => {
      if (body === '') return done(null, undefined)
      // Retain JSON validation, poisoning protection, and Fastify's body limits.
      parseJson(request, body, done)
    })
    route.post(path, handler)
  })
}
