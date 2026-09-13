# Architecture — Configuration and environment

- **Parent:** [architecture.md](../architecture.md) — overview, component map, cross-cutting
  invariants, phased implementation order, and the [traceability map](../architecture.md#traceability-map).
- **Status:** Draft. Variable and secret **names only**; the authoritative list for every stack.

> Evidence tags carry the same meaning as in the overview: **[fact:<ref>]** (confirmed by an
> official page listed in [architecture.md §25](../architecture.md#25-official-sources)),
> **[inference]** (a design conclusion drawn from those facts), **[assumption]** (needs a spike
> or human decision).

---

## 4. Configuration and environment

This document lists configuration names and constraints. The repository's Wrangler file
contains safe non-secret local defaults and sentinel identifiers; no real deployment
identifiers or secret values are committed. Values are supplied per stack through
Wrangler vars (non-secret) and Wrangler secrets (secret).

### Non-secret configuration

| Name | Read by | Purpose |
|---|---|---|
| `ENVIRONMENT` | all | selects the stack; the current implementation accepts only `staging`; production remains absent and rejected |
| `COMPANION_WORKER_BASE_URL` | Windows companion | exact HTTPS `workers.dev` origin for the staging Worker; no path, query, fragment, credentials, or custom port; companion-only and not a Wrangler variable |
| `DISCORD_REGISTRATION_CHANNEL_ID` | companion, ingestion Worker | the only channel whose plain human messages are registration commands |
| `DISCORD_MVP_ADMIN_CHANNEL_ID` | companion, manual-code Worker endpoint | dedicated staging channel for `!wos-code CODE`; must differ from the registration channel |
| `DISCORD_MVP_ADMIN_USER_ALLOWLIST` | companion, manual-code Worker endpoint | nonempty comma-separated human administrator snowflakes; both tiers check it; must not contain the application id |
| `DISCORD_GUILD_ID` | companion, ingestion Worker | expected staging guild |
| `DISCORD_APPLICATION_ID` | companion, ingestion Worker, output builder | dedicated bot application id; verified against the logged-in companion and used by the author filter |
| `DEFAULT_STATE` | registration parser | state used when the message omits a numeric state (contract in `AGENTS.md`) |
| `DISCORD_MESSAGE_MAX_LENGTH` | validation-reply guard, output builder | chunking threshold; accepts 500–2,000; builders reserve footer, part marker and truthful overflow before selecting rows |
| `OPERATION_DEADLINE_SECONDS` | ingestion Worker, consumers, sweeper | max wall time before an operation is force-closed with a partial summary; local guardrail 1–604,800 seconds |
| `ITEM_CLAIM_LEASE_SECONDS` | consumers, sweeper | `operation_items` lease TTL |
| `REDEMPTION_CLAIM_LEASE_SECONDS` | consumers, sweeper | **invocation** lease TTL (`redemptions.invocation_expires_at`); also the `retry_wait` "must be re-picked-up by" grace. **Set above the provider call timeout** so a lease does not expire mid-call ([§15.2](redemption-state-machine.md#152-global-redemption-record--the-sole-provider-call-authority)) |
| `OUTPUT_CLAIM_LEASE_SECONDS` | output dispatcher, sweeper | `discord_output_deliveries` claim lease TTL |
| `REDEMPTION_MAX_REEVAL` | ingestion Worker, sweeper, repair | cap on `redemptions.reeval_count`; Phase 3 accepts 0–100; beyond the configured cap only an operator `repair_run` may reopen the row |
| `REDEMPTION_AUTO_REOPEN_RETRY_EXHAUSTED` | operation sweeper | must be `false`; automatic reopening is rejected; T14 operator repair is the only retry-exhausted reopening path |
| `SUMMARY_MAX_CHUNKS` | summary builder | hard cap on chunks per summary; overflow becomes a deterministic `"+N more not listed"` line in the final chunk |
| `OUTBOX_DISPATCH_MAX_ATTEMPTS` | outbox dispatcher | attempts before an outbox row is marked `dead`; Phase 3 accepts 1–5 to retain the bounded marking/query proof |
| `OUTPUT_DISPATCH_MAX_ATTEMPTS` | output dispatcher | send attempts before a delivery row is alerted |
| `CODE_DISCOVERY_ENABLED` | code-discovery scheduler | master switch; `false` until a source is authorized |
| `PRODUCTION_REDEMPTION_ENABLED` | provider adapter | must be `false` unless an authorized provider is documented and approved |
| `PROVIDER_MODE` | provider adapter | `mock` (default) or a named authorized provider |
| `REGISTRATION_JOBS_QUEUE` / `CODE_FANOUT_JOBS_QUEUE` | producers | staging bindings, not scalar vars; the redemption DLQ is configured through consumer queue names and `dead_letter_queue`, with no direct producer binding |
| `PROVIDER_MAX_RETRIES` | configuration / Queue contract | physical-message retry configuration, fixed at 3 in Wrangler; independent of logical invocation authority |
| `PROVIDER_MAX_INVOCATIONS` | consumers, acceptance, repair | 1–101; default 4 **including the first invocation**, captured per budget generation; atomically charged before calling the provider |
| `PROVIDER_TIMEOUT_SECONDS` | consumers | provider timeout, default 10 seconds; invocation and item leases must exceed it |
| `OUTPUT_TIMEOUT_SECONDS` | output client | default 10 seconds; output lease must exceed it |
| `DISCORD_DELIVERY_ENABLED` | output dispatcher | exact boolean; `false` is the checked-in safe default and performs no Discord request; `true` is staging-only and also requires the bot-token binding plus deployable Discord identifiers |
| `PROVIDER_RATE_LIMIT_PER_SECOND` | provider adapter | client-side rate limiting toward the provider |
| `SPIKE_SENDER_ALLOWLIST` | separately gated spike source and ingestion Worker (**staging only; not the Task 09 companion**) | strictly comma-separated dedicated spike bot/webhook snowflake ids without whitespace; duplicates are collapsed; empty means strict filtering; after authentication the Worker classifies a bot by `author_id` or webhook by `webhook_id`; a human is always normal even if its id matches; system and own-application messages always drop; the application id is rejected in the list; never set in production; accepted invalid spike output is retained only in the immutable migration-0003 suppressed shape |
| `LOG_LEVEL` | all | structured-log verbosity |

Stored event identifiers remain digit strings and never JS numbers. A deployable Task 09
configuration requires every configured Discord guild/channel/application/administrator id to
be a non-placeholder snowflake of 17–20 digits with a nonzero first digit. `PLAYER_ID` has 1–32
digits, and `STATE` / `DEFAULT_STATE` has 1–16 and may preserve leading zeros. Names are
normalized and capped at 64 Unicode code points; immutable rendered labels are capped at 80 code
points. Manual gift codes use `[A-Za-z0-9_-]` and are capped at 64 characters. These are
application constants, not new configuration variables.

Phase 4 page sizes are fixed application bounds: expansion 128, outbox 90, seal/layout and terminal reconciliation at most 128, render one chunk, stuck-item repair one pair. Summary and terminal pages also enforce a 262,144-byte cumulative source budget (one larger legacy row may advance alone). The default operation deadline is 3,600 seconds; separate scheduler lanes preserve expansion throughput. `SUMMARY_MAX_CHUNKS` defaults to 10 and output attempts to 5.

Integer configuration accepts either an integer number or a digit-only string within
the documented range. The ranges are local implementation guardrails, not claims about
provider limits or production tuning.

`INGESTION_SHARED_SECRET` and `DISCORD_BOT_TOKEN` are declared by name in `secrets.required` at
the top level and under `env.staging`, making generated types deterministic without local
credential files. Worker runtime configuration always requires a nonempty, whitespace-free
ingestion secret; it requires and retains the bot token only when delivery is explicitly true.
The companion requires both. Validation errors contain names and expectations only. Tests inject
synthetic values through isolated local configuration and never perform an external request.

The safe top-level Worker has `workers_dev=false`. Only `env.staging` has `workers_dev=true`, and
both scopes set `preview_urls=false`. The checked-in Discord ids and D1 id are sentinels: the
Worker compiles in a dry run, but runtime configuration rejects the Discord placeholders until
reviewed staging ids replace them. This makes a mistaken deploy nonfunctional rather than quietly
accepting traffic under fake scope.

`LOCAL_GATEWAY_ADAPTER` is a Task 08C test binding, not an application variable or deployable
resource. It exists only in `vitest.config.ts`'s explicit Miniflare `durableObjects` map and the
test-only environment declaration. It is absent from `wrangler.jsonc`; no class migration,
namespace id, route, alarm trigger, token input, or production/staging configuration was added.
The same test configuration injects a synthetic spike-sender id solely for local integration
coverage.

### Secrets (names only — never values, never logged)

| Name | Held by | Purpose |
|---|---|---|
| `DISCORD_BOT_TOKEN` | Windows companion, staging output dispatcher | dedicated Discord bot authentication; companion uses it for Gateway login, Worker uses it only at the final REST network boundary when delivery is enabled |
| `DISCORD_PUBLIC_KEY` | interactions fallback only | Ed25519 verification for the `/register` fallback ([ADR 0001](../adr/0001-discord-event-ingestion.md) Option 3) |
| `INGESTION_SHARED_SECRET` | Windows companion, ingestion Worker | authenticates companion → `/ingest` and `/manual-code` |

**No production Whiteout provider secret is defined.** A future authorized provider may use
any authentication mechanism; its secret name(s) are added only when its contract is
documented and approved. Any `WHITEOUT_PROVIDER_*` name that appears later is a non-binding
placeholder, not a commitment to API-key authentication.
