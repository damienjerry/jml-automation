import { defineConfig } from 'vitest/config'

/**
 * `node:sqlite` is a prefix-only builtin: it does not appear in
 * `module.builtinModules`, so the test runner's module resolver treats it as a
 * package called "sqlite" and fails to load it. That would make the default
 * people store untestable, so it is handed the real module through
 * `createRequire` instead. Delete this plugin once the runner resolves
 * prefix-only builtins on its own.
 */
const nodeSqliteBuiltin = {
  name: 'jml-node-sqlite-builtin',
  enforce: 'pre' as const,
  resolveId(id: string) {
    return id === 'node:sqlite' ? '\0jml-node-sqlite' : null
  },
  load(id: string) {
    if (id !== '\0jml-node-sqlite') return null
    return [
      "import { createRequire } from 'node:module'",
      "const { DatabaseSync, StatementSync, constants, backup } = createRequire(import.meta.url)('node:sqlite')",
      'export { DatabaseSync, StatementSync, constants, backup }',
    ].join('\n')
  },
}

export default defineConfig({
  plugins: [nodeSqliteBuiltin],
  test: {
    include: ['test/**/*.test.ts'],
    // Contract tests hit a real tenant and are opt-in via JML_CONTRACT=1.
    exclude: process.env.JML_CONTRACT ? [] : ['test/contract/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      thresholds: {
        // The state machine and the engine decide whether a real account gets
        // suspended or deleted, so they carry a higher bar than the rest.
        'src/core/transitions.ts': { branches: 100, functions: 100, lines: 100 },
        'src/engine/**': { branches: 90, functions: 90, lines: 90 },
      },
    },
  },
})
