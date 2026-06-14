// ╔══════════════════════════════════════════════════════════════╗
// ║  PIPSILY — app.js v6.9 — fix durée HLS inconnue (d=0)        ║
// ║  Films + Séries (Saisons / Épisodes) — M3U / JSON            ║
// ║  Xtream Codes API — Google TV / Android                      ║
// ╚══════════════════════════════════════════════════════════════╝

"use strict";

// ─────────────────────────────────────────────────────────────────
//  CONSTANTES
// ─────────────────────────────────────────────────────────────────

const STORE = {
  favorites : "pf_favorites_v4",
  history   : "pf_history_v4",
  progress  : "pf_progress_v4"
};

const PER_PAGE   = 48;
const SENTINEL_M = "300px";

// Détection iOS / iPadOS (y compris iPad en mode desktop avec touch)
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
              (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

// Safari natif iOS/iPadOS (pas Chrome/Firefox/Edge sur iOS)
const isSafariIOS = isIOS &&
  /Safari/i.test(navigator.userAgent) &&
  !/CriOS|FxiOS|OPiOS|EdgiOS/i.test(navigator.userAgent);

// Tous les contextes iOS : Safari + PWA standalone (UA sans "Safari") + toutes applis
// En mode PWA (ajouté à l'écran d'accueil), l'UA ne contient pas "Safari"
const isIOSContext = isIOS;

// ─────────────────────────────────────────────────────────────────
//  ÉTAT GLOBAL
// ─────────────────────────────────────────────────────────────────

const S = {
  type      : "vod",
  vod       : [],
  series    : [],
  live      : [],
  cat       : "",
  search    : "",
  quality   : "",
  region    : localStorage.getItem("pipsily_region") || "",
  _liveRegionIdx: null,   // construit une fois, resetté si live recharge
  sort      : "title",
  shown     : { vod: 0, series: 0, live: 0 },
  favOnly   : false,
  loading   : false,
  // Panneau séries
  panel     : {
    open       : false,
    series     : null,
    seasonsMap : {},   // { "1": [ep,...], "2": [...] }
    seasonsMeta: [],   // [ { num, name, cover, count } ]
    selSeason  : null
  },
  // Cache en mémoire des épisodes chargés
  epCache   : {},
  // Base pré-générée (episodes_part*.json) — chargée en lazy au 1er clic série
  epDb      : {}
};

// ─────────────────────────────────────────────────────────────────
//  UTILITAIRES
// ─────────────────────────────────────────────────────────────────

const $  = id => document.getElementById(id);
const esc = s  => String(s ?? "").replace(/[&<>"']/g,
  c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));

// Supprime le préfixe "EU | " ou "EU|" des noms de catégorie Live pour l'affichage
function displayCat(name){
  return String(name || "").replace(/^EU\s*\|\s*/i, "").trim();
}

// ─────────────────────────────────────────────────────────────────
//  LECTEUR INTERNE — PipPlayer
//  Remplace la navigation vers player.html par un overlay intégré
// ─────────────────────────────────────────────────────────────────
const PipPlayer = {
  _hls       : null,
  _item      : null,
  _epList    : [],
  _epIdx     : -1,
  _progTimer : null,
  _lastFocus : null, // focus à restaurer après fermeture du lecteur natif (TV)

  // ── Ouvrir le lecteur avec un item ──────────────────────────────
  open(item){
    this._item   = item;
    this._epList = item._epList || [];
    this._epIdx  = item._epIdx  ?? -1;

    // preparePlutoUrl() injecte les params requis par Pluto TV (deviceModel, etc.)
    // doit s'appliquer ici, AVANT AndroidBridge, iOS AVPlayer et le WebView player.
    const url   = preparePlutoUrl(item.url || item.stream_url || "");
    const label = item.episode_label
      ? `${item.title} — ${item.episode_label}`
      : item.title || "Lecture";
    const sub = item.episode_title || item.category_name || "";

    // ── APK : lecteur natif ExoPlayer (HTTP sans mixed content) ────
    if(typeof window.AndroidBridge?.openPlayer === "function"){
      this._lastFocus = document.activeElement; // restauré dans onAndroidPlayerClosed
      pushHist(item);
      // Alimenter _epUrlMap pour tous les épisodes (TV + non-TV)
      // afin que onAndroidPlayerClosed puisse sauvegarder sous "seriesId||SxxExx"
      if(item.type === "series" && this._epList.length > 0){
        const sid = String(item.series_id || item.id || "");
        if(sid){
          if(!window._epUrlMap) window._epUrlMap = {};
          this._epList.forEach(ep => {
            if(!ep.url) return;
            const s = String(ep.season || 1).padStart(2,"0");
            const e = String(ep.episode_num || 1).padStart(2,"0");
            window._epUrlMap[ep.url] = ep.progress_key || `${sid}||S${s}E${e}`;
          });
        }
      }
      // Sérialiser la liste d'épisodes pour Java
      const epsJson = this._epList.length > 1
        ? JSON.stringify(this._epList.map(ep => ({
            url          : ep.url || ep.stream_url || "",
            title        : ep.title || "",
            episode_label: ep.episode_label || ep.episode_num
              ? `S${String(ep.season||1).padStart(2,"0")}E${String(ep.episode_num||1).padStart(2,"0")}`
              : ""
          })))
        : "[]";
      // Reprise au bon endroit si une progression est sauvegardée
      const savedMs = _getSavedProgressMs(item);
      if(savedMs > 0 && typeof window.AndroidBridge.openPlayerAt === "function"){
        window.AndroidBridge.openPlayerAt(url, item.title || label, sub, epsJson, this._epIdx, savedMs);
      } else {
        window.AndroidBridge.openPlayer(url, item.title || label, sub, epsJson, this._epIdx);
      }
      return;
    }

    // ── iOS / iPadOS : AVPlayer natif (Safari, PWA, Chrome iOS…) ──
    // Tous les navigateurs iOS utilisent WebKit → webkitEnterFullscreen() disponible.
    // En mode PWA standalone, l'UA ne contient pas "Safari" → on teste isIOS directement.
    if(isIOSContext){
      pushHist(item);
      this._openAVPlayer(item);
      return;
    }

    // ── Navigateur mobile Android (hors APK) : mixed-content HTTP → overlay direct ──
    const _isMixedContent = /^http:/i.test(url) && location.protocol === "https:";
    if(_isMixedContent){
      pushHist(item);
      this._openOverlay(item);
      return;
    }

    // ── Navigateur / PWA : lecteur overlay WebView ──────────────────
    const el = $("pip-player");
    el.classList.add("pip-open");
    document.body.style.overflow = "hidden";
    el.scrollTop = 0;

    $("pip-title").textContent = label;
    $("pip-sub").textContent   = sub;
    document.title = label + " — PIPSILY";

    $("pip-plot").textContent = item.plot || "Chargement du synopsis…";
    if(!item.plot) this._loadPlot(item);

    this._updateEpNav();
    this._updateFavBtn();
    this._hideStatus();
    this._loadVideo(item);
  },

  // ── Fermer le lecteur ───────────────────────────────────────────
  close(){
    const video = $("pip-video");
    if(video){ this._saveProgress(); video.pause(); video.removeAttribute("src"); video.load(); }
    if(this._hls){ this._hls.destroy(); this._hls = null; }
    clearTimeout(this._progTimer);
    $("pip-player").classList.remove("pip-open");
    document.body.style.overflow = "";
    document.title = "PIPSILY";

    // Rafraîchir après fermeture AVANT de nullifier _item
    const closedItem = this._item;
    this._item = null;

    // 1. Rafraîchir "Continuer à regarder" (section en cours + favoris)
    if(typeof renderContinueRow === "function") renderContinueRow();

    // 2. Rafraîchir le panneau série si ouvert (bouton Reprendre, barres épisodes)
    if(S.panel.open && !S.panel.isVod && typeof renderPanel === "function") renderPanel();

    // 3. Mettre à jour les barres de progression sur les vignettes de la grille
    if(closedItem) _refreshCardProgress(closedItem);
  },

  // ── Sélection automatique de la piste audio française ──────────
  _setFrenchAudio(){
    if(!this._hls) return;
    const tracks = this._hls.audioTracks;
    if(!tracks || tracks.length <= 1) return;
    // Cherche une piste dont le code langue commence par "fr" (fr, fre, fra…)
    // ou dont le nom contient "french" / "français"
    const frIdx = tracks.findIndex(t =>
      /^fr/i.test(t.lang  || "") ||
      /fran[çc]/i.test(t.name || "") ||
      /french/i.test(t.name  || "")
    );
    if(frIdx >= 0 && frIdx !== this._hls.audioTrack){
      console.log(`[PipPlayer] Piste audio FR sélectionnée : ${tracks[frIdx].name} (lang=${tracks[frIdx].lang})`);
      this._hls.audioTrack = frIdx;
    }
  },

  // ── Chargement vidéo ────────────────────────────────────────────
  _loadVideo(item){
    const video = $("pip-video");
    if(!video) return;
    video.removeAttribute("src"); video.load();
    if(this._hls){ this._hls.destroy(); this._hls = null; }

    // rawUrl = URL originale (HTTP) — url = version sécurisée tentée en premier
    const rawUrl = preparePlutoUrl((item.url || item.stream_url || "").trim());
    const url    = secureUrl(rawUrl);
    if(!url){ this._showStatus("❌ Aucune URL de lecture disponible.", true); return; }

    const isHLS = /\.m3u8/i.test(url) || item.type === "live";
    // PC navigateur de bureau (pas APK Android, pas iOS)
    const isPcBrowser = !isIOSContext && typeof window.AndroidBridge === "undefined";

    // ── Fallback : ouvre dans onglet (rawUrl HTTP) ou lecteur natif Android ──
    const _openNativeFallback = () => {
      if(typeof window.AndroidBridge?.openInVlc === "function"){
        this._showStatus("⚠️ Ouverture du lecteur natif…", false);
        setTimeout(() => {
          try { window.AndroidBridge.openInVlc(rawUrl, this._item?.title || "", false); }
          catch(e){ window.open(rawUrl, "_blank", "noopener"); }
        }, 600);
      } else {
        // PC / navigateur : ouvrir rawUrl (HTTP) dans un nouvel onglet — VLC ou lecteur natif
        window.open(rawUrl, "_blank", "noopener");
      }
    };

    // ── Lecture via HLS.js (Live + m3u8) ──
    if(isHLS && window.Hls?.isSupported()){
      // Helper : une tentative HLS.js sur une source, avec rappel en cas d'échec fatal
      const tryHls = (src, onFatal) => {
        this._hls = new Hls({ maxBufferLength: 30, enableWorker: false });
        this._hls.loadSource(src);
        this._hls.attachMedia(video);
        this._hls.on(Hls.Events.MANIFEST_PARSED, () => {
          this._setFrenchAudio();
          video.play().catch(() => {});
        });
        this._hls.on(Hls.Events.ERROR, (_, d) => {
          if(d.fatal){
            this._hls.destroy(); this._hls = null;
            onFatal();
          }
        });
      };

      if(isPcBrowser && rawUrl !== url){
        // PC + page HTTPS : le serveur IPTV n'a pas de HTTPS → l'upgrade échoue.
        // 1) tenter HTTPS  2) retenter HLS.js sur l'URL HTTP d'origine
        //    (fonctionne si "Contenu non sécurisé : Autoriser" est activé pour le site)
        // 3) sinon : expliquer le réglage au lieu d'ouvrir un onglet inutile
        tryHls(url, () => {
          this._showStatus("⚠️ Nouvel essai sur le flux HTTP d'origine…", false);
          tryHls(rawUrl, () => {
            this._showStatus(
              "❌ Le navigateur bloque les flux HTTP sur ce site HTTPS. " +
              "Pour lire les vidéos sur PC : cliquez le cadenas 🔒 dans la barre d'adresse → " +
              "« Paramètres du site » → « Contenu non sécurisé » → Autoriser, puis rechargez la page. " +
              "Sinon, utilisez 🔗 Copier le lien et ouvrez-le dans VLC.", true);
          });
        });
      } else {
        tryHls(url, () => {
          if(isPcBrowser){
            // PC en HTTP local : essayer rawUrl directement
            this._showStatus("⚠️ Basculement sur flux original…", false);
            video.src = rawUrl;
            video.play().catch(() => _openNativeFallback());
          } else {
            this._showStatus("⚠️ Basculement lecture native…", false);
            video.src = url;
            video.play().catch(() => _openNativeFallback());
          }
        });
      }
    } else if(isHLS && video.canPlayType("application/vnd.apple.mpegurl")){
      // Safari natif HLS
      video.src = url;
      video.play().catch(() => {});
    } else {
      video.src = url;
      video.play().catch(() => {});
    }

    // Erreur sur l'élément vidéo → fallback
    video.onerror = () => {
      if(isPcBrowser && video.src !== rawUrl){
        // PC : réessayer avec l'URL HTTP originale
        video.src = rawUrl;
        video.play().catch(() => _openNativeFallback());
      } else {
        this._showStatus("⚠️ Le flux ne peut pas être lu ici — ouverture du lecteur natif…", false);
        setTimeout(_openNativeFallback, 800);
      }
    };

    // Reprendre la progression sauvegardée
    video.addEventListener("loadedmetadata", () => this._restoreProgress(), { once: true });
    // Sauvegarder la progression toutes les 5s
    video.ontimeupdate = () => {
      clearTimeout(this._progTimer);
      this._progTimer = setTimeout(() => this._saveProgress(), 5000);
    };
  },

  // ── Progression ─────────────────────────────────────────────────
  _saveProgress(){
    const video = $("pip-video");
    if(!video || !this._item || video.currentTime < 5) return;
    const prog = getProg();
    // Priorité : progress_key (épisodes de série) → id numérique (VOD)
    const key  = this._item.progress_key || String(this._item.id || this._item.stream_id || "");
    if(!key) return;
    const dur = (video.duration && isFinite(video.duration)) ? Math.floor(video.duration) : 0;
    prog[key] = { t: Math.floor(video.currentTime), d: dur, ts: Date.now() };
    storeSet(STORE.progress, prog); // cache déjà mis à jour (même objet)
  },

  _restoreProgress(){
    const video = $("pip-video");
    if(!video || !this._item) return;
    const prog  = getProg(); // utilise le cache (au lieu de storeGet brut)
    const key   = this._item.progress_key || String(this._item.id || this._item.stream_id || "");
    const saved = prog[key];
    if(!saved) return;
    // Format {t, d, ts} (PipPlayer) — priorité
    if(saved.t > 10 && saved.t < (video.duration || Infinity) - 30){
      video.currentTime = saved.t;
    // Format {pct, ts} (iOS AVPlayer / ancien) — repli
    } else if(saved.pct > 0.01 && saved.pct < 0.97 && video.duration && isFinite(video.duration)){
      video.currentTime = saved.pct * video.duration;
    }
  },

  // ── Synopsis lazy-load ──────────────────────────────────────────
  _loadPlot(item){
    const streamUrl = item.stream_url || item.url || "";
    // ── Extraire base/user/pass depuis l'URL Xtream ──────────────────
    let creds = null;
    try {
      const u   = new URL(streamUrl);
      const pts = u.pathname.split("/").filter(Boolean);
      // Format /movie/user/pass/id.ext  ou  /series/user/pass/id.ext
      if((pts[0]==="movie"||pts[0]==="series"||pts[0]==="live") && pts.length >= 4)
        creds = { base: u.origin, username: pts[1], password: pts[2] };
      // Format query-string  ?username=...&password=...
      else {
        const usr = u.searchParams.get("username");
        const pwd = u.searchParams.get("password");
        if(usr && pwd) creds = { base: u.origin, username: usr, password: pwd };
      }
      // Format  /user/pass/id.ext  (Xtream sans préfixe)
      if(!creds && pts.length >= 3 && !pts[0].includes("."))
        creds = { base: u.origin, username: pts[0], password: pts[1] };
    } catch {}

    // Fallback : peut-être que l'item porte directement les infos de connexion
    if(!creds && item.username && item.password && item.server)
      creds = { base: item.server, username: item.username, password: item.password };

    if(!creds){
      if($("pip-plot")) $("pip-plot").textContent = "Synopsis non disponible pour ce contenu.";
      return;
    }

    const isSeries = item.type==="series" || !!item.series_id;
    const id       = isSeries ? (item.series_id||item.id) : (item.id||item.stream_id);
    if(!id){ if($("pip-plot")) $("pip-plot").textContent = "Synopsis non disponible pour ce contenu."; return; }

    const action = isSeries ? `get_series_info&series_id=${id}` : `get_vod_info&vod_id=${id}`;
    const apiUrl = `${creds.base}/player_api.php?username=${encodeURIComponent(creds.username)}&password=${encodeURIComponent(creds.password)}&action=${action}`;

    const ctrl = new AbortController();
    const _tid = setTimeout(() => ctrl.abort(), 10000);

    fetch(apiUrl, { signal: ctrl.signal, credentials: "omit" })
      .then(r => { clearTimeout(_tid); return r.ok ? r.json() : null; })
      .then(d => {
        const plot = d?.info?.plot
                  || d?.info?.description
                  || d?.info?.overview
                  || d?.movie_data?.plot
                  || d?.movie_data?.description
                  || null;
        if($("pip-plot")) $("pip-plot").textContent = plot || "Synopsis non renseigné par le fournisseur.";
      })
      .catch(() => {
        clearTimeout(_tid);
        if($("pip-plot")) $("pip-plot").textContent = "Synopsis non disponible (erreur réseau).";
      });
  },

  // ── Favoris — utilise le système global (format {key,item,at}) ──
  _updateFavBtn(){
    const btn = $("pip-fav");
    if(!btn || !this._item) return;
    const fav = isFav(this._item);
    btn.classList.toggle("pip-is-fav", fav);
    btn.textContent = fav ? "♥" : "♡";
  },

  toggleFav(){
    if(!this._item) return;
    toggleFav(this._item);   // appel de la fonction globale unifiée
    this._updateFavBtn();
  },

  // ── Navigation épisodes ─────────────────────────────────────────
  _updateEpNav(){
    const nav  = $("pip-ep-nav");
    const prev = $("pip-prev");
    const next = $("pip-next");
    if(!nav) return;
    const hasList = this._epList.length > 1;
    nav.hidden     = !hasList;
    if(prev) prev.disabled = this._epIdx <= 0;
    if(next) next.disabled = this._epIdx < 0 || this._epIdx >= this._epList.length - 1;
  },

  goPrev(){ if(this._epIdx > 0) this._goEp(this._epIdx - 1); },
  goNext(){ if(this._epIdx < this._epList.length - 1) this._goEp(this._epIdx + 1); },

  _goEp(idx){
    const ep = this._epList[idx];
    if(!ep) return;
    this._saveProgress();
    this._epIdx = idx;
    const s   = String(ep.season || 1).padStart(2,"0");
    const e   = String(ep.episode_num || idx+1).padStart(2,"0");
    this.open({
      ...this._item,
      id            : ep.id,
      url           : ep.url,
      stream_url    : ep.url,
      plot          : ep.plot || this._item.plot || "",
      episode_label : `S${s}E${e}`,
      episode_title : ep.title || "",
      _epList       : this._epList,
      _epIdx        : idx
    });
  },

  // ── Statut ──────────────────────────────────────────────────────
  _showStatus(msg, isError = false){
    const el = $("pip-status");
    if(!el) return;
    el.textContent = msg;
    el.className   = "pip-status" + (isError ? " pip-status--error" : "");
    el.hidden      = false;
    setTimeout(() => { if(el) el.hidden = true; }, 6000);
  },
  _hideStatus(){ const el = $("pip-status"); if(el) el.hidden = true; },

  // ── Lecture native / externe ─────────────────────────────────────
  openNative(){
    if(!this._item) return;
    const rawUrl = (this._item.url || this._item.stream_url || "").trim();
    if(!rawUrl) return;
    // PC navigateur : ouvrir URL originale (HTTP) dans un onglet — le navigateur peut la lire
    if(!isIOSContext && typeof window.AndroidBridge === "undefined"){
      window.open(rawUrl, "_blank", "noopener");
      return;
    }
    if(typeof window.AndroidBridge !== "undefined"){
      // Android APK : URL brute — le WebView accepte HTTP nativement, ne pas toucher
      try { window.AndroidBridge.openInVlc(rawUrl, this._item.title || "", false); return; } catch {}
    }
    // Navigateur / iOS : upgrade HTTP→HTTPS si la page est en HTTPS
    window.open(secureUrl(rawUrl), "_blank", "noopener");
  },

  // ── iOS : ouvrir dans VLC (scheme vlc://) ───────────────────────
  openVLC(){
    if(!this._item) return;
    const raw = (this._item.url || this._item.stream_url || "").trim();
    if(!raw) return;
    // vlc:// remplace le protocole : vlc://exemple.com/stream.m3u8
    window.location.href = "vlc://" + raw.replace(/^https?:\/\//i, "");
  },

  // ── iOS : ouvrir dans Infuse ────────────────────────────────────
  openInfuse(){
    if(!this._item) return;
    const url = (this._item.url || this._item.stream_url || "").trim();
    if(!url) return;
    window.location.href = "infuse://x-callback-url/play?url=" + encodeURIComponent(url);
  },

  // ── AVPlayer natif iOS via <video> + webkitEnterFullscreen() ────
  // Méthode dans PipPlayer pour être accessible depuis open() (portée globale)
  _openAVPlayer(item){
    const url = (item.url || item.stream_url || "").trim();
    if(!url) return;

    // Détection mixed-content : flux HTTP sur page HTTPS → bloqué par le navigateur mobile
    const isHttp = /^http:/i.test(url);
    const isHttps = location.protocol === "https:";
    if(isHttp && isHttps){
      // Fallback direct vers le lecteur overlay (HLS.js tentera de charger nativement)
      this._openOverlay(item);
      return;
    }

    document.getElementById("_avp")?.remove();

    const vid = document.createElement("video");
    vid.id       = "_avp";
    vid.controls = true;
    vid.setAttribute("x-webkit-airplay", "allow");
    // PAS de playsinline → iOS utilise le lecteur natif plein écran
    // Doit être visible dans le layout (≥ 1px) pour que webkitEnterFullscreen fonctionne
    vid.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0.01;z-index:9998;pointer-events:none";
    vid.src = url;
    document.body.appendChild(vid);

    // Appels synchrones dans le geste utilisateur — iOS met en file d'attente
    // et entre en plein écran dès que le flux est prêt
    vid.play().catch(() => {});
    if(typeof vid.webkitEnterFullscreen === "function"){
      try { vid.webkitEnterFullscreen(); } catch(e) { console.warn("[AVP]", e); }
    }

    // Sauvegarde progression — utilise progress_key pour les séries, itemKey sinon
    let _pt;
    vid.addEventListener("timeupdate", () => {
      clearTimeout(_pt);
      _pt = setTimeout(() => {
        if(vid.currentTime < 5) return;
        const k = item.progress_key || itemKey(item);
        const t = Math.floor(vid.currentTime);
        const d = (vid.duration && isFinite(vid.duration)) ? Math.floor(vid.duration) : 0;
        const pct = d > 0 ? t / d : 0;
        if(pct > 0.01 && pct < 0.98){
          const p = getProg();
          p[k] = { t, d, ts: Date.now() };
          storeSet(STORE.progress, p);
        }
      }, 5000);
    });

    // Reprendre depuis la progression sauvegardée (supporte les deux formats)
    vid.addEventListener("loadedmetadata", () => {
      const k     = item.progress_key || itemKey(item);
      const saved = getProg()[k];
      if(!saved) return;
      if(saved.t > 10 && saved.t < (vid.duration || Infinity) - 30)
        vid.currentTime = saved.t;
      else if(saved.pct > 0.01 && vid.duration && isFinite(vid.duration))
        vid.currentTime = saved.pct * vid.duration;
    }, { once: true });

    // Nettoyage à la fermeture du lecteur natif + rafraîchissement "Continuer"
    const cleanup = () => {
      clearTimeout(_pt); vid.pause(); vid.src = ""; vid.remove();
      if(typeof renderContinueRow === "function") renderContinueRow();
    };
    vid.addEventListener("webkitendfullscreen", cleanup, { once: true });
    vid.addEventListener("ended",               cleanup, { once: true });

    // Fallback : si plein écran natif n'est pas disponible après 3 s
    // → lecteur overlay PipPlayer (HLS.js) plutôt que VLC
    const fbTimer = setTimeout(() => {
      if(document.getElementById("_avp")){
        cleanup();
        this._openOverlay(item);
      }
    }, 3000);
    vid.addEventListener("webkitbeginfullscreen", () => clearTimeout(fbTimer), { once: true });
    vid.addEventListener("webkitendfullscreen",   () => clearTimeout(fbTimer), { once: true });
  },

  // ── Lecteur overlay (HLS.js) — utilisé comme fallback iOS et mode navigateur ──
  _openOverlay(item){
    const url   = item.url || item.stream_url || "";
    const label = item.episode_label
      ? `${item.title} — ${item.episode_label}` : item.title || "Lecture";
    const sub   = item.episode_title || item.category_name || "";

    const el = $("pip-player");
    if(!el) return;
    el.classList.add("pip-open");
    document.body.style.overflow = "hidden";
    el.scrollTop = 0;

    $("pip-title").textContent = label;
    $("pip-sub").textContent   = sub;
    document.title = label + " — PIPSILY";
    $("pip-plot").textContent  = item.plot || "";

    this._updateEpNav();
    this._updateFavBtn();
    this._hideStatus();
    this._loadVideo(item);
  }
};

function storeGet(k, fb){
  try { const r = localStorage.getItem(k); return r ? JSON.parse(r) : fb; } catch { return fb; }
}
function storeSet(k, v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }

// ── Cache mémoire — évite des centaines de JSON.parse par render ──
let _cacheP = null; // cache progression
let _cacheF = null; // cache favoris

function getProg(){
  if(!_cacheP || typeof _cacheP !== "object" || Array.isArray(_cacheP)){
    const raw = storeGet(STORE.progress, {});
    _cacheP = (raw && typeof raw === "object" && !Array.isArray(raw)) ? raw : {};
  }
  return _cacheP;
}
function getFavs(){
  if(!Array.isArray(_cacheF)){
    const raw = storeGet(STORE.favorites, []);
    _cacheF = Array.isArray(raw) ? raw : [];
    // Nettoyage préventif si le format est corrompu (null, objet, string…)
    if(!Array.isArray(raw)){
      console.warn("[PIPSILY] Favoris corrompus en localStorage — réinitialisation.");
      storeSet(STORE.favorites, []);
    }
  }
  return _cacheF;
}
function _invalidateCache(){ _cacheP = null; _cacheF = null; }

// ── Index de progression par série — toujours frais depuis _cacheP (pas de cache séparé) ──
// _cacheP est déjà en mémoire : Object.entries dessus = ~0ms, pas besoin de double-cache.
function _getSeriesPctMap(){
  const prog = getProg(); // lit _cacheP (in-memory), pas localStorage
  const map  = {};
  const re   = /^(.+)\|\|S\d+E\d+$/;
  for(const [k, e] of Object.entries(prog)){
    const m = re.exec(k);
    if(!m || !e?.ts) continue;
    const sid = m[1];
    // Priorité : ratio t/d si les deux sont connus, sinon pct stocké (fallback HLS),
    // sinon estimation 0.5 si t>30 (durée inconnue mais visionnage confirmé)
    const pct = (e.t > 0 && e.d > 0) ? e.t / e.d
              : (e.pct > 0 ? e.pct : (e.t > 30 ? 0.5 : 0));
    if(pct <= 0) continue;
    if(!map[sid] || e.ts > map[sid].ts) map[sid] = { pct: Math.min(pct, 1), ts: e.ts };
  }
  return map;
}

// ── Retourne la position sauvegardée en ms (pour Android openPlayerAt) ──
function _getSavedProgressMs(item){
  const prog = getProg();
  // Priorité : progress_key (épisodes de série) → id numérique (VOD)
  const key  = item.progress_key || String(item.id || item.stream_id || "");
  if(key && prog[key]?.t > 10) return prog[key].t * 1000;   // secondes → ms
  return 0;
}

// ── Restaurer le focus sur la vignette jouée (TV : D-pad opérationnel dès le retour) ──
// Appelé depuis TOUS les points de sortie de onAndroidPlayerClosed
function _restoreTvFocus(){
  setTimeout(() => {
    const f = PipPlayer._lastFocus;
    PipPlayer._lastFocus = null;
    if(f && f !== document.body && f.isConnected){
      f.focus();
      f.scrollIntoView?.({ behavior:"smooth", block:"nearest" });
    } else {
      document.querySelector(".nrow-card, .card")?.focus();
    }
  }, 200);
}

// ── Callback appelé par l'APK Android quand le lecteur ExoPlayer se ferme ──
// MainActivity.reportProgress() injecte ce JS via webView.evaluateJavascript()
window.onAndroidPlayerClosed = function(url, posMs, durMs){
  if(!url || !posMs || posMs < 30000){ _restoreTvFocus(); return; }   // moins de 30s regardées → ignorer

  const t   = Math.floor(posMs / 1000);
  const d   = (durMs > 0 && isFinite(durMs)) ? Math.floor(durMs / 1000) : 0;
  const pct = d > 0 ? posMs / durMs : 0;
  if(d > 0 && pct > 0.97){ _restoreTvFocus(); return; }               // presque fini → pas besoin de reprendre
  const prog = getProg();

  // ── Épisodes de série : URL connue via _epUrlMap ────────────────
  const epKey = window._epUrlMap?.[url];
  if(epKey){
    // Si durée inconnue (d=0, typique HLS séries), stocker pct=0.5 comme
    // valeur de secours pour que la barre rouge et "Reprendre" restent visibles.
    const savePct = d > 0 ? pct : 0.5;
    prog[epKey] = { t, d, pct: savePct, ts: Date.now() };
    storeSet(STORE.progress, prog);
    _invalidateCache();
    if(typeof renderContinueRow === "function") renderContinueRow();
    // Rafraîchir la vignette de la série dans la grille + le panneau si ouvert
    const sid = epKey.split("||")[0];
    const seriesItem = (S.series || []).find(s => String(s.id || s.stream_id || "") === sid);
    if(seriesItem){
      if(typeof _refreshCardProgress === "function") _refreshCardProgress(seriesItem);
    }
    if(S.panel.open && !S.panel.isVod && typeof renderPanel === "function") renderPanel();
    _restoreTvFocus();
    return;
  }

  // ── VOD / Live : chercher l'item dans le catalogue par URL exacte ─
  const all  = [...(S.vod || []), ...(S.series || []), ...(S.live || [])];
  const item = all.find(x => (x.url || x.stream_url || "") === url);
  if(item){
    const id = String(item.id || item.stream_id || "");
    if(id) prog[id] = { t, d, ts: Date.now() };
    prog[itemKey(item)] = { pct, ts: Date.now() };
  } else {
    prog[url] = { pct, ts: Date.now() };
  }
  storeSet(STORE.progress, prog);
  _invalidateCache();
  if(typeof renderContinueRow === "function") renderContinueRow();
  if(item && typeof _refreshCardProgress === "function") _refreshCardProgress(item);

  // Restaurer le focus sur la vignette jouée (TV : D-pad opérationnel dès le retour)
  // Délai 200 ms pour laisser renderContinueRow() reconstruire le DOM
  _restoreTvFocus();
};

function getHist()  { return storeGet(STORE.history, []); }
function saveProg(key, pct){
  const p = getProg(); p[key] = { pct, ts: Date.now() };
  storeSet(STORE.progress, p); // cache déjà mis à jour (même objet)
}

function itemKey(item){
  return `${item.type || S.type}||${item.id || ""}||${item.title || ""}`;
}

// ── Met à jour la barre de progression sur toutes les vignettes d'un item ──
// Appelé par PipPlayer.close() pour rafraîchir les cartes sans re-rendre toute la grille.
function _refreshCardProgress(playedItem){
  // Pour un épisode de série, l'item qui nous intéresse est la série parente
  const isSeries = playedItem.type === "series" || !!playedItem.series_id;
  let targetItem = null;
  if(isSeries){
    const sid = String(playedItem.series_id || playedItem.id || "");
    targetItem = (S.series || []).find(s => String(s.id || s.stream_id || "") === sid);
  } else {
    targetItem = playedItem;
  }
  if(!targetItem) return;

  const key = itemKey(targetItem);
  const pct = getWatchPct(targetItem);
  document.querySelectorAll(`[data-key="${CSS.escape(key)}"]`).forEach(card => {
    // Chercher la zone image (card-media, nrow-media, nou-media)
    const media = card.querySelector(".card-media, .nrow-media, .nou-media");
    if(!media) return;
    let bar = media.querySelector(".card-prog-bar");
    if(pct > 0.03 && pct < 0.97){
      if(!bar){
        bar = document.createElement("div");
        bar.className = "card-prog-bar";
        bar.innerHTML = `<div class="card-prog-fill"></div>`;
        media.appendChild(bar);
      }
      bar.querySelector(".card-prog-fill").style.width = Math.round(pct * 100) + "%";
    } else if(bar){
      bar.remove();
    }
  });
}

// Upgrade HTTP → HTTPS si la page est servie en HTTPS (évite mixed content sur Android)
function secureUrl(url){
  if(!url) return url;
  if(location.protocol === "https:" && /^http:\/\//i.test(url))
    return url.replace(/^http:\/\//i, "https://");
  return url;
}

/**
 * Ajoute les paramètres obligatoires aux URLs de streaming Pluto TV.
 * Sans ces params le serveur retourne HTTP 400 (deviceModel manquant, etc.).
 * Appelé juste avant la lecture — les URLs stockées restent propres.
 */
function preparePlutoUrl(url){
  if(!url || !url.includes("pluto.tv/stitch/hls/channel/")) return url;
  const base = url.split("?")[0];
  return base +
    "?advertisingId=&appName=web&appVersion=unknown&clientTime=0" +
    "&deviceDNT=0&deviceId=pipsily&deviceLat=0&deviceLon=0" +
    "&deviceMake=web&deviceModel=web&deviceType=web&deviceVersion=unknown" +
    "&includeExtendedEvents=false&marketingRegion=FR&sid=&userId=";
}
function isFav(item){ return getFavs().some(x => x.key === itemKey(item)); }

// Progression de visionnage (0–1) — fonctionne avec les deux clés (PipPlayer + AVPlayer iOS)
function getWatchPct(item){
  const prog = getProg();
  const k1   = itemKey(item);                              // clé AVPlayer iOS
  if(prog[k1]?.pct > 0) return prog[k1].pct;
  const k2 = String(item.id || item.stream_id || "");     // clé PipPlayer VOD
  if(k2 && prog[k2]?.t > 0 && prog[k2]?.d > 0) return prog[k2].t / prog[k2].d;
  // Séries : progression du dernier épisode regardé (stockée sous "seriesId||SxxExx")
  if(item.type === "series" && k2) return _getSeriesPctMap()[k2]?.pct || 0;
  return 0;
}

// Timestamp de la dernière session (pour trier "Continuer à regarder")
function getWatchTs(item){
  const prog = getProg();
  const k1   = itemKey(item);
  if(prog[k1]?.ts) return prog[k1].ts;
  const k2 = String(item.id || item.stream_id || "");
  if(k2 && prog[k2]?.ts) return prog[k2].ts;
  return 0;
}

function toggleFav(item){
  const favs = getFavs();
  const key  = itemKey(item);
  const idx  = favs.findIndex(x => x.key === key);
  if(idx >= 0) favs.splice(idx, 1);
  else favs.unshift({ key, item, at: Date.now() });
  _cacheF = favs.slice(0, 500);             // mettre à jour le cache
  storeSet(STORE.favorites, _cacheF);
  const fav = isFav(item);
  document.querySelectorAll(`.card[data-key="${CSS.escape(key)}"] .fav-btn`).forEach(b => {
    b.classList.toggle("is-fav", fav);
  });
  // Rafraîchir la section Favoris
  if(typeof renderFavoritesRow === "function") renderFavoritesRow();
}

function pushHist(item){
  const h = getHist().filter(x => x.key !== itemKey(item));
  h.unshift({ key: itemKey(item), item, at: Date.now() });
  storeSet(STORE.history, h.slice(0, 300));
}

// ─────────────────────────────────────────────────────────────────
//  NETTOYAGE TITRES
// ─────────────────────────────────────────────────────────────────

function cleanTitle(t){
  if(!t) return "";
  let s = String(t);
  s = s.replace(/^(FR|SRS|EN|VOD|SERIE)\s*[-|:]\s*/i, "");
  s = s.replace(/\s*(?:group-title|tvg-\w+)\s*=\s*"[^"]*"/gi, "");
  s = s.replace(/\.(mkv|mp4|ts|m3u8|avi|mov)$/i, "");
  s = s.replace(/\s*\(\d{4}\)\s*$/, "");
  return s.replace(/\s+/g, " ").trim();
}

// "NomSérie - S01E01 - Titre épisode"  →  "Titre épisode"
function cleanEpTitle(raw, seriesTitle){
  if(!raw) return "";
  let s = String(raw);
  // Supprimer préfixe "NomSérie - S01E01 - "
  const re = new RegExp("^" + seriesTitle.replace(/[.*+?^${}()|[\]\\]/g,"\\$&") + "\\s*[-–]\\s*S\\d+E\\d+\\s*[-–]\\s*", "i");
  s = s.replace(re, "");
  // Supprimer juste "S01E01 - " en tête
  s = s.replace(/^S\d+E\d+\s*[-–]\s*/i, "");
  s = cleanTitle(s);
  return s || "";
}

function inferQuality(src){
  const t = String(src || "").toLowerCase();
  if(/\b(4k|uhd|2160p?)\b/.test(t)) return "4K";
  if(/\b(fhd|full[\s-]?hd|1080p?|hd|720p?)\b/.test(t)) return "HD";
  if(/\b(sd|480p?|360p?)\b/.test(t)) return "SD";
  return "";
}

// ─────────────────────────────────────────────────────────────────
//  PARSING M3U
// ─────────────────────────────────────────────────────────────────

function parseM3U(text, type){
  const lines = text.split(/\r?\n/);
  const out   = [];
  let cur     = null;

  for(const raw of lines){
    const line = raw.trim();
    if(!line) continue;

    if(line.startsWith("#EXTINF:")){
      const group = (line.match(/group-title="([^"]+)"/i) || [,"Autre"])[1];
      const logo  = (line.match(/tvg-logo="([^"]+)"/i)    || [,""])[1];
      const title = line.includes(",") ? line.split(",").slice(1).join(",").trim() : "Sans titre";
      cur = { title: cleanTitle(title), category_name: cleanTitle(group),
              stream_icon: logo, quality: inferQuality(`${title} ${group}`) };

    } else if(!line.startsWith("#") && cur){
      out.push({
        id            : out.length,
        title         : cur.title,
        category_name : cur.category_name,
        stream_icon   : cur.stream_icon,
        stream_url    : line,
        url           : line,
        plot          : "",
        type,
        quality       : cur.quality,
        _xtream       : type === "series" && line.includes("get_series_info"),
        episodes      : {},
        seasons       : []
      });
      cur = null;
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────
//  NORMALISATION JSON
// ─────────────────────────────────────────────────────────────────

function normalizeItems(arr, type){
  return (Array.isArray(arr) ? arr : []).map((x, i) => ({
    id            : x.id || x.stream_id || x.series_id || String(i),
    title         : cleanTitle(x.title || x.name || "Sans titre"),
    category_id   : x.category_id || "",
    category_name : cleanTitle(x.category_name || x.category || "Autre"),
    stream_icon   : x.stream_icon || x.image || x.cover || x.poster || "",
    stream_url    : x.url || x.stream_url || "",
    url           : x.url || x.stream_url || "",
    plot          : x.plot || x.description || x.overview || "",
    type,
    quality       : inferQuality([x.title, x.name, x.category_name, x.plot].join(" ")),
    added         : x.added || 0,
    _xtream       : type === "series" && !!(x.url || x.stream_url || "").includes("get_series_info"),
    episodes      : {},
    seasons       : []
  }));
}

function extractArr(raw){
  if(Array.isArray(raw)) return raw;
  if(!raw || typeof raw !== "object") return [];
  for(const k of ["items","streams","channels","movies","series","vod"]){
    if(Array.isArray(raw[k])) return raw[k];
  }
  return [];
}

// ─────────────────────────────────────────────────────────────────
//  FETCH HELPERS
// ─────────────────────────────────────────────────────────────────

async function fetchJson(url){
  try { const r = await fetch(url); return r.ok ? r.json() : null; } catch { return null; }
}
async function fetchText(url){
  try { const r = await fetch(url); return r.ok ? r.text() : null; } catch { return null; }
}

// ─────────────────────────────────────────────────────────────────
//  BASE ÉPISODES PRÉ-GÉNÉRÉE (episodes_part*.json)
// ─────────────────────────────────────────────────────────────────

// Map series_id → numéro de chunk (téléchargé une seule fois)
let _epMap = null;         // { "51596": 3, "18": 1, ... }
let _epMapPromise = null;
// Cache des chunks déjà téléchargés
const _loadedChunks = {};  // { 1: Promise, 3: Promise, ... }

async function getEpMap(){
  if(_epMap) return _epMap;
  if(_epMapPromise) return _epMapPromise;
  _epMapPromise = fetchJson("episodes_map.json").then(m => {
    _epMap = m || {};
    console.log(`[PIPSILY] epMap : ${Object.keys(_epMap).length} séries indexées`);
    return _epMap;
  });
  return _epMapPromise;
}

async function ensureEpDb(seriesId){
  const map = await getEpMap();
  const chunkNum = seriesId ? map[String(seriesId)] : null;
  if(!chunkNum) return false; // série absente de l'index

  if(!_loadedChunks[chunkNum]){
    _loadedChunks[chunkNum] = fetchJson(`episodes_part${chunkNum}.json`).then(chunk => {
      if(chunk && typeof chunk === "object") Object.assign(S.epDb, chunk);
      console.log(`[PIPSILY] chunk ${chunkNum} chargé (${Object.keys(chunk||{}).length} séries)`);
    });
  }
  await _loadedChunks[chunkNum];
  return true;
}

// ─────────────────────────────────────────────────────────────────
//  XTREAM CODES — CHARGEMENT ÉPISODES
// ─────────────────────────────────────────────────────────────────
//
//  URL de la série : http://host/player_api.php?username=X&password=Y&action=get_series_info&series_id=Z
//
//  Réponse API :
//  {
//    info    : { plot, cover, ... }
//    seasons : [ { season_number, name, cover, episode_count } ]
//    episodes: {
//      "1" : [ { id, episode_num, title, url, container_extension, info:{plot,movie_image} } ]
//    }
//  }
//
//  URL d'un épisode :
//    - ep.url directement (si présente et valide)
//    - sinon : base/series/username/password/ep.id.ext

function parseXtreamCreds(apiUrl){
  try {
    const p = new URL(apiUrl);
    return {
      base     : p.origin,
      username : p.searchParams.get("username") || "",
      password : p.searchParams.get("password") || "",
    };
  } catch { return null; }
}

function buildEpUrl(apiUrl, ep){
  // URL directe dans l'épisode (source la plus fiable)
  if(ep.url && !ep.url.includes("player_api") && !ep.url.includes("get_series_info")){
    return secureUrl(ep.url);
  }
  // Reconstruction Xtream
  const x = parseXtreamCreds(apiUrl);
  if(x && x.username && x.password && ep.id && !String(ep.id).includes("-")){
    const ext = ep.container_extension || "mkv";
    return secureUrl(`${x.base}/series/${x.username}/${x.password}/${ep.id}.${ext}`);
  }
  return "";
}

async function loadEpisodes(series){
  const cacheKey = `s_${series.id}_${series.title}`;
  if(S.epCache[cacheKey]) return S.epCache[cacheKey];

  // ── 1. Base pré-générée (charge uniquement le chunk nécessaire) ──
  const sid = String(series.id || "");
  await ensureEpDb(sid); // télécharge 1 fichier ~4MB au lieu de 21MB
  if(sid && S.epDb[sid]){
    const db = S.epDb[sid];
    const seasonsMap = {};
    Object.entries(db.seasons || {}).forEach(([sk, epList]) => {
      seasonsMap[String(sk)] = epList.map(ep => ({
        id                 : ep.id,
        episode_num        : ep.episode_num,
        season             : ep.season,
        title              : cleanEpTitle(ep.title || "", series.title) || `Épisode ${ep.episode_num}`,
        url                : ep.url,        // URL HTTP goldenlink.live — intent Android
        stream_url         : ep.url,
        container_extension: ep.ext || "mkv",
        duration           : ep.duration || "",
        plot               : ep.plot || "",
        thumb              : ep.thumb || ""
      }));
    });
    const seasonsMeta = (db.seasonsMeta || []).map(s => ({
      num  : s.num,
      name : s.name || `Saison ${s.num}`,
      cover: s.cover || "",
      count: s.count || 0
    }));
    // Enrichir les métadonnées de la série
    if(db.meta){
      if(!series.plot        && db.meta.plot)  series.plot        = db.meta.plot;
      if(!series.stream_icon && db.meta.cover) series.stream_icon = db.meta.cover;
    }
    const result = { seasonsMap, seasonsMeta };
    S.epCache[cacheKey] = result;
    return result;
  }

  // ── 2. Fallback : API Xtream en direct ──
  const rawApiUrl = series.stream_url || series.url || "";
  if(!rawApiUrl) return { seasonsMap: {}, seasonsMeta: [] };

  // Toujours utiliser HTTP (goldenlink.live n'a pas HTTPS)
  const isNativeApk = typeof window.AndroidBridge !== "undefined";
  const apiUrl = rawApiUrl.replace(/^https?:\/\//i, "http://");

  // Timeout 12s + gestion CORS/réseau
  let data = null;

  // APK : AndroidBridge.fetchJson() depuis Java (pas de restriction mixed content)
  if(isNativeApk && typeof window.AndroidBridge?.fetchJson === "function"){
    try {
      const raw = window.AndroidBridge.fetchJson(apiUrl);
      if(raw) data = JSON.parse(raw);
    } catch {}
  }

  // Fallback navigateur fetch() (fonctionne si MIXED_CONTENT_ALWAYS_ALLOW)
  if(!data){
    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 12000);
      const r = await fetch(apiUrl, { signal: controller.signal });
      clearTimeout(tid);
      data = r.ok ? await r.json() : null;
    } catch(e) { data = null; }
  }

  if(!data) return { seasonsMap: {}, seasonsMeta: [], directOnly: true };

  const seasonsMap = {};

  // ── Épisodes ──
  // La réponse Xtream a : data.episodes = { "1": [...], "2": [...] }
  const rawEps = data.episodes;
  if(rawEps && typeof rawEps === "object"){
    Object.entries(rawEps).forEach(([sk, epList]) => {
      if(!Array.isArray(epList)) return;
      const key = String(sk);
      seasonsMap[key] = epList
        .filter(ep => ep && (ep.id || ep.episode_num))
        .map(ep => {
          const url = buildEpUrl(apiUrl, ep);
          return {
            id                 : ep.id,
            episode_num        : Number(ep.episode_num) || 1,
            season             : Number(ep.season || sk),
            title              : cleanEpTitle(ep.title || ep.name || "", series.title) || `Épisode ${ep.episode_num}`,
            url,
            stream_url         : url,
            container_extension: ep.container_extension || "mkv",
            duration           : ep.info?.duration || "",
            plot               : ep.info?.plot || "",
            thumb              : ep.info?.movie_image || ""
          };
        })
        .sort((a, b) => a.episode_num - b.episode_num);
    });
  }

  // ── Métadonnées saisons ──
  let seasonsMeta = [];
  if(Array.isArray(data.seasons)){
    seasonsMeta = data.seasons
      .filter(s => s.season_number > 0)
      .sort((a, b) => a.season_number - b.season_number)
      .map(s => ({
        num   : s.season_number,
        name  : s.name || `Saison ${s.season_number}`,
        cover : s.cover_big || s.cover || "",
        count : s.episode_count || 0
      }));
  }

  // Enrichir les métadonnées de la série depuis l'API
  if(data.info){
    if(!series.plot)        series.plot         = data.info.plot || data.info.description || "";
    if(!series.stream_icon) series.stream_icon  = data.info.cover || data.info.movie_image || "";
  }

  const result = { seasonsMap, seasonsMeta };
  S.epCache[cacheKey] = result;
  return result;
}

// ─────────────────────────────────────────────────────────────────
//  PANNEAU VOD (film — synopsis + bouton lecture)
// ─────────────────────────────────────────────────────────────────

function getExt(url){
  if(!url) return "";
  return (url.split("?")[0].split(".").pop() || "").toLowerCase();
}

function openVodPanel(item){
  S.panel.lastFocus = document.activeElement;
  S.panel.open     = true;
  S.panel.series   = item;
  S.panel.isVod    = true;

  document.body.style.overflow = "hidden";
  const panel = $("seriesPanel");
  panel.hidden = false;
  // Pousse un état dans l'historique → Android Back = goBack() → popstate → ferme le panneau
  history.pushState({pip:"vod"}, "");

  const ext     = getExt(item.stream_url || item.url || "");
  const meta    = [item.category_name, item.quality, ext ? ext.toUpperCase() : ""].filter(Boolean).join(" · ");
  const cover   = item.stream_icon || "";
  const plot    = item.plot || "";

  // ── Progression sauvegardée ──
  const savedMs = _getSavedProgressMs(item);
  const _fmtMs  = ms => { const m = Math.floor(ms/60000); const s = String(Math.floor((ms%60000)/1000)).padStart(2,"0"); return `${m}:${s}`; };
  const _pctSaved = (() => {
    const prog = getProg();
    const id   = String(item.id || item.stream_id || "");
    return (id && prog[id]?.d > 0) ? Math.round(prog[id].t / prog[id].d * 100) : 0;
  })();

  panel.innerHTML = `
    <div class="sp-header">
      <div class="sp-hinfo">
        <div class="sp-kicker">🎬 Film</div>
        <h3 class="sp-title">${esc(item.title)}</h3>
        ${meta ? `<div class="sp-meta">${esc(meta)}</div>` : ""}
      </div>
      <button id="vodCloseBtn" class="sp-close" aria-label="Fermer">✕</button>
    </div>

    <div class="sp-body">
      <div class="sp-hero">
        ${cover
          ? `<img class="sp-cover" src="${esc(cover)}" alt="" loading="lazy" onerror="this.style.display='none'">`
          : `<div class="sp-cover sp-nocover">🎬</div>`}
        <div class="sp-hero-txt">
          <p class="sp-plot" id="vodPlot">${esc(plot || "Chargement du synopsis…")}</p>
        </div>
      </div>

      <div class="vod-actions">
        ${savedMs > 0
          ? `<button id="vodResumeBtn" class="vod-play-btn">
               <span class="vod-play-icon">▶</span>
               <span>Reprendre${_pctSaved ? ` — ${_pctSaved}%` : ` à ${_fmtMs(savedMs)}`}</span>
             </button>
             <button id="vodRestartBtn" class="vod-restart-btn">
               ↩ Début
             </button>`
          : `<button id="vodPlayBtn" class="vod-play-btn">
               <span class="vod-play-icon">▶</span>
               <span>Lire le film</span>
             </button>`}
        <button class="fav-btn-large ${isFav(item) ? "is-fav" : ""}" id="vodFavBtn" type="button">
          <span class="fav-heart">♥</span>
          <span id="vodFavLabel">${isFav(item) ? "Favori" : "Ajouter aux favoris"}</span>
        </button>
      </div>
    </div>`;

  // ── Bind events ──
  $("vodCloseBtn").addEventListener("click", closeVodPanel);
  panel.addEventListener("click", e => { if(e.target === panel) closeVodPanel(); }, { once: true });

  if(savedMs > 0){
    $("vodResumeBtn").addEventListener("click", () => { closeVodPanel(); playItem(item); });
    $("vodRestartBtn").addEventListener("click", () => {
      // Supprimer la progression sauvegardée puis lire depuis le début
      const prog = getProg();
      const id   = String(item.id || item.stream_id || "");
      if(id) delete prog[id];
      delete prog[itemKey(item)];
      storeSet(STORE.progress, prog);
      _invalidateCache();
      closeVodPanel();
      playItem(item);
    });
  } else {
    $("vodPlayBtn").addEventListener("click", () => { closeVodPanel(); playItem(item); });
  }

  $("vodFavBtn").addEventListener("click", () => {
    toggleFav(item);
    const fav = isFav(item);
    $("vodFavBtn").classList.toggle("is-fav", fav);
    const lbl = $("vodFavLabel");
    if(lbl) lbl.textContent = fav ? "Favori" : "Ajouter aux favoris";
  });

  // ── Focus initial (TV / D-pad) — Entrée joue directement ──
  setTimeout(() => ($("vodResumeBtn") || $("vodPlayBtn"))?.focus(), 80);

  // ── Lazy-load synopsis depuis l'API si absent ──
  if(!plot){
    fetchVodPlot(item).then(p => {
      const el = $("vodPlot");
      if(el) el.textContent = p || "Aucun synopsis disponible.";
      if(p) item.plot = p; // cache dans l'item pour ne pas re-fetcher
    });
  }
}

async function fetchVodPlot(item){
  const streamUrl = item.stream_url || item.url || "";
  if(!streamUrl) return null;

  // ── Extraire credentials depuis l'URL Xtream ──────────────────────
  let username = "", password = "", base = "";
  try {
    const u = new URL(streamUrl);
    base = u.origin;
    const pts = u.pathname.split("/").filter(Boolean);
    if((pts[0]==="movie"||pts[0]==="series"||pts[0]==="live") && pts.length >= 4){
      username = pts[1]; password = pts[2];
    } else if(!u.search && pts.length >= 3 && !pts[0].includes(".")){
      // Format /user/pass/id sans préfixe
      username = pts[0]; password = pts[1];
    } else {
      username = u.searchParams.get("username") || "";
      password = u.searchParams.get("password") || "";
    }
  } catch { return null; }

  if(!username || !password) return null;
  const vodId = item.id || item.stream_id || String(item.num || "");
  if(!vodId) return null;

  // Toujours HTTP pour les API Xtream (la plupart ne supportent pas HTTPS)
  const apiUrl = base.replace(/^https?:/, "http:") +
    `/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&action=get_vod_info&vod_id=${vodId}`;

  let json = null;

  // ── Option 1 : Bridge Android natif (contourne le blocage CORS du WebView) ──
  if(typeof window.AndroidBridge?.fetchUrlAsync === "function"){
    json = await new Promise(resolve => {
      const cbName = "_vodPlotCb" + Date.now();
      const timer  = setTimeout(() => { delete window[cbName]; resolve(null); }, 12000);
      window[cbName] = (b64, ok) => {
        clearTimeout(timer); delete window[cbName];
        if(!ok){ resolve(null); return; }
        try { resolve(JSON.parse(atob(b64))); } catch { resolve(null); }
      };
      window.AndroidBridge.fetchUrlAsync(apiUrl, cbName);
    });
  }
  // ── Option 2 : fetch standard (bloqué par CORS sur beaucoup de serveurs IPTV) ──
  else {
    try {
      const ctrl = new AbortController();
      const tid  = setTimeout(() => ctrl.abort(), 8000);
      const r    = await fetch(apiUrl, { signal: ctrl.signal });
      clearTimeout(tid);
      if(r.ok) json = await r.json();
    } catch { /* CORS ou réseau */ }
  }

  if(!json) return null;
  return json?.info?.plot || json?.info?.description || json?.movie_data?.plot || null;
}

function closeVodPanel(_fromPopstate){
  if(!S.panel.open && !S.panel.isVod) return;
  const needBack = !_fromPopstate && history.state?.pip === "vod";
  S.panel.open  = false;
  S.panel.isVod = false;
  $("seriesPanel").hidden = true;
  document.body.style.overflow = "";
  // Restaurer le focus sur la vignette d'origine
  const prev = S.panel.lastFocus;
  S.panel.lastFocus = null;
  if(prev && prev.isConnected){
    requestAnimationFrame(() => {
      prev.focus({ preventScroll: true });
      prev.scrollIntoView({ behavior:"smooth", block:"nearest" });
    });
  }
  if(needBack) history.back();
}

// ─────────────────────────────────────────────────────────────────
//  PANNEAU SÉRIES
// ─────────────────────────────────────────────────────────────────

function openPanel(series){
  S.panel.lastFocus  = document.activeElement;
  S.panel.open       = true;
  S.panel.series     = series;
  S.panel.seasonsMap = {};
  S.panel.seasonsMeta= [];
  S.panel.selSeason  = null;

  document.body.style.overflow = "hidden";
  history.pushState({pip:"series"}, "");

  const panel = $("seriesPanel");
  panel.hidden = false;
  panel.innerHTML = buildPanelLoading(series);
  bindClose();

  loadEpisodes(series).then(({ seasonsMap, seasonsMeta, directOnly }) => {
    S.panel.seasonsMap  = seasonsMap;
    S.panel.seasonsMeta = seasonsMeta;
    S.panel.directOnly  = directOnly || false;
    const keys = Object.keys(seasonsMap).sort((a,b) => Number(a)-Number(b));
    S.panel.selSeason = keys[0] || null;
    renderPanel();
  });
}

function closePanel(_fromPopstate){
  if(!S.panel.open) return;
  const needBack = !_fromPopstate && history.state?.pip === "series";
  S.panel.open = false;
  $("seriesPanel").hidden = true;
  document.body.style.overflow = "";
  // Restaurer le focus sur la vignette d'origine
  const prev = S.panel.lastFocus;
  S.panel.lastFocus = null;
  if(prev && prev.isConnected){
    requestAnimationFrame(() => {
      prev.focus({ preventScroll: true });
      prev.scrollIntoView({ behavior:"smooth", block:"nearest" });
    });
  }
  if(needBack) history.back();
}

function bindClose(){
  $("seriesCloseBtn")?.addEventListener("click", closePanel);
}

function buildPanelLoading(s){
  const cover = s.stream_icon || "";
  return `
    <div class="sp-header">
      <div class="sp-hinfo">
        <div class="sp-kicker">Série</div>
        <h3 class="sp-title">${esc(s.title)}</h3>
      </div>
      <button id="seriesCloseBtn" class="sp-close">✕</button>
    </div>
    <div class="sp-body">
      <div class="sp-hero">
        ${cover
          ? `<img class="sp-cover" src="${esc(cover)}" alt="" loading="lazy">`
          : `<div class="sp-cover sp-nocover">🎬</div>`}
        <div class="sp-hero-txt">
          <p class="sp-plot">${esc(s.plot || "Chargement…")}</p>
          <div class="sp-loading"><span class="sp-spin"></span> Chargement des saisons…</div>
        </div>
      </div>
    </div>`;
}

function renderPanel(){
  const panel = $("seriesPanel");
  if(!panel || !S.panel.series) return;

  const s          = S.panel.series;
  const smap       = S.panel.seasonsMap;
  const smeta      = S.panel.seasonsMeta;
  const sel        = S.panel.selSeason;
  const keys       = Object.keys(smap).sort((a,b) => Number(a)-Number(b));
  const totalEps   = Object.values(smap).reduce((n,a) => n+a.length, 0);

  const metaLine = [
    s.category_name,
    keys.length  ? `${keys.length} saison${keys.length>1?"s":""}` : "",
    totalEps     ? `${totalEps} épisode${totalEps>1?"s":""}` : ""
  ].filter(Boolean).join(" · ");

  // ── Onglets saisons ──
  let tabsHtml = "";
  if(keys.length > 1){
    tabsHtml = `<div class="sp-tabs">` +
      keys.map(sk => {
        const m     = smeta.find(x => String(x.num)===sk);
        const label = m ? m.name : `Saison ${sk}`;
        const cnt   = smap[sk]?.length || 0;
        return `<button class="sp-tab${sk===sel?" sp-tab--active":""}"
                  data-season="${esc(sk)}" type="button">
                  ${esc(label)}
                  <span class="sp-tab-cnt">${cnt} ép.</span>
                </button>`;
      }).join("") +
    `</div>`;
  } else if(keys.length === 1){
    const m     = smeta.find(x => String(x.num)===keys[0]);
    const label = m ? m.name : `Saison ${keys[0]}`;
    tabsHtml = `<div class="sp-onesaison">${esc(label)}</div>`;
  }

  // ── Épisodes de la saison sélectionnée ──
  let epsHtml = "";

  if(!sel || keys.length === 0){
    // Pas d'épisodes chargés
    if(S.panel.directOnly){
      // Série non trouvée dans la base locale et API non joignable
      epsHtml = `
        <div class="sp-noep-block">
          <div style="font-size:36px;margin-bottom:12px">📭</div>
          <div style="font-weight:700;font-size:16px;margin-bottom:8px">Épisodes non disponibles</div>
          <div style="font-size:13px;color:#8ca8cc;line-height:1.5">
            Cette série n'est pas encore dans notre base de données locale.<br>
            Relancez <code>node fetch_episodes.js</code> pour mettre à jour.
          </div>
        </div>`;
    } else {
      epsHtml = `<div class="sp-noep">Aucune saison disponible pour cette série.</div>`;
    }
  } else {
    const eps  = smap[sel] || [];
    const m    = smeta.find(x => String(x.num)===sel);
    const covr = m?.cover && m.cover.length > 40 ? m.cover : "";

    if(covr) epsHtml += `<div class="sp-scov"><img src="${esc(covr)}" alt="" loading="lazy"></div>`;

    if(!eps.length){
      epsHtml += `<div class="sp-noep">Aucun épisode dans cette saison.</div>`;
    } else {
      epsHtml += `<div class="sp-eplist">`;
      eps.forEach((ep, idx) => {
        const code  = `S${String(sel).padStart(2,"0")}E${String(ep.episode_num).padStart(2,"0")}`;
        const progK = `${s.id}||${code}`;
        const _pe   = getProg()[progK] || {};
        const pct   = (_pe.t > 0 && _pe.d > 0) ? Math.round(_pe.t / _pe.d * 100)
                    : (_pe.pct > 0 ? Math.round(_pe.pct * 100) : (_pe.t > 30 ? 50 : 0));
        const done  = pct >= 90;
        const hasUrl= !!ep.url;

        epsHtml += `
          <button class="sp-ep${done?" sp-ep--done":""}${!hasUrl?" sp-ep--locked":""}"
            data-season="${esc(sel)}" data-idx="${idx}" type="button"
            ${!hasUrl?"disabled":""}
            title="${hasUrl ? esc(ep.title) : "URL non disponible"}">

            ${ep.thumb
              ? `<img class="sp-ep-img" src="${esc(ep.thumb)}" alt="" loading="lazy">`
              : `<div class="sp-ep-img sp-ep-img--blank"></div>`}

            <div class="sp-ep-info">
              <span class="sp-ep-code">${esc(code)}</span>
              <span class="sp-ep-title">${esc(ep.title || "Sans titre")}</span>
              ${ep.duration ? `<span class="sp-ep-dur">${esc(ep.duration)}</span>` : ""}
              ${ep.plot     ? `<span class="sp-ep-plot">${esc(ep.plot.substring(0,120))}${ep.plot.length>120?"…":""}</span>` : ""}
            </div>

            <div class="sp-ep-status">
              ${done        ? `<span class="sp-check">✓</span>`                  : ""}
              ${!done&&pct>2? `<span class="sp-pct">${Math.round(pct)}%</span>` : ""}
              ${hasUrl      ? `<span class="sp-play">▶</span>`
                            : `<span class="sp-lock">–</span>`}
            </div>
          </button>
          ${pct>2 ? `<div class="sp-prog"><div class="sp-prog-fill" style="width:${Math.min(pct,100)}%"></div></div>` : ""}`;
      });
      epsHtml += `</div>`;
    }
  }

  // ── Trouver le dernier épisode regardé (en cours ou terminé) ──
  let lastWatched = null;
  {
    const prog = getProg();
    const sIdEsc  = String(s.id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const epKeyRe = new RegExp(`^${sIdEsc}\\|\\|(S(\\d+)E(\\d+))$`);
    let lastTs = 0;
    const progKeys = Object.keys(prog).filter(k => epKeyRe.test(k));
    console.log(`[PIPSILY] Série "${s.title}" (id=${s.id}) — clés progression:`, progKeys.length ? progKeys : "(aucune)");
    progKeys.forEach(k => {
      const m = epKeyRe.exec(k);
      if(!m) return;
      const en = prog[k];
      if(!en?.ts || en.ts <= lastTs) return;
      const tSec = en.t || 0;
      const dSec = (en.d && isFinite(en.d)) ? en.d : 0;
      const pct  = dSec > 0 ? tSec / dSec : (en.pct || 0);
      console.log(`  ${k} →`, { t: tSec, d: dSec, pct: Math.round(pct*100)+"%" });
      // Accepte les deux formats : {t,d,ts} (PipPlayer) et {pct,ts} (AVPlayer/ancien)
      if(tSec > 10 || pct > 0.01){
        lastWatched = { code: m[1], sn: String(Number(m[2])), en: m[3], pct, tSec, progK: k };
        lastTs = en.ts;
      }
    });
    console.log(`[PIPSILY] lastWatched:`, lastWatched || "(aucun)");
  }

  // ── Premier épisode (pour Regarder / Début) ──
  let firstEp = null, firstSk = null;
  {
    const firstSeason = keys[0];
    if(firstSeason && smap[firstSeason]?.length){
      firstEp = smap[firstSeason].find(e => !!e.url) || null;
      firstSk = firstSeason;
    }
  }

  // ── Prochain épisode à afficher sur le bouton (si lastWatched est terminé) ──
  let nextEpCode = null;
  if(lastWatched?.pct >= 0.95){
    const _orderedAll = [];
    keys.forEach(sk => (smap[sk]||[]).forEach(ep => _orderedAll.push({ sk, ep })));
    const _curI = _orderedAll.findIndex(({sk, ep}) =>
      Number(sk) === Number(lastWatched.sn) && Number(ep.episode_num) === Number(lastWatched.en));
    if(_curI >= 0 && _curI + 1 < _orderedAll.length){
      const nxt = _orderedAll[_curI + 1];
      nextEpCode = `S${String(nxt.sk).padStart(2,"0")}E${String(nxt.ep.episode_num).padStart(2,"0")}`;
    }
  }

  // ── Rendu HTML complet ──
  panel.innerHTML = `
    <div class="sp-header">
      <div class="sp-hinfo">
        <div class="sp-kicker">Série</div>
        <h3 class="sp-title">${esc(s.title)}</h3>
        ${metaLine ? `<div class="sp-meta">${esc(metaLine)}</div>` : ""}
      </div>
      <button id="seriesCloseBtn" class="sp-close">✕</button>
    </div>

    <div class="sp-body">
      <div class="sp-hero">
        ${s.stream_icon
          ? `<img class="sp-cover" src="${esc(s.stream_icon)}" alt="" loading="lazy">`
          : `<div class="sp-cover sp-nocover">🎬</div>`}
        <div class="sp-hero-txt">
          <p class="sp-plot">${esc(s.plot || "Aucun synopsis disponible.")}</p>
        </div>
      </div>

      <!-- Actions série : Reprendre / Début / Regarder + Favoris -->
      <div class="sp-series-actions">
        ${lastWatched
          ? `<button id="seriesResumeBtn" class="vod-play-btn" type="button">
               <span class="vod-play-icon">▶</span>
               <span>${lastWatched.pct >= 0.95
                 ? "Épisode suivant · " + (nextEpCode || lastWatched.code)
                 : "Reprendre · " + lastWatched.code + (lastWatched.pct > 0.01 ? " — " + Math.round(lastWatched.pct * 100) + "%" : "")
               }</span>
             </button>
             ${firstEp ? `<button id="seriesRestartBtn" class="vod-restart-btn" type="button">↩ Depuis le début</button>` : ""}`
          : (firstEp
              ? `<button id="seriesPlayBtn" class="vod-play-btn" type="button">
                   <span class="vod-play-icon">▶</span>
                   <span>Regarder la série</span>
                 </button>`
              : "")}
        <button class="fav-btn-large ${isFav(s) ? "is-fav" : ""}" id="seriesFavBtn" type="button">
          <span class="fav-heart">♥</span>
          <span id="seriesFavLabel">${isFav(s) ? "Favori" : "Ajouter aux favoris"}</span>
        </button>
      </div>

      ${tabsHtml}

      <div id="spEps">${epsHtml}</div>
    </div>

    `;

  bindClose();

  // ── Helper : retrouve {ep, sk} par numéro de saison+épisode (robuste aux clés "2" vs "02") ──
  function _findEpBySE(targetSn, targetEn){
    for(const [sk, epList] of Object.entries(smap)){
      if(Number(sk) !== targetSn) continue;
      const ep = epList.find(e => Number(e.episode_num) === targetEn);
      if(ep) return { ep, sk };
    }
    return null;
  }

  // ── Helper : liste ordonnée de tous les épisodes ──
  function _allEpsOrdered(){
    const arr = [];
    Object.keys(smap).sort((a,b)=>Number(a)-Number(b)).forEach(sk =>
      (smap[sk]||[]).forEach(ep => arr.push({ sk, ep })));
    return arr;
  }

  // Bouton Reprendre / Épisode suivant
  $("seriesResumeBtn")?.addEventListener("click", () => {
    if(!lastWatched) return;
    const targetSn = Number(lastWatched.sn);
    const targetEn = Number(lastWatched.en);

    if(lastWatched.pct >= 0.95){
      // Épisode terminé → chercher le suivant dans la liste ordonnée
      const all = _allEpsOrdered();
      const curIdx = all.findIndex(({sk, ep}) =>
        Number(sk) === targetSn && Number(ep.episode_num) === targetEn);
      if(curIdx >= 0 && curIdx + 1 < all.length){
        const next = all[curIdx + 1];
        if(next.ep.url){ playEpisode(s, next.ep, next.sk); return; }
      }
      // Fin de série ou pas d'épisode suivant : reprise de l'épisode en cours
    }

    // Reprendre l'épisode en cours (ou dernier si fin de série)
    const found = _findEpBySE(targetSn, targetEn);
    if(found) playEpisode(s, found.ep, found.sk);
  });

  // Bouton Début série (premier épisode)
  $("seriesRestartBtn")?.addEventListener("click", () => {
    if(!firstEp || !firstSk) return;
    // Supprimer TOUTE la progression de cette série (tous les épisodes déjà vus)
    const prog   = getProg();
    const prefix = String(s.id) + "||";
    Object.keys(prog).forEach(k => { if(k.startsWith(prefix)) delete prog[k]; });
    storeSet(STORE.progress, prog);
    _invalidateCache();
    playEpisode(s, firstEp, firstSk);
  });

  // Bouton Regarder série (pas de progression, premier épisode)
  $("seriesPlayBtn")?.addEventListener("click", () => {
    if(firstEp && firstSk) playEpisode(s, firstEp, firstSk);
  });

  // Lecture directe
  $("spDirectBtn")?.addEventListener("click", () => playItem(s));

  // Bouton favoris série
  $("seriesFavBtn")?.addEventListener("click", () => {
    toggleFav(s);
    const fav = isFav(s);
    $("seriesFavBtn")?.classList.toggle("is-fav", fav);
    const lbl = $("seriesFavLabel");
    if(lbl) lbl.textContent = fav ? "Favori" : "Ajouter aux favoris";
  });

  // Onglets
  panel.querySelectorAll(".sp-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      S.panel.selSeason = btn.dataset.season;
      renderPanel();
      $("spEps")?.scrollIntoView({ behavior:"smooth", block:"nearest" });
    });
  });

  // ── Modal de reprise : overlay centré accessible télécommande ──
  function openResumeModal(ep, sk, progK, pct, tSec){
    document.getElementById("spResumeModal")?.remove();
    const code = `S${String(sk).padStart(2,"0")}E${String(ep.episode_num).padStart(2,"0")}`;
    // Afficher % si connu, sinon durée absolue
    const resumeInfo = pct > 0.01
      ? `${Math.round(pct * 100)}% visionné`
      : (tSec > 0
          ? `${Math.floor(tSec/60)}min${tSec%60 > 0 ? " " + String(tSec%60) + "s" : ""} visionnés`
          : "Reprendre");
    const ov = document.createElement("div");
    ov.id = "spResumeModal";
    ov.className = "sp-resume-modal";
    ov.innerHTML = `
      <div class="sp-resume-modal__box">
        <div class="sp-resume-modal__title">${esc(code)}${ep.title ? " — " + esc(ep.title) : ""}</div>
        <div class="sp-resume-modal__pct">${resumeInfo}</div>
        <div class="sp-resume-modal__btns">
          <button id="spRmResume" class="sp-resume-modal__play">▶ Reprendre</button>
          <button id="spRmRestart" class="sp-resume-modal__restart">↩ Depuis le début</button>
        </div>
        <button id="spRmClose" class="sp-resume-modal__close">✕</button>
      </div>`;
    document.body.appendChild(ov);

    const closeModal = () => { document.removeEventListener("keydown", onModalKey, true); ov.remove(); };

    function onModalKey(e){
      if(!document.getElementById("spResumeModal")){ document.removeEventListener("keydown", onModalKey, true); return; }
      if(["Escape","GoBack","Back"].includes(e.key)){ e.preventDefault(); e.stopPropagation(); closeModal(); return; }
      if(e.key === "ArrowLeft" || e.key === "ArrowRight"){ e.preventDefault(); e.stopPropagation();
        const cur = document.activeElement;
        if(cur?.id === "spRmResume") $("spRmRestart")?.focus();
        else $("spRmResume")?.focus();
        return;
      }
      if(e.key === "Enter" || e.key === " "){ e.preventDefault(); e.stopPropagation();
        if(document.activeElement?.id === "spRmRestart") document.activeElement.click();
        else $("spRmResume")?.click();
        return;
      }
    }
    document.addEventListener("keydown", onModalKey, true);

    $("spRmResume").addEventListener("click", () => { closeModal(); playEpisode(s, ep, sk); });
    $("spRmRestart").addEventListener("click", () => {
      const prog = getProg();
      delete prog[progK];
      storeSet(STORE.progress, prog);
      _invalidateCache();
      closeModal();
      playEpisode(s, ep, sk);
    });
    $("spRmClose").addEventListener("click", closeModal);
    ov.addEventListener("click", e => { if(e.target === ov) closeModal(); });
    setTimeout(() => $("spRmResume")?.focus(), 60);
  }

  // Boutons épisodes
  panel.querySelectorAll(".sp-ep:not([disabled])").forEach(btn => {
    btn.addEventListener("click", () => {
      const sk    = btn.dataset.season;
      const idx   = Number(btn.dataset.idx);
      const ep    = (smap[sk] || [])[idx];
      if(!ep || !ep.url) return;

      // Vérifier la progression sauvegardée
      const code  = `S${String(sk).padStart(2,"0")}E${String(ep.episode_num).padStart(2,"0")}`;
      const progK = `${s.id}||${code}`;
      const saved = getProg()[progK];
      const tSec  = saved?.t || 0;
      const dSec  = (saved?.d && isFinite(saved.d)) ? saved.d : 0;
      // pct en fraction 0-1 (0 si durée inconnue)
      const pctF  = dSec > 0 ? tSec / dSec : (saved?.pct || 0);

      // Proposer reprise : > 60s regardés ET (pas de durée connue OU pas presque fini)
      if(tSec > 60 && pctF < 0.95){
        openResumeModal(ep, sk, progK, pctF, tSec);
      } else {
        playEpisode(s, ep, sk);
      }
    });
  });

  // Focus initial (TV) — priorité : Reprendre > Lire > premier épisode
  setTimeout(() => {
    const primaryBtn = $("seriesResumeBtn") || $("seriesPlayBtn") ||
                       panel.querySelector(".sp-series-actions .vod-play-btn") ||
                       panel.querySelector(".sp-ep:not([disabled])");
    primaryBtn?.focus();
  }, 80);
}

// ─────────────────────────────────────────────────────────────────
//  LECTURE
// ─────────────────────────────────────────────────────────────────

function playEpisode(series, ep, season){
  pushHist(series);

  // Index global pour prev/next
  const smap   = S.panel.seasonsMap;
  const keys   = Object.keys(smap).sort((a,b)=>Number(a)-Number(b));
  const allEps = [];
  keys.forEach(sk => (smap[sk]||[]).forEach(e => allEps.push({ season:sk, ep:e })));
  const curIdx = allEps.findIndex(x => x.season===season && x.ep.episode_num===ep.episode_num);

  const code   = `S${String(season).padStart(2,"0")}E${String(ep.episode_num).padStart(2,"0")}`;
  const progKey= `${series.id}||${code}`;

  const playerItem = {
    type             : "series",
    series_id        : series.id,
    title            : series.title,
    episode_label    : code,
    episode_title    : ep.title,
    category_name    : series.category_name || "",
    stream_icon      : ep.thumb || series.stream_icon || "",
    stream_url       : ep.url,
    url              : ep.url,
    plot             : ep.plot || series.plot || "",
    progress_key     : progKey,
    all_episodes     : allEps.map(x => ({
      season       : x.season,
      episode_num  : x.ep.episode_num,
      title        : x.ep.title,
      url          : x.ep.url,
      thumb        : x.ep.thumb,
      plot         : x.ep.plot,
      progress_key : `${series.id}||S${String(x.season).padStart(2,"0")}E${String(x.ep.episode_num).padStart(2,"0")}`
    })),
    current_ep_index : curIdx
  };

  // APK Android (TV ou non-TV) : pré-alimenter _epUrlMap pour TOUS les épisodes
  // Indispensable avant tout appel AndroidBridge, quelle que soit la détection TV.
  // PipPlayer.open() peut aussi lancer ExoPlayer sur TV — _epUrlMap doit être prêt.
  if(typeof window.AndroidBridge !== "undefined"){
    if(!window._epUrlMap) window._epUrlMap = {};
    playerItem.all_episodes.forEach(epItem => {
      if(epItem.url) window._epUrlMap[epItem.url] = epItem.progress_key;
    });
  }

  // APK Android (non-TV) : ExoPlayer direct depuis playEpisode (openPlayerAt)
  const _isTV = /TV|GoogleTV|SmartTV|AndroidTV/i.test(navigator.userAgent) ||
                (/Android/i.test(navigator.userAgent) && !navigator.userAgent.includes("Mobile"));
  if(!_isTV && typeof window.AndroidBridge !== "undefined"){
    const epTitle  = `${series.title} — ${code}${ep.title ? " " + ep.title : ""}`;
    const epsJson  = JSON.stringify(playerItem.all_episodes);
    const savedMs  = _getSavedProgressMs({ progress_key: progKey });

    if(typeof window.AndroidBridge.openPlayerAt === "function"){
      try { window.AndroidBridge.openPlayerAt(ep.url, series.title, epTitle, epsJson, curIdx, savedMs); return; }
      catch(e){ console.warn("openPlayerAt:", e); }
    }
    if(typeof window.AndroidBridge.openPlayer === "function"){
      try { window.AndroidBridge.openPlayer(ep.url, series.title, epTitle, epsJson, curIdx); return; }
      catch(e){ console.warn("openPlayer:", e); }
    }
    if(typeof window.AndroidBridge.openInVlc === "function"){
      try { window.AndroidBridge.openInVlc(ep.url, epTitle, false); return; }
      catch(e){ console.warn("openInVlc:", e); }
    }
  }

  // ── Lecteur interne ──────────────────────────────────────────────
  pushHist({ ...playerItem, type: "series" });
  PipPlayer.open({
    ...playerItem,
    id      : playerItem.series_id,
    _epList : allEps.map((x,i) => ({
      id          : x.ep.id,
      url         : x.ep.url,
      season      : x.season,
      episode_num : x.ep.episode_num,
      title       : x.ep.title || "",
      plot        : x.ep.plot  || "",
      thumb       : x.ep.thumb || ""
    })),
    _epIdx  : curIdx
  });
}

async function playItem(item){
  stopPreview();

  // ── Code parental (catégories for adults) ──
  const isAdultCat = /adult|adulte|\+18|xxx|erot|for adult/i.test(item.category_name || "");
  if(isAdultCat && window.PIPSILY_AUTH && S._userId){
    const pin = await window.PIPSILY_AUTH.getParentalPin(S._userId);
    if(pin){
      const ok = await window.PIPSILY_AUTH.promptParentalPin(pin);
      if(!ok) return;
    }
  }

  pushHist(item);
  const url = item.url || item.stream_url || "";

  // ── Toujours utiliser le lecteur interne PipPlayer ──────────────────
  // (Le bouton "Lecture native" dans le lecteur appelle AndroidBridge.openInVlc si dispo)
  PipPlayer.open({
    ...item,
    stream_url : url,
    url        : url
  });
}

// ─────────────────────────────────────────────────────────────────
//  FILTRES / TRI
// ─────────────────────────────────────────────────────────────────

// Catégorie commençant par "xxx" (toutes casses) → adulte.
// Exception : "xXx" (film d'action). On ignore les emojis/espaces en tête.
const _startsXXX = c => {
  if(!c) return false;
  const clean = c.replace(/^[\s\p{Emoji_Presentation}\p{Extended_Pictographic}°|•\-_]+/u, "").trim();
  if(!clean) return false;
  if(clean.startsWith("xXx")) return false; // film "xXx" — garder
  return /^xxx/i.test(clean);
};

// Une catégorie est adulte si :
//   • mots-clés adultes (adult, +18, erot…)
//   • xxx en DÉBUT de catégorie  → "XXX Films", "🔞 XXX Séries"
//   • xxx en FIN  de catégorie   → "Films XXX", "Séries XXX"
// "xxx" uniquement au MILIEU (ex: "SÉRIES | XXX | ACTION") n'est PAS adulte
// → évite les faux positifs sur des catégories dont xxx est un code fournisseur
const _isAdultCat = c => {
  if(!c) return false;
  if(/adult|adulte|\+18|18\+|erot|for adult/i.test(c)) return true;
  if(_startsXXX(c)) return true;                    // xxx en début
  if(/\bxxx\s*$/i.test(c)) return true;             // xxx en fin
  return false;
};

// VOSTFR — toujours masqué (titre ou catégorie)
const _isVostfr = x => /vostfr/i.test(x.title || "") || /vostfr/i.test(x.category_name || "");

function filtered(){
  let items = S.type === "vod" ? [...S.vod] : S.type === "series" ? [...S.series] : [...S.live];
  // VOSTFR toujours masqué
  items = items.filter(x => !_isVostfr(x));
  if(S.cat === "__ADULT__"){
    // Pill adulte : visible uniquement si PIN déverrouillé pour cette session
    if(sessionStorage.getItem("pipsily_adult_unlocked")){
      items = items.filter(x => _isAdultCat(x.category_name));
    } else {
      S.cat = "";
      items = items.filter(x => !_isAdultCat(x.category_name));
    }
  } else if(S.cat){
    items = items.filter(x => x.category_name === S.cat);
  } else {
    // "Tout" sélectionné → masquer les catégories adultes
    items = items.filter(x => !_isAdultCat(x.category_name));
  }
  if(S.search){
    const q = S.search.toLowerCase();
    items = items.filter(x =>
      x.title.toLowerCase().includes(q) || (x.plot||"").toLowerCase().includes(q)
    );
  }
  // Qualité non applicable au live
  if(S.quality && S.type !== "live") items = items.filter(x => x.quality === S.quality);
  if(S.sort === "category")
    items.sort((a,b) => a.category_name.localeCompare(b.category_name)||a.title.localeCompare(b.title));
  else if(S.sort !== "recent")
    items.sort((a,b) => a.title.localeCompare(b.title));

  // ── Live : filtre régional (préférence utilisateur, index auto-construit) ──
  // Logique : si une variante régionale correspond → on la montre.
  // Si AUCUNE variante ne correspond (ex : France 3 sans Roussillon),
  // on affiche en repli la variante "Paris" si elle existe, sinon la première trouvée.
  if(S.type === "live" && S.region){
    if(!S._liveRegionIdx) S._liveRegionIdx = _buildLiveRegionIdx(S.live);
    const { regionSet } = S._liveRegionIdx;
    const userReg = S.region.toLowerCase();

    // Phase 1 — identifier les bases ayant une variante correspondant à la région,
    //            et préparer un repli pour celles qui n'en ont pas.
    // Ordre de priorité du repli :
    //   1. Chaîne générale sans suffixe ("France 3")
    //   2. Variante "Paris" ("France 3 Paris")
    //   3. Première variante disponible
    const basesWithMatch  = new Set();
    const baseGeneral     = new Map(); // base_lc → item sans suffixe régional
    const baseFallback    = new Map(); // base_lc → item de repli (Paris ou premier)

    items.forEach(item => {
      const clean = _baseLiveName(item.title);
      const r = _isChannelRegional(clean, regionSet);
      if(r){
        const base = r.base.toLowerCase();
        if(r.region === userReg) basesWithMatch.add(base);
        // Repli régional : priorité à "paris", sinon premier trouvé
        if(!baseFallback.has(base) || r.region === "paris")
          baseFallback.set(base, item);
      } else {
        // Chaîne sans suffixe → peut servir de repli général pour une base du même nom
        const key = clean.toLowerCase();
        if(!baseGeneral.has(key)) baseGeneral.set(key, item);
      }
    });

    // Phase 2 — items de repli pour les bases sans correspondance
    const fallbackSet = new Set();
    baseFallback.forEach((item, base) => {
      if(basesWithMatch.has(base)) return; // une variante correspond → pas de repli
      // 1. Chaîne générale ("France 3") si elle existe dans le flux
      const general = baseGeneral.get(base);
      if(general){ fallbackSet.add(general); return; }
      // 2. Sinon : Paris ou première variante
      fallbackSet.add(item);
    });

    items = items.filter(item => {
      const clean = _baseLiveName(item.title);
      const r = _isChannelRegional(clean, regionSet);

      if(!r){
        // Chaîne sans suffixe régional (ex : "France 3")
        // La masquer si une variante de la région la remplace déjà
        // (évite "France 3" + "France 3 Bretagne" en même temps)
        return !basesWithMatch.has(clean.toLowerCase());
      }

      if(r.region === userReg) return true;   // variante de la région → visible
      return fallbackSet.has(item);            // repli général si aucune variante ne correspond
    });

    // ── Filet de sécurité : dédoublonnage final ─────────────────────────────
    // Si plusieurs variantes de la même base ont échappé au filtre ci-dessus
    // (ex : détection tardive via fallback mot-par-mot), on n'en garde qu'une :
    //   1. Variante de la région  →  priorité absolue
    //   2. Chaîne générale sans suffixe (France 3)  →  repli préféré
    //   3. Première variante trouvée  →  dernier recours
    {
      const baseBest = new Map(); // base_lc → { score, item }
      items.forEach(item => {
        const clean = _baseLiveName(item.title);
        const r = _isChannelRegional(clean, regionSet);
        if(!r) return;                                // les "généraux" sont hors concours
        const base  = r.base.toLowerCase();
        const score = r.region === userReg ? 2 : 0;
        if(!baseBest.has(base) || score > baseBest.get(base).score)
          baseBest.set(base, { score, item });
      });
      if(baseBest.size){
        const keepRegional = new Set([...baseBest.values()].map(v => v.item));
        items = items.filter(item => {
          const clean = _baseLiveName(item.title);
          const r = _isChannelRegional(clean, regionSet);
          if(!r) return true;                         // général : toujours conservé
          return keepRegional.has(item);
        });
      }
    }
  }
  // ── Live : grouper les variantes de qualité (BOOMERANG SD/FHD/HEVC → 1 seule fiche) ──
  if(S.type === "live") items = groupLiveItems(items);

  // ── Live : ordre TNT française (numéros LCN comme chez Free), puis catégories ──
  // Correspondance EXACTE sur le nom normalisé — l'ancien startsWith faisait
  // matcher "FRANCE 24"→"FRANCE 2", "France 3 Alsace"→"France 3", etc.
  if(S.type === "live" && !S.search){
    // Numéros de chaînes Free / TNT (LCN)
    const _TNT_LCN = {
      "TF1":1, "FRANCE2":2, "FRANCE3":3, "CANAL+":4, "FRANCE5":5, "M6":6,
      "ARTE":7, "C8":8, "W9":9, "TMC":10, "TFX":11, "NRJ12":12,
      "LCP":13, "LCPAN":13, "FRANCE4":14, "BFMTV":15, "CNEWS":16,
      "CSTAR":17, "GULLI":18,
      "TF1SERIESFILMS":20, "LEQUIPE":21, "LEQUIPELIVE21":21, "6TER":22, "RMCSTORY":23,
      "RMCDECOUVERTE":24, "CHERIE25":25, "LCI":26, "FRANCEINFO":27
    };
    // Normalisation : décoratifs/accents/espaces/ponctuation supprimés
    const _tntNorm = t => (t || "")
      .replace(_DECO_RE, " ")
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .toUpperCase().replace(/[^A-Z0-9+]/g, "");
    const _lcn = title => {
      const n = _TNT_LCN[_tntNorm(title)];
      if(n) return n;
      // Région choisie : la variante régionale hérite du numéro de sa base
      // ("FRANCE 3 ALSACE" → numéro 3) — une seule variante survit au filtre
      if(S.region && S._liveRegionIdx){
        const r = _isChannelRegional(title, S._liveRegionIdx.regionSet);
        if(r){
          const nb = _TNT_LCN[_tntNorm(r.base)];
          if(nb) return nb;
        }
      }
      return 9999;
    };
    const _CAT_PRI = {
      "EU | FRANCE GENERAL":       0,
      "EU | FRANCE NEWS":          1,
      "EU | FRANCE ENTERTAINMENT": 2,
      "EU | FRANCE SPORTS":        3,
      "EU | FRANCE CINEMA":        4,
      "EU | FRANCE DOCUMENTAIRE":  5,
      "EU | FRANCE KIDS":          6,
      "EU | FRANCE DOM TOM":       7,
      "EU | 24/7 FRENCH":          8,
      "EU | FRANCE PLUTO TV":      9,
      "EU | FRANCE DAZN":         10,
      "EU | FRANCE LIGUE 1+":     11,
    };
    items.sort((a, b) => {
      const la = _lcn(a.title), lb = _lcn(b.title);
      if(la !== lb) return la - lb;             // ordre LCN TNT d'abord
      if(la !== 9999) return a.title.localeCompare(b.title); // même numéro (doublons)
      const pa = _CAT_PRI[a.category_name] ?? 99;
      const pb = _CAT_PRI[b.category_name] ?? 99;
      if(pa !== pb) return pa - pb;             // hors TNT → ordre catégorie
      return a.title.localeCompare(b.title);    // puis alphabétique (ordre stable)
    });
  }

  // Filtre favoris uniquement (bouton ❤️ dans la barre)
  if(S.favOnly){
    if(S.type === "live") items = items.filter(g => isFav(g));
    else items = items.filter(x => isFav(x));
  }

  return items;
}

// ─────────────────────────────────────────────────────────────────
//  GROUPAGE LIVE PAR NOM DE BASE — SD/FHD/HEVC etc. → 1 seule carte
// ─────────────────────────────────────────────────────────────────
const _QUAL_ORDER = ["4K","UHD","FHD","HDR","HDTV","HD","HEVC","SD"];
const _QUAL_RE    = /[\s\[\(]+(HDR\+?|HDTV|FHD|UHD|4K|8K|HEVC|H\.?265|H\.?264|1080p?|720p?|2160p?|HD|SD)\b\]?\)?/gi;

function _parseLiveQuality(title){
  if(!title) return null;
  const matches = [...title.matchAll(_QUAL_RE)].map(m => m[1].toUpperCase());
  for(const q of _QUAL_ORDER) if(matches.includes(q)) return q;
  return matches[0] || null;
}
// Caractères décoratifs utilisés par certains fournisseurs IPTV (ex: "TF1•", "◉ M6")
const _DECO_RE = /[◉★►•·✦✧▶⬤●❶-❿①-⑳]+/g;
function _baseLiveName(title){
  if(!title) return "";
  return title
    .replace(_DECO_RE, " ")          // supprimer les décoratifs (TF1• → TF1, ◉ TF1 → TF1)
    .replace(_QUAL_RE, "")           // supprimer les tags qualité (HD, FHD, HDR…)
    .replace(/^[\s\-–—|:]+/, "")    // supprimer les préfixes "- ", "| ", ": " courants dans les flux IPTV
    .replace(/\s+/g, " ").trim();
}

// ── Détection dynamique des chaînes régionales ───────────────────────────────
// Un suffixe est considéré "région" s'il apparaît à la fin de 2+ chaînes de bases différentes.
// Ex : "Bretagne" est dans "France 3 Bretagne" ET "BFM Bretagne" → région détectée.
// Aucune liste codée en dur — fonctionne avec n'importe quel flux IPTV.

// Mots qui ne sont PAS des noms géographiques — évite les faux positifs
// IMPORTANT : inclure les chiffres pour éviter que "France 2", "RMC 2"… soient
// traités comme chaînes régionales (suffixe "2" détecté dans 2+ bases → faux positif).
const _NON_GEO = new Set([
  "séries","series","films","cinéma","cinema","sport","sports","info","kids",
  "jeunesse","comedy","action","thriller","music","news","live","direct","replay",
  "plus","one","two","max","go","box","play","vod","premium","extra","family",
  "classic","vintage","gold","select","club","tv","web","mobile","app",
  // Chiffres — empêchent France 2 / Canal 2 / RMC 2… d'être classés "régionaux"
  "2","3","4","5","6","7","8","9","10","11","12",
  // Qualités vidéo — jamais des noms de régions
  "hd","sd","4k","uhd","fhd","hdr",
  // Suffixes IPTV courants (pas des noms géographiques)
  "²","2","fr","be","ch","lu","ca","us",
  "event","event only","only","vip","iptv","adult","adults",
  "rue","ter","bis",
  // Suffixes de chaînes thématiques (Canal+, L'Équipe, BeIN...)
  "action","animation","aventure","cinema","cinéma","comedie","comédie",
  "crime","decouvertes","découvertes","drame","enquetes","enquêtes","famille",
  "gaming","horreur","investigation","jeunesse","kids","life","nature",
  "polar","romance","sci-fi","scifi","serie","séries","thriller","western",
  "event only","event","only","a+","+1","+2","+3","+4","+5",
  "max","one","two","three","four","five","six","seven","eight","nine","ten"
]);

// ── Liste de garantie : noms géographiques toujours reconnus comme régions ──
// Complète la détection dynamique pour les flux avec peu de variantes régionales.
const _GEO_NAMES = new Set([
  // Nouvelles régions administratives
  "auvergne-rhône-alpes","bourgogne-franche-comté","bretagne",
  "centre-val de loire","corse","grand est","hauts-de-france",
  "île-de-france","normandie","nouvelle-aquitaine","occitanie",
  "pays de la loire","provence-alpes-côte d'azur",
  // Anciennes régions (encore très utilisées dans les flux IPTV)
  "alsace","aquitaine","auvergne","bourgogne",
  "champagne","champagne-ardenne","franche-comté",
  "languedoc","languedoc-roussillon","limousin","lorraine",
  "midi-pyrénées","nord-pas-de-calais","picardie",
  "poitou-charentes","rhône-alpes",
  // Abréviations courantes
  "ara","bfc","cvl","hdf","idf","na","npc","paca","pdl",
  // Grandes villes (BFM régionales, etc.)
  "paris","lyon","marseille","bordeaux","toulouse","lille",
  "rennes","nantes","strasbourg","montpellier","nice",
  "grenoble","rouen","toulon","perpignan","nancy",
  // DOM-TOM
  "guadeloupe","martinique","guyane","la réunion","réunion","mayotte",
  // Variantes sans accents / avec espaces (orthographes alternatives dans les flux)
  "ile-de-france","hauts de france","ile de france",
  "rhone-alpes","franche comte","pays-de-la-loire",
  // Variantes SANS tirets (providers qui utilisent des espaces)
  "nord pas de calais","nouvelle aquitaine","auvergne rhone alpes",
  "bourgogne franche comte","centre val de loire","provence alpes cote d azur",
  "pays de loire",
  // Autres suffixes régionaux fréquents
  "grand littoral","alsace-moselle","nord picardie",
  // Sous-régions / bassins France 3 (apparaissent dans certains flux)
  "alpes","alpes du sud","côte d azur","cote d azur",
  "poitou","charentes","berry","limousin","auvergne",
  "bourgogne","franche-comte","franche comté","lorraine",
  "champagne ardenne","picardie","haute normandie","basse normandie",
  "centre","ardennes","moselle","alsace"
]);

/**
 * Construit l'index régional depuis les items live.
 * Un suffixe est une région si :
 *   (A) il apparaît dans ≥ 2 bases différentes  → "Bretagne" dans France3 + BFM
 *   (B) la même base a ≥ 2 suffixes non-NON_GEO → "France 3" avec 2+ régions
 * En plus, _GEO_NAMES garantit la détection même avec 1 seule occurrence.
 * Retourne { regionSet: Set<string_lc>, displayNames: Map<lc, string> }
 */
function _buildLiveRegionIdx(items){
  const baseSuffixes = new Map(); // base_lc → Set<suf_lc>
  const suffixBases  = new Map(); // suf_lc  → Set<base_lc>

  items.forEach(item => {
    const clean = _baseLiveName(item.title).trim();
    const words = clean.split(/\s+/);
    if(words.length < 2) return;
    for(let n = 1; n <= Math.min(4, words.length - 1); n++){
      const suf  = words.slice(-n).join(" ").toLowerCase();
      const base = words.slice(0,  -n).join(" ").toLowerCase();
      // Rejeter si le suffixe contient des chiffres ou des caractères spéciaux
      // (ex : "6ter", "24/7", "²", "a$$3$" ne sont pas des régions)
      if(!suf || !base || _NON_GEO.has(suf) || suf.length < 2 || base.length < 2) continue;
      if(/\d|[²³¹$&@!%#^*]/.test(suf)) continue;
      // Rejeter les suffixes qui commencent par un tiret ou contiennent des parenthèses
      // (ex : "- (EVENT ONLY)", "(EVENT ONLY)", "- A+", "- ACTION")
      if(/^[-–—]/.test(suf) || /[()[\]]/.test(suf)) continue;
      if(!baseSuffixes.has(base)) baseSuffixes.set(base, new Set());
      baseSuffixes.get(base).add(suf);
      if(!suffixBases.has(suf))  suffixBases.set(suf, new Set());
      suffixBases.get(suf).add(base);
    }
  });

  const regionSet = new Set();

  // (A) Même suffixe dans ≥ 2 bases → région transversale (BFM Bretagne + France3 Bretagne)
  suffixBases.forEach((bases, suf) => { if(bases.size >= 2) regionSet.add(suf); });

  // (B) Même base avec ≥ 2 suffixes → la chaîne a des variantes régionales
  //     (France 3 Bretagne + France 3 Normandie suffit)
  baseSuffixes.forEach((suffixes, _base) => {
    if(suffixes.size >= 2) suffixes.forEach(suf => regionSet.add(suf));
  });

  // Reconstruire les noms d'affichage (casse d'origine) + stocker pour account.html
  const displayNames = new Map();
  items.forEach(item => {
    const clean = _baseLiveName(item.title).trim();
    const words = clean.split(/\s+/);
    for(let n = 1; n <= Math.min(4, words.length - 1); n++){
      const suf  = words.slice(-n).join(" ");
      const lc   = suf.toLowerCase();
      if(regionSet.has(lc) && !displayNames.has(lc)) displayNames.set(lc, suf);
    }
  });

  try {
    const names = [...displayNames.values()].sort((a,b) => a.localeCompare(b,"fr"));
    localStorage.setItem("pipsily_available_regions", JSON.stringify(names));
  } catch(e){}

  return { regionSet, displayNames };
}

/**
 * Retourne {base, region_lc} si le titre est une chaîne régionale, sinon null.
 * Consulte d'abord l'index dynamique, puis la liste statique _GEO_NAMES.
 * Cherche du suffixe le plus long au plus court (priorité aux noms multi-mots).
 *
 * Fallback : si aucun suffixe reconnu, scanne les mots du titre un par un.
 * Permet de détecter "France 3 Corse Via Stella" → base="France 3", région="corse"
 * même quand "Via Stella" est accroché à la fin et masque le nom géographique.
 */
function _isChannelRegional(cleanTitle, regionSet){
  // Neutraliser les tirets isolés : "FRANCE 3 NORD - PAS DE CALAIS" →
  // "FRANCE 3 NORD PAS DE CALAIS" (sinon le tiret casse le découpage en mots
  // et la région n'est jamais reconnue → chaîne traitée comme nationale)
  const words = cleanTitle.replace(/\s+[-–—]\s+/g, " ").trim().split(/\s+/);
  if(words.length < 2) return null;

  // ── Étape 1 : suffixes de longueur décroissante (4 → 1 mots) ──
  for(let n = Math.min(4, words.length - 1); n >= 1; n--){
    const suf  = words.slice(-n).join(" ").toLowerCase();
    const base = words.slice(0,  -n).join(" ");
    if((regionSet.has(suf) || _GEO_NAMES.has(suf)) && base) return { base, region: suf };
  }

  // ── Étape 2 : scan mot par mot (géo-nom en milieu de titre) ──
  // Gère les cas comme "France 3 Corse Via Stella" où le nom de région
  // n'est pas le dernier mot mais est reconnu dans _GEO_NAMES.
  for(let i = 1; i < words.length; i++){
    const word = words[i].toLowerCase();
    if(_GEO_NAMES.has(word)){
      const base = words.slice(0, i).join(" ");
      if(base) return { base, region: word };
    }
  }

  return null;
}

// ── Logos de repli pour les chaînes sans icône dans le flux ─────────────────
// Wikimedia Commons Special:FilePath → redirige vers l'image réelle (CORS ok).
// ?width=160 force la conversion SVG → PNG 160 px.
const _LW = "?width=160";
const _LB = "https://commons.wikimedia.org/wiki/Special:FilePath/";
const _LOGO_MAP = {
  // France Télévisions ───────────────────────────────────────────────────────
  "france 2":            _LB+"France_2_logo.svg"+_LW,
  "france 3":            _LB+"France_3.svg"+_LW,
  "france 4":            _LB+"France_4_logo.svg"+_LW,
  "france 5":            _LB+"France_5_logo.svg"+_LW,
  "franceinfo":          _LB+"Franceinfo_logo.svg"+_LW,
  "france info":         _LB+"Franceinfo_logo.svg"+_LW,
  // TF1 Groupe ──────────────────────────────────────────────────────────────
  "tf1":                 _LB+"TF1_logo.svg"+_LW,
  "tmc":                 _LB+"TMC_logo.svg"+_LW,
  "tfx":                 _LB+"TFX.svg"+_LW,
  "tf1 series films":    _LB+"TF1_S%C3%A9ries_Films.svg"+_LW,
  "tf1 séries films":    _LB+"TF1_S%C3%A9ries_Films.svg"+_LW,
  "tf1 series":          _LB+"TF1_S%C3%A9ries_Films.svg"+_LW,
  "tf1 séries":          _LB+"TF1_S%C3%A9ries_Films.svg"+_LW,
  "lci":                 _LB+"LCI_logo.svg"+_LW,
  // M6 Groupe ───────────────────────────────────────────────────────────────
  "m6":                  _LB+"M6_logo.svg"+_LW,
  "w9":                  _LB+"W9.svg"+_LW,
  "6ter":                _LB+"6ter.svg"+_LW,
  // Arte / Canal+ ───────────────────────────────────────────────────────────
  "arte":                _LB+"Arte_Logo.svg"+_LW,
  "canal+":              _LB+"Canal%2B.svg"+_LW,
  "canal plus":          _LB+"Canal%2B.svg"+_LW,
  // Info / News ─────────────────────────────────────────────────────────────
  "bfmtv":               _LB+"BFMTV.svg"+_LW,
  "bfm tv":              _LB+"BFMTV.svg"+_LW,
  "bfm":                 _LB+"BFMTV.svg"+_LW,         // couvre BFM Paris, BFM Lyon…
  "cnews":               _LB+"CNews.svg"+_LW,
  // Divertissement TNT ──────────────────────────────────────────────────────
  "c8":                  _LB+"C8.svg"+_LW,
  "cstar":               _LB+"CStar.svg"+_LW,
  "c star":              _LB+"CStar.svg"+_LW,
  "gulli":               _LB+"Gulli.svg"+_LW,
  "nrj12":               _LB+"NRJ_12.svg"+_LW,
  "nrj 12":              _LB+"NRJ_12.svg"+_LW,
  "neon":                _LB+"Neon_TV.svg"+_LW,
  "chérie 25":           _LB+"Ch%C3%A9rie_25.svg"+_LW,
  "cherie 25":           _LB+"Ch%C3%A9rie_25.svg"+_LW,
  "l'equipe":            _LB+"L%27%C3%89quipe_TV.svg"+_LW,
  "l equipe":            _LB+"L%27%C3%89quipe_TV.svg"+_LW,
  "rmc story":           _LB+"RMC_Story.svg"+_LW,
  "rmc decouverte":      _LB+"RMC_D%C3%A9couverte.svg"+_LW,
  "rmc découverte":      _LB+"RMC_D%C3%A9couverte.svg"+_LW,
  "paramount":           _LB+"Paramount_Network.svg"+_LW,
};
// Clés triées du plus long au plus court → préfixe le plus précis gagne
const _LOGO_KEYS = Object.keys(_LOGO_MAP).sort((a,b)=>b.length-a.length);

/**
 * Retourne l'URL du logo de repli pour un titre de chaîne, sinon "".
 * Couvre les variantes régionales : "France 3 Bretagne" → logo France 3.
 */
function _getLogoFallback(title){
  if(!title) return "";
  const key = _baseLiveName(title).toLowerCase();
  for(const k of _LOGO_KEYS){
    if(key === k || key.startsWith(k+" ")) return _LOGO_MAP[k];
  }
  return "";
}

function groupLiveItems(items){
  const groups = new Map();
  items.forEach(item => {
    const base = _baseLiveName(item.title) || item.title;
    const qual = _parseLiveQuality(item.title);
    if(!groups.has(base)){
      groups.set(base, {
        ...item,
        title: base,
        type: "live",
        _variants: [],
        _iconRank: 999
      });
    }
    const g = groups.get(base);
    g._variants.push({ quality: qual || "Auto", item });
    // Garder l'icône de la meilleure qualité (FHD préférée)
    const rank = qual ? _QUAL_ORDER.indexOf(qual) : 99;
    if(rank >= 0 && rank < g._iconRank && item.stream_icon){
      g.stream_icon = item.stream_icon;
      g._iconRank = rank;
    }
  });
  // Trier les variantes par préférence de qualité
  groups.forEach(g => {
    g._variants.sort((a,b) => {
      const ra = _QUAL_ORDER.indexOf(a.quality); const rb = _QUAL_ORDER.indexOf(b.quality);
      return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb);
    });
  });
  return [...groups.values()];
}

// ── Sélecteur de qualité Live (overlay) ──
function openLivePicker(group){
  if(document.getElementById("livePicker")) return;
  // L'overlay natif du preview flotterait AU-DESSUS du picker (TextureView hors DOM) → stop
  if(typeof stopPreview === "function") stopPreview();
  // Pousse un état dans l'historique → Back TV/Android ferme le picker, pas l'app
  history.pushState({pip:"picker"}, "");
  const ov = document.createElement("div");
  ov.id = "livePicker";
  ov.className = "live-picker";

  // Raccourcir le nom de la chaîne dans le hint (enlever la qualité déjà affichée)
  const makeHint = (title, quality) => {
    let h = title.replace(new RegExp(`\\b${quality}\\b`,"i"), "").replace(/[\[\]\(\)\s]+$/, "").trim();
    return h || title;
  };

  const _isFavGroup = isFav(group);
  // ♥ et Fermer sont dans la MÊME rangée en bas — accessibles avec un seul ↓
  ov.innerHTML = `
    <div class="live-picker__box">
      <h2 class="live-picker__title">${esc(group.title)}</h2>
      <p class="live-picker__sub">Choisissez la qualité · utilisez ←→ + OK</p>
      <div class="live-picker__grid">
        ${group._variants.map((v,i) => `
          <button class="live-picker__btn${i===0?" live-picker__btn--focus":""}"
                  data-idx="${i}" tabindex="${i===0?0:-1}">
            <span class="live-picker__qual">${esc(v.quality)}</span>
            <span class="live-picker__hint">${esc(makeHint(v.item.title, v.quality))}</span>
          </button>`).join("")}
      </div>
      <div class="live-picker__actions">
        <button class="live-picker__fav ${_isFavGroup?"is-fav":""}" id="livePickerFav" tabindex="-1">
          ${_isFavGroup?"♥ Retirer":"♡ Favori"}
        </button>
        <button class="live-picker__close" id="livePickerClose" tabindex="-1">✕ Fermer</button>
      </div>
    </div>`;
  document.body.appendChild(ov);

  // ── Navigation D-pad TV ──────────────────────────────────────────
  // Zones : [qualité 0…N] → ↓ → [♥ Favori] [✕ Fermer]
  //         ←→ dans chaque zone ; ↑ remonte aux qualités
  const allBtns  = () => [...ov.querySelectorAll(".live-picker__btn")];
  const favEl    = () => document.getElementById("livePickerFav");
  const closeEl  = () => document.getElementById("livePickerClose");
  // actionRow : 0=♥, 1=Fermer
  let focusIdx     = 0;  // index dans la grille qualité
  let actionFocus  = -1; // -1=pas dans action row, 0=♥, 1=Fermer

  const clearQualFocus = () => {
    allBtns().forEach(b => { b.classList.remove("live-picker__btn--focus"); b.tabIndex = -1; });
  };
  const clearActionFocus = () => {
    const f = favEl();   if(f){ f.classList.remove("live-picker__fav--focus");   f.tabIndex = -1; }
    const c = closeEl(); if(c){ c.classList.remove("live-picker__close--focus"); c.tabIndex = -1; }
  };

  const focusBtn = (idx) => {
    const btns = allBtns();
    if(idx < 0 || idx >= btns.length) return;
    focusIdx    = idx;
    actionFocus = -1;
    clearActionFocus();
    btns.forEach((b,i) => {
      b.classList.toggle("live-picker__btn--focus", i === idx);
      b.tabIndex = i === idx ? 0 : -1;
    });
    btns[idx].focus();
  };

  const focusAction = (which) => {
    // which : 0=♥, 1=Fermer
    actionFocus = which;
    clearQualFocus();
    const f = favEl();
    const c = closeEl();
    if(f){ f.classList.toggle("live-picker__fav--focus",   which === 0); f.tabIndex = which === 0 ? 0 : -1; }
    if(c){ c.classList.toggle("live-picker__close--focus", which === 1); c.tabIndex = which === 1 ? 0 : -1; }
    if(which === 0 && f) f.focus();
    else if(which === 1 && c) c.focus();
  };

  const close = (fromPopstate = false) => {
    document.removeEventListener("keydown", onKey, true);
    ov.remove();
    if(!fromPopstate && history.state?.pip === "picker") history.back();
  };
  // Exposer close pour le popstate handler (closure inaccessible autrement)
  ov._closePicker = close;

  // Listener en phase CAPTURE sur document — intercepte AVANT la nav spatiale Android TV WebView
  function onKey(e) {
    if(!document.getElementById("livePicker")){ document.removeEventListener("keydown", onKey, true); return; }
    const btns     = allBtns();
    const inAction = actionFocus >= 0;

    switch(e.key){
      case "Escape": case "GoBack": case "Back":
        e.preventDefault(); e.stopPropagation(); close(); return;

      case "ArrowRight":
        e.preventDefault(); e.stopPropagation();
        if(inAction)  focusAction(actionFocus === 0 ? 1 : 0); // ♥ ↔ Fermer
        else          focusBtn(Math.min(focusIdx + 1, btns.length - 1));
        return;

      case "ArrowLeft":
        e.preventDefault(); e.stopPropagation();
        if(inAction)  focusAction(actionFocus === 0 ? 1 : 0); // ♥ ↔ Fermer
        else          focusBtn(Math.max(focusIdx - 1, 0));
        return;

      case "ArrowDown":                         // ↓ qualité → ♥ (direct, un seul ↓)
        e.preventDefault(); e.stopPropagation();
        if(!inAction) focusAction(0);           // atterrit sur ♥ en premier
        return;

      case "ArrowUp":                           // ↑ → retour boutons qualité
        e.preventDefault(); e.stopPropagation();
        if(inAction) focusBtn(focusIdx);
        return;

      case "Enter": case " ":
        e.preventDefault(); e.stopPropagation();
        if(inAction && actionFocus === 1){ close(); return; }
        if(inAction && actionFocus === 0){
          toggleFav(group);
          const f = favEl();
          if(f){
            const nowFav = isFav(group);
            f.classList.toggle("is-fav", nowFav);
            f.textContent = nowFav ? "♥ Retirer" : "♡ Favori";
          }
          return;
        }
        // sur une qualité
        if(btns[focusIdx]){ close(); playItem(group._variants[focusIdx].item); }
        return;
    }
  }
  document.addEventListener("keydown", onKey, true);

  // Clics souris / touch
  allBtns().forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.idx);
      close();
      playItem(group._variants[idx].item);
    });
    btn.addEventListener("focus", () => {
      focusIdx    = Number(btn.dataset.idx);
      actionFocus = -1;
      allBtns().forEach((b,i) => b.classList.toggle("live-picker__btn--focus", i===focusIdx));
    });
  });

  const favBtnEl = favEl();
  if(favBtnEl) favBtnEl.addEventListener("click", () => {
    toggleFav(group);
    const nowFav = isFav(group);
    favBtnEl.classList.toggle("is-fav", nowFav);
    favBtnEl.textContent = nowFav ? "♥ Retirer" : "♡ Favori";
  });

  const cBtnEl = closeEl();
  if(cBtnEl) cBtnEl.addEventListener("click", close);
  ov.addEventListener("click", e => { if(e.target === ov) close(); });

  // Focus initial sur la 1ère qualité
  setTimeout(() => focusBtn(0), 80);
}

