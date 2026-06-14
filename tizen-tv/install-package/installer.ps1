#Requires -Version 5.0
# installer.ps1 — PIPSILY TV — Installateur Samsung Smart TV
# Usage : lancé automatiquement par INSTALLER.bat

param([string]$BaseDir = $PSScriptRoot)
$ErrorActionPreference = "Stop"
$Host.UI.RawUI.WindowTitle = "PIPSILY TV — Installateur Samsung"

# ─── Couleurs ────────────────────────────────────────────────────────────────
function Write-Step   { param($n,$t) Write-Host "  [$n] $t" -ForegroundColor Cyan }
function Write-OK     { param($t)    Write-Host "  ✓  $t" -ForegroundColor Green }
function Write-Warn   { param($t)    Write-Host "  ⚠  $t" -ForegroundColor Yellow }
function Write-Err    { param($t)    Write-Host "  ✗  $t" -ForegroundColor Red }
function Write-Info   { param($t)    Write-Host "     $t" -ForegroundColor Gray }
function Write-Line   { Write-Host ("  " + "─" * 56) -ForegroundColor DarkGray }
function Write-Banner {
  Clear-Host
  Write-Host ""
  Write-Host "  ╔══════════════════════════════════════════════════════╗" -ForegroundColor Cyan
  Write-Host "  ║        PIPSILY TV — Installateur Samsung TV          ║" -ForegroundColor Cyan
  Write-Host "  ╚══════════════════════════════════════════════════════╝" -ForegroundColor Cyan
  Write-Host ""
}

Write-Banner

# ─── Chemins ─────────────────────────────────────────────────────────────────
$SdbExe    = Join-Path $BaseDir "sdb\sdb.exe"
$SignerExe = Join-Path $BaseDir "sign_wgt.exe"
$WgtSrc    = Join-Path $BaseDir "PIPSILY-TV.wgt"
$WgtSigned = Join-Path $BaseDir "PIPSILY-TV-signed.wgt"
$AppId     = "com.morpheus45.pipsily"

# ─── ÉTAPE 0 : Vérification des fichiers ─────────────────────────────────────
Write-Step "0" "Vérification des fichiers..."

if (-not (Test-Path $SdbExe)) {
  Write-Err "sdb.exe introuvable : $SdbExe"
  Write-Info "Le dossier sdb\ doit être présent à côté de INSTALLER.bat"
  Read-Host "`n  Appuyer sur Entrée pour quitter" | Out-Null
  exit 1
}
Write-OK "sdb.exe trouvé"

if (-not (Test-Path $SignerExe)) {
  Write-Err "sign_wgt.exe introuvable : $SignerExe"
  Read-Host "`n  Appuyer sur Entrée pour quitter" | Out-Null
  exit 1
}
Write-OK "sign_wgt.exe trouvé"

if (-not (Test-Path $WgtSrc)) {
  Write-Err "Package introuvable : PIPSILY-TV.wgt"
  Read-Host "`n  Appuyer sur Entrée pour quitter" | Out-Null
  exit 1
}
Write-OK "PIPSILY-TV.wgt trouvé"

Write-Host ""
Write-Line

# ─── ÉTAPE 1 : DUID de la TV ─────────────────────────────────────────────────
Write-Host ""
Write-Host "  ┌─ ÉTAPE 1 : DUID de ta TV Samsung ─────────────────────────┐" -ForegroundColor Yellow
Write-Host "  │                                                             │" -ForegroundColor DarkGray
Write-Host "  │  Sur la TV, va dans :                                       │" -ForegroundColor White
Write-Host "  │    Paramètres  →  Support  →  À propos de ce TV            │" -ForegroundColor White
Write-Host "  │                                                             │" -ForegroundColor DarkGray
Write-Host "  │  Clique 5 fois sur le numéro de modèle                     │" -ForegroundColor White
Write-Host "  │  → Un dialogue Mode développeur s'ouvre                    │" -ForegroundColor White
Write-Host "  │  → Le DUID est affiché dans ce dialogue                    │" -ForegroundColor White
Write-Host "  │    Exemple : 1ABCD1234567EF0                                │" -ForegroundColor Cyan
Write-Host "  │                                                             │" -ForegroundColor DarkGray
Write-Host "  └─────────────────────────────────────────────────────────────┘" -ForegroundColor Yellow
Write-Host ""

