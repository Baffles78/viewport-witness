import https from 'node:https'
import type { LookupFunction } from 'node:net'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import { resolvePublicAddresses, validateUrl } from './ssrf.js'

const BYTE_LIMIT = 1024 * 1024
const REDIRECT_LIMIT = 5
export const WEB_JOB_BUDGET_MS = 8_000
const HTML_TYPES = new Set(['text/html', 'application/xhtml+xml'])

export interface BoundedHtml {
  finalUrl: string
  html: string
  inputBytes: number
  contentType: string
  redirects: number
  headers: Headers
  fetchedAt: string
}

interface PinnedResponse {
  status: number
  url: string
  headers: Headers
  body: Buffer
}

export type PublicResolver = typeof resolvePublicAddresses
export type PinnedRequester = (
  url: URL,
  pinned: { address: string; family: 4 | 6 },
  signal: AbortSignal,
) => Promise<PinnedResponse>

export interface FetchBoundedHtmlOptions {
  resolver?: PublicResolver
  requester?: PinnedRequester
}

export function createPinnedLookup(pinned: { address: string; family: 4 | 6 }): LookupFunction {
  return (_hostname, options, callback): void => {
    if (options.all) callback(null, [pinned])
    else callback(null, pinned.address, pinned.family)
  }
}

function toHeaders(raw: NodeJS.Dict<string | string[]>): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(raw)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item)
    else if (value !== undefined) headers.set(name, value)
  }
  return headers
}

async function requestPinned(
  url: URL,
  pinned: { address: string; family: 4 | 6 },
  signal: AbortSignal,
): Promise<PinnedResponse> {
  return await new Promise<PinnedResponse>((resolve, reject) => {
    const request = https.request(
      {
        protocol: 'https:',
        hostname: url.hostname,
        port: 443,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: {
          accept: 'text/html,application/xhtml+xml;q=0.9',
          'accept-encoding': 'gzip, deflate, br',
          'user-agent': 'ViewportWitness/0.2',
        },
        lookup: createPinnedLookup(pinned),
        servername: url.hostname.startsWith('[') ? undefined : url.hostname,
        rejectUnauthorized: true,
        signal,
      },
      (response) => {
        const status = response.statusCode ?? 0
        const headers = toHeaders(response.headers)
        if (status >= 300 && status < 400) {
          response.destroy()
          resolve({ status, url: url.toString(), headers, body: Buffer.alloc(0) })
          return
        }
        const encoding = (response.headers['content-encoding'] ?? '').toString().toLowerCase()
        const decoder =
          encoding === 'gzip'
            ? createGunzip()
            : encoding === 'deflate'
              ? createInflate()
              : encoding === 'br'
                ? createBrotliDecompress()
                : encoding === '' || encoding === 'identity'
                  ? null
                  : undefined
        if (decoder === undefined) {
          response.destroy()
          reject(new Error('unsupported_content_encoding'))
          return
        }
        let wireBytes = 0
        response.on('data', (chunk: Buffer) => {
          wireBytes += chunk.byteLength
          if (wireBytes > BYTE_LIMIT) response.destroy(new Error('response_too_large'))
        })
        const decoded = decoder ? response.pipe(decoder) : response
        const chunks: Buffer[] = []
        let decodedBytes = 0
        decoded.on('data', (chunk: Buffer) => {
          decodedBytes += chunk.byteLength
          if (decodedBytes > BYTE_LIMIT) {
            decoded.destroy(new Error('response_too_large'))
            response.destroy()
            return
          }
          chunks.push(Buffer.from(chunk))
        })
        decoded.once('error', reject)
        response.once('error', reject)
        decoded.once('end', () => {
          resolve({
            status,
            url: url.toString(),
            headers,
            body: Buffer.concat(chunks, decodedBytes),
          })
        })
      },
    )
    request.once('error', reject)
    request.end()
  })
}

export function safePublicUrl(raw: string): string {
  const parsed = new URL(raw)
  parsed.username = ''
  parsed.password = ''
  parsed.hash = ''
  for (const key of [...parsed.searchParams.keys()]) parsed.searchParams.set(key, '[redacted]')
  return parsed.toString()
}

export async function fetchBoundedHtml(
  rawUrl: string,
  outerSignal?: AbortSignal,
  options: FetchBoundedHtmlOptions = {},
): Promise<BoundedHtml> {
  const controller = new AbortController()
  let abortReason: 'job_aborted' | 'fetch_timeout' | undefined
  const abort = (): void => {
    abortReason = 'job_aborted'
    controller.abort()
  }
  outerSignal?.addEventListener('abort', abort, { once: true })
  if (outerSignal?.aborted) abort()
  let timeout: NodeJS.Timeout | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      abortReason = 'fetch_timeout'
      controller.abort()
      reject(new Error('fetch_timeout'))
    }, WEB_JOB_BUDGET_MS)
  })
  const work = (async (): Promise<BoundedHtml> => {
    let current = rawUrl
    let redirects = 0
    while (true) {
      if (controller.signal.aborted) throw new Error(abortReason ?? 'fetch_timeout')
      const validation = validateUrl(current)
      const parsedUrl = new URL(current)
      const resolution = validation.valid
        ? await (options.resolver ?? resolvePublicAddresses)(parsedUrl.hostname)
        : { safe: false, reason: validation.reason, addresses: [] }
      if (controller.signal.aborted) throw new Error(abortReason ?? 'fetch_timeout')
      if (!resolution.safe || resolution.addresses.length === 0)
        throw new Error(`blocked_destination:${resolution.reason ?? 'unknown'}`)
      const pinned = resolution.addresses[0]
      if (!pinned) throw new Error('blocked_destination:dns_no_records')
      const response = await (options.requester ?? requestPinned)(
        parsedUrl,
        pinned,
        controller.signal,
      )
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (!location) throw new Error('redirect_without_location')
        if (redirects >= REDIRECT_LIMIT) throw new Error('redirect_limit_exceeded')
        current = new URL(location, current).toString()
        redirects += 1
        continue
      }
      if (response.status < 200 || response.status >= 300)
        throw new Error(`upstream_http_${response.status}`)
      const contentType = (response.headers.get('content-type') ?? '')
        .split(';')[0]
        ?.trim()
        .toLowerCase()
      if (!contentType || !HTML_TYPES.has(contentType)) throw new Error('unsupported_content_type')
      const declared = Number(response.headers.get('content-length') ?? '0')
      if (Number.isFinite(declared) && declared > BYTE_LIMIT) throw new Error('response_too_large')
      if (response.body.byteLength === 0) throw new Error('empty_response')
      return {
        finalUrl: safePublicUrl(response.url),
        html: new TextDecoder('utf-8', { fatal: false }).decode(response.body),
        inputBytes: response.body.byteLength,
        contentType,
        redirects,
        headers: response.headers,
        fetchedAt: new Date().toISOString(),
      }
    }
  })()
  try {
    return await Promise.race([work, deadline])
  } catch (error) {
    if (controller.signal.aborted) throw new Error(abortReason ?? 'fetch_timeout')
    throw error
  } finally {
    if (timeout) clearTimeout(timeout)
    outerSignal?.removeEventListener('abort', abort)
  }
}
