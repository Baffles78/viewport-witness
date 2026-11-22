// Recovery always uses this fixed adapter: no signer, wallet or payment is available.
export default async function noPaymentAdapter() {
  throw new Error('Payment is forbidden during accepted-job recovery; preserve the checkpoint and reconcile')
}
