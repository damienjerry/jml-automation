import { defineConfig } from 'vitest/config'

export default defineConfig({
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
