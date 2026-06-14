# PIPSILY — Handoff document

> Généré le **2026-05-31** — pour reprendre le projet sans contexte

---

## 🎯 C'est quoi

Application IPTV PWA + APK Android + Samsung TV.  
- **URL live** : https://morpheus45.github.io/VOD/  
- **Repo** : `C:\Users\cedri\OneDrive\Desktop\VOD-push` → GitHub `morpheus45/VOD` branche `main`  
- **Documentation complète** : voir `PIPSILY.md` dans ce même dossier

---

## ⚠️ RÈGLE ABSOLUE

> **Ne jamais toucher à `tizen-tv/`** — projet Android TV/Samsung séparé.  
> Ne modifier QUE les fichiers à la racine du repo.

---

## 🗂️ Fichiers clés

| Fichier | Rôle |
|---------|------|
| `app.js` | Logique principale (~4 400 lignes) |
| `auth.js` | Supabase Auth + sessions + appareils |
| `styles.css` | CSS global |
| `sw.js` | Service Worker (bumper CACHE à chaque déploiement) |
| `admin.html` | Panel admin (comptes, plans, paiements) |
| `login.html` | Inscription / connexion |
| `version.json` | Versions APK (25) et Tizen (1) |
| `PIPSILY.md` | Documentation technique complète |

---

## 🔑 Accès & identifiants

| Service | Info |
|---------|------|
| Supabase URL | `https://gwmuazostbbgroplnlql.supabase.co` |
| Supabase Anon Key | dans `auth.js` ligne 12 |
| Admin email | `cedric.lago@gmail.com` |
| Wero (paiements) | `0622461624` — PIPSILY |
| PayPal Solo | `https://paypal.me/pipsily/42` |
| PayPal Multi | `https://paypal.me/pipsily/53` |

---

## 📦 État actuel (2026-05-31)

| Élément | Version |
|---------|---------|
| SW Cache | `pipsily-v207` |
| APK | v25 |
| Tizen | v1 |
| Catalogue VOD | 18 649 films |
| Catalogue Séries | 5 288 (11 catégories) |
| Catalogue Live | 1 263 chaînes |

---

## ✅ Ce qui a été fait dans cette session

### Bugs corrigés (dans l'ordre)
1. **Focus TV** — `_restoreTvFocus()` appelé à tous les points de sortie de `onAndroidPlayerClosed`
2. **`document.body` comme `_lastFocus`** — condition `f && f !== document.body && f.isConnected`
3. **`pf_local_apk_ver` prématuré** — supprimé du onclick download APK
4. **`e.preventDefault()` manquant APK banner** — ajouté pour les flèches D-pad
5. **Poursuivre après PIN** — `renderPoursuivreRow()` ajouté après `renderGrid(true)`
6. **`DATABASE ERROR` inscription** — trigger Supabase reécrit exception-safe
7. **Email confirmation 404** — `emailRedirectTo` ajouté dans `admin.html createAccount()`
8. **Bannière APK à chaque démarrage** — bouton "Plus tard (7 jours)" + Back = 7j suppression
9. **MacGyver disparaissait de Poursuivre** — `onerror` image cachait toute la carte (→ `this.style.display='none'`)
10. **Filtre adulte trop large** — `xxx` au milieu d'une catégorie n'est plus adulte (seulement début ou fin)
11. **Vidéos mobiles (mixed content)** — `_openOverlay` fallback pour HTTP sur HTTPS
12. **Login messages génériques** — routing erreurs Supabase spécifiques
13. **Pills qualité obstruées sur mobile** — masquées sur mobile (`display:none <700px`)

### Nouvelles fonctionnalités
- **Son de navigation D-pad** — tick Web Audio API 720→360 Hz, 70ms
- **`_openOverlay(item)`** — méthode PipPlayer pour lecture HLS.js directe
- **PIPSILY.md** — documentation technique complète (18 sections)
- **HANDOFF.md** — ce fichier

