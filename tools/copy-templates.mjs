/**
 * Copy the notification templates into the build output.
 *
 * The templates are Markdown read at run time relative to the compiled module,
 * and the TypeScript compiler only emits JavaScript. Without this step a
 * published install has dist/notify/fanout.js and no dist/notify/templates,
 * so every notification fails at the point of sending: the day-6 warning and
 * the day-7 delete notice are exactly the messages whose absence nobody
 * notices until an account has already been deleted unannounced.
 */
import { cpSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const from = join(root, 'src', 'notify', 'templates')
const to = join(root, 'dist', 'notify', 'templates')

if (!existsSync(from)) {
  console.error(`no template directory at ${from}`)
  process.exit(1)
}

cpSync(from, to, { recursive: true })

const copied = readdirSync(to).filter((f) => f.endsWith('.md'))
const expected = readdirSync(from).filter((f) => f.endsWith('.md'))
if (copied.length !== expected.length) {
  console.error(`copied ${copied.length} of ${expected.length} templates`)
  process.exit(1)
}
console.log(`copied ${copied.length} notification templates into dist/notify/templates`)
