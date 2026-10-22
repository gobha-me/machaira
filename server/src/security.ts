import type { FastifyInstance } from 'fastify'
import helmet from '@fastify/helmet'

export function parseHsts(value: string | undefined, production: boolean): boolean {
  if (value === undefined) return production
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error('MACHAIRA_HSTS must be true or false')
}

export async function registerSecurity(app: FastifyInstance, hsts: boolean): Promise<void> {
  // Helmet writes to reply.raw in onRequest, before auth/parser failures and
  // the SSE handlers that call raw.writeHead()/end() without Fastify's onSend.
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'none'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        frameSrc: ["'none'"],
        formAction: ["'self'"],
        // Vite emits external modules and precompiles Vue templates: no inline
        // scripts or runtime compiler (unsafe-eval) are needed.
        scriptSrc: ["'self'"],
        scriptSrcAttr: ["'none'"],
        // Vue style bindings/v-show and theme CSS variables change inline styles
        // (reader highlights, progress bars, font sizes). Keep this allowance
        // confined to styles; index.html loads the Google Fonts stylesheet.
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'"],
        // All provider requests and SSE go through the same-origin server API.
        connectSrc: ["'self'"],
        // useReadAloud plays API audio via URL.createObjectURL(blob).
        mediaSrc: ["'self'", 'blob:'],
        upgradeInsecureRequests: hsts ? [] : null
      }
    },
    // Production TLS terminates at Traefik, so request.protocol is not a reliable
    // signal. HTTP-only deployments can explicitly opt out; do not pin subdomains.
    strictTransportSecurity: hsts ? { maxAge: 31536000, includeSubDomains: false } : false,
    xFrameOptions: { action: 'deny' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
  })
}
