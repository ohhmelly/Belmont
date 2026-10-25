# Stops the local (non-Docker) dev stack: Next.js app, worker, fixture
# server. Kills by matched command line AND by whoever currently owns
# ports 3000/3001/4100 — command-line matching alone isn't enough: the
# `npm run start` wrapper's own command line doesn't appear anywhere in
# its "next start" child process's command line (that child shows as
# `node .../next/dist/bin/next start`), so killing only the wrapper
# leaves the real server running and bound to the port, serving a stale
# build while a freshly started one fails with EADDRINUSE (confirmed the
# hard way after a Phase 6 rebuild — the exact same category of orphan
# bug this script was written to prevent for the worker, just missed on
# the app side). Run this before `dev-start.ps1` if you're ever unsure
# what's still running.

$ErrorActionPreference = "SilentlyContinue"

$patterns = @("npm run worker", "npm run start", "npm start", "worker.ts", "next\dist\bin\next")
$procs = Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'powershell.exe'"

$killedIds = @{}
foreach ($p in $procs) {
    foreach ($pattern in $patterns) {
        if ($p.CommandLine -like "*$pattern*" -and $p.CommandLine -notlike "*dev-stop*") {
            Write-Output "Stopping PID $($p.ProcessId): $($p.CommandLine)"
            Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
            $killedIds[$p.ProcessId] = $true
            break
        }
    }
}

# Belt-and-suspenders: whatever is actually bound to our known ports,
# regardless of what its command line looks like.
foreach ($port in @(3000, 3001, 4100)) {
    $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    foreach ($c in $conns) {
        if (-not $killedIds.ContainsKey($c.OwningProcess)) {
            $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $($c.OwningProcess)"
            Write-Output "Stopping PID $($c.OwningProcess) (owns port $port): $($proc.CommandLine)"
            Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
            $killedIds[$c.OwningProcess] = $true
        }
    }
}

Write-Output "Stopped $($killedIds.Count) process(es)."
