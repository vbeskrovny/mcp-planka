<#
.SYNOPSIS
  Register mcp-planka with a Windows-native Claude Code install (default: user scope).
.DESCRIPTION
  Uses Windows Node if available, otherwise runs the server inside WSL.
  If you use Claude Code inside WSL, run ./register.sh there instead.
.EXAMPLE
  .\register.ps1
  .\register.ps1 -Name planka-me -Config C:\keys\.planka-me
  .\register.ps1 -DryRun
#>
param(
  [string]$Name = "planka",
  [ValidateSet("user", "local", "project")][string]$Scope = "user",
  [string]$Config = "",
  [switch]$ForceWsl,
  [switch]$DryRun
)
$ErrorActionPreference = "Stop"

function Run([string]$Exe, [string[]]$ArgList) {
  if ($DryRun) { Write-Host "[dry-run] $Exe $($ArgList -join ' ')"; return }
  & $Exe @ArgList
  if ($LASTEXITCODE -ne 0) { throw "$Exe failed ($LASTEXITCODE)" }
}

$Root  = (Resolve-Path $PSScriptRoot).Path
$Entry = Join-Path $Root "dist\index.js"
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { throw "claude CLI not found in PATH" }

if ($Config) {
  $Config = (Resolve-Path $Config).Path
} elseif (-not (Test-Path (Join-Path $Root ".planka")) -and -not ($env:PLANKA_URL -and $env:PLANKA_API_KEY)) {
  throw "No $Root\.planka (URL=... / KEY=...) and PLANKA_URL/PLANKA_API_KEY not set"
}

$UseWsl = $ForceWsl -or -not (Get-Command node -ErrorAction SilentlyContinue)
if ($UseWsl) {
  if (-not (Get-Command wsl -ErrorAction SilentlyContinue)) { throw "Neither Windows node nor wsl found" }
  $WslRoot  = (wsl wslpath -a ($Root -replace '\\', '/')).Trim()
  $WslEntry = "$WslRoot/dist/index.js"
  Write-Host "Using Node inside WSL ($WslRoot)"
  Run "wsl" @("bash", "-lc", "cd '$WslRoot' && ([ -d node_modules ] || npm install --no-fund --no-audit) && npm run build --silent")
  $Server = @("wsl", "node", $WslEntry)
  if ($Config) { $Server = @("wsl", "env", "PLANKA_CONFIG=$((wsl wslpath -a ($Config -replace '\\', '/')).Trim())", "node", $WslEntry) }
} else {
  Write-Host "Using Windows Node $(node -v)"
  Push-Location $Root
  try {
    if (-not (Test-Path node_modules)) { Run "npm" @("install", "--no-fund", "--no-audit") }
    Run "npm" @("run", "build", "--silent")
  } finally { Pop-Location }
  $Server = @("node", $Entry)
}

foreach ($s in "local", "user", "project") {
  $info = (& claude mcp get $Name 2>$null) -join "`n"
  if ($info -match "(?i)scope:\s*$s") { Write-Host "Removing existing '$Name' ($s scope)"; Run "claude" @("mcp", "remove", $Name, "-s", $s) }
}

$ArgList = @("mcp", "add", "-s", $Scope, $Name)
if ($Config -and -not $UseWsl) { $ArgList += @("-e", "PLANKA_CONFIG=$Config") }
$ArgList += "--"
$ArgList += $Server
Write-Host "Registering '$Name' ($Scope scope)"
Run "claude" $ArgList

if (-not $DryRun) {
  & claude mcp get $Name
  Write-Host "`nDone. Restart Claude Code - /mcp only shows servers loaded at session start."
}
