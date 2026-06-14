@echo off
chcp 65001 > nul
title PIPSILY — Configuration Supabase

echo.
echo  ╔═══════════════════════════════════════════╗
echo  ║   PIPSILY — Configuration automatique     ║
echo  ║   Double-cliquez pour configurer Supabase  ║
echo  ╚═══════════════════════════════════════════╝
echo.

:: Vérifier Python
python --version > nul 2>&1
if errorlevel 1 (
    echo  [ERREUR] Python n'est pas installé.
    echo  Téléchargez Python sur https://python.org
    pause
    exit /b 1
)

:: Lancer le script de configuration
python "%~dp0setup-supabase.py"

if errorlevel 1 (
    echo.
    echo  Une erreur s'est produite. Consultez les messages ci-dessus.
    pause
)