$tvDuid = ""
while ($true) {
  $tvDuid = (Read-Host "  Entre le DUID de la TV").Trim()
  if ($tvDuid -match '^[A-Za-z0-9\-]{8,64}$') { break }
  Write-Warn "DUID invalide. Lettres, chiffres et tirets uniquement. Exemple : 1ABCD1234567EF0"
}

Write-Host ""
Write-Line

# ─── ÉTAPE 2 : Signature du package avec le DUID ─────────────────────────────
Write-Banner
Write-Host "  ┌─ ÉTAPE 2 : Signature du package pour ta TV ───────────────┐" -ForegroundColor Yellow
Write-Host "  └─────────────────────────────────────────────────────────────┘" -ForegroundColor Yellow
Write-Host ""
Write-Step "1" "Signature avec DUID : $tvDuid"
Write-Info "Génération du certificat personnalisé..."
Write-Host ""

$ErrorActionPreference = "Continue"
$signOut = & $SignerExe --duid $tvDuid --input $WgtSrc --output $WgtSigned 2>&1 | Out-String
$ErrorActionPreference = "Stop"

if ($LASTEXITCODE -ne 0 -or -not (Test-Path $WgtSigned)) {
  Write-Err "Signature échouée."
  Write-Info $signOut
  Read-Host "`n  Entrée pour quitter" | Out-Null
  exit 1
}

$wgtSize = [Math]::Round((Get-Item $WgtSigned).Length / 1KB)
Write-OK "Package signé ($wgtSize Ko)"

Write-Host ""
Write-Line

# ─── ÉTAPE 3 : Guide mode développeur ────────────────────────────────────────
Write-Banner
Write-Host "  ┌─ ÉTAPE 3 : Mode développeur sur ta TV Samsung ────────────┐" -ForegroundColor Yellow
Write-Host "  │                                                             │" -ForegroundColor DarkGray
Write-Host "  │  (si pas encore fait depuis l'étape 1)                     │" -ForegroundColor Gray
Write-Host "  │                                                             │" -ForegroundColor DarkGray
Write-Host "  │  1. Clique 5 fois sur le numéro de modèle (cf étape 1)    │" -ForegroundColor White
Write-Host "  │  2. Mode développeur → Activé (ON)                         │" -ForegroundColor White
Write-Host "  │  3. Entre l'adresse IP de CE PC dans 'Host PC IP'          │" -ForegroundColor White
Write-Host "  │  4. Redémarre la TV                                         │" -ForegroundColor White
Write-Host "  │                                                             │" -ForegroundColor DarkGray
Write-Host "  └─────────────────────────────────────────────────────────────┘" -ForegroundColor Yellow
Write-Host ""

# Afficher l'IP locale du PC
Write-Host "  IP de CE PC :" -ForegroundColor Cyan -NoNewline
try {
  $localIps = (Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.*" }
  ).IPAddress
  if ($localIps) {
    $localIps | ForEach-Object { Write-Host "  $_" -ForegroundColor Green }
  } else { Write-Host "  (voir Paramètres Windows → Wi-Fi → Propriétés)" -ForegroundColor Yellow }
} catch { Write-Host "  (non détectée)" -ForegroundColor Yellow }

Write-Host ""
Write-Host "  ┌─ COMMENT TROUVER L'IP DE LA TV ────────────────────────────┐" -ForegroundColor DarkGray
Write-Host "  │  TV : Paramètres → Général → Réseau → État du réseau       │" -ForegroundColor Gray
Write-Host "  │       → Informations IP                                     │" -ForegroundColor Gray
Write-Host "  └─────────────────────────────────────────────────────────────┘" -ForegroundColor DarkGray
Write-Host ""
Read-Host "  → Appuyer sur Entrée quand le mode développeur est activé et la TV redémarrée" | Out-Null

# ─── ÉTAPE 4 : Saisie IP TV + connexion ──────────────────────────────────────
Write-Banner
Write-Host "  ┌─ ÉTAPE 4 : Connexion à la TV ──────────────────────────────┐" -ForegroundColor Yellow
Write-Host "  └─────────────────────────────────────────────────────────────┘" -ForegroundColor Yellow
Write-Host ""

$tvIp = ""
while ($true) {
  $tvIp = (Read-Host "  Entre l'adresse IP de ta TV Samsung (ex: 192.168.1.50)").Trim()
  if ($tvIp -match '^\d{1,3}(\.\d{1,3}){3}$') { break }
  Write-Warn "Adresse IP invalide. Format attendu : 192.168.1.XXX"
}

Write-Host ""
Write-Step "2" "Connexion à la TV ($tvIp)..."
Write-Host ""

