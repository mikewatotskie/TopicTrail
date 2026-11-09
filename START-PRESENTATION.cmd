@echo off
powershell.exe -NoProfile -File "%~dp0scripts\start-presentation.ps1"
if errorlevel 1 pause
