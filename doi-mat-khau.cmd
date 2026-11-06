@echo off
rem P&N — dat lai mat khau dang nhap dashboard cho mot tai khoan (go tai cho, khong luu).
cd /d "%~dp0"
node --env-file=.env tools\dat-lai-mat-khau.mjs
pause
