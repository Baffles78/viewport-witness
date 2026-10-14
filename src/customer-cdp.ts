import { CdpClient } from '@coinbase/cdp-sdk'
import { fromCdpEvmAccount, type CdpEvmAccount } from '@coinbase/cdp-sdk/x402'
import type { Address } from 'viem'
import type { ClientEvmSigner } from '@x402/evm'

type CustomerEnvironment = Record<string, string | undefined>
type LookupClient = { evm: { getAccount(options: { address: Address }): Promise<CdpEvmAccount> } }
type Credentials = { apiKeyId: string; apiKeySecret: string; walletSecret: string }

/** Customer-side helper. Resolves an existing account; never provisions, funds or submits a transaction. */
export async function connectExistingCdpBaseAccount(
  env: CustomerEnvironment = process.env,
  createClient: (credentials: Credentials) => LookupClient = (credentials) =>
    new CdpClient(credentials),
): Promise<ClientEvmSigner> {
  const required = [
    'CDP_API_KEY_ID',
    'CDP_API_KEY_SECRET',
    'CDP_WALLET_SECRET',
    'VW_PAYER_ADDRESS',
  ] as const
  if (required.some((name) => !env[name]?.trim()))
    throw new Error(
      'Existing CDP account requires CDP_API_KEY_ID, CDP_API_KEY_SECRET, CDP_WALLET_SECRET and VW_PAYER_ADDRESS in your local environment; never paste them into commands or reports.',
    )
  const address = env.VW_PAYER_ADDRESS!
  if (!/^0x[a-fA-F0-9]{40}$/.test(address))
    throw new Error('VW_PAYER_ADDRESS must identify your existing EVM account')
  const client = createClient({
    apiKeyId: env.CDP_API_KEY_ID!,
    apiKeySecret: env.CDP_API_KEY_SECRET!,
    walletSecret: env.CDP_WALLET_SECRET!,
  })
  let account: CdpEvmAccount
  try {
    account = await client.evm.getAccount({ address: address as Address })
  } catch {
    throw new Error(
      'Could not access that existing CDP account. Check its address, credentials and account permissions; no new wallet was created.',
    )
  }
  if (account.address.toLowerCase() !== address.toLowerCase())
    throw new Error('CDP returned a different account; signing refused')
  return fromCdpEvmAccount(account)
}
