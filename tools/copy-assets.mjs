/**
 * Copy the non-TypeScript assets into the build output.
 *
 * Two directories under src/ are read at run time relative to the compiled
 * module, and the TypeScript compiler only emits JavaScript, so without this
 * step a published install has the code and none of the files it reads.
 *
 * notify/templates: dist/notify/fanout.js with no dist/notify/templates makes
 * every notification fail at the point of sending. The day-6 hand-over warning
 * and the day-7 delete notice are exactly the messages whose absence nobody
 * notices until an account has already been deleted unannounced.
 *
 * engine/device/scripts: the manifest is the single record of whether an
 * uninstall script has ever been run on real hardware, and the hand-over path
 * refuses to send an unproven script. A missing manifest is therefore not a
 * cosmetic gap; it is the safety record for the one operation that runs code on
 * somebody's machine. Reading it throws rather than defaulting, so this step
 * failing has to fail the build rather than surfacing on the first disposition.
 */
import { cpSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

/** Each entry names a directory under src/ and the extensions that must survive the copy. */
const assets = [
  { dir: ['notify', 'templates'], label: 'notification templates', exts: ['.md'] },
  {
    dir: ['engine', 'device', 'scripts'],
    label: 'device scripts and their manifest',
    exts: ['.json', '.ps1', '.sh'],
  },
  { dir: ['cli', 'fixtures'], label: 'demo HR fixture', exts: ['.json'] },
]

let failed = false

for (const asset of assets) {
  const from = join(root, 'src', ...asset.dir)
  const to = join(root, 'dist', ...asset.dir)

  if (!existsSync(from)) {
    console.error(`no source directory at ${from}`)
    failed = true
    continue
  }

  cpSync(from, to, { recursive: true })

  const wanted = (d) => readdirSync(d).filter((f) => asset.exts.some((e) => f.endsWith(e)))
  const expected = wanted(from)
  const copied = wanted(to)
  if (copied.length !== expected.length) {
    console.error(`copied ${copied.length} of ${expected.length} ${asset.label}`)
    failed = true
    continue
  }
  console.log(`copied ${copied.length} ${asset.label} into dist/${asset.dir.join('/')}`)
}

if (failed) process.exit(1)
