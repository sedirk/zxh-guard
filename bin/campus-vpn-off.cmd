@echo off
chcp 65001 >nul
title 校内 VPN - 关闭
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0campus-vpn.ps1" -Action stop
echo.
timeout /t 6 >nul