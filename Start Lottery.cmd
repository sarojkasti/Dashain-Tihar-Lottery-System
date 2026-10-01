@echo off
cd /d "%~dp0"
echo Open http://localhost:3010 in your browser after the server starts.
call npm.cmd start
pause
