@echo off
title Stop Demandora Services
echo Stopping Demandora services on ports 3000 and 8000...
powershell -Command "$p3000 = (Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue).OwningProcess; if ($p3000) { Stop-Process -Id $p3000 -Force -ErrorAction SilentlyContinue; Write-Host 'Stopped Demandora Port 3000.' }; $p8000 = (Get-NetTCPConnection -LocalPort 8000 -ErrorAction SilentlyContinue).OwningProcess; if ($p8000) { Stop-Process -Id $p8000 -Force -ErrorAction SilentlyContinue; Write-Host 'Stopped Demandora Port 8000.' }"
echo Done.
pause
