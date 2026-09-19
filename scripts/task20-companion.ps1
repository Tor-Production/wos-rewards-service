param(
  [Parameter(Mandatory = $true)] [string] $TuplePath,
  [Parameter(Mandatory = $true)] [string] $AuthPath,
  [switch] $Start
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$configModule = Join-Path $root 'dist/companion/src/config.js'
$entrypoint = Join-Path $root 'dist/companion/src/index.js'
$tupleKeys = @(
  'DISCORD_CODE_FEED_CHANNEL_ID', 'DISCORD_CODE_FOLLOWER_WEBHOOK_ID',
  'DISCORD_CODE_SOURCE_GUILD_ID', 'DISCORD_CODE_SOURCE_CHANNEL_ID'
)
$secretKeys = @('DISCORD_BOT_TOKEN', 'INGESTION_SHARED_SECRET')
$processKeys = @(
  'ENVIRONMENT', 'PROVIDER_MODE', 'CODE_DISCOVERY_ENABLED',
  'COMPANION_WORKER_BASE_URL', 'DISCORD_GUILD_ID',
  'DISCORD_REGISTRATION_CHANNEL_ID', 'DISCORD_MVP_ADMIN_CHANNEL_ID',
  'DISCORD_MVP_ADMIN_USER_ALLOWLIST', 'DISCORD_APPLICATION_ID'
) + $tupleKeys + $secretKeys

function Read-RequiredValues([string] $Path, [string[]] $Names) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw 'Named local input file unavailable' }
  $found = @{}
  foreach ($line in Get-Content -LiteralPath $Path) {
    if ($line -match '^([A-Z][A-Z0-9_]*)=(.*)$' -and $Names -contains $Matches[1]) {
      if ($found.ContainsKey($Matches[1])) { throw 'Duplicate required local input name' }
      $found[$Matches[1]] = $Matches[2]
    }
  }
  foreach ($name in $Names) {
    if (-not $found.ContainsKey($name) -or [string]::IsNullOrWhiteSpace($found[$name])) {
      throw "Required local input name missing: $name"
    }
  }
  return $found
}

try {
  if (-not (Test-Path -LiteralPath $configModule -PathType Leaf)) {
    throw 'Build the companion first with npm run companion:build'
  }
  $tuple = Read-RequiredValues $TuplePath $tupleKeys
  $auth = Read-RequiredValues $AuthPath $secretKeys
  $nonsecret = @{
    ENVIRONMENT = 'staging'
    PROVIDER_MODE = 'mock'
    CODE_DISCOVERY_ENABLED = 'true'
    COMPANION_WORKER_BASE_URL = 'https://wos-rewards-service-staging.chute-risk9361.workers.dev'
    DISCORD_GUILD_ID = '1455981004261953659'
    DISCORD_REGISTRATION_CHANNEL_ID = '1548863278946590720'
    DISCORD_MVP_ADMIN_CHANNEL_ID = '1548863407334101122'
    DISCORD_MVP_ADMIN_USER_ALLOWLIST = '470002312341880834'
    DISCORD_APPLICATION_ID = '1542396374832652369'
  }
  foreach ($name in $processKeys) {
    $value = if ($tuple.ContainsKey($name)) { $tuple[$name] } elseif ($auth.ContainsKey($name)) { $auth[$name] } else { $nonsecret[$name] }
    [Environment]::SetEnvironmentVariable($name, $value, 'Process')
  }
  & node --input-type=module -e "import { loadCompanionConfig } from './dist/companion/src/config.js'; loadCompanionConfig(process.env); console.log('companion_config_valid');"
  if ($LASTEXITCODE -ne 0) { throw 'Companion config validation failed' }
  if ($Start) {
    Write-Output 'companion_starting_foreground'
    & node $entrypoint
    if ($LASTEXITCODE -ne 0) { throw 'Companion exited unsuccessfully' }
  }
} catch {
  # Never include raw exception text: configuration libraries and shells may echo input.
  Write-Error 'Task 20 companion preparation/start failed; keep discovery disabled.'
  exit 1
} finally {
  foreach ($name in $processKeys) { [Environment]::SetEnvironmentVariable($name, $null, 'Process') }
  Remove-Variable tuple, auth -ErrorAction SilentlyContinue
}
