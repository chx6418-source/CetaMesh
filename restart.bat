@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Stopping old guard windows...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='cmd.exe'\" | Where-Object { $_.CommandLine -like '*%~dp0start.bat*' -and $_.CommandLine -notlike '*restart.bat*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
echo Stopping old bridge processes...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*%~dp0src\bridge.js*' -and $_.CommandLine -notlike '*mcp-*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
timeout /t 2 /nobreak 1>nul
del state\bridge.lock 2>nul
echo Relaunching bridge silently (no window will appear)...
start "" /b cmd /c call "%~dp0start.bat" --open
exit /b 0
