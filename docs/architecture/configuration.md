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

This document lists configuration names and constraints. The repository's Wrangler file keeps
safe sentinel identifiers at its top/default scope and records the reviewed non-secret Task 09
identifiers only under `env.staging`. No secret value is committed. Values are supplied per stack
through Wrangler vars (non-secret) and Wrangler secrets (secret).

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
| `CODE_DISCOVERY_ENABLED` | companion and Worker Follow intake, independently | defaults to `false` when absent; accepts exact boolean/boolean string; all checked-in deployment values and examples remain `false`; enabling requires staging/mock and the complete tuple below |
| `COMMUNITY_JSON_SOURCE_ENABLED` | Worker community JSON scheduled lane | defaults to `false`; independent of the Follow tuple, accepts exact boolean/boolean string, and may be true only in staging/mock. Checked-in deployment leaves it disabled; Task 23 adds no activation |
| `DISCORD_CODE_FEED_CHANNEL_ID` | companion and Worker Follow intake | destination feed in `DISCORD_GUILD_ID`; non-placeholder 17–20 digit snowflake, distinct from registration/admin channels |
| `DISCORD_CODE_FOLLOWER_WEBHOOK_ID` | companion and Worker Follow intake | one exact follower webhook; its type and relationship must be verified before live activation |
| `DISCORD_CODE_SOURCE_GUILD_ID`, `DISCORD_CODE_SOURCE_CHANNEL_ID` | companion and Worker Follow intake | exact canonical source guild/channel; non-placeholder 17–20 digit snowflakes; not inferred from names |
| `PRODUCTION_REDEMPTION_ENABLED` | provider adapter | must be `false` unless an authorized provider is documented and approved |
| `PROVIDER_MODE` | provider adapter | `mock` (default) or a named authorized provider |
| `REGISTRATION_JOBS_QUEUE` / `CODE_FANOUT_JOBS_QUEUE` | producers | staging bindings, not scalar vars; the redemption DLQ is configured through consumer queue names and `dead_letter_queue`, with no direct producer binding |
| `PROVIDER_MAX_RETRIES` | configuration / Queue contract | physical-message retry configuration, fixed at 3 in Wrangler; independent of logical invocation authority |
| `PROVIDER_MAX_INVOCATIONS` | consumers, acceptance, repair | 1–101; default 4 **including the first invocation**, captured per budget generation; atomically charged before calling the provider |
| `PROVIDER_TIMEOUT_SECONDS` | consumers | provider timeout, default 10 seconds; invocation and item leases must exceed it |
| `OUTPUT_TIMEOUT_SECONDS` | output client | default 10 seconds; output lease must exceed it |
| `DISCORD_DELIVERY_ENABLED` | output dispatcher | exact boolean; the top/default safe value is `false` and performs no Discord request; `env.staging` is `true` only under the approved connection/delivery smoke-test gate and also requires the bot-token binding plus deployable Discord identifiers |
| `PROVIDER_RATE_LIMIT_PER_SECOND` | provider adapter | client-side rate limiting toward the provider |
| `SPIKE_SENDER_ALLOWLIST` | separately gated spike source and ingestion Worker (**staging only; not the Task 09 companion**) | strictly comma-separated dedicated spike bot/webhook snowflake ids without whitespace; duplicates are collapsed; empty means strict filtering; after authentication the Worker classifies a bot by `author_id` or webhook by `webhook_id`; a human is always normal even if its id matches; system and own-application messages always drop; the application id is rejected in the list; never set in production; accepted invalid spike output is retained only in the immutable migration-0003 suppressed shape |
| `LOG_LEVEL` | all | structured-log verbosity |

### Task 09 staging deployment record (non-secret)

The staging-only provisioning gate completed on 2026-09-14 and the separately approved
deployment/migration gate completed on 2026-09-15. This table is the reviewed source for the
Windows companion values that are not Wrangler variables and the non-secret identifiers returned
by Cloudflare. Worker secret bindings are recorded by name only; their values remain hidden and
must never enter this repository.

