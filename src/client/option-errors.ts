import { validateUrl } from '../ssrf.js'

const fixes = {
  TARGET_URL_INVALID: 'Use one complete public HTTPS URL, for example https://example.com.',
  TARGET_HTTPS_REQUIRED:
    'Use https:// for a public page. HTTP, file and other schemes are not supported.',
  TARGET_CREDENTIALS_FORBIDDEN:
    'Remove the username and password from the URL. Never put credentials in command arguments.',
  TARGET_PORT_UNSUPPORTED: 'Use the default HTTPS port 443; custom target ports are not supported.',
  TARGET_NOT_PUBLIC:
    'Use a public HTTPS page. Loopback, private, local and metadata destinations remain blocked; changing DNS does not bypass this rule.',
} as const

export class ClientTargetError extends Error {
  readonly fix: string
  constructor(readonly code: keyof typeof fixes) {
    super(code)
    this.fix = fixes[code]
  }
}

/** Classify only existing policy results. Never include the URL or raw reason in output. */
export function assertClientTarget(url: string): void {
  const result = validateUrl(url)
  if (result.valid) return
  const reason = result.reason ?? ''
  if (reason === 'invalid_url') throw new ClientTargetError('TARGET_URL_INVALID')
  if (reason.startsWith('blocked_scheme:')) throw new ClientTargetError('TARGET_HTTPS_REQUIRED')
  if (reason === 'url_credentials_not_allowed')
    throw new ClientTargetError('TARGET_CREDENTIALS_FORBIDDEN')
  if (reason.startsWith('blocked_port:')) throw new ClientTargetError('TARGET_PORT_UNSUPPORTED')
  throw new ClientTargetError('TARGET_NOT_PUBLIC')
}
