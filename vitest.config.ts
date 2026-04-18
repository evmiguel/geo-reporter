import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/unit/**/*.test.tsx'],
    exclude: ['tests/integration/**'],
    testTimeout: 5_000,
    setupFiles: ['./tests/unit/web/setup.ts'],
    environmentMatchGlobs: [
      ['tests/unit/web/**', 'happy-dom'],
    ],
  },
})