// ─────────────────────────────────────────────────────────────────
//  GRILLE
// ─────────────────────────────────────────────────────────────────

function renderGrid(reset = false){
  const grid  = $("grid");
  const empty = $("emptyState");
  if(!grid) return;

  const col   = filtered();
  const limit = S.shown[S.type];
  const items = col.slice(0, limit);

  if(!items.length){ grid.innerHTML = ""; empty.hidden = false; return; }
  empty.hidden = true;
  if(reset) grid.innerHTML = "";

  const frag = document.createDocumentFragment();
  let _staggerIdx = 0;
  items.slice(grid.children.length).forEach(item => {
    const card = document.createElement("div");
    const key  = itemKey(item);
    card.className   = "card";
    card.tabIndex    = 0;
    card.dataset.key  = key;
    card._pfItem     = item;
    // taste-skill : stagger animation (max 18 pour éviter les délais trop longs)
    card.style.setProperty("--i", Math.min(_staggerIdx++, 18));

    const isSeries = item.type === "series";
    const isLive   = item.type === "live";
    const poster   = item.stream_icon || (isLive ? _getLogoFallback(item.title) : "");
    const badgeCls = isLive ? "card-badge--live" : isSeries ? "card-badge--s" : "card-badge--f";
    const badgeTxt = isLive ? "📡 Live" : isSeries ? "Série" : "Film";
    const pct      = isLive ? 0 : getWatchPct(item);
    const progBar  = (pct > 0.03 && pct < 0.97)
      ? `<div class="card-prog-bar"><div class="card-prog-fill" style="width:${Math.round(pct*100)}%"></div></div>`
      : "";

    card.innerHTML = `
      <div class="card-media">
        ${poster
          ? `<img src="${esc(poster)}" alt="" loading="lazy" onerror="this.style.display='none';var p=document.createElement('div');p.className='card-placeholder';p.textContent='${isLive?"📡":"🎬"}';this.parentNode.insertBefore(p,this);">`
          : `<div class="card-placeholder">${isLive?"📡":"🎬"}</div>`}
        <span class="card-badge ${badgeCls}">${badgeTxt}</span>
        ${item.quality && !isLive ? `<span class="card-qual">${esc(item.quality)}</span>` : ""}
        <button class="fav-btn ${isFav(item)?"is-fav":""}" type="button" aria-label="Favori">♥</button>
        ${progBar}
      </div>
      <div class="card-info">
        <div class="card-title">${esc(item.title)}</div>
        <div class="card-cat">${esc(displayCat(item.category_name))}</div>
      </div>`;

    card.querySelector(".fav-btn").addEventListener("click", e => {
      e.stopPropagation(); toggleFav(item);
    });

    const activate = () => {
      if(item.type === "series") openPanel(item);
      else if(item.type === "live"){
        // Si plusieurs qualités → picker, sinon lecture directe
        if(item._variants && item._variants.length > 1) openLivePicker(item);
        else playItem(item._variants?.[0]?.item || item);
      }
      else openVodPanel(item);
    };
    card.addEventListener("click", activate);
    card.addEventListener("keydown", e => {
      if(e.key === "Enter" || e.key === " "){ e.preventDefault(); activate(); }
    });
    // Classe JS pour focus visible (TV D-pad / iframe)
    card.addEventListener("focus", () => card.classList.add("is-tv-focused"));
    card.addEventListener("blur",  () => card.classList.remove("is-tv-focused"));

    frag.appendChild(card);
  });

  grid.appendChild(frag);
  $("catalogCount").textContent = `${col.length} éléments · ${grid.children.length} affichés`;
}

