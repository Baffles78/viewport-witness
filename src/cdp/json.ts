import { createHash } from 'node:crypto'

export const CDP_REQUEST_BYTES = 64 * 1024
const MAX_DEPTH = 20
const MAX_NODES = 4096
const MAX_BIGINT = 10n ** 1024n

/** Strict JSON snapshot. Never invokes getters/toJSON or silently drops signing input. */
export function serializeCdpJson(value: unknown): { body: string; hash: string } {
  const active = new Set<object>()
  let nodes = 0
  let scalarBytes = 0
  const walk = (input: unknown, depth: number): unknown => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) throw new Error('cdp_request_limit')
    if (typeof input === 'bigint') {
      if (input >= MAX_BIGINT || input <= -MAX_BIGINT) throw new Error('cdp_request_limit')
      input = input.toString()
    }
    if (input === null || typeof input === 'boolean') return input
    if (typeof input === 'string') {
      scalarBytes += Buffer.byteLength(input)
      if (scalarBytes > CDP_REQUEST_BYTES) throw new Error('cdp_request_limit')
      return input
    }
    if (typeof input === 'number' && Number.isFinite(input)) return input
    if (typeof input !== 'object' || !input || active.has(input))
      throw new Error('cdp_invalid_json')
    const proto = Object.getPrototypeOf(input)
    if (!Array.isArray(input) && proto !== Object.prototype && proto !== null)
      throw new Error('cdp_invalid_json')
    if (Object.getOwnPropertySymbols(input).length) throw new Error('cdp_invalid_json')
    const keys = Object.keys(input)
    const ownKeys = Object.getOwnPropertyNames(input).filter(
      (key) => !(Array.isArray(input) && key === 'length'),
    )
    if (ownKeys.length !== keys.length || ownKeys.includes('toJSON'))
      throw new Error('cdp_invalid_json')
    if (
      keys.length > MAX_NODES ||
      (Array.isArray(input) && (input.length > MAX_NODES || keys.length !== input.length))
    )
      throw new Error('cdp_request_limit')
    if (Array.isArray(input) && keys.some((key, index) => key !== String(index)))
      throw new Error('cdp_invalid_json')
    active.add(input)
    const output: unknown[] | Record<string, unknown> = Array.isArray(input)
      ? []
      : Object.create(null)
    for (const key of Array.isArray(input) ? keys : keys.sort()) {
      const property = Object.getOwnPropertyDescriptor(input, key)
      if (!property || !('value' in property) || key === 'toJSON')
        throw new Error('cdp_invalid_json')
      scalarBytes += Buffer.byteLength(key)
      if (scalarBytes > CDP_REQUEST_BYTES) throw new Error('cdp_request_limit')
      const child = walk(property.value, depth + 1)
      if (Array.isArray(output)) output.push(child)
      else output[key] = child
    }
    active.delete(input)
    return output
  }
  const body = JSON.stringify(walk(value, 0))
  if (Buffer.byteLength(body) > CDP_REQUEST_BYTES) throw new Error('cdp_request_limit')
  return { body, hash: createHash('sha256').update(body).digest('hex') }
}
