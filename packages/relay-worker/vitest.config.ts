import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        // Reuse the real wrangler.toml so tests get the same bindings
        // (DB, DOs, R2) as production — `main` there also lets the pool
        // register the ChatRoom/UserHub DO classes.
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          // The installed pool (0.5.x) bundles workerd 1.20241230.0,
          // which rejects wrangler.toml's newer compatibility_date.
          // Pin tests to the newest date this workerd supports.
          compatibilityDate: '2024-12-30',
          // Secrets normally come from `wrangler secret put` / .dev.vars;
          // tests mint their own session JWTs with this value.
          bindings: { JWT_SECRET: 'test-secret' },
        },
      },
    },
  },
});
