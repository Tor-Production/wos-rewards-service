/**
 * Test-only bindings.
 *
 * `worker-configuration.d.ts` is generated from `wrangler.jsonc` and describes what the
 * deployed Worker gets. This file merges in the extra binding that only the Vitest pool
 * provides (see `miniflare.bindings` in `vitest.config.ts`). It is inside `test/`, which the
 * `src` TypeScript project does not include, so Worker code can never reference it.
 */
declare namespace Cloudflare {
  interface Env {
    LOCAL_GATEWAY_ADAPTER: DurableObjectNamespace<
      import("../src/discord/gateway/local-durable-object").LocalDiscordGatewayAdapter
    >;
    BASELINE_DB: D1Database;
    PHASE4_DB: D1Database;
    THROUGHPUT_DB: D1Database;
    UPGRADE_DB: D1Database;
    PHASE5_UPGRADE_DB: D1Database;
    PHASE5_FAILURE_DB: D1Database;
    PHASE5_DISPATCH_DB: D1Database;
    /** The migrations read from `migrations/` by `vitest.config.ts`. */
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
