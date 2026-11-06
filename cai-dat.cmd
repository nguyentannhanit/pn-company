@echo off
rem P&N — chay script PowerShell kem theo, bo qua chinh sach chan script.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install\install.ps1" %*
pause
