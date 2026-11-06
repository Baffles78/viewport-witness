// Customer-side only. Loaded by first-check/release-check only with explicit --execute.
// Uses your existing CDP account; no account creation or key import.
import { connectExistingCdpBaseAccount } from '../../dist/customer-cdp.js'
export const signer = await connectExistingCdpBaseAccount()
