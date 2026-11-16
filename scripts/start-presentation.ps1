param([switch]$NoOpen, [switch]$Packaged)
$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$release = if ($Packaged) { $project } else { Join-Path $project 'deliverables\duckduckgo-v11\web' }
$index = Join-Path $release 'dist-presentation\index.html'
if (-not (Test-Path -LiteralPath $index -PathType Leaf)) { throw 'The current TopicTrail security release is missing. Build or extract the current local web release.' }
$indexHash = (Get-FileHash -LiteralPath $index -Algorithm SHA256).Hash.ToLowerInvariant()
$address = 'http://127.0.0.1:4184'
function Get-PresentationStatus {
  try { return Invoke-RestMethod -Uri "$address/_topictrail_presentation_status" -TimeoutSec 2 }
  catch { return $null }
}
$status = Get-PresentationStatus
if ($status -and $status.app -ne 'TopicTrail-main-presentation') { throw 'Port 4184 is occupied by another application.' }
if (-not $status) {
  $node = (Get-Command node -ErrorAction Stop).Source
  $server = Join-Path $PSScriptRoot 'presentation-server.mjs'
  $serverArgs = @(('"' + $server + '"'))
  if ($Packaged) { $serverArgs += '--packaged' }
  Start-Process -FilePath $node -ArgumentList $serverArgs -WorkingDirectory $project -WindowStyle Hidden
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    Start-Sleep -Milliseconds 250
    $status = Get-PresentationStatus
    if ($status) { break }
  }
}
if (-not $status -or $status.app -ne 'TopicTrail-main-presentation') { throw 'TopicTrail could not start on port 4184.' }
if ($status.securityRevision -ne 1 -or $status.indexHash -ne $indexHash) {
  throw 'Another version of the TopicTrail web server is running on port 4184. Close its server and launch this release again.'
}
if (-not $NoOpen) { Start-Process "$address/demo" }
Write-Output "TopicTrail is ready at $address/demo"
