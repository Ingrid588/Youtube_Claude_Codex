@echo off
cd /d "%~dp0"
powershell -Command "Get-NetTCPConnection -LocalPort 8765 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"
start /B pythonw live_dub_server.py
echo Live dub server started in background on http://127.0.0.1:8765
timeout /t 3 >nul
