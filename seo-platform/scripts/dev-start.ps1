# Starts the local (non-Docker) dev stack: Postgres must already be
# running as a Windows service. Launches the Next.js app, the pg-boss
# worker, and the fixture test server, each in its own minimized window.
# Run dev-stop.ps1 first if you're restarting after a code change to the
# worker or app — `npm run dev`/`start` do not hot-reload a change made
# while the old process is still alive, and merely closing the window can
# leave the real node process running (see dev-stop.ps1's comment).

$root = Split-Path -Parent $PSScriptRoot

Write-Output "Starting app (http://localhost:3000)..."
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root\app'; npm run start" -WindowStyle Minimized

Write-Output "Starting worker..."
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root\app'; npm run worker" -WindowStyle Minimized

Write-Output "Starting fixture server (http://127.0.0.1:4100)..."
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root\fixtures'; npm start" -WindowStyle Minimized

Write-Output "All three launched in minimized windows. Give them a few seconds, then check:"
Write-Output "  Invoke-WebRequest http://localhost:3000/api/health"
