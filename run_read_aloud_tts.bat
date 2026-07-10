@echo off
setlocal

echo.
echo ===============================================
echo      Read-Aloud Cloud TTS Server (local test)
echo ===============================================
echo.

REM Check Python
python --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Python not found. Please install Python 3.8+
    pause
    exit /b 1
)

cd /d "%~dp0"

echo Checking dependencies...
python -c "import fastapi, uvicorn, edge_tts" >nul 2>&1
if errorlevel 1 (
    echo Installing dependencies...
    pip install fastapi uvicorn edge-tts -q
    if errorlevel 1 (
        echo ERROR: Failed to install dependencies
        echo Please run: pip install fastapi uvicorn edge-tts
        pause
        exit /b 1
    )
)

echo [OK] Dependencies OK
echo.
echo Starting server on http://127.0.0.1:7860 ...
echo Press Ctrl+C to stop.
echo.

set PORT=7860
python read_aloud_tts_server.py

pause