function loadMore(){
  if(S.loading) return;
  S.loading = true;
  const col  = filtered();
  const next = Math.min(S.shown[S.type] + PER_PAGE, col.length);
  if(next > S.shown[S.type]){ S.shown[S.type] = next; renderGrid(); }
  S.loading = false;
}

// ─────────────────────────────────────────────────────────────────
//  RANGÉES NETFLIX — browse par catégorie (sans filtre actif)
// ─────────────────────────────────────────────────────────────────

const NROW_MAX = 24; // éléments max par rangée

function makeNrowCard(item){
  const card = document.createElement("div");
  const isLive = item.type === "live";
  card.className   = "nrow-card" + (isLive ? " nrow-card--live" : "");
  card.tabIndex    = 0;
  card.dataset.key = itemKey(item);
  card._pfItem     = item;
  const poster   = item.stream_icon || (isLive ? _getLogoFallback(item.title) : "");
  const isSeries = item.type === "series";
  const pct      = isLive ? 0 : getWatchPct(item);
  const progBar  = (pct > 0.03 && pct < 0.97)
    ? `<div class="card-prog-bar"><div class="card-prog-fill" style="width:${Math.round(pct*100)}%"></div></div>`
    : "";

  card.innerHTML = `
    <div class="nrow-media">
      ${poster
        ? `<img src="${esc(poster)}" alt="">`
        : `<div class="nrow-placeholder">${isSeries ? "📺" : "🎬"}</div>`}
      ${item.quality ? `<span class="nrow-qual">${esc(item.quality)}</span>` : ""}
      <div class="nrow-overlay"><span class="nrow-play">▶</span></div>
      <button class="nrow-fav ${isFav(item) ? "is-fav" : ""}" type="button" aria-label="Favori">♥</button>
      ${progBar}
    </div>
    <div class="nrow-info">
      <div class="nrow-name">${esc(item.title)}</div>
    </div>`;

  // Fallback si l'image ne charge pas : remplacer par le placeholder emoji
  if(poster){
    const imgEl = card.querySelector(".nrow-media img");
    if(imgEl) imgEl.onerror = function(){
      this.style.display = "none";
      const ph = document.createElement("div");
      ph.className = "nrow-placeholder";
      ph.textContent = isSeries ? "📺" : "🎬";
      this.parentNode.insertBefore(ph, this);
    };
  }

  card.querySelector(".nrow-fav").addEventListener("click", e => {
    e.stopPropagation();
    toggleFav(item);
    e.currentTarget.classList.toggle("is-fav", isFav(item));
  });

  const activate = () => {
    if(item.type === "series") openPanel(item);
    else if(item.type === "live") playItem(item);
    else openVodPanel(item);
  };
  card.addEventListener("click", e => { if(!e.target.closest(".nrow-fav")) activate(); });
  card.addEventListener("keydown", e => {
    if(e.key === "Enter" || e.key === " "){ e.preventDefault(); activate(); }
  });
  card.addEventListener("focus", () => card.classList.add("is-tv-focused"));
  card.addEventListener("blur",  () => card.classList.remove("is-tv-focused"));
  return card;
}

