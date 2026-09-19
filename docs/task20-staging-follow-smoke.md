# Task 20 controlled staging Follow smoke — preparation runbook

Status: **approved attempt stopped before mutation; replacement read-only verification under review**. Owner: [issue #35](https://github.com/Tor-Production/wos-rewards-service/issues/35); partial parent [#22](https://github.com/Tor-Production/wos-rewards-service/issues/22). This page preserves the frozen runtime/config/build/tuple/synthetic inputs and proposes a separate verification helper. The original approval still covers the remaining single staging/mock cutover and smoke scope; the one bot preflight is consumed and must not be repeated. **Stop before Cloudflare mutation or publication until the replacement gate is reviewed and its fresh checkpoint evidence is available.** A material scope change needs separate approval.

**Dated execution note — 2026-09-19:** The first read-only Queue topology check stopped before any mutation because all three Queue GET responses omitted `settings.delivery_paused`. The approved single bot preflight later passed once. A separate signed-in Dashboard read then showed all three exact Queues `Active` with a `Pause` control at 09:50–09:52 UTC. Those observations are [dated evidence](architecture/configuration.md#task-20-approved-attempt-stopped-at-the-queue-baseline--2026-09-19), not a resumed baseline or evidence after a later checkpoint. No Worker deployment, migration or announcement occurred.

## Scope and fixed resources

Only the existing `wos-rewards-service-staging` Worker on its `workers.dev` route, D1 `wos-rewards-service-staging` (`6dc171c2-27f5-4ef2-8788-ebd243cd354f`), registration Queue `wos-rewards-registration-jobs-staging`, fanout Queue `wos-rewards-code-fanout-jobs-staging`, and DLQ `wos-rewards-redemption-dlq-staging` may change. The three queue IDs are recorded in [configuration](architecture/configuration.md#task-09-staging-deployment-record-non-secret). Existing staging Discord application `1542396374832652369`, guild `1455981004261953659`, feed `1550653633014661220`, and admin output channel `1548863407334101122` are the only Discord surfaces. The follower webhook and controlled source IDs remain in a local non-secret manifest, never in GitHub. The exact webhook-object GET returned 403; the maintainer verified the Follow relationship in Discord UI, but webhook type/source fields were not independently read. The test accepts that narrow limitation and must capture a fresh Gateway envelope; it cannot establish an official source.

The maintainer's [Channels Followed screenshot](https://share.zight.com/01a0b7f2-c3d4-7d9f-9799-3d50a0a43671) shows `3604 [LOS] #codes-source-test` posting into `#wos-code-feed` alongside a separate official Follow. A second Discord screenshot shows **0 Webhooks** and **2 Channels Followed** in that channel's Integrations UI. These are distinct UI categories: Discord's API defines [Channel Follower as an internal webhook type 2](https://docs.discord.com/developers/resources/webhook#webhook-object-webhook-types); its [message object](https://docs.discord.com/developers/resources/message#message-object) can carry `webhook_id`, and the author ID corresponds to that ID when webhook-authored. The supplied original message link establishes that the controlled source guild is the staging guild. The supplied destination message ID decodes to the same `2026-09-19T01:54:38.314Z` create time recorded in Task 19's exact-message read. The staging bot has no source-channel permission; it observes only the destination feed. Do not substitute the other Follow, infer an ID from the displayed name, or loosen the exact source/webhook filter.

After the maintainer supplied the exact controlled destination-message link and the private file, one documented bot GET for that message returned HTTP 403. A separate current-application identity GET also returned 403. No response body, message content or credential was emitted, no history/source scan was made, and neither endpoint was retried after its 403. The two responses do not establish whether the restriction is bot permission, token scope or an upstream API access rule. The ignored tuple is independently checked against Task 19's earlier exact-message metadata, including the raw `webhook_id`; it is not based only on an author-ID inference. The webhook object's type/source fields were not read because that historical exact-object GET returned 403. An approval-gated, bounded readiness check must succeed before any Cloudflare mutation; a 403 or other failure stops the cutover without retry or credential rotation.

At the 2026-09-19 preparation read, the active Worker was `7a083c14-a7ac-4875-ad11-04de4b10b139` at 100%, mock, production redemption false, discovery false, Discord delivery true, with both required secret **names** bound. The D1 journal had `0001`–`0004`, no hold/discovery columns, one player, two delivered prior operations, zero unfinished items, zero outstanding redemptions, zero legacy hold candidates, zero pending/dead outbox, and zero unsent output. All three queue point-in-time backlog metrics were zero, with 86,400-second retention. These are dated observations, not a later gate or a claim that approximate metrics prove no invocation exists.

## Why the bridge is necessary

Migration `0005` adds dispatch holds to legacy unresolved work. The deployed pre-0005 Queue and recovery code does not respect those holds. The temporary `src/cutover/disabled.ts` returns HTTP 503 without reading request bodies, has no scheduled work, and retries any unexpected Queue delivery without acknowledging it. Its generated config has no Queue consumers or Cron trigger, while keeping the same Worker name, staging bindings, route, mock mode, delivery setting, and discovery false. **Wrangler 4.127.1 does not detach existing consumers when `queues.consumers=[]` is deployed.** Pause all three Queues, explicitly remove each existing consumer with `queues consumer worker remove`, and verify zero attachments before deploying the bridge. The empty config then avoids reattaching them. D1 accepted work, outbox rows, held rows and stored Queue messages are not removed. The bridge is never the post-migration fallback: it cannot process durable work indefinitely before queue retention expires. [Cloudflare consumer removal](https://developers.cloudflare.com/workers/wrangler/commands/queues/).

Cloudflare says a paused Queue retains messages but expiry still applies; pausing prevents push and pull delivery. The three queue consumers have at most 15 minutes per invocation. Cron removal can take **up to 15 minutes** to propagate, and each Cron invocation can then run for **up to 15 minutes**. Therefore, after the bridge deploy is confirmed as the sole 100% version and its three consumers are absent, wait **30 full minutes after the Cron-removal acknowledgement** before `0005`, and recheck journal and work counts. This is the platform's 15+15 minute bound, not a zero-depth inference. Record the exact UTC acknowledgement and earliest migration time. If Cron-removal metadata cannot be confirmed, stop before migration. [Cloudflare Queue pause](https://developers.cloudflare.com/queues/configuration/pause-purge/), [Cron propagation](https://developers.cloudflare.com/workers/configuration/cron-triggers/), [invocation limits](https://developers.cloudflare.com/workers/platform/limits/), [Queue retention](https://developers.cloudflare.com/queues/platform/limits/).

HTTP invocations have no platform duration bound while the client stays connected. Do **not** claim the bridge kills earlier HTTP invocations. The old fetch paths only accept registration/manual code and may append outbox jobs; they do not run redemption consumers or recovery. The historical Task 09 source and a read-only, in-memory marker check of the exact active script support this path inventory; the active script has no `dispatch_hold` marker. Migration `0005` holds only unresolved `in_progress`, `retry_wait`, or charged `pending` rows; post-0005 guarded uncertainty uses `outcome_uncertain`. The old registration reopen predicate targets only `permanent_failure/player_ineligible`, while old manual acceptance only inserts new code/operation/snapshot rows. Thus an old HTTP completion may create accepted work, but cannot clear or replay a `0005` hold. Recheck aggregates after the 30-minute drain and preserve any new accepted work. Do not use an old HTTP request completion as proof of a stopped old Cron or Queue invocation.

## Offline preparation and approval freeze

Run from the reviewed Task 20 worktree in PowerShell. Use installed Wrangler **4.127.1** via `node_modules/.bin/wrangler.cmd`. Keep the controlled tuple in an ignored local `KEY=value` file containing the four `DISCORD_CODE_*` names from `scripts/task20-config.ps1`; keep companion credentials in a separate existing private file. Neither file is printed, committed, copied into a command argument or uploaded. The companion's required names are `DISCORD_BOT_TOKEN` and `INGESTION_SHARED_SECRET`. The tuple must match the Task 19 observed destination/webhook/source and the maintainer's controlled Follow check; do not substitute official-source IDs or broaden filters.

```powershell
$ErrorActionPreference = 'Stop'
$wrangler = (Resolve-Path .\node_modules\.bin\wrangler.cmd).Path
$tuplePath = (Resolve-Path .\.task20-local\controlled.env).Path
& .\scripts\task20-config.ps1 -Mode Bridge
& .\scripts\task20-config.ps1 -Mode Guarded -TuplePath $tuplePath
& .\scripts\task20-config.ps1 -Mode Enabled -TuplePath $tuplePath
foreach ($mode in @('bridge','guarded','enabled')) {
  & $wrangler deploy --dry-run --strict --env staging --config ".task20-local/wrangler.$mode.jsonc"
  if ($LASTEXITCODE -ne 0) { throw "Dry run failed: $mode" }
}
git rev-parse HEAD
git rev-parse 'HEAD^{tree}'
Get-FileHash .task20-local/wrangler.*.jsonc -Algorithm SHA256
```

Review the generated files locally: bridge must declare zero consumers, zero Cron and discovery false; guarded must restore the three exact consumers and one-minute Cron with discovery false; enabled must differ from guarded only by discovery true and contain the exact controlled tuple. The checked-in `wrangler.jsonc` remains discovery false. Bind the build output/config hashes and the exact synthetic three-line announcement to the approval. Use a fresh unique synthetic code absent from `gift_codes` (check only `SELECT COUNT(*)` for that selected literal), an exact parser-compatible expiry label, and the prescribed redemption-page text. No real game validity is needed or requested.

Before any mutation repeat: `gh issue view 35`, `git status --short`, active Worker deployment/version metadata (single version at 100%, bindings, mock/off switches), `wrangler d1 migrations list wos-rewards-service-staging --remote --env staging`, the journal/schema/count SQL below, all three `wrangler queues info` calls and documented `/metrics` GETs. The reviewed baseline must still be **one player**, no unexpected ongoing work, no uncertainty, no oldest queued message older than **22 hours**, and only `0005` then `0006` pending. This leaves two hours within the known 24-hour retention for the 30-minute drain, restoration and bounded smoke; abort and restore earlier if the oldest message approaches 23 hours. A changed player count or workload requires a new exact expected fanout and approval bundle. The point-in-time Queue metrics are a retention/backlog signal, not a proof of no in-flight work. Confirm companion stopped before the cutover. The approved Discord preflight reads already occurred once and are not repeated.

```powershell
& $wrangler deployments list --name wos-rewards-service-staging --env staging --json
& $wrangler d1 migrations list wos-rewards-service-staging --remote --env staging
& $wrangler d1 execute wos-rewards-service-staging --remote --env staging --json --command "SELECT name FROM d1_migrations ORDER BY id"
& $wrangler d1 execute wos-rewards-service-staging --remote --env staging --json --command "SELECT (SELECT COUNT(*) FROM players) AS players,(SELECT COUNT(*) FROM operation_items WHERE status IN ('pending','in_progress')) AS unfinished_items,(SELECT COUNT(*) FROM redemptions WHERE status IN ('pending','in_progress','retry_wait')) AS outstanding_redemptions,(SELECT COUNT(*) FROM redemptions WHERE status IN ('in_progress','retry_wait') OR (status='pending' AND provider_invocations>0)) AS legacy_hold_candidates,(SELECT COUNT(*) FROM redemptions WHERE reason_code='outcome_uncertain') AS uncertain_reasons"
& $wrangler d1 execute wos-rewards-service-staging --remote --env staging --json --command "SELECT status,COUNT(*) AS n FROM outbox_jobs GROUP BY status;SELECT status,COUNT(*) AS n FROM discord_output_deliveries GROUP BY status"
foreach ($q in @('wos-rewards-registration-jobs-staging','wos-rewards-code-fanout-jobs-staging','wos-rewards-redemption-dlq-staging')) { & $wrangler queues info $q }
```

### Replacement read-only Queue delivery gate for review

Keep the frozen runtime checkout, generated configs, build outputs, tuple and synthetic text unchanged. Run `scripts/task20-observe.ps1` and `scripts/task20-topology.ps1` from the separately reviewed **evidence checkout** at its recorded commit, using **PowerShell 7.5 or newer** so JSON UTC timestamps remain strings (`ConvertFrom-Json -DateKind String`); record both helper file hashes apart from the frozen runtime/config/build hashes. The observer still validates the expected Cloudflare account, each exact Queue ID, integer consumer count, 86,400-second retention, bounded metrics and the Worker's Cron via documented GETs. Its seven direct Queue/metrics/Cron API GETs each have an eight-second timeout. It keeps the Wrangler OAuth token in memory, clears it, and emits no header or token. A nonzero backlog without a valid oldest-message timestamp fails; a zero point-in-time backlog never proves no in-flight work. The baseline still requires an oldest queued message younger than 22 hours, and later checkpoints must stop before the 23-hour retention margin.

For **every** checkpoint in the table, including recovery and repeated hold checks:

1. Immediately **after that checkpoint's last relevant mutation** (or just before the initial baseline read), record `$checkpointStartUtc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')` and a new unique `$checkpoint` ID. Do not reuse an earlier ID or receipt. For a recovery inventory after a partial/failed command, record the start after the command returns or is interrupted.
2. Open each of the three exact Cloudflare Queue **Messages** URLs in a new tab or perform a full browser reload (`Ctrl+Shift+R`) in a signed-in Dashboard session **after** that start time; wait for each page to load. A cached SPA view from before the action is not evidence. On each newly loaded page, verify its breadcrumb, Queue ID and URL; read the `Pause Delivery` section and record its explicit `Status: Active` with `Pause` control, or `Status: Paused` with `Resume` control, plus that page's UTC observation time. Do not press either control during observation.
3. Save a new ignored `.task20-local/dashboard-<checkpoint>.json` with `checkpoint` and a `queues` array of exactly three rows. Each row has string fields `name`, `queue_id`, `url`, `observed_utc`, `section`, `status`, and `control`. The exact identity pairs are below; `section` is `Pause Delivery`, and `observed_utc` is an ISO UTC `...Z` time taken while the reloaded page is visible. The 09:50–09:52 receipts above are historical only and must not be copied into a new checkpoint.
4. Run the reviewed observer with `-DashboardEvidencePath`, `-Checkpoint` and `-NotBeforeUtc $checkpointStartUtc`, plus the expected topology from the table. It requires all three named observations after the checkpoint start and no older than five minutes when the gate finishes. A missing API pause boolean may use this validated Dashboard state; a malformed API boolean, API/Dashboard conflict, wrong identity, stale/unknown UI state, inconsistent Pause/Resume control, missing retention/metrics, or unexpected consumer/Cron state stops. Each Queue GET, metrics GET and Cron GET has an eight-second timeout. Do not change state or publish after a failed gate.

| Queue name | Queue ID | Exact Dashboard Messages URL |
| --- | --- | --- |
| `wos-rewards-registration-jobs-staging` | `23b1587e847e4db18d3bc440b1ba07d2` | `https://dash.cloudflare.com/e693626956842865123018153a6dbc31/workers/queues/23b1587e847e4db18d3bc440b1ba07d2/messages` |
| `wos-rewards-code-fanout-jobs-staging` | `d8366278aa9743859d6b8ddf9f27735b` | `https://dash.cloudflare.com/e693626956842865123018153a6dbc31/workers/queues/d8366278aa9743859d6b8ddf9f27735b/messages` |
| `wos-rewards-redemption-dlq-staging` | `e9a4aea43d0c447090f8036de687e15a` | `https://dash.cloudflare.com/e693626956842865123018153a6dbc31/workers/queues/e9a4aea43d0c447090f8036de687e15a/messages` |

Example row inside the three-row JSON array (replace the time with the new observation):

```json
{"name":"wos-rewards-registration-jobs-staging","queue_id":"23b1587e847e4db18d3bc440b1ba07d2","url":"https://dash.cloudflare.com/e693626956842865123018153a6dbc31/workers/queues/23b1587e847e4db18d3bc440b1ba07d2/messages","observed_utc":"2026-09-19T09:50:36.592Z","section":"Pause Delivery","status":"Active","control":"Pause"}
```

| Checkpoint | Expected consumers per Queue | Expected delivery | Expected Cron |
| --- | ---: | --- | ---: |
| Initial baseline, before any Cloudflare mutation | 1 | Active / `false` | 1 |
| After all three pause commands | 1 | Paused / `true` | 1 |
| After all three consumer removals | 0 | Paused / `true` | 1 |
| After bridge deploy and Cron-removal acknowledgement | 0 | Paused / `true` | 0 |
| During the 30-minute drain and immediately before `0005` | 0 | Paused / `true` | 0 |
| After guarded deploy, before resume | 1 | Paused / `true` | 1 |
| After all three resume commands; again before publication | 1 | Active / `false` | 1 |
| Recovery inventory after any partial/failed command | Inspect each actual count/state and Cron; no assumed common state | Inspect each actual state | Inspect actual schedule |
| Recovery after consumers/Cron restored, before resume | 1 | Paused / `true` | 1 |
| Recovery after all three resumed | 1 | Active / `false` | 1 |

For an ordinary checkpoint, the command is:

```powershell
& $observerPath -ExpectedConsumers 1 -ExpectedPaused false -ExpectedCronCount 1 -DashboardEvidencePath $dashboardEvidencePath -Checkpoint $checkpoint -NotBeforeUtc $checkpointStartUtc
if ($LASTEXITCODE -ne 0) { throw 'Task 20 Queue/Cron checkpoint unproven' }
```

Set `$observerPath` to the reviewed evidence checkout's absolute `scripts/task20-observe.ps1` path and verify its recorded hash before use. Substitute the table's expected values for each checkpoint. For a recovery inventory, omit the three `-Expected*` parameters, but still provide the fresh Dashboard evidence and inspect all reported counts, states and schedules **before** deciding a repair action. The observer's outputs are sanitized state/aggregate values; preserve them and the local ignored evidence file in the run record. Neither a Dashboard observation alone nor an API response with an omitted pause field passes the gate.

The first call uses the table's **initial baseline** values and a newly recorded baseline receipt. In each command block below, **pause before every observer line**: set a new checkpoint ID and start time after the preceding action, reload all three exact pages, write the new local receipt, then supply those three variables to that line. An observer line is not executable with values left from an earlier checkpoint. If any read or assertion fails, stop at that gate and use the applicable recovery inventory; do not infer a missing API boolean as `false`.

## Approved live sequence only

1. Record approval URL, frozen runtime HEAD/tree, all three frozen config hashes, active version, tuple-file hash, chosen synthetic text, baseline counts and UTC start. Separately record the reviewed evidence-helper commit and both helper file hashes. Stop if the frozen inputs differ. The existing single approval covers the remaining bridge deployment, pause/detach/restore of all three consumers, Cron removal/re-addition, migrations, guarded and enabled deployments, temporary foreground bot login, one maintainer publication, observation and disable/shutdown. No optional duplicate is included; its live deduplication is **not claimed**. The executor owns preparation, Cloudflare commands, companion, observation and shutdown. The maintainer uses Discord **Publish** once only after the executor verifies both gates and signals readiness. Stop for review of this replacement read-only gate before any mutation; a material change to approved scope needs separate approval.
2. The isolated bot preflight was executed **once** after the failed initial Queue gate and returned `task20_preflight_ready`. It made one `GET /gateway/bot`, one Gateway connection and one exact historical destination-message GET, with no event listener or Worker call. The process exited successfully within the bounded supervisor window. **Do not run it again.** This result establishes bot access to the historical copy; the fresh Follow event and Queue delivery gate remain to be tested.

3. Pause delivery to each of the three exact Queues, then explicitly remove each old Worker consumer. Check each command's exit code. Verify every Queue paused and **zero** consumers attached while the old Cron is still present. Only then deploy the bridge and verify its new deployment is 100%, its binding names and switches match the freeze, its Queue consumer count remains zero on all three, and its Cron trigger is removed. A 503 ingress probe must return no body. Record the Cron removal acknowledgement time. Queue pause and consumer detachment retain messages; do not purge or pull. On any partial pause/removal or bridge failure, use the pre-migration recovery below; never deploy the bridge if detachment is unproven.

   ```powershell
   $queues = @('wos-rewards-registration-jobs-staging','wos-rewards-code-fanout-jobs-staging','wos-rewards-redemption-dlq-staging')
   foreach ($q in $queues) {
     & $wrangler queues pause-delivery $q --env staging --config wrangler.jsonc
     if ($LASTEXITCODE -ne 0) { throw "Pause failed: $q" }
   }
   & $observerPath -ExpectedConsumers 1 -ExpectedPaused true -ExpectedCronCount 1 -DashboardEvidencePath $dashboardEvidencePath -Checkpoint $checkpoint -NotBeforeUtc $checkpointStartUtc
   if ($LASTEXITCODE -ne 0) { throw 'Pause topology unproven' }
   foreach ($q in $queues) {
     & $wrangler queues consumer worker remove $q wos-rewards-service-staging --env staging --config wrangler.jsonc
     if ($LASTEXITCODE -ne 0) { throw "Consumer removal failed: $q" }
   }
   & $observerPath -ExpectedConsumers 0 -ExpectedPaused true -ExpectedCronCount 1 -DashboardEvidencePath $dashboardEvidencePath -Checkpoint $checkpoint -NotBeforeUtc $checkpointStartUtc
   if ($LASTEXITCODE -ne 0) { throw 'Consumer detachment unproven' }
   & $wrangler deploy --env staging --config .task20-local/wrangler.bridge.jsonc --strict
   if ($LASTEXITCODE -ne 0) { throw 'Bridge deploy failed' }
   & $wrangler deployments list --name wos-rewards-service-staging --env staging --json
   & $observerPath -ExpectedConsumers 0 -ExpectedPaused true -ExpectedCronCount 0 -DashboardEvidencePath $dashboardEvidencePath -Checkpoint $checkpoint -NotBeforeUtc $checkpointStartUtc
   if ($LASTEXITCODE -ne 0) { throw 'Bridge topology unproven' }
   ```

4. Do not migrate earlier than **30 minutes after the verified Cron-removal acknowledgement**. During the hold and again immediately before `0005`, run a **new** `0 / paused / 0` observer checkpoint with three newly reloaded Dashboard pages and a new receipt each time. Verify the bridge remains the sole deployment, zero attached consumers, all Queues paused, no new Cron trigger, bounded Queue oldest-message age well inside 24 hours, and no unexpected D1 work/hold change. A queue metric of zero cannot shorten the wait. Any missed checkpoint or unexpected work aborts before `0005`.
5. Confirm journal exactly `0001`–`0004`, pending migrations exactly `0005` then `0006`, and expected schema columns absent. Apply the pending migrations by the installed Wrangler's single ordered command below; its migration journal and backup mechanism apply each file sequentially. Check that only `0005` and `0006` were applied, `dispatch_hold_*`, `uncertain_count`, and `discovered_code_events` exist, and any legacy candidates became retained holds without status/counter loss. If the first migration fails, stop; if `0005` succeeded and `0006` failed, follow the **post-0005** fallback, never the old version. [D1 migration ordering/rollback](https://developers.cloudflare.com/d1/reference/migrations/).

   ```powershell
   & $wrangler d1 migrations apply wos-rewards-service-staging --remote --env staging
   if ($LASTEXITCODE -ne 0) { throw 'Migration failed; inspect journal before fallback' }
   & $wrangler d1 migrations list wos-rewards-service-staging --remote --env staging
   & $wrangler d1 execute wos-rewards-service-staging --remote --env staging --json --command "SELECT name FROM d1_migrations ORDER BY id"
   & $wrangler d1 execute wos-rewards-service-staging --remote --env staging --json --command "SELECT (SELECT COUNT(*) FROM pragma_table_info('redemptions') WHERE name LIKE 'dispatch_hold_%') AS hold_columns,(SELECT COUNT(*) FROM pragma_table_info('operations') WHERE name='uncertain_count') AS uncertain_column,(SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='discovered_code_events') AS discovery_table"
   ```

6. Deploy the **guarded** new runtime with discovery false, all three consumers and the one-minute Cron. Verify 100% new version, correct staging bindings and secret names, D1 journal/schema, **exactly one consumer on each still-paused Queue**, mock mode, production redemption false, and discovery false before resuming. Check every resume exit code and verify all three became unpaused through a new `1 / Active / 1` checkpoint. Re-addition of Cron can take up to 15 minutes; allow the documented propagation bound before the publication, then confirm a new scheduled invocation or equivalent progress evidence. If no scheduled progress, do not publish. The guarded runtime, not the bridge or old version, owns queued work and any holds from here onward. If deploy or attachment fails, keep all Queues paused and use the post-0005 fallback; if resume is partial, pause all three again and inspect the exact state before repair.

   ```powershell
   & $wrangler deploy --env staging --config .task20-local/wrangler.guarded.jsonc --strict
   if ($LASTEXITCODE -ne 0) { throw 'Guarded deploy failed; remain paused and repair this same revision' }
   & $wrangler deployments list --name wos-rewards-service-staging --env staging --json
   & $observerPath -ExpectedConsumers 1 -ExpectedPaused true -ExpectedCronCount 1 -DashboardEvidencePath $dashboardEvidencePath -Checkpoint $checkpoint -NotBeforeUtc $checkpointStartUtc
   if ($LASTEXITCODE -ne 0) { throw 'Guarded topology unproven; remain paused' }
   foreach ($q in $queues) {
     & $wrangler queues resume-delivery $q --env staging --config wrangler.jsonc
     if ($LASTEXITCODE -ne 0) { throw "Resume failed: $q" }
   }
   & $observerPath -ExpectedConsumers 1 -ExpectedPaused false -ExpectedCronCount 1 -DashboardEvidencePath $dashboardEvidencePath -Checkpoint $checkpoint -NotBeforeUtc $checkpointStartUtc
   if ($LASTEXITCODE -ne 0) { throw 'Resumed topology unproven' }
   ```

7. Deploy the **enabled** config at 100% for the same guarded code with only the reviewed controlled tuple and Worker discovery true. Verify switches and tuple locally/remote without logging secret values. Start one foreground companion process with the same four tuple fields, existing registration/admin configuration, `ENVIRONMENT=staging`, `PROVIDER_MODE=mock`, and process-only secrets loaded from the existing private file. The Task 20 launcher sets its `CODE_DISCOVERY_ENABLED=true` process variable and clears all supplied variables on exit; wait for `companion_ready`. No user account automation, history scan or webhook lookup. If login or readiness fails, disable the Worker gate and stop.

   ```powershell
   & $wrangler deploy --env staging --config .task20-local/wrangler.enabled.jsonc --strict
   if ($LASTEXITCODE -ne 0) { throw 'Enabled deploy failed' }
   & $wrangler deployments list --name wos-rewards-service-staging --env staging --json
   # In a separate foreground PowerShell, with $tuplePath and $authPath set to the
   # reviewed absolute local paths. Run -- without -Start first to validate offline.
   & .\scripts\task20-companion.ps1 -TuplePath $tuplePath -AuthPath $authPath
   & .\scripts\task20-companion.ps1 -TuplePath $tuplePath -AuthPath $authPath -Start
   # Keep this console visible for companion_ready and Ctrl+C shutdown.
   ```

8. Immediately before any readiness signal, repeat the new `1 / Active / 1` Queue/Cron checkpoint with freshly reloaded Dashboard pages and a new receipt. Only after both gates are verified on, signal the maintainer to use Discord **Publish** once for the **one exact approved synthetic** three-line announcement in the controlled source. The executor then observes; the maintainer performs no Cloudflare or companion command. Timestamp `T0` is the original publication/create time. Observe no longer than `T0 + 15 minutes`. The companion must receive a fresh `MESSAGE_CREATE` with original timestamp inside five minutes, full content, default type/reference, IS_CROSSPOST without disallowed flags, and the exact destination/webhook/source tuple. Do not retimestamp, edit, replay a historical REST message or publish a second message as a fake duplicate. Record only sanitized event categories and aggregate counts, not the body, code, IDs or private player rows.
9. Acceptance: one `discovered_code_events` canonical `accepted` row, one new `code_distribution_run`, frozen `expected_count=1` and one snapshot member (re-freeze if the approved baseline changes), at most one mock player/code pair, no new uncertainty hold, exactly one delivered sanitized final admin summary with `has_footer=1` and the required runtime footer rendered once. No extra operation or message; output must have disabled mentions. Verify from bounded D1 aggregates plus the one admin message. A live duplicate test is omitted, so only existing offline deduplication tests support that behavior. Unexpected source/content/player count/work, rate limit/access error, a new uncertainty hold, a second operation, or no output at the deadline is an abort.
10. On success **or abort**, deploy `wrangler.guarded.jsonc` (Worker discovery false), stop companion with Ctrl+C and confirm client shutdown, clear its process environment, verify both discovery gates off and the companion stopped. Keep the guarded Worker, existing consumers and Cron running for accepted work/output. Recheck journal, queue backlog/retention and aggregate holds. Document sanitized dated result and final state in the owning architecture docs and this PR. Do not merge without separate approval.

## Abort and fallback

- **Before `0005`, including a partial pause or partial consumer removal:** stop publication and companion if started. First run a **new recovery inventory** through the observer with fresh reloaded Dashboard receipts, a new checkpoint ID/start time, and no `-Expected*` arguments. Inspect each Queue's actual pause state and consumer count plus Cron; a command can have taken effect even if its response failed. If all consumers are still attached and the old Worker/Cron remain active, resume any paused Queue and verify all three unpaused, one consumer each, one Cron at a **new** `1 / Active / 1` checkpoint. If any consumer is missing, keep or put **all three** Queues in the paused state; verify that state at a **new** checkpoint before repair. If the bridge is deployed and schema still exactly `0001`–`0004`, roll back only to the recorded old version `7a083c14-a7ac-4875-ad11-04de4b10b139` with the command below and verify its 100% version. Add a consumer **only to each Queue observed with zero** using the corresponding exact command below; do not add to a Queue with one. More than one consumer, an unknown count, a changed old version or an unprovable pause state requires stopping and escalating, not guessing. If Cron is absent, restore the exact trigger. Verify one consumer per Queue and one Cron while paused at a fresh `1 / Paused / 1` checkpoint, then resume each Queue with exit checks and verify all unpaused at a separate fresh `1 / Active / 1` checkpoint. A partial resume failure returns to a new all-paused inspection before retry. Do not leave accepted queued work behind a 24-hour retention clock. A different active old version needs a revised approval bundle.

  ```powershell
  # Only if bridge was deployed, the old version and pre-0005 journal match the freeze:
  & $wrangler rollback 7a083c14-a7ac-4875-ad11-04de4b10b139 --name wos-rewards-service-staging --env staging --yes
  if ($LASTEXITCODE -ne 0) { throw 'Old-version rollback failed; keep Queues paused' }
  # Run each add line ONLY when that Queue's fresh read-only metadata shows zero consumers.
  & $wrangler queues consumer worker add wos-rewards-registration-jobs-staging wos-rewards-service-staging --batch-size 2 --max-concurrency 1 --message-retries 3 --dead-letter-queue wos-rewards-redemption-dlq-staging --env staging --config wrangler.jsonc
  if ($LASTEXITCODE -ne 0) { throw 'Registration consumer restore failed; keep Queues paused' }
  & $wrangler queues consumer worker add wos-rewards-code-fanout-jobs-staging wos-rewards-service-staging --batch-size 2 --max-concurrency 1 --message-retries 3 --dead-letter-queue wos-rewards-redemption-dlq-staging --env staging --config wrangler.jsonc
  if ($LASTEXITCODE -ne 0) { throw 'Fanout consumer restore failed; keep Queues paused' }
  & $wrangler queues consumer worker add wos-rewards-redemption-dlq-staging wos-rewards-service-staging --batch-size 2 --max-concurrency 1 --message-retries 3 --env staging --config wrangler.jsonc
  if ($LASTEXITCODE -ne 0) { throw 'DLQ consumer restore failed; keep Queues paused' }
  # Only if fresh Cron metadata shows zero schedules:
  & $wrangler triggers deploy --name wos-rewards-service-staging --env staging --config wrangler.jsonc
  if ($LASTEXITCODE -ne 0) { throw 'Cron restore failed; keep Queues paused' }
  & $observerPath -ExpectedConsumers 1 -ExpectedPaused true -ExpectedCronCount 1 -DashboardEvidencePath $dashboardEvidencePath -Checkpoint $checkpoint -NotBeforeUtc $checkpointStartUtc
  if ($LASTEXITCODE -ne 0) { throw 'Restored topology unproven; keep Queues paused' }
  foreach ($q in $queues) {
    & $wrangler queues resume-delivery $q --env staging --config wrangler.jsonc
    if ($LASTEXITCODE -ne 0) { throw "Resume failed: $q; re-pause all and inspect" }
  }
  & $observerPath -ExpectedConsumers 1 -ExpectedPaused false -ExpectedCronCount 1 -DashboardEvidencePath $dashboardEvidencePath -Checkpoint $checkpoint -NotBeforeUtc $checkpointStartUtc
  if ($LASTEXITCODE -ne 0) { throw 'Recovered topology unproven' }
  ```
- **After `0005`:** never roll back to the old version. Start with a new recovery inventory using fresh reloaded Dashboard receipts and no `-Expected*` arguments. Keep/restore the **same reviewed guarded runtime** with discovery false, three consumers and Cron. Verify one consumer per still-paused Queue and the one-minute Cron at a fresh `1 / Paused / 1` checkpoint before resuming each with checked exits; verify all three unpaused at a separate fresh `1 / Active / 1` checkpoint. If a resume is partial, pause all three again and inspect at a new checkpoint before repair. Process accepted work while retaining holds. If `0006` is missing, discovery stays off; do not publish. If guarded deploy or recovery cannot be proven before the oldest message approaches retention, stop and escalate with the exact current state; no purge, deletion or uncertain replay.
- **After publication:** disable Worker discovery with the guarded config, stop companion and clear its process variables, retain all committed work and holds, and record the first failed checkpoint. No production resource, real provider, game request, new resource or provider authorization is in this bundle.

Queue pause/resume, deployments, migrations, Discord login/publication and intake are **live external actions**. Only the bounded bot preflight login occurred in the stopped attempt; no foreground companion login, publication, intake or Cloudflare mutation occurred. The existing one-run approval still covers the remaining scope, subject to review of this replacement verification gate and fresh checkpoint evidence. It does **not** authorize a second bot preflight, an optional duplicate publication or a material change of scope.
