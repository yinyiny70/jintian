@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo 正在运行全部测试...
echo.
node tests\run.js
echo.
echo 测试结束。按任意键关闭这个窗口。
pause >nul
