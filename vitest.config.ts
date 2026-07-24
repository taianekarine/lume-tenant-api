import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    exclude: ['test/**/*.e2e-spec.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/application/**/*.ts', 'src/domain/**/*.ts'],
      exclude: ['**/*.spec.ts', '**/index.ts'],
      thresholds: {
        statements: 80,
        branches: 65,
        functions: 80,
        lines: 80,
      },
    },
  },
});
