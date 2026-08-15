import { defineConfig } from 'vitest/config';

// The range sim is pure logic (no DOM/canvas), so the harness runs in a plain
// Node environment — that stays the DEFAULT so the several-hundred physics /
// course-data tests keep running in the fast env. Vitest, jsdom and
// @testing-library/* are devDependencies only — they never enter the app
// bundle. Test files live beside the code they exercise (src/**/*.test.ts).
//
// The handful of tests that need a DOM (React hooks/components, e.g.
// lib/games/useGameFlow.test.tsx) opt in per file with a
// `// @vitest-environment jsdom` docblock rather than flipping the suite —
// vitest 2.x reads that comment and spins jsdom up for that file alone.
// `.tsx` is in `include` so those component tests are collected at all.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
