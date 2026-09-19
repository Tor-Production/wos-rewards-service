function Assert-Task20QueueTopology {
  param(
    [Parameter(Mandatory = $true)] [object] $QueueResult,
    [Nullable[int]] $ExpectedConsumers,
    [ValidateSet('true', 'false')] [string] $ExpectedPaused
  )

  $countProperty = $QueueResult.PSObject.Properties['consumers_total_count']
  $settingsProperty = $QueueResult.PSObject.Properties['settings']
  if ($null -eq $countProperty -or $null -eq $countProperty.Value -or
      $countProperty.Value -isnot [long] -or $countProperty.Value -lt 0 -or
      $null -eq $settingsProperty -or $null -eq $settingsProperty.Value) {
    throw 'Staging Queue topology unavailable'
  }
  $pausedProperty = $settingsProperty.Value.PSObject.Properties['delivery_paused']
  if ($null -eq $pausedProperty -or $pausedProperty.Value -isnot [bool]) {
    throw 'Staging Queue pause state unavailable'
  }
  $count = [long]$countProperty.Value
  $paused = [bool]$pausedProperty.Value
  if ($null -ne $ExpectedConsumers -and $count -ne $ExpectedConsumers) {
    throw 'Unexpected Queue consumer count'
  }
  if ($ExpectedPaused -and $paused.ToString().ToLowerInvariant() -ne $ExpectedPaused) {
    throw 'Unexpected Queue delivery state'
  }
  return [pscustomobject]@{ ConsumerCount = $count; Paused = $paused }
}
