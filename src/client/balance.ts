import { BASE_RPC, diagnosticFetch } from './network.js'

export const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
export async function readBaseUsdcBalance(
  payer: string,
  fetchFn: typeof fetch = fetch,
): Promise<bigint> {
  if (!/^0x[a-fA-F0-9]{40}$/.test(payer)) throw new Error('PAYER_INVALID')
  const send = diagnosticFetch(fetchFn)
  const rpc = async (id: number, method: string, params: unknown[]) => {
    const response = await send(`${BASE_RPC}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    })
    const value: unknown = await response.json()
    if (!response.ok || !value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('BASE_RPC_FAILED')
    const result = value as Record<string, unknown>
    if (
      result.jsonrpc !== '2.0' ||
      result.id !== id ||
      result.error ||
      typeof result.result !== 'string'
    )
      throw new Error('BASE_RPC_FAILED')
    return result.result
  }
  if ((await rpc(1, 'eth_chainId', [])) !== '0x2105') throw new Error('BASE_CHAIN_MISMATCH')
  const value = await rpc(2, 'eth_call', [
    { to: BASE_USDC, data: `0x70a08231${payer.slice(2).toLowerCase().padStart(64, '0')}` },
    'latest',
  ])
  if (!/^0x[a-fA-F0-9]{64}$/.test(value)) throw new Error('BASE_BALANCE_INVALID')
  return BigInt(value)
}
