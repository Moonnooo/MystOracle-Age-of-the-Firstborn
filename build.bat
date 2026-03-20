@echo off
REM ===============================
REM MystOracle: Age of the Firstborn BOM-Safe Build
REM ===============================

SETLOCAL ENABLEDELAYEDEXPANSION

REM --- Change to script folder ---
cd /d "%~dp0"

REM --- Log file ---
set LOGFILE=build.log
echo =============================== > %LOGFILE%
echo Build started at %DATE% %TIME% >> %LOGFILE%
echo =============================== >> %LOGFILE%
echo. >> %LOGFILE%

REM --- Remove BOM from ALL JSON files recursively ---
echo Removing BOMs from all JSON files...
echo Removing BOMs from all JSON files... >> %LOGFILE%
node -e "const fs=require('fs'); const path=require('path'); function walk(dir){fs.readdirSync(dir).forEach(f=>{const fp=path.join(dir,f);if(fs.statSync(fp).isDirectory()){walk(fp);} else if(f.endsWith('.json')){let d=fs.readFileSync(fp,'utf8'); if(d.charCodeAt(0)===0xFEFF){fs.writeFileSync(fp,d.slice(1),'utf8'); console.log('Removed BOM: '+fp);}}});} walk(process.cwd());"
echo BOM removal complete.
echo BOM removal complete. >> %LOGFILE%
echo.

REM --- Auto-increment patch version safely ---
echo Updating game version...
echo Updating game version... >> %LOGFILE%
node -e "const fs=require('fs'); const f='package.json'; let d=fs.readFileSync(f,'utf8'); let o=JSON.parse(d); let p=o.version.split('.'); p[2]=parseInt(p[2])+1; o.version=p.join('.'); fs.writeFileSync(f, JSON.stringify(o,null,2),'utf8'); console.log(o.version);" > tempver.txt
set /p newver=<tempver.txt
del tempver.txt
echo Version updated to !newver!
echo Version updated to !newver! >> %LOGFILE%
echo.

REM --- Build Vite production bundle ---
echo Building Vite production bundle...
echo Building Vite production bundle... >> %LOGFILE%
npx vite build >> %LOGFILE% 2>&1
IF %ERRORLEVEL% NEQ 0 (
    echo Vite build FAILED! Check %LOGFILE% for details.
    pause
    exit /b %ERRORLEVEL%
)
echo Vite build completed successfully.
echo Vite build completed successfully. >> %LOGFILE%
echo.

REM --- Launch Electron ---
echo Starting MystOracle: Age of the Firstborn...
echo Starting MystOracle: Age of the Firstborn... >> %LOGFILE%
npx electron . >> %LOGFILE% 2>&1
IF %ERRORLEVEL% NEQ 0 (
    echo Electron FAILED! Check %LOGFILE% for details.
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo Build and launch completed successfully!
echo See %LOGFILE% for full output.
pause
