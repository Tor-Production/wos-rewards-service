function Assert-Task20QueueTopology {
  param(
    [Parameter(Mandatory = $true)] [object] $QueueResult,
    [Nullable[int]] $ExpectedConsumers,
    [ValidateSet('true', 'false')] [string] $ExpectedPaused,
    [Nullable[bool]] $DashboardPaused
  )

  $countProperty = $QueueResult.PSObject.Properties['consumers_total_count']
  $settingsProperty = $QueueResult.PSObject.Properties['settings']
  if ($null -eq $countProperty -or $null -eq $countProperty.Value -or
      $countProperty.Value -isnot [long] -or $countProperty.Value -lt 0 -or
      $null -eq $settingsProperty -or $null -eq $settingsProperty.Value) {
    throw 'Staging Queue topology unavailable'
  }
  $pausedProperty = $settingsProperty.Value.PSObject.Properties['delivery_paused']
  if ($null -ne $pausedProperty -and $pausedProperty.Value -isnot [bool]) {
    throw 'Staging Queue pause state unavailable'
  }
  $count = [long]$countProperty.Value
  if ($null -eq $pausedProperty) {
    if ($null -eq $DashboardPaused) { throw 'Staging Queue pause state unavailable' }
    $paused = [bool]$DashboardPaused
    $source = 'dashboard'
  } else {
    $paused = [bool]$pausedProperty.Value
    $source = 'api'
    if ($null -ne $DashboardPaused -and $paused -ne [bool]$DashboardPaused) {
      throw 'Conflicting Queue delivery state'
    }
  }
  if ($null -ne $ExpectedConsumers -and $count -ne $ExpectedConsumers) {
    throw 'Unexpected Queue consumer count'
  }
  if ($ExpectedPaused -and $paused.ToString().ToLowerInvariant() -ne $ExpectedPaused) {
    throw 'Unexpected Queue delivery state'
  }
  return [pscustomobject]@{ ConsumerCount = $count; Paused = $paused; PauseSource = $source }
}

function Assert-Task20DashboardEvidence {
  param(
    [Parameter(Mandatory = $true)] [object] $Evidence,
    [Parameter(Mandatory = $true)] [System.Collections.IDictionary] $QueueCatalog,
    [Parameter(Mandatory = $true)] [string] $AccountId,
    [Parameter(Mandatory = $true)] [string] $Checkpoint,
    [Parameter(Mandatory = $true)] [DateTimeOffset] $NotBeforeUtc,
    [DateTimeOffset] $NowUtc = [DateTimeOffset]::UtcNow
  )

  if ($Evidence.PSObject.Properties['checkpoint'] -eq $null -or
      $Evidence.checkpoint -isnot [string] -or $Evidence.checkpoint -cne $Checkpoint -or
      $Evidence.PSObject.Properties['queues'] -eq $null -or
      $Evidence.queues -isnot [array] -or $Evidence.queues.Count -ne $QueueCatalog.Count) {
    throw 'Dashboard checkpoint evidence unavailable'
  }
  $seen = @{}
  $pauseMap = @{}
  foreach ($row in $Evidence.queues) {
    if ($null -eq $row) { throw 'Dashboard Queue evidence unavailable' }
    foreach ($field in @('name', 'queue_id', 'url', 'observed_utc', 'section', 'status', 'control')) {
      $property = $row.PSObject.Properties[$field]
      if ($null -eq $property -or $property.Value -isnot [string] -or [string]::IsNullOrWhiteSpace($property.Value)) {
        throw 'Dashboard Queue evidence unavailable'
      }
    }
    $name = $row.name
    if ($seen.ContainsKey($name)) { throw 'Duplicate Dashboard Queue evidence' }
    $seen[$name] = $true
    $match = $null
    foreach ($item in $QueueCatalog.GetEnumerator()) {
      if ($item.Value.Name -ceq $name) { $match = $item; break }
    }
    if ($null -eq $match) { throw 'Unexpected Dashboard Queue identity' }
    $id = $match.Value.Id
    $expectedUrl = "https://dash.cloudflare.com/$AccountId/workers/queues/$id/messages"
    if ($row.queue_id -cne $id -or $row.url -cne $expectedUrl -or $row.section -cne 'Pause Delivery') {
      throw 'Unexpected Dashboard Queue identity'
    }
    if ($row.observed_utc -cnotmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$') {
      throw 'Invalid Dashboard observation time'
    }
    $observed = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParse($row.observed_utc, [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::AssumeUniversal, [ref] $observed) -or
        $observed -lt $NotBeforeUtc -or $observed -lt $NowUtc.AddMinutes(-5) -or
        $observed -gt $NowUtc.AddSeconds(15)) {
      throw 'Stale or invalid Dashboard observation time'
    }
    if ($row.status -ceq 'Active' -and $row.control -ceq 'Pause') {
      $pauseMap[$match.Key] = $false
    } elseif ($row.status -ceq 'Paused' -and $row.control -ceq 'Resume') {
      $pauseMap[$match.Key] = $true
    } else {
      throw 'Unknown or conflicting Dashboard delivery state'
    }
  }
  return $pauseMap
}
