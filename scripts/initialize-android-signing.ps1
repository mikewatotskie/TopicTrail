#Requires -Version 7.0
[CmdletBinding()]
param([switch]$VerifyExisting)

$ErrorActionPreference = 'Stop'
$privateRoot = Join-Path $env:LOCALAPPDATA 'TopicTrailRelease'
$recoveryRoot = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'TopicTrail Signing Recovery'
$active = Join-Path $privateRoot 'release.p12'
$backup = Join-Path $recoveryRoot 'recovery.p12'
$jdk = @($env:JAVA_HOME) + @(Get-ChildItem -Directory (Join-Path $env:USERPROFILE '.gradle/jdks') -ErrorAction SilentlyContinue | ForEach-Object FullName)
$tool = $jdk | Where-Object { $_ -and (Test-Path -LiteralPath (Join-Path $_ 'bin/keytool.exe')) } | Select-Object -First 1
if (!$tool) { throw 'A JDK with keytool is required.' }
$keytool = Join-Path $tool 'bin/keytool.exe'
$owner = [Security.Principal.WindowsIdentity]::GetCurrent().User
if (!$VerifyExisting) {
    foreach ($folder in @($privateRoot, $recoveryRoot)) {
        if (Test-Path -LiteralPath $folder) { throw "A signing directory already exists. Refusing to replace it: $folder" }
    }
    foreach ($folder in @($privateRoot, $recoveryRoot)) {
        $item = New-Item -ItemType Directory -Path $folder
        $acl = Get-Acl -LiteralPath $item.FullName
        $acl.SetAccessRuleProtection($true, $false)
        $acl.SetAccessRule([Security.AccessControl.FileSystemAccessRule]::new($owner, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
        Set-Acl -LiteralPath $item.FullName -AclObject $acl
    }
}
function Save-Password([string]$value, [string]$path) {
    ConvertTo-SecureString $value -AsPlainText -Force | ConvertFrom-SecureString | Set-Content -LiteralPath $path -Encoding ascii
}
function Certificate-Fingerprint([string]$store, [string]$variable) {
    $result = & $keytool -list -v '-J-Duser.language=en' '-J-Duser.country=US' -storetype PKCS12 -keystore $store -storepass:env $variable -alias topictrail-release
    if ($LASTEXITCODE -ne 0 -or ($result -join "`n") -notmatch 'SHA256:\s*([A-F0-9:]{95})') { throw 'Cannot verify the signing certificate.' }
    return $Matches[1].Replace(':', '').ToLowerInvariant()
}
try {
    if ($VerifyExisting) {
        $env:TT_ACTIVE_PASSWORD = ConvertTo-SecureString (Get-Content -Raw (Join-Path $privateRoot 'key-password.dpapi')).Trim() | ConvertFrom-SecureString -AsPlainText
        $env:TT_BACKUP_PASSWORD = ConvertTo-SecureString (Get-Content -Raw (Join-Path $privateRoot 'recovery-password.dpapi')).Trim() | ConvertFrom-SecureString -AsPlainText
    } else {
        $env:TT_ACTIVE_PASSWORD = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(48))
        $env:TT_BACKUP_PASSWORD = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(48))
        Save-Password $env:TT_ACTIVE_PASSWORD (Join-Path $privateRoot 'key-password.dpapi')
        # Keep the recovery password in the owner's protected credential directory, separate from recovery media.
        Save-Password $env:TT_BACKUP_PASSWORD (Join-Path $privateRoot 'recovery-password.dpapi')
        & $keytool -genkeypair -storetype PKCS12 -keystore $active -storepass:env TT_ACTIVE_PASSWORD -keypass:env TT_ACTIVE_PASSWORD -alias topictrail-release -keyalg RSA -keysize 4096 -sigalg SHA256withRSA -validity 10958 -dname 'CN=TopicTrail Android Release, O=TopicTrail' -noprompt
        if ($LASTEXITCODE -ne 0) { throw 'Release key creation failed.' }
        & $keytool -importkeystore -srckeystore $active -srcstoretype PKCS12 -srcstorepass:env TT_ACTIVE_PASSWORD -srcalias topictrail-release -destkeystore $backup -deststoretype PKCS12 -deststorepass:env TT_BACKUP_PASSWORD -destkeypass:env TT_BACKUP_PASSWORD -destalias topictrail-release -noprompt
        if ($LASTEXITCODE -ne 0) { throw 'Encrypted recovery copy failed.' }
    }
    $fingerprint = Certificate-Fingerprint $active TT_ACTIVE_PASSWORD
    if ((Certificate-Fingerprint $backup TT_BACKUP_PASSWORD) -ne $fingerprint) { throw 'Backup identity mismatch.' }
    # Creating a certificate request exercises the recovered private key without exporting it.
    $null = & $keytool -certreq -keystore $backup -storepass:env TT_BACKUP_PASSWORD -alias topictrail-release
    if ($LASTEXITCODE -ne 0) { throw 'Recovered private key could not sign.' }
    [pscustomobject]@{ publicCertificateSHA256=$fingerprint; encryptedRecoveryVerified=$true; signerDirectory=$privateRoot; recoveryDirectory=$recoveryRoot } | ConvertTo-Json
} finally {
    Remove-Item Env:TT_ACTIVE_PASSWORD, Env:TT_BACKUP_PASSWORD -ErrorAction SilentlyContinue
}
