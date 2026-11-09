@echo off
setlocal
rem dsh-memewiki: open the local wiki manager page (127.0.0.1 only)
rem Pass extra flags through, e.g.:  open-wiki.cmd --port 4000 --no-open
cd /d "%~dp0.."
node --no-warnings scripts\wiki-server.mjs %*
if errorlevel 1 (
  echo.
  echo The wiki server stopped with an error. Read the message above.
  pause
)
