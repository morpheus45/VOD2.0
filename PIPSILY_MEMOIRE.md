# PIPSILY — Mémoire Technique Complète

> Dernière mise à jour : 2026-05-26 · Commit stable : `4c644df` · SW cache : `pipsily-v186`

---

## 1. Identité du projet

| Champ | Valeur |
|-------|--------|
| Nom app | **PIPSILY** |
| Repo GitHub | `morpheus45/VOD` |
| GitHub Pages | `https://morpheus45.github.io/VOD/` |
| Dossier local | `C:\Users\cedri\OneDrive\Desktop\VOD-push` |
| Remote git | `https://github.com/morpheus45/VOD.git` |
| Type | PWA (Progressive Web App) + APK Android WebView |

> ⚠️ **NE PAS CONFONDRE** avec `google-tv-perso/` qui est un projet Android TV séparé. Ne jamais y toucher.

---

## 2. Architecture

```
GitHub Pages (PWA)
├── index.html          — page principale (Films/Séries/TV)
├── login.html          — connexion / inscription
├── account.html        — profil utilisateur (abonnement, appareils, région, PIN)
├── admin.html          — panneau admin (gestion abonnés)
├── player.html         — lecteur vidéo dédié
├── install.html        — guide installation 7 plateformes
├── vitrine.html        — page publique / tarifs
├── merci.html          — page post-paiement
├── samsung-tv.html     — guide Samsung TV
├── app.js?v=166        — logique principale (catalogue, filtres, player)
├── auth.js             — authentification Supabase
├── player.js?v=51      — lecteur vidéo interne
├── styles.css?v=103    — styles globaux
├── sw.js               — Service Worker (cache v186)
├── manifest.webmanifest
├── version.json        — versions APK + Samsung .wgt
└── android-app/        — projet Android Studio (APK WebView)
```

---

## 3. Supabase

| Champ | Valeur |
|-------|--------|
| URL | `https://gwmuazostbbgroplnlql.supabase.co` |
| Anon key | `sb_publishable_cNZ37Mjd57b_9nlyCvtkkA_wSIszOMR` |
| Admin email | `cedric.lago@gmail.com` |
| Wero phone | encodé en base64 dans auth.js : `atob("MDYyMjQ2MTYyNA==")` |

### Tables

| Table | Colonnes clés |
|-------|--------------|
| `profiles` | `id` (auth.uid), `email`, `plan`, `devices_allowed`, `subscription_expires_at` |
| `devices` | `id`, `user_id`, `device_id`, `device_name`, `last_seen`, `monthly_fee` |
| `payments` | `id`, `user_id`, `amount`, `type`, `notes`, `confirmed_at` |
| `sessions` | `id`, `user_id`, `session_token`, `created_at` |

### Plans

| Plan | Accès | Appareils | Durée |
|------|-------|-----------|-------|
| `admin` | Total | ∞ | Sans limite |
| `unlimited` | Total | 3 | Sans limite |
| `active` Solo | Normal | 1 | 365 jours (42 €/an) |
| `active` Multi | Normal | 3 | 365 jours (53 €/an) |
| `test` | Normal | 1 | 7 jours |
| `pending` | Bloqué | — | En attente |

### RLS — Point critique connu

La policy `admin all profiles` avait une récursion infinie (`is_admin()` était `SECURITY INVOKER`).
**Fix SQL à appliquer dans Supabase Dashboard si ce n'est pas encore fait :**

```sql
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND plan = 'admin');
$$;
REVOKE EXECUTE ON FUNCTION public.is_admin() FROM anon;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;

DROP POLICY IF EXISTS "admin all profiles" ON public.profiles;
CREATE POLICY "admin all profiles" ON public.profiles
  FOR ALL USING (auth.uid() = id OR public.is_admin());

UPDATE public.profiles SET plan = 'admin', devices_allowed = 999
WHERE lower(email) = lower('cedric.lago@gmail.com');
```

---

## 4. Filtres permanents (app.js)

Ces filtres sont **toujours actifs** — ne jamais les supprimer :

