export const CDP_CUSTOMER_ENVIRONMENT = [
  'CDP_API_KEY_ID',
  'CDP_API_KEY_SECRET',
  'CDP_WALLET_SECRET',
  'VW_PAYER_ADDRESS',
] as const

export function missingCdpCustomerSettings(env: Record<string, string | undefined>): string[] {
  return CDP_CUSTOMER_ENVIRONMENT.filter((name) => !env[name]?.trim())
}
