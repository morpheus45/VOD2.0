# PIPSILY TV — Application Samsung Smart TV (Tizen)

App packagée (.wgt) avec mise à jour automatique, basée sur le code PIPSILY existant.

---

## Prérequis

| Outil | Version | Lien |
|---|---|---|
| Tizen Studio | 5.x ou + | [Télécharger](https://developer.samsung.com/smarttv/develop/getting-started/setting-up-sdk/installing-tv-sdk.html) |
| Samsung TV Extension | inclus | Via Tizen Studio Package Manager |
| Compte Samsung Developer | Gratuit | [developer.samsung.com](https://developer.samsung.com) |
| TV Samsung en mode développeur | — | Voir section ci-dessous |

---

## Activer le mode développeur sur la TV

1. Aller dans **Paramètres → Support → À propos de ce TV**
2. Appuyer **5 fois** sur le bouton **OK** sur le **numéro de modèle** affiché
3. Un dialogue s'ouvre : **Mode développeur → ON**
4. Entrer l'**adresse IP de ton PC**
5. Redémarrer la TV
6. La TV est maintenant accessible via `sdb` (Samsung Device Bridge)

---

## Structure du projet

```
tizen-tv/
├── config.xml          ← Manifest Tizen (ID app, privileges, profile TV)
├── index.html          ← Shell HTML principal (pas de Service Worker)
├── tizen-update.js     ← Moteur de mise à jour automatique
├── tizen-tv.js         ← Adaptations télécommande Samsung
├── build.ps1           ← Script de build PowerShell
├── .project            ← Config Tizen Studio
├── .tproject           ← Config profil Tizen Studio
├── icon.png            ← Icône 128×128 (copiée depuis icons/ par build.ps1)
├── icon_large.png      ← Icône 512×512
│
│   ← Fichiers PIPSILY copiés par build.ps1 →
├── app.js
├── auth.js
├── styles.css
├── ... (tous les assets PIPSILY)
└── icons/
```

---

## Premier build

### 1. Préparer les fichiers

```powershell
cd "C:\Users\cedri\OneDrive\Desktop\VOD-push\tizen-tv"
.\build.ps1
```

Le script copie tous les fichiers PIPSILY dans le dossier `tizen-tv/` et propose de lancer le build automatique si Tizen CLI est dans le PATH.

### 2. Créer un certificat (première fois seulement)

Dans Tizen Studio :
- **Tools → Certificate Manager → +**
- Choisir **Samsung** → suivre l'assistant
- Utiliser ton compte Samsung Developer pour signer

### 3. Packager dans Tizen Studio

1. **File → Import → Tizen → Tizen Project** → sélectionner le dossier `tizen-tv/`
2. Clic droit sur le projet → **Build Signed Package**
3. Le fichier `PIPSILY-TV.wgt` apparaît dans `result/`

### 4. Installer sur la TV via sdb

```bash
# Connecter la TV (remplacer IP par l'IP de ta TV)
sdb connect 192.168.1.XXX

# Vérifier la connexion
sdb devices

# Installer le .wgt
sdb install result/PIPSILY-TV.wgt

# Lancer l'app
sdb shell 0 execute com.morpheus45.pipsily
```

---

## Workflow de mise à jour

Quand une nouvelle version est prête, le processus est le suivant :

### Côté développeur

```
1. Modifier le code PIPSILY (app.js, styles.css, etc.)
2. Incrémenter tizen_version dans version.json (ex: 1 → 2)
3. Mettre à jour tizen_changes dans version.json
4. Lancer .\build.ps1 pour copier les nouveaux fichiers
5. Dans Tizen Studio : Build Signed Package → PIPSILY-TV.wgt
6. Créer un release GitHub : tag "tv-v2", uploader PIPSILY-TV.wgt
7. Mettre à jour tizen_url dans version.json
8. git push origin main
```

### Côté TV (automatique)

Au prochain lancement de l'app :
1. `tizen-update.js` vérifie `version.json` sur GitHub Pages
2. Si `tizen_version` > version installée → overlay "Mise à jour disponible"
3. L'utilisateur clique "Mettre à jour maintenant"
4. Téléchargement du `.wgt` + installation via `tizen.package.install()`
5. L'app se relance automatiquement

---

## Commandes sdb utiles

```bash
# Voir les logs en temps réel
sdb dlog | grep PIPSILY

# Voir tous les logs du navigateur
sdb dlog | grep WebView

# Désinstaller l'app
sdb shell 0 uninstall com.morpheus45.pipsily

# Ouvrir un shell sur la TV
sdb shell

# Copier un fichier vers la TV
sdb push fichier.wgt /tmp/
```

---

## Notes importantes

- **Pas de Service Worker** : les apps `.wgt` Tizen packagées ne supportent pas les Service Workers. La mise à jour est gérée par `tizen-update.js` à la place.
- **HLS.js** est épinglé à `1.5.15` (version fixe) pour éviter des régressions sur le moteur WebKit de Tizen.
- **`$TIZEN_SCRIPT`** dans `index.html` est un placeholder remplacé automatiquement par Tizen Studio lors du build — ne pas modifier.
- **`updateBar`** de PIPSILY est conservé dans le DOM mais masqué (`display:none`) pour éviter les erreurs JavaScript dans `app.js`.
- Le profil `tv-samsung-public-7.0` cible Tizen 3.0+ (TV depuis 2016). Pour les TV plus anciennes, changer en `tv-samsung-public-5.0`.
- **`packagemanager.install`** nécessite une signature Samsung Partner (au-delà du certificat développeur standard). Si l'API n'est pas disponible, `tizen-update.js` affiche un message de fallback avec le lien de téléchargement.
