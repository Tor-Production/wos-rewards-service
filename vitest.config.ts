import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  // Read every migration in `migrations/`, in migration-number order, and hand them to the
  // Workers runtime as a test-only binding. This reads local files only; it contacts no
  // Cloudflare service and needs no credentials.
  //
  // The path is relative to the working directory, which is the repository root when
  // `npm test` runs — the same assumption `wrangler.configPath` below already makes.
  const migrations = await readD1Migrations("./migrations");

  return {
    plugins: [
      cloudflareTest({
        // Run every test inside the Workers runtime, against the same `staging` variables
        // and bindings a staging deploy would use. `STAGING_DB` resolves to a local
        // Miniflare D1 database; no remote database is ever contacted.
        wrangler: { configPath: "./wrangler.jsonc", environment: "staging" },
        miniflare: {
          d1Databases: ["BASELINE_DB", "PHASE4_DB", "THROUGHPUT_DB", "UPGRADE_DB"],
          outboundService: () => {
            throw new Error("unmatched outbound network request prohibited");
          },
          // Test-only binding, declared here and never in `wrangler.jsonc`, so no deployed
          // Worker can see it. `test/env.d.ts` declares its type.
          bindings: {
            TEST_MIGRATIONS: migrations,
            // Synthetic local test input; unusable as a real credential.
            INGESTION_SHARED_SECRET: "test-only-not-a-secret",
          },
        },
      }),
    ],
    test: {
      // A Workers pool is substantially heavier than a normal Vitest worker. Keep high-core
      // developer machines and CI runners from trying to boot every test file at once.
      maxWorkers: 1,
      // D1 migration and crash-recovery integration cases can exceed Vitest's five-second
      // default on Windows while remaining comfortably bounded.
      testTimeout: 30_000,
      // Applies the migrations to the test database before any test runs.
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
