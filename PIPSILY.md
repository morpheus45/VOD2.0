# PIPSILY — Documentation technique complète

> Version app : **6.9** · APK : **v25** · SW cache : **pipsily-v206** · Date : 2026-05-31

---

## Table des matières

1. [Vue d'ensemble](#1-vue-densemble)
2. [Architecture](#2-architecture)
3. [Structure des fichiers](#3-structure-des-fichiers)
4. [Sources de données](#4-sources-de-données)
5. [Authentification & abonnements](#5-authentification--abonnements)
6. [Lecteur vidéo — PipPlayer](#6-lecteur-vidéo--pipplayer)
7. [Navigation TV (D-pad)](#7-navigation-tv-d-pad)
8. [Section Poursuivre](#8-section-poursuivre)
9. [Contrôle parental (PIN adulte)](#9-contrôle-parental-pin-adulte)
10. [Mise à jour APK](#10-mise-à-jour-apk)
11. [Service Worker & cache](#11-service-worker--cache)
12. [Clés de stockage local](#12-clés-de-stockage-local)
13. [AndroidBridge — API Java↔JS](#13-androidbridge--api-javajs)
14. [Plateformes supportées](#14-plateformes-supportées)
15. [Samsung TV (Tizen)](#15-samsung-tv-tizen)
16. [Administration](#16-administration)
17. [Déploiement](#17-déploiement)
18. [Bugs corrigés — historique](#18-bugs-corrigés--historique)

---

## 1. Vue d'ensemble

**PIPSILY** est une application IPTV PWA (Progressive Web App) permettant de regarder Films, Séries et TV en direct via un flux Xtream Codes.

| Élément | Valeur |
|---------|--------|
| URL production | `https://morpheus45.github.io/VOD/` |
| Repo GitHub | `morpheus45/VOD` |
| Branche déployée | `main` |
| APK Android | v25 — `PIPSILY.apk` |
| Tizen Samsung TV | v1 — `PIPSILY-TV-signed.wgt` |
| Supabase projet | `gwmuazostbbgroplnlql` |
| Admin email | `cedric.lago@gmail.com` |

### Catalogue (mai 2026)
| Type | Titres | Catégories |
|------|--------|------------|
| Films (VOD) | 18 649 | 30 |
| Séries | 5 288 | 11 |
| TV Live | 1 263 | — |

---

## 2. Architecture

```
┌─────────────────────────────────────────────────┐
│  GitHub Pages (HTTPS)                           │
│  index.html + app.js + styles.css               │
│  ├── Service Worker (sw.js)  — cache shell      │
│  ├── auth.js  ────────────────── Supabase Auth  │
│  ├── vod.json / series.json / live.json         │
│  └── episodes_map.json + episodes_partN.json    │
└──────────────┬──────────────────────────────────┘
               │ HTTPS
┌──────────────▼──────────────────────────────────┐
│  Supabase (PostgreSQL + Auth)                   │
│  Tables : profiles · devices · sessions ·      │
│           payments                              │
└─────────────────────────────────────────────────┘

Clients :
  • Navigateur PC/Mac     → PWA, HLS.js overlay
  • Mobile Android (APK)  → WebView + AndroidBridge
  • Mobile iOS/Safari     → AVPlayer natif
  • Android TV / TV APK   → ExoPlayer via bridge
  • Samsung TV (Tizen)    → tizen-tv/ (projet séparé)
```

### Flux de données
```
IPTV Xtream API (HTTP) → push-script Python → JSON static → GitHub Pages
                                                            → série.json
                                                            → vod.json
                                                            → live.json
                                                            → episodes_*.json
```

---

## 3. Structure des fichiers

```
VOD-push/
├── index.html          — App principale (shell HTML)
├── login.html          — Connexion / inscription
├── account.html        — Profil utilisateur & appareils
├── admin.html          — Panel admin (plans, comptes, paiements)
├── player.html         — Lecteur standalone (legacy)
├── install.html        — Guide installation 7 plateformes
├── vitrine.html        — Page marketing
├── merci.html          — Page post-paiement
├── samsung-tv.html     — Guide installation Tizen
│
├── app.js              — Logique principale (~4400 lignes)
├── auth.js             — Auth Supabase + sessions + appareils
├── player.js           — Lecteur standalone (legacy)
│
├── styles.css          — CSS global (v103)
├── player.css          — CSS lecteur standalone
│
├── sw.js               — Service Worker (cache pipsily-v206)
├── manifest.webmanifest
│
├── vod.json            — 18 649 films
├── series.json         — 5 288 séries
├── live.json           — 1 263 chaînes TV
├── version.json        — Versions APK/Tizen + changelog
├── episodes_map.json   — Index séries → chunks
├── episodes_part0.json — Épisodes chunk 0
├── episodes_index.json — Index global épisodes
│
├── logo.svg
├── icons/              — icon-192, icon-512, splashs iOS
└── tizen-tv/           — ⚠️ PROJET SÉPARÉ — NE PAS MODIFIER
    ├── dist/
    └── build/
```

> ⚠️ **RÈGLE ABSOLUE** : ne jamais modifier `tizen-tv/` depuis ce repo.  
> C'est un projet Android TV/Samsung distinct.

---

## 4. Sources de données

### Format JSON (utilisé en prod)
```json
{
  "meta": { "generated": "2026-05-28T..." },
  "categories": [{ "category_id": "1337", "category_name": "FR - DRAME" }],
  "items": [{
    "id": 34310,
    "series_id": 34310,
    "title": "MacGyver",
    "category_name": "FR - DRAME",
    "category_id": "1337",
    "stream_icon": "https://...",
    "plot": "...",
    "stream_url": "http://server/player_api.php?...",
    "added": 0
  }]
}
```

### Catégories séries (11)
`FR - ACTION`, `FR - ANIME`, `FR - ASIATIQUE`, `FR - COMÉDIE`, `FR - DOCUMENTAIRE`, `FR - DRAME`, `FR - ENFANTS`, `FR - LATEST SERIES`, `FR - NETFLIX`, `FR - SCI-FICTION`, `FR - TELE REALITE`

### Normalisation (`normalizeItems`)
Chaque item reçoit les champs normalisés :
```js
{
  id, stream_id, title, category_name, category_id,
  stream_icon, stream_url, url, plot, type,
  quality,   // "4K"|"HD"|"SD"|"Autres"|""
  added,     // timestamp Unix
  _xtream,   // bool — série avec API Xtream
  episodes, seasons  // pour séries
}
```

---

## 5. Authentification & abonnements

### Supabase Auth
- Signup avec confirmation email (`emailRedirectTo: https://morpheus45.github.io/VOD/login.html`)
- Signin avec `signInWithPassword`
- Session persistée dans localStorage (`pipsily_auth`)

### Plans
| Plan | Appareils max | Sessions simultanées | Expiration |
|------|---------------|----------------------|------------|
| `pending` | 0 | 0 | — |
| `active` | 1 | 1 | Date fixe |
| `unlimited` | 3 | 4 | Aucune |
| `admin` | ∞ | ∞ | Aucune |

### Tables Supabase
```sql
profiles  (id, email, plan, subscription_expires_at, devices_allowed, parental_pin)
devices   (id, user_id, device_id, device_name, monthly_fee, last_seen)
sessions  (id, user_id, device_id, device_name, token, last_seen)
payments  (id, user_id, amount, type, period_start, period_end, confirmed_at, notes)
```

### Trigger auto-création profil (exception-safe)
```sql
create or replace function handle_new_user()
returns trigger language plpgsql security definer
set search_path = public as $$
begin
  insert into public.profiles(id, email, plan)
  values(new.id, new.email,
    case when new.email = 'cedric.lago@gmail.com' then 'admin' else 'pending' end)
  on conflict(id) do nothing;
  return new;
exception when others then
  raise warning 'handle_new_user error: %', sqlerrm;
  return new;
end; $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
for each row execute procedure handle_new_user();
```

### RLS (Row Level Security)
```sql
-- Lecture/écriture profil propre
create policy "own profile" on profiles for all using (auth.uid() = id);
-- Admin lit tout
create policy "admin all" on profiles for all
  using ((select plan from profiles where id = auth.uid()) = 'admin');
-- Idem pour devices, sessions, payments
```

### Heartbeat sessions
- Intervalle : toutes les 5 minutes
- Purge automatique des sessions > 24h sans activité
- `startSessionWatcher(userId)` lancé au démarrage

---

## 6. Lecteur vidéo — PipPlayer

### Modes de lecture selon la plateforme
```
PipPlayer.open(item)
  ├── AndroidBridge disponible → ExoPlayer natif (AndroidBridge.openPlayer)
  ├── iOS/iPadOS               → AVPlayer (_openAVPlayer)
  │     ├── HTTP sur HTTPS      → _openOverlay (fallback mixed content)
  │     └── Timeout 3s          → _openOverlay (si fullscreen échoue)
  ├── Mixed content HTTP/HTTPS  → _openOverlay direct
  └── Navigateur standard       → _openOverlay (HLS.js ou video natif)
```

### `_openOverlay(item)`
Ouvre le panneau `#pip-player` avec HLS.js :
```js
_openOverlay(item){
  // Ouvre le panel, met à jour titre/sub/plot
  // Appelle _loadVideo(item)
}
```

### `_loadVideo(item)`
```
url = secureUrl(preparePlutoUrl(item.url))  // HTTP→HTTPS
isHLS = /.m3u8/i ou type==="live"

Si isHLS + Hls.isSupported() → HLS.js
  └── MANIFEST_PARSED → play + sélection piste FR
  └── ERROR fatal     → video.src direct → onerror → _openNativeFallback
Si isHLS + Safari natif → video.src direct
Sinon                   → video.src direct
onerror → _openNativeFallback (window.open sur PC, VLC sur Android)
```

### Mixed content (HTTP streams sur HTTPS page)
`secureUrl()` convertit HTTP→HTTPS avant chargement. Si le serveur IPTV ne supporte pas HTTPS, la lecture échouera et ouvrira dans un onglet. Utiliser le bouton **⎘ Copier le lien** pour VLC.

### Contrôles du lecteur
| Bouton | Action |
|--------|--------|
| `← Retour` | Ferme le lecteur |
| `⛶ Plein écran` | Fullscreen |
| `⎘ Copier le lien` | Copie l'URL originale |
| `▶ Lecture native` | `window.open` ou AndroidBridge |
| `♡ / ♥ Favoris` | Toggle favori |
| `⏮ Épisode précédent` | Navigation série |
| `Épisode suivant ⏭` | Navigation série |

### Progression sauvegardée
- Sauvegarde toutes les 5s dans localStorage (`pipsily_progress`)
- Clé : `type||id||title` pour VOD, `seriesId||SxxExx` pour épisodes
- Reprise au bon timestamp au prochain lancement

---

## 7. Navigation TV (D-pad)

### Modes de navigation
| Mode | Contexte | Activé par |
|------|----------|------------|
| `_navGrid` | Grille principale | Défaut |
| `_navNetflix` | Rangées Netflix | Mode Netflix actif |
| `_navPanel` | Panneau série | Ouverture panel |

### Son de navigation
```js
function _playNavClick(){
  // Web Audio API : oscillateur 720Hz → 360Hz en 55ms, gain 0.18 → 0
  // Durée totale : 70ms
}
```
Appelé à chaque touche directionnelle (ArrowUp/Down/Left/Right).

### Raccourcis clavier TV
| Touche | Action |
|--------|--------|
| Flèches | Navigation D-pad |
| Enter | Sélectionner |
| Escape/GoBack/Back | Retour/fermeture |
| n / N / ChannelUp | Épisode suivant |
| ArrowRight (lecteur) | +10s |
| ArrowLeft (lecteur) | -10s |

### Restauration focus après lecteur
`_restoreTvFocus()` — appelé à TOUS les points de sortie de `onAndroidPlayerClosed` :
- Cas early return (posMs < 30000)
- Cas fin normale (pct > 0.97)
- Cas épisode (epKey trouvé)
- Cas VOD normal

---

## 8. Section Poursuivre

Affiche en haut de page les contenus **en cours** + **favoris** de l'onglet actif.

### Logique de filtrage
```js
// Masquer le contenu adulte (inchangeable par PIN)
const _hideXXXItem = item => _isAdultCat(item?.category_name);

// Adulte = keywords OU xxx en début OU xxx en fin de category_name
const _isAdultCat = c => {
  if(!c) return false;
  if(/adult|adulte|\+18|18\+|erot|for adult/i.test(c)) return true;
  if(_startsXXX(c)) return true;       // "XXX Films", "🔞 XXX Séries"
  if(/\bxxx\s*$/i.test(c)) return true; // "Films XXX"
  return false;
};

// xxx en début (après emojis/symboles) — exception pour "xXx" (film d'action)
const _startsXXX = c => {
  const clean = c.replace(/^[\s\p{Emoji}...]+/u, "").trim();
  if(clean.startsWith("xXx")) return false;
  return /^xxx/i.test(clean);
};
```

> **Important :** "xxx" en MILIEU de catégorie (ex: `"SÉRIES | XXX | ACTION"`) n'est PAS considéré adulte — évite les faux positifs des fournisseurs IPTV.

### Ordre d'affichage
1. **En cours** : items avec 3% < progression < 97%, triés par `ts` desc
2. **Favoris** : items ❤️ non déjà en cours, mêmes type que l'onglet actif

### Pourquoi un favori peut disparaître
- **Image cassée** : `onerror` masquait toute la carte → corrigé, maintenant seule l'image est masquée
- **Mauvais onglet** : un favori série n'apparaît que sur l'onglet Séries
- **Progression > 97%** : item considéré terminé, masqué de "en cours"

---

## 9. Contrôle parental (PIN adulte)

### Fonctionnement
1. Le contenu adulte est détecté par `_isAdultCat(category_name)`
2. Sans PIN défini : pill 🔞 invisible
3. Avec PIN défini : pill 🔞 visible, clic demande le PIN
4. PIN validé : `sessionStorage.setItem("pipsily_adult_unlocked","1")` → session uniquement

### Stockage
- `localStorage.pipsily_adult_pin` — PIN haché (4-6 chiffres)
- `sessionStorage.pipsily_adult_unlocked` — déverrouillé pour la session

### API
```js
getParentalPin(userId)    // lecture depuis profiles.parental_pin
setParentalPin(userId, pin) // écriture
promptParentalPin(storedPin) // dialog overlay, retourne Promise<bool>
```

### Le PIN ne bypass pas Poursuivre
Même avec `pipsily_adult_unlocked = "1"`, le contenu adulte reste masqué dans la section Poursuivre/Favoris.

---

## 10. Mise à jour APK

### `checkApkUpdate()` — Flux
```
version.json → remoteVer (int)
AndroidBridge.getApkVersion() → localVer
  └── fallback : localStorage.pf_local_apk_ver
Si !localVer → fail-safe, pas de bannière
Si remoteVer > localVer :
  Vérifier suppression :
    pf_apk_sv4 >= remoteVer ET Date.now() < pf_apk_su4 → supprimé
  Sinon → showApkUpdateBanner()
```

### Bannière de mise à jour
- Modal plein écran avec bouton **⬇ Mettre à jour** et **Plus tard (7 jours)**
- Touche Back/GoBack → ferme avec suppression 7 jours
- Clic "Mettre à jour" → `AndroidBridge.downloadAndInstall(url)` → suppression 7 jours
- `pf_local_apk_ver` mis à jour UNIQUEMENT par `getApkVersion()` (bridge), jamais par le clic

### version.json
```json
{
  "apk_version": 25,
  "apk_url": "https://github.com/morpheus45/VOD/releases/download/v25/PIPSILY.apk",
  "changes": "...",
  "tizen_version": 1,
  "tizen_url": "https://github.com/morpheus45/VOD/releases/download/tv-v1/PIPSILY-TV-signed.wgt"
}
```

---

## 11. Service Worker & cache

### Stratégie
| Ressource | Stratégie |
|-----------|-----------|
| `.json` / `.m3u` | Network-first (toujours frais) |
| Assets (CSS, JS, images) | Cache-first + update background |
| Navigation (`index.html`) | Cache fallback si offline |

### Versioning
- Cache name : `pipsily-vXXX` (actuellement `pipsily-v206`)
- À chaque modification de `sw.js` : incrémenter le numéro
- Install : vide **tous** les anciens caches + met en cache le shell
- Activate : `clients.claim()` + envoie `RELOAD` à toutes les fenêtres

### Shell mis en cache
```
./ index.html login.html account.html admin.html player.html
install.html vitrine.html merci.html samsung-tv.html
styles.css?v=103 player.css app.js?v=166 auth.js player.js?v=51
manifest.webmanifest logo.svg icons/icon-192.png icons/icon-512.png
version.json + splashs iOS (7 tailles)
```

### Mise à jour forcée (bouton "Mettre à jour")
- **PWA** : vide le cache SW + reload avec `?nocache=timestamp`
- **APK** : active le SW en attente via `SKIP_WAITING` → RELOAD

---

## 12. Clés de stockage local

### localStorage
| Clé | Type | Description |
|-----|------|-------------|
| `pipsily_device_id` | UUID | Identifiant appareil unique |
| `pipsily_session_token` | string | Token session actif |
| `pipsily_progress` | JSON | Progression films/séries |
| `pipsily_favorites` | JSON | Favoris `{key, item, at}[]` |
| `pipsily_history` | JSON | Historique lecture |
| `pipsily_adult_pin` | string | PIN parental |
| `pf_local_apk_ver` | int | Version APK installée (bridge) |
| `pf_apk_sv4` | int | Version APK suppress update banner |
| `pf_apk_su4` | timestamp | Expire suppress update banner (7j) |
| `pf_apk_install_dismiss` | timestamp | Supprime bannière install APK |
| `pf_apk_install_dismiss_ver` | int | Version affichée à l'install banner |

### sessionStorage
| Clé | Valeur | Description |
|-----|--------|-------------|
| `pipsily_adult_unlocked` | `"1"` | Session adulte déverrouillée |

### STORE (clés internes)
```js
const STORE = {
  progress  : "pipsily_progress",
  favorites : "pipsily_favorites",
  history   : "pipsily_history",
};
```

---

## 13. AndroidBridge — API Java↔JS

Toutes les méthodes sont appelées depuis `window.AndroidBridge`.

| Méthode | Paramètres | Description |
|---------|------------|-------------|
| `openPlayer(url, title, sub, epsJson, epIdx)` | string × 4 + int | Lance ExoPlayer |
| `openPlayerAt(url, title, sub, epsJson, epIdx, posMs)` | + int ms | Lance à position |
| `openInVlc(url, title, loop)` | string × 2, bool | Ouvre dans VLC |
| `getApkVersion()` | — | Retourne version int (ex: 25) |
| `downloadAndInstall(url)` | string | Télécharge + installe APK |
| `openDownloadUrl(url)` | string | Ouvre URL de téléchargement |
| `clearCache()` | — | Vide le cache WebView |
| `fetchJson(url)` | string | Fetch HTTP depuis Java (bypass CORS) |

### Callback JS depuis Java
```js
window.onAndroidPlayerClosed(url, posMs, durMs)
// Appelé par Java quand ExoPlayer se ferme
// Sauvegarde la progression + restore focus D-pad
```

---

## 14. Plateformes supportées

| Plateforme | Lecteur | Remarques |
|------------|---------|-----------|
| Chrome/Edge PC | HLS.js overlay | Mixed content HTTP → lien à copier |
| Safari Mac | HLS natif | |
| Android APK | ExoPlayer + WebView | `window.AndroidBridge` disponible |
| Android navigateur | HLS.js overlay | Mixed content → overlay |
| iOS Safari | AVPlayer natif | `webkitEnterFullscreen` |
| iOS PWA (écran d'accueil) | AVPlayer natif | |
| iOS Chrome/Firefox | AVPlayer natif | Tous les browsers iOS = WebKit |
| Android TV APK | ExoPlayer | `PIPSILY_NATIVE = "android_tv"` |
| Samsung TV Tizen | Tizen player | Projet séparé (`tizen-tv/`) |

---

## 15. Samsung TV (Tizen)

> **PROJET COMPLÈTEMENT SÉPARÉ** — dossier `tizen-tv/`  
> Ne jamais modifier depuis ce repo principal.

- Package : `PIPSILY-TV-signed.wgt`
- Version : 1
- URL release : `https://github.com/morpheus45/VOD/releases/download/tv-v1/PIPSILY-TV-signed.wgt`
- Installation : guide sur `samsung-tv.html`

---

## 16. Administration

### Accès
URL : `admin.html` — accessible uniquement si `plan === "admin"` ou email = `cedric.lago@gmail.com`.

### Fonctionnalités
| Action | Description |
|--------|-------------|
| Créer un compte | `auth.signUp` + upsert profil |
| Solo 42€/an | `plan=active`, 365j, 1 appareil |
| Multi 53€/an | `plan=active`, 365j, 3 appareils |
| ∞ Illimité | `plan=unlimited`, sans expiration |
| +30 jours | Prolonge l'abonnement actif |
| Test 7j | Accès temporaire |
| Bloquer | `plan=pending` |
| Supprimer | Supprime profil + devices + sessions + payments |
| Confirmer paiement Wero | Marque confirmé + active 30j |

### Statistiques affichées
CA annuel / CA mensuel estimé / Connectés (15 min) / Actifs / Expirés / En attente

### SQL utiles
```sql
-- Mettre un compte en illimité
update profiles set plan='unlimited', devices_allowed=999,
  subscription_expires_at=null where email='user@example.com';

-- Voir les comptes actifs
select email, plan, subscription_expires_at, devices_allowed
from profiles order by created_at desc;
```

---

## 17. Déploiement

### Workflow standard
```bash
# 1. Modifier les fichiers
# 2. Bumper CACHE dans sw.js (pipsily-vXXX)
# 3. Vérifier la syntaxe
node --check app.js

# 4. Committer et pousser
git add -p
git commit -m "fix: description"
git push origin main
# GitHub Pages déploie automatiquement en ~30s
```

### Bumper la version SW
Modifier `sw.js` ligne 2 : `const CACHE = "pipsily-vXXX";`  
Incrémenter à chaque déploiement modifiant les assets.

### Mettre à jour les données catalogue
Les fichiers JSON (`vod.json`, `series.json`, `live.json`, `episodes_*.json`) sont générés par un script Python externe et poussés dans le repo.

### Déployer une nouvelle version APK
1. Compiler l'APK Android
2. Créer une release GitHub avec tag `vXX`
3. Uploader `PIPSILY.apk` dans les assets de la release
4. Mettre à jour `version.json` :
   ```json
   { "apk_version": 26, "apk_url": "https://github.com/.../v26/PIPSILY.apk", "changes": "..." }
   ```
5. `git push origin main` → les APK déjà installés verront la bannière de mise à jour

### Supabase — Configuration URL (obligatoire)
```
Authentication → URL Configuration
  Site URL    : https://morpheus45.github.io/VOD/login.html
  Redirect URLs : https://morpheus45.github.io/VOD/login.html
```

---

## 18. Bugs corrigés — historique

### Session mai 2026

#### Bug 1 — Focus TV non restauré sur toutes les sorties de `onAndroidPlayerClosed`
- **Problème** : Le `setTimeout` de restauration focus ne s'exécutait pas sur le chemin série (return anticipé) ni les early guards
- **Fix** : Helper `_restoreTvFocus()` appelé à tous les points de sortie

#### Bug 2 — `document.body` comme `_lastFocus` bypassait le fallback
- **Problème** : `body.isConnected = true` mais `body.focus()` = no-op, le querySelector fallback ne s'exécutait pas
- **Fix** : Condition `f && f !== document.body && f.isConnected`

#### Bug 3 — `pf_local_apk_ver` écrit prématurément dans le onclick APK
- **Problème** : La version locale était marquée "à jour" dès le clic download, avant installation
- **Fix** : Suppression de cette ligne. `pf_local_apk_ver` mis à jour uniquement par `getApkVersion()` (bridge)

#### Bug 4 — APK banner : `e.preventDefault()` manquant pour les flèches
- **Problème** : `e.stopPropagation()` seul ne bloquait pas le scroll/navigation D-pad
- **Fix** : Ajout de `e.preventDefault()` dans le else-if du keydown handler

#### Bug 5 — Poursuivre non rafraîchi après déverrouillage PIN adulte
- **Problème** : `renderGrid(true)` appelé mais pas `renderPoursuivreRow()`
- **Fix** : Ajout de `renderPoursuivreRow()` après `renderGrid(true)` dans `showAdultPinPrompt`

#### Bug 6 — `DATABASE ERROR` à l'inscription
- **Problème** : Trigger `handle_new_user()` sans `set search_path = public` + sans exception handler → bloque la création de compte
- **Fix** : Trigger reécrit avec `set search_path`, `on conflict do nothing`, `exception when others then return new`

#### Bug 7 — Email de confirmation → 404
- **Problème** : `admin.html createAccount()` appelait `auth.signUp` sans `emailRedirectTo` → Supabase utilisait l'URL par défaut du projet (incorrecte)
- **Fix** : Ajout de `emailRedirectTo: "https://morpheus45.github.io/VOD/login.html"` dans `createAccount()`

#### Bug 8 — Bannière APK mise à jour à chaque démarrage
- **Problème** : Suppression de 24h seulement, pas de bouton "Plus tard"
- **Fix** : Bouton "Plus tard (7 jours)" + Back ferme avec 7j de suppression

#### Bug 9 — MacGyver disparaissait de Poursuivre (image cassée)
- **Problème** : `onerror` sur l'image remontait 2 niveaux DOM et cachait toute la carte `.nou-card`
- **Fix** : `onerror="this.style.display='none'"` — seule l'image est masquée

#### Bug 10 — Filtre adulte trop large (`_isAdultCat`)
- **Problème** : `/xxx/i` matchait "xxx" partout dans `category_name` (ex: `"SÉRIES | XXX | ACTION"`)
- **Fix** : `_isAdultCat` ne filtre que si xxx est en début OU en fin de catégorie (pas au milieu)

#### Bug 11 — Videos mobiles ne se lancent plus (mixed content)
- **Problème** : Streams HTTP sur page HTTPS → bloqués par le navigateur mobile
- **Fix** : Détection `_isMixedContent` → `_openOverlay` direct (HLS.js)

#### Bug 12 — Login : "E-mail ou mot de passe incorrect" affiché pour tous les cas
- **Problème** : Message générique même pour "email not confirmed" 
- **Fix** : Routing des erreurs Supabase avec messages spécifiques

#### Bug 13 — Pills qualité obstruées sur mobile
- **Problème** : Conteneur trop étroit, ❤️ Favoris coupé à droite
- **Fix** : `margin: 0 -10px; padding: 0 10px` + taille réduite sur mobile

---

*Document généré le 2026-05-31 — PIPSILY v6.9 — APK v25 — SW pipsily-v206*
