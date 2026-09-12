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
| `DISCORD_REGISTRATION_CHANNEL_ID` | ingestion tier, ingestion Worker | the only channel whose messages are registration commands |
| `DISCORD_GUILD_ID` | ingestion tier, ingestion Worker | expected guild |
| `DISCORD_APPLICATION_ID` | ingestion Worker, output builder | own application id; used by the author filter |
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
| `DISCORD_DELIVERY_ENABLED` | fail-closed configuration | must remain false; only an explicitly injected synthetic transport can deliver locally |
| `PROVIDER_RATE_LIMIT_PER_SECOND` | provider adapter | client-side rate limiting toward the provider |
| `SPIKE_SENDER_ALLOWLIST` | `DiscordEventSource` **and** ingestion Worker (**staging only**) | strictly comma-separated dedicated spike bot/webhook snowflake ids without whitespace; duplicates are collapsed; empty means strict filtering; after authentication the Worker classifies a bot by `author_id` or webhook by `webhook_id`; a human is always normal even if its id matches; system and own-application messages always drop; the application id is rejected in the list; never set in production; accepted invalid spike output is retained only in the immutable migration-0003 suppressed shape |
| `LOG_LEVEL` | all | structured-log verbosity |

Phase 3 preserves identifiers as digit strings, including leading zeros: Discord ids have
1–20 digits, `PLAYER_ID` has 1–32, and `STATE` / `DEFAULT_STATE` has 1–16. Names are normalized
and capped at 64 Unicode code points; immutable rendered labels are capped at 80 code
points. These are application constants, not new configuration variables.

Phase 4 page sizes are fixed application bounds: expansion 128, outbox 90, seal/layout and terminal reconciliation at most 128, render one chunk, stuck-item repair one pair. Summary and terminal pages also enforce a 262,144-byte cumulative source budget (one larger legacy row may advance alone). The default operation deadline is 3,600 seconds; separate scheduler lanes preserve expansion throughput. `SUMMARY_MAX_CHUNKS` defaults to 10 and output attempts to 5.

Integer configuration accepts either an integer number or a digit-only string within
the documented range. The ranges are local implementation guardrails, not claims about
provider limits or production tuning.

`INGESTION_SHARED_SECRET` is declared by name in `secrets.required` at the top level and
under `env.staging`, making generated types deterministic without local credential files.
Runtime configuration requires a nonempty, whitespace-free value and never includes it in validation errors.
Tests inject only a synthetic value through the local Miniflare environment.

### Secrets (names only — never values, never logged)

| Name | Held by | Purpose |
|---|---|---|
| `DISCORD_BOT_TOKEN` | ingestion tier, output dispatcher | Discord bot authentication |
| `DISCORD_PUBLIC_KEY` | interactions fallback only | Ed25519 verification for the `/register` fallback ([ADR 0001](../adr/0001-discord-event-ingestion.md) Option 3) |
| `INGESTION_SHARED_SECRET` | companion (Option 2), ingestion Worker | authenticates companion → `/ingest` |

**No production Whiteout provider secret is defined.** A future authorized provider may use
any authentication mechanism; its secret name(s) are added only when its contract is
documented and approved. Any `WHITEOUT_PROVIDER_*` name that appears later is a non-binding
placeholder, not a commitment to API-key authentication.
