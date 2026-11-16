[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [ValidateSet('Existing', 'Presentation', IgnoreCase = $false)]
  [string]$Variant
)

$ErrorActionPreference = 'Stop'
throw 'The standalone Expo-template-signed build has been retired. Use scripts/build-secure-android.ps1 -Variant Release for distribution or -Variant Migration only for the direct transfer to existing installations. Supply the next unused -VersionCode.'
