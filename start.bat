@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem BRIDGE_ARGS 仅首次启动携带（--open 由启动/重启入口传入）；守护循环内的自动重启不重复唤起浏览器
set "BRIDGE_ARGS=%*"
:loop
node "%~dp0src\bridge.js" %BRIDGE_ARGS%
set code=%errorlevel%
if "%code%"=="2" exit /b 2
echo [%date% %time%] bridge exited (code %code%), restarting in 5 seconds...
timeout /t 5 /nobreak >nul
set "BRIDGE_ARGS="
goto loop
