import { Resolver, lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { validateUrl } from '../ssrf.js'

export function parseDnsServers(value?: string): string[] | undefined {
  if (value === undefined) return undefined
  const servers = value.split(',')
  if (
    value.length > 200 ||
    servers.length < 1 ||
    servers.length > 4 ||
    servers.some((ip) => !isIP(ip))
  )
    throw new Error('DNS_SERVERS_INVALID')
  return servers
}
export interface TargetResolver {
  resolve4(host: string): Promise<string[]>
  resolve6(host: string): Promise<string[]>
}
export function clientTargetValidator(servers?: string[], supplied?: TargetResolver) {
  const resolver = supplied ?? new Resolver({ timeout: 3000, tries: 1 })
  if (servers) {
    parseDnsServers(servers.join(','))
    if (!supplied) (resolver as Resolver).setServers(servers)
  }
  return async (url: string): Promise<{ valid: boolean; reason?: string }> => {
    const syntactic = validateUrl(url)
    if (!syntactic.valid || url.length > 2048) return { valid: false, reason: 'target_invalid' }
    const hostname = new URL(url).hostname
    if (isIP(hostname.replace(/^\[|\]$/g, ''))) return { valid: true }
    const results = await Promise.allSettled([
      resolver.resolve4(hostname),
      resolver.resolve6(hostname),
    ])
    let count = 0
    for (const [index, result] of results.entries()) {
      if (result.status === 'rejected') {
        if (
          !['ENODATA', 'ENOTFOUND'].includes((result.reason as NodeJS.ErrnoException)?.code ?? '')
        )
          return { valid: false, reason: 'dns_error:resolver_failed' }
      } else {
        if (result.value.length > 100) return { valid: false, reason: 'dns_error:too_many_records' }
        for (const address of result.value) {
          if (
            isIP(address) !== (index === 0 ? 4 : 6) ||
            !validateUrl(`https://${index === 0 ? address : `[${address}]`}`).valid
          )
            return { valid: false, reason: 'target_private_address' }
          count++
        }
      }
    }
    return count ? { valid: true } : { valid: false, reason: 'dns_error:no_records' }
  }
}
export async function diagnosticOsLookup(url: string, lookupFn = lookup): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      lookupFn(new URL(url).hostname).then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), 3000)
      }),
    ])
  } catch {
    return false
  } finally {
    if (timer) clearTimeout(timer)
  }
}
