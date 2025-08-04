import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
  },
  resolve: {
    alias: {
      obsidian: new URL('./tests/obsidian-mock.ts', import.meta.url).pathname,
      // Mock WASM imports
      '../node_modules/sql.js/dist/sql-wasm.wasm': new URL('./tests/mocks/sql-wasm-mock.js', import.meta.url).pathname,
    },
  },
});