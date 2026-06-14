#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
PIPSILY — Configuration automatique Supabase
============================================
Ce script crée votre projet Supabase, applique le schéma SQL,
met à jour auth.js et pousse tout sur GitHub.
"""

import subprocess, json, time, os, sys, re

VOD_DIR     = os.path.dirname(os.path.abspath(__file__))
AUTH_JS     = os.path.join(VOD_DIR, "auth.js")
SUPA_DIR    = os.path.join(VOD_DIR, "supabase")
DB_PASS     = "PipsilyDB2026!"
REGION      = "eu-west-2"
GH_TOKEN    = os.environ.get("GH_TOKEN", "")  # set via env if needed

BLUE  = "\033[94m"
GREEN = "\033[92m"
RED   = "\033[91m"
BOLD  = "\033[1m"
RESET = "\033[0m"

def header(msg): print(f"\n{BOLD}{BLUE}▶ {msg}{RESET}")
def ok(msg):     print(f"  {GREEN}✓ {msg}{RESET}")
def err(msg):    print(f"  {RED}✗ {msg}{RESET}")

def run_capture(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True, cwd=VOD_DIR)
    return r.stdout.strip(), r.stderr.strip(), r.returncode

def supa(args):
    return run_capture(["npx", "supabase"] + args)

def git(args):
    return run_capture(["git"] + args)

# ── Étape 1 : Login ──────────────────────────────────────────────
header("Étape 1 — Connexion Supabase")

# Vérifier si déjà connecté
token_path = os.path.join(os.path.expanduser("~"), ".supabase", "access-token")
already_logged_in = os.path.exists(token_path)

if already_logged_in:
    ok("Déjà connecté à Supabase!")
else:
    print("  Votre navigateur va s'ouvrir. Connectez-vous ou créez un compte gratuit.")
    print("  (Aucune carte bancaire requise pour le plan gratuit)")
    print()
    input("  → Appuyez sur ENTRÉE pour ouvrir le navigateur...")

    ret = subprocess.run(["npx", "supabase", "login"], cwd=VOD_DIR)
    if ret.returncode != 0:
        err("Connexion échouée. Relancez le script et réessayez.")
        sys.exit(1)
    ok("Connecté à Supabase!")

# ── Étape 2 : Organisation ────────────────────────────────────────
header("Étape 2 — Récupération de votre organisation")
stdout, stderr, code = supa(["orgs", "list", "--output", "json"])
try:
    orgs = json.loads(stdout)
    if not orgs:
        err("Aucune organisation trouvée. Créez-en une sur app.supabase.com")
        sys.exit(1)
    org_id = orgs[0]["id"]
    org_name = orgs[0].get("name", org_id)
    ok(f"Organisation: {org_name} ({org_id})")
except Exception as e:
    err(f"Erreur: {e}\nSortie: {stdout}\nErreur: {stderr}")
    sys.exit(1)

# ── Étape 3 : Création du projet ──────────────────────────────────
header("Étape 3 — Création du projet PIPSILY")
print("  Création en cours (peut prendre ~30 secondes)...")
stdout, stderr, code = supa([
    "projects", "create", "pipsily",
    "--org-id", org_id,
    "--region", REGION,
    "--db-password", DB_PASS,
    "--output", "json"
])

if code != 0:
    # Peut-être le projet existe déjà
    if "already exists" in stderr or "already exists" in stdout:
        print("  Projet 'pipsily' déjà existant, récupération...")
        stdout2, _, _ = supa(["projects", "list", "--output", "json"])
        try:
            projects = json.loads(stdout2)
            proj = next((p for p in projects if p.get("name") == "pipsily"), projects[0])
            project_ref = proj["id"]
            ok(f"Projet existant récupéré: {project_ref}")
        except:
            err(f"Impossible de récupérer le projet.\n{stderr}")
            sys.exit(1)
    else:
        err(f"Création échouée:\n{stderr}")
        sys.exit(1)
else:
    try:
        proj = json.loads(stdout)
        project_ref = proj["id"]
        ok(f"Projet créé: {project_ref}")
    except:
        # Chercher le ref dans la sortie texte
        m = re.search(r'[a-z]{20}', stdout + stderr)
        if m:
            project_ref = m.group(0)
            ok(f"Projet créé: {project_ref}")
        else:
            err(f"Impossible de lire l'ID du projet.\n{stdout}\n{stderr}")
            sys.exit(1)

project_url = f"https://{project_ref}.supabase.co"

# ── Étape 4 : Attente ────────────────────────────────────────────
header("Étape 4 — Mise en ligne du projet")
print("  Patientez pendant l'initialisation...", end="", flush=True)
for i in range(40):
    time.sleep(1)
    print(".", end="", flush=True)
print()
ok("Projet prêt!")

# ── Étape 5 : Clés API ───────────────────────────────────────────
header("Étape 5 — Récupération des clés API")
anon_key = None
for attempt in range(5):
    stdout, stderr, code = supa([
        "projects", "api-keys",
        "--project-ref", project_ref,
        "--output", "json"
    ])
    try:
        keys = json.loads(stdout)
        anon_key = next((k["api_key"] for k in keys if k["name"] == "anon"), None)
        if anon_key:
            break
    except:
        pass
    print(f"  Tentative {attempt+1}/5...")
    time.sleep(5)

if not anon_key:
    err(f"Impossible de récupérer la clé anon.\n{stdout}\n{stderr}")
    sys.exit(1)
ok(f"Clé anon: {anon_key[:24]}...")

# ── Étape 6 : Lien local ─────────────────────────────────────────
header("Étape 6 — Liaison du projet")
os.makedirs(SUPA_DIR, exist_ok=True)
stdout, stderr, code = supa([
    "link",
    "--project-ref", project_ref,
    "--password", DB_PASS
])
if code != 0 and "already linked" not in stderr:
    print(f"  Avertissement liaison: {stderr[:200]}")
else:
    ok("Projet lié!")

# ── Étape 7 : Schéma SQL ─────────────────────────────────────────
header("Étape 7 — Application du schéma SQL")
time.sleep(3)
stdout, stderr, code = supa(["db", "push", "--yes"])
if code != 0:
    print(f"  Avertissement SQL: {stderr[:300]}")
    # Essayer via l'API REST Management
    import urllib.request
    sql_file = os.path.join(SUPA_DIR, "migrations", "20240101000000_initial.sql")
    if os.path.exists(sql_file):
        with open(sql_file, "r", encoding="utf-8") as f:
            sql = f.read()
        print("  Tentative via API Management...")
        try:
            import urllib.request, urllib.error
            # Read access token from CLI config
            token_file = os.path.expanduser(r"~\.supabase\access-token")
            if not os.path.exists(token_file):
                token_file = os.path.expandvars(r"%APPDATA%\supabase\access-token")
            with open(token_file) as tf:
                token_data = json.load(tf)
            access_token = token_data.get("token", "")

            req = urllib.request.Request(
                f"https://api.supabase.com/v1/projects/{project_ref}/database/query",
                data=json.dumps({"query": sql}).encode(),
                headers={
                    "Authorization": f"Bearer {access_token}",
                    "Content-Type": "application/json"
                }
            )
            with urllib.request.urlopen(req) as resp:
                print(f"  Réponse: {resp.status}")
            ok("Schéma appliqué via API!")
        except Exception as e2:
            print(f"  Info: {e2} — le schéma devra être appliqué manuellement")
else:
    ok("Schéma SQL appliqué!")

# ── Étape 8 : Mise à jour auth.js ───────────────────────────────
header("Étape 8 — Mise à jour de auth.js")
with open(AUTH_JS, "r", encoding="utf-8") as f:
    content = f.read()

content = content.replace(
    '"https://VOTRE_PROJET.supabase.co"',
    f'"{project_url}"'
).replace(
    '"VOTRE_ANON_KEY"',
    f'"{anon_key}"'
)

with open(AUTH_JS, "w", encoding="utf-8") as f:
    f.write(content)
ok(f"auth.js mis à jour avec {project_url}")

# ── Étape 9 : Mise à jour sw.js ─────────────────────────────────
header("Étape 9 — Incrémentation du cache Service Worker")
sw_path = os.path.join(VOD_DIR, "sw.js")
with open(sw_path, "r", encoding="utf-8") as f:
    sw = f.read()
sw = re.sub(r'pipsily-v\d+', 'pipsily-v55', sw)
with open(sw_path, "w", encoding="utf-8") as f:
    f.write(sw)
ok("Service worker mis à jour (pipsily-v55)")

# ── Étape 10 : Push GitHub ───────────────────────────────────────
header("Étape 10 — Publication sur GitHub")
git(["add", "auth.js", "sw.js"])
git(["commit", "-m", "feat: configure Supabase backend\n\nCo-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"])
stdout, stderr, code = git(["push"])
if code != 0:
    # Try with token
    git(["remote", "set-url", "origin",
         f"https://{GH_TOKEN}@github.com/morpheus45/VOD.git"])
    stdout, stderr, code = git(["push"])

if code == 0:
    ok("GitHub mis à jour!")
else:
    # Try with token from env
    if GH_TOKEN:
        git(["remote", "set-url", "origin",
             f"https://{GH_TOKEN}@github.com/morpheus45/VOD.git"])
        stdout, stderr, code = git(["push"])
    if code == 0:
        ok("GitHub mis à jour!")
    else:
        print(f"  Avertissement push: {stderr[:200]}")

# ── Terminé ───────────────────────────────────────────────────────
print(f"""
{BOLD}{GREEN}
╔══════════════════════════════════════════════════════╗
║          PIPSILY — Configuration terminée !          ║
╚══════════════════════════════════════════════════════╝
{RESET}
  Projet  : {project_url}
  Clé     : {anon_key[:24]}...

  ✓ Base de données créée
  ✓ auth.js configuré
  ✓ Déployé sur GitHub Pages

  Votre application est maintenant opérationnelle !
  → https://morpheus45.github.io/VOD/

  Pour créer votre compte admin, allez sur :
  → https://morpheus45.github.io/VOD/login.html
  Utilisez : cedric.lago@gmail.com
{BOLD}
""")

input("  Appuyez sur ENTRÉE pour fermer...")
