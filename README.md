# wos-rewards-service

A Cloudflare-hosted Discord service for registering Whiteout Survival players and processing
manually supplied gift codes. The repository contains a strict TypeScript Worker, D1 migrations,
Queue/DLQ consumers, durable summary delivery, and a small `discord.js` companion.

The service runtime remains **mock-only**: development, tests, and the recorded staging deployment
use `MockWhiteoutProvider`. Production redemption and automatic gift-code discovery are disabled.
Start with the [documentation router](docs/README.md) for current state and focused reading, and
read [AGENTS.md](AGENTS.md) before changing the repository.

## Current status

- `main` contains the Task 09 staging MVP on top of Phases 1–4 and the merged Task 13 uncertainty
  containment. Task 13 adds migration `0005` plus a durable pre-dispatch hold so an ambiguous
  provider timeout, exception, process loss, or lost result is retained for verification without
  automatic replay. It does not add or authorize a real provider.
- Task 13 is **merged but not deployed**. The latest committed deployment evidence is the dated
  Task 09 record: staging provisioning on 2026-09-14, deployment/migrations `0001`–`0004` on
  2026-09-15, and the mock-only Discord smoke test on 2026-09-17. Those observations have not been
  freshly reverified. See the [deployment record](docs/architecture/configuration.md#task-09-staging-deployment-record-non-secret)
  and [staging runbook/evidence](docs/architecture/operations-and-reliability.md#task-09-staging-mvp-activation-gate).
- Task 12 was a completed, isolated local live experiment under a narrow dated human exception.
  Its two agent request budgets are consumed and disabled, and its harness is outside the Worker,
  D1, Queues, Discord, and runtime provider selection. It does not establish a general provider or
  production replay guarantee. See [provider decision §16](docs/whiteout-provider-decision.md#16-task-12--bounded-local-live-experiment-2026-09-18).
- Only the `staging` application environment is supported. ADR 0001 remains Proposed; its 72-hour
  Gateway spike is deferred, not passed or waived. Production redemption and discovery remain
  blocked by the documented authorization and contract gates.

GitHub owns active work and task history. See the [issue tracker](https://github.com/Tor-Production/wos-rewards-service/issues)
and the pinned [roadmap and working agreement](https://github.com/Tor-Production/wos-rewards-service/issues/25).

## Supported Discord input

In the configured registration channel, a human may send:

```text
PLAYER_ID
PLAYER_ID DISPLAY_NAME
PLAYER_ID STATE
PLAYER_ID STATE DISPLAY_NAME
```

`PLAYER_ID` is required and numeric. A numeric second parameter is `STATE`; otherwise the service
uses configured `DEFAULT_STATE` and treats the remaining text as the optional display name.
Display names may contain spaces. Re-registering updates the existing player.

In the configured staging admin channel, an allow-listed human administrator may submit one
manual command:

```text
!wos-code CODE
```

This opens the existing durable distribution path for the manually supplied code. It is not code
discovery, and the current runtime sends redemption work only to `MockWhiteoutProvider`.

<a id="prerequisites"></a>
<a id="commands"></a>

## Local setup

Prerequisites: Node.js 20 or later and npm. Local builds and tests need no Cloudflare login,
Discord connection, or real credentials.

```powershell
npm ci
npm test
```

`npm test` runs both the Worker suite and the companion suite. Useful commands are:

| Command                  | Purpose                                                                                                                                            |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run format:check`   | Check repository formatting without rewriting files.                                                                                               |
| `npm run cf-typegen`     | Regenerate committed Worker types after a Wrangler configuration change.                                                                           |
| `npm run typecheck`      | Verify generated Worker types and strict Worker, test, and companion TypeScript.                                                                   |
| `npm run test:worker`    | Run the Worker test suite.                                                                                                                         |
| `npm run test:companion` | Run the companion test suite.                                                                                                                      |
| `npm run test:mvp`       | Run the focused staging-MVP Worker tests and companion suite.                                                                                      |
| `npm run test:probe`     | Build and test the isolated Task 12 harness offline; it sends no live request.                                                                     |
| `npm run test:shuffle`   | Run Worker and companion suites with shuffled files and tests.                                                                                     |
| `npm run validate`       | Compile a local staging dry run; it does not deploy or provision resources.                                                                        |
| `npm run check`          | Run formatting, type freshness/strict types, the offline probe, deterministic and shuffled Worker/companion suites, and the local staging dry run. |
| `npm run dev`            | Start the local Worker with staging configuration and local Miniflare storage.                                                                     |

The repository currently has no GitHub Actions workflow; `npm run check` is the complete local
pre-finish command, not a claim about hosted CI.

### Windows companion

The companion is a foreground process, not a Windows service or high-availability system. It
requires the non-secret identifiers and secret **names** documented in
[configuration](docs/architecture/configuration.md); never put secret values in chat,
documentation, committed files, commands, or logs.

```powershell
npm run companion:start
```

Stop it with Ctrl+C. Starting it against Discord is an external action and requires the applicable
human approval and host configuration; normal local validation does not start it.

## Database migrations

The additive D1 migrations live in `migrations/`:

- `0001` creates the twelve-table baseline.
- `0002` adds Phase 4 consumer, summary, and delivery state.
- `0003` adds immutable staging-spike evidence.
- `0004` adds the manual-code command idempotency ledger.
- `0005` adds Task 13 dispatch-hold evidence and separate uncertainty accounting.

Tests apply and verify the full migration sequence locally. To update only the local staging D1
database used by `npm run dev`:

```powershell
npm run d1:migrate:local
```

There is deliberately no remote-apply package command. The historical staging record covers only
`0001`–`0004`; applying `0005` remotely or deploying the merged Task 13 runtime requires separate
explicit authorization. See the [schema owner](docs/architecture/data-model-and-outbox.md#implemented-additive-task-13-uncertainty-migration-0005)
and [environment rules](docs/architecture/operations-and-reliability.md#19-staging-and-production-separation).

<a id="generated-worker-types"></a>
<a id="safety"></a>

## Safety and limits

- Staging is the default and only implemented environment; production resources do not exist in
  this repository configuration.
- `PRODUCTION_REDEMPTION_ENABLED` and `CODE_DISCOVERY_ENABLED` remain false and are rejected when
  enabled. No authorized production `WhiteoutProvider` or `GiftCodeSource` implementation exists.
- All service redemption access must cross the `WhiteoutProvider` interface. The isolated Task 12
  experiment is historical evidence, not runtime routing or general authorization.
- Real Discord output is separately gated. Local tests use synthetic events, local D1/Queues, the
  mock provider, and injected transports.
- Secrets are neither required nor used by local checks. Never commit, print, log, or request a
  token, credential, cookie, signing value, or session secret.

For architecture, operations, provider gates, and targeted reading by work type, continue to
[docs/README.md](docs/README.md).
