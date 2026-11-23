import { setupStageArgs } from '../dist/client/setup-options.js'
import { parseClientOptions } from '../dist/client/options.js'
import { fileURLToPath } from 'node:url'

try {
  const raw = process.env.VW_SETUP_OPTIONS ?? ''
  delete process.env.VW_SETUP_OPTIONS
  if (raw.length > 12000) throw new Error('options_limit')
  const argv = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'))
  if (!Array.isArray(argv) || argv.some((value) => typeof value !== 'string'))
    throw new Error('options_invalid')
  parseClientOptions(argv, true)
  const mode = process.argv[2]
  if (!['public', 'account', 'execute', 'resume'].includes(mode)) throw new Error('mode_invalid')
  const args = setupStageArgs(mode, argv)
  if (mode === 'public' || mode === 'account') {
    const { main } = await import('./doctor.mjs')
    process.exitCode = await main(args)
  } else {
    const { main } = await import('./first-check.mjs')
    process.argv = [
      process.execPath,
      fileURLToPath(new URL('./first-check.mjs', import.meta.url)),
      ...args,
    ]
    await main()
  }
} catch {
  console.error(
    'SETUP_STAGE_FAILED: setup stopped safely. Preserve existing checkpoints; no automatic retry is allowed.',
  )
  process.exitCode = 2
} finally {
  for (const key of [
    'CDP_API_KEY_ID',
    'CDP_API_KEY_SECRET',
    'CDP_WALLET_SECRET',
    'VW_PAYER_ADDRESS',
  ])
    delete process.env[key]
}
