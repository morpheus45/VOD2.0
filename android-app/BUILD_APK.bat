@echo off
chcp 65001 > nul
echo.
echo ╔═══════════════════════════════════════════════════╗
echo ║         PIPSILY — Compilation APK Android         ║
echo ╚═══════════════════════════════════════════════════╝
echo.

:: Vérifier Java
where java > nul 2>&1
if errorlevel 1 (
    echo [ERREUR] Java n'est pas dans le PATH.
    echo Installez Java 17 : https://adoptium.net/
    pause & exit /b 1
)

:: Keystore de signature — même clé que toutes les versions précédentes
:: pipsily.keystore = sauvegarde de ~/.android/debug.keystore du PC de build
set KEYSTORE=%~dp0pipsily.keystore
set KS_ALIAS=androiddebugkey
set KS_PASS=android
set KS_KEY_PASS=android
set OUT_APK=app\build\outputs\apk\debug\app-debug.apk

if not exist "%KEYSTORE%" (
    echo [INFO] pipsily.keystore absent — utilisation de la debug keystore systeme
    set KEYSTORE=%USERPROFILE%\.android\debug.keystore
)

if not exist "%KEYSTORE%" (
    echo [ERREUR] Aucune keystore trouvee.
    echo Copiez ~/.android/debug.keystore vers android-app\pipsily.keystore
    pause & exit /b 1
)

echo [INFO] Keystore : %KEYSTORE%
echo [BUILD] Compilation assembleDebug...
echo.

call gradlew.bat assembleDebug --no-daemon

if errorlevel 1 (
    echo.
    echo [ERREUR] La compilation a echoue.
    pause & exit /b 1
)

:: Copier et renommer l'APK
copy "%OUT_APK%" "PIPSILY.apk" > nul
echo.
echo ╔═══════════════════════════════════════════════════╗
echo ║  OK  APK genere : android-app\PIPSILY.apk         ║
echo ╚═══════════════════════════════════════════════════╝
echo.
echo Prochaines etapes :
echo   1. git add . et git commit -m "apk: vXX"
echo   2. gh release create vXX android-app/PIPSILY.apk#PIPSILY.apk
echo   3. Mettre a jour version.json : apk_version + apk_url
echo   4. git push origin main
echo.
echo IMPORTANT : Conserver pipsily.keystore dans ce dossier.
echo             Meme cle pour toutes les versions = mises a jour auto.
echo.
pause
