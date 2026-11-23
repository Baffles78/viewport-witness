import { parseClientOptions } from './options.js'

export function setupStageArgs(
  mode: 'public' | 'account' | 'execute' | 'resume',
  argv: string[],
): string[] {
  const value = parseClientOptions(argv, true)
  if (mode === 'resume') {
    if (!value.resume || !value.output) throw new Error('RESUME_OPTIONS_INVALID')
    return ['--resume', '--output', value.output, ...(value.dnsServers ? ['--dns-servers', value.dnsServers.join(',')] : [])]
  }
  if (value.resume || !value.url) throw new Error('TARGET_URL_REQUIRED')
  const result = ['--url', value.url, '--budget', value.budget]
  if (value.dnsServers) result.push('--dns-servers', value.dnsServers.join(','))
  if (value.network) result.push('--network', value.network)
  if (value.recipient) result.push('--recipient', value.recipient)
  if (mode === 'execute') {
    if (!value.execute || !value.runId) throw new Error('EXECUTION_POLICY_REQUIRED')
    result.push('--run-id', value.runId, '--wallet', 'cdp', '--execute')
    if (value.output) result.push('--output', value.output)
  } else {
    if (value.payer) result.push('--payer', value.payer)
    if (mode === 'account') result.push('--check-account')
    if (value.json) result.push('--json')
  }
  return result
}

export function safeSetupEnvironment(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const excluded = new Set([
    'NODE_OPTIONS',
    'NODE_PATH',
    'NODE_DEBUG',
    'NODE_DEBUG_NATIVE',
    'NODE_TLS_REJECT_UNAUTHORIZED',
    'DEBUG',
    'CDP_API_KEY_ID',
    'CDP_API_KEY_SECRET',
    'CDP_WALLET_SECRET',
    'VW_PAYER_ADDRESS',
  ])
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key, value]) => value !== undefined && !excluded.has(key.toUpperCase()),
    ),
  ) as Record<string, string>
}
