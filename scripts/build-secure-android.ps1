#Requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateRange(2, 2100000000)][int]$VersionCode,
    [ValidateSet('Release', 'Migration', 'Both')][string]$Variant = 'Release'
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$stage = Join-Path $projectRoot '.r'
$destination = Join-Path $projectRoot 'deliverables/private-android'
$null = New-Item -ItemType Directory -Force -Path $stage, $destination, (Join-Path $stage 't')
foreach ($path in @($stage, $destination, (Split-Path -Parent $destination))) {
    if ((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Build directories must be ordinary directories.' }
}
$sdk = @($env:ANDROID_HOME, $env:ANDROID_SDK_ROOT, 'C:\Android\Sdk') | Where-Object {
    $_ -and (Test-Path -LiteralPath (Join-Path $_ 'build-tools/37.0.0/apksigner.bat'))
} | Select-Object -First 1
if (!$sdk) { throw 'The Android SDK and build tools 37 are required.' }
$jdk = @($env:JAVA_HOME) + @(Get-ChildItem -Directory (Join-Path $env:USERPROFILE '.gradle/jdks') -ErrorAction SilentlyContinue | ForEach-Object FullName)
$java = $jdk | Where-Object { $_ -and (Test-Path -LiteralPath (Join-Path $_ 'bin/javac.exe')) -and ((Get-Content (Join-Path $_ 'release') -Raw) -match 'JAVA_VERSION="17\.') } | Select-Object -First 1
if (!$java) { throw 'A JDK 17 installation is required.' }
$kinds = if ($Variant -eq 'Both') { @('Release','Migration') } else { @($Variant) }
$lock = [IO.File]::Open((Join-Path $stage 'release.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
$variables = @('JAVA_HOME','ANDROID_HOME','ANDROID_SDK_ROOT','TOPICTRAIL_CLOUD_STAGE','TOPICTRAIL_CLOUD_VARIANT',
    'NODE_ENV','EXPO_NO_TELEMETRY','EXPO_SKIP_FINGERPRINT_EMBED','CMAKE_BUILD_PARALLEL_LEVEL','TEMP','TMP',
    'JAVA_TOOL_OPTIONS','TOPICTRAIL_SIGNING_PASSWORD','TOPICTRAIL_SIGNING_FILE')
$previous = @{}
foreach ($name in $variables) { $previous[$name] = [Environment]::GetEnvironmentVariable($name) }
try {
    # Windows can restore read-only directory attributes on Gradle's generated source folders.
    # Gradle must replace these directories when VERSION_CODE changes between updates.
    $generatedApp = Join-Path $stage 'b/n'
    if (Test-Path -LiteralPath $generatedApp) {
        foreach ($dir in @((Join-Path $stage 'b'), $generatedApp)) {
            if ((Get-Item -LiteralPath $dir -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unexpected linked build directory.' }
        }
        Get-ChildItem -LiteralPath $generatedApp -Directory -Force -Recurse | Where-Object {
            ($_.Attributes -band [IO.FileAttributes]::ReadOnly) -and !($_.Attributes -band [IO.FileAttributes]::ReparsePoint)
        } | ForEach-Object { $_.Attributes = $_.Attributes -band (-bnot [IO.FileAttributes]::ReadOnly) }
    }
    $env:JAVA_HOME = $java
    $env:ANDROID_HOME = $sdk
    $env:ANDROID_SDK_ROOT = $sdk
    $env:TOPICTRAIL_CLOUD_STAGE = $stage
    $env:TOPICTRAIL_CLOUD_VARIANT = 'Distribution'
    $env:NODE_ENV = 'production'
    $env:EXPO_NO_TELEMETRY = '1'
    $env:EXPO_SKIP_FINGERPRINT_EMBED = '1'
    $env:CMAKE_BUILD_PARALLEL_LEVEL = '2'
    $env:TEMP = Join-Path $stage 't'
    $env:TMP = $env:TEMP
    $env:JAVA_TOOL_OPTIONS = '-Djava.io.tmpdir="' + $env:TEMP + '" -Djdk.net.unixdomain.tmpdir="' + $env:TEMP + '"'
    if ($kinds -contains 'Release') {
        $vault = Join-Path $env:LOCALAPPDATA 'TopicTrailRelease'
        $env:TOPICTRAIL_SIGNING_FILE = Join-Path $vault 'release.p12'
        $credential = (Get-Content -LiteralPath (Join-Path $vault 'key-password.dpapi') -Raw).Trim()
        $env:TOPICTRAIL_SIGNING_PASSWORD = ConvertTo-SecureString $credential | ConvertFrom-SecureString -AsPlainText
    }
    $receipts = @(Get-ChildItem -LiteralPath $destination -Recurse -File -Filter 'receipt.json' | ForEach-Object { Get-Content -Raw -LiteralPath $_.FullName | ConvertFrom-Json })
    foreach ($kind in $kinds) {
        if ($receipts | Where-Object { $_.variant -eq $kind -and $_.versionCode -ge $VersionCode }) { throw "Choose a version code above the last packaged $kind build." }
    }
    if ($kinds -contains 'Release') {
        # Metro copies current assets without removing legacy font files from older builds.
        $raw = Join-Path $stage 'b/n/generated/res/react/release/raw'
        if (Test-Path -LiteralPath $raw -PathType Container) {
            for ($dir = Get-Item -LiteralPath $raw; $dir.FullName -ne $stage; $dir = $dir.Parent) {
                if ($dir.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unexpected linked resource directory.' }
            }
            foreach ($font in @('interregular', 'intermedium', 'intersemibold', 'interbold')) {
                $obsolete = Join-Path $raw "src_assets_fonts_$font.ttf"
                if (Test-Path -LiteralPath $obsolete -PathType Leaf) { Remove-Item -LiteralPath $obsolete }
            }
        }
    }
    $run = Join-Path $destination ([DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss-fffZ') + "-v$VersionCode")
    $null = New-Item -ItemType Directory -Path $run
    $gradle = @('-p', (Join-Path $projectRoot 'android')) + @($kinds | ForEach-Object { ":app:assemble$_" }) + @(
        '--no-daemon', '--no-parallel', '--max-workers=2', '--build-cache', '--no-configuration-cache', '--console=plain',
        "-PtopicTrailVersionCode=$VersionCode", '-PreactNativeArchitectures=arm64-v8a,x86_64',
        '-Pkotlin.compiler.execution.strategy=in-process', '-Pexpo.android.cmakeObjectPathMax=250',
        '-Dorg.gradle.jvmargs=-Xmx3072m -XX:MaxMetaspaceSize=1024m',
        '--project-cache-dir', (Join-Path $stage 'c'), '--init-script', (Join-Path $PSScriptRoot 'cloud-native.gradle'))
    & (Join-Path $projectRoot 'android/gradlew.bat') @gradle *> (Join-Path $run 'gradle.log')
    if ($LASTEXITCODE -ne 0) { throw "Android build failed. See $run\gradle.log" }
    $tools = Join-Path $sdk 'build-tools/37.0.0'
    foreach ($kind in $kinds) {
        $suffix = $kind.ToLowerInvariant()
        $signed = Join-Path $stage "b/n/outputs/apk/$suffix/app-$suffix.apk"
        $identity = if ($kind -eq 'Release') { 'com.teamjam.topictrail' } else { 'com.teamjam.topictrail.acceptance' }
        $pin = if ($kind -eq 'Release') { (Get-Content (Join-Path $projectRoot 'android/app/release-certificate.sha256') -Raw).Trim() } else { 'fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c' }
        $checks = Join-Path $run $suffix
        $null = New-Item -ItemType Directory -Path $checks
        $signature = & (Join-Path $tools 'apksigner.bat') verify --verbose --print-certs $signed
        if ($LASTEXITCODE -ne 0 -or ($signature -join "`n") -notmatch 'Number of signers: 1\s' -or ($signature -join "`n") -notmatch "certificate SHA-256 digest: $pin\s") { throw "Unexpected $kind signer." }
        $signature | Set-Content (Join-Path $checks 'signature.txt')
        $badging = & (Join-Path $tools 'aapt2.exe') dump badging $signed
        if ($LASTEXITCODE -ne 0 -or ($badging -join "`n") -notmatch "(?m)^package: name='$([regex]::Escape($identity))' versionCode='$VersionCode'" -or ($badging -join "`n") -match 'application-debuggable|android.permission.(SYSTEM_ALERT_WINDOW|ACCESS_LOCAL_NETWORK)') { throw "Unexpected $kind app identity, permissions or debug state." }
        if ($kind -eq 'Release' -and ($badging -join "`n") -match 'android\.permission\.(READ|WRITE)_EXTERNAL_STORAGE') { throw 'Release storage permissions must be limited to picker grants.' }
        $badging | Set-Content (Join-Path $checks 'badging.txt')
        $manifest = & (Join-Path $tools 'aapt2.exe') dump xmltree --file AndroidManifest.xml $signed
        $xml = $manifest -join "`n"
        $appXml = ($xml -split 'E: application \(', 2)[1]
        if ($LASTEXITCODE -ne 0 -or !$appXml -or $appXml -notmatch 'android:usesCleartextTraffic[^=\r\n]*=false' -or ($kind -eq 'Release' -and $appXml -notmatch 'android:allowBackup[^=\r\n]*=false')) { throw "Unexpected packaged $kind transport or backup policy." }
        # AAPT2 indents children of each manifest element. Outbound package queries are outside activities.
        $activities = [regex]::Matches($appXml, '(?ms)^(?<indent> *)E: activity(?:-alias)? \([^\n]*\n(?<children>.*?)(?=^\k<indent>\S|\z)')
        if (!$activities.Count) { throw "Missing packaged $kind activity." }
        foreach ($activity in $activities) {
            $filters = [regex]::Matches($activity.Groups['children'].Value, '(?ms)^(?<indent> *)E: intent-filter \([^\n]*\n(?<children>.*?)(?=^\k<indent>\S|\z)')
            foreach ($filter in $filters) {
                $filterTree = $filter.Groups['children'].Value
                if ($filterTree -match 'android\.intent\.category\.BROWSABLE' -or $filterTree -match 'android:scheme\(') { throw "Unexpected packaged $kind inbound link handler." }
            }
        }
        $manifest | Set-Content (Join-Path $checks 'manifest.txt')
        & (Join-Path $tools 'zipalign.exe') -c -P 16 4 $signed
        if ($LASTEXITCODE -ne 0) { throw 'APK alignment failed.' }
        if ($kind -eq 'Release') {
            Add-Type -AssemblyName System.IO.Compression.FileSystem
            $archive = [IO.Compression.ZipFile]::OpenRead($signed)
            try {
                $fontFiles = @{
                    'assets/fonts/Inter.ttf' = 'src/assets/fonts/Inter-Regular.ttf'
                    'assets/fonts/ionicons.ttf' = 'node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/Ionicons.ttf'
                }
                $inter = Get-Item -LiteralPath (Join-Path $projectRoot $fontFiles['assets/fonts/Inter.ttf'])
                $interHash = (Get-FileHash -LiteralPath $inter.FullName -Algorithm SHA256).Hash
                $extraInter = 0
                foreach ($asset in $fontFiles.GetEnumerator()) {
                    $entry = $archive.GetEntry($asset.Key)
                    if (!$entry) { throw "Missing packaged startup font: $($asset.Key)." }
                    $stream = $entry.Open()
                    try { $actual = (Get-FileHash -InputStream $stream -Algorithm SHA256).Hash } finally { $stream.Dispose() }
                    $expected = (Get-FileHash -LiteralPath (Join-Path $projectRoot $asset.Value) -Algorithm SHA256).Hash
                    if ($actual -ne $expected) { throw "Packaged startup font changed: $($asset.Key)." }
                }
                foreach ($entry in $archive.Entries) {
                    if ($entry.FullName -ne 'assets/fonts/Inter.ttf' -and $entry.FullName.EndsWith('.ttf') -and $entry.Length -eq $inter.Length) {
                        $stream = $entry.Open()
                        try { if ((Get-FileHash -InputStream $stream -Algorithm SHA256).Hash -eq $interHash) { $extraInter++ } }
                        finally { $stream.Dispose() }
                    }
                }
                if ($extraInter) { throw "Found stale duplicate Inter resources in the release APK." }
            } finally { $archive.Dispose() }
        }
        $output = Join-Path $checks "TopicTrail-$suffix-v$VersionCode.apk"
        Copy-Item -LiteralPath $signed -Destination $output
        [pscustomobject]@{variant=$kind;applicationId=$identity;versionCode=$VersionCode;certificateSHA256=$pin;apk=(Split-Path -Leaf $output);sha256=(Get-FileHash -LiteralPath $output).Hash.ToLowerInvariant()} | ConvertTo-Json | Set-Content (Join-Path $checks 'receipt.json')
        Write-Output $output
    }
} finally {
    $lock.Dispose()
    foreach ($name in $variables) { [Environment]::SetEnvironmentVariable($name, $previous[$name]) }
}
