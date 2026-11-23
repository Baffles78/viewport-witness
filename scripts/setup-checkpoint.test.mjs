import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { guardSetupCheckpoint } from './lib/setup-checkpoint.mjs'

test('setup guards preserve uncertain, concurrent and accepted checkpoints before credentials', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-setup-checkpoint-'))
  try {
    const state = path.join(root, 'checkpoint.json'), lock = state + '.lock'
    await guardSetupCheckpoint(root)
    for (const [mode, expected] of [['payment-attempted', 'SETUP_PAYMENT_UNCERTAIN'], ['accepted', 'SETUP_ACCEPTED_USE_RESUME'], ['other', 'SETUP_PAYMENT_UNCERTAIN']]) {
      const content = JSON.stringify({ schema: 'viewport-witness-release/v1', pages: [{ state: mode }] })
      await fs.writeFile(state, content)
      await assert.rejects(guardSetupCheckpoint(root), new RegExp(expected))
      assert.equal(await fs.readFile(state, 'utf8'), content)
    }
    await fs.writeFile(lock, 'existing-lock')
    await assert.rejects(guardSetupCheckpoint(root), /SETUP_CHECKPOINT_LOCKED/)
    assert.equal(await fs.readFile(lock, 'utf8'), 'existing-lock')
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