// Renomme les catégories fournisseur en libellés français lisibles
function displayCatName(name){
  const n = (name || "").toUpperCase();
  if(/LATEST\s+MOVIES?/.test(n)) return "DERNIERS AJOUTS";
  if(/LATEST\s+SERIES/.test(n))  return "DERNIERS AJOUTS";
  return name;
}

function renderNetflixRows(){
  const grid  = $("grid");
  const empty = $("emptyState");
  if(!grid) return;

  const all = S.type === "vod" ? S.vod : S.series;

  // Grouper par catégorie (ordre d'apparition original) — adultes exclus du "Tout"
  const catMap = new Map();
  for(const item of all){
    const cat = item.category_name || "Autre";
    if(_isAdultCat(cat)) continue;  // masqué sauf si pill 🔞 sélectionnée
    if(_isVostfr(item))  continue;  // VOSTFR toujours masqué
    if(!catMap.has(cat)) catMap.set(cat, []);
    catMap.get(cat).push(item);
  }

  if(!catMap.size){ grid.innerHTML = ""; empty.hidden = false; return; }

  // Mettre DERNIERS AJOUTS (LATEST MOVIES / LATEST SERIES) en première position
  const isLatest = k => /LATEST\s+(MOVIES?|SERIES)/i.test(k);
  const sorted = [...catMap.entries()].sort(([a],[b]) => {
    if(isLatest(a) && !isLatest(b)) return -1;
    if(!isLatest(a) && isLatest(b)) return  1;
    return 0;
  });
  const orderedMap = new Map(sorted);
  empty.hidden = true;
  grid.innerHTML = "";

  const rowsArr = [...orderedMap.entries()];
  let rowIdx = 0;
  let totalItems = 0;
  const RBATCH = 3;

  function _buildRow(catName, items){
    totalItems += items.length;
    const section = document.createElement("div");
    section.className = "nrow";
    const hdr = document.createElement("div");
    hdr.className = "nrow-hdr";
    const titleEl = document.createElement("h3");
    titleEl.className = "nrow-title";
    titleEl.textContent = displayCatName(catName);
    hdr.appendChild(titleEl);
    section.appendChild(hdr);
    const strip = document.createElement("div");
    strip.className = "nrow-strip";
    items.slice(0, NROW_MAX).forEach(item => strip.appendChild(makeNrowCard(item)));
    // Tuile "Voir tout"
    const allTile = document.createElement("button");
    allTile.className = "nrow-card nrow-all-tile";
    allTile.type = "button";
    allTile.tabIndex = 0;
    allTile.setAttribute("aria-label", `Voir tout ${catName} (${items.length})`);
    allTile.innerHTML = `<div class="nrow-media nrow-all-media"><span class="nrow-all-arrow">→</span><span class="nrow-all-label">Voir tout</span><span class="nrow-all-count">(${items.length})</span></div>`;
    allTile.addEventListener("click", () => {
      S.cat = catName;
      const sel = $("categorySelect");
      if(sel) sel.value = catName;
      $("catPills")?.querySelectorAll(".cat-pill").forEach(b =>
        b.classList.toggle("cat-pill--active", b.dataset.cat === catName)
      );
      const g = $("grid");
      if(g) g.className = "grid";
      S.shown[S.type] = PER_PAGE;
      renderGrid(true);
    });
    strip.appendChild(allTile);
    section.appendChild(strip);
    return section;
  }

  function _renderBatch(){
    const end = Math.min(rowIdx + RBATCH, rowsArr.length);
    for(; rowIdx < end; rowIdx++){
      const [catName, items] = rowsArr[rowIdx];
      grid.appendChild(_buildRow(catName, items));
    }
    if(rowIdx < rowsArr.length){
      requestAnimationFrame(_renderBatch);
    } else {
      $("catalogCount").textContent = `${totalItems} éléments · ${rowsArr.length} catégories`;
    }
  }
  _renderBatch();
}

