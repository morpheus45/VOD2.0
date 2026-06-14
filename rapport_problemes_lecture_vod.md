# Rapport d’audit du dépôt VOD : problèmes de lecture

## Résumé exécutif

L’examen du dépôt **morpheus45/VOD** montre que les problèmes de lecture ne proviennent pas d’une seule panne, mais d’un **ensemble de défauts de conception et de compatibilité**. Le plus critique est que, pour la majorité des contenus VOD chargés depuis les playlists M3U, l’application **n’utilise pas réellement le lecteur intégré** et redirige l’utilisateur directement vers l’URL du média. En pratique, cela contourne `player.html` et `player.js`, ce qui annule la reprise de lecture, la gestion d’erreurs enrichie, le plein écran piloté, et une partie de la compatibilité multi-format.

Un second problème majeur est que le catalogue VOD contient une proportion très importante de formats **peu ou mal supportés nativement par les navigateurs**, en particulier **MKV** et **AVI**. Enfin, les sources média sont massivement en **HTTP non sécurisé**, ce qui crée des risques élevés de blocage dès que l’interface est servie en **HTTPS**. À cela s’ajoutent une détection trop simpliste des formats, une dépendance à des bibliothèques externes chargées depuis CDN, et l’absence de mécanisme de repli robuste lorsque la lecture échoue.

## Constats principaux

| Priorité | Problème | Impact direct sur la lecture | Preuve |
|---|---|---|---|
| Critique | Les contenus VOD/lives avec URL directe sont ouverts hors du lecteur intégré | La lecture contourne `player.html`, donc expérience incohérente et compatibilité réduite | `app.js:657-668` |
| Critique | Flux en HTTP non sécurisé | Risque de **mixed content** si l’interface est servie en HTTPS | Playlists `.m3u` ; comptage effectué sur `vod.m3u`, `live.m3u`, `series.m3u` |
| Critique | Forte présence de formats non compatibles navigateur | Échec fréquent de lecture native dans le navigateur | `vod.m3u` : **11 234 MKV**, **4 820 MP4**, **476 AVI** |
| Élevée | Détection des formats uniquement par suffixe d’URL | Certains flux HLS/TS ne seront pas traités par le bon moteur | `player.js:195-196` |
| Élevée | Dépendance à `hls.js` et `mpegts.js` via CDN externe | Si les scripts externes ne chargent pas, la lecture spécialisée échoue | `player.html:43-45` |
| Élevée | Pas de fallback automatique après erreur HLS/MPEG-TS | L’utilisateur reçoit un message, mais pas de tentative de lecture alternative | `player.js:198-209`, `player.js:213-235` |
| Moyenne | Ouverture du lien direct dans le même onglet | Sortie brutale de l’application, perte de contexte utilisateur | `player.js:83-86` |
| Moyenne | Le lecteur dépend de `sessionStorage` | Accès direct à `player.html` ou rechargement isolé = perte du média à lire | `player.js:3-10` |

## Analyse détaillée

### 1. Le lecteur intégré est contourné pour la majorité des VOD

Le point le plus important se situe dans `openItem()` dans `app.js`. Dès qu’un élément possède une URL de flux (`stream_url` ou `url`), le code **redirige directement** vers cette URL au lieu de passer par `player.html`.

> `app.js:660-668` : si `directUrl` existe, l’application fait `location.href = directUrl` ou `window.open(directUrl, "_blank")` en cas de mismatch HTTP/HTTPS.

Or, les éléments issus de `vod.m3u` possèdent justement une URL directe. Cela signifie que le clic sur un film ouvre le fichier vidéo brut au lieu d’utiliser le lecteur maison. Le comportement observé est donc structurel :

| Élément | Comportement réel actuel | Conséquence |
|---|---|---|
| Film VOD provenant de `vod.m3u` | Ouverture directe du média | Le lecteur personnalisé n’est pas utilisé |
| Flux live provenant de `live.m3u` | Ouverture directe du flux | Pas de gestion centralisée des erreurs |
| Série via épisode sélectionné | Passage par `player.html` | Fonctionne mieux que les VOD, mais reste fragile |

Ce choix provoque plusieurs effets négatifs : perte de l’interface, perte de la reprise de lecture, dépendance totale au support natif du navigateur, et comportement différent selon le type de contenu.

### 2. Le catalogue VOD est majoritairement en MKV, format mal supporté nativement

L’analyse de `vod.m3u` montre la répartition suivante des extensions :

| Extension | Nombre observé |
|---|---:|
| MKV | 11 234 |
| MP4 | 4 820 |
| AVI | 476 |

Ce point est déterminant. Les navigateurs modernes lisent généralement bien **MP4/H.264/AAC**, mais la prise en charge de **MKV** est variable et celle de **AVI** est très mauvaise, voire inexistante. Comme l’application redirige directement vers les médias, elle repose de fait sur la capacité native du navigateur à ouvrir ces fichiers. Cela explique très plausiblement des retours du type **« certains films ne se lancent pas »**, **« écran noir »**, ou **« téléchargement au lieu de lecture »**.

### 3. Les flux utilisent massivement HTTP et non HTTPS

Le comptage sur les playlists montre :

| Playlist | Nombre d’URL en `http://` |
|---|---:|
| `vod.m3u` | 16 530 |
| `live.m3u` | 1 261 |
| `series.m3u` | 5 202 |

Dans `app.js`, lorsque la page tourne en HTTPS et que le flux est en HTTP, le code détecte un décalage de protocole :

> `app.js:661-665` : si la page est en `https:` et que le flux commence par `http://`, l’application ouvre le flux dans un nouvel onglet.

Cette logique évite un blocage direct dans la page, mais **ne résout pas réellement le problème**. Elle déporte simplement la lecture hors de l’application. De plus, si le serveur distant réagit mal ou si le navigateur renforce ses politiques de sécurité, la lecture devient instable.

