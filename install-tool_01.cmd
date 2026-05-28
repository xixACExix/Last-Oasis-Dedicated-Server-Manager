@echo off
setlocal
cd /d "%~dp0"
title Tool_01 Dedicated Installer
color 0E

echo.
echo ===============================================================
echo                TOOL_01 DEDICATED INSTALLER
echo ===============================================================
echo   Auto-detects Last Oasis paths, installs local runtime tools,
echo   writes a clean config, and prepares desktop shortcuts.
echo.

if exist "%~dp0NativeApp\Tool01.Native.exe" (
  echo Starting the setup window...
  start "" "%~dp0NativeApp\Tool01.Native.exe" --install
  exit /b 0
)

if exist "%~dp0DedicatedManager\Last Oasis Dedicated Server Tool.exe" (
  echo Starting the setup window...
  start "" "%~dp0DedicatedManager\Last Oasis Dedicated Server Tool.exe" --install
  exit /b 0
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File "%~dp0scripts\install-control-center.ps1"
set "INSTALL_EXIT=%errorlevel%"
echo.
if not "%INSTALL_EXIT%"=="0" (
  echo Installer failed.
  echo.
  pause
  exit /b %INSTALL_EXIT%
)

echo Installer finished successfully.
echo.
pause
exit /b 0
