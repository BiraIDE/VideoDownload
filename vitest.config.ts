
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['utils/**/*.ts'],
      exclude: ['**/*.d.ts', '_versoes/**', '.output/**', 'node_modules/**'],
      reporter: ['text', 'lcov'],
    },
  },
});
