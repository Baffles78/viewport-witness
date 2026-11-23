import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseClientOptions } from '../dist/client/options.js'
import { safeSetupEnvironment, executionOutput } from '../dist/client/setup-options.js'
import os from 'node:os'
import { guardSetupCheckpoint } from './lib/setup-checkpoint.mjs'

export const setupHelp = `Secure Windows setup (PowerShell 5.1 or newer):
  viewport-witness setup --url https://example.com
Default: public doctor and unpaid quote only. No credential prompts or saved setup files.
  --check-account asks for masked API credentials and an existing public payer, then GET/balance checks.
Payment requires every explicit flag:
  --execute --url <https-url> --run-id <id> --network base --recipient <approved-address> --budget 0.08
Only then is a masked Wallet Secret requested and the existing checkpoint runner invoked once.
Recovery: setup --resume --output <same-directory> (no credentials or signing).
Optional: --output, --payer, --dns-servers <IP,IP>, --json.
No credentials are written to files, profiles or persistent environment settings.`

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === '--help') {
    console.log(setupHelp)
    return 0
  }
  try {
    const options = parseClientOptions(argv, true)
    if (!options.resume && !options.url) throw new Error('target_required')
    if (options.execute) {
      const output = executionOutput(options, process.env.LOCALAPPDATA, os.homedir())
      if (!options.output) argv = [...argv, '--output', output]
      await guardSetupCheckpoint(output)
      console.log(`Execution output directory: ${output}`)
    }
    if (process.platform !== 'win32') {
      console.error(
        'SETUP_WINDOWS_REQUIRED: use doctor or the documented environment-based client on this platform.',
      )
      return 2
    }
    const root = path.dirname(fileURLToPath(import.meta.url))
    const child = spawn(
      path.join(
        process.env.SystemRoot ?? 'C:/Windows',
        'System32/WindowsPowerShell/v1.0/powershell.exe',
      ),
      [
        '-NoLogo',
        '-NoProfile',
        '-File',
        path.join(root, 'windows-setup.ps1'),
        '-NodePath',
        process.execPath,
        '-BridgePath',
        path.join(root, 'setup-bridge.mjs'),
        '-OptionsBase64',
        Buffer.from(JSON.stringify(argv)).toString('base64'),
      ],
      { shell: false, windowsHide: true, stdio: 'inherit', env: safeSetupEnvironment(process.env) },
    )
    return await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code) => resolve(code ?? 2))
    })
  } catch (error) {
    if (typeof error?.message === 'string' && error.message.startsWith('SETUP_'))
      console.error(error.message)
    console.error(
      'SETUP_STOPPED: check explicit options and Windows script policy. No policy was changed; preserve any existing checkpoint.',
    )
    return 2
  }
}