// ─────────────────────────────────────────────────────────────────
//  RENDU PRINCIPAL
// ─────────────────────────────────────────────────────────────────

function render(){
  const col   = filtered();
  const label = S.type === "vod" ? "Films" : S.type === "series" ? "Séries" : "TV en direct";

  // ── Visibilité hero + nouveautés ──
  // Films / Séries : pas de hero ni de nouveautés (design SmartersPro)
  // Live          : hero conservé tel quel (user: "laisse comme ça")
  const heroEl  = $("hero");
  const novSect = $("nouveautesSection");
  if(S.type === "live"){
    if(heroEl)  heroEl.hidden  = false;
    $("heroTitle").textContent    = label;
    $("heroSubtitle").textContent = S.cat || "";
    $("statCount").textContent    = `${col.length} éléments`;
  } else {
    if(heroEl)  heroEl.hidden  = true;
    if(novSect) novSect.hidden = true;
  }

  // Section Poursuivre — En cours + Favoris fusionnés (persiste via localStorage)
  renderPoursuivreRow();

  // Basculer qualité ↔ région selon l'onglet
  const _qp = $("qualityPills");
  const _rp = $("regionPills");
  if(S.type === "live"){
    if(_qp) _qp.style.display = "none";
    _renderRegionPills(_rp);
  } else {
    if(_qp) _qp.style.display = "";
    if(_rp) _rp.hidden = true;
    document.querySelectorAll(".quality-pill").forEach(p =>
      p.classList.toggle("quality-pill--active", p.dataset.q === S.quality)
    );
  }

  const all  = S.type === "vod" ? S.vod : S.type === "series" ? S.series : S.live;
  const cats = [...new Set(all.map(x => x.category_name).filter(Boolean))].sort();
  // Exclure les catégories adultes du <select> pour éviter le contournement du filtre 🔞
  const catsForSelect = cats.filter(c => !_isAdultCat(c) && !/vostfr/i.test(c));
  $("categorySelect").innerHTML = `<option value="">Toutes les catégories</option>` +
    catsForSelect.map(c => `<option value="${esc(c)}"${c===S.cat?" selected":""}>${esc(displayCat(c))}</option>`).join("");

  // Pills catégories (Films / Séries)
  renderCatPills(cats);

  // Mode Netflix : rangées par catégorie si aucun filtre actif (Films / Séries)
  const useNetflix = S.type !== "live" && !S.search && !S.quality && !S.cat;

  // Grille adaptée au type
  const grid = $("grid");
  if(grid) grid.className = useNetflix ? "netflix-rows"
                          : S.type === "live" ? "grid grid--live" : "grid";

  S.shown[S.type] = PER_PAGE;
  if(useNetflix) renderNetflixRows();
  else           renderGrid(true);
}

