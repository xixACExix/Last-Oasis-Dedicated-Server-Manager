@echo off
setlocal
cd /d "%~dp0"
title Tool_01 Package Builder
color 0E

echo.
echo ===============================================================
echo                 TOOL_01 PACKAGE BUILDER
echo ===============================================================
echo   Builds a clean dedicated-server package without live configs,
echo   browser-session captures, or other local machine secrets.
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build-dedicated-package.ps1"
set "PACKAGE_EXIT=%errorlevel%"
echo.
if not "%PACKAGE_EXIT%"=="0" (
  echo Package build failed.
  echo.
  pause
  exit /b %PACKAGE_EXIT%
)

echo Package build finished successfully.
echo.
pause
exit /b 0
