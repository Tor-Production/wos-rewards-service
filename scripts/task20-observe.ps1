param(
  [ValidateSet(0, 1)] [Nullable[int]] $ExpectedConsumers,
  [ValidateSet('true', 'false')] [string] $ExpectedPaused,
  [ValidateSet(0, 1)] [Nullable[int]] $ExpectedCronCount,
  [string] $DashboardEvidencePath,
  [string] $Checkpoint,
  [string] $NotBeforeUtc
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'task20-topology.ps1')
$wrangler = Join-Path (Split-Path $PSScriptRoot -Parent) 'node_modules/.bin/wrangler.cmd'
$accountId = 'e693626956842865123018153a6dbc31'
$base = "https://api.cloudflare.com/client/v4/accounts/$accountId"
$queues = [ordered]@{
  registration = [pscustomobject]@{ Name = 'wos-rewards-registration-jobs-staging'; Id = '23b1587e847e4db18d3bc440b1ba07d2' }
  fanout = [pscustomobject]@{ Name = 'wos-rewards-code-fanout-jobs-staging'; Id = 'd8366278aa9743859d6b8ddf9f27735b' }
  dlq = [pscustomobject]@{ Name = 'wos-rewards-redemption-dlq-staging'; Id = 'e9a4aea43d0c447090f8036de687e15a' }
}

try {
  if ($PSVersionTable.PSVersion -lt [version]'7.5') {
    throw 'PowerShell 7.5 or newer is required for receipt timestamp parsing'
  }
  $dashboardPauseMap = $null
  if ($DashboardEvidencePath) {
    if ([string]::IsNullOrWhiteSpace($Checkpoint) -or
        $NotBeforeUtc -cnotmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$') {
      throw 'Dashboard checkpoint parameters unavailable'
    }
    $start = [DateTimeOffset]::Parse($NotBeforeUtc, [Globalization.CultureInfo]::InvariantCulture)
    $evidence = Get-Content -LiteralPath $DashboardEvidencePath -Raw -Encoding UTF8 | ConvertFrom-Json -DateKind String
    $dashboardPauseMap = Assert-Task20DashboardEvidence -Evidence $evidence -QueueCatalog $queues -AccountId $accountId -Checkpoint $Checkpoint -NotBeforeUtc $start
  }
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
    $id = $item.Value.Id
    $q = Invoke-RestMethod -Uri "$base/queues/$id" -Headers $headers -Method Get -TimeoutSec 8
    $m = Invoke-RestMethod -Uri "$base/queues/$id/metrics" -Headers $headers -Method Get -TimeoutSec 8
    if (-not $q.success -or -not $m.success -or $q.result.queue_id -cne $id) {
      throw 'Staging Queue metadata mismatch'
    }
    $retention = $q.result.settings.PSObject.Properties['message_retention_period']
    $backlogCount = $m.result.PSObject.Properties['backlog_count']
    $backlogBytes = $m.result.PSObject.Properties['backlog_bytes']
    if ($null -eq $retention -or $retention.Value -isnot [long] -or $retention.Value -ne 86400 -or
        $null -eq $backlogCount -or $backlogCount.Value -isnot [long] -or $backlogCount.Value -lt 0 -or
        $null -eq $backlogBytes -or $backlogBytes.Value -isnot [long] -or $backlogBytes.Value -lt 0) {
      throw 'Staging Queue retention or metrics unavailable'
    }
    $dashboardPaused = $null
    if ($null -ne $dashboardPauseMap) {
      $dashboardPauseMap = Assert-Task20DashboardEvidence -Evidence $evidence -QueueCatalog $queues -AccountId $accountId -Checkpoint $Checkpoint -NotBeforeUtc $start
      $dashboardPaused = [bool]$dashboardPauseMap[$item.Key]
    }
    $topology = Assert-Task20QueueTopology -QueueResult $q.result -ExpectedConsumers $ExpectedConsumers -ExpectedPaused $ExpectedPaused -DashboardPaused $dashboardPaused
    $consumerCount = $topology.ConsumerCount
    $paused = $topology.Paused
    $oldest = $m.result.oldest_message_timestamp_ms
    if (($null -eq $oldest -and $backlogCount.Value -gt 0) -or
        ($null -ne $oldest -and ($oldest -isnot [long] -or $oldest -lt 0))) {
      throw 'Staging Queue oldest-message metric unavailable'
    }
    if ($backlogCount.Value -gt 0) {
      $oldestAgeMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [long]$oldest
      if ($oldest -eq 0 -or $oldestAgeMs -lt -15000 -or $oldestAgeMs -ge (23 * 60 * 60 * 1000)) {
        throw 'Staging Queue oldest message outside retention margin'
      }
    }
    Write-Output ("queue=$($item.Key) consumers=$consumerCount paused=$paused pause_source=$($topology.PauseSource) retention_seconds=$($retention.Value) backlog_count=$($backlogCount.Value) backlog_bytes=$($backlogBytes.Value) oldest_ms=$oldest")
  }
  $s = Invoke-RestMethod -Uri "$base/workers/scripts/wos-rewards-service-staging/schedules" -Headers $headers -Method Get -TimeoutSec 8
  if (-not $s.success) { throw 'Staging Cron metadata unavailable' }
  $cronCount = @($s.result.schedules).Count
  if ($null -ne $ExpectedCronCount -and $cronCount -ne $ExpectedCronCount) { throw 'Unexpected Cron count' }
  if ($ExpectedCronCount -eq 1 -and @($s.result.schedules | Where-Object { $_.cron -ne '* * * * *' }).Count -gt 0) {
    throw 'Unexpected Cron schedule'
  }
  Write-Output ('cron_count=' + $cronCount)
  foreach ($schedule in @($s.result.schedules)) { Write-Output ('cron=' + $schedule.cron) }
  if ($null -ne $dashboardPauseMap) {
    Assert-Task20DashboardEvidence -Evidence $evidence -QueueCatalog $queues -AccountId $accountId -Checkpoint $Checkpoint -NotBeforeUtc $start | Out-Null
  }
} catch {
  # Never print an HTTP response, auth record, headers, URL or raw exception.
  Write-Error 'Task 20 staging read-only observation failed; stop the cutover gate.'
  exit 1
} finally {
  Remove-Variable auth, headers -ErrorAction SilentlyContinue
}
