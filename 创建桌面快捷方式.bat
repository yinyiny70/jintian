@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto nonode
node "tools\make-shortcut.js"
echo.
echo (press any key to close this window)
pause >nul
exit /b 0

:nonode
echo.
echo [X] Node.js was not found on this computer.
echo     Please tell Codex before going further.
echo.
pause
exit /b 1
