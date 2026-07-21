@echo off
rem  Brief Tracker - double-click to run the local server and open the dashboard.
cd /d "%~dp0"

rem  Use node from PATH if available, otherwise the default install location.
set "NODE=node"
where node >nul 2>nul || set "NODE=C:\Program Files\nodejs\node.exe"

echo.
echo   Brief Tracker is starting at  http://localhost:5178
echo   Keep this window open while you use the dashboard. Close it to stop.
echo.

rem  Open the browser (a beat after, so the server is up), then run the server.
start "" cmd /c "timeout /t 2 >nul & start "" http://localhost:5178"
%NODE% server.mjs

echo.
echo   Server stopped.
pause
