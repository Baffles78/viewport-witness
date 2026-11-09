import { afterEach, describe, expect, it } from 'vitest'
import { servers, makeConfig, startInfoServer } from './helpers/mcp-server.js'

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.close(() => resolve())
        }),
    ),
  )
})

describe('GET /privacy', () => {
  it('returns 200', async () => {
    const { port } = await startInfoServer(makeConfig())
    const res = await fetch(`http://127.0.0.1:${port}/privacy`)
    expect(res.status).toBe(200)
  })

  it('returns text/markdown content-type', async () => {
    const { port } = await startInfoServer(makeConfig())
    const res = await fetch(`http://127.0.0.1:${port}/privacy`)
    expect(res.headers.get('content-type')).toMatch(/text\/markdown|text\/plain/)
  })

  it('mentions data retention', async () => {
    const { port } = await startInfoServer(makeConfig())
    const res = await fetch(`http://127.0.0.1:${port}/privacy`)
    const text = await res.text()
    expect(text.toLowerCase()).toContain('retent')
  })

  it('mentions submitted URLs', async () => {
    const { port } = await startInfoServer(makeConfig())
    const res = await fetch(`http://127.0.0.1:${port}/privacy`)
    const text = await res.text()
    expect(text.toLowerCase()).toContain('url')
  })

  it('mentions screenshots', async () => {
    const { port } = await startInfoServer(makeConfig())
    const res = await fetch(`http://127.0.0.1:${port}/privacy`)
    const text = await res.text()
    expect(text.toLowerCase()).toContain('screenshot')
  })

  it('does not claim to have a named legal jurisdiction or company address', async () => {
    const { port } = await startInfoServer(makeConfig())
    const res = await fetch(`http://127.0.0.1:${port}/privacy`)
    const text = await res.text()
    expect(text).not.toMatch(/incorporated in|registered in|based in|GDPR|CCPA/i)
  })
})

describe('GET /terms', () => {
  it('returns 200', async () => {
    const { port } = await startInfoServer(makeConfig())
    const res = await fetch(`http://127.0.0.1:${port}/terms`)
    expect(res.status).toBe(200)
  })

  it('returns text/markdown content-type', async () => {
    const { port } = await startInfoServer(makeConfig())
    const res = await fetch(`http://127.0.0.1:${port}/terms`)
    expect(res.headers.get('content-type')).toMatch(/text\/markdown|text\/plain/)
  })

  it('mentions paid automated QA and x402', async () => {
    const { port } = await startInfoServer(makeConfig())
    const res = await fetch(`http://127.0.0.1:${port}/terms`)
    const text = await res.text()
    expect(text.toLowerCase()).toContain('paid')
    expect(text.toLowerCase()).toContain('x402')
  })

  it('mentions public HTTPS target authorisation', async () => {
    const { port } = await startInfoServer(makeConfig())
    const res = await fetch(`http://127.0.0.1:${port}/terms`)
    const text = await res.text()
    expect(text.toLowerCase()).toContain('authoris')
  })

  it('mentions non-mutating browser behaviour', async () => {
    const { port } = await startInfoServer(makeConfig())
    const res = await fetch(`http://127.0.0.1:${port}/terms`)
    const text = await res.text()
    expect(text.toLowerCase()).toMatch(/read.only|non.mutat/)
  })

  it('mentions report expiry', async () => {
    const { port } = await startInfoServer(makeConfig())
    const res = await fetch(`http://127.0.0.1:${port}/terms`)
    const text = await res.text()
    expect(text.toLowerCase()).toContain('expir')
  })

  it('mentions crypto payment finality', async () => {
    const { port } = await startInfoServer(makeConfig())
    const res = await fetch(`http://127.0.0.1:${port}/terms`)
    const text = await res.text()
    expect(text.toLowerCase()).toMatch(/final|irreversible|refund/)
  })

  it('does not claim a specific company name, jurisdiction, or legal guarantee', async () => {
    const { port } = await startInfoServer(makeConfig())
    const res = await fetch(`http://127.0.0.1:${port}/terms`)
    const text = await res.text()
    expect(text).not.toMatch(/incorporated in|registered in|Ltd\.|LLC\.|Inc\./i)
  })
})

describe('GET /logo.png', () => {
  it('returns the directory logo as PNG', async () => {
    const { port } = await startInfoServer(makeConfig())
    const res = await fetch(`http://127.0.0.1:${port}/logo.png`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/image\/png/)
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(1_000)
  })
})

describe('GET /favicon.ico', () => {
  it('serves the service icon for directory discovery', async () => {
    const { port } = await startInfoServer(makeConfig())
    const res = await fetch(`http://127.0.0.1:${port}/favicon.ico`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('image/png')
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0)
  })
})
