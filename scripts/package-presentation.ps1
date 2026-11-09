$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$deliverables = Join-Path $project 'deliverables\presentation-20261110'
$archivePath = Join-Path $deliverables 'TopicTrail-Web-Presentation-20261110.zip'
if (Test-Path -LiteralPath $archivePath) { throw 'The presentation archive already exists; preserve the completed deliverable.' }
$required = @('dist-presentation\index.html', 'START-PRESENTATION.cmd',
  'scripts\presentation-server.mjs', 'scripts\start-presentation.ps1',
  'deliverables\presentation-20261110\PRESENTATION-RUNBOOK.md',
  'deliverables\presentation-20261110\VERIFIED-STATUS.md')
foreach ($relative in $required) {
  if (-not (Test-Path -LiteralPath (Join-Path $project $relative) -PathType Leaf)) { throw "Missing package input: $relative" }
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::Open($archivePath, [IO.Compression.ZipArchiveMode]::Create)
try {
  $entries = @()
  foreach ($directory in @('dist-presentation','deliverables\presentation-20261110\sample-files')) {
    $entries += Get-ChildItem -LiteralPath (Join-Path $project $directory) -Recurse -File |
      ForEach-Object { [pscustomobject]@{ file=$_.FullName; name=$_.FullName.Substring($project.Length+1).Replace('\','/') } }
  }
  foreach ($relative in $required | Where-Object { $_ -ne 'dist-presentation\index.html' }) {
    $entries += [pscustomobject]@{ file=(Join-Path $project $relative); name=$relative.Replace('\','/') }
  }
  foreach ($entry in $entries) {
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive,$entry.file,$entry.name,[IO.Compression.CompressionLevel]::Optimal) | Out-Null
  }
} finally { $archive.Dispose() }
$check = [IO.Compression.ZipFile]::OpenRead($archivePath)
try {
  if (-not $check.GetEntry('START-PRESENTATION.cmd') -or -not $check.GetEntry('dist-presentation/index.html')) {
    throw 'The archive is missing its launcher or web entry.'
  }
  if (@($check.Entries | Where-Object { $_.FullName -match '(^|/)\.env|keystore|before-inventory|node_modules' }).Count) {
    # Expo public asset paths can legitimately retain a node_modules path; only secret inputs are disallowed.
    if (@($check.Entries | Where-Object { $_.FullName -match '(^|/)\.env|keystore|before-inventory' }).Count) {
      throw 'Unexpected private input in web package.'
    }
  }
  $receipt = [pscustomobject]@{ archive=$archivePath; entries=$check.Entries.Count;
    bytes=(Get-Item -LiteralPath $archivePath).Length; sha256=(Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash }
} finally { $check.Dispose() }
$receipt | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $deliverables 'web-package.json') -Encoding utf8
$receipt | ConvertTo-Json
