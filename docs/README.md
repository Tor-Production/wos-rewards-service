# wos-rewards-service — documentation

This is the current-state and routing page for the Cloudflare-hosted Discord service. The service
registers Whiteout Survival players from plain messages, accepts an allow-listed manual code
command, and processes work through D1 and Cloudflare Queues. `AGENTS.md` is the binding source for
safety, engineering, issue/branch workflow, registration parsing, and the runtime Discord footer.

Use this page to choose the smallest authoritative document sections for a task. GitHub owns active
work, future work, and pull-request history; repository documents own stable architecture, contracts,
authorization records, and dated technical evidence.

## Current state

| Area | Current meaning |
|---|---|
| Repository runtime | Strict TypeScript Worker, D1, Queue/DLQ consumers, durable summary/output delivery, authenticated registration and manual-code intake, and a provisional foreground `discord.js` companion. Development, tests, runtime routing, and the recorded staging deployment use `MockWhiteoutProvider`. |
| Task 13 in `main` | Additive migration `0005` and the merged consumer/recovery guards retain potentially applied player/code outcomes as uncertainty without automatic replay. Dispatch evidence is written before a potentially applying call; timeout, exception, lost result, and process-loss paths preserve the hold. Frozen summaries count uncertainty separately. This is local/repository state, not a real-provider implementation or upstream reconciliation guarantee. |
| Deployed evidence | Task 09's mock-only Discord smoke and Task 19's [read-only observation](architecture/configuration.md#task-19-read-only-staging-preflight--2026-09-19) are dated historical records. Task 21 later deployed the guarded staging runtime and applied migrations `0005`/`0006`. Task 24 applied `0007`; its one-fetch staging baseline smoke failed closed, then restored healthy discovery-disabled/mock staging. The exact fetch failure is unknown. See [issue #44](https://github.com/Tor-Production/wos-rewards-service/issues/44). |
| Task 12 experiment | A narrow, dated local exception exercised one private pair and one separate already-applied check against the live game. Both agent request budgets are consumed and disabled. The harness remains outside the Worker, D1, Queues, Discord, and provider selection; it does not authorize a general provider, replay after an unknown outcome, or production activation. |
| Environments and Discord topology | The application accepts `staging` only. The Task 09 Option 2 companion is provisional and was stopped after its dated smoke. ADR 0001 remains **Proposed**; the 72-hour Option 1 spike is deferred, not passed or waived, and the Task 08C Durable Object remains local-test-only. |
| Follow intake | Disabled offline staging/mock push intake, authenticated Worker revalidation, immutable source/event provenance (migration `0006`) and existing distribution pipeline are implemented. [Task 19 read-only staging preflight](architecture/discord-ingestion-and-registration.md#task-19-read-only-preflight-and-proposed-controlled-test--2026-09-19) confirms the old mock/discovery-disabled Worker, journal `0001`–`0004`, and selected historical message's strict text shape/content access. Its reference points to a **controlled staging source** whose Follow relationship the maintainer verified in Discord UI; the bot's exact-webhook GET was denied. This is not official-source or fresh Gateway evidence. Discovery and activation remain disabled. |
| Community JSON source | PR #43 merged the disabled staging/mock scheduled path with an exact endpoint, durable 30-minute request gate, baseline-only first snapshot, bounded reconciliation and immutable first observation (migration `0007`). Task 24 applied that migration in staging and restored the source-disabled Worker after the first scheduled fetch did not initialize a baseline. Automatic discovery remains disabled. See [discovery policy §7](whiteout-provider-decision.md#7-gift-code-discovery-source-status). |
| Task 20 preparation | The [controlled staging Follow smoke runbook](task20-staging-follow-smoke.md) records the isolated cutover, fresh read-only baseline, explicit Queue consumer detachment/recovery and approval-gated bot preflight. The ignored local tuple matches Task 19 exact-message evidence, and the private bot-auth file is present; an exact local approval bundle is frozen for review. It has not migrated, deployed, logged in, published or enabled discovery. The historical webhook-object GET and newer exact-message/application GETs returned 403; current bot readiness remains unproven. |
| Active gates | Production redemption and automatic discovery are disabled. No authorized production `WhiteoutProvider` exists. The exact narrow provider-gate amendment is accepted, but upstream operator authorization, a verified authorized contract, separate offline-slice approval, §5 evidence, and the documented activation approvals remain unsatisfied. The broader stage A–D proposal remains pending. |

For the exact historical non-secret staging inventory, use the
[Task 09 deployment record](architecture/configuration.md#task-09-staging-deployment-record-non-secret).
For the dated activation sequence and limitations, use the
[staging MVP gate](architecture/operations-and-reliability.md#task-09-staging-mvp-activation-gate).
The Task 09 link is historical; the separate [Task 19 staging read](architecture/configuration.md#task-19-read-only-staging-preflight--2026-09-19) is a dated, bounded observation, not activation evidence.

Active work and dependencies are maintained in the
[GitHub issue tracker](https://github.com/Tor-Production/wos-rewards-service/issues) and the pinned
[project roadmap and working agreement](https://github.com/Tor-Production/wos-rewards-service/issues/25).
Task numbers identify repository milestones; issue numbers identify tracker records and are not the
same sequence.

## Documentation routing

| Document | Read it for |
|---|---|
| [../README.md](../README.md) | Reader-facing purpose, supported Discord input, local setup, package commands, migrations, and current limits. |
| [architecture.md](architecture.md) | Orientation: scope/non-goals, system context, component boundaries, cross-cutting idempotency, phase order (§23), official sources, and the traceability map. |
| [architecture/configuration.md](architecture/configuration.md) | Configuration and secret names, validation constraints, and the dated Task 09 non-secret deployment record. |
| [architecture/discord-ingestion-and-registration.md](architecture/discord-ingestion-and-registration.md) | Discord source boundaries, author filtering, parsing, atomic registration acceptance, manual-code intake, and disabled Follow intake/activation checklist. |
| [architecture/data-model-and-outbox.md](architecture/data-model-and-outbox.md) | D1 schema, migrations, identifiers, transactional outbox, Task 13 migration `0005`, Follow migration `0006`, and community migration `0007`. |
| [architecture/redemption-state-machine.md](architecture/redemption-state-machine.md) | Provider interfaces, Queue/DLQ ownership, the T1–T17 transitions, retry classification, and the durable Task 13 uncertainty hold. |
| [architecture/summary-and-delivery.md](architecture/summary-and-delivery.md) | Frozen completion accounting and the paged seal/layout/render/delivery pipeline, including Discord output safety. |
| [architecture/operations-and-reliability.md](architecture/operations-and-reliability.md) | Cron budgets, staging separation, historical activation evidence, observability, testing, failure recovery, and scenario matrices. |
| [architecture/open-decisions-and-risks.md](architecture/open-decisions-and-risks.md) | Settled decisions, open decisions, and risks; check before assuming a gate or topology is resolved. |
| [adr/0001-discord-event-ingestion.md](adr/0001-discord-event-ingestion.md) | Proposed ingestion-topology decision, the deferred Gateway spike, and its pass thresholds. |
| [whiteout-provider-decision.md](whiteout-provider-decision.md) | Provider authorization and evidence, mock/error contracts, real-provider acceptance gates, Task 10 research, Task 13 qualification, and Task 12’s dated exception/evidence. Use the targeted routing below instead of loading it wholesale. |
| [../experiments/task12/README.md](../experiments/task12/README.md) | Offline-default Task 12 harness behavior, consumed budgets, and disabled-state evidence boundaries. Do not inspect private local records for ordinary work. |

Each subject has one owner. The overview and this router summarize and link; they do not replace a
normative rule. Historical evidence stays in its owning document and is loaded only when the task
needs it.

### Provider-decision section routing

The provider decision is a large evidence record. Load only the sections relevant to the question:

| Task | Sections |
|---|---|
| Check current provider status or permission | [§1 current status](whiteout-provider-decision.md#1-current-status), [§4 required authorization](whiteout-provider-decision.md#4-required-authorization-and-evidence-before-adding-a-real-provider), [§5 acceptance](whiteout-provider-decision.md#5-acceptance-criteria-for-a-production-provider), and [§8 prohibitions](whiteout-provider-decision.md#8-explicit-prohibition-statement). |
| Change or validate mock behavior | [§3 mock behavior](whiteout-provider-decision.md#3-mockwhiteoutprovider-behaviour) plus the provider interface/state-machine sections that own the changed code. |
| Map provider errors or retries | [§6 error mapping](whiteout-provider-decision.md#6-provider-rate-limits-and-error-mapping), [state machine §11 and §15.2](architecture/redemption-state-machine.md), and Task 13’s [§11 containment update](whiteout-provider-decision.md#task-13-local-containment-update--2026-09-18). |
| Implement/validate disabled Follow intake or evaluate live activation | [§7 discovery status](whiteout-provider-decision.md#7-gift-code-discovery-source-status), §8, and the discovery risk in [open decisions](architecture/open-decisions-and-risks.md#24-unresolved-decisions-and-risks). |
| Audit the accepted narrow gate or pending broader proposal | [§13 decision record](whiteout-provider-decision.md#13-pending-staged-gate-amendment), together with §§4–5. The exact narrow text is accepted; the broader stage A–D proposal is not. |
| Interpret Task 10 evidence or plan a later provider slice | [§10–§15](whiteout-provider-decision.md#10-task-10-public-evidence--2026-09-17), especially §11’s dated compatibility analysis and Task 13 qualification. |
| Audit the completed Task 12 exception | [§16](whiteout-provider-decision.md#16-task-12--bounded-local-live-experiment-2026-09-18). Load it only when the experiment’s authorization, contract, observations, or consumed budgets are directly relevant. |

## What to read per implementation phase

Phases are defined in [architecture §23](architecture.md#23-phased-implementation-order). Every
task also inherits `AGENTS.md`; expand beyond a row only when the scope actually crosses that
boundary.

| Phase or work type | Minimum focused context |
|---|---|
| **1 — Scaffold/configuration** | This Current state; architecture §1 and §23; configuration §4 and secret names; state machine §11 provider interfaces; provider decision §1, §3, and the rollback requirement in §5; operations §19 and §21. |
| **2 — D1 schema/migrations** | Data model §10 and §12 plus the relevant additive-migration subsection; operations §19 migration separation. |
| **3 — Ingestion/outbox** | Discord ingestion §3 and §§5–7; data model §12/§14; state machine §13 Queue rules; relevant configuration names; operations §9/§21; architecture §16 idempotency. |
| **4 — Consumers/redemption/summary** | State machine §11, §13, §15.1–§15.2 and §17; data model’s affected tables/migration; summary §§15.3–15.5 and §18; operations §9 and §§20–22; provider decision §6. Include the Task 13 hold sections for any retry/recovery work. |
| **5 — ADR 0001 spike** | ADR 0001 in full; the spike-specific ingestion/data/output guards; configuration spike names; operations spike reconciliation and Gateway metrics; open decisions §24. |
| **6 — Provisional staging companion** | ADR 0001 §§3 and 6–8; companion/manual-code ingestion; configuration names; migration `0004`; summary delivery; operations Task 09 gate and runbook. |
| **7 — Hardening/recovery** | Operations §9 and §§20–22; state machine T1–T17 and §17; relevant summary/data-model recovery sections; configuration lease, retry, and deadline names. |
| **8 — Real provider / live discovery activation (blocked)** | Use the provider-decision routing above. Always load §§1, 4, 5, and 8; add §6 for provider errors, §7 for discovery, §11 for compatibility/Task 13 containment, §13 for the accepted narrow amendment and pending broader proposal, or §16 only for Task 12 history. Also load state machine §11, relevant configuration switches, architecture §1 non-goals, and open decisions §24. Do **not** treat the whole historical provider record as routine required context. |

When a task changes the supported runtime/environment, active gates, or merged-versus-deployed
state, update this Current state section in the same pull request. Record active task progress and
future scheduling in GitHub rather than adding a second roadmap here.
