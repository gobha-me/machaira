import type {
  DeploymentProviderCapability,
  DeploymentProviderDescriptor,
  DeploymentProviderMap
} from '../services/api'

export interface DeploymentProviderDefaults {
  baseUrl: string
  model: string
  batchSize?: number
  voice?: string
}

export function providerDefaults(
  providers: DeploymentProviderMap,
  capability: DeploymentProviderCapability
): DeploymentProviderDefaults | null {
  const provider = providers[capability]
  if (!provider) return null
  return {
    baseUrl: provider.baseUrl,
    model: provider.model,
    ...(provider.batchSize === undefined ? {} : { batchSize: provider.batchSize }),
    ...(provider.voice === undefined ? {} : { voice: provider.voice })
  }
}

export function providerTitle(provider: DeploymentProviderDescriptor): string {
  const source = provider.source === 'bundled' ? 'Bundled' : 'Deployment'
  return `${source} ${provider.engine}`
}

export function providerReadiness(provider: DeploymentProviderDescriptor): string {
  switch (provider.readiness.state) {
    case 'ready': return 'ready'
    case 'starting': return provider.readiness.message ? `starting · ${provider.readiness.message}` : 'starting'
    case 'unavailable': return provider.readiness.message ? `unavailable · ${provider.readiness.message}` : 'unavailable'
    case 'unchecked': return 'configured · test before saving'
  }
}
