$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$release = Join-Path $project 'deliverables\duckduckgo-v11\web'
$archivePath = Join-Path $release 'TopicTrail-Local-Web-v11.zip'
if (Test-Path -LiteralPath $archivePath) { throw 'The completed archive already exists. Preserve it and use a new release directory for future builds.' }
& node (Join-Path $PSScriptRoot 'presentation-server.mjs') --check-manifest
if ($LASTEXITCODE -ne 0) { throw 'The export differs from its reviewed public manifest.' }

$packageScripts = Join-Path $release 'scripts'
[IO.Directory]::CreateDirectory($packageScripts) | Out-Null
$scriptFiles = @('presentation-server.mjs', 'presentation-public-files.json', 'start-presentation.ps1')
foreach ($name in $scriptFiles) {
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $packageScripts $name)
}
$launcher = (Get-Content -Raw -LiteralPath (Join-Path $project 'START-PRESENTATION.cmd')).Replace('start-presentation.ps1"', 'start-presentation.ps1" -Packaged')
[IO.File]::WriteAllText((Join-Path $release 'START-PRESENTATION.cmd'), $launcher, [Text.Encoding]::ASCII)
$publicFiles = Get-Content -Raw -LiteralPath (Join-Path $packageScripts 'presentation-public-files.json') | ConvertFrom-Json
$names = @('START-PRESENTATION.cmd') + @($scriptFiles | ForEach-Object { 'scripts/' + $_ }) + @($publicFiles | ForEach-Object { 'dist-presentation/' + $_ })
$tempArchive = Join-Path $release ('.partial-' + [guid]::NewGuid().ToString('N') + '.zip')
$tar = (Get-Command tar.exe -ErrorAction Stop).Source
try {
  $names | & $tar -acf $tempArchive -C $release -T -
  if ($LASTEXITCODE -ne 0) { throw 'Windows could not archive the approved export files.' }
  $archived = @(& $tar -tf $tempArchive)
  if ($LASTEXITCODE -ne 0 -or (Compare-Object @($names | Sort-Object) @($archived | Sort-Object))) { throw 'The archive contents differ from the approved files.' }
  [IO.File]::Move($tempArchive, $archivePath)
} finally {
  if ([IO.File]::Exists($tempArchive)) { [IO.File]::Delete($tempArchive) }
}
$receipt = [pscustomobject]@{ archive=(Split-Path -Leaf $archivePath); entries=$names.Count; bytes=(Get-Item -LiteralPath $archivePath).Length; sha256=(Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant() }
$receipt | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $release 'web-package.json') -Encoding utf8
$receipt | ConvertTo-Json
