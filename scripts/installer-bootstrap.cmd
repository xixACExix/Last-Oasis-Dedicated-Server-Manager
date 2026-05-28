@echo off
setlocal
cd /d "%~dp0"
title Tool_01 Single-File Installer
powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File "%~dp0installer-bootstrap.ps1"
exit /b %errorlevel%
