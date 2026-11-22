export function usdcAtomic(value: string): bigint {
  if (!/^\d{1,8}(\.\d{1,6})?$/.test(value)) throw new Error('Invalid USDC budget')
  const [whole, fraction = ''] = value.split('.')
  return BigInt(whole!) * 1000000n + BigInt(fraction.padEnd(6, '0'))
}
