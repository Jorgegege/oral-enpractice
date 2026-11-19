@echo off
chcp 65001 >nul
title 英语口语教练 · 本地预览
echo.
echo  正在启动本地服务器...
echo  启动后请在浏览器打开 http://localhost:4321
echo  按 Ctrl+C 可停止
echo.
node app.js
pause
