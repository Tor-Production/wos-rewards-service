param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Bridge', 'Guarded', 'Enabled')]
  [string] $Mode,
  [string] $TuplePath,
  [string] $OutputDirectory = '.task20-local'
)

$ErrorActionPreference = 'Stop'
$basePath = Join-Path (Split-Path $PSScriptRoot -Parent) 'wrangler.jsonc'
$source = Get-Content -LiteralPath $basePath -Raw

function Replace-ExactlyOnce([string] $Text, [string] $Old, [string] $New) {
  $first = $Text.IndexOf($Old, [StringComparison]::Ordinal)
  if ($first -lt 0 -or $Text.IndexOf($Old, $first + $Old.Length, [StringComparison]::Ordinal) -ge 0) {
    throw "Expected exactly one cutover configuration anchor"
  }
  return $Text.Substring(0, $first) + $New + $Text.Substring($first + $Old.Length)
}

$stageMarker = '"name": "wos-rewards-service-staging"'
$stageStart = $source.IndexOf($stageMarker, [StringComparison]::Ordinal)
if ($stageStart -lt 0) { throw 'Staging Worker name mismatch' }
$prefix = $source.Substring(0, $stageStart)
$stage = $source.Substring($stageStart)
$stage = Replace-ExactlyOnce $stage '"CODE_DISCOVERY_ENABLED": false,' '"CODE_DISCOVERY_ENABLED": false,'

if ($Mode -eq 'Bridge') {
  $source = Replace-ExactlyOnce $source '"main": "src/index.ts"' '"main": "src/cutover/disabled.ts"'
  $source = Replace-ExactlyOnce $source '"triggers": { "crons": ["* * * * *"] }' '"triggers": { "crons": [] }'
  $consumerPattern = '(?s)"consumers": \[.*?\],\s*"producers":'
  if ([regex]::Matches($source, $consumerPattern).Count -ne 1) {
    throw 'Expected exactly one staging Queue-consumer block'
  }
  $source = [regex]::Replace($source, $consumerPattern, '"consumers": [],' + "`n" + '        "producers":')
} else {
  if (-not $TuplePath -or -not (Test-Path -LiteralPath $TuplePath -PathType Leaf)) {
    throw 'The named local non-secret tuple file is required'
  }
  $required = @(
    'DISCORD_CODE_FEED_CHANNEL_ID',
    'DISCORD_CODE_FOLLOWER_WEBHOOK_ID',
    'DISCORD_CODE_SOURCE_GUILD_ID',
    'DISCORD_CODE_SOURCE_CHANNEL_ID'
  )
  $values = @{}
  foreach ($line in Get-Content -LiteralPath $TuplePath) {
    if ($line -match '^([A-Z][A-Z0-9_]*)=(.*)$' -and $required -contains $Matches[1]) {
      if ($values.ContainsKey($Matches[1])) { throw 'Duplicate controlled tuple key' }
      $values[$Matches[1]] = $Matches[2]
    }
  }
  foreach ($key in $required) {
    if (-not $values.ContainsKey($key) -or $values[$key] -cnotmatch '^[1-9][0-9]{16,19}$') {
      throw "Missing or malformed $key"
    }
  }
  if ($values['DISCORD_CODE_FEED_CHANNEL_ID'] -in @('1548863278946590720', '1548863407334101122')) {
    throw 'Controlled feed overlaps a registration or admin channel'
  }
  if ($values['DISCORD_CODE_FEED_CHANNEL_ID'] -eq $values['DISCORD_CODE_SOURCE_CHANNEL_ID']) {
    throw 'Controlled source and feed must differ'
  }
  $enabled = if ($Mode -eq 'Enabled') { 'true' } else { 'false' }
  $lines = @("`"CODE_DISCOVERY_ENABLED`": $enabled,")
  foreach ($key in $required) { $lines += "        `"$key`": `"$($values[$key])`"," }
  $stage = Replace-ExactlyOnce $stage '"CODE_DISCOVERY_ENABLED": false,' ($lines -join "`n")
  $source = $prefix + $stage
}

# Wrangler resolves paths from this generated configuration's directory.
$source = Replace-ExactlyOnce $source '"main": "src/' '"main": "../src/'
$source = Replace-ExactlyOnce $source '"migrations_dir": "migrations"' '"migrations_dir": "../migrations"'
$source = Replace-ExactlyOnce $source '"$schema": "node_modules/' '"$schema": "../node_modules/'

New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$outputPath = Join-Path $OutputDirectory ("wrangler.$($Mode.ToLowerInvariant()).jsonc")
Set-Content -LiteralPath $outputPath -Value $source -Encoding utf8 -NoNewline
$digest = (Get-FileHash -LiteralPath $outputPath -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Output "mode=$Mode sha256=$digest path=$outputPath"
