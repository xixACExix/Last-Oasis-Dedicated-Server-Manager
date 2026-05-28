@echo off
setlocal
cd /d "%~dp0"
title Stop Last Oasis Control Center
color 0C

echo.
echo ===============================================================
echo              STOP LAST OASIS CONTROL CENTER
echo ===============================================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-control-center.ps1"

echo.
pause
