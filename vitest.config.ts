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
          // Test-only binding, declared here and never in `wrangler.jsonc`, so no deployed
          // Worker can see it. `test/env.d.ts` declares its type.
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    test: {
      // Applies the migrations to the test database before any test runs.
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
