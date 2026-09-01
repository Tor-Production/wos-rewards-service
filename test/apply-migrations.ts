import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

/**
 * Apply the baseline schema to the test database.
 *
 * Setup files run once per test file, outside the pool's per-test storage isolation, and may
 * run several times in a session. `applyD1Migrations()` only applies migrations that are not
 * already recorded in the `d1_migrations` table, so calling it repeatedly is a no-op — the
 * migrated schema is simply the baseline every isolated test inherits.
 *
 * This targets the local Miniflare D1 database behind the `STAGING_DB` binding. No remote
 * database is contacted and no Cloudflare credentials are used.
 */
await applyD1Migrations(env.STAGING_DB, env.TEST_MIGRATIONS);
