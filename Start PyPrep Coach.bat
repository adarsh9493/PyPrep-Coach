@echo off
REM ---------------------------------------------------------------------------
REM  PyPrep Coach - double-click this file to start the coach and open it
REM  in your browser. Close the window it opens to stop the server.
REM ---------------------------------------------------------------------------
setlocal
title PyPrep Coach

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch.ps1"

REM If the launcher failed before it could explain itself, keep the window open.
if not "%ERRORLEVEL%"=="0" pause
endlocal
