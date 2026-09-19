# Task 20 controlled staging Follow smoke — preparation runbook

Status: **prepared, not approved or executed**. Owner: [issue #35](https://github.com/Tor-Production/wos-rewards-service/issues/35); partial parent [#22](https://github.com/Tor-Production/wos-rewards-service/issues/22). This page is the command sequence to review. Record the exact approved commit, tree, generated configuration hashes, local tuple and synthetic text in the approval record before running it. The ignored local four-field tuple matches Task 19's earlier exact-message metadata, including its observed `webhook_id`, and the maintainer's controlled source/destination links. A new ignored project `.wrangler/secrets-staging.md` supplies the two required private names. Offline validation passes. The historical exact webhook-object GET returned 403, and newer exact-message/application GETs also returned 403 for an unknown reason. The live approval bundle is still **not approved**. No action below is authorized by this page.

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

Before any mutation repeat: `gh issue view 35`, `git status --short`, active Worker deployment/version metadata (single version at 100%, bindings, mock/off switches), `wrangler d1 migrations list wos-rewards-service-staging --remote --env staging`, the journal/schema/count SQL below, all three `wrangler queues info` calls and documented `/metrics` GETs. The reviewed baseline must still be **one player**, no unexpected ongoing work, no uncertainty, no oldest queued message older than **22 hours**, and only `0005` then `0006` pending. This leaves two hours within the known 24-hour retention for the 30-minute drain, restoration and bounded smoke; abort and restore earlier if the oldest message approaches 23 hours. A changed player count or workload requires a new exact expected fanout and approval bundle. The point-in-time Queue metrics are a retention/backlog signal, not a proof of no in-flight work. Confirm companion stopped before the cutover. The only Discord service reads in the approved sequence are the two bounded preflight GETs below.

```powershell
& $wrangler deployments list --name wos-rewards-service-staging --env staging --json
& $wrangler d1 migrations list wos-rewards-service-staging --remote --env staging
& $wrangler d1 execute wos-rewards-service-staging --remote --env staging --json --command "SELECT name FROM d1_migrations ORDER BY id"
& $wrangler d1 execute wos-rewards-service-staging --remote --env staging --json --command "SELECT (SELECT COUNT(*) FROM players) AS players,(SELECT COUNT(*) FROM operation_items WHERE status IN ('pending','in_progress')) AS unfinished_items,(SELECT COUNT(*) FROM redemptions WHERE status IN ('pending','in_progress','retry_wait')) AS outstanding_redemptions,(SELECT COUNT(*) FROM redemptions WHERE status IN ('in_progress','retry_wait') OR (status='pending' AND provider_invocations>0)) AS legacy_hold_candidates,(SELECT COUNT(*) FROM redemptions WHERE reason_code='outcome_uncertain') AS uncertain_reasons"
& $wrangler d1 execute wos-rewards-service-staging --remote --env staging --json --command "SELECT status,COUNT(*) AS n FROM outbox_jobs GROUP BY status;SELECT status,COUNT(*) AS n FROM discord_output_deliveries GROUP BY status"
foreach ($q in @('wos-rewards-registration-jobs-staging','wos-rewards-code-fanout-jobs-staging','wos-rewards-redemption-dlq-staging')) { & $wrangler queues info $q }
```

Run `& .\scripts\task20-observe.ps1 -ExpectedConsumers 1 -ExpectedPaused false -ExpectedCronCount 1` at this checkpoint. Repeat it with the expected topology at every named Queue/Cron checkpoint below. It uses the existing Wrangler OAuth token **in memory only**, validates the one expected account, and issues documented GETs only for the three recorded Queue IDs and this Worker's Cron schedule. It prints consumer counts, pause states, retention, point-in-time backlog, oldest-message timestamp and Cron schedule; it clears the token variable. Do not print request headers or token, pull messages, or infer exact queue emptiness from this sample. A read or assertion failure blocks the cutover gate.

## Approved live sequence only

1. Record approval URL, HEAD/tree, all three config hashes, active version, tuple-file hash, chosen synthetic text, baseline counts and UTC start. Stop if any differs. The single approval must explicitly cover the bounded bot preflight, bridge deployment, pause/detach/restore of all three consumers, Cron removal/re-addition, migrations, guarded and enabled deployments, temporary bot login, one maintainer publication, observation and disable/shutdown. No optional duplicate is included in this run; its live deduplication is **not claimed**. The executor owns preparation, the Cloudflare commands, companion, observation and shutdown. The maintainer only gives this approval and, when the executor signals both gates ready, uses Discord **Publish** once for the agreed synthetic source announcement.
2. **Before any Cloudflare mutation**, run one bounded bot preflight with the existing private file and the two selected historical message IDs from the ignored approval bundle. The isolated, one-shot preflight makes exactly one `GET /gateway/bot` (8-second request timeout), opens one Gateway WebSocket with the companion's required intents (8-second handshake timeout), checks the READY application ID, then makes one exact destination-message GET (8-second request timeout) and compares its Follow metadata to the frozen tuple. There is no SDK retry or automatic reconnect. The supervisor permits at most **28 seconds** for the operation and reserves **2 seconds** to terminate its worker; it reports success only after termination. If termination misses the 30-second total bound, the dedicated preflight process exits. It has no `MESSAGE_CREATE` listener and never calls the Worker. It logs no token, message body or IDs. A 403, 429, mismatch, close, timeout or other failure is terminal; do not retry, rotate credentials or proceed to queue changes. The historical webhook-object GET is not repeated. This check is live and remains unexecuted until approval.

   ```powershell
   $authPath = (Resolve-Path '<approved private auth file>').Path
   & .\scripts\task20-companion.ps1 -TuplePath $tuplePath -AuthPath $authPath -Preflight -DestinationMessageId '<approved destination message ID>' -SourceMessageId '<approved original message ID>'
   if ($LASTEXITCODE -ne 0) { throw 'Bot preflight failed; no Cloudflare mutation allowed' }
   ```

3. Pause delivery to each of the three exact Queues, then explicitly remove each old Worker consumer. Check each command's exit code. Verify every Queue paused and **zero** consumers attached while the old Cron is still present. Only then deploy the bridge and verify its new deployment is 100%, its binding names and switches match the freeze, its Queue consumer count remains zero on all three, and its Cron trigger is removed. A 503 ingress probe must return no body. Record the Cron removal acknowledgement time. Queue pause and consumer detachment retain messages; do not purge or pull. On any partial pause/removal or bridge failure, use the pre-migration recovery below; never deploy the bridge if detachment is unproven.

   ```powershell
   $queues = @('wos-rewards-registration-jobs-staging','wos-rewards-code-fanout-jobs-staging','wos-rewards-redemption-dlq-staging')
   foreach ($q in $queues) {
     & $wrangler queues pause-delivery $q --env staging --config wrangler.jsonc
     if ($LASTEXITCODE -ne 0) { throw "Pause failed: $q" }
   }
   & .\scripts\task20-observe.ps1 -ExpectedConsumers 1 -ExpectedPaused true -ExpectedCronCount 1
   if ($LASTEXITCODE -ne 0) { throw 'Pause topology unproven' }
   foreach ($q in $queues) {
     & $wrangler queues consumer worker remove $q wos-rewards-service-staging --env staging --config wrangler.jsonc
     if ($LASTEXITCODE -ne 0) { throw "Consumer removal failed: $q" }
   }
   & .\scripts\task20-observe.ps1 -ExpectedConsumers 0 -ExpectedPaused true -ExpectedCronCount 1
   if ($LASTEXITCODE -ne 0) { throw 'Consumer detachment unproven' }
   & $wrangler deploy --env staging --config .task20-local/wrangler.bridge.jsonc --strict
   if ($LASTEXITCODE -ne 0) { throw 'Bridge deploy failed' }
   & $wrangler deployments list --name wos-rewards-service-staging --env staging --json
   & .\scripts\task20-observe.ps1 -ExpectedConsumers 0 -ExpectedPaused true -ExpectedCronCount 0
   if ($LASTEXITCODE -ne 0) { throw 'Bridge topology unproven' }
   ```

4. Do not migrate earlier than **30 minutes after the verified Cron-removal acknowledgement**. During the hold, verify the bridge remains the sole deployment, zero attached consumers, all Queues paused, no new Cron trigger, bounded Queue oldest-message age well inside 24 hours, and no unexpected D1 work/hold change. A queue metric of zero cannot shorten the wait. Any missed checkpoint or unexpected work aborts before `0005`.
5. Confirm journal exactly `0001`–`0004`, pending migrations exactly `0005` then `0006`, and expected schema columns absent. Apply the pending migrations by the installed Wrangler's single ordered command below; its migration journal and backup mechanism apply each file sequentially. Check that only `0005` and `0006` were applied, `dispatch_hold_*`, `uncertain_count`, and `discovered_code_events` exist, and any legacy candidates became retained holds without status/counter loss. If the first migration fails, stop; if `0005` succeeded and `0006` failed, follow the **post-0005** fallback, never the old version. [D1 migration ordering/rollback](https://developers.cloudflare.com/d1/reference/migrations/).

   ```powershell
   & $wrangler d1 migrations apply wos-rewards-service-staging --remote --env staging
   if ($LASTEXITCODE -ne 0) { throw 'Migration failed; inspect journal before fallback' }
   & $wrangler d1 migrations list wos-rewards-service-staging --remote --env staging
   & $wrangler d1 execute wos-rewards-service-staging --remote --env staging --json --command "SELECT name FROM d1_migrations ORDER BY id"
   & $wrangler d1 execute wos-rewards-service-staging --remote --env staging --json --command "SELECT (SELECT COUNT(*) FROM pragma_table_info('redemptions') WHERE name LIKE 'dispatch_hold_%') AS hold_columns,(SELECT COUNT(*) FROM pragma_table_info('operations') WHERE name='uncertain_count') AS uncertain_column,(SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='discovered_code_events') AS discovery_table"
   ```

6. Deploy the **guarded** new runtime with discovery false, all three consumers and the one-minute Cron. Verify 100% new version, correct staging bindings and secret names, D1 journal/schema, **exactly one consumer on each still-paused Queue**, mock mode, production redemption false, and discovery false before resuming. Check every resume exit code and verify all three became unpaused. Re-addition of Cron can take up to 15 minutes; allow the documented propagation bound before the publication, then confirm a new scheduled invocation or equivalent progress evidence. If no scheduled progress, do not publish. The guarded runtime, not the bridge or old version, owns queued work and any holds from here onward. If deploy or attachment fails, keep all Queues paused and use the post-0005 fallback; if resume is partial, pause all three again and inspect the exact state before repair.

   ```powershell
   & $wrangler deploy --env staging --config .task20-local/wrangler.guarded.jsonc --strict
   if ($LASTEXITCODE -ne 0) { throw 'Guarded deploy failed; remain paused and repair this same revision' }
   & $wrangler deployments list --name wos-rewards-service-staging --env staging --json
   & .\scripts\task20-observe.ps1 -ExpectedConsumers 1 -ExpectedPaused true -ExpectedCronCount 1
   if ($LASTEXITCODE -ne 0) { throw 'Guarded topology unproven; remain paused' }
   foreach ($q in $queues) {
     & $wrangler queues resume-delivery $q --env staging --config wrangler.jsonc
     if ($LASTEXITCODE -ne 0) { throw "Resume failed: $q" }
   }
   & .\scripts\task20-observe.ps1 -ExpectedConsumers 1 -ExpectedPaused false -ExpectedCronCount 1
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

8. Only after both gates are verified on, signal the maintainer to use Discord **Publish** once for the **one exact approved synthetic** three-line announcement in the controlled source. The executor then observes; the maintainer performs no Cloudflare or companion command. Timestamp `T0` is the original publication/create time. Observe no longer than `T0 + 15 minutes`. The companion must receive a fresh `MESSAGE_CREATE` with original timestamp inside five minutes, full content, default type/reference, IS_CROSSPOST without disallowed flags, and the exact destination/webhook/source tuple. Do not retimestamp, edit, replay a historical REST message or publish a second message as a fake duplicate. Record only sanitized event categories and aggregate counts, not the body, code, IDs or private player rows.
9. Acceptance: one `discovered_code_events` canonical `accepted` row, one new `code_distribution_run`, frozen `expected_count=1` and one snapshot member (re-freeze if the approved baseline changes), at most one mock player/code pair, no new uncertainty hold, exactly one delivered sanitized final admin summary with `has_footer=1` and the required runtime footer rendered once. No extra operation or message; output must have disabled mentions. Verify from bounded D1 aggregates plus the one admin message. A live duplicate test is omitted, so only existing offline deduplication tests support that behavior. Unexpected source/content/player count/work, rate limit/access error, a new uncertainty hold, a second operation, or no output at the deadline is an abort.
10. On success **or abort**, deploy `wrangler.guarded.jsonc` (Worker discovery false), stop companion with Ctrl+C and confirm client shutdown, clear its process environment, verify both discovery gates off and the companion stopped. Keep the guarded Worker, existing consumers and Cron running for accepted work/output. Recheck journal, queue backlog/retention and aggregate holds. Document sanitized dated result and final state in the owning architecture docs and this PR. Do not merge without separate approval.

## Abort and fallback

- **Before `0005`, including a partial pause or partial consumer removal:** stop publication and companion if started. First read each Queue's actual pause state and consumer count; a command can have taken effect even if its response failed. If all consumers are still attached and the old Worker/Cron remain active, resume any paused Queue and verify all three unpaused, one consumer each, one Cron. If any consumer is missing, keep or put **all three** Queues in the paused state; verify that state before repair. If the bridge is deployed and schema still exactly `0001`–`0004`, roll back only to the recorded old version `7a083c14-a7ac-4875-ad11-04de4b10b139` with the command below and verify its 100% version. Add a consumer **only to each Queue observed with zero** using the corresponding exact command below; do not add to a Queue with one. More than one consumer, an unknown count, a changed old version or an unprovable pause state requires stopping and escalating, not guessing. If Cron is absent, restore the exact trigger. Verify one consumer per Queue and one Cron while paused, then resume each Queue with exit checks and verify all unpaused. A partial resume failure returns to all-paused inspection before retry. Do not leave accepted queued work behind a 24-hour retention clock. A different active old version needs a revised approval bundle.

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
  & .\scripts\task20-observe.ps1 -ExpectedConsumers 1 -ExpectedPaused true -ExpectedCronCount 1
  if ($LASTEXITCODE -ne 0) { throw 'Restored topology unproven; keep Queues paused' }
  foreach ($q in $queues) {
    & $wrangler queues resume-delivery $q --env staging --config wrangler.jsonc
    if ($LASTEXITCODE -ne 0) { throw "Resume failed: $q; re-pause all and inspect" }
  }
  & .\scripts\task20-observe.ps1 -ExpectedConsumers 1 -ExpectedPaused false -ExpectedCronCount 1
  if ($LASTEXITCODE -ne 0) { throw 'Recovered topology unproven' }
  ```
- **After `0005`:** never roll back to the old version. Keep/restore the **same reviewed guarded runtime** with discovery false, three consumers and Cron. Verify one consumer per still-paused Queue and the one-minute Cron before resuming each with checked exits; verify all three unpaused afterward. If a resume is partial, pause all three again and inspect before repair. Process accepted work while retaining holds. If `0006` is missing, discovery stays off; do not publish. If guarded deploy or recovery cannot be proven before the oldest message approaches retention, stop and escalate with the exact current state; no purge, deletion or uncertain replay.
- **After publication:** disable Worker discovery with the guarded config, stop companion and clear its process variables, retain all committed work and holds, and record the first failed checkpoint. No production resource, real provider, game request, new resource or provider authorization is in this bundle.

Queue pause/resume, deployments, migrations, Discord login/publication and intake are **live external actions**. They remain unexecuted until the exact reviewed bundle is explicitly approved.
