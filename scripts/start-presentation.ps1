param([switch]$NoOpen)
$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$address = 'http://127.0.0.1:4184'
function Get-PresentationStatus {
  try { return Invoke-RestMethod -Uri "$address/_topictrail_presentation_status" -TimeoutSec 2 }
  catch { return $null }
}
$status = Get-PresentationStatus
if ($status -and $status.app -ne 'TopicTrail-main-presentation') { throw 'Port 4184 is occupied by another application.' }
if (-not $status) {
  if (-not (Test-Path -LiteralPath (Join-Path $project 'dist-presentation\index.html'))) {
    throw 'The presentation web export is missing.'
  }
  $node = (Get-Command node -ErrorAction Stop).Source
  $server = Join-Path $PSScriptRoot 'presentation-server.mjs'
  Start-Process -FilePath $node -ArgumentList @(('"' + $server + '"')) -WorkingDirectory $project -WindowStyle Hidden
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    Start-Sleep -Milliseconds 250
    $status = Get-PresentationStatus
    if ($status) { break }
  }
}
if (-not $status -or $status.app -ne 'TopicTrail-main-presentation') { throw 'TopicTrail could not start on port 4184.' }
if (-not $NoOpen) { Start-Process "$address/demo" }
Write-Output "TopicTrail is ready at $address/demo"
