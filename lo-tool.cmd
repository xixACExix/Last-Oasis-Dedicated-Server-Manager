@echo off
setlocal
cd /d "%~dp0"
title Last Oasis Control Center Launcher
color 0E

echo.
echo ===============================================================
echo             LAST OASIS CONTROL CENTER LAUNCHER
echo ===============================================================
echo   Local realm launcher, recovery panel, and live monitor
echo.

set "NPM_CMD=%~dp0tools\node\npm.cmd"
set "PORTABLE_NODE_ROOT=%~dp0tools\node"
set "SERVER_ENTRY=%~dp0dist\server\index.js"
if exist "%SERVER_ENTRY%" (
  powershell -NoProfile -Command "try { $response = Invoke-WebRequest -UseBasicParsing 'http://localhost:4020/api/state' -TimeoutSec 2; if ($response.StatusCode -eq 200) { exit 0 } } catch {}; exit 1"
  if %errorlevel%==0 (
    echo Control center is already running at http://localhost:4020
  ) else (
    start "" /min powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-control-center.ps1"
    echo Starting control center in the background...
  )
  echo Launcher monitor stays open so you can see server and event actions live.
  echo.
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\launcher-monitor.ps1" -ApiUrl "http://localhost:4020/api/monitor" -BrowserUrl "http://localhost:4020"
  exit /b %errorlevel%
)

if not exist "%NPM_CMD%" (
  for /f "delims=" %%I in ('where npm.cmd 2^>nul') do (
    set "NPM_CMD=%%~fI"
    goto npm_resolved
  )
  if not exist "%NPM_CMD%" (
    echo No npm runtime was found.
    echo Run install-tool_01.cmd first so the control center can install its portable Node runtime.
    echo.
    pause
    exit /b 1
  )
)
:npm_resolved

if exist "%PORTABLE_NODE_ROOT%\node.exe" (
  set "PATH=%PORTABLE_NODE_ROOT%;%PATH%"
)

if not exist "node_modules" (
  echo Installing dependencies...
  call "%NPM_CMD%" install
  if errorlevel 1 exit /b %errorlevel%
)

echo Building Last Oasis Control Center...
call "%NPM_CMD%" run build
if errorlevel 1 exit /b %errorlevel%

powershell -NoProfile -Command "try { $response = Invoke-WebRequest -UseBasicParsing 'http://localhost:4020/api/state' -TimeoutSec 2; if ($response.StatusCode -eq 200) { exit 0 } } catch {}; exit 1"
if %errorlevel%==0 (
  echo Control center is already running at http://localhost:4020
) else (
  start "" /min powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-control-center.ps1"
  echo Starting control center in the background...
)

echo Launcher monitor stays open so you can see server and event actions live.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\launcher-monitor.ps1" -ApiUrl "http://localhost:4020/api/monitor" -BrowserUrl "http://localhost:4020"
exit /b %errorlevel%
