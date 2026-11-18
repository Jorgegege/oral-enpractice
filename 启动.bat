@echo off
chcp 65001 >nul
cd /d %~dp0

echo Installing/updating dependencies...
call npm install

echo Starting server... open http://localhost:3000 in your browser.
start "" http://localhost:3000
node app.js

echo.
echo Server stopped. Close this window or press any key to exit.
pause
