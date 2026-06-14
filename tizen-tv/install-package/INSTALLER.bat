@echo off
color 0B
cls

echo.
echo  =========================================================
echo        PIPSILY TV  --  Installation Samsung TV
echo  =========================================================
echo.

powershell -Command "exit 0" >nul 2>&1
if errorlevel 1 (
  echo  [ERREUR] PowerShell requis. Mise a jour Windows necessaire.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer.ps1" "%~dp0"
pause
