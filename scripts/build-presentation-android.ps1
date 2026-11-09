[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$android = Join-Path $projectRoot 'android'
$stage = Join-Path $projectRoot '.p'
$packageId = 'com.teamjam.topictrail.acceptance.presentation'
$scheme = 'topictrail-presentation'
$architecture = 'arm64-v8a'
$task = ':app:assembleDebug'

function Use-LocalDirectory([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) {
    New-Item -ItemType Directory -Path $Path | Out-Null
  }
  $item = Get-Item -LiteralPath $Path -Force
  if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "Build output must use an ordinary project directory: $Path"
  }
}

function Invoke-BuildTool([string]$Program, [string[]]$Arguments, [string]$LogFile, [switch]$Quiet) {
  $oldPreference = $ErrorActionPreference
  try {
    # Windows PowerShell wraps native stderr as ErrorRecords. Trust the native exit code.
    $ErrorActionPreference = 'Continue'
    & $Program @Arguments 2>&1 | ForEach-Object { $_.ToString() } | Tee-Object -FilePath $LogFile |
      ForEach-Object { if (-not $Quiet) { Write-Host $_ } }
    return $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $oldPreference
  }
}

if (-not (Test-Path -LiteralPath (Join-Path $android 'app\debug.keystore') -PathType Leaf)) {
  throw 'The existing local signing keystore is required.'
}
if (Get-CimInstance Win32_Process -Filter "Name = 'java.exe'" |
    Where-Object { $_.CommandLine -match 'GradleWrapperMain|gradle-wrapper\.jar' -and
      $_.CommandLine -like "*$android*" }) {
  throw 'A Gradle wrapper for this project is running. Retry after it exits.'
}
$gradleHome = if ($env:GRADLE_USER_HOME) { $env:GRADLE_USER_HOME } else { Join-Path $env:USERPROFILE '.gradle' }
$javaCandidates = @($env:JAVA_HOME)
foreach ($jdkDirectory in @((Join-Path $gradleHome 'jdks'), (Join-Path $env:ProgramFiles 'Java'))) {
  if (Test-Path -LiteralPath $jdkDirectory -PathType Container) {
    $javaCandidates += @(Get-ChildItem -LiteralPath $jdkDirectory -Directory | Select-Object -ExpandProperty FullName)
  }
}
$java = $javaCandidates | Where-Object {
  $_ -and (Test-Path -LiteralPath (Join-Path $_ 'bin\javac.exe') -PathType Leaf) -and
    (Test-Path -LiteralPath (Join-Path $_ 'release') -PathType Leaf) -and
    ((Get-Content -LiteralPath (Join-Path $_ 'release') -Raw) -match '(?m)^JAVA_VERSION="17\.')
} | Select-Object -First 1
if (-not $java) { throw 'An already installed JDK 17 is required for this offline build.' }

$sdk = @($env:ANDROID_HOME, $env:ANDROID_SDK_ROOT, 'C:\Android\Sdk') | Where-Object {
  $_ -and ((Test-Path -LiteralPath (Join-Path $_ 'platforms\android-37.0\android.jar') -PathType Leaf) -or
    (Test-Path -LiteralPath (Join-Path $_ 'platforms\android-37\android.jar') -PathType Leaf))
} | Select-Object -First 1
if (-not $sdk) { throw 'The installed Android 37 SDK was not found.' }
$androidTools = Join-Path $sdk 'build-tools\37.0.0'
$aapt = Join-Path $androidTools 'aapt2.exe'
$apksigner = Join-Path $androidTools 'apksigner.bat'
if (-not (Test-Path -LiteralPath $aapt -PathType Leaf) -or -not (Test-Path -LiteralPath $apksigner -PathType Leaf)) {
  throw 'Android build tools 37.0.0 are required.'
}

