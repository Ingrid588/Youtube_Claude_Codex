@echo off
setlocal enabledelayedexpansion

echo.
echo ===============================================
echo      YouTube Video Narration Web App
echo ===============================================
echo.

REM Check Python
python --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Python not found. Please install Python 3.8+
    pause
    exit /b 1
)

echo [OK] Python detected

REM Get script directory
cd /d "%~dp0"
set "PROJECT_DIR=%cd%"
set "WEB_APP_DIR=%PROJECT_DIR%\web_app"

echo Project: %PROJECT_DIR%
echo Web App: %WEB_APP_DIR%
echo.

REM Check files
if not exist "%PROJECT_DIR%\live_dub_server.py" (
    echo ERROR: live_dub_server.py not found
    pause
    exit /b 1
)

if not exist "%WEB_APP_DIR%\index.html" (
    echo ERROR: web_app/index.html not found
    pause
    exit /b 1
)

echo [OK] All files found
echo.

REM Check dependencies
echo Checking dependencies...
python -c "import fastapi" >nul 2>&1
if errorlevel 1 (
    echo Installing dependencies...
    pip install fastapi uvicorn yt-dlp edge-tts -q
    if errorlevel 1 (
        echo ERROR: Failed to install dependencies
        echo Please run: pip install fastapi uvicorn yt-dlp edge-tts
        pause
        exit /b 1
    )
)

echo [OK] Dependencies OK
echo.

echo ===============================================
echo      Starting services...
echo ===============================================
echo.

REM Start backend
echo [1/2] Starting backend (http://127.0.0.1:8765)...
start "Backend" cmd /k "cd /d %PROJECT_DIR% && python live_dub_server.py"

REM Wait for backend
timeout /t 3 /nobreak >nul

REM Start frontend
echo [2/2] Starting frontend (http://localhost:8000)...
start "Frontend" cmd /k "cd /d %WEB_APP_DIR% && python -m http.server 8000"

REM Wait a bit
timeout /t 2 /nobreak >nul

echo.
echo ===============================================
echo [SUCCESS] Services started!
echo ===============================================
echo.
echo Frontend:  http://localhost:8000
echo Backend:   http://127.0.0.1:8765
echo.
echo Opening browser...
echo.

REM Open browser
start http://localhost:8000

echo Usage:
echo   1. Paste YouTube URL
echo   2. Click "Get Subtitles"
echo   3. Select language and voice
echo   4. Click "Generate Narration"
echo   5. Play or download
echo.
echo See: web_app/README.md for details
echo.

pause
