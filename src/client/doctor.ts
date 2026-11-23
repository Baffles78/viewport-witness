import { runReleaseCheck } from '../release-check.js'
import { lookupCdpAccount } from '../cdp/account-lookup.js'
import { clientTargetValidator, diagnosticOsLookup } from './dns.js'
import { diagnosticFetch, SERVICE_ORIGIN } from './network.js'
import { BASE_USDC, readBaseUsdcBalance } from './balance.js'
import type { ClientOptions } from './options.js'

export type DoctorStatus = 'pass' | 'fail' | 'unknown' | 'skipped'
export interface DoctorStage {
  stage: string
  status: DoctorStatus
  code: string
  fix: string
}
type Environment = Record<string, string | undefined>
export interface DoctorDependencies {
  fetchFn?: typeof fetch
  validateTarget?: ReturnType<typeof clientTargetValidator>
  osLookup?: (url: string) => Promise<boolean>
  nodeVersion?: string
}
export function supportedRuntime(version: string): boolean {
  const [major = 0, minor = 0] = version.split('.').map(Number)
  return major > 22 || (major === 22 && minor >= 12)
}
export async function runDoctor(
  options: ClientOptions,
  env: Environment = process.env,
  dependencies: DoctorDependencies = {},
) {
  const stages: DoctorStage[] = []
  const add = (stage: string, status: DoctorStatus, code: string, fix: string) =>
    stages.push({ stage, status, code, fix })
  const validate = dependencies.validateTarget ?? clientTargetValidator(options.dnsServers)
  const send = diagnosticFetch(dependencies.fetchFn)
  const runtime = supportedRuntime(dependencies.nodeVersion ?? process.versions.node)
  add(
    'runtime',
    runtime ? 'pass' : 'fail',
    runtime ? 'RUNTIME_OK' : 'RUNTIME_UNSUPPORTED',
    'Use Node.js 22.12.0 or newer.',
  )
  let targetOk = false,
    serviceOk = false,
    quoteOk = false
  let paymentTerms: Array<{
    network: string
    asset: string
    recipient: string
    amountAtomicUsdc: string
  }> = []
  let targetReason = 'dns_error:resolver_failed'
  if (runtime && options.url) {
    try {
      const result = await validate(options.url)
      targetOk = result.valid
      targetReason = result.reason ?? 'target_invalid'
    } catch {
      /* Static diagnostic below. */
    }
    const dnsFailure = targetReason.startsWith('dns_error:')
    add(
      'target_dns',
      targetOk ? 'pass' : 'fail',
      targetOk ? 'TARGET_PUBLIC' : dnsFailure ? 'TARGET_DNS_FAILED' : 'TARGET_NOT_PUBLIC',
      dnsFailure
        ? 'If direct DNS is refused, supply an explicit trusted IP-only --dns-servers list; OS lookup never bypasses validation.'
        : 'Use a public HTTPS page. Private addresses, unsafe URLs and local destinations remain blocked.',
    )
    const osWorks = await (dependencies.osLookup ?? diagnosticOsLookup)(options.url).catch(
      () => false,
    )
    add(
      'os_dns',
      osWorks ? 'pass' : 'unknown',
      osWorks ? 'OS_LOOKUP_OK_DIAGNOSTIC_ONLY' : 'OS_LOOKUP_UNKNOWN',
      'OS lookup is diagnostic only and never approves a target.',
    )
  } else {
    add('target_dns', 'skipped', 'TARGET_URL_REQUIRED', 'Supply --url with one public HTTPS page.')
    add(
      'os_dns',
      'skipped',
      'TARGET_URL_REQUIRED',
      'Supply --url to compare OS lookup with strict DNS.',
    )
  }
  if (runtime) {
    try {
      const response = await send(`${SERVICE_ORIGIN}/health`, { method: 'GET' })
      serviceOk = response.ok && Boolean(await response.json())
    } catch {
      /* No raw provider messages. */
    }
  }
  add(
    'service',
    serviceOk ? 'pass' : 'unknown',
    serviceOk ? 'SERVICE_REACHABLE' : 'SERVICE_UNAVAILABLE',
    'Check the network and service health, then retry the read-only doctor.',
  )
  if (runtime && targetOk && options.url) {
    try {
      const preview = await runReleaseCheck(
        {
          runId: 'doctor-preview',
          pages: [options.url],
          maxBudgetUsdc: options.budget,
          allowedNetwork: 'eip155:8453',
          ...(options.recipient ? { allowedPayTo: options.recipient } : {}),
        },
        {
          fetchFn: send,
          validateTarget: validate,
          usage: {
            source:
              env.VW_USAGE_SOURCE === 'monitor' || env.VW_USAGE_SOURCE === 'test-client'
                ? env.VW_USAGE_SOURCE
                : 'agent-client',
          },
        },
      )
      if ('paymentTerms' in preview) {
        const term = preview.paymentTerms[0]
        quoteOk =
          preview.dryRun === true &&
          preview.spendingApproved === false &&
          preview.paymentTerms.length === 1 &&
          term?.network === 'eip155:8453' &&
          term.asset.toLowerCase() === BASE_USDC &&
          term.amountAtomicUsdc === '80000' &&
          /^0x[a-fA-F0-9]{40}$/.test(term.recipient) &&
          (!options.recipient || term.recipient === options.recipient)
        if (quoteOk && term)
          paymentTerms = [
            {
              network: term.network,
              asset: term.asset,
              recipient: term.recipient,
              amountAtomicUsdc: term.amountAtomicUsdc,
            },
          ]
      }
    } catch {
      /* No payment adapter exists in this invocation. */
    }
  }
  add(
    'quote',
    targetOk ? (quoteOk ? 'pass' : 'fail') : 'skipped',
    quoteOk ? 'QUOTE_NATIVE_BASE_USDC_008' : 'QUOTE_NOT_CONFIRMED',
    'Require one exact 0.08 native Base USDC quote within your budget; independently approve its recipient. No payment was attempted.',
  )
  const presence = {
    apiKeyId: Boolean(env.CDP_API_KEY_ID),
    apiKeySecret: Boolean(env.CDP_API_KEY_SECRET),
    walletSecret: Boolean(env.CDP_WALLET_SECRET),
    payer: Boolean(options.payer ?? env.VW_PAYER_ADDRESS),
  }
  add(
    'credentials',
    Object.values(presence).every(Boolean) ? 'pass' : 'unknown',
    Object.values(presence).every(Boolean) ? 'CREDENTIALS_PRESENT_ONLY' : 'CREDENTIALS_MISSING',
    'Use secure setup for the selected stage. A Wallet Secret is not needed for the read-only account GET; presence does not validate signing or authorize payment.',
  )
  const payer = options.payer ?? (options.checkAccount ? env.VW_PAYER_ADDRESS : undefined)
  const publicReady = runtime && targetOk && serviceOk && quoteOk
  let accountOk = false,
    balanceOk = false
  if (
    options.checkAccount &&
    publicReady &&
    presence.apiKeyId &&
    presence.apiKeySecret &&
    payer &&
    /^0x[a-fA-F0-9]{40}$/.test(payer)
  ) {
    try {
      await lookupCdpAccount(
        { apiKeyId: env.CDP_API_KEY_ID!, apiKeySecret: env.CDP_API_KEY_SECRET! },
        payer,
        { ...(dependencies.fetchFn ? { fetchFn: dependencies.fetchFn } : {}) },
      )
      accountOk = true
    } catch {
      /* Provider response is deliberately not emitted. */
    }
    add(
      'account',
      accountOk ? 'pass' : 'fail',
      accountOk ? 'CDP_ACCOUNT_GET_OK_SIGNING_UNTESTED' : 'CDP_ACCOUNT_GET_FAILED',
      'Verify the nominated existing account is in the same CDP project as the API key and that your current computer public IP is allowed. Check permissions and address; signing is untested.',
    )
  } else
    add(
      'account',
      'skipped',
      'CDP_ACCOUNT_NOT_CHECKED',
      'After public checks pass, select --check-account with API credentials and the existing public payer address; no Wallet Secret is used.',
    )
  if (publicReady && payer && /^0x[a-fA-F0-9]{40}$/.test(payer)) {
    try {
      balanceOk = (await readBaseUsdcBalance(payer, dependencies.fetchFn)) >= 80000n
      add(
        'base_usdc',
        balanceOk ? 'pass' : 'fail',
        balanceOk ? 'BASE_USDC_BALANCE_SUFFICIENT' : 'BASE_USDC_INSUFFICIENT',
        'At least 0.08 native USDC on Base is needed. Arrange funding separately if desired; this command cannot fund or transfer.',
      )
    } catch (error) {
      add(
        'base_usdc',
        'unknown',
        error instanceof Error && error.message === 'BASE_CHAIN_MISMATCH'
          ? 'BASE_CHAIN_MISMATCH'
          : 'BASE_RPC_UNAVAILABLE',
        'The balance is unknown, not zero. Check the fixed Base RPC network and retry this read-only check.',
      )
    }
  } else
    add(
      'base_usdc',
      'skipped',
      'BASE_USDC_NOT_CHECKED',
      'Supply a valid public --payer address after public checks pass.',
    )
  return {
    schema: 'viewport-witness-doctor/v1',
    stages,
    credentialPresence: presence,
    paymentTerms,
    readyForPreview: publicReady,
    paymentPreconditionsObserved:
      publicReady && accountOk && balanceOk && Object.values(presence).every(Boolean),
    spendingApproved: false,
    signingTested: false,
    walletSecretValidated: false,
    limitations: [
      'Read-only preflight only; successful account GET and balance checks do not prove signing, payment authority or settlement.',
    ],
  }
}
