@echo off
cd /d "%~dp0"

echo Starting Vite dev server...
start "" cmd /k "npx vite"

REM Wait for dev server to start
echo Waiting for Vite to be ready...
:waitloop
curl -s http://localhost:5173/ >nul 2>&1
IF %ERRORLEVEL% NEQ 0 (
    timeout /t 1 >nul
    goto waitloop
)

REM Launch Electron
echo Vite ready! Launching Electron...
npx electron .
pause