$wrapperProperties = Get-Content -LiteralPath (Join-Path $android 'gradle\wrapper\gradle-wrapper.properties') -Raw
$distribution = [regex]::Match($wrapperProperties, '(?m)^distributionUrl=.*?/(gradle-[^/\r\n]+)\.zip\s*$').Groups[1].Value
$wrapperCache = Join-Path $gradleHome ('wrapper\dists\' + $distribution)
if (-not $distribution -or -not (Test-Path -LiteralPath $wrapperCache -PathType Container) -or
    -not (Get-ChildItem -LiteralPath $wrapperCache -Recurse -File -Filter "$distribution.zip.ok" | Select-Object -First 1)) {
  throw 'The project Gradle distribution must already be in the local wrapper cache.'
}
$null = Get-Command node -ErrorAction Stop

$ownerFile = Join-Path $stage '.topictrail-presentation'
if (Test-Path -LiteralPath $stage) {
  Use-LocalDirectory $stage
  if (-not (Test-Path -LiteralPath $ownerFile -PathType Leaf) -or
      (Get-Content -LiteralPath $ownerFile -Raw).Trim() -ne $projectRoot) {
    throw "The existing staging directory has no matching build owner: $stage"
  }
} else {
  Use-LocalDirectory $stage
  [IO.File]::WriteAllText($ownerFile, $projectRoot)
}
$lock = [IO.File]::Open((Join-Path $stage 'build.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
try {
  $temp = Join-Path $stage 't'
  $cache = Join-Path $stage 'c'
  foreach ($directory in @($temp, $cache, (Join-Path $stage 'b'), (Join-Path $stage 'x'), (Join-Path $stage 'android'))) {
    Use-LocalDirectory $directory
  }

  $deliverables = Join-Path $projectRoot 'deliverables'
  $presentation = Join-Path $deliverables 'presentation-20261110'
  Use-LocalDirectory $deliverables
  Use-LocalDirectory $presentation
  $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss-fff') + 'Z'
  $run = Join-Path $presentation "android-$stamp"
  New-Item -ItemType Directory -Path $run | Out-Null
  $log = Join-Path $run 'build.log'
  $receiptFile = Join-Path $run 'receipt.json'
  $generatedApk = Join-Path $stage 'b\a\outputs\apk\debug\app-debug.apk'
  $savedApk = Join-Path $run "topictrail-presentation-$architecture-$stamp.apk"

  $env:JAVA_HOME = $java
  $env:JAVA_TOOL_OPTIONS = '-Djava.io.tmpdir="' + $temp + '" -Djdk.net.unixdomain.tmpdir="' + $temp + '"'
  $env:ANDROID_HOME = $sdk
  $env:ANDROID_SDK_ROOT = $sdk
  $env:TEMP = $temp
  $env:TMP = $temp
  $env:EXPO_OFFLINE = '1'
  $env:EXPO_NO_TELEMETRY = '1'
  $env:EXPO_NO_GIT_STATUS = '1'
  $env:EXPO_SKIP_FINGERPRINT_EMBED = '1'
  $env:CMAKE_BUILD_PARALLEL_LEVEL = '1'
  $env:TOPICTRAIL_PRESENTATION_STAGE = $stage

  # The non-debuggable APK activates release lint, whose tooling is absent from the offline cache.
  $gradleArguments = @($task, '-x', ':app:lintVitalDebug', '-x', ':app:lintVitalReportDebug',
    '--offline', '--no-daemon', '--no-parallel', '--max-workers=1',
    '--no-build-cache', '--no-configuration-cache', '--console=plain', '--stacktrace',
    "-PreactNativeArchitectures=$architecture", '-Pkotlin.compiler.execution.strategy=in-process',
    '-Pexpo.android.cmakeObjectPathMax=250', '--project-cache-dir', $cache,
    '--init-script', (Join-Path $PSScriptRoot 'presentation-native.gradle'))
  $receipt = [ordered]@{
    startedAt = (Get-Date).ToUniversalTime().ToString('o')
    projectRoot = $projectRoot
    task = $task
    architecture = $architecture
    applicationId = $packageId
    scheme = $scheme
    offline = $true
    deviceExecuted = $false
    status = 'failed'
    log = $log
    gradleArguments = $gradleArguments
  }

  try {
    Push-Location -LiteralPath $android
    try {
      $receipt.gradleExit = Invoke-BuildTool (Join-Path $android 'gradlew.bat') $gradleArguments $log
    } finally {
      Pop-Location
    }
    if ($receipt.gradleExit -ne 0) { throw "Gradle exited $($receipt.gradleExit). See $log" }
    if (-not (Test-Path -LiteralPath $generatedApk -PathType Leaf)) {
      throw 'Gradle succeeded without an APK at the expected path.'
    }

    $badging = Join-Path $run 'apk-badging.txt'
    $manifest = Join-Path $run 'apk-manifest.txt'
    $signature = Join-Path $run 'apk-signature.txt'
    if ((Invoke-BuildTool $aapt @('dump', 'badging', $generatedApk) $badging -Quiet) -ne 0 -or
        (Invoke-BuildTool $aapt @('dump', 'xmltree', '--file', 'AndroidManifest.xml', $generatedApk) $manifest -Quiet) -ne 0 -or
        (Invoke-BuildTool $apksigner @('verify', '--verbose', '--print-certs', $generatedApk) $signature -Quiet) -ne 0) {
      throw 'Android package metadata or signature verification failed.'
    }
    $badge = Get-Content -LiteralPath $badging -Raw
    $manifestDump = Get-Content -LiteralPath $manifest -Raw
    $schemePattern = '(?m)android:scheme[^\r\n]*"' + [regex]::Escape($scheme) + '"'
    if ($badge -notmatch "(?m)^package: name='$([regex]::Escape($packageId))'" -or
        $badge -notmatch "(?m)^application-label:'TopicTrail Presentation'\r?$" -or
        $badge -match '(?m)^application-debuggable' -or
        $manifestDump -notmatch $schemePattern -or
        $manifestDump -match '(?m)android:scheme[^\r\n]*"topictrail"') {
      throw 'The package metadata does not match the isolated standalone presentation identity.'
    }

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($generatedApk)
    try {
      $bundle = $zip.GetEntry('assets/index.android.bundle')
      $hermes = $zip.GetEntry("lib/$architecture/libhermesvm.so")
      $abis = @($zip.Entries | Where-Object { $_.FullName -match '^lib/([^/]+)/[^/]+$' } |
        ForEach-Object { $_.FullName.Split('/')[1] } | Sort-Object -Unique)
      if ($null -eq $bundle -or $bundle.Length -eq 0 -or $null -eq $hermes -or
          $abis.Count -ne 1 -or $abis[0] -ne $architecture) {
        throw 'The APK must contain an embedded JavaScript bundle and ARM64-only Hermes libraries.'
      }
      $receipt.embeddedBundleBytes = $bundle.Length
    } finally {
      $zip.Dispose()
    }
    [IO.File]::Copy($generatedApk, $savedApk, $false)
    $receipt.apk = $savedApk
    $receipt.bytes = (Get-Item -LiteralPath $savedApk).Length
    $receipt.sha256 = (Get-FileHash -LiteralPath $savedApk -Algorithm SHA256).Hash
    $receipt.status = 'artifact-verified'
  } catch {
    $receipt.error = $_.Exception.Message
    throw
  } finally {
    $receipt.finishedAt = (Get-Date).ToUniversalTime().ToString('o')
    $receipt | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $receiptFile -Encoding UTF8
    $receipt | ConvertTo-Json -Depth 4
  }
} finally {
  $lock.Dispose()
}
