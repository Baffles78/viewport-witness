import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { loadBoundedJson } from './bounded-json.mjs'

/** Random per-output-run measurement, never a wallet/session or authorization token. */
export async function quickstartUsage(output, env = process.env) {
  const source = ['monitor', 'test-client'].includes(env.VW_USAGE_SOURCE)
    ? env.VW_USAGE_SOURCE
    : 'agent-client'
  if (env.VW_DISABLE_USAGE_TRACKING === '1') return { source }
  try {
    const file = path.join(output, 'quickstart-usage.json')
    try {
      await fs.writeFile(
        file,
        JSON.stringify({ schema: 'viewport-witness-usage/v1', id: randomUUID() }) + '\n',
        { flag: 'wx', mode: 0o600 },
      )
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
    }
    const saved = await loadBoundedJson(file)
    if (
      saved.schema !== 'viewport-witness-usage/v1' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(saved.id)
    )
      return { source }
    return { runId: saved.id, source }
  } catch {
    return { source }
  } // Measurement must not block the customer's check.
}
