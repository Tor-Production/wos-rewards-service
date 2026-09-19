$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'task20-topology.ps1')

function Expect-Rejection([string] $Json) {
  $result = $Json | ConvertFrom-Json
  try {
    Assert-Task20QueueTopology -QueueResult $result -ExpectedConsumers 0 -ExpectedPaused true | Out-Null
  } catch { return }
  throw 'Malformed Queue topology was accepted'
}

foreach ($json in @(
  '{"settings":{"delivery_paused":true}}',
  '{"consumers_total_count":null,"settings":{"delivery_paused":true}}',
  '{"consumers_total_count":0.5,"settings":{"delivery_paused":true}}',
  '{"consumers_total_count":"0","settings":{"delivery_paused":true}}',
  '{"consumers_total_count":false,"settings":{"delivery_paused":true}}',
  '{"consumers_total_count":-1,"settings":{"delivery_paused":true}}',
  '{"consumers_total_count":0}',
  '{"consumers_total_count":0,"settings":{"delivery_paused":null}}',
  '{"consumers_total_count":0,"settings":{"delivery_paused":"true"}}',
  '{"consumers_total_count":0,"settings":{"delivery_paused":1}}'
)) { Expect-Rejection $json }

$zero = '{"consumers_total_count":0,"settings":{"delivery_paused":true}}' | ConvertFrom-Json
$one = '{"consumers_total_count":1,"settings":{"delivery_paused":false}}' | ConvertFrom-Json
$z = Assert-Task20QueueTopology -QueueResult $zero -ExpectedConsumers 0 -ExpectedPaused true
$o = Assert-Task20QueueTopology -QueueResult $one -ExpectedConsumers 1 -ExpectedPaused false
if ($z.ConsumerCount -ne 0 -or -not $z.Paused -or $o.ConsumerCount -ne 1 -or $o.Paused) {
  throw 'Valid Queue topology was not preserved'
}

$omitted = '{"consumers_total_count":1,"settings":{}}' | ConvertFrom-Json
$fallback = Assert-Task20QueueTopology -QueueResult $omitted -ExpectedConsumers 1 -ExpectedPaused false -DashboardPaused $false
if ($fallback.Paused -or $fallback.PauseSource -cne 'dashboard' -or $o.PauseSource -cne 'api') {
  throw 'Dashboard fallback did not preserve the delivery state source'
}
foreach ($candidate in @(
  @{ Queue = $omitted; Dashboard = $null },
  @{ Queue = ('{"consumers_total_count":1,"settings":{"delivery_paused":null}}' | ConvertFrom-Json); Dashboard = $false },
  @{ Queue = $one; Dashboard = $true }
)) {
  try {
    Assert-Task20QueueTopology -QueueResult $candidate.Queue -ExpectedConsumers 1 -ExpectedPaused false -DashboardPaused $candidate.Dashboard | Out-Null
  } catch { continue }
  throw 'Missing, malformed or conflicting pause state was accepted'
}

$catalog = [ordered]@{
  a = [pscustomobject]@{ Name = 'queue-a'; Id = 'aaaa' }
  b = [pscustomobject]@{ Name = 'queue-b'; Id = 'bbbb' }
  c = [pscustomobject]@{ Name = 'queue-c'; Id = 'cccc' }
}
$now = [DateTimeOffset]::Parse('2026-09-19T10:00:00Z')
$notBefore = $now.AddMinutes(-2)
$account = 'account-test'
$rows = foreach ($item in $catalog.GetEnumerator()) {
  [pscustomobject]@{
    name = $item.Value.Name
    queue_id = $item.Value.Id
    url = "https://dash.cloudflare.com/$account/workers/queues/$($item.Value.Id)/messages"
    observed_utc = '2026-09-19T09:59:00Z'
    section = 'Pause Delivery'
    status = 'Active'
    control = 'Pause'
  }
}
$valid = [pscustomobject]@{ checkpoint = 'baseline'; queues = @($rows) }
$map = Assert-Task20DashboardEvidence -Evidence $valid -QueueCatalog $catalog -AccountId $account -Checkpoint baseline -NotBeforeUtc $notBefore -NowUtc $now
if ($map.Count -ne 3 -or $map['a'] -or $map['b'] -or $map['c']) {
  throw 'Valid Dashboard evidence was not preserved'
}
if ($PSVersionTable.PSVersion -lt [version]'7.5') { throw 'PowerShell 7.5 or newer is required for receipt parsing' }
$fixturePath = Join-Path $env:TEMP ('task20-dashboard-fixture-' + [Guid]::NewGuid().ToString('N') + '.json')
try {
  Set-Content -LiteralPath $fixturePath -Value ($valid | ConvertTo-Json -Depth 6) -Encoding UTF8
  $loaded = Get-Content -LiteralPath $fixturePath -Raw -Encoding UTF8 | ConvertFrom-Json -DateKind String
  if ($loaded.queues[0].observed_utc -isnot [string]) { throw 'Receipt loader changed timestamp type' }
  $loadedMap = Assert-Task20DashboardEvidence -Evidence $loaded -QueueCatalog $catalog -AccountId $account -Checkpoint baseline -NotBeforeUtc $notBefore -NowUtc $now
  if ($loadedMap.Count -ne 3) { throw 'File-loaded Dashboard receipt was rejected' }
} finally {
  Remove-Item -LiteralPath $fixturePath -ErrorAction SilentlyContinue
}
$pausedEvidence = $valid | ConvertTo-Json -Depth 6 | ConvertFrom-Json -DateKind String
foreach ($row in $pausedEvidence.queues) { $row.status = 'Paused'; $row.control = 'Resume' }
$pausedMap = Assert-Task20DashboardEvidence -Evidence $pausedEvidence -QueueCatalog $catalog -AccountId $account -Checkpoint baseline -NotBeforeUtc $notBefore -NowUtc $now
if (-not $pausedMap['a'] -or -not $pausedMap['b'] -or -not $pausedMap['c']) {
  throw 'Valid paused Dashboard evidence was not preserved'
}

function Expect-EvidenceRejection([scriptblock] $Change) {
  $candidate = $valid | ConvertTo-Json -Depth 6 | ConvertFrom-Json -DateKind String
  & $Change $candidate
  try {
    Assert-Task20DashboardEvidence -Evidence $candidate -QueueCatalog $catalog -AccountId $account -Checkpoint baseline -NotBeforeUtc $notBefore -NowUtc $now | Out-Null
  } catch { return }
  throw 'Malformed Dashboard evidence was accepted'
}

Expect-EvidenceRejection { param($x) $x.checkpoint = 'paused' }
Expect-EvidenceRejection { param($x) $x.queues[0].queue_id = 'wrong' }
Expect-EvidenceRejection { param($x) $x.queues[0].url = 'https://dash.cloudflare.com/other/workers/queues/aaaa/messages' }
Expect-EvidenceRejection { param($x) $x.queues[0].name = 'queue-b' }
Expect-EvidenceRejection { param($x) $x.queues[0].control = 'Resume' }
Expect-EvidenceRejection { param($x) $x.queues[0].status = 'Unknown' }
Expect-EvidenceRejection { param($x) $x.queues[0].section = 'Other' }
Expect-EvidenceRejection { param($x) $x.queues[0].observed_utc = '2026-09-19T09:57:00Z' }
Expect-EvidenceRejection { param($x) $x.queues[0].observed_utc = '2026-09-19T10:01:00Z' }
Expect-EvidenceRejection { param($x) $x.queues = @($x.queues[0], $x.queues[1]) }
Write-Output 'task20_topology_and_dashboard_fixtures_passed'