| Item | Value |
|---|---|
| Worker name | `wos-rewards-service-staging` |
| Cloudflare Worker id | `231fd53e27db414ca54444ecc5b8d33b` |
| Active Worker version | `7a083c14-a7ac-4875-ad11-04de4b10b139` (100% deployment) |
| `COMPANION_WORKER_BASE_URL` | `https://wos-rewards-service-staging.chute-risk9361.workers.dev` |
| D1 database name / id / region | `wos-rewards-service-staging` / `6dc171c2-27f5-4ef2-8788-ebd243cd354f` / `EEUR` |
| Registration Queue name / id | `wos-rewards-registration-jobs-staging` / `23b1587e847e4db18d3bc440b1ba07d2` |
| Code-fanout Queue name / id | `wos-rewards-code-fanout-jobs-staging` / `d8366278aa9743859d6b8ddf9f27735b` |
| Redemption DLQ name / id | `wos-rewards-redemption-dlq-staging` / `e9a4aea43d0c447090f8036de687e15a` |
| Cron schedule | `* * * * *` (one minute) |
| `DISCORD_GUILD_ID` | `1455981004261953659` |
| `DISCORD_REGISTRATION_CHANNEL_ID` | `1548863278946590720` |
| `DISCORD_MVP_ADMIN_CHANNEL_ID` | `1548863407334101122` |
| `DISCORD_MVP_ADMIN_USER_ALLOWLIST` | `470002312341880834` |
| `DISCORD_APPLICATION_ID` | `1542396374832652369` |
| `DEFAULT_STATE` | `3607` |
| Remote migration state | `0001`–`0004` applied; no pending migration |
| Secret binding names | `INGESTION_SHARED_SECRET`, `DISCORD_BOT_TOKEN` |
| Discord activation state | staging delivery enabled; smoke test completed; companion stopped |

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

The safe top-level Worker has `workers_dev=false`, `DISCORD_DELIVERY_ENABLED=false` and Discord
sentinels. Only `env.staging` has `workers_dev=true`, `DISCORD_DELIVERY_ENABLED=true`, the reviewed
Discord ids above, and the real staging D1 id; both scopes set `preview_urls=false`. A deploy that
omits `--env staging` therefore remains nonfunctional instead of quietly accepting traffic under
fake scope.

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


### Disabled Follow configuration

New source IDs are optional while discovery is disabled. Existing disabled deployments and companion
configuration remain compatible. An enabled companion also requires explicit `ENVIRONMENT=staging`
and `PROVIDER_MODE=mock`; the Worker already enforces those values. These settings do not authorize
activation. Both loaders invoke the shared validation independently and fail closed on incomplete
or malformed enabled tuples. Synthetic local examples only:

```text
CODE_DISCOVERY_ENABLED=false
ENVIRONMENT=staging
PROVIDER_MODE=mock
DISCORD_CODE_FEED_CHANNEL_ID=100000000000000006
DISCORD_CODE_FOLLOWER_WEBHOOK_ID=100000000000000007
DISCORD_CODE_SOURCE_GUILD_ID=100000000000000008
DISCORD_CODE_SOURCE_CHANNEL_ID=100000000000000009
```

