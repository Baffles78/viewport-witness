import { describe, expect, it, vi } from 'vitest'
import { clientTargetValidator, parseDnsServers } from '../src/client/dns.js'
import { diagnosticFetch, SERVICE_ORIGIN } from '../src/client/network.js'
import { parseClientOptions } from '../src/client/options.js'
import {
  setupStageArgs,
  safeSetupEnvironment,
  executionOutput,
} from '../src/client/setup-options.js'
import path from 'node:path'

describe('strict per-client DNS configuration', () => {
  it('requires an explicit bounded IP-only list', () => {
    expect(parseDnsServers('1.1.1.1,2606:4700:4700::1111')).toEqual([
      '1.1.1.1',
      '2606:4700:4700::1111',
    ])
    for (const value of [
      '',
      'dns.google',
      '1.1.1.1:53',
      '1.1.1.1,',
      Array(5).fill('1.1.1.1').join(','),
    ])
      expect(() => parseDnsServers(value)).toThrow()
  })
  it('checks both families and every address; one operational family failure closes approval', async () => {
    const resolver = {
      resolve4: vi.fn(async () => ['93.184.216.34']),
      resolve6: vi.fn(async () => {
        throw Object.assign(new Error('SENTINEL'), { code: 'ECONNREFUSED' })
      }),
    }
    expect(await clientTargetValidator(['1.1.1.1'], resolver)('https://example.com')).toEqual({
      valid: false,
      reason: 'dns_error:resolver_failed',
    })
    expect(resolver.resolve4).toHaveBeenCalledTimes(1)
    expect(resolver.resolve6).toHaveBeenCalledTimes(1)
    resolver.resolve6.mockImplementation(async () => ['2606:4700:4700::1111', '::1'])
    expect((await clientTargetValidator(undefined, resolver)('https://example.com')).valid).toBe(
      false,
    )
    resolver.resolve4.mockImplementation(async () => ['93.184.216.34', '10.0.0.1'])
    expect((await clientTargetValidator(undefined, resolver)('https://example.com')).valid).toBe(
      false,
    )
  })
  it('accepts public A with an empty expected AAAA family and never mutates global DNS', async () => {
    const resolver = {
      resolve4: async () => ['93.184.216.34'],
      resolve6: async () => {
        throw Object.assign(new Error(), { code: 'ENODATA' })
      },
    }
    expect(await clientTargetValidator(undefined, resolver)('https://example.com')).toEqual({
      valid: true,
    })
    expect((await clientTargetValidator(undefined, resolver)('https://127.0.0.1')).valid).toBe(
      false,
    )
  })
})
describe('onboarding transport and execution boundaries', () => {
  it('blocks new endpoints and redirects without forwarding secrets', async () => {
    const send = vi.fn(
      async () =>
        new Response(null, { status: 307, headers: { location: 'https://evil.example' } }),
    )
    const safe = diagnosticFetch(send as unknown as typeof fetch)
    await expect(safe('https://evil.example/', { method: 'POST' })).rejects.toThrow(
      'ENDPOINT_INVALID',
    )
    const response = await safe(`${SERVICE_ORIGIN}/health`, { method: 'GET' })
    expect(response.status).toBe(307)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error' })
  })
  it('bounds slow/chunked bodies, late fetch responses, and oversize headers', async () => {
    const endpoint = `${SERVICE_ORIGIN}/health`
    let cancelled = false
    const stream = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(65537))
        },
        cancel() {
          cancelled = true
        },
      })
    await expect(diagnosticFetch(async () => new Response(stream()))(endpoint)).rejects.toThrow(
      'DIAGNOSTIC_REQUEST_FAILED',
    )
    expect(cancelled).toBe(true)
    const stalled = new ReadableStream<Uint8Array>({})
    await expect(diagnosticFetch(async () => new Response(stalled), 5)(endpoint)).rejects.toThrow(
      'DIAGNOSTIC_REQUEST_FAILED',
    )
    let resolve!: (value: Response) => void
    await expect(
      diagnosticFetch(
        () =>
          new Promise<Response>((ready) => {
            resolve = ready
          }),
        5,
      )(endpoint),
    ).rejects.toThrow('DIAGNOSTIC_REQUEST_FAILED')
    let lateCancelled = false
    resolve(
      new Response(
        new ReadableStream({
          cancel() {
            lateCancelled = true
          },
        }),
      ),
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(lateCancelled).toBe(true)
    await expect(
      diagnosticFetch(
        async () =>
          new Response(null, { status: 402, headers: { 'payment-required': 'x'.repeat(65537) } }),
      )(endpoint),
    ).rejects.toThrow('DIAGNOSTIC_REQUEST_FAILED')
  })
  it('default setup has no execution authority; explicit policy is necessary and preserved', () => {
    expect(setupStageArgs('public', ['--url', 'https://example.com'])).not.toContain('--execute')
    expect(() => setupStageArgs('execute', ['--url', 'https://example.com'])).toThrow(
      'EXECUTION_POLICY_REQUIRED',
    )
    expect(() => parseClientOptions(['--execute', '--url', 'https://example.com'], true)).toThrow()
    const args = [
      '--execute',
      '--url',
      'https://example.com',
      '--run-id',
      'same-run',
      '--network',
      'base',
      '--recipient',
      `0x${'22'.repeat(20)}`,
      '--budget',
      '0.08',
      '--dns-servers',
      '1.1.1.1',
    ]
    const execution = setupStageArgs('execute', args)
    expect(execution).toContain('same-run')
    expect(execution).toContain('1.1.1.1')
    expect(execution.filter((flag) => flag === '--execute')).toHaveLength(1)
    expect(setupStageArgs('resume', ['--resume', '--output', 'folder with spaces'])).toEqual([
      '--resume',
      '--output',
      'folder with spaces',
    ])
  })
  it('removes inherited credentials/preload/debug/TLS bypass from child environments', () => {
    const env = safeSetupEnvironment({
      PATH: 'kept',
      NODE_OPTIONS: 'SENTINEL',
      node_path: 'SENTINEL',
      NODE_DEBUG: 'SENTINEL',
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
      CDP_API_KEY_SECRET: 'SENTINEL',
      CDP_WALLET_SECRET: 'SENTINEL',
      VW_PAYER_ADDRESS: 'SENTINEL',
    })
    expect(env).toEqual({ PATH: 'kept' })
  })
  it('defaults execution to the user run directory rather than the terminal directory', () => {
    const home = path.resolve('test-home'),
      local = path.join(home, 'local-data')
    expect(executionOutput({ runId: 'same-run' }, local, home)).toBe(
      path.join(local, 'ViewportWitness', 'runs', 'same-run'),
    )
    expect(executionOutput({ runId: 'same-run' }, undefined, home)).toBe(
      path.join(home, 'AppData', 'Local', 'ViewportWitness', 'runs', 'same-run'),
    )
  })
})
