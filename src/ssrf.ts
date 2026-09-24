import { promises as dns } from 'dns'

// Blocked hostnames (exact match or suffix)
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.',
  '0.0.0.0',
  '::',
  '::1',
  'metadata.google.internal',
])

const BLOCKED_SUFFIXES = [
  '.local',
  '.internal',
  '.lan',
  '.corp',
  '.test',
  '.example',
  '.invalid',
  '.localhost',
]

// Cloud metadata addresses
const METADATA_HOSTS = new Set([
  '169.254.169.254', // AWS, GCP, Azure, DigitalOcean
  'fd00:ec2::254', // AWS IPv6
  '169.254.170.2', // ECS task metadata
])

interface ValidationResult {
  valid: boolean
  reason?: string
}

export function validateUrl(rawUrl: string): ValidationResult {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return { valid: false, reason: 'invalid_url' }
  }

  // Scheme check
  if (parsed.protocol !== 'https:') {
    return { valid: false, reason: `blocked_scheme:${parsed.protocol}` }
  }

  // Credentials in URL
  if (parsed.username || parsed.password) {
    return { valid: false, reason: 'url_credentials_not_allowed' }
  }

  // Port check: only 443 or default (no explicit port)
  if (parsed.port && parsed.port !== '443') {
    return { valid: false, reason: `blocked_port:${parsed.port}` }
  }

  const hostname = parsed.hostname.toLowerCase()

  // Exact hostname blocks
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return { valid: false, reason: `blocked_host:${hostname}` }
  }

  // Metadata service checks
  if (METADATA_HOSTS.has(hostname)) {
    return { valid: false, reason: 'blocked_metadata_service' }
  }

  // Suffix blocks
  for (const suffix of BLOCKED_SUFFIXES) {
    if (hostname === suffix.slice(1) || hostname.endsWith(suffix)) {
      return { valid: false, reason: `blocked_host_suffix:${suffix}` }
    }
  }

  // IP address checks (inline)
  const ipResult = checkIp(hostname)
  if (!ipResult.safe) {
    return { valid: false, reason: ipResult.reason ?? 'blocked_ip' }
  }

  // IPv6 literal in brackets
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    const ipv6 = hostname.slice(1, -1)
    const ipv6Result = checkIpv6(ipv6)
    if (!ipv6Result.safe) {
      return { valid: false, reason: ipv6Result.reason ?? 'blocked_ipv6' }
    }
  }

  return { valid: true }
}

interface SafetyResult {
  safe: boolean
  reason?: string
}

function checkIp(host: string): SafetyResult {
  // IPv4 check
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return checkIpv4(host)
  }
  // IPv6 literal (without brackets)
  if (host.includes(':')) {
    return checkIpv6(host)
  }
  return { safe: true }
}

function ipv4ToInt(ip: string): number {
  const parts = ip.split('.').map(Number)
  return (
    (((parts[0] ?? 0) << 24) |
      ((parts[1] ?? 0) << 16) |
      ((parts[2] ?? 0) << 8) |
      (parts[3] ?? 0)) >>>
    0
  )
}

function inCidr(ip: string, cidr: string): boolean {
  const [network, bits] = cidr.split('/')
  if (!network || !bits) return false
  const mask = ~((1 << (32 - parseInt(bits, 10))) - 1) >>> 0
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(network) & mask)
}

const BLOCKED_IPV4_CIDRS = [
  '0.0.0.0/8', // Unspecified
  '10.0.0.0/8', // RFC1918
  '100.64.0.0/10', // Carrier-grade NAT
  '127.0.0.0/8', // Loopback
  '169.254.0.0/16', // Link-local / metadata
  '172.16.0.0/12', // RFC1918
  '192.0.0.0/24', // IETF Protocol Assignments
  '192.0.2.0/24', // Documentation (TEST-NET-1)
  '192.168.0.0/16', // RFC1918
  '198.18.0.0/15', // Benchmarking
  '198.51.100.0/24', // Documentation (TEST-NET-2)
  '203.0.113.0/24', // Documentation (TEST-NET-3)
  '224.0.0.0/4', // Multicast
  '240.0.0.0/4', // Reserved
  '255.255.255.255/32', // Broadcast
]

function checkIpv4(ip: string): SafetyResult {
  for (const cidr of BLOCKED_IPV4_CIDRS) {
    if (inCidr(ip, cidr)) {
      return { safe: false, reason: `blocked_ipv4_range:${cidr}` }
    }
  }
  return { safe: true }
}