These IDs are synthetic placeholders, not verified staging configuration. The existing
`DISCORD_GUILD_ID` is the destination guild. No live IDs are required for disabled implementation.
See the [source contract and later activation checklist](discord-ingestion-and-registration.md#discord-follow-intake).

### Task 19 read-only staging preflight — 2026-09-19

This is a new observation, not a revision of the dated Task 09 table above. At
2026-09-19T02:07Z, authenticated read-only Wrangler calls against the **named staging** Worker
and D1 binding found active version `7a083c14-a7ac-4875-ad11-04de4b10b139` at 100%. Its version
metadata has the registration and code-fanout Queue bindings, staging D1 binding, the two secret
**names** (no values read), `ENVIRONMENT=staging`, `PROVIDER_MODE=mock`,
`PRODUCTION_REDEMPTION_ENABLED=false`, `CODE_DISCOVERY_ENABLED=false`, and
`DISCORD_DELIVERY_ENABLED=true`. This is still the 2026-09-17 version, not Task 18's Follow code.
The D1 migration journal contains exactly `0001`–`0004`; Wrangler reports only additive `0005`
and `0006` pending. Schema inspection found no `dispatch_hold_*`, `uncertain_count`, or
`discovered_code_events`, as expected before those migrations.

Bounded D1 aggregates at that read: 1 player, 1 gift code, 2 operations (both `summarized` with
`summary_state=delivered`), 0 unfinished operation items, 0 outstanding redemptions, 0
legacy-0005 hold candidates, 0 `outcome_uncertain` reason rows under the old schema, 1 outbox
row already `enqueued` (0 `pending`/`sending`/`dead`), and 2 output deliveries both `sent`.
These counts are a snapshot, not a queue-depth inspection, a guarantee of a later player count,
or proof that 0005/0006 can be applied without a fresh gate. No player/code rows, code values, message
contents, credential values, or queues were read. Re-read schema/journal and aggregates just
before any separately approved migration or activation.

At the first read, the maintainer had supplied destination feed ID `1550653633014661220` and an
invite link but not a selected message or local bot authentication. Those inputs arrived later.
The 2026-09-19T02:50Z exact-message read and local-only tuple are recorded in the
[Follow evidence](discord-ingestion-and-registration.md#task-19-read-only-preflight-and-proposed-controlled-test--2026-09-19).
The derived webhook/source/message IDs live only in an ignored local Task 19 manifest. The
maintainer later confirmed that the referenced staging channel is their **controlled test
source** and checked Discord's Channels Followed UI to confirm it follows into `wos-code-feed`.
That is maintainer-verified configuration, not an approved deployment configuration or a
successful exact-webhook API read; the bot received 403. No enabled deployment value was checked
in, and the original Cloudflare snapshot above was not repeated or changed.

### Task 20 preparation read-only staging snapshot — 2026-09-19

At 2026-09-19T04:15:46Z, named-resource Wrangler 4.127.1 and the documented read-only
Cloudflare Queue/Cron GETs reconfirmed the existing `7a083c14-a7ac-4875-ad11-04de4b10b139`
Worker version at 100%, with staging D1, registration/fanout Queue bindings, both required
secret **names**, `PROVIDER_MODE=mock`, production redemption false, discovery false and delivery
true. A read-only in-memory inspection of the exact active script content confirmed manual and
registration ingress markers, no Follow endpoint marker, and no `dispatch_hold` guard marker;
no bundle body was printed or saved. The migration journal still contained exactly `0001`–`0004`;
only `0005` and `0006` were
pending. Hold columns, `uncertain_count` and the Follow ledger were absent. Bounded aggregate
counts: 1 player, 1 code, 2 prior operations (both summarized/delivered), 0 unfinished items,
0 outstanding redemptions, 0 legacy hold candidates, 0 uncertain reason rows, 1 previously
enqueued outbox row (0 pending/dead), and 2 sent outputs. No player or code rows were exported.

Each of the three named Queues had one consumer, 86,400-second retention, and a point-in-time
backlog count/bytes of 0/0 with no oldest message timestamp. The staging Worker had one
`* * * * *` Cron trigger. Queue metrics do not prove the absence of in-flight invocations; the
[Task 20 runbook](../task20-staging-follow-smoke.md) uses pause, consumer detachment and the
documented Cron propagation/invocation bounds for that safety gate. The known Task 19 local
preflight/auth files were absent from their exact stated path at this checkout; no values were
read or searched for elsewhere. Nothing was migrated, deployed, enabled or published by this
snapshot.

Later on 2026-09-19, the maintainer supplied an ignored project
`.wrangler/secrets-staging.md` containing both required private companion names. Its values
were neither printed nor copied; the launcher accepted its whitespace around `=` and passed
offline configuration validation using a synthetic controlled tuple. The maintainer supplied
one exact controlled destination message link and its original source link. A single bot GET
for that destination message returned 403; a separate current-application identity GET also
returned 403. Neither was retried after the 403. The maintainer then copied the destination
message's author ID. Discord's documented author/webhook relation, the supplied exact
source/destination links, and Task 19's matching historical exact-message read support a
proposed four-field tuple. Its ignored generated bridge/guarded/enabled configurations passed
three strict offline Wrangler dry runs, and the companion passed offline validation with the
new private file. The raw follower `webhook_id` and exact webhook object's type/source fields
were not re-read in this checkout; the review must accept or resolve that limitation before
the live gate. These later checks did not change the 04:15:46Z Cloudflare snapshot or any
staging resource.

At the later 2026-09-19T04:59:22Z read-only refresh, the same older Worker version remained
the latest 100% deployment. All three Queues still had one consumer each, 86,400-second
retention, zero point-in-time backlog and no oldest-message timestamp; one minute Cron remained.
D1 still had four applied migrations, with `0005` and `0006` pending and their schema absent.
Bounded counts remained one player and zero unfinished items, outstanding redemptions,
legacy hold candidates, uncertainty reasons, pending/dead outbox jobs and unsent outputs.
The chosen synthetic code had zero `gift_codes` matches. These observations are a dated
approval baseline and must be repeated immediately before any approved mutation.
