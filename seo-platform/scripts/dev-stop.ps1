# Stops the local (non-Docker) dev stack: Next.js app, worker, fixture
# server. Kills by matched command line, not just the wrapping PowerShell
# window — `Stop-Process` on a wrapper shell leaves `npm`/`node`/`tsx`
# child processes orphaned and still running (confirmed the hard way
# during local Windows setup: a killed wrapper left the worker running
# stale code, silently racing a freshly started one). Run this before
# `dev-start.ps1` if you're ever unsure what's still running.

$ErrorActionPreference = "SilentlyContinue"

$patterns = @("npm run worker", "npm run start", "npm start", "worker.ts")
$procs = Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'powershell.exe'"

$killed = 0
foreach ($p in $procs) {
    foreach ($pattern in $patterns) {
        if ($p.CommandLine -like "*$pattern*" -and $p.CommandLine -notlike "*dev-stop*") {
            Write-Output "Stopping PID $($p.ProcessId): $($p.CommandLine)"
            Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
            $killed++
            break
        }
    }
}

Write-Output "Stopped $killed process(es)."
