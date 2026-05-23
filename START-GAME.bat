@echo off
title Ben's Mortal Kombat
color 0A
echo.
echo  Installing dependencies (first run only)...
call npm install --silent 2>nul
echo.
echo  Starting server — browser will open automatically...
echo  Keep this window open while playing!
echo.
node server.js
pause
