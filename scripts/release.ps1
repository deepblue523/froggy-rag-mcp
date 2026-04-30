param(
  [ValidateSet('patch', 'minor', 'major')]
  [string] $Bump = 'patch',

  [switch] $DryRun,
  [switch] $SkipPush,
  [switch] $AllowDirty,
  [switch] $WithSourceDist,
  [switch] $SkipReleaseNotes,
  [switch] $AllowMissingReleaseNotes
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

$argList = @($Bump)
if ($DryRun) { $argList += '--dry-run' }
if ($SkipPush) { $argList += '--skip-push' }
if ($AllowDirty) { $argList += '--allow-dirty' }
if ($WithSourceDist) { $argList += '--with-source-dist' }
if ($SkipReleaseNotes) { $argList += '--skip-release-notes' }
if ($AllowMissingReleaseNotes) { $argList += '--allow-missing-release-notes' }

node scripts/release.js @argList
