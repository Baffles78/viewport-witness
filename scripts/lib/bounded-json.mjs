import { promises as fs } from 'node:fs'
import { resolve } from 'node:path'

export async function loadBoundedJson(filePath, maxBytes = 64 * 1024) {
  const abs = resolve(filePath)
  const stat = await fs.lstat(abs)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Expected a regular JSON file')
  if (stat.size > maxBytes) throw new Error(`File exceeds ${maxBytes} byte limit: ${abs}`)
  const text = await fs.readFile(abs, 'utf8')
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('Malformed JSON file; preserve it and reconcile')
  }
}
