import { defineConfig } from 'vitest/config';

// The range sim is pure logic (no DOM/canvas), so the harness runs in a plain
// Node environment. Vitest is a devDependency only — it never enters the app
// bundle. Test files live beside the code they exercise (src/**/*.test.ts).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
