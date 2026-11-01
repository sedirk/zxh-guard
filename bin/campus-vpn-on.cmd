@echo off
chcp 65001 >nul
title 校内 VPN - 启动
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0campus-vpn.ps1" -Action start
echo.
echo 本窗口 10 秒后自动关闭（VPN 会继续在后台运行，用“校内VPN-关闭”停止）。
timeout /t 10 >nul