import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['convex/__tests__/**/*.test.ts', 'src/demo/__tests__/**/*.test.ts'],
  },
});
