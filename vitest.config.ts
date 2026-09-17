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
        // Explicit because the local class is a named export without a deployable Wrangler
        // namespace or migration. This metadata is consumed only by the Vitest worker pool.
        additionalExports: { LocalDiscordGatewayAdapter: "DurableObject" },
        // Run every test inside the Workers runtime, against the same `staging` variables
        // and bindings a staging deploy would use. `STAGING_DB` resolves to a local
        // Miniflare D1 database; no remote database is ever contacted.
        wrangler: { configPath: "./wrangler.jsonc", environment: "staging" },
        miniflare: {
          // Local-only Durable Object namespace. It is intentionally absent from
          // `wrangler.jsonc`, so neither staging nor any future production deploy can bind,
          // address, migrate or start the adapter from this task.
          durableObjects: {
            LOCAL_GATEWAY_ADAPTER: {
              className: "LocalDiscordGatewayAdapter",
              useSQLite: true,
            },
          },
          d1Databases: [
            "BASELINE_DB",
            "PHASE4_DB",
            "THROUGHPUT_DB",
            "UPGRADE_DB",
            "PHASE5_UPGRADE_DB",
            "PHASE5_FAILURE_DB",
            "PHASE5_DISPATCH_DB",
            "MVP_UPGRADE_DB",
          ],
          outboundService: () => {
            throw new Error("unmatched outbound network request prohibited");
          },
          // Test-only binding, declared here and never in `wrangler.jsonc`, so no deployed
          // Worker can see it. `test/env.d.ts` declares its type.
          bindings: {
            TEST_MIGRATIONS: migrations,
            // Synthetic local test input; unusable as a real credential.
            INGESTION_SHARED_SECRET: "test-only-not-a-secret",
            // The deployed staging environment may enable real Discord delivery under an
            // explicit gate. General tests remain network-inert; the dedicated delivery suite
            // enables this flag with a synthetic token and injected transport when needed.
            DISCORD_DELIVERY_ENABLED: false,
            DISCORD_GUILD_ID: "100000000000000001",
            DISCORD_REGISTRATION_CHANNEL_ID: "100000000000000002",
            DISCORD_APPLICATION_ID: "100000000000000003",
            DISCORD_MVP_ADMIN_CHANNEL_ID: "100000000000000004",
            DISCORD_MVP_ADMIN_USER_ALLOWLIST: "100000000000000005",
            // Synthetic allow-list entry used only by local Gateway adapter integration tests.
            SPIKE_SENDER_ALLOWLIST: "000000000000000004",
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
