import type { Requirement } from './release-check.js'

function displayUsdc(value: bigint): string {
  const fraction = (value % 1000000n).toString().padStart(6, '0').replace(/0+$/, '')
  return `${value / 1000000n}${fraction ? '.' + fraction : ''}`
}

export function buildReleasePreview(input: {
  budget: bigint
  planned: bigint
  reserved: bigint
  pages: string[]
  preflights: Array<{ requirement?: Requirement }>
}) {
  const paymentTerms = input.preflights.flatMap((page, index) => {
    const term = page.requirement
    return term
      ? [
          {
            pageIndex: index,
            network: term.network,
            asset: term.asset,
            recipient: term.payTo,
            amountAtomicUsdc: term.amount,
            ...(typeof term.extra?.feePayer === 'string' ? { feePayer: term.extra.feePayer } : {}),
          },
        ]
      : []
  })
  return {
    decision: 'INCONCLUSIVE' as const,
    dryRun: true,
    maximumAtomic: input.budget.toString(),
    quotedAtomic: input.planned.toString(),
    reservedAtomic: input.reserved.toString(),
    pages: input.pages,
    spendingApproved: false,
    paymentTerms,
    markdown:
      [
        '# Release check preview',
        `Pages: ${input.pages.length}. Additional quoted price: ${displayUsdc(input.planned)} USDC. Configured budget limit: ${displayUsdc(input.budget)} USDC.`,
        `Previously reserved: ${displayUsdc(input.reserved)} USDC (not an actual-settlement receipt).`,
        ...paymentTerms.map(
          (term) =>
            `Page ${term.pageIndex + 1}: ${term.amountAtomicUsdc} atomic USDC; network ${term.network}; asset ${term.asset}; recipient ${term.recipient}${term.feePayer ? `; facilitator fee payer ${term.feePayer}` : ''}.`,
        ),
        'Review the recipient independently and obtain spending approval before execution. Quoted terms can change; execution revalidates network, recipient and budget.',
        'No payment adapter invoked. No release verdict is available.',
      ].join('\n') + '\n',
  }
}
