import type { FastifyInstance } from 'fastify'
import type { DeploymentProviderService } from '../deployment-providers.js'

export async function registerDeploymentProviders(
  app: FastifyInstance,
  providers: DeploymentProviderService
): Promise<void> {
  app.get('/api/providers/deployment', {
    config: {
      rateLimit: {
        max: 30,
        timeWindow: '1 minute',
        keyGenerator: (request) => request.authUser?.id ?? request.ip
      }
    }
  }, async () => ({ providers: await providers.list() }))
}
