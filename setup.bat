@echo off
REM ===============================
REM MystOracle: Age of the Firstborn Initial Setup (BOM-safe)
REM ===============================

SETLOCAL ENABLEDELAYEDEXPANSION

REM Change to script folder
cd /d "%~dp0"

REM Log file
set LOGFILE=setup.log
echo =============================== > %LOGFILE%
echo Setup started at %DATE% %TIME% >> %LOGFILE%
echo =============================== >> %LOGFILE%
echo.

REM --- Install dependencies ---
echo Installing dependencies...
echo Installing dependencies... >> %LOGFILE%
npm install >> %LOGFILE% 2>&1
IF %ERRORLEVEL% NEQ 0 (
    echo npm install FAILED! Check %LOGFILE% for details.
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo Setup completed successfully!
echo See %LOGFILE% for details.
pause
