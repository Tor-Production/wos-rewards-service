# wos-rewards-service — documentation

A Cloudflare-hosted Discord service that registers Whiteout Survival players from plain
messages in one configured registration channel (`PLAYER_ID [STATE] [NAME]`) and applies gift
codes for them. The backend is Workers + Durable Objects + D1 + Queues, TypeScript strict
mode, staging-first. All Whiteout Survival access goes through the `WhiteoutProvider`
interface, and `MockWhiteoutProvider` is the default in development, tests, and staging.

`AGENTS.md` at the repository root is the binding contract — safety boundaries, engineering
requirements, the branch/PR workflow, the player registration contract, and the runtime
Discord footer. It wins over anything written here.

## Current state

| | |
|---|---|
| **Repository contents** | Documentation only. No application code, package manifest, Wrangler configuration, schema, or migration exists yet. |
| **Implemented phase** | None. The next step is **Phase 1 — Scaffold** ([architecture.md §23](architecture.md#23-phased-implementation-order)). |
| **Supported environments** | `staging` only, and only on paper — no stack has been provisioned. Production is defined in the design but must stay separate and unprovisioned until approved. |
| **Production gift-code redemption** | **BLOCKED.** No authorized production `WhiteoutProvider` exists; `PRODUCTION_REDEMPTION_ENABLED` must be `false` everywhere. See [whiteout-provider-decision.md](whiteout-provider-decision.md). |
| **Gift-code discovery** | **Not authorized.** `GiftCodeSource` is an abstraction only; `CODE_DISCOVERY_ENABLED` is `false`. |
| **Ingestion topology** | **Provisional.** [ADR 0001](adr/0001-discord-event-ingestion.md) is **Proposed**, not Accepted; a time-boxed spike decides between a Durable Object Gateway client and an external companion. The real `DiscordEventSource` adapter is not built until that spike completes or is explicitly waived. |
| **Checks that apply today** | Markdown review only — there is no build, type check, or test suite to run yet. |

> **Maintenance note.** Any future task that changes the implemented phase, the current gates
> (production redemption, code discovery, the ADR 0001 spike), or the supported environments
> **must update this Current state section in the same pull request** as the change. A stale
> Current state is treated as a defect, not as documentation debt.

## Documentation routing

| Document | Read it when you need |
|---|---|
| [architecture.md](architecture.md) | Orientation: scope and goals, system context and deployment topology, component boundaries, cross-cutting idempotency invariants, the phased implementation order, and the official-sources table every `[fact:<ref>]` tag resolves against. Also carries the **Document map** and the **Traceability map**. |
| [architecture/configuration.md](architecture/configuration.md) | Every non-secret variable and every secret, **names only**, with what reads each one. |
| [architecture/discord-ingestion-and-registration.md](architecture/discord-ingestion-and-registration.md) | The `DiscordEventSource` boundary, the production author gate and the staging spike exception, message parsing, atomic acceptance, and the two flows that follow it. |
| [architecture/data-model-and-outbox.md](architecture/data-model-and-outbox.md) | Identifier handling, the preliminary D1 tables, and the transactional outbox. |
| [architecture/redemption-state-machine.md](architecture/redemption-state-machine.md) | The provider abstractions, Queue and DLQ boundaries, the item lease, the global redemption record with the **T1–T16** transition table, and retry / permanent-failure classification. |
| [architecture/summary-and-delivery.md](architecture/summary-and-delivery.md) | Completion accounting and the source freeze, the paged seal → layout → render → deliver pipeline, zero-result operations, and Discord output safety including footer placement. |
| [architecture/operations-and-reliability.md](architecture/operations-and-reliability.md) | Scheduled components and the Cron budget, staging/production separation, observability, the testing strategy, failure modes and recovery, and the scenario matrix. |
| [architecture/open-decisions-and-risks.md](architecture/open-decisions-and-risks.md) | What is Resolved, what is Open, and the known Risks — check here before assuming a decision is settled. |
| [adr/0001-discord-event-ingestion.md](adr/0001-discord-event-ingestion.md) | The ingestion-transport decision (**Proposed**), the options compared, and the spike design and pass thresholds. |
| [whiteout-provider-decision.md](whiteout-provider-decision.md) | What Whiteout Survival access is authorized, the `MockWhiteoutProvider` contract, the provider error-mapping contract, acceptance criteria for a real provider, and the explicit prohibitions. |

Each subject has exactly one owning document. `architecture.md` summarizes and links; it does
not restate a normative rule another document owns. The runtime Discord footer **text** lives
only in `AGENTS.md` and is reproduced in no document.

## What to read per implementation phase

Phases are the ones in [architecture.md §23](architecture.md#23-phased-implementation-order).
Load the sections listed — not the whole corpus. If a task grows beyond its row, load the
containing document rather than guessing.

| Phase | Sections to load |
|---|---|
| **1 — Scaffold** (TypeScript strict, Wrangler config for the `staging` stack, `MockWhiteoutProvider`, test harness) | this file (Current state); [architecture.md](architecture.md) §1, §23; [configuration.md](architecture/configuration.md) §4 (`ENVIRONMENT`, `PROVIDER_MODE`, `PRODUCTION_REDEMPTION_ENABLED`, `LOG_LEVEL`) and Secrets; [redemption-state-machine.md](architecture/redemption-state-machine.md) §11 (the `WhiteoutProvider` interface and `MockWhiteoutProvider` requirements); [whiteout-provider-decision.md](whiteout-provider-decision.md) §1, §3 (`MockWhiteoutProvider` behaviour), §5 (rollback switch, mock parity); [operations-and-reliability.md](architecture/operations-and-reliability.md) §21 (mandated unit tests, Workers-compatible runner, pre-finish gate), §19 (staging/production separation) |
| **2 — D1 schema + migrations** | [data-model-and-outbox.md](architecture/data-model-and-outbox.md) §10, §12 (all tables); [operations-and-reliability.md](architecture/operations-and-reliability.md) §19 (migrations staging first, then production after review) |
| **3 — Ingestion Worker + `DiscordEventSource` interface + atomic acceptance + transactional outbox + Queues** | [discord-ingestion-and-registration.md](architecture/discord-ingestion-and-registration.md) §3, §5, §6, §7; [data-model-and-outbox.md](architecture/data-model-and-outbox.md) §12 (`processed_events`, `operations`, `operation_items`, `outbox_jobs`), §14; [redemption-state-machine.md](architecture/redemption-state-machine.md) §13 (queue names, batching and retry limits **[fact:C6–C8]**, consumer-side dedup — there is no producer idempotency key); [configuration.md](architecture/configuration.md) §4 (`DISCORD_*`, `DEFAULT_STATE`, `*_QUEUE`, `OUTBOX_DISPATCH_MAX_ATTEMPTS`, `FANOUT_EXPANSION_PAGE_SIZE`, `SPIKE_SENDER_ALLOWLIST`) and Secrets (`INGESTION_SHARED_SECRET`); [operations-and-reliability.md](architecture/operations-and-reliability.md) §9 (outbox dispatcher cadence), §21 (atomic-acceptance, author-filter, parser, outbox-`dead` tests); [architecture.md](architecture.md) §16 (event-acceptance and outbox → queue idempotency) |
| **4 — Consumers + global redemption serialization + operation aggregation + durable output delivery** | [redemption-state-machine.md](architecture/redemption-state-machine.md) §11 (`RedeemResult`), §15.1, §15.2 (**T1–T16**), §13 (DLQ consumer, T10/T11), §17; [whiteout-provider-decision.md](whiteout-provider-decision.md) §6 (provider rate limits and the error-mapping contract the adapter must fill in); [summary-and-delivery.md](architecture/summary-and-delivery.md) §15.3, §15.4, §15.5, §18 (footer placement); [data-model-and-outbox.md](architecture/data-model-and-outbox.md) §12 (`redemptions`, `operation_items`, `operation_late_results`, `summary_item_snapshot`, `summary_chunk_layout`, `discord_output_deliveries`); [operations-and-reliability.md](architecture/operations-and-reliability.md) §9 (summary builder, output dispatcher, sweeper), §20 (invocation-transition metrics), §21 (serialization, T3, T9 → T2, DLQ, state-cap, summary tests), §22, §15.6; [configuration.md](architecture/configuration.md) §4 (lease TTLs, `PROVIDER_MAX_RETRIES`, `SUMMARY_*`, `REDEMPTION_*`, `OPERATION_DEADLINE_SECONDS`) |
| **5 — ADR 0001 spike** | [adr/0001-discord-event-ingestion.md](adr/0001-discord-event-ingestion.md) in full, especially §5, §6 (spike design, pass thresholds, reporting rule), §8; [discord-ingestion-and-registration.md](architecture/discord-ingestion-and-registration.md) §3 (Author filtering, Staging spike exception); [configuration.md](architecture/configuration.md) §4 (`SPIKE_SENDER_ALLOWLIST`, `ENVIRONMENT`, `DISCORD_*`) and Secrets; [operations-and-reliability.md](architecture/operations-and-reliability.md) §19 (staging-only allow-list), §20 (Gateway reconnect / RESUME / IDENTIFY counters); [open-decisions-and-risks.md](architecture/open-decisions-and-risks.md) §24 (Open — Option 1 reliability; Risks) |
| **6 — Chosen `DiscordEventSource` adapter** *(blocked until phase 5 completes or is waived)* | [adr/0001-discord-event-ingestion.md](adr/0001-discord-event-ingestion.md) §3, §7, §8; [discord-ingestion-and-registration.md](architecture/discord-ingestion-and-registration.md) §3 in full (including the `RegistrationMessageEvent` contract and companion validation scope); [configuration.md](architecture/configuration.md) Secrets (`DISCORD_BOT_TOKEN`, `INGESTION_SHARED_SECRET`, `DISCORD_PUBLIC_KEY`) and §4 (`DISCORD_GUILD_ID`, `DISCORD_REGISTRATION_CHANNEL_ID`, `DISCORD_APPLICATION_ID`); [operations-and-reliability.md](architecture/operations-and-reliability.md) §20 (ingestion-tier observability), §22 (`DiscordEventSource` down, Resume failure, `/ingest` unavailable) |
| **7 — Observability, sweepers, DLQ consumer, hardening** | [operations-and-reliability.md](architecture/operations-and-reliability.md) §9 (all scheduled jobs including the operation sweeper and retention), §20 in full, §22, §15.6, §21; [redemption-state-machine.md](architecture/redemption-state-machine.md) §15.2 (Crash-safe re-drive — T12/T15; Terminal-write guards; Terminality is per `reason_code`), §13 (DLQ inspection consumer — T10/T11), §17; [summary-and-delivery.md](architecture/summary-and-delivery.md) §15.3 (the freeze guard sweeper mirror writes must honour), §15.4 (seal on force-close); [data-model-and-outbox.md](architecture/data-model-and-outbox.md) §12 (`redemptions`, `operation_late_results`), §14 (`dead` handling, atomic reopen, `repair_run`); [configuration.md](architecture/configuration.md) §4 (`SWEEPER_REDRIVE_BATCH`, `REDEMPTION_MAX_REEVAL`, `REDEMPTION_AUTO_REOPEN_RETRY_EXHAUSTED`, `OPERATION_DEADLINE_SECONDS`, `*_CLAIM_LEASE_SECONDS`, `OUTPUT_DISPATCH_MAX_ATTEMPTS`) |
| **8 — Blocked: authorized `WhiteoutProvider` / `GiftCodeSource`, production redemption** | [whiteout-provider-decision.md](whiteout-provider-decision.md) in full (§4 required authorization and evidence, §5 acceptance criteria, §6 error mapping, §7 discovery-source status, §8 prohibitions, §9 change log); [redemption-state-machine.md](architecture/redemption-state-machine.md) §11 (`GiftCodeSource` — **not authorized**); [configuration.md](architecture/configuration.md) §4 (`PRODUCTION_REDEMPTION_ENABLED`, `PROVIDER_MODE`, `CODE_DISCOVERY_ENABLED`, `PROVIDER_RATE_LIMIT_PER_SECOND`); [architecture.md](architecture.md) §1 (Non-goals); [open-decisions-and-risks.md](architecture/open-decisions-and-risks.md) §24 (Open — the discovery source; Risks) |

Every phase additionally inherits `AGENTS.md`: staging is the default environment, no
production action without explicit human approval, and no secret is ever committed, printed,
logged, or requested.
