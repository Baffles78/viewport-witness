import { promises as fs } from 'node:fs'
import path from 'node:path'
import { loadBoundedJson } from './bounded-json.mjs'

/** Earlier guidance only; the existing financial runner remains the execution authority. */
export async function guardSetupCheckpoint(output) {
  const folder = await fs.lstat(output).catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!folder) return
  if (!folder.isDirectory() || folder.isSymbolicLink()) throw new Error('SETUP_OUTPUT_INVALID')
  if (await fs.lstat(path.join(output, 'checkpoint.json.lock')).catch(() => null))
    throw new Error('SETUP_CHECKPOINT_LOCKED: preserve the existing lock; reconcile its owner.')
  let state
  try {
    state = await loadBoundedJson(path.join(output, 'checkpoint.json'))
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw new Error('SETUP_CHECKPOINT_INVALID: preserve the existing checkpoint.')
  }
  if (
    state?.schema !== 'viewport-witness-release/v1' ||
    !Array.isArray(state.pages) ||
    state.pages.length !== 1
  )
    throw new Error('SETUP_CHECKPOINT_INVALID: preserve the existing checkpoint.')
  if (state.pages.some((page) => page?.state === 'accepted'))
    throw new Error(
      'SETUP_ACCEPTED_USE_RESUME: use setup --resume --output with this directory; no credentials are needed.',
    )
  if (state.pages.some((page) => page?.state !== 'planned'))
    throw new Error(
      'SETUP_PAYMENT_UNCERTAIN: preserve and reconcile this checkpoint before any further payment.',
    )
}
