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
Write-Output 'task20_topology_fixtures_passed: 12'
