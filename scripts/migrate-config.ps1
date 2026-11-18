<#
.SYNOPSIS
  Migrate an old-style mcp-planka config (URL= / KEY= / MANAGERS= / INSTRUCTIONS= / FILES_DIR=, usually in
  .planka) to the .env format, where every setting has the PLANKA_ prefix. Same rules as migrate-config.sh.
.DESCRIPTION
  Src = Dest: rename the keys in place. Otherwise write them into Dest (merged into an existing Dest),
  verify, then delete Src. Never prints values. A key already set in Dest to a different value is a
  conflict: nothing is changed and the script fails. Exit codes: 0 migrated, 3 nothing to migrate, 1 error.
#>
param([Parameter(Mandatory)][string]$Src, [Parameter(Mandatory)][string]$Dest)
$ErrorActionPreference = "Stop"

$New = @{ URL = "PLANKA_URL"; KEY = "PLANKA_API_KEY"; MANAGERS = "PLANKA_MANAGERS";
          INSTRUCTIONS = "PLANKA_INSTRUCTIONS"; FILES_DIR = "PLANKA_FILES_DIR" }
$LineRe = '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$'

function Fail([string]$Msg) { [Console]::Error.WriteLine("migrate-config: $Msg"); exit 1 }
function ReadLines([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return @() }
  return @([IO.File]::ReadAllText($Path) -split "\r?\n" | ForEach-Object { $_ })
}
# KEY -> trimmed value (last one wins)
function Values([string[]]$Lines) {
  $v = @{}
  foreach ($l in $Lines) { if ($l -match $LineRe) { $v[$Matches[1]] = $Matches[2].Trim() } }
  return $v
}

if (-not (Test-Path -LiteralPath $Src)) { Fail "not found: $Src" }
$SrcFull  = [IO.Path]::GetFullPath($Src)
$DestFull = [IO.Path]::GetFullPath($Dest)
$Same = $SrcFull -ieq $DestFull

$srcLines = ReadLines $SrcFull
if ($srcLines.Count -and $srcLines[-1] -eq "") { $srcLines = $srcLines[0..($srcLines.Count - 2)] }
$changed = $false
$converted = foreach ($l in $srcLines) {
  if ($l -match $LineRe -and $New.ContainsKey($Matches[1])) {
    $changed = $true
    "$($New[$Matches[1]])=$($Matches[2].Trim())"
  } else { $l }
}
$converted = @($converted)
if ($Same -and -not $changed) { Write-Host "migrate-config: $SrcFull already uses PLANKA_ keys"; exit 3 }

if ($Same -or -not (Test-Path -LiteralPath $DestFull)) {
  $out = $converted
} else {
  $out = @(ReadLines $DestFull)
  if ($out.Count -and $out[-1] -eq "") { $out = $out[0..($out.Count - 2)] }
  $have = Values $out
  $want = Values $converted
  $added = $false
  foreach ($l in $converted) {
    if ($l -notmatch $LineRe) { continue }
    $k = $Matches[1]
    if ($have.ContainsKey($k)) {
      if ($have[$k] -ne $want[$k]) { Fail "$k is set to a different value in $DestFull and $SrcFull; nothing changed, fix one by hand" }
    } else {
      if (-not $added) { $out += "# mcp-planka (migrated from $(Split-Path -Leaf $SrcFull))"; $added = $true }
      $out += $l; $have[$k] = $want[$k]
    }
  }
}

# Verify before replacing anything.
$got = Values $out
$want = Values $converted
foreach ($k in $want.Keys) {
  if (-not $got.ContainsKey($k) -or $got[$k] -ne $want[$k]) { Fail "verification failed for $k; nothing changed" }
}

$tmp = "$DestFull.migrate.tmp"
[IO.File]::WriteAllText($tmp, (($out -join "`n") + "`n"))
Move-Item -LiteralPath $tmp -Destination $DestFull -Force
if ($Same) {
  Write-Host "migrate-config: renamed keys in $DestFull to the PLANKA_ names"
} else {
  Remove-Item -LiteralPath $SrcFull -Force
  Write-Host "migrate-config: moved $SrcFull to $DestFull (PLANKA_ keys) and deleted $SrcFull"
}
exit 0
