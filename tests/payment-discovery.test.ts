import { describe, it, expect } from 'vitest'
import { getPaymentDiscovery } from '../src/payment/index.js'
import { baseOpts } from './helpers/payment-middleware.js'

describe('payment discovery - pricing and network regression', () => {
  it('getPaymentDiscovery returns $0.08 USDC price in testnet mode', () => {
    const discovery = getPaymentDiscovery({ ...baseOpts, mode: 'testnet' })
    expect(discovery.price).toBe('$0.08 USDC')
    expect(discovery.asset).toBe('USDC')
    expect(discovery.paymentRequired).toBe(true)
  })

  it('getPaymentDiscovery returns $0.08 USDC price in production mode', () => {
    const discovery = getPaymentDiscovery({ ...baseOpts, mode: 'production', enableMainnet: true })
    expect(discovery.price).toBe('$0.08 USDC')
    expect(discovery.paymentRequired).toBe(true)
  })

  it('getPaymentDiscovery returns base-sepolia network for testnet', () => {
    const discovery = getPaymentDiscovery({ ...baseOpts, mode: 'testnet' })
    expect(discovery.network).toContain('84532')
  })

  it('getPaymentDiscovery returns base mainnet network for production', () => {
    const discovery = getPaymentDiscovery({ ...baseOpts, mode: 'production', enableMainnet: true })
    expect(discovery.network).toContain('8453')
    expect(discovery.network).not.toContain('84532')
  })

  it('getPaymentDiscovery preserves payTo address unchanged', () => {
    const discovery = getPaymentDiscovery({ ...baseOpts, mode: 'testnet' })
    expect(discovery.payTo).toBe('0xe5fa9502bd9f32a0fc90f2c809296b4835c2c400')
  })

  it('advertises Base and Solana together when the second rail is enabled', () => {
    const discovery = getPaymentDiscovery({
      ...baseOpts,
      mode: 'production',
      enableMainnet: true,
      enableSolana: true,
      solanaPayTo: 'EcgBX5ydNsGfJDrmW2qzNtJenDud8sNGSZBtt3XH2WJk',
    })

    expect(discovery.accepts).toHaveLength(2)
    expect(discovery.accepts[0]).toMatchObject({ network: expect.stringContaining('8453') })
    expect(discovery.accepts[1]).toEqual({
      scheme: 'exact',
      network: expect.stringContaining('solana:5eykt4'),
      asset: 'USDC',
      payTo: 'EcgBX5ydNsGfJDrmW2qzNtJenDud8sNGSZBtt3XH2WJk',
    })
  })

  it('does not advertise Solana unless the explicit switch is enabled', () => {
    const discovery = getPaymentDiscovery({
      ...baseOpts,
      mode: 'production',
      enableMainnet: true,
      solanaPayTo: 'EcgBX5ydNsGfJDrmW2qzNtJenDud8sNGSZBtt3XH2WJk',
    })
    expect(discovery.accepts).toHaveLength(1)
  })

  it('testMode flag is true only for test payment mode', () => {
    expect(getPaymentDiscovery({ ...baseOpts, mode: 'test' }).testMode).toBe(true)
    expect(getPaymentDiscovery({ ...baseOpts, mode: 'testnet' }).testMode).toBe(false)
    expect(
      getPaymentDiscovery({ ...baseOpts, mode: 'production', enableMainnet: true }).testMode,
    ).toBe(false)
  })
})

describe('payment discovery - crawler enrichment', () => {
  it('returns endpoint, method, skillMdUrl, openapiUrl when baseUrl provided', () => {
    const discovery = getPaymentDiscovery(
      { ...baseOpts, mode: 'testnet' },
      'https://qa.honeygate.app',
    )
    expect(discovery.endpoint).toBe('POST https://qa.honeygate.app/v1/checks')
    expect(discovery.method).toBe('POST')
    expect(discovery.skillMdUrl).toBe('https://qa.honeygate.app/skill.md')
    expect(discovery.openapiUrl).toBe('https://qa.honeygate.app/openapi.json')
    expect(discovery.description).toBeTruthy()
  })

  it('omits crawler fields when no baseUrl provided (backwards compatible)', () => {
    const discovery = getPaymentDiscovery({ ...baseOpts, mode: 'testnet' })
    expect(discovery.endpoint).toBeUndefined()
    expect(discovery.method).toBeUndefined()
    expect(discovery.skillMdUrl).toBeUndefined()
    expect(discovery.openapiUrl).toBeUndefined()
  })

  it('does not claim settlement volume, MCP compatibility, or registry acceptance', () => {
    const discovery = getPaymentDiscovery(
      { ...baseOpts, mode: 'testnet' },
      'https://qa.honeygate.app',
    )
    const json = JSON.stringify(discovery)
    expect(json).not.toMatch(/settlement.volume/i)
    expect(json).not.toMatch(/mcp.compat/i)
    expect(json).not.toMatch(/registry.accept/i)
    expect(json).not.toMatch(/registered/i)
  })
})