// ─────────────────────────────────────────────────────────────────
//  PILLS RÉGION (onglet TV Live)
// ─────────────────────────────────────────────────────────────────

function _renderRegionPills(container){
  if(!container) return;
  container.hidden = false;

  // Récupérer les régions détectées depuis le flux live
  let regions = [];
  try { regions = JSON.parse(localStorage.getItem("pipsily_available_regions") || "[]"); } catch(e){}

  const cur = S.region.toLowerCase();

  // Pill "Tout" + une pill par région détectée
  container.innerHTML =
    `<button class="quality-pill ${!S.region ? "quality-pill--active" : ""}" data-rgn="">🌍 Tout</button>` +
    regions.map(r => {
      const lc = r.toLowerCase();
      return `<button class="quality-pill ${lc === cur ? "quality-pill--active" : ""}" data-rgn="${esc(lc)}">${esc(r.charAt(0).toUpperCase()+r.slice(1))}</button>`;
    }).join("");

  // Gestionnaire de clic sur chaque pill
  container.querySelectorAll("[data-rgn]").forEach(btn => {
    btn.onclick = () => {
      const val = btn.dataset.rgn;
      S.region = val;
      S._liveRegionIdx = null; // forcer recalcul
      if(val) localStorage.setItem("pipsily_region", val);
      else    localStorage.removeItem("pipsily_region");
      render();
    };
  });
}

// ─────────────────────────────────────────────────────────────────
//  PILLS CATÉGORIES
// ─────────────────────────────────────────────────────────────────

function renderCatPills(cats){
  const pills = $("catPills");
  if(!pills) return;
  pills.hidden = false;

  // Séparer catégories normales et adultes
  const normalCats = cats.filter(c => !_isAdultCat(c) && !/vostfr/i.test(c));
  const hasAdult   = cats.some(c => _isAdultCat(c));

  const hasAdultPin = !!localStorage.getItem("pipsily_adult_pin");
  pills.innerHTML =
    `<button class="cat-pill cat-pill--search" data-search="1" aria-label="Rechercher">🔍</button>` +
    `<button class="cat-pill ${!S.cat ? "cat-pill--active" : ""}" data-cat="">Tout</button>` +
    normalCats.map(c =>
      `<button class="cat-pill ${c===S.cat ? "cat-pill--active" : ""}" data-cat="${esc(c)}">${esc(displayCat(c))}</button>`
    ).join("") +
    (hasAdult && hasAdultPin
      ? `<button class="cat-pill ${S.cat==="__ADULT__" ? "cat-pill--active" : ""}" data-cat="__ADULT__" style="color:#ff8899">🔞 Adult</button>`
      : "");

  // ── Bouton recherche : ouvre un overlay plein écran ──
  pills.querySelector(".cat-pill--search")?.addEventListener("click", () => openSearchOverlay());

  pills.querySelectorAll(".cat-pill[data-cat]").forEach(btn => {
    btn.addEventListener("click", () => {
      const cat = btn.dataset.cat;

      // ── Pill adulte : demander PIN si session pas encore déverrouillée ──
      if(cat === "__ADULT__" && !sessionStorage.getItem("pipsily_adult_unlocked")){
        const stored = localStorage.getItem("pipsily_adult_pin");
        if(!stored){ return; } // pas de PIN configuré → ignorer
        showAdultPinPrompt(pills);
        return;
      }

      S.cat = cat;
      const sel = $("categorySelect");
      if(sel) sel.value = S.cat;
      S.shown[S.type] = PER_PAGE;
      pills.querySelectorAll(".cat-pill[data-cat]").forEach(b =>
        b.classList.toggle("cat-pill--active", b.dataset.cat === S.cat)
      );
      // Revenir aux rangées Netflix si "Tout" est sélectionné et aucun filtre actif
      const useNetflix = !S.cat && !S.search && !S.quality;
      const g = $("grid");
      if(g) g.className = useNetflix ? "netflix-rows"
                        : S.type === "live" ? "grid grid--live" : "grid";
      if(useNetflix) renderNetflixRows();
      else           renderGrid(true);
    });
  });
}

// ── Overlay PIN adulte ────────────────────────────────────────────
function showAdultPinPrompt(pills){
  if($("adultPinOverlay")) return;
  const ov = document.createElement("div");
  ov.id = "adultPinOverlay";
  ov.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.78);z-index:9999;display:flex;align-items:center;justify-content:center";
  ov.innerHTML =
    '<div style="background:#0c1422;border:1px solid rgba(255,255,255,.12);border-radius:20px;padding:28px 24px;width:min(320px,90vw);text-align:center">' +
      '<div style="font-size:28px;margin-bottom:10px">🔞</div>' +
      '<div style="font-size:16px;font-weight:800;color:#eef4ff;margin-bottom:6px">Contenu adulte</div>' +
      '<div style="font-size:13px;color:#7a9cc0;margin-bottom:18px">Entrez votre code PIN</div>' +
      '<input id="adultPinInput" type="password" inputmode="numeric" maxlength="6" placeholder="••••"' +
        ' style="width:100%;padding:12px;border-radius:11px;border:1px solid rgba(255,255,255,.15);' +
        'background:rgba(255,255,255,.07);color:#eef4ff;font-size:20px;text-align:center;' +
        'outline:none;letter-spacing:6px;margin-bottom:12px;box-sizing:border-box" />' +
      '<div id="adultPinErr" style="color:#ff8899;font-size:13px;margin-bottom:10px;min-height:18px"></div>' +
      '<div style="display:flex;gap:10px">' +
        '<button id="adultPinCancel" style="flex:1;padding:11px;border-radius:11px;border:1px solid rgba(255,255,255,.1);background:transparent;color:#7a9cc0;cursor:pointer;font-size:14px">Annuler</button>' +
        '<button id="adultPinOk" style="flex:1;padding:11px;border-radius:11px;border:none;background:linear-gradient(135deg,#7B5FE8,#38A8E8);color:#fff;cursor:pointer;font-size:14px;font-weight:700">Valider</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(ov);
  const inp = $("adultPinInput");
  setTimeout(() => inp && inp.focus(), 60);

  const close = () => ov.remove();
  $("adultPinCancel").onclick = close;

  const validate = () => {
    const entered = inp ? inp.value.trim() : "";
    const stored  = localStorage.getItem("pipsily_adult_pin");
    if(entered === stored){
      sessionStorage.setItem("pipsily_adult_unlocked", "1");
      close();
      // Activer la pill adult et afficher le contenu
      S.cat = "__ADULT__";
      if(pills) pills.querySelectorAll(".cat-pill[data-cat]").forEach(b =>
        b.classList.toggle("cat-pill--active", b.dataset.cat === "__ADULT__")
      );
      S.shown[S.type] = PER_PAGE;
      const g = $("grid");
      if(g) g.className = "grid";
      renderGrid(true);
      if(typeof renderPoursuivreRow === "function") renderPoursuivreRow();
    } else {
      const err = $("adultPinErr");
      if(err) err.textContent = "Code incorrect";
      if(inp){ inp.value = ""; inp.focus(); }
    }
  };
  $("adultPinOk").onclick = validate;
  if(inp) inp.addEventListener("keydown", e => {
    if(e.key === "Enter") validate();
    if(e.key === "Escape") close();
  });
}



// ── Overlay de recherche plein écran (TV-friendly) ──
function openSearchOverlay(){
  if($("searchOverlay")) return;
  const ov = document.createElement("div");
  ov.id = "searchOverlay";
  ov.className = "search-overlay";
  ov.innerHTML = `
    <div class="search-overlay__box">
      <h2 class="search-overlay__title">🔍 Rechercher</h2>
      <input id="searchOverlayInput" type="search" autocomplete="off"
             placeholder="Tapez un titre…" />
      <div class="search-overlay__hint">Entrée : valider · Échap : fermer</div>
    </div>`;
  document.body.appendChild(ov);
  const inp = $("searchOverlayInput");
  inp.value = S.search || "";
  setTimeout(() => inp.focus(), 50);
  const close = () => { ov.remove(); document.querySelector(".cat-pill--search")?.focus(); };
  inp.addEventListener("keydown", e => {
    if(e.key === "Escape"){ e.preventDefault(); close(); }
    else if(e.key === "Enter"){
      e.preventDefault();
      S.search = inp.value.trim();
      $("searchInput").value = S.search;
      S.shown[S.type] = PER_PAGE;
      const useNetflix = !S.cat && !S.search && !S.quality;
      const g = $("grid");
      if(g) g.className = useNetflix ? "netflix-rows"
                        : S.type === "live" ? "grid grid--live" : "grid";
      if(useNetflix) renderNetflixRows(); else renderGrid(true);
      close();
    }
  });
  ov.addEventListener("click", e => { if(e.target === ov) close(); });
}

// ─────────────────────────────────────────────────────────────────
//  SON DE NAVIGATION — tick synthétique via Web Audio API
//  Pas de fichier externe, fonctionne hors-ligne
// ─────────────────────────────────────────────────────────────────

