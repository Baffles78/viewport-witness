import { describe, it, expect } from 'vitest'
import { validateUrl } from '../src/ssrf.js'

describe('validateUrl - blocked URLs', () => {
  const blocked: Array<[string, string]> = [
    ['http://example.com', 'non-https scheme'],
    ['ftp://example.com', 'ftp scheme'],
    ['file:///etc/passwd', 'file scheme'],
    ['data:text/html,<h1>hi</h1>', 'data scheme'],
    ['blob:https://example.com/abc', 'blob scheme'],
    ['javascript:alert(1)', 'javascript scheme'],
    ['https://user:pass@example.com', 'url credentials'],
    ['https://example.com:8080', 'non-443 port'],
    ['https://example.com:80', 'port 80'],
    ['https://localhost', 'localhost hostname'],
    ['https://localhost.', 'localhost with dot'],
    ['https://127.0.0.1', 'loopback ipv4'],
    ['https://127.0.0.2', 'loopback ipv4 subnet'],
    ['https://0.0.0.0', 'unspecified ipv4'],
    ['https://169.254.169.254', 'cloud metadata'],
    ['https://169.254.170.2', 'link-local'],
    ['https://10.0.0.1', 'RFC1918 10.x'],
    ['https://10.255.255.255', 'RFC1918 10.x max'],
    ['https://172.16.0.1', 'RFC1918 172.16.x'],
    ['https://172.31.255.255', 'RFC1918 172.31.x max'],
    ['https://192.168.1.1', 'RFC1918 192.168.x'],
    ['https://192.168.0.1', 'RFC1918 192.168.x'],
    ['https://100.64.0.1', 'CGNAT'],
    ['https://100.127.255.255', 'CGNAT max'],
    ['https://[::1]', 'ipv6 loopback'],
    ['https://[fe80::1]', 'ipv6 link-local'],
    ['https://[ff00::1]', 'ipv6 multicast'],
    ['https://[fc00::1]', 'ipv6 unique local'],
    ['https://example.local', '.local suffix'],
    ['https://service.internal', '.internal suffix'],
    ['https://host.lan', '.lan suffix'],
    ['https://host.corp', '.corp suffix'],
    ['https://host.test', '.test suffix'],
    ['https://host.example', '.example suffix'],
    ['https://host.invalid', '.invalid suffix'],
    ['https://host.localhost', '.localhost suffix'],
  ]

  it.each(blocked)('%s should be blocked (%s)', (url, _reason) => {
    const result = validateUrl(url)
    expect(result.valid).toBe(false)
    expect(result.reason).toBeDefined()
  })
})

describe('validateUrl - allowed URLs', () => {
  it('allows https://example.com', () => {
    expect(validateUrl('https://example.com').valid).toBe(true)
  })

  it('allows https://github.com', () => {
    expect(validateUrl('https://github.com').valid).toBe(true)
  })

  it('allows https://api.example.com/path?query=1', () => {
    expect(validateUrl('https://api.example.com/path?query=1').valid).toBe(true)
  })

  it('allows https://example.com:443 (explicit 443)', () => {
    expect(validateUrl('https://example.com:443').valid).toBe(true)
  })
})

describe('validateUrl - IPv6 mapped IPv4', () => {
  it('blocks ::ffff:10.0.0.1 (IPv4-mapped RFC1918)', () => {
    const result = validateUrl('https://[::ffff:10.0.0.1]')
    expect(result.valid).toBe(false)
  })

  it('blocks ::ffff:192.168.1.1 (IPv4-mapped RFC1918)', () => {
    const result = validateUrl('https://[::ffff:192.168.1.1]')
    expect(result.valid).toBe(false)
  })

  it('blocks ::ffff:127.0.0.1 (IPv4-mapped loopback)', () => {
    const result = validateUrl('https://[::ffff:127.0.0.1]')
    expect(result.valid).toBe(false)
  })
})

describe('validateUrl - documentation and reserved ranges', () => {
  it('blocks 192.0.2.1 (documentation TEST-NET-1)', () => {
    const result = validateUrl('https://192.0.2.1')
    expect(result.valid).toBe(false)
  })

  it('blocks 198.51.100.1 (documentation TEST-NET-2)', () => {
    const result = validateUrl('https://198.51.100.1')
    expect(result.valid).toBe(false)
  })

  it('blocks 203.0.113.1 (documentation TEST-NET-3)', () => {
    const result = validateUrl('https://203.0.113.1')
    expect(result.valid).toBe(false)
  })

  it('blocks 224.0.0.1 (multicast)', () => {
    const result = validateUrl('https://224.0.0.1')
    expect(result.valid).toBe(false)
  })
})

describe('validateUrl - port handling', () => {
  it('blocks port 22', () => {
    expect(validateUrl('https://example.com:22').valid).toBe(false)
  })

  it('blocks port 3000', () => {
    expect(validateUrl('https://example.com:3000').valid).toBe(false)
  })

  it('allows no port', () => {
    expect(validateUrl('https://example.com').valid).toBe(true)
  })
})

describe('validateUrl - invalid input', () => {
  it('rejects empty string', () => {
    expect(validateUrl('').valid).toBe(false)
  })

  it('rejects non-URL string', () => {
    expect(validateUrl('not a url').valid).toBe(false)
  })
})
