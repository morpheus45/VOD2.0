#!/bin/bash
# PIPSILY TV — Installateur Samsung Smart TV (macOS)
# Double-cliquer pour lancer depuis le Finder

# Aller dans le dossier du script (nécessaire pour les chemins relatifs)
cd "$(dirname "$0")"

# Couleurs terminal
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; WHITE='\033[1;37m'; GRAY='\033[0;37m'; NC='\033[0m'

SDB="$(pwd)/sdb/sdb"
WGT="$(pwd)/PIPSILY-TV-signed.wgt"
APP_ID="com.morpheus45.pipsily"

clear
echo ""
echo -e "${CYAN}  ╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}  ║        PIPSILY TV — Installateur Samsung TV          ║${NC}"
echo -e "${CYAN}  ╚══════════════════════════════════════════════════════╝${NC}"
echo ""

# ── Vérifications ─────────────────────────────────────────────────────────────
echo -e "${CYAN}  [0] Vérification des fichiers...${NC}"

if [ ! -f "$SDB" ]; then
  echo -e "${RED}  ✗  sdb introuvable : $SDB${NC}"
  echo "     Vérifier que le dossier sdb/ est présent"
  read -p "  Entrée pour quitter..." ; exit 1
fi

# Supprimer la quarantaine macOS et rendre exécutable
xattr -d com.apple.quarantine "$SDB" 2>/dev/null || true
chmod +x "$SDB"
echo -e "${GREEN}  ✓  sdb prêt${NC}"

if [ ! -f "$WGT" ]; then
  echo -e "${RED}  ✗  PIPSILY-TV-signed.wgt introuvable${NC}"
  read -p "  Entrée pour quitter..." ; exit 1
fi
WGT_SIZE=$(du -k "$WGT" | cut -f1)
echo -e "${GREEN}  ✓  PIPSILY-TV-signed.wgt trouvé (${WGT_SIZE} Ko)${NC}"

echo ""
echo "  ────────────────────────────────────────────────────────"

# ── Guide mode développeur ────────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}  ┌─ ÉTAPE 1 : Mode développeur sur ta TV Samsung ─────────┐${NC}"
echo -e "${YELLOW}  │                                                          │${NC}"
echo    "  │  1. Télécommande → Accueil → Paramètres (⚙)             │"
echo    "  │  2. Support → À propos de ce TV                          │"
echo    "  │  3. Clique 5 fois sur le NUMÉRO DE MODÈLE               │"
echo    "  │  4. Mode développeur → ON                                │"
echo    "  │  5. Entre l'adresse IP de CE Mac (voir ci-dessous)       │"
echo    "  │  6. Confirmer → Redémarrer la TV                         │"
echo -e "${YELLOW}  └──────────────────────────────────────────────────────────┘${NC}"
echo ""

# Afficher l'IP locale du Mac
echo -e "${CYAN}  IP de CE Mac :${NC}"
ifconfig | grep "inet " | grep -v "127.0.0.1" | awk '{print "    " $2}' | head -5
echo ""

echo -e "${GRAY}  Trouver l'IP de la TV :${NC}"
echo    "  TV → Paramètres → Général → Réseau → État du réseau → Informations IP"
echo ""

read -p "  → Appuyer sur Entrée quand le mode développeur est activé et la TV redémarrée : "

# ── Saisie IP TV ───────────────────────────────────────────────────────────────
clear
echo ""
echo -e "${CYAN}  ╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}  ║        PIPSILY TV — Installateur Samsung TV          ║${NC}"
echo -e "${CYAN}  ╚══════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${YELLOW}  ┌─ ÉTAPE 2 : Connexion à la TV ───────────────────────────┐${NC}"
echo -e "${YELLOW}  └──────────────────────────────────────────────────────────┘${NC}"
echo ""

while true; do
  read -p "  Adresse IP de ta TV Samsung (ex: 192.168.1.50) : " TV_IP
  if [[ "$TV_IP" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]]; then
    break
  fi
  echo -e "${YELLOW}  ⚠  Format invalide — exemple : 192.168.1.50${NC}"
done

echo ""
echo -e "${CYAN}  [1] Connexion à $TV_IP...${NC}"
echo -e "${GRAY}  Assure-toi que la TV et ce Mac sont sur le même Wi-Fi${NC}"
echo ""

"$SDB" connect "$TV_IP" 2>&1 | sed 's/^/     /'

DEVICES=$("$SDB" devices 2>&1)
if echo "$DEVICES" | grep -q "device"; then
  echo -e "${GREEN}  ✓  TV connectée !${NC}"
else
  echo ""
  echo -e "${YELLOW}  ⚠  Connexion difficile. Vérifier que :${NC}"
  echo    "     - Mode développeur activé et TV redémarrée"
  echo    "     - IP du Mac correctement saisie sur la TV"
  echo    "     - TV et Mac sur le même réseau Wi-Fi"
  echo ""
  read -p "  Réessayer ? (o/n) : " RETRY
  if [[ "$RETRY" == "n" || "$RETRY" == "N" ]]; then exit 1; fi
  "$SDB" disconnect "$TV_IP" 2>/dev/null
  sleep 2
  "$SDB" connect "$TV_IP" 2>&1 | sed 's/^/     /'
fi

echo ""
echo "  ────────────────────────────────────────────────────────"

# ── Installation ──────────────────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}  ┌─ ÉTAPE 3 : Installation de PIPSILY TV ──────────────────┐${NC}"
echo -e "${YELLOW}  └──────────────────────────────────────────────────────────┘${NC}"
echo ""
echo -e "${CYAN}  [2] Installation du package sur la TV...${NC}"
echo -e "${GRAY}  Cela peut prendre 30 à 60 secondes...${NC}"
echo ""

INSTALL_OUT=$("$SDB" install "$WGT" 2>&1)
echo "$INSTALL_OUT" | sed 's/^/     /'

if echo "$INSTALL_OUT" | grep -qi "successful\|installed\|success" || [ $? -eq 0 ]; then
  echo -e "${GREEN}  ✓  Installation réussie !${NC}"
else
  APP_CHECK=$("$SDB" shell 0 applist 2>&1)
  if echo "$APP_CHECK" | grep -q "$APP_ID"; then
    echo -e "${GREEN}  ✓  Application présente sur la TV !${NC}"
  else
    echo -e "${RED}  ✗  Installation échouée.${NC}"
    echo    "     Si l'erreur mentionne 'signature' ou 'certificate' :"
    echo    "     → Redémarre la TV en mode développeur et relance ce script"
    read -p "  Entrée pour quitter : " ; exit 1
  fi
fi

echo ""
echo -e "${CYAN}  [3] Lancement de PIPSILY TV...${NC}"
"$SDB" shell 0 execute "$APP_ID" 2>&1 | sed 's/^/     /'

echo ""
echo -e "${GREEN}  ╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}  ║                                                      ║${NC}"
echo -e "${GREEN}  ║   ✓  PIPSILY TV est installé et lancé !             ║${NC}"
echo -e "${GREEN}  ║                                                      ║${NC}"
echo -e "${GREEN}  ║   L'app se met à jour automatiquement à chaque       ║${NC}"
echo -e "${GREEN}  ║   lancement — rien d'autre à faire.                 ║${NC}"
echo -e "${GREEN}  ║                                                      ║${NC}"
echo -e "${GREEN}  ╚══════════════════════════════════════════════════════╝${NC}"
echo ""
read -p "  Entrée pour fermer... "
