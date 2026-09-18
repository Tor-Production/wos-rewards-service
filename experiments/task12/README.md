# Task 12 local experiment

This is a local caller against the live game, isolated from the deployed service.
Authorization and community contract: [provider decision §16](../../docs/whiteout-provider-decision.md#16-task-12--bounded-local-live-experiment-2026-09-18).

Offline verification, from the repository root:

```powershell
npm run test:probe
node dist/task12/experiments/task12/driver.js
node dist/task12/experiments/task12/driver.js --digest
npm run check
npm run test:mvp
git diff --check
```

Default driver execution prints an offline notice and does no network I/O. No npm script
invokes live mode. Tests inject synthetic signers/transports; the native HTTPS tests replace
the socket API. The root Workers suite excludes this Node-only experiment directory.

The explicit `--live` mode reads one fixed private `authorization.json`; it takes no pair,
endpoint, marker, path, or run-ID command-line overrides. The manifest requires reference,
playerId, state, code, consent, unredeemed, reserved, startsAt, cutoff, expiry (`unknown` or
an ISO UTC instant), harnessDigest and checksPassed. It is an operator-recorded artifact,
not a way to generate consent. All times must be explicit UTC instants. A fresh build and
passing focused tests must precede recording the digest and dispatch. No new authorization
is inferred from editing these files or supplying an arbitrary manifest.

One native HTTPS POST has a 30-second deadline, no retry and no redirect handling. The
signing material is fetched from pinned public source in memory; the source is never run.
No browser impersonation, cookies or user credentials are used. A fixed exclusive marker
is durably created before dispatch. Never remove it, change its path, or bypass the disable
latch. The driver records allowlisted evidence and disables itself after attempt or abort.
`requests` counts transport dispatches; an interrupted socket cannot prove server receipt.
An absent result after an interrupted process remains unresolved with the marker consumed.

The exact fixed private paths are in the provider decision. Keep them outside version
control and preserve them across process/worktree restarts. Only the approved pair may be
sent. Additional accounts, replay, corrections, state lookup and manual retry are excluded.
API success and human in-game mail confirmation are separate evidence. SAME TYPE EXCHANGE
is not proof that this exact code was applied. No result establishes production readiness.
