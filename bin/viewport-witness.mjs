#!/usr/bin/env node
import { main } from '../scripts/first-check.mjs'

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 2
})