let _audioCtx = null;
function _playNavClick(){
  try {
    if(!window.AudioContext && !window.webkitAudioContext) return;
    if(!_audioCtx || _audioCtx.state === "closed"){
      _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if(_audioCtx.state === "suspended") _audioCtx.resume();
    const ctx  = _audioCtx;
    const now  = ctx.currentTime;
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.setValueAtTime(720, now);
    osc.frequency.exponentialRampToValueAtTime(360, now + 0.055);
    gain.gain.setValueAtTime(0.18, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.07);
    osc.start(now);
    osc.stop(now + 0.07);
  } catch(e){}
}

// ─────────────────────────────────────────────────────────────────
//  APERÇU VIDÉO "IN-TILE" — lecture live dans la vignette focalisée
// ─────────────────────────────────────────────────────────────────

let _previewTimer = null;
let _previewKey   = null;
let _previewUrls  = [];   // file de candidats : qualité la plus basse → la plus haute
let _previewIdx   = 0;
let _previewCard  = null;

function _previewSendRect(){
  if(typeof window.AndroidBridge?.startLivePreview !== "function") return;
  const card = _previewCard;
  const url  = _previewUrls[_previewIdx];
  if(!card || !card.isConnected || !url) return;
  const media = card.querySelector(".card-media, .nrow-media") || card;
  const r = media.getBoundingClientRect();
  if(r.width <= 0 || r.height <= 0) return;
  const dpr = window.devicePixelRatio || 1;
  try{
    window.AndroidBridge.startLivePreview(
      url,
      Math.round(r.left   * dpr), Math.round(r.top    * dpr),
      Math.round(r.width  * dpr), Math.round(r.height * dpr)
    );
  }catch{}
}

// Appelé par le natif (TvActivity) quand le flux d'aperçu échoue :
// on tente la qualité suivante du même groupe (les flux SD IPTV sont souvent morts)
window.onLivePreviewError = function(){
  if(!_previewKey) return;
  _previewIdx++;
  if(_previewIdx >= _previewUrls.length) return;  // plus de candidat → poster
  _previewSendRect();
};

function managePreview(){
  const card = document.activeElement?.closest?.(".card, .nrow-card");
  const item = card?._pfItem;

  if(!item || item.type !== "live"){ stopPreview(); return; }

  const key = card.dataset.key;
  if(_previewKey === key) return;
  stopPreview();
  _previewKey  = key;
  _previewCard = card;

  // Candidats : toutes les qualités du groupe, de la plus BASSE (légère,
  // anti-saccades) à la plus haute — bascule auto si un flux est mort
  if(item._variants && item._variants.length){
    // _variants est trié meilleure qualité d'abord → on inverse
    _previewUrls = [...item._variants].reverse()
      .map(v => v.item?.url || v.item?.stream_url || "")
      .filter(Boolean);
  } else {
    _previewUrls = [item.url || item.stream_url || ""].filter(Boolean);
  }
  _previewIdx = 0;
  if(!_previewUrls.length) return;

  _previewTimer = setTimeout(() => {
    _previewSendRect();
    // Re-caler une fois le scroll fluide terminé (le natif repositionne sans redémarrer le flux)
    setTimeout(() => { if(_previewKey === key) _previewSendRect(); }, 550);
  }, 850);
}

function stopPreview(){
  if(_previewTimer){ clearTimeout(_previewTimer); _previewTimer = null; }
  _previewKey  = null;
  _previewCard = null;
  _previewUrls = [];
  _previewIdx  = 0;
  try{ window.AndroidBridge?.stopLivePreview?.(); }catch{}
}

// ─────────────────────────────────────────────────────────────────
//  NAVIGATION CLAVIER / D-PAD TV
// ─────────────────────────────────────────────────────────────────

function initTV(){
  // ── Aperçu live dans la vignette focalisée (D-pad + souris) ──
  document.addEventListener("focusin", managePreview);
  // Focus perdu (re-render, élément retiré du DOM) → body redevient actif sans focusin
  document.addEventListener("focusout", () => {
    setTimeout(() => {
      const ae = document.activeElement;
      if(!ae || ae === document.body) stopPreview();
    }, 0);
  });

  // ── Navigation D-pad TV unifiée — un seul handler, 3 modes clairs ──
  document.addEventListener("keydown", e => {
    const k = e.key;

    // Retour / Fermeture panneau — toujours preventDefault pour ne pas quitter l'app
    if(["Escape","GoBack","Back","BrowserBack"].includes(k)){
      e.preventDefault();
      if(!$("seriesPanel")?.hidden){
        if(S.panel.isVod) closeVodPanel(); else closePanel();
      }
      return;
    }

    if(!["ArrowUp","ArrowDown","ArrowLeft","ArrowRight"].includes(k)) return;
    e.preventDefault();
    _playNavClick();

    const panelOpen  = !$("seriesPanel")?.hidden;
    const useNetflix = $("grid")?.classList.contains("netflix-rows");

    if(panelOpen)  { _navPanel(k);   return; }
    if(useNetflix) { _navNetflix(k); return; }
    _navGrid(k);
  });

  // ── Mode panneau séries / VOD ──
  function _navPanel(k){
    const panel = $("seriesPanel");
    if(!panel) return;

    // ── Panneau Film (VOD) : navigation linéaire simple ──
    if(S.panel.isVod){
      const items = [...panel.querySelectorAll(
        ".vod-play-btn, .vod-restart-btn, .fav-btn-large, .sp-close," +
        ".sp-resume-play, .sp-resume-restart, .sp-resume-dismiss"
      )].filter(el => !el.closest("[hidden]"));
      const idx = items.indexOf(document.activeElement);
      if(idx < 0){ items[0]?.focus(); return; }
      if(k === "ArrowDown" || k === "ArrowRight") items[Math.min(idx+1, items.length-1)]?.focus();
      else if(k === "ArrowUp" || k === "ArrowLeft") items[Math.max(idx-1, 0)]?.focus();
      return;
    }

    // ── Panneau Série : navigation 2D complète ──
    // Zones (de haut en bas) :
    //   close   : #seriesCloseBtn  (✕ en haut à droite)
    //   actions : Reprendre/Lire + Restart + Favoris  (dans .sp-series-actions)
    //   tabs    : onglets saisons  (horizontal)
    //   eps     : boutons épisodes (vertical)
    const active = document.activeElement;

    const closeBtn   = panel.querySelector("#seriesCloseBtn");
    const actionBtns = [...panel.querySelectorAll(
      ".sp-series-actions .vod-play-btn," +
      ".sp-series-actions .vod-restart-btn," +
      ".sp-series-actions .fav-btn-large"
    )].filter(el => !el.closest("[hidden]"));
    const tabs = [...panel.querySelectorAll(".sp-tab")]
                   .filter(el => !el.closest("[hidden]"));
    const eps  = [...panel.querySelectorAll(".sp-ep:not([disabled])")]
                   .filter(el => !el.closest("[hidden]"));

    const isClose  = active === closeBtn;
    const isAction = actionBtns.includes(active);
    const isTab    = active?.classList.contains("sp-tab");
    const isEp     = active?.classList.contains("sp-ep");

    // Focus initial si rien n'est focalisé dans le panneau
    if(!isClose && !isAction && !isTab && !isEp){
      (actionBtns[0] || tabs[0] || eps[0])?.focus();
      return;
    }

    // ── Bouton Fermer (✕) ──
    if(isClose){
      if(k === "ArrowDown"){
        (actionBtns[0] || tabs[0] || eps[0])?.focus();
      }
      // ← → sans effet sur le close
      return;
    }

    // ── Boutons d'action (Reprendre/Lire, Depuis le début, Favoris) ──
    if(isAction){
      const ai = actionBtns.indexOf(active);
      if(k === "ArrowRight"){ actionBtns[Math.min(ai+1, actionBtns.length-1)]?.focus(); return; }
      if(k === "ArrowLeft") { actionBtns[Math.max(ai-1, 0)]?.focus();                   return; }
      if(k === "ArrowUp")   { closeBtn?.focus(); panel.scrollTo?.({top:0,behavior:"smooth"}); return; }
      if(k === "ArrowDown") { (tabs[0] || eps[0])?.focus(); return; }
      return;
    }

    // ── Onglets saisons ──
    if(isTab){
      const ti = tabs.indexOf(active);
      if(k === "ArrowRight" && ti < tabs.length-1){ tabs[ti+1].focus(); return; }
      if(k === "ArrowLeft"  && ti > 0)            { tabs[ti-1].focus(); return; }
      if(k === "ArrowUp")   { (actionBtns[0] || closeBtn)?.focus(); panel.scrollTo?.({top:0,behavior:"smooth"}); return; }
      if(k === "ArrowDown") { eps[0]?.focus(); return; }
      return;
    }

    // ── Épisodes (liste verticale) ──
    if(isEp){
      const ei = eps.indexOf(active);
      if(k === "ArrowDown"){
        if(ei < eps.length-1){
          eps[ei+1].focus();
          eps[ei+1].scrollIntoView({ behavior:"smooth", block:"nearest" });
        }
        return;
      }
      if(k === "ArrowUp"){
        if(ei > 0){
          eps[ei-1].focus();
          eps[ei-1].scrollIntoView({ behavior:"smooth", block:"nearest" });
        } else {
          // Premier épisode → remonter aux onglets (s'il y en a) ou aux boutons
          (tabs[0] || actionBtns[0])?.focus();
          panel.scrollTo?.({ top:0, behavior:"smooth" });
        }
        return;
      }
      // ← → ignorés dans la liste épisodes
      return;
    }
  }

  // ── Helper : focus sur le 1er pill catégorie (ou pill actif) ──
  function _focusFirstPill(){
    const pills = $("catPills");
    if(!pills || pills.hidden) return false;
    const target = pills.querySelector(".cat-pill--active") || pills.querySelector(".cat-pill");
    if(target){
      target.focus();
      target.scrollIntoView({ behavior:"smooth", block:"nearest", inline:"center" });
      // Remonter tout en haut de la page pour que les pills soient visibles
      window.scrollTo({ top: 0, behavior: "smooth" });
      return true;
    }
    return false;
  }

  // ── Mode Netflix rows ──
  // Gère les rangées nrow (Netflix) ET nou-row (Favoris / Continuer / Nouveautés)
  function _navNetflix(k){
    const active   = document.activeElement;
    const isPill   = active?.classList.contains("cat-pill");
    const isNavBtn = active?.classList.contains("nav-btn");
    const isNouCard = active?.classList.contains("nou-card");

    // ── Helper : première nou-card visible (favoris / continuer) ──
    const _firstNouCard = () => {
      for(const row of document.querySelectorAll(".nou-row")){
        if(row.closest("[hidden]")) continue;
        const c = row.querySelector(".nou-card");
        if(c) return c;
      }
      return null;
    };

    // ── Sur une nou-card (favoris / continuer) ──
    if(isNouCard){
      const row   = active.closest(".nou-row");
      const cards = row ? [...row.querySelectorAll(".nou-card")] : [];
      const ci    = cards.indexOf(active);
      if(k === "ArrowRight"){
        const next = cards[ci + 1];
        if(next){ next.focus(); next.scrollIntoView({ behavior:"smooth", block:"nearest", inline:"center" }); }
        return;
      }
      if(k === "ArrowLeft"){
        const prev = cards[ci - 1];
        if(prev){ prev.focus(); prev.scrollIntoView({ behavior:"smooth", block:"nearest", inline:"center" }); }
        return;
      }
      if(k === "ArrowUp"){
        // Chercher la nou-row précédente, sinon remonter aux pills
        const allRows = [...document.querySelectorAll(".nou-row")].filter(r => !r.closest("[hidden]"));
        const ri = allRows.indexOf(row);
        if(ri > 0){
          const prevRow = allRows[ri - 1];
          const prevCard = prevRow.querySelectorAll(".nou-card")[ci] || prevRow.querySelector(".nou-card");
          prevCard?.focus(); prevCard?.scrollIntoView({ behavior:"smooth", block:"nearest" });
        } else {
          if(!_focusFirstPill()) document.querySelector(".nav-btn.active, .nav-btn")?.focus();
          window.scrollTo({ top: 0, behavior: "smooth" });
        }
        return;
      }
      if(k === "ArrowDown"){
        // Passer à la prochaine nou-row ou à la grille principale
        const allRows = [...document.querySelectorAll(".nou-row")].filter(r => !r.closest("[hidden]"));
        const ri = allRows.indexOf(row);
        if(ri >= 0 && ri < allRows.length - 1){
          const nextRow  = allRows[ri + 1];
          const nextCard = nextRow.querySelectorAll(".nou-card")[ci] || nextRow.querySelector(".nou-card");
          nextCard?.focus(); nextCard?.scrollIntoView({ behavior:"smooth", block:"nearest" });
        } else {
          // .nrow-card en mode Netflix, .card en mode grille
          const first = document.querySelector(".nrow-card, .card");
          if(first){ first.focus(); first.scrollIntoView({ behavior:"smooth", block:"nearest" }); }
        }
        return;
      }
      // Ne pas consommer les touches non-flèches (Enter/Space gérés par le card lui-même)
    }

    // Toutes les rangées visibles dans l'ordre DOM :
    //   1. nou-row (Continuer, Favoris, Nouveautés) — seulement si section visible + non vide
    //   2. nrow (rangées Netflix par catégorie)
    const CARD = ".nrow-card, .nou-card";
    const allRows = [
      ...[...document.querySelectorAll(".nou-row")]
          .filter(r => !r.closest("[hidden]") && r.children.length > 0),
      ...document.querySelectorAll(".nrow")
    ];

    const currentRow = active?.closest(".nrow, .nou-row");
    const rowIdx     = allRows.indexOf(currentRow);

    // ── Sur les nav-btns (top) : Films/Séries/TV ──
    if(isNavBtn){
      const navBtns = [...document.querySelectorAll(".nav-btn[data-type]")];
      const ni = navBtns.indexOf(active);
      if(k === "ArrowRight" && ni < navBtns.length - 1){ navBtns[ni + 1].focus(); return; }
      if(k === "ArrowLeft"  && ni > 0){ navBtns[ni - 1].focus(); return; }
      if(k === "ArrowUp"){
        // Remonter vers les boutons utilisateur (Admin / Compte / Install)
        const uBtns = [...document.querySelectorAll("#topbarUserBtns a, #topbarUserBtns button")]
          .filter(el => getComputedStyle(el).display !== "none");
        if(uBtns.length) { uBtns[0].focus(); return; }
      }
      if(k === "ArrowDown"){
        if(_focusFirstPill()) return;
        const first = allRows[0]?.querySelector(CARD);
        if(first){ first.focus(); first.scrollIntoView({ behavior:"smooth", block:"nearest" }); }
      }
      return;
    }

    // ── Sur les boutons utilisateur (Admin / Compte / Install) ──
    const isUserBtn = active?.closest("#topbarUserBtns") !== null;
    if(isUserBtn){
      const uBtns = [...document.querySelectorAll("#topbarUserBtns a, #topbarUserBtns button")]
        .filter(el => getComputedStyle(el).display !== "none");
      const ui = uBtns.indexOf(active);
      if(k === "ArrowRight" && ui < uBtns.length-1){ uBtns[ui+1].focus(); return; }
      if(k === "ArrowLeft"  && ui > 0)             { uBtns[ui-1].focus(); return; }
      if(k === "ArrowDown"){
        document.querySelector(".nav-btn.active, .nav-btn")?.focus();
        return;
      }
      return;
    }

    // ── Sur les cat-pills (filtres catégorie) ──
    if(isPill){
      const pills = [...document.querySelectorAll(".cat-pill")];
      const pi = pills.indexOf(active);
      if(k === "ArrowRight" && pi < pills.length - 1){
        pills[pi + 1].focus();
        pills[pi + 1].scrollIntoView({ behavior:"smooth", block:"nearest", inline:"center" });
        return;
      }
      if(k === "ArrowLeft" && pi > 0){
        pills[pi - 1].focus();
        pills[pi - 1].scrollIntoView({ behavior:"smooth", block:"nearest", inline:"center" });
        return;
      }
      if(k === "ArrowUp"){
        document.querySelector(".nav-btn.active, .nav-btn")?.focus();
        return;
      }
      if(k === "ArrowDown"){
        const first = allRows[0]?.querySelector(CARD);
        if(first){ first.focus(); first.scrollIntoView({ behavior:"smooth", block:"nearest" }); }
        return;
      }
      return;
    }

    // ── Gauche / Droite : navigation dans la bande courante ──
    if(k === "ArrowRight" || k === "ArrowLeft"){
      if(!currentRow) return;
      const cards = [...currentRow.querySelectorAll(CARD)];
      const ci    = cards.indexOf(active);
      if(ci < 0) return;
      const next = k === "ArrowRight" ? cards[ci + 1] : cards[ci - 1];
      if(next){ next.focus(); next.scrollIntoView({ behavior:"smooth", block:"nearest", inline:"center" }); }
      return;
    }

    // ── Haut / Bas : sauter entre rangées ──
    if(rowIdx < 0){
      if(k === "ArrowDown"){
        const first = allRows[0]?.querySelector(CARD);
        if(first){ first.focus(); first.scrollIntoView({ behavior:"smooth", block:"nearest" }); }
      } else if(k === "ArrowUp"){
        // Élément détaché du DOM (re-render en cours) → remonter vers pills / nav
        if(!_focusFirstPill()) document.querySelector(".nav-btn.active,.nav-btn")?.focus();
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
      return;
    }

    let targetRow;
    if(k === "ArrowDown"){
      targetRow = allRows[rowIdx + 1];
      if(!targetRow) return;
    } else {
      targetRow = rowIdx > 0 ? allRows[rowIdx - 1] : null;
    }

    if(targetRow){
      // Garder la même position horizontale dans la rangée cible
      const cards  = [...currentRow.querySelectorAll(CARD)];
      const ci     = Math.max(0, cards.indexOf(active));
      const tCards = [...targetRow.querySelectorAll(CARD)];
      const target = tCards[Math.min(ci, tCards.length - 1)] || tCards[0];
      if(target){ target.focus(); target.scrollIntoView({ behavior:"smooth", block:"nearest" }); }
    } else {
      // Plus de rangée au-dessus → remonter aux pills ou aux boutons de nav
      if(!_focusFirstPill()){
        document.querySelector(".nav-btn.active, .nav-btn")?.focus();
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    }
  }

  // ── Mode grille normale (Live ou catégorie filtrée) ──
  function _navGrid(k){
    const active   = document.activeElement;
    const isPill   = active?.classList.contains("cat-pill");
    const isNavBtn = active?.classList.contains("nav-btn");

    // ── Helper : première nou-card visible (favoris / continuer) ──
    const _firstNouCard = () => {
      for(const row of document.querySelectorAll(".nou-row")){
        if(row.closest("[hidden]")) continue;
        const c = row.querySelector(".nou-card");
        if(c) return c;
      }
      return null;
    };

    // ── Sur les nav-btns ──
    if(isNavBtn){
      const navBtns = [...document.querySelectorAll(".nav-btn[data-type]")];
      const ni = navBtns.indexOf(active);
      if(k === "ArrowRight" && ni < navBtns.length - 1){ navBtns[ni + 1].focus(); return; }
      if(k === "ArrowLeft"  && ni > 0){ navBtns[ni - 1].focus(); return; }
      if(k === "ArrowUp"){
        const uBtns = [...document.querySelectorAll("#topbarUserBtns a, #topbarUserBtns button")]
          .filter(el => getComputedStyle(el).display !== "none");
        if(uBtns.length) { uBtns[0].focus(); return; }
      }
      if(k === "ArrowDown"){
        if(_focusFirstPill()) return;
        document.querySelector(".card")?.focus();
      }
      return;
    }

    // ── Sur les boutons utilisateur (Admin / Compte / Install) ──
    const isUserBtn2 = active?.closest("#topbarUserBtns") !== null;
    if(isUserBtn2){
      const uBtns = [...document.querySelectorAll("#topbarUserBtns a, #topbarUserBtns button")]
        .filter(el => getComputedStyle(el).display !== "none");
      const ui = uBtns.indexOf(active);
      if(k === "ArrowRight" && ui < uBtns.length-1){ uBtns[ui+1].focus(); return; }
      if(k === "ArrowLeft"  && ui > 0)             { uBtns[ui-1].focus(); return; }
      if(k === "ArrowDown"){
        document.querySelector(".nav-btn.active, .nav-btn")?.focus();
        return;
      }
      return;
    }

    // ── Sur les cat-pills ──
    if(isPill){
      const pills = [...document.querySelectorAll(".cat-pill")];
      const pi = pills.indexOf(active);
      if(k === "ArrowRight" && pi < pills.length - 1){
        pills[pi + 1].focus();
        pills[pi + 1].scrollIntoView({ behavior:"smooth", block:"nearest", inline:"center" });
        return;
      }
      if(k === "ArrowLeft" && pi > 0){
        pills[pi - 1].focus();
        pills[pi - 1].scrollIntoView({ behavior:"smooth", block:"nearest", inline:"center" });
        return;
      }
      if(k === "ArrowUp"){
        document.querySelector(".nav-btn.active, .nav-btn")?.focus();
        return;
      }
      if(k === "ArrowDown"){
        document.querySelector(".card")?.focus();
        return;
      }
      return;
    }

    // ── Sur une nou-card (Continuer/Favoris) — même logique que _navNetflix ──
    const isNouCard = active?.classList.contains("nou-card");
    if(isNouCard){
      const row   = active.closest(".nou-row");
      const rCards = row ? [...row.querySelectorAll(".nou-card")] : [];
      const ci    = rCards.indexOf(active);
      if(k === "ArrowRight"){
        const nxt = rCards[ci + 1];
        if(nxt){ nxt.focus(); nxt.scrollIntoView({ behavior:"smooth", block:"nearest", inline:"center" }); }
        return;
      }
      if(k === "ArrowLeft"){
        const prv = rCards[ci - 1];
        if(prv){ prv.focus(); prv.scrollIntoView({ behavior:"smooth", block:"nearest", inline:"center" }); }
        return;
      }
      if(k === "ArrowUp"){
        // Remonter aux pills puis aux boutons de nav
        if(!_focusFirstPill()) document.querySelector(".nav-btn.active,.nav-btn")?.focus();
        window.scrollTo({ top: 0, behavior: "smooth" });
        return;
      }
      if(k === "ArrowDown"){
        const firstCard = document.querySelector(".card");
        if(firstCard){ firstCard.focus(); firstCard.scrollIntoView({ behavior:"smooth", block:"nearest" }); }
        return;
      }
      return;
    }

    // ── Sur une carte de la grille : navigation cols ──
    const cards = [...document.querySelectorAll(".card")];
    let idx = cards.indexOf(active);
    if(idx < 0){ cards[0]?.focus(); return; }

    // Nombre réel de colonnes : compter les cartes sur la 1ère ligne (offsetTop identique).
    // L'ancien forfait offsetWidth/200 était faux en mode TV (colonnes 110px/145px) →
    // les flèches ↑↓ sautaient en diagonale.
    let cols = 1;
    if(cards.length > 1){
      const top0 = cards[0].offsetTop;
      while(cols < cards.length && Math.abs(cards[cols].offsetTop - top0) < 4) cols++;
    }

    let next = idx;
    if(k === "ArrowRight")     next = Math.min(idx + 1, cards.length - 1);
    else if(k === "ArrowLeft") next = Math.max(0, idx - 1);
    else if(k === "ArrowDown") next = Math.min(idx + cols, cards.length - 1);
    else if(k === "ArrowUp")   next = idx - cols;

    if(next < 0){
      // Au-dessus de la 1ère ligne → nou-cards, sinon cat-pills, sinon nav-btns
      const nou = _firstNouCard();
      if(nou){ nou.focus(); nou.scrollIntoView({ behavior:"smooth", block:"nearest" }); return; }
      if(!_focusFirstPill()){
        document.querySelector(".nav-btn.active, .nav-btn")?.focus();
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
      return;
    }
    cards[next]?.focus();
    cards[next]?.scrollIntoView({ behavior:"smooth", block:"nearest" });
  }
}

// ─────────────────────────────────────────────────────────────────
//  SECTION POURSUIVRE — En cours + Favoris fusionnés
//  Ordre : items en cours (tri par ts desc) → favoris non commencés
// ─────────────────────────────────────────────────────────────────

function renderPoursuivreRow(){
  try { _renderPoursuivreRowInner(); } catch(e){ console.error("[PIPSILY] renderPoursuivreRow:", e); }
}
function _renderPoursuivreRowInner(){
  const sect = $("poursuivreSection");
  const row  = $("poursuivreRow");
  if(!sect || !row) return;

  // Onglet TV (live) : section non pertinente, masquée
  if(S.type === "live"){ sect.hidden = true; return; }

  const prog         = getProg();
  const type         = S.type;
  // PIN parental ne bypass PAS Poursuivre — XXX toujours masqué dans "en cours"
  // Utilise _isAdultCat (début OU fin) sur category_name uniquement.
  // title/name exclus : ils contiennent des préfixes provider non représentatifs.
  const _hideXXXItem = item => _isAdultCat(item?.category_name);

  // ── 1. Items en cours ──────────────────────────────────────────
  let inProgress = [];
  if(type === "series"){
    // Épisodes stockés sous "seriesId||SxxExx"
    const seriesIdx = {};
    S.series.forEach(s => { seriesIdx[String(s.id || s.stream_id || "")] = s; });
    const epKeyRe = /^(.+)\|\|S\d+E\d+$/;
    const best = {};
    Object.keys(prog).forEach(k => {
      const m = epKeyRe.exec(k);
      if(!m) return;
      const sid = m[1];
      if(!seriesIdx[sid]) return;
      const e = prog[k];
      if(!e?.ts) return;
      let pct = (e.t > 0 && e.d > 0) ? e.t / e.d
              : (e.pct > 0 ? e.pct : (e.t > 30 ? 0.5 : 0));
      if(pct > 1) pct /= 100; // normalise format player.js (0-100) → fraction (0-1)
      if(pct <= 0.03 || pct >= 0.97) return;
      if(!best[sid] || e.ts > best[sid].ts) best[sid] = { pct, ts: e.ts };
    });
    inProgress = Object.keys(best)
      .map(sid => ({ item: seriesIdx[sid], pct: best[sid].pct, ts: best[sid].ts }))
      .filter(x => !_hideXXXItem(x.item))
      .sort((a, b) => b.ts - a.ts).slice(0, 15);
  } else {
    const all = type === "vod" ? S.vod : S.live;
    inProgress = all.map(item => {
      const k1 = itemKey(item), k2 = String(item.id || item.stream_id || "");
      const en = prog[k1] || prog[k2];
      const rawPct = en?.pct || (en?.t > 0 && en?.d > 0 ? en.t / en.d : 0);
      const pct = rawPct > 1 ? rawPct / 100 : rawPct; // normalise format player.js (0-100) → fraction
      return { item, pct, ts: en?.ts || 0 };
    }).filter(x => x.pct > 0.03 && x.pct < 0.97 && x.ts > 0 && !_hideXXXItem(x.item))
      .sort((a, b) => b.ts - a.ts).slice(0, 15);
  }

  // ── 2. Favoris non déjà en cours ──────────────────────────────
  const inProgKeys = new Set(inProgress.map(x => itemKey(x.item)));
  const favItems = getFavs()
    .filter(f => {
      if(!f.item) return false;
      if(_hideXXXItem(f.item)) return false;
      const ftype = f.item.type || type;
      return ftype === type && !inProgKeys.has(itemKey(f.item));
    })
    .map(f => ({ item: f.item, pct: 0, ts: 0 }))
    .slice(0, 15);

  // ── 3. Fusionner — en cours d'abord, puis favoris ─────────────
  const all = [...inProgress, ...favItems].slice(0, 25);

  if(!all.length){ sect.hidden = true; return; }
  sect.hidden = false;
  row.innerHTML = "";
  const frag = document.createDocumentFragment();

  all.forEach(({ item, pct, ts }) => {
    const isLive    = item.type === "live";
    const isInProg  = ts > 0 && pct > 0.03;
    const card = document.createElement("div");
    card.className = "nou-card" + (isLive ? " nou-card--live" : "");
    card.tabIndex  = 0;

    const progBar = isInProg
      ? `<div class="card-prog-bar card-prog-bar--nou"><div class="card-prog-fill" style="width:${Math.round(pct*100)}%"></div></div>`
      : `<div class="nou-fav-badge">❤️</div>`;

    card.innerHTML = `
      <div class="nou-media">
        ${item.stream_icon
          ? `<img src="${esc(item.stream_icon)}" alt="" loading="lazy" onerror="this.style.display='none'">`
          : `<div class="nou-placeholder">${isInProg ? "▶" : "❤️"}</div>`}
        <div class="nou-overlay"><span class="nou-play">▶</span></div>
        ${progBar}
      </div>
      <div class="nou-info">
        <div class="nou-title">${esc(item.title)}</div>
        <div class="nou-date">${isInProg ? Math.round(pct*100) + "% visionné" : esc(displayCat(item.category_name) || "Favori")}</div>
      </div>`;

    const activate = () => {
      if(item.type === "series") openPanel(item);
      else if(item.type === "live"){
        if(item._variants?.length > 1) openLivePicker(item);
        else playItem(item._variants?.[0]?.item || item);
      }
      else openVodPanel(item);
    };
    card.addEventListener("click", activate);
    card.addEventListener("keydown", e => { if(e.key==="Enter"||e.key===" "){ e.preventDefault(); activate(); } });
    card.addEventListener("focus", () => {
      document.querySelectorAll(".nou-card.is-tv-focused").forEach(c => c.classList.remove("is-tv-focused"));
      card.classList.add("is-tv-focused");
      card.scrollIntoView({ behavior:"smooth", block:"nearest", inline:"center" });
    });
    card.addEventListener("blur", () => card.classList.remove("is-tv-focused"));
    frag.appendChild(card);
  });
  row.appendChild(frag);
}

// Stubs de compatibilité (call sites existants)
function renderContinueRow()  { renderPoursuivreRow(); }
function renderFavoritesRow() { renderPoursuivreRow(); }

// ─────────────────────────────────────────────────────────────────
//  SECTION NOUVEAUTÉS
// ─────────────────────────────────────────────────────────────────

function renderNouveautes(){
  const sect = $("nouveautesSection");
  const row  = $("nouveautesRow");
  if(!sect || !row) return;

  // Top 20 VOD récents (added desc) avec poster
  const recent = [...S.vod]
    .filter(x => x.added > 0 && x.stream_icon)
    .sort((a, b) => b.added - a.added)
    .slice(0, 20);

  if(!recent.length){ sect.hidden = true; return; }
  sect.hidden = false;

  row.innerHTML = "";
  const frag = document.createDocumentFragment();
  recent.forEach(item => {
    const card = document.createElement("div");
    card.className = "nou-card";
    card.tabIndex  = 0;
    const d = item.added ? new Date(item.added * 1000) : null;
    const dateStr = d
      ? d.toLocaleDateString("fr-FR", { day:"2-digit", month:"short" })
      : "";
    card.innerHTML = `
      <div class="nou-media">
        <img src="${esc(item.stream_icon)}" alt="" loading="lazy"
             onerror="this.parentElement.parentElement.style.display='none'">
        ${item.quality ? `<span class="nou-qual">${esc(item.quality)}</span>` : ""}
        <div class="nou-overlay">
          <span class="nou-play">▶</span>
        </div>
      </div>
      <div class="nou-info">
        <div class="nou-title">${esc(item.title)}</div>
        ${dateStr ? `<div class="nou-date">${dateStr}</div>` : ""}
      </div>`;
    card.addEventListener("click", () => openVodPanel(item));
    card.addEventListener("keydown", e => {
      if(e.key === "Enter" || e.key === " "){ e.preventDefault(); openVodPanel(item); }
    });
    // Classe JS pour focus visible même dans iframe (preview / webview)
    card.addEventListener("focus", () => {
      document.querySelectorAll(".nou-card.is-tv-focused").forEach(c => c.classList.remove("is-tv-focused"));
      card.classList.add("is-tv-focused");
    });
    card.addEventListener("blur", () => card.classList.remove("is-tv-focused"));
    frag.appendChild(card);
  });
  row.appendChild(frag);

  // ── Navigation D-pad TV : flèches gauche/droite dans la rangée ──
  row.addEventListener("keydown", e => {
    const cards = [...row.querySelectorAll(".nou-card")];
    const idx   = cards.indexOf(document.activeElement);
    if(idx < 0) return;
    if(e.key === "ArrowRight"){
      // stopPropagation : sinon le handler D-pad global (initTV) rejoue la touche → saut de 2 cartes
      e.preventDefault(); e.stopPropagation();
      const next = cards[idx + 1];
      if(next){ next.focus(); next.scrollIntoView({ behavior:"smooth", block:"nearest", inline:"center" }); }
    } else if(e.key === "ArrowLeft"){
      e.preventDefault(); e.stopPropagation();
      const prev = cards[idx - 1];
      if(prev){ prev.focus(); prev.scrollIntoView({ behavior:"smooth", block:"nearest", inline:"center" }); }
    }
    // ArrowUp / ArrowDown : gérés par le handler D-pad global (saut entre rangées)
  });

  // Hero : mettre en avant le 1er item avec une belle image
  renderHero(recent[0]);
}

function renderHero(item){
  const hero = $("hero");
  if(!hero || !item) return;
  if(item.stream_icon){
    hero.style.backgroundImage = `url('${item.stream_icon}')`;
    hero.classList.add("hero--img");
  }
  $("heroTitle").textContent    = item.title || "PIPSILY";
  $("heroSubtitle").textContent = item.category_name || "";
}

// ─────────────────────────────────────────────────────────────────
//  BOOT
// ─────────────────────────────────────────────────────────────────

async function boot(){

  // ── Purger le cache région corrompu (noms de chaînes au lieu de régions) ──
  // Les anciennes versions stockaient n'importe quel suffixe ; on purge pour reconstruire proprement.
  try {
    const cached = JSON.parse(localStorage.getItem("pipsily_available_regions") || "[]");
    // Si la liste contient des entrées avec des chiffres ou des tirets initiaux → corrompue
    const corrupted = cached.some(r =>
      /^\d|^[-–]/.test(r) ||            // commence par chiffre ou tiret
      /[()[\]\d]/.test(r) ||             // contient parenthèses, crochets ou chiffres
      r.length > 35 ||                   // trop long pour être un nom de région
      /event|only|action|cinema|sport|series|kids|gaming/i.test(r) // mots thématiques
    );
    if(corrupted) localStorage.removeItem("pipsily_available_regions");
  } catch(e){ localStorage.removeItem("pipsily_available_regions"); }

  // ── Classe CSS TV (failsafe si le media query ne se déclenche pas) ──
  if(window.PIPSILY_NATIVE === "android_tv" || window.PIPSIFLIX_NATIVE === "android_tv" ||
     /AndroidTV|GoogleTV|SmartTV/i.test(navigator.userAgent)){
    document.documentElement.classList.add("is-tv");
  }

  // ── Auto-refresh catalogue au démarrage : si un nouveau SW est en
  //    attente, on l'active silencieusement (sans bouton manuel) ──
  if("serviceWorker" in navigator){
    navigator.serviceWorker.ready.then(reg => {
      if(reg.waiting){
        reg.waiting.postMessage({ type:"SKIP_WAITING" });
      }
      // Vérifier les MAJ à chaque démarrage
      reg.update?.().catch(() => {});
    }).catch(() => {});
  }

  // ── Auth gate (APK + PWA) ──
  // Wrapped dans try-catch : une exception dans authGate() (ex: tables Supabase manquantes)
  // ne doit JAMAIS empêcher l'application de démarrer.
  if(window.PIPSILY_AUTH){
    let auth;
    try {
      auth = await window.PIPSILY_AUTH.authGate();
    } catch(e) {
      console.error("[PIPSILY] authGate crash (tables manquantes ?):", e.message);
      let _sess = null;
      try { _sess = await window.PIPSILY_AUTH.getSession?.(); } catch{}
      const _em = (_sess?.user?.email || "").toLowerCase();
      const _adm = _em && _em === (window.PIPSILY_AUTH?.ADMIN_EMAIL || "").toLowerCase();
      auth = { session: _sess || { user: { id: "err" } }, sub: { ok: true, plan: _adm ? "admin" : "active", unlimited: _adm } };
    }
    if(!auth) return; // redirigé vers login.html ou paywall

    S._userId  = auth.session?.user?.id || "err";
    S._isAdmin = auth.sub.plan === "admin" || (auth.session?.user?.email||"").toLowerCase() === (window.PIPSILY_AUTH.ADMIN_EMAIL||"").toLowerCase();
    S._unlim   = auth.sub.unlimited;

    const userBtns = $("topbarUserBtns");
    if(userBtns) userBtns.style.display = "flex";
    if(S._isAdmin){
      const adminBtn = $("adminBtn");
      if(adminBtn) adminBtn.style.display = "inline-flex";
    }

    // Surveillance session : déconnexion forcée si autre appareil se connecte (Standard/Test)
    window.PIPSILY_AUTH.startSessionWatcher?.(S._userId);
  }

  // Navigation type
  document.querySelectorAll(".nav-btn[data-type]").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".nav-btn[data-type]").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      // Fermer le panneau s'il est ouvert
      if(S.panel?.open){ closePanel?.(); }
      S.type    = btn.dataset.type;
      S.loading = false;
      S.cat     = "";
      S.search  = "";
      S.quality = "";
      S.sort    = "title";
      S.favOnly = false;
      $("searchInput").value = "";
      // Reset pilules qualité → "Tout"
      document.querySelectorAll(".quality-pill").forEach(p => p.classList.remove("quality-pill--active"));
      document.querySelector(".quality-pill[data-q='']")?.classList.add("quality-pill--active");
      $("favFilterBtn")?.classList.remove("quality-pill--active");
      // Placeholder dynamique selon la section
      const ph = { vod:"Rechercher un film…", series:"Rechercher une série…", live:"Rechercher une chaîne…" };
      $("searchInput").placeholder = ph[S.type] || "Rechercher…";
      // Remettre le scroll en haut
      window.scrollTo({ top: 0, behavior: "instant" });
      render();
    });
  });

  // Barre fixe "Mettre à jour"
  $("refreshCacheBtn")?.addEventListener("click", async () => {
    const btn  = $("refreshCacheBtn");
    const date = $("lastUpdateDate");
    btn.disabled    = true;
    btn.textContent = "⏳ Mise à jour…";
    if(date) date.textContent = "Actualisation en cours…";

    // APK Android : activer le nouveau SW s'il est en attente, puis vider le cache WebView
    const isNativeApk = typeof window.AndroidBridge !== "undefined";
    if(isNativeApk){
      try {
        const reg = await navigator.serviceWorker?.ready;
        if(reg?.waiting){
          // Nouveau SW disponible → l'activer. Il enverra RELOAD à toutes les fenêtres.
          reg.waiting.postMessage({ type:"SKIP_WAITING" });
          // Laisser le RELOAD du SW s'en charger (évite race condition avec clearCache)
          return;
        }
      } catch {}
      // Pas de SW en attente → juste vider le cache WebView (données fraîches)
      if(window.AndroidBridge?.clearCache){
        try { window.AndroidBridge.clearCache(); } catch(e){}
      } else {
        window.location.reload();
      }
      return;
    }

    // PWA / navigateur : vider le cache Service Worker
    try {
      if("caches" in window){
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
      }
      const reg = await navigator.serviceWorker?.ready;
      if(reg?.waiting) reg.waiting.postMessage({ type:"SKIP_WAITING" });
    } catch {}
    // Reload forcé avec timestamp pour bypasser le SW
    window.location.href = window.location.href.split("?")[0] + "?nocache=" + Date.now();
  });

  $("categorySelect").addEventListener("change", e => { S.cat = e.target.value; render(); });
  let _searchTimer = null;
  $("searchInput").addEventListener("input", e => {
    S.search = e.target.value;
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(render, 250);
  });
  $("sortSelect").addEventListener("change",  e => { S.sort = e.target.value; render(); });

  // Pilules qualité — remplacent le <select>
  document.querySelectorAll(".quality-pill:not(.fav-pill)").forEach(btn => {
    btn.addEventListener("click", () => {
      S.quality  = btn.dataset.q || "";
      S.favOnly  = false;
      document.querySelectorAll(".quality-pill").forEach(p => p.classList.remove("quality-pill--active"));
      btn.classList.add("quality-pill--active");
      render();
    });
  });

  // Bouton ❤️ Favoris dans la barre (remplace la section mid-page)
  $("favFilterBtn")?.addEventListener("click", () => {
    S.favOnly = !S.favOnly;
    S.quality = "";
    document.querySelectorAll(".quality-pill").forEach(p => p.classList.remove("quality-pill--active"));
    if(!S.favOnly) document.querySelector(".quality-pill[data-q='']")?.classList.add("quality-pill--active");
    $("favFilterBtn")?.classList.toggle("quality-pill--active", S.favOnly);
    S.shown[S.type] = PER_PAGE;
    render();
  });

  // Clic backdrop
  $("seriesPanel")?.addEventListener("click", e => {
    if(e.target === $("seriesPanel")) closePanel();
  });

  // Infinite scroll
  new IntersectionObserver(
    entries => { if(entries[0].isIntersecting) loadMore(); },
    { rootMargin: SENTINEL_M }
  ).observe($("gridSentinel"));

  initTV();

  // ── Retour Android / Échap : ferme le panneau ouvert (sans quitter l'app) ──
  window.addEventListener("popstate", () => {
    const picker = document.getElementById("livePicker");
    if(picker){ picker._closePicker?.(true); return; }
    if(S.panel.open && S.panel.isVod) { closeVodPanel(true);  return; }
    if(S.panel.open)                  { closePanel(true);      return; }
    if($("pip-player")?.classList.contains("pip-open")) { PipPlayer.close(); }
  });

  // ── Copie URL — fallback pour Safari sans clipboard API ─────────
  function _copyFallback(text){
    try {
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.cssText = "position:fixed;opacity:0;top:0;left:0";
      document.body.appendChild(ta); ta.focus(); ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      PipPlayer._showStatus("✓ Lien copié !");
    } catch { PipPlayer._showStatus("Lien : " + text); }
  }

  // ── Initialisation du lecteur interne ────────────────────────────
  $("pip-back")?.addEventListener("click", () => PipPlayer.close());
  $("pip-fav")?.addEventListener("click",  () => PipPlayer.toggleFav());
  $("pip-prev")?.addEventListener("click", () => PipPlayer.goPrev());
  $("pip-next")?.addEventListener("click", () => PipPlayer.goNext());
  $("pip-native")?.addEventListener("click", () => PipPlayer.openNative());
  $("pip-vlc")?.addEventListener("click",    () => PipPlayer.openVLC());
  $("pip-infuse")?.addEventListener("click", () => PipPlayer.openInfuse());
  // Afficher les boutons iOS uniquement sur iPhone / iPad
  if(isIOS){
    const iosBar = $("pip-ios-actions");
    if(iosBar) iosBar.hidden = false;
  }
  $("pip-fullscreen")?.addEventListener("click", () => {
    const v = $("pip-video");
    if(!v) return;
    // Safari utilise webkitFullscreenElement / webkitExitFullscreen
    if(document.fullscreenElement || document.webkitFullscreenElement){
      (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
    } else {
      (v.requestFullscreen || v.webkitRequestFullscreen || v.mozRequestFullScreen)?.call(v);
    }
  });
  $("pip-copy")?.addEventListener("click", () => {
    const url = PipPlayer._item?.url || PipPlayer._item?.stream_url || "";
    if(!url) return;
    // Safari < 13.1 ou non-HTTPS : fallback execCommand
    if(navigator.clipboard){
      navigator.clipboard.writeText(url)
        .then(() => PipPlayer._showStatus("✓ Lien copié !"))
        .catch(() => _copyFallback(url));
    } else {
      _copyFallback(url);
    }
  });
  // Fermeture par touche Échap / retour TV
  document.addEventListener("keydown", e => {
    if(!$("pip-player")?.classList.contains("pip-open")) return;
    const k = e.key;
    if(["Escape","GoBack","BrowserBack","Back"].includes(k)){ e.preventDefault(); PipPlayer.close(); }
    else if(k === "ArrowRight"){ const v = $("pip-video"); if(v){ e.preventDefault(); v.currentTime = Math.min(v.duration||Infinity, v.currentTime+10); } }
    else if(k === "ArrowLeft") { const v = $("pip-video"); if(v){ e.preventDefault(); v.currentTime = Math.max(0, v.currentTime-10); } }
    else if(k === "n" || k === "N" || k === "ChannelUp")  { e.preventDefault(); PipPlayer.goNext(); }
    else if(k === "p" || k === "P" || k === "ChannelDown"){ e.preventDefault(); PipPlayer.goPrev(); }
  }, true);

  // ── Pré-chargement de l'index épisodes (1 Ko, non bloquant) ──
  getEpMap();  // charge episodes_map.json en avance (1 Ko seulement)

  // ── Chargement VOD + Séries + Live + index en parallèle ──
  const [vodJson, seriesJson, liveJson, epIndex] = await Promise.all([
    fetchJson("vod.json"),
    fetchJson("series.json"),
    fetchJson("live.json"),
    fetchJson("episodes_index.json")
  ]);

  if(vodJson){ S.vod = normalizeItems(extractArr(vodJson), "vod"); }
  else {
    const vodM3u = await fetchText("vod.m3u");
    if(vodM3u){ S.vod = parseM3U(vodM3u, "vod"); }
  }

  if(seriesJson){ S.series = normalizeItems(extractArr(seriesJson), "series"); }
  else {
    const seriesM3u = await fetchText("series.m3u");
    if(seriesM3u){ S.series = parseM3U(seriesM3u, "series"); }
  }

  if(liveJson){
    // Les items live ont déjà type:"live" dans le JSON — normalisation légère
    const liveItems = extractArr(liveJson);
    S._liveRegionIdx = null; // reset index quand les données live changent
    S.live = liveItems.map((x, i) => ({  // normalisation
      id           : x.id || x.stream_id || String(i),
      stream_id    : x.stream_id || x.id || String(i),
      title        : x.title || x.name || "Sans titre",
      category_id  : x.category_id || "",
      category_name: x.category_name || "Autre",
      stream_icon  : x.stream_icon || x.image || "",
      stream_url   : x.stream_url || x.url || "",
      url          : x.stream_url || x.url || "",
      plot         : "",
      type         : "live",
      quality      : ""
    }));
    // Construire l'index régional immédiatement → peupler pipsily_available_regions
    // pour que les pills de région soient disponibles dès le premier affichage du live.
    if(S.live.length) S._liveRegionIdx = _buildLiveRegionIdx(S.live);
  }

  // ── Afficher date dernière mise à jour dans la barre fixe ──
  {
    const el = document.getElementById("lastUpdateDate");
    if(el){
      if(epIndex?.generated){
        const d   = new Date(epIndex.generated);
        const fmt = d.toLocaleDateString("fr-FR", { day:"2-digit", month:"short", year:"numeric" });
        const nb  = epIndex.total ? ` · ${epIndex.total.toLocaleString("fr-FR")} séries` : "";
        el.textContent = `Mise à jour le ${fmt}${nb}`;
      } else {
        el.textContent = "Catalogue à jour";
      }
    }
  }

  // ── Restaurer la section si on revient du lecteur ──────────────────
  {
    const _ctx = (() => {
      try { return JSON.parse(sessionStorage.getItem("iptv_nav_ctx") || "null"); } catch { return null; }
    })();
    if(_ctx?.type && ["vod","series","live"].includes(_ctx.type)){
      S.type    = _ctx.type;
      S.cat     = _ctx.cat    || "";
      S.search  = _ctx.search || "";
      if(S.search) $("searchInput").value = S.search;
      document.querySelectorAll(".nav-btn[data-type]").forEach(b => {
        b.classList.toggle("active", b.dataset.type === S.type);
      });
      const ph = { vod:"Rechercher un film…", series:"Rechercher une série…", live:"Rechercher une chaîne…" };
      $("searchInput").placeholder = ph[S.type] || "Rechercher…";
      sessionStorage.removeItem("iptv_nav_ctx");
    }
  }

  renderNouveautes();
  render();

  // ── TV : focus initial sur le bouton actif (Films) après 1er render ──
  if(document.documentElement.classList.contains("is-tv")){
    setTimeout(() => {
      const btn = document.querySelector(".nav-btn.active") || document.querySelector(".nav-btn");
      btn?.focus();
    }, 200);
  }

  // ── Écoute des mises à jour Service Worker ──
  if("serviceWorker" in navigator){
    navigator.serviceWorker.addEventListener("message", e => {
      if(e.data?.type === "UPDATE_AVAILABLE") showUpdateBanner();
    });
    // Cas APK : SW déjà en "waiting" depuis une session précédente
    // → updatefound ne se re-déclenche pas, il faut le détecter manuellement
    navigator.serviceWorker.ready.then(reg => {
      if(reg.waiting) showUpdateBanner();
    }).catch(() => {});
  }

  // ── Bannière installation APK pour Android (navigateur, hors APK) ──
  checkApkInstallBanner();

  // ── Vérification auto-update APK (non bloquant, inside APK only) ──
  checkApkUpdate();
}