---

## 🚨 Action Supabase OBLIGATOIRE (si pas encore fait)

Le trigger de création de profil doit être appliqué dans Supabase.  
**SQL Editor** → https://supabase.com/dashboard/project/gwmuazostbbgroplnlql/sql/new

```sql
-- Trigger exception-safe (fix DATABASE ERROR à l'inscription)
create or replace function handle_new_user()
returns trigger language plpgsql security definer
set search_path = public as $$
begin
  insert into public.profiles (id, email, plan)
  values (new.id, new.email,
    case when new.email = 'cedric.lago@gmail.com' then 'admin' else 'pending' end)
  on conflict (id) do nothing;
  return new;
exception when others then
  raise warning 'handle_new_user error: %', sqlerrm;
  return new;
end; $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
for each row execute procedure handle_new_user();
```

**URL Configuration** → https://supabase.com/dashboard/project/gwmuazostbbgroplnlql/auth/url-configuration
```
Site URL    : https://morpheus45.github.io/VOD/login.html
Redirect URL: https://morpheus45.github.io/VOD/login.html
```

---

## 🔧 Workflow déploiement

```bash
# 1. Modifier les fichiers
# 2. Bumper le cache SW
# sw.js ligne 2 : const CACHE = "pipsily-vXXX";  ← incrémenter

# 3. Vérifier la syntaxe
node --check app.js

# 4. Committer et pousser
git add fichier1 fichier2 sw.js
git commit -m "fix: description courte"
git push origin main
# → GitHub Pages déploie en ~30 secondes
```

---

## 📋 Tâches en suspens

- [ ] **Compte `david-mike@hotmail.fr`** — créer via `admin.html` (plan Illimité) une fois le trigger SQL appliqué
- [ ] **Vidéos PC** — les streams HTTP ne peuvent pas jouer dans un navigateur HTTPS (mixed content). Le bouton "⎘ Copier le lien" est la solution pour VLC. Une vraie solution nécessiterait un proxy HTTPS côté serveur.
- [ ] **APK v26** — pas prévu pour l'instant. Quand prêt : créer release GitHub v26, uploader PIPSILY.apk, mettre à jour `version.json`

---

## 🧠 Points d'architecture importants

### Filtre contenu adulte
```js
// Dans app.js — _isAdultCat
// "xxx" filtre uniquement en DÉBUT ou FIN de category_name
// "SÉRIES | XXX | ACTION" → PAS adulte (xxx au milieu = code fournisseur)
// "XXX Films" ou "Films XXX" → adulte
```

### Lecteur vidéo — ordre de priorité
```
1. AndroidBridge (APK) → ExoPlayer natif
2. iOS → AVPlayer natif
3. Mixed content HTTP/HTTPS → _openOverlay (HLS.js)
4. Navigateur standard → _openOverlay (HLS.js)
```

### Service Worker — JSON toujours réseau
```js
// sw.js : JSON et M3U → network-first (jamais depuis le cache)
// Garantit que le catalogue est toujours frais
```

### Poursuivre — pourquoi un favori peut disparaître
1. Image cassée → `onerror` cachait la carte (CORRIGÉ)
2. Mauvais onglet → série visible seulement sur l'onglet Séries
3. Catégorie adulte → `_hideXXXItem` masque même avec PIN
4. Progression > 97% → item considéré terminé

---

## 📁 Structure localStorage (clés importantes)

```
pipsily_progress     → {"type||id||title": {t, d, pct, ts}}
pipsily_favorites    → [{key, item, at}]
pipsily_adult_pin    → "1234" (PIN parental)
pf_local_apk_ver     → 25 (version APK installée)
pf_apk_sv4           → 25 (version suppress bannière)
pf_apk_su4           → 1234567890 (expire timestamp)
```

---

*HANDOFF généré le 2026-05-31 — Session Claude Sonnet 4.6*
