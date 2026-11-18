<#
.SYNOPSIS
  Register mcp-planka with a Windows-native Claude Code install (default: user scope).
.DESCRIPTION
  Uses Windows Node (>= 20) if available, otherwise runs the server with Node inside WSL.
  WSL's Node is located by absolute path (nvm, fnm, volta etc. only set PATH in interactive
  shells), and registered as "wsl.exe -e <node> <entry>", so no shell setup is needed at runtime.
  Config: .env in the repo (PLANKA_URL=..., PLANKA_API_KEY=...), or -Config <file>. An old .planka
  (URL= / KEY= ...) is migrated to .env with PLANKA_ keys and then deleted.
  If you use Claude Code inside WSL, run ./register.sh there instead.
.EXAMPLE
  .\register.ps1
  .\register.ps1 -Name planka-me -Config C:\keys\planka-me.env
  .\register.ps1 -ForceWsl -Distro Debian
  .\register.ps1 -DryRun
#>
param(
  [string]$Name = "planka",
  [ValidateSet("user", "local", "project")][string]$Scope = "user",
  [string]$Config = "",
  [switch]$ForceWsl,
  [string]$Distro = "",
  [switch]$DryRun
)
$ErrorActionPreference = "Stop"

function Run([string]$Exe, [string[]]$ArgList) {
  if ($DryRun) { Write-Host "[dry-run] $Exe $($ArgList -join ' ')"; return }
  & $Exe @ArgList
  if ($LASTEXITCODE -ne 0) { throw "$Exe failed ($LASTEXITCODE)" }
}

# Arguments that select the WSL distro (empty = default distro).
$WslSel = @()
if ($Distro) { $WslSel = @("-d", $Distro) }

# Run a native command, discarding its stderr. Windows PowerShell 5.1 turns native stderr into a
# terminating error under ErrorActionPreference=Stop, even with 2>$null, so relax it locally.
function Quiet([scriptblock]$Block) {
  $ErrorActionPreference = "Continue"
  & $Block 2>$null
}

# Run a bash command inside WSL and return its stdout lines (stderr discarded).
function WslOut([string]$BashFlags, [string]$Cmd) {
  $out = Quiet { & wsl.exe @WslSel -e bash $BashFlags $Cmd }
  return @($out | ForEach-Object { "$_".Trim() } | Where-Object { $_ })
}

function NodeMajor([string]$Version) { [int](($Version -replace '^v', '') -split '\.')[0] }

$Root  = (Resolve-Path $PSScriptRoot).Path
$Entry = Join-Path $Root "dist\index.js"
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { throw "claude CLI not found in PATH" }

# Old format: .planka with URL= / KEY= / ... New: .env with PLANKA_ keys.
$Migrate = Join-Path $Root "scripts\migrate-config.ps1"
function HasLegacyKeys([string]$Path) {
  return [bool](Select-String -LiteralPath $Path -Pattern '^\s*(URL|KEY|MANAGERS|INSTRUCTIONS|FILES_DIR)\s*=' -Quiet)
}
function MigrateConfig([string]$From, [string]$To) {
  if ($DryRun) { Write-Host "[dry-run] migrate $From -> $To (PLANKA_ keys)"; return }
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Migrate -Src $From -Dest $To
  if ($LASTEXITCODE -ne 0) { throw "config migration failed ($LASTEXITCODE)" }
}
$EnvFile = Join-Path $Root ".env"
if ($Config) {
  $Config = (Resolve-Path $Config).Path
  if (HasLegacyKeys $Config) { MigrateConfig $Config $Config }
} else {
  $Legacy = Join-Path $Root ".planka"
  if (Test-Path $Legacy) { MigrateConfig $Legacy $EnvFile }
  if ((Test-Path $EnvFile) -and (HasLegacyKeys $EnvFile)) { MigrateConfig $EnvFile $EnvFile }
  if (-not (Test-Path $EnvFile) -and -not ($DryRun -and (Test-Path $Legacy)) -and -not ($env:PLANKA_URL -and $env:PLANKA_API_KEY)) {
    throw "No $EnvFile (PLANKA_URL=... / PLANKA_API_KEY=...) and PLANKA_URL/PLANKA_API_KEY not set"
  }
}

$WinNode = Get-Command node -ErrorAction SilentlyContinue
$UseWsl = $ForceWsl -or -not $WinNode
if (-not $UseWsl -and (NodeMajor (node -v)) -lt 20) {
  Write-Host "Windows Node $(node -v) is too old (need >= 20); trying WSL"
  $UseWsl = $true
}

if ($UseWsl) {
  if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) { throw "Neither Windows Node >= 20 nor WSL found" }
  $WslRoot = (WslOut "-c" "wslpath -a '$($Root -replace '\\', '/')'") | Select-Object -Last 1
  if (-not $WslRoot) { throw "WSL is not working (wslpath failed). Is a distro installed? (wsl -l)" }

  # Find node: plain login shell first, then an interactive shell (loads ~/.bashrc, where nvm lives),
  # then nvm.sh directly. Keep only absolute paths (interactive shells may print other noise).
  $WslNode = $null
  foreach ($probe in @(@("-lc", "command -v node"), @("-lic", "command -v node"),
                       @("-c", ". ~/.nvm/nvm.sh >/dev/null 2>&1; command -v node"))) {
    $WslNode = (WslOut $probe[0] $probe[1]) | Where-Object { $_ -like "/*" } | Select-Object -Last 1
    if ($WslNode) { break }
  }
  if (-not $WslNode) {
    throw "No Node found in WSL. Install Node 20+ there (e.g. nvm install 22), or install Node for Windows."
  }
  $WslVersion = (Quiet { & wsl.exe @WslSel -e $WslNode -v } | Select-Object -First 1)
  if (-not $WslVersion -or (NodeMajor "$WslVersion".Trim()) -lt 20) { throw "WSL Node $WslVersion at $WslNode is too old (need >= 20)" }
  $WslBin   = $WslNode -replace '/node$', ''
  $WslEntry = "$WslRoot/dist/index.js"
  Write-Host "Using Node $("$WslVersion".Trim()) inside WSL ($WslNode)"

  # Install dependencies if missing, and build only if dist/ is missing or older than src/.
  # No double quotes in this script: Windows PowerShell 5.1 mangles them in native arguments.
  $build = "set -e; cd '$WslRoot'; export PATH='$($WslBin)':`$PATH; " +
           "[ -d node_modules ] || npm install --no-fund --no-audit; " +
           "if [ ! -f dist/index.js ] || find src -name '*.ts' -newer dist/index.js | grep -q .; " +
           "then echo Building...; npm run build --silent; else echo dist/ is up to date; fi"
  Run "wsl.exe" ($WslSel + @("-e", "bash", "-c", $build))

  $Server = @("wsl.exe") + $WslSel + @("-e")
  if ($Config) {
    $WslConfig = (WslOut "-c" "wslpath -a '$($Config -replace '\\', '/')'") | Select-Object -Last 1
    $Server += @("env", "PLANKA_CONFIG=$WslConfig")
  }
  $Server += @($WslNode, $WslEntry)
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
  $info = (Quiet { & claude mcp get $Name }) -join "`n"
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
  if ($UseWsl) {
    Write-Host "The server runs from $WslRoot. Starting it from the Windows drive can take ~10 s;"
    Write-Host "if Claude Code reports a connection timeout, set MCP_TIMEOUT=30000 (user environment variable)."
  }
}
