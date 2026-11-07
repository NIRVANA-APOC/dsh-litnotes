/**
 * Vitest configuration for the 2.0 TypeScript codebase.
 *
 * Host and shared modules run in the Node environment; client component tests
 * opt into happy-dom per file with `// @vitest-environment happy-dom`.
 */

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    environment: 'node',
    setupFiles: ['test/setup.ts'],
    restoreMocks: true,
    reporters: ['default'],
    // The repo is a plugin package, not a library: keep the test surface flat.
    pool: 'forks',
  },
})
