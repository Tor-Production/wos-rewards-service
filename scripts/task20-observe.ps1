$ErrorActionPreference = 'Stop'
$wrangler = Join-Path (Split-Path $PSScriptRoot -Parent) 'node_modules/.bin/wrangler.cmd'
$accountId = 'e693626956842865123018153a6dbc31'
$base = "https://api.cloudflare.com/client/v4/accounts/$accountId"
$queues = [ordered]@{
  registration = '23b1587e847e4db18d3bc440b1ba07d2'
  fanout = 'd8366278aa9743859d6b8ddf9f27735b'
  dlq = 'e9a4aea43d0c447090f8036de687e15a'
}

try {
  $identity = (& $wrangler whoami --json 2>$null | ConvertFrom-Json)
  if ($LASTEXITCODE -ne 0 -or @($identity.accounts).Count -ne 1 -or $identity.accounts[0].id -ne $accountId) {
    throw 'Unexpected Wrangler account'
  }
  $auth = (& $wrangler auth token --json 2>$null | ConvertFrom-Json)
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($auth.token)) {
    throw 'Wrangler authentication unavailable'
  }
  $headers = @{ Authorization = 'Bearer ' + $auth.token }
  Write-Output ('observed_utc=' + [DateTime]::UtcNow.ToString('o'))
  foreach ($item in $queues.GetEnumerator()) {
    $q = Invoke-RestMethod -Uri "$base/queues/$($item.Value)" -Headers $headers -Method Get
    $m = Invoke-RestMethod -Uri "$base/queues/$($item.Value)/metrics" -Headers $headers -Method Get
    if (-not $q.success -or -not $m.success -or $q.result.queue_id -ne $item.Value) {
      throw 'Staging Queue metadata mismatch'
    }
    $oldest = $m.result.oldest_message_timestamp_ms
    Write-Output ("queue=$($item.Key) consumers=$($q.result.consumers_total_count) retention_seconds=$($q.result.settings.message_retention_period) backlog_count=$($m.result.backlog_count) backlog_bytes=$($m.result.backlog_bytes) oldest_ms=$oldest")
  }
  $s = Invoke-RestMethod -Uri "$base/workers/scripts/wos-rewards-service-staging/schedules" -Headers $headers -Method Get
  if (-not $s.success) { throw 'Staging Cron metadata unavailable' }
  Write-Output ('cron_count=' + @($s.result.schedules).Count)
  foreach ($schedule in @($s.result.schedules)) { Write-Output ('cron=' + $schedule.cron) }
} catch {
  # Never print an HTTP response, auth record, headers, URL or raw exception.
  Write-Error 'Task 20 staging read-only observation failed; stop the cutover gate.'
  exit 1
} finally {
  Remove-Variable auth, headers -ErrorAction SilentlyContinue
}