function showUpdateBanner(){
  if($("updateBanner")) return;
  const isTV = /TV|GoogleTV|SmartTV|AndroidTV/i.test(navigator.userAgent) ||
               (/Android/i.test(navigator.userAgent) && !navigator.userAgent.includes("Mobile"));
  const banner = document.createElement("div");
  banner.id = "updateBanner";
  banner.innerHTML = `
    <span>🔄 Mise à jour disponible !</span>
    <button id="updateNowBtn" type="button" tabindex="0"
      style="background:linear-gradient(135deg,#7B5FE8,#38A8E8);color:#fff;border:none;
             border-radius:10px;padding:10px 20px;font-weight:700;font-size:14px;cursor:pointer">
      Mettre à jour
    </button>
    <button id="updateDismissBtn" type="button" tabindex="0" aria-label="Fermer"
      style="background:rgba(255,255,255,.12);color:#fff;border:none;border-radius:10px;
             padding:10px 14px;font-size:14px;cursor:pointer">✕</button>`;
  // Sur TV : bannière en HAUT pour être accessible par D-pad (pas en bas hors écran)
  banner.style.cssText = isTV
    ? `position:fixed;top:0;left:0;right:0;z-index:9999;display:flex;align-items:center;
       justify-content:center;gap:16px;padding:14px 20px;color:#fff;font-size:14px;font-weight:600;
       background:linear-gradient(135deg,#1a2d50,#0f1e3a);border-bottom:2px solid rgba(255,159,44,.5);
       box-shadow:0 4px 24px rgba(0,0,0,.6);`
    : `position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:9999;
       display:flex;align-items:center;gap:12px;padding:14px 18px;color:#fff;font-size:14px;font-weight:600;
       background:linear-gradient(135deg,#1a2d50,#0f1e3a);border:1px solid rgba(255,159,44,.4);
       border-radius:16px;box-shadow:0 8px 32px rgba(0,0,0,.5);white-space:nowrap;`;
  document.body.appendChild(banner);
  $("updateNowBtn").addEventListener("click", () => {
    navigator.serviceWorker?.ready.then(reg => {
      reg.waiting?.postMessage({ type: "SKIP_WAITING" });
      window.location.reload();
    }).catch(() => window.location.reload());
  });
  $("updateDismissBtn").addEventListener("click", () => banner.remove());
  // Auto-focus sur TV pour que le D-pad puisse sélectionner tout de suite
  if(isTV) setTimeout(() => $("updateNowBtn")?.focus(), 100);
}

// ─────────────────────────────────────────────────────────────────
//  APK AUTO-UPDATE — vérifie version.json et propose le téléchargement
// ─────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────
//  BANNIÈRE INSTALLATION APK — pour les visiteurs Android (hors APK)
// ─────────────────────────────────────────────────────────────────
async function checkApkInstallBanner(){
  // Seulement si : Android + pas encore dans l'APK
  const isAndroid   = /Android/i.test(navigator.userAgent);
  const isNativeApk = typeof window.AndroidBridge !== "undefined";
  if(!isAndroid || isNativeApk) return;

  const vinfo     = await fetchJson("version.json").catch(() => null);
  const remoteVer = Number(vinfo?.apk_version || 0);
  const _rawUrl   = vinfo?.apk_url || "";
  const url       = /^https:\/\/github\.com\//.test(_rawUrl) ? _rawUrl : "https://github.com/morpheus45/VOD/releases/latest";

  // Si une nouvelle version est disponible → ignorer le timer de dismiss
  const dismissedUntil = Number(localStorage.getItem("pf_apk_install_dismiss") || 0);
  const dismissedVer   = Number(localStorage.getItem("pf_apk_install_dismiss_ver") || 0);
  const newVersionOut  = remoteVer > 0 && remoteVer !== dismissedVer;
  if(!newVersionOut && Date.now() < dismissedUntil) return;

  if($("apkInstallBanner")) return;

  // ── Modal plein écran au 1er passage, sinon bandeau ──
  const isFirstVisit = !localStorage.getItem("pf_apk_install_dismiss");
  const banner = document.createElement("div");
  banner.id = "apkInstallBanner";

  if(isFirstVisit || newVersionOut){
    // Modal centré — impossible à rater
    banner.style.cssText = `
      position:fixed;inset:0;z-index:9999;
      display:flex;flex-direction:column;align-items:center;justify-content:center;
      background:rgba(5,8,15,.92);backdrop-filter:blur(8px);padding:24px;`;
    banner.innerHTML = `
      <div style="background:linear-gradient(135deg,#0d1a31,#1a1060);border:1px solid rgba(107,63,224,.5);
                  border-radius:20px;padding:28px 24px;max-width:360px;width:100%;text-align:center;
                  box-shadow:0 24px 60px rgba(0,0,0,.8)">
        <img src="./logo.svg" alt="PIPSILY" style="height:48px;margin-bottom:16px">
        <div style="font-size:20px;font-weight:800;color:#eef4ff;margin-bottom:8px">
          ${newVersionOut ? `🆕 PIPSILY v${remoteVer} disponible !` : '📱 Installez l\'appli !'}
        </div>
        <div style="font-size:13px;color:#a89be0;margin-bottom:20px;line-height:1.5">
          ${newVersionOut
            ? (vinfo?.changes || 'Améliorations & corrections de bugs')
            : 'Meilleure expérience · Lecture fluide · Pas de mixed content'}
        </div>
        <a href="${url}" target="_blank" rel="noopener"
          style="display:block;width:100%;box-sizing:border-box;padding:14px;border-radius:12px;
                 background:linear-gradient(135deg,#7B5FE8,#38A8E8);color:#fff;
                 font-size:15px;font-weight:800;text-decoration:none;margin-bottom:10px">
          📥 Télécharger l'APK
        </a>
        <button id="apkInstallDismiss"
          style="width:100%;padding:11px;border-radius:12px;border:1px solid rgba(255,255,255,.15);
                 background:transparent;color:#7a9cc0;font-size:13px;cursor:pointer">
          Plus tard (rappel demain)
        </button>
      </div>`;
  } else {
    // Bandeau compact (visites suivantes)
    banner.style.cssText = `
      position:fixed;top:0;left:0;right:0;z-index:9998;
      display:flex;align-items:center;gap:12px;padding:10px 14px;
      background:linear-gradient(135deg,#1a1060,#0e0a30);
      border-bottom:2px solid rgba(107,63,224,.5);
      color:#fff;box-shadow:0 4px 16px rgba(0,0,0,.6)`;
    banner.innerHTML = `
      <img src="./logo.svg" alt="" style="height:28px">
      <div style="flex:1;font-size:13px;font-weight:700;color:#eef4ff">
        📥 Installer l'appli PIPSILY
        <span style="font-size:11px;font-weight:400;color:#a89be0;margin-left:6px">Meilleure lecture</span>
      </div>
      <a href="${url}" target="_blank" rel="noopener"
        style="padding:8px 14px;border-radius:9px;background:linear-gradient(135deg,#7B5FE8,#38A8E8);
               color:#fff;font-size:12px;font-weight:700;text-decoration:none;white-space:nowrap">
        Installer
      </a>
      <button id="apkInstallDismiss" aria-label="Fermer"
        style="background:rgba(255,255,255,.1);border:none;color:#fff;border-radius:7px;
               padding:7px 9px;font-size:13px;cursor:pointer">✕</button>`;
    document.body.style.paddingTop = "54px";
  }

  document.body.appendChild(banner);

  banner.querySelector("#apkInstallDismiss").onclick = () => {
    banner.remove();
    document.body.style.paddingTop = "";
    // Rappel dans 1 jour + mémoriser la version affichée
    localStorage.setItem("pf_apk_install_dismiss",     String(Date.now() + 86400000));
    localStorage.setItem("pf_apk_install_dismiss_ver", String(remoteVer));
  };
}

async function checkApkUpdate(){
  // Hors APK natif → rien à faire
  if(typeof window.AndroidBridge === "undefined") return;

  try {
    const vinfo = await fetchJson("version.json");
    if(!vinfo || !vinfo.apk_version || !vinfo.apk_url) return;
    const remoteVer = parseInt(vinfo.apk_version, 10);
    if(!remoteVer) return;

    // ── Lire la version APK installée ──────────────────────────────
    // On appelle directement (pas de typeof — sur certains WebView Android,
    // les méthodes Java ne sont pas de type "function" mais restent appelables).
    let localVer = 0;
    try {
      const raw = window.AndroidBridge.getApkVersion();
      localVer  = raw ? parseInt(String(raw), 10) : 0;
    } catch {}

    // Mémoriser la version connue pour les prochains lancements
    if(localVer > 0){
      localStorage.setItem("pf_local_apk_ver", String(localVer));
    } else {
      // Fallback : version mémorisée lors d'un lancement précédent
      localVer = parseInt(localStorage.getItem("pf_local_apk_ver") || "0", 10);
    }

    // Version toujours inconnue → fail-safe, pas de bannière
    if(!localVer) return;

    // Déjà à jour
    if(remoteVer <= localVer) return;

    // Migration : les anciennes clés sv4/su4 étaient aussi posées au clic
    // "Mettre à jour" (7 jours) → une installation ÉCHOUÉE bloquait la bannière.
    localStorage.removeItem("pf_apk_sv4");
    localStorage.removeItem("pf_apk_su4");
    // Suppression : "Plus tard" = 7 jours ; "Mettre à jour" = 10 min seulement
    const suppressVer   = parseInt(localStorage.getItem("pf_apk_sv5") || "0", 10);
    const suppressUntil = parseInt(localStorage.getItem("pf_apk_su5") || "0", 10);
    if(suppressVer >= remoteVer && Date.now() < suppressUntil) return;

    showApkUpdateBanner(vinfo, remoteVer);
  } catch {}
}

function showApkUpdateBanner(vinfo, remoteVer){
  if($("apkUpdateBanner")) return;

  // Détection TV (user-agent ou flag injecté par TvActivity)
  const isTV = window.PIPSILY_NATIVE === "android_tv" ||
               /AndroidTV|GoogleTV|SmartTV/i.test(navigator.userAgent) ||
               (/Android/i.test(navigator.userAgent) && !/Mobile/i.test(navigator.userAgent));

  const banner = document.createElement("div");
  banner.id = "apkUpdateBanner";

  const _dismissApkBanner = () => {
    banner.remove();
    // Supprimer 7 jours à chaque "Plus tard" ou Back
    localStorage.setItem("pf_apk_sv5", String(remoteVer));
    localStorage.setItem("pf_apk_su5", String(Date.now() + 7 * 86400000));
  };

  banner.innerHTML =
    '<div class="apk-tv-modal">' +
      '<div class="apk-tv-icon">📦</div>' +
      '<h2 class="apk-tv-title">PIPSILY v' + remoteVer + ' disponible</h2>' +
      '<p class="apk-tv-changes">' + (vinfo.changes || "Améliorations & corrections") + '</p>' +
      '<div class="apk-tv-btns">' +
        '<button id="apkDownloadBtn" type="button" class="apk-tv-btn apk-tv-btn--install" tabindex="0">' +
          '⬇ Mettre à jour' +
        '</button>' +
        '<button id="apkLaterBtn" type="button" class="apk-tv-btn" tabindex="0" ' +
          'style="margin-top:10px;background:rgba(255,255,255,.08);font-size:13px;padding:10px 20px">' +
          'Plus tard (7 jours)' +
        '</button>' +
      '</div>' +
      (isTV ? '<p class="apk-tv-hint">OK = installer · Retour = plus tard</p>' : '') +
    '</div>';

  banner.style.cssText =
    "position:fixed;inset:0;z-index:99999;" +
    "background:rgba(0,0,0,.96);" +
    "display:flex;align-items:center;justify-content:center;" +
    "pointer-events:all;";

  banner.addEventListener("keydown", e => {
    if(["Escape","GoBack","Back","BrowserBack"].includes(e.key)){
      e.preventDefault(); e.stopPropagation();
      _dismissApkBanner();
    } else if(e.key !== "Enter" && e.key !== " "){
      e.preventDefault(); e.stopPropagation();
    }
  }, true);

  document.body.appendChild(banner);

  requestAnimationFrame(() => {
    requestAnimationFrame(() => $("apkDownloadBtn")?.focus());
  });

  // ── Plus tard ──
  $("apkLaterBtn").onclick = _dismissApkBanner;

  // ── Téléchargement ──
  $("apkDownloadBtn").onclick = () => {
    const url = vinfo.apk_url;
    const btn = $("apkDownloadBtn");
    if(btn){ btn.textContent = "📥 Téléchargement en cours…"; btn.disabled = true; }

    // Suppression COURTE (10 min) le temps d'installer — si l'installation
    // échoue, la bannière est re-proposée au prochain lancement
    localStorage.setItem("pf_apk_sv5", String(remoteVer));
    localStorage.setItem("pf_apk_su5", String(Date.now() + 10 * 60000));

    if(typeof window.AndroidBridge?.downloadAndInstall === "function"){
      window.AndroidBridge.downloadAndInstall(url);
    } else if(typeof window.AndroidBridge?.openDownloadUrl === "function"){
      window.AndroidBridge.openDownloadUrl(url);
    } else {
      window.open(url, "_blank");
    }
  };
}

window.addEventListener("load", boot);
