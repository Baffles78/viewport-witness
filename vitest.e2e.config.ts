import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 180000,
    hookTimeout: 60000,
    include: ['tests/e2e.test.ts'],
    exclude: ['node_modules', 'dist'],
  },
})
