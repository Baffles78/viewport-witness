import { DatabaseSync } from 'node:sqlite'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FeedbackStore } from './db/feedback.js'

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length !== 1)
    throw new Error('Usage: node dist/feedback-summary.js /absolute/path/to/vw.db')
  const db = new DatabaseSync(resolve(args[0] as string), { readOnly: true })
  try {
    process.stdout.write(JSON.stringify(new FeedbackStore(db).summary(), null, 2) + '\n')
  } finally {
    db.close()
  }
}
