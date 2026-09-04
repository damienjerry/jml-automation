#!/usr/bin/env node
/**
 * CLI entry point.
 *
 * Two things happen before the library loads. Both are here rather than in the
 * TypeScript so they work even when the build output is missing or the Node
 * version cannot parse it.
 */

// node:sqlite is the default people store. Node prints one ExperimentalWarning
// on first use, which reads as a fault to somebody running this for the first
// time. Filter that single warning and nothing else.
const originalEmit = process.emitWarning
process.emitWarning = (warning, ...rest) => {
  const text = typeof warning === 'string' ? warning : warning?.message ?? ''
  if (text.includes('SQLite is an experimental feature')) return
  return originalEmit.call(process, warning, ...rest)
}

const [major, minor] = process.versions.node.split('.').map(Number)
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(
    `jml needs Node 22.13 or newer (node:sqlite and the type stripping this CLI relies on).\n` +
      `This is Node ${process.versions.node}. Install a newer Node, then run this again.`,
  )
  process.exit(78) // EX_CONFIG
}

const { main } = await import('../dist/cli/index.js').catch((err) => {
  console.error(
    'jml is not built yet. Run `npm ci && npm run build` in the repository first.\n' +
      `Underlying error: ${err.message}`,
  )
  process.exit(70) // EX_SOFTWARE
})

await main(process.argv.slice(2))
