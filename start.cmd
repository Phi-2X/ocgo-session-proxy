@echo off
rem Start the OpenCode Go session proxy. Extra arguments are passed through,
rem for example:  start.cmd --port 9000
setlocal
node "%~dp0proxy.mjs" --port 8787 %*
