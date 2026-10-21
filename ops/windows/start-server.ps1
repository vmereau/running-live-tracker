<#
.SYNOPSIS
  Supervisor for the tracker server on the home PC (AD-14): starts node server/src/main.ts
  and restarts it 10 s after it exits, forever. Run at logon by a Task Scheduler task,
  see docs/ops/race-readiness.md.

.PARAMETER EventConfig
  Event config (EVENT_CONFIG). A relative path is resolved from the repo root.
.PARAMETER DataDir
  Data folder (DATA_DIR), default <repo>\data. A relative path is resolved from the repo root.
.PARAMETER Port
  HTTP port (PORT), default 8787. The server always binds 127.0.0.1 only.

Logs, all under <DataDir>\logs:
  server-<UTC date>.log         the server's own JSON log (written by the server)
  stdout.log                    stdout of the latest run (overwritten at each start)
  stderr-<yyyyMMdd-HHmmss>.log  stderr of a run (UTC start time), kept only when non-empty (boot errors, crashes)
  supervisor.log                one line per start and per exit (exit code, time)
#>
param(
  [Parameter(Mandatory = $true)][string]$EventConfig,
  [string]$DataDir,
  [int]$Port = 8787
)

$ErrorActionPreference = 'Stop'
$RestartDelaySeconds = 10

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

function Resolve-FromRepo([string]$path) {
  if ([System.IO.Path]::IsPathRooted($path)) { return [System.IO.Path]::GetFullPath($path) }
  return [System.IO.Path]::GetFullPath((Join-Path $repoRoot $path))
}

$EventConfig = Resolve-FromRepo $EventConfig
if ([string]::IsNullOrWhiteSpace($DataDir)) { $DataDir = Join-Path $repoRoot 'data' }
$DataDir = Resolve-FromRepo $DataDir
$logsDir = Join-Path $DataDir 'logs'
New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
$supervisorLog = Join-Path $logsDir 'supervisor.log'
$mainTs = Join-Path $repoRoot 'server\src\main.ts'

$env:EVENT_CONFIG = $EventConfig
$env:DATA_DIR = $DataDir
$env:PORT = "$Port"

function Write-SupervisorLog([string]$message) {
  $line = '{0} {1}' -f (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'), $message
  # Best effort: a failed log write must never stop the supervisor.
  try { Add-Content -Path $supervisorLog -Value $line -Encoding utf8 } catch {}
}

Write-SupervisorLog "supervisor started (pid $PID): EVENT_CONFIG=$EventConfig DATA_DIR=$DataDir PORT=$Port"

while ($true) {
  try {
    $node = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')
    $stdoutLog = Join-Path $logsDir 'stdout.log'
    $stderrLog = Join-Path $logsDir "stderr-$stamp.log"
    $started = Get-Date
    $process = Start-Process -FilePath $node -ArgumentList "`"$mainTs`"" -WorkingDirectory $repoRoot `
      -NoNewWindow -Wait -PassThru -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog
    $seconds = [int]((Get-Date) - $started).TotalSeconds
    $code = if ($null -eq $process.ExitCode) { 'unknown' } else { $process.ExitCode }
    $stderrNote = ''
    if ((Test-Path $stderrLog) -and (Get-Item $stderrLog).Length -eq 0) { Remove-Item $stderrLog -Force }
    elseif (Test-Path $stderrLog) { $stderrNote = ", stderr in $(Split-Path $stderrLog -Leaf)" }
    Write-SupervisorLog "server (pid $($process.Id)) exited with code $code after $seconds s$stderrNote; restarting in $RestartDelaySeconds s"
  } catch {
    Write-SupervisorLog "cannot start the server: $($_.Exception.Message); retrying in $RestartDelaySeconds s"
  }
  Start-Sleep -Seconds $RestartDelaySeconds
}