function expandIpv6(addr: string): bigint {
  // Handle ::ffff:a.b.c.d (IPv4-mapped)
  const ipv4Mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr)
  if (ipv4Mapped?.[1]) {
    const ipv4Parts = ipv4Mapped[1].split('.').map(Number)
    const ipv4Int = BigInt(
      ((ipv4Parts[0] ?? 0) << 24) |
        ((ipv4Parts[1] ?? 0) << 16) |
        ((ipv4Parts[2] ?? 0) << 8) |
        (ipv4Parts[3] ?? 0),
    )
    return (BigInt('0xffff') << BigInt(32)) | ipv4Int
  }

  const halves = addr.split('::')
  if (halves.length > 2) return BigInt(0)

  const left = halves[0] ? halves[0].split(':') : []
  const right = halves[1] ? halves[1].split(':') : []
  const missing = 8 - left.length - right.length
  const groups = [...left, ...Array(missing).fill('0'), ...right]

  let result = BigInt(0)
  for (const g of groups) {
    result = (result << BigInt(16)) | BigInt(parseInt(g || '0', 16))
  }
  return result
}

function inIpv6Cidr(addr: string, cidr: string): boolean {
  const [network, bits] = cidr.split('/')
  if (!network || !bits) return false
  const prefixLen = parseInt(bits, 10)
  const addrInt = expandIpv6(addr)
  const netInt = expandIpv6(network)
  const shift = BigInt(128 - prefixLen)
  return addrInt >> shift === netInt >> shift
}

const BLOCKED_IPV6_CIDRS = [
  '::/128', // Unspecified
  '::1/128', // Loopback
  '::ffff:0:0/96', // IPv4-mapped (check ipv4 sub-ranges separately)
  '64:ff9b::/96', // IPv4/IPv6 translation
  '100::/64', // Discard
  '2001::/23', // IETF Protocol Assignments
  '2001:db8::/32', // Documentation
  'fc00::/7', // Unique local
  'fe80::/10', // Link-local
  'ff00::/8', // Multicast
]

function checkIpv6(addr: string): SafetyResult {
  // IPv4-mapped check: ::ffff:x.x.x.x
  const ipv4Mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr)
  if (ipv4Mapped?.[1]) {
    const ipv4Result = checkIpv4(ipv4Mapped[1])
    if (!ipv4Result.safe) {
      return { safe: false, reason: `blocked_ipv4_mapped:${ipv4Mapped[1]}` }
    }
  }

  for (const cidr of BLOCKED_IPV6_CIDRS) {
    try {
      if (inIpv6Cidr(addr, cidr)) {
        return { safe: false, reason: `blocked_ipv6_range:${cidr}` }
      }
    } catch {
      // ignore parse errors for this cidr
    }
  }
  return { safe: true }
}

export async function resolveAndCheck(hostname: string): Promise<SafetyResult> {
  // If hostname is already an IP, check directly
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    return checkIpv4(hostname)
  }
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    return checkIpv6(hostname.slice(1, -1))
  }

  const errors: string[] = []
  let resolvedAddresses = 0

  try {
    const v4Addrs = await dns.resolve4(hostname)
    resolvedAddresses += v4Addrs.length
    for (const addr of v4Addrs) {
      const result = checkIpv4(addr)
      if (!result.safe) {
        return { safe: false, reason: result.reason ?? `blocked_resolved_ip:${addr}` }
      }
    }
  } catch (err: unknown) {
    // ENOTFOUND is expected for non-existent hostnames; collect for later
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOTFOUND' && code !== 'ENODATA') {
      errors.push(`ipv4_resolve_error:${code}`)
    }
  }

  try {
    const v6Addrs = await dns.resolve6(hostname)
    resolvedAddresses += v6Addrs.length
    for (const addr of v6Addrs) {
      const result = checkIpv6(addr)
      if (!result.safe) {
        return { safe: false, reason: result.reason ?? `blocked_resolved_ipv6:${addr}` }
      }
    }
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOTFOUND' && code !== 'ENODATA') {
      errors.push(`ipv6_resolve_error:${code}`)
    }
  }

  if (errors.length > 0) {
    // DNS errors (not NXDOMAIN) - fail safe
    return { safe: false, reason: `dns_error:${errors.join(',')}` }
  }

  if (resolvedAddresses === 0) {
    return { safe: false, reason: 'dns_no_records' }
  }

  return { safe: true }
}