$ErrorActionPreference = "Continue"
$connectOut = & $SdbExe connect $tvIp 2>&1 | Out-String
Write-Info $connectOut.Trim()

$devices = & $SdbExe devices 2>&1 | Out-String
if ($devices -match $tvIp -or $devices -match "device") {
  Write-OK "TV connectée !"
} else {
  Write-Host ""
  Write-Warn "Connexion difficile. Vérifie que :"
  Write-Info "  - La TV est en mode développeur (étape 3)"
  Write-Info "  - L'IP de CE PC est bien entrée dans 'Host PC IP' sur la TV"
  Write-Info "  - TV et PC sont sur le même réseau Wi-Fi"
  Write-Info "  - La TV a bien redémarré après activation du mode dev"
  Write-Host ""
  $retry = Read-Host "  Réessayer ? (O/n)"
  if ($retry -eq "n" -or $retry -eq "N") { exit 1 }

  Write-Step "2" "Nouvelle tentative..."
  & $SdbExe disconnect $tvIp 2>&1 | Out-Null
  Start-Sleep 2
  & $SdbExe connect $tvIp 2>&1 | Out-Null
}

Write-Host ""
Write-Line

# ─── ÉTAPE 5 : Installation ───────────────────────────────────────────────────
Write-Host ""
Write-Host "  ┌─ ÉTAPE 5 : Installation de PIPSILY TV ─────────────────────┐" -ForegroundColor Yellow
Write-Host "  └─────────────────────────────────────────────────────────────┘" -ForegroundColor Yellow
Write-Host ""
Write-Step "3" "Installation du package sur la TV..."
Write-Info "Cela peut prendre 30 à 60 secondes..."
Write-Host ""

$installOut = & $SdbExe install $WgtSigned 2>&1 | Out-String
Write-Info $installOut.Trim()

$installOk = ($installOut -match "successful|installed|success") -or ($LASTEXITCODE -eq 0 -and $installOut -notmatch "closed|failed|error")

if ($installOk) {
  Write-OK "Installation réussie !"
} else {
  $appCheck = & $SdbExe shell 0 applist 2>&1 | Out-String
  if ($appCheck -match $AppId) {
    Write-OK "Application présente sur la TV !"
  } else {
    Write-Host ""
    Write-Err "Installation échouée."
    Write-Host ""

    if ($installOut -match "closed") {
      Write-Host "  CAUSE : La TV a fermé la connexion." -ForegroundColor Red
      Write-Host ""
      Write-Host "  SOLUTIONS A ESSAYER :" -ForegroundColor Yellow
      Write-Info "  1. Verifier que le DUID entré ($tvDuid) correspond"
      Write-Info "     exactement au DUID affiché sur la TV"
      Write-Info "  2. Desactiver le mode developpeur, le reactiver"
      Write-Info "     et bien entrer l'IP de CE PC dans 'Host PC IP'"
      Write-Info "  3. Laisser la TV demarrer 30 secondes apres le reboot"
      Write-Info "  4. Relancer cet installateur"
    } elseif ($installOut -match "certificate|signature") {
      Write-Host "  CAUSE : Certificat invalide." -ForegroundColor Red
      Write-Info "  → Verifier que le DUID est correct et relancer"
    } else {
      Write-Info "Sortie sdb : $installOut"
    }

    Read-Host "`n  Entree pour quitter" | Out-Null
    exit 1
  }
}

Write-Host ""
Write-Line

# ─── ÉTAPE 6 : Lancement ──────────────────────────────────────────────────────
Write-Host ""
Write-Step "4" "Lancement de PIPSILY TV..."
& $SdbExe shell 0 execute $AppId 2>&1 | Out-Null

Write-Host ""
Write-Host "  ╔══════════════════════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "  ║                                                          ║" -ForegroundColor Green
Write-Host "  ║   ✓  PIPSILY TV est installé et lancé !                 ║" -ForegroundColor Green
Write-Host "  ║                                                          ║" -ForegroundColor Green
Write-Host "  ║   L'app vérifiera les mises à jour automatiquement       ║" -ForegroundColor Green
Write-Host "  ║   à chaque lancement — rien d'autre à faire.            ║" -ForegroundColor Green
Write-Host "  ║                                                          ║" -ForegroundColor Green
Write-Host "  ╚══════════════════════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""
Write-Info "Tu peux fermer cette fenêtre."
Write-Host ""
Read-Host "  Entrée pour quitter" | Out-Null
