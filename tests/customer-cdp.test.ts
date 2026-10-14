import { describe, expect, it, vi } from 'vitest'
import { connectExistingCdpBaseAccount } from '../src/customer-cdp.js'

const address = `0x${'11'.repeat(20)}` as const
const env = {
  CDP_API_KEY_ID: 'fixture-id',
  CDP_API_KEY_SECRET: 'fixture-secret',
  CDP_WALLET_SECRET: 'fixture-wallet',
  VW_PAYER_ADDRESS: address,
}
describe('existing customer CDP connector', () => {
  it('refuses missing configuration before accessing CDP', async () => {
    const create = vi.fn()
    await expect(connectExistingCdpBaseAccount({}, create)).rejects.toThrow(
      'Existing CDP account requires',
    )
    expect(create).not.toHaveBeenCalled()
  })
  it('looks up only the nominated existing account and exposes signing capability', async () => {
    const account = { address, signTypedData: vi.fn(async () => `0x${'22'.repeat(65)}` as const) }
    const getAccount = vi.fn(async () => account)
    const create = vi.fn(() => ({ evm: { getAccount } }))
    const signer = await connectExistingCdpBaseAccount(env, create)
    expect(getAccount).toHaveBeenCalledExactlyOnceWith({ address })
    expect(signer.address).toBe(address)
    expect(typeof signer.signTypedData).toBe('function')
    expect(account.signTypedData).not.toHaveBeenCalled()
  })
  it('does not expose provider errors or accept a different payer', async () => {
    await expect(
      connectExistingCdpBaseAccount(env, () => ({
        evm: {
          getAccount: async () => {
            throw new Error('fixture-secret')
          },
        },
      })),
    ).rejects.toThrow('Could not access')
    await expect(
      connectExistingCdpBaseAccount(env, () => ({
        evm: {
          getAccount: async () => ({ address: `0x${'22'.repeat(20)}`, signTypedData: vi.fn() }),
        },
      })),
    ).rejects.toThrow('different account')
  })
})