Le test réseau effectué sur deux exemples de VOD (`.mp4` et `.mkv`) a renvoyé :

> `curl: (52) Empty reply from server`

Cela ne prouve pas à lui seul une panne définitive côté utilisateur, mais montre que le serveur source répond de façon peu robuste au moins dans certains contextes, ce qui renforce le risque de lecture aléatoire.

### 4. La détection des formats est trop simpliste

Dans `player.js`, la logique choisit le moteur de lecture uniquement si l’URL finit par `.m3u8` ou `.ts`.

| Ligne | Logique actuelle | Limite |
|---|---|---|
| `player.js:195` | HLS si extension `.m3u8` | Ne couvre pas les URLs HLS masquées, signées, ou sans suffixe explicite |
| `player.js:196` | MPEG-TS si extension `.ts` | Ne couvre pas d’autres cas de transport stream ou endpoints dynamiques |

En pratique, beaucoup de serveurs IPTV ou VOD exposent des URLs qui **ne reflètent pas clairement le format réel**. Avec la logique actuelle, un flux HLS sans suffixe `.m3u8` tombera dans la branche native `video.src = url`, ce qui peut provoquer un échec alors qu’un moteur HLS aurait pu le lire.

### 5. Le lecteur dépend de bibliothèques CDN sans repli local

`player.html` charge :

- `https://cdn.jsdelivr.net/npm/hls.js@latest`
- `https://cdn.jsdelivr.net/npm/mpegts.js@latest`

Si le CDN est indisponible, filtré, ralenti, ou bloqué par un environnement réseau, le lecteur perd immédiatement sa capacité à gérer certains flux. Il n’existe **aucune copie locale** ni mécanisme de secours. Cela crée un point de fragilité supplémentaire, surtout pour une application supposée être utilisée dans des environnements variés.

### 6. Gestion d’erreur insuffisante pendant la lecture

Le code affiche bien un message utilisateur en cas d’erreur HLS ou d’erreur vidéo générale, mais il **n’essaie pas vraiment d’autre stratégie**.

| Cas | Réaction actuelle | Limite |
|---|---|---|
| Erreur HLS | Message : essayer le lien direct | Aucun fallback automatique vers lecture native ou autre mode |
| Erreur vidéo HTML5 | Message générique | Aucun diagnostic plus précis |
| Flux TS non lu | Message d’avertissement | Pas de tentative de reconfiguration |

Autrement dit, quand la lecture échoue, le système **informe**, mais ne **récupère pas**.

### 7. Ouverture du lien externe dans le même onglet

Dans `player.js`, le bouton « Ouvrir le lien direct » exécute :

> `player.js:83-86` : `if(url) location.href = url;`

Cela fait quitter l’application à l’utilisateur. Même si ce n’est pas un bug bloquant au sens strict, c’est un **mauvais comportement fonctionnel** pour un lecteur. L’onglet courant perd alors toute l’interface, l’historique interne, et le contexte utilisateur.

### 8. Dépendance à `sessionStorage` pour alimenter `player.html`

Le média à lire est récupéré uniquement via :

> `player.js:3-10` : lecture de `sessionStorage.getItem("iptv_current_item")`

Si l’utilisateur ouvre `player.html` directement, recharge la page dans un contexte séparé, ou arrive sur cette page sans passage préalable par l’application, le lecteur ne sait rien lire. Ce n’est pas forcément la cause principale des pannes VOD, mais c’est une faiblesse d’architecture.

## Diagnostic final

Le dépôt présente **quatre causes racines majeures** des problèmes de lecture :

1. **Contournement du lecteur intégré** pour la majorité des VOD et des flux live.
2. **Formats réellement distribués peu compatibles navigateur**, surtout MKV et AVI.
3. **Usage massif de HTTP**, problématique dès qu’on sert l’interface en HTTPS.
4. **Logique de détection et de secours insuffisante** dans le lecteur.

## Priorisation des corrections recommandées

| Ordre | Correction recommandée | Effet attendu |
|---|---|---|
| 1 | Forcer tous les clics VOD/live/séries à passer par `player.html` au lieu de rediriger directement vers le média | Uniformise la lecture et réactive les mécanismes de contrôle |
| 2 | Traiter explicitement les contenus MKV/AVI comme incompatibles navigateur ou prévoir une stratégie de transcodage/serveur adapté | Réduit les échecs silencieux |
| 3 | Migrer les flux vers HTTPS quand possible | Supprime les problèmes de mixed content |
| 4 | Améliorer la détection des formats au-delà du simple suffixe d’URL | Meilleure reconnaissance des flux réels |
| 5 | Ajouter un fallback automatique après échec HLS/MPEG-TS | Rend le lecteur plus résilient |
| 6 | Héberger localement `hls.js` et `mpegts.js` ou prévoir un repli | Évite les pannes liées au CDN |
| 7 | Ouvrir les liens externes dans un nouvel onglet au lieu de remplacer la page courante | Préserve l’application |

## Conclusion

En l’état, les **problèmes de lecture sont bien réels et structurels**. Le dépôt n’est pas seulement confronté à quelques liens cassés : il souffre d’un **modèle de lecture incohérent** entre catalogue et lecteur, aggravé par des **formats difficiles**, des **flux non sécurisés** et une **tolérance limitée aux erreurs**. Le défaut le plus important à corriger immédiatement est la fonction `openItem()` dans `app.js`, car elle détourne l’essentiel du trafic vidéo hors du lecteur intégré.

Si vous le souhaitez, je peux maintenant produire la **liste exacte des corrections à appliquer dans le code**, ou bien vous préparer un **patch complet prêt à intégrer** dans le dépôt.
