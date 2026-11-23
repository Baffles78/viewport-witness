#!/usr/bin/env node
const command = process.argv[2]
const entry =
  command === 'doctor'
    ? '../scripts/doctor.mjs'
    : command === 'setup'
      ? '../scripts/setup.mjs'
      : '../scripts/first-check.mjs'
const { main } = await import(entry)
if (command === 'doctor' || command === 'setup') process.argv.splice(2, 1)
const result = await main().catch((error) => {
  console.error(error.message)
  process.exitCode = 2
})
if (typeof result === 'number') process.exitCode = result