```js
// Adulte — regex de détection
const _ADULT_RE = /adult|adulte|\+18|18\+|xxx|erot|for adult/i;
const _isAdultCat = c => _ADULT_RE.test(c || "");

// VOSTFR — toujours masqué (titre + catégorie)
const _isVostfr = x => /vostfr/i.test(x.title || "") || /vostfr/i.test(x.category_name || "");
```

- **VOSTFR** : masqué partout, sans exception
- **Adulte** : masqué par défaut — accessible uniquement via pill "🔞 Adult" + PIN parental (À RÉIMPLÉMENTER proprement)
- Ces filtres s'appliquent à : grille principale, nouveautés, section Poursuivre, favoris

---

## 5. Service Worker — Fonctionnement et bugs connus

### Mécanisme
- `sw.js` versionné via `const CACHE = "pipsily-vXXX"`
- Changer ce numéro = nouveau SW détecté → purge des anciens caches → `skipWaiting()` → `RELOAD` envoyé aux clients
- Fichiers pré-cachés listés dans `SHELL[]`

### Bug connu #1 — Race RELOAD listener
Le listener `navigator.serviceWorker.addEventListener("message", ...)` est à l'intérieur de `window.addEventListener("load", ...)` dans `index.html`. Si le SW envoie `RELOAD` avant que `window.load` se déclenche, le message est perdu. **À corriger : déplacer le listener en dehors du `load`.**

### Bug connu #2 — addAll() atomique
Si UN seul fichier du SHELL échoue (réseau, 404), tout le SW install échoue silencieusement et l'ancien SW cassé continue de servir. **À corriger : wrapper addAll() dans un try/catch.**

### Règle de déploiement
- Toute modification de fichier JS/CSS/HTML = bumper SW cache (`pipsily-vXXX` → `vXXX+1`)
- Pour forcer une mise à jour urgente = bumper le cache **ET** demander à l'utilisateur de vider le cache Android TV

---

## 6. APK Android

| Champ | Valeur |
|-------|--------|
| Version actuelle | **v24** |
| APK URL | `https://github.com/morpheus45/VOD/releases/download/v24/PIPSILY.apk` |
| Projet Android | `android-app/` (Android Studio) |
| Logo icône | mipmap-hdpi/xhdpi/xxhdpi/xxxhdpi/ic_launcher.png (PIPSILY PRO) |
| WebView URL | Charge GitHub Pages au lancement |
| Bridge Java | `window.AndroidBridge.getApkVersion()` |

L'APK est une WebView — les mises à jour web (app.js, etc.) sont automatiques au lancement. Un nouvel APK n'est nécessaire que pour changer le code natif Android.

### version.json
```json
{
  "apk_version": 24,
  "apk_url": "https://github.com/morpheus45/VOD/releases/download/v24/PIPSILY.apk",
  "tizen_version": 1,
  "tizen_url": "https://github.com/morpheus45/VOD/releases/download/tv-v1/PIPSILY-TV-signed.wgt"
}
```

---

## 7. Samsung TV (.wgt)

| Champ | Valeur |
|-------|--------|
| Version | tv-v1 |
| Fichier | `PIPSILY-TV-signed.wgt` |
| Release | `https://github.com/morpheus45/VOD/releases/download/tv-v1/PIPSILY-TV-signed.wgt` |
| Projet Tizen | `tizen-tv/` |

---

## 8. Paiements — Flux Wero

