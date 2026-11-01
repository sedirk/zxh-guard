@echo off
rem Start the NUAA campus VPN tray (no window).
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0nuaa-vpn-tray.ps1"
