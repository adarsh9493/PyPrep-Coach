<#
  PyPrep Coach - launcher
  ---------------------------------------------------------------------------
  This is what "Start PyPrep Coach.bat" runs when you double-click it.

  It:
    1. checks Node.js is installed
    2. installs npm dependencies on the very first run
    3. starts the server (node server.js)
    4. waits until the site actually answers
    5. opens it in your default browser

  The console window that appears IS the server. Close it to stop the coach.
#>

$ErrorActionPreference = 'Stop'

# Work from the folder this script lives in, no matter where it was launched.
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $Root

function Write-Info { param($m) Write-Host $m -ForegroundColor Cyan }
function Write-Ok   { param($m) Write-Host $m -ForegroundColor Green }
function Write-Note { param($m) Write-Host $m -ForegroundColor Yellow }
function Write-Bad  { param($m) Write-Host $m -ForegroundColor Red }

function Stop-WithPause {
    param([int]$Code = 1)
    Write-Host ''
    Read-Host 'Press Enter to close this window'
    exit $Code
}

# Read PORT from .env if the user has set one (falls back to 3000).
function Get-EnvPort {
    $port = 3000
    $envPath = Join-Path $Root '.env'
    if (Test-Path -LiteralPath $envPath) {
        foreach ($line in Get-Content -LiteralPath $envPath) {
            if ($line -match '^\s*PORT\s*=\s*"?(\d+)"?\s*$') { $port = [int]$Matches[1] }
        }
    }
    return $port
}

# Fast TCP check: is something listening on this port yet?
function Test-PortOpen {
    param([int]$Port)
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $async = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        if ($async.AsyncWaitHandle.WaitOne(300)) {
            $client.EndConnect($async)
            return $true
        }
        return $false
    }
    catch {
        return $false
    }
    finally {
        $client.Close()
    }
}

Write-Host ''
Write-Host '  🐍 PyPrep Coach' -ForegroundColor Magenta
Write-Host '  ----------------' -ForegroundColor DarkGray

# --- Pre-flight checks -----------------------------------------------------
if (-not (Test-Path -LiteralPath (Join-Path $Root 'server.js'))) {
    Write-Bad 'server.js was not found next to this launcher.'
    Write-Note 'Keep the launcher files in the same folder as server.js.'
    Stop-WithPause
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Bad 'Node.js 18 or newer is required, but it was not found on your PATH.'
    Write-Note 'Install it from https://nodejs.org (choose the LTS version), then double-click this file again.'
    Stop-WithPause
}

$Port = Get-EnvPort
$Url = "http://localhost:$Port"

# --- First run: install dependencies ---------------------------------------
if (-not (Test-Path -LiteralPath (Join-Path $Root 'node_modules\express'))) {
    Write-Info 'First run: installing dependencies with npm (one time only, this can take a minute)...'
    & npm install --no-fund --no-audit
    if ($LASTEXITCODE -ne 0) {
        Write-Bad 'npm install failed. Check your internet connection and that Node.js is installed correctly.'
        Stop-WithPause
    }
    Write-Ok 'Dependencies installed.'
}

# --- Already running? Just open the browser. -------------------------------
if (Test-PortOpen -Port $Port) {
    Write-Note "Something is already serving port $Port - opening it in your browser."
    Start-Process $Url
    exit 0
}

# --- Start the server ------------------------------------------------------
Write-Info "Starting the server on port $Port..."
Write-Note 'Leave this window open while you practice. Close it to stop the coach.'
Write-Host ''

$serverProc = Start-Process -FilePath 'node' -ArgumentList 'server.js' `
    -WorkingDirectory $Root -NoNewWindow -PassThru

# --- Wait until it actually answers on the port ----------------------------
$ready = $false
for ($i = 0; $i -lt 120; $i++) {
    if ($serverProc.HasExited) { break }
    if (Test-PortOpen -Port $Port) { $ready = $true; break }
    Start-Sleep -Milliseconds 250
}

if (-not $ready) {
    Write-Host ''
    Write-Bad 'The server did not start listening.'
    if ($serverProc.HasExited) {
        Write-Bad "node exited with code $($serverProc.ExitCode) - see the message above for the reason."
        Write-Note "A busy port is the usual cause. Add  PORT=3001  to your .env file and try again."
    }
    Stop-WithPause
}

# --- Open the browser ------------------------------------------------------
Write-Ok "Ready! Opening $Url in your browser."
Start-Process $Url
Write-Host ''

# --- Stay alive for as long as the server runs -----------------------------
$serverProc.WaitForExit()
Write-Host ''
Write-Host 'Server stopped.' -ForegroundColor DarkGray
