// The public /openapi.json document. Each section lives in src/openapi/;
// add new paths or schemas there and spread them in here.
import { FEEDBACK_URL } from './public.js'
import { serviceInfoPaths } from './openapi/paths-service.js'
import { productPaths } from './openapi/paths-products.js'
import { checkPaths } from './openapi/paths-checks.js'
import { serviceSchemas } from './openapi/schemas-service.js'
import { webProductSchemas } from './openapi/schemas-web-products.js'
import { reportSchemas } from './openapi/schemas-report.js'
import { viewportSchemas } from './openapi/schemas-viewport.js'

export const openApiSpec = {
  openapi: '3.1.0',
  info: {
    title: 'ViewportWitness by Apex Labs',
    version: '0.2.1',
    'x-guidance':
      'Use POST /v1/checks for general browser QA, POST /v1/verify for explicit assertions, and POST /v1/compare when you already have a completed baseline job. Each paid operation returns an x402 challenge before work begins.',
    description:
      'Machine-facing browser QA API. Submit a public HTTPS URL and receive screenshots, ' +
      'accessibility findings, layout analysis, and a structured report across three browser viewports. ' +
      'x402 payment is required per report on the live service; see /.well-known/x402 for current payment options. ' +
      'Self-hosted instances can run in test mode without payment.',
    contact: {
      url: FEEDBACK_URL,
    },
  },
  servers: [
    { url: 'https://qa.honeygate.app', description: 'Live service' },
    { url: 'http://localhost:3000', description: 'Local development (test mode, no payment)' },
  ],
  paths: {
    ...serviceInfoPaths,
    ...productPaths,
    ...checkPaths,
  },
  components: {
    securitySchemes: {
      x402Payment: {
        type: 'apiKey',
        in: 'header',
        name: 'PAYMENT-SIGNATURE',
        description:
          'x402 payment header. Include a signed payment payload for the required amount. ' +
          'See /.well-known/x402 for accepted networks and amounts.',
      },
    },
    schemas: {
      ...serviceSchemas,
      ...webProductSchemas,
      ...reportSchemas,
      ...viewportSchemas,
    },
  },
} as const
