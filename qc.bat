@echo off
chcp 65001 >nul
cd /d "%~dp0"
REM  qc.bat  -- run dubbing quality check (qc.py)
REM    qc.bat                 scan all
REM    qc.bat <video_id>      check one video
REM    qc.bat --watch 30      re-scan every 30s (supervise alongside main program)
REM    qc.bat --deep          full overlap check (slower)
python qc.py %*
echo.
pause
