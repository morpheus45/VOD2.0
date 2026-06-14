# build.ps1 — PIPSILY TV — Prépare le dossier tizen-tv/ pour Tizen Studio
# Lance depuis le dossier tizen-tv/ : .\build.ps1
# Ou depuis VOD-push/ : .\tizen-tv\build.ps1

$ErrorActionPreference = "Stop"

$scriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$sourceDir  = Split-Path -Parent $scriptDir   # VOD-push/
$targetDir  = $scriptDir                       # tizen-tv/

Write-Host ""
Write-Host "═══════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  PIPSILY TV — Build Tizen" -ForegroundColor Cyan
Write-Host "═══════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""
Write-Host "Source : $sourceDir" -ForegroundColor Gray
Write-Host "Cible  : $targetDir" -ForegroundColor Gray
Write-Host ""

# ─── Fichiers individuels à copier ───────────────────────────────────────────
$files = @(
  "app.js",
  "auth.js",
  "player.js",
  "styles.css",
  "player.css",
  "logo.svg",
  "manifest.webmanifest",
  "version.json",
  "login.html",
  "account.html",
  "admin.html",
  "player.html",
  "apple.html"
  # index.html exclu → on utilise tizen-tv/index.html
  # sw.js exclu → Service Worker incompatible avec Tizen packagé
)

$copied = 0
$totalBytes = 0

foreach($f in $files){
  $src = Join-Path $sourceDir $f
  $dst = Join-Path $targetDir $f
  if(Test-Path $src){
    Copy-Item -Path $src -Destination $dst -Force
    $size = (Get-Item $src).Length
    $totalBytes += $size
    $copied++
    Write-Host "  ✓ $f ($([Math]::Round($size/1KB, 1)) Ko)" -ForegroundColor Green
  } else {
    Write-Host "  ⚠ $f introuvable (ignoré)" -ForegroundColor Yellow
  }
}

# ─── Dossiers à copier ───────────────────────────────────────────────────────
$dirs = @("icons")

foreach($d in $dirs){
  $src = Join-Path $sourceDir $d
  $dst = Join-Path $targetDir $d
  if(Test-Path $src){
    if(Test-Path $dst){ Remove-Item -Recurse -Force $dst }
    Copy-Item -Path $src -Destination $dst -Recurse -Force
    $dirSize = (Get-ChildItem $src -Recurse | Measure-Object -Property Length -Sum).Sum
    $totalBytes += $dirSize
    $count = (Get-ChildItem $src -Recurse -File).Count
    $copied += $count
    Write-Host "  ✓ $d/ ($count fichiers, $([Math]::Round($dirSize/1KB, 1)) Ko)" -ForegroundColor Green
  } else {
    Write-Host "  ⚠ Dossier $d/ introuvable (ignoré)" -ForegroundColor Yellow
  }
}

Write-Host ""
Write-Host "─────────────────────────────────────────────────────" -ForegroundColor DarkGray
Write-Host "  $copied fichiers copiés — Total : $([Math]::Round($totalBytes/1MB, 2)) Mo" -ForegroundColor White
Write-Host ""

# ─── Vérification Tizen CLI ──────────────────────────────────────────────────
$tizenCli = Get-Command "tizen" -ErrorAction SilentlyContinue

if($tizenCli){
  Write-Host "Tizen CLI détecté : $($tizenCli.Source)" -ForegroundColor Cyan
  Write-Host ""
  $choice = Read-Host "Lancer le build automatique (tizen build-web + package) ? [O/n]"
  if($choice -ne "n" -and $choice -ne "N"){
    Write-Host ""
    Write-Host "Build en cours..." -ForegroundColor Cyan
    Set-Location $targetDir
    & tizen build-web -- .
    if($LASTEXITCODE -eq 0){
      Write-Host "Package en cours..." -ForegroundColor Cyan
      & tizen package -t wgt -s default -- .build
      if($LASTEXITCODE -eq 0){
        $wgt = Get-ChildItem -Path (Join-Path $targetDir ".build") -Filter "*.wgt" | Select-Object -First 1
        if($wgt){
          Write-Host ""
          Write-Host "  ✅ Package créé : $($wgt.FullName)" -ForegroundColor Green
          Write-Host "  Taille : $([Math]::Round($wgt.Length/1MB, 2)) Mo" -ForegroundColor Green
        }
      }
    }
  }
} else {
  Write-Host "Tizen CLI non trouvé dans le PATH." -ForegroundColor Yellow
  Write-Host ""
  Write-Host "  ┌─ Instructions build manuel ──────────────────────────────┐" -ForegroundColor DarkGray
  Write-Host "  │  1. Ouvrir Tizen Studio                                   │" -ForegroundColor DarkGray
  Write-Host "  │  2. File → Import → Tizen → Tizen Project                 │" -ForegroundColor DarkGray
  Write-Host "  │  3. Sélectionner ce dossier : $targetDir" -ForegroundColor DarkGray
  Write-Host "  │  4. Clic droit projet → Build Signed Package              │" -ForegroundColor DarkGray
  Write-Host "  │  5. Le .wgt se trouve dans result/                        │" -ForegroundColor DarkGray
  Write-Host "  └───────────────────────────────────────────────────────────┘" -ForegroundColor DarkGray
  Write-Host ""
  Write-Host "  Tizen Studio : https://developer.samsung.com/smarttv/develop/getting-started/setting-up-sdk/installing-tv-sdk.html" -ForegroundColor Cyan
}

Write-Host ""
Write-Host "═══════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  Build terminé." -ForegroundColor Cyan
Write-Host "═══════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""
