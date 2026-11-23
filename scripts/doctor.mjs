import { parseClientOptions } from '../dist/client/options.js'
import { runDoctor } from '../dist/client/doctor.js'
import { ClientTargetError } from '../dist/client/option-errors.js'

export const doctorHelp = `Read-only preflight; no files, wallet authentication, signing or payment:
  viewport-witness doctor --url https://example.com [--json]
  --dns-servers <IP,IP>  Explicit client-only DNS resolvers; never an OS-lookup fallback.
  --payer <public-address> --network base --budget 0.08 --recipient <approved-address>
  --check-account       Optional API-key-only existing account GET. Signing stays untested.
Credentials are read from the local environment; never pass their values as arguments.`

export async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.length === 1 && argv[0] === '--help') {
    console.log(doctorHelp)
    return 0
  }
  try {
    const options = parseClientOptions(argv)
    const report = await runDoctor(options, env)
    if (options.json) console.log(JSON.stringify(report, null, 2))
    else {
      for (const stage of report.stages)
        console.log(`${stage.status.toUpperCase()} ${stage.stage}: ${stage.code}\n  ${stage.fix}`)
      for (const term of report.paymentTerms)
        console.log(
          `Unpaid quote: ${term.amountAtomicUsdc} atomic USDC (0.08 USDC); network ${term.network}; asset ${term.asset}; recipient ${term.recipient}. Independently approve this recipient before execution.`,
        )
      console.log(
        'Read-only preflight. Signing, Wallet Secret validity and settlement were not tested; no payment is authorized.',
      )
    }
    const accountReady =
      !options.checkAccount ||
      ['account', 'base_usdc'].every((name) =>
        report.stages.some((stage) => stage.stage === name && stage.status === 'pass'),
      )
    return report.readyForPreview && accountReady ? 0 : 2
  } catch (error) {
    const failure = {
      schema: 'viewport-witness-doctor/v1',
      stages: [
        {
          stage: 'options',
          status: 'fail',
          code: error instanceof ClientTargetError ? error.code : 'DOCTOR_OPTIONS_OR_CHECK_FAILED',
          fix:
            error instanceof ClientTargetError
              ? error.fix
              : 'Use doctor --help. No payment or signing was attempted.',
        },
      ],
      readyForPreview: false,
      spendingApproved: false,
      signingTested: false,
    }
    if (argv.includes('--json')) console.log(JSON.stringify(failure))
    else console.error(`${failure.stages[0].code}: ${failure.stages[0].fix}`)
    return 2
  }
}
