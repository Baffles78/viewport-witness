import { parseDnsServers } from './dns.js'
import { assertClientTarget } from './option-errors.js'
import { usdcAtomic } from '../release-budget.js'

export interface ClientOptions {
  url?: string
  budget: string
  recipient?: string
  payer?: string
  dnsServers?: string[]
  checkAccount: boolean
  json: boolean
  execute: boolean
  resume: boolean
  network?: 'base'
  runId?: string
  output?: string
}
export function parseClientOptions(argv: string[], setup = false): ClientOptions {
  const values: Record<string, string | boolean> = {}
  const flags = ['--check-account', '--json', ...(setup ? ['--execute', '--resume'] : [])]
  const fields = [
    '--url',
    '--network',
    '--budget',
    '--recipient',
    '--payer',
    '--dns-servers',
    ...(setup ? ['--run-id', '--output'] : []),
  ]
  if (argv.length > 30) throw new Error('OPTIONS_INVALID')
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!
    if (Object.hasOwn(values, flag)) throw new Error('OPTIONS_INVALID')
    if (flags.includes(flag)) values[flag] = true
    else if (fields.includes(flag)) {
      const value = argv[++index]
      if (!value || value.startsWith('--') || value.length > 2048 || /[\x00-\x1f]/.test(value))
        throw new Error('OPTIONS_INVALID')
      values[flag] = value
    } else throw new Error('OPTIONS_INVALID')
  }
  const text = (key: string) =>
    typeof values[key] === 'string' ? (values[key] as string) : undefined
  const url = text('--url'),
    network = text('--network'),
    recipient = text('--recipient'),
    payer = text('--payer')
  const budget = text('--budget') ?? '0.08',
    runId = text('--run-id'),
    output = text('--output')
  if (url) assertClientTarget(url)
  if (
    (network && network !== 'base') ||
    (recipient && !/^0x[a-fA-F0-9]{40}$/.test(recipient)) ||
    (payer && !/^0x[a-fA-F0-9]{40}$/.test(payer))
  )
    throw new Error('OPTIONS_INVALID')
  if (usdcAtomic(budget) <= 0n || (runId && !/^[-a-zA-Z0-9_]{1,60}$/.test(runId)))
    throw new Error('OPTIONS_INVALID')
  const execute = values['--execute'] === true,
    resume = values['--resume'] === true
  if (
    resume &&
    (!output ||
      Object.keys(values).some((key) => !['--resume', '--output', '--dns-servers'].includes(key)))
  )
    throw new Error('RESUME_OPTIONS_INVALID')
  if (
    execute &&
    (!url || !runId || !recipient || network !== 'base' || !text('--budget') || resume)
  )
    throw new Error('EXECUTION_POLICY_REQUIRED')
  const dnsServers = parseDnsServers(text('--dns-servers'))
  return {
    budget,
    checkAccount: values['--check-account'] === true,
    json: values['--json'] === true,
    execute,
    resume,
    ...(url ? { url } : {}),
    ...(network ? { network: 'base' } : {}),
    ...(recipient ? { recipient } : {}),
    ...(payer ? { payer } : {}),
    ...(dnsServers ? { dnsServers } : {}),
    ...(runId ? { runId } : {}),
    ...(output ? { output } : {}),
  }
}
