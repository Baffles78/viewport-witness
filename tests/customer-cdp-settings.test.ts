import { describe, expect, it } from 'vitest'
import { missingCdpCustomerSettings } from '../src/customer-cdp-settings.js'

describe('non-secret CDP setup diagnostics', () => {
  it('returns only missing variable names, never their configured values', () => {
    expect(
      missingCdpCustomerSettings({
        CDP_API_KEY_ID: 'fixture-secret-value',
        CDP_API_KEY_SECRET: ' ',
      }),
    ).toEqual(['CDP_API_KEY_SECRET', 'CDP_WALLET_SECRET', 'VW_PAYER_ADDRESS'])
    expect(
      JSON.stringify(missingCdpCustomerSettings({ CDP_API_KEY_ID: 'fixture-secret-value' })),
    ).not.toContain('fixture-secret-value')
  })
})