1. Utilisateur déclare paiement dans `account.html` → insert dans `payments` avec `confirmed_at = null`
2. Admin voit la demande dans `admin.html` → confirme
3. Admin clique **Solo 42€/an** ou **Multi 53€/an** → `activateAnnual()` → update profiles + insert payment confirmé
4. Admin peut aussi activer **∞ Illimité** (sans date d'expiration) via `setUnlimited()`
5. Admin peut donner **+30 jours** via `activateUser()`

---

## 9. Admin — Fonctions clés (admin.html)

```js
activateAnnual(userId, devices)  // devices=1 → Solo 42€, devices=3 → Multi 53€
setUnlimited(userId)             // plan=unlimited, pas d'expiration
activateUser(userId, days)       // +N jours
sq(label, fn)                    // wrapper Supabase safe (vérifie r.error)
calcAnnualRevenue(users)         // calcule le CA annuel des abonnés actifs
```

Boutons dans la carte utilisateur (ordre) :
1. **Solo 42€/an** — 1 appareil, 365j
2. **Multi 53€/an** — 3 appareils, 365j
3. **∞ Illimité** — pas d'expiration (violet)
4. **+30 jours**

---

## 10. Compte utilisateur (account.html)

Sections :
- Abonnement (statut, email, plan, expiration)
- Paiement Wero (masqué pour admin/unlimited)
- Mes appareils
- Ma région (TV Live — sélecteur custom TV-friendly)
- 🔞 Contrôle parental (PIN localStorage 4-6 chiffres)
- Sécurité (changement mot de passe)
- Déconnexion

**PIN parental :**
- Stocké dans `localStorage.getItem("pipsily_adult_pin")`
- Session déverrouillée : `sessionStorage.getItem("pipsily_adult_unlocked")`
- Se reverrouille à la fermeture de l'app (sessionStorage)

---

## 11. Page install.html — 7 plateformes

| Onglet | Méthodes |
|--------|---------|
| 📱 iPhone/iPad | PWA via Safari |
| 🤖 Android | PWA Chrome + APK direct |
| 📺 Android TV / Google TV | Downloader + navigateur + ADB |
| 🖥 Samsung TV | Installateur auto + Tizen Studio |
| 🔥 Amazon Fire TV | APK via Downloader |
| 🍎 Apple TV | AirPlay miroir + AirPlay vidéo |
| 💻 PC / Mac | PWA navigateur |

URL courtes à créer : `bit.ly/pipsily-apk` → `https://github.com/morpheus45/VOD/releases/download/v24/PIPSILY.apk`

---

## 12. Vitrine (vitrine.html)

Plans publics avec PayPal :
- **Solo** 42 €/an → `paypal.me/pipsily/42`
- **Multi** 53 €/an → `paypal.me/pipsily/53`

---

## 13. Règles de développement CRITIQUES

1. **Ne jamais toucher `google-tv-perso/`** — projet Android TV séparé, sans rapport
2. **Toujours bumper le SW cache** après toute modification de fichier web
3. **Tester la syntaxe JS avant push** : `node --check app.js`
4. **Ne pas générer de code JS avec Python si les chaînes contiennent des caractères spéciaux** — utiliser des éditions directes avec Edit/PowerShell
5. **Ne pas modifier** : bouton jaune pause, gestion audio — sauf demande explicite
6. **VOSTFR et XXX** doivent rester masqués par défaut en toutes circonstances
7. **Toujours modifier les fichiers à la racine du repo** — pas dans des sous-dossiers web

---

## 14. Tâches en attente / À faire

- [ ] **Pill "🔞 Adult"** à réimplémenter proprement (sans génération Python) — après WESTERN dans catPills, visible uniquement si PIN défini, demande PIN si session verrouillée
- [ ] **Filtrer adulte dans Poursuivre** — inProgress + favItems
- [ ] **Fix SW race** : déplacer listener RELOAD hors de `window.addEventListener("load")`
- [ ] **Fix addAll() atomique** : wrapper dans try/catch pour éviter SW install silencieux
- [ ] **APK v25** : rebuilder si changements natifs Android nécessaires
- [ ] **Lien court** `bit.ly/pipsily-apk` à créer sur Bitly

---

## 15. Commandes utiles

```bash
# Vérifier syntaxe JS
node --check app.js

# Pousser un commit
cd "C:\Users\cedri\OneDrive\Desktop\VOD-push"
git add fichier.html
git commit -m "feat: description"
git push origin main

# Voir les commits récents
git log --oneline -10

# Restaurer un fichier à un commit précédent
git checkout COMMIT_HASH -- fichier.html

# Tester si Supabase répond
curl -s "https://gwmuazostbbgroplnlql.supabase.co/rest/v1/profiles?select=id&limit=1" \
  -H "apikey: sb_publishable_cNZ37Mjd57b_9nlyCvtkkA_wSIszOMR"
```

---

*Généré le 2026-05-26 — PIPSILY v25 / SW pipsily-v186*
