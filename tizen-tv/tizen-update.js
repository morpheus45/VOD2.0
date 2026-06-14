/**
 * tizen-update.js — PIPSILY TV auto-update engine
 * Vérifie version.json, télécharge le nouveau .wgt et l'installe via tizen.package.install()
 * Exposé via window.initTizenUpdate()
 */
(function(){
  "use strict";

  // ─── Constants ───────────────────────────────────────────────────────────
  const VERSION_URL    = "https://morpheus45.github.io/VOD/version.json";
  const FETCH_TIMEOUT  = 10000;
  const SUPPRESS_KEY   = "pipsily_tizen_suppress_until";
  const DL_DIR         = "documents/downloads";

  // ─── Helpers ─────────────────────────────────────────────────────────────

  function getCurrentVersion(){
    try {
      const v = tizen.application.getCurrentApplication().appInfo.version; // "1.0.0"
      const p = v.split(".").map(Number);
      return (p[0] || 0) * 100 + (p[1] || 0);
    } catch { return 0; }
  }

  function isSuppressed(){
    return Date.now() < Number(localStorage.getItem(SUPPRESS_KEY) || 0);
  }

  function suppress24h(){
    localStorage.setItem(SUPPRESS_KEY, String(Date.now() + 86400000));
  }

  function fetchJSON(url){
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const timer = setTimeout(() => { xhr.abort(); reject(new Error("timeout")); }, FETCH_TIMEOUT);
      xhr.onload  = () => { clearTimeout(timer); try { resolve(JSON.parse(xhr.responseText)); } catch(e){ reject(e); } };
      xhr.onerror = () => { clearTimeout(timer); reject(new Error("network")); };
      xhr.open("GET", url + "?_=" + Date.now());
      xhr.send();
    });
  }

  function esc(s){ return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

  // ─── Styles ──────────────────────────────────────────────────────────────

  function injectStyles(){
    if(document.getElementById("tizen-update-css")) return;
    const s = document.createElement("style");
    s.id = "tizen-update-css";
    s.textContent = `
      #tizen-update-overlay {
        position:fixed;inset:0;z-index:99999;
        display:flex;align-items:center;justify-content:center;
        background:rgba(5,8,15,.93);backdrop-filter:blur(10px);
        font-family:'Segoe UI',system-ui,sans-serif;
      }
      #tizen-update-card {
        background:linear-gradient(135deg,#0d1a31,#1a1060);
        border:1px solid rgba(107,63,224,.5);border-radius:24px;
        padding:40px 36px;max-width:520px;width:90%;text-align:center;
        box-shadow:0 32px 80px rgba(0,0,0,.8);
      }
      #tizen-update-card h2 { font-size:22px;font-weight:800;color:#eef4ff;margin:0 0 8px; }
      #tizen-update-card .tv-version { font-size:32px;font-weight:900;color:#7B5FE8;margin:8px 0 16px; }
      #tizen-update-card .tv-changes {
        font-size:14px;color:#a89be0;line-height:1.6;margin-bottom:28px;
        background:rgba(255,255,255,.04);border-radius:12px;padding:12px 16px;text-align:left;
      }
      #tizen-update-progbar {
        height:6px;border-radius:3px;background:rgba(255,255,255,.1);margin-bottom:16px;overflow:hidden;
        display:none;
      }
      #tizen-update-progbar .fill {
        height:100%;border-radius:3px;width:0%;transition:width .3s;
        background:linear-gradient(90deg,#6B3FE0,#38A8E8);
      }
      #tizen-update-status { font-size:13px;color:#7a9cc0;margin-bottom:20px;min-height:20px; }
      .tv-btn {
        display:block;width:100%;box-sizing:border-box;padding:16px;border-radius:14px;
        font-size:16px;font-weight:800;cursor:pointer;margin-bottom:10px;border:none;
        transition:transform .1s,box-shadow .1s;outline:none;
      }
      .tv-btn:focus, .tv-btn.tv-focused {
        box-shadow:0 0 0 4px rgba(107,63,224,.7);transform:scale(1.03);
      }
      .tv-btn--primary { background:linear-gradient(135deg,#7B5FE8,#38A8E8);color:#fff; }
      .tv-btn--secondary {
        background:rgba(255,255,255,.07);color:#7a9cc0;
        border:1px solid rgba(255,255,255,.12);
      }
      .tv-btn:disabled { opacity:.4;pointer-events:none; }
    `;
    document.head.appendChild(s);
  }

  // ─── Overlay DOM ─────────────────────────────────────────────────────────

  function buildOverlay(vinfo){
    injectStyles();
    const el = document.createElement("div");
    el.id = "tizen-update-overlay";
    el.innerHTML = `
      <div id="tizen-update-card">
        <h2>Mise à jour disponible</h2>
        <div class="tv-version">PIPSILY TV v${esc(String(vinfo.tizen_version))}</div>
        <div class="tv-changes">${esc(vinfo.tizen_changes || vinfo.changes || "Améliorations et corrections de bugs.")}</div>
        <div id="tizen-update-progbar"><div class="fill" id="tizen-update-fill"></div></div>
        <div id="tizen-update-status"></div>
        <button class="tv-btn tv-btn--primary" id="tv-update-now">📥 Mettre à jour maintenant</button>
        <button class="tv-btn tv-btn--secondary" id="tv-update-later">Plus tard (rappel demain)</button>
      </div>`;
    document.body.appendChild(el);
    return el;
  }

  // ─── Remote navigation ───────────────────────────────────────────────────

  function setupRemoteNav(overlay){
    let btns = [];
    let idx  = 0;

    function refresh(){
      btns = [...overlay.querySelectorAll(".tv-btn:not(:disabled)")];
      if(btns.length) { btns.forEach(b => b.classList.remove("tv-focused")); btns[idx = 0].classList.add("tv-focused"); btns[0].focus(); }
    }

    overlay.addEventListener("keydown", e => {
      if(!btns.length) return;
      if(e.keyCode === 38 || e.keyCode === 37){ // UP / LEFT
        btns[idx].classList.remove("tv-focused");
        idx = (idx - 1 + btns.length) % btns.length;
        btns[idx].classList.add("tv-focused"); btns[idx].focus(); e.preventDefault();
      } else if(e.keyCode === 40 || e.keyCode === 39){ // DOWN / RIGHT
        btns[idx].classList.remove("tv-focused");
        idx = (idx + 1) % btns.length;
        btns[idx].classList.add("tv-focused"); btns[idx].focus(); e.preventDefault();
      } else if(e.keyCode === 13){ // OK
        btns[idx]?.click(); e.preventDefault();
      } else if(e.keyCode === 10009 || e.keyCode === 27){ // BACK / ESC
        document.getElementById("tv-update-later")?.click(); e.preventDefault();
      }
    });

    refresh();
    return refresh;
  }

  // ─── Download ────────────────────────────────────────────────────────────

  function downloadWgt(url, onProgress){
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.responseType = "blob";
      xhr.onprogress = e => { if(e.lengthComputable) onProgress(e.loaded / e.total); };
      xhr.onload  = () => xhr.status >= 200 && xhr.status < 300 ? resolve(xhr.response) : reject(new Error("HTTP " + xhr.status));
      xhr.onerror = () => reject(new Error("Erreur réseau"));
      xhr.open("GET", url);
      xhr.send();
    });
  }

  function writeWgtToFilesystem(blob){
    return new Promise((resolve, reject) => {
      tizen.filesystem.resolve(DL_DIR, dir => {
        const fname = "PIPSILY-TV.wgt";
        try { dir.deleteFile(dir.toURI() + "/" + fname, ()=>{}, ()=>{}); } catch{}
        const file = dir.createFile(fname);
        const stream = file.openStream("w", () => {
          const reader = new FileReader();
          reader.onload = ev => {
            const arr = Array.from(new Uint8Array(ev.target.result));
            stream.writeBytes(arr);
            stream.close();
            resolve(file.toURI());
          };
          reader.onerror = reject;
          reader.readAsArrayBuffer(blob);
        }, reject);
      }, e => {
        // Dossier inexistant → créer dans documents
        tizen.filesystem.resolve("documents", docs => {
          docs.createDirectory("downloads");
          writeWgtToFilesystem(blob).then(resolve).catch(reject);
        }, reject);
      }, "rw");
    });
  }

  // ─── Install ─────────────────────────────────────────────────────────────

  function installWgt(fileURI, setStatus, onSuccess, onError){
    if(typeof tizen.package?.install !== "function"){
      // Fallback : tizen.package.install non disponible (certains profils)
      setStatus("⚠ Installation automatique non disponible sur ce TV.<br>Installez <a style='color:#38A8E8'>PIPSILY-TV.wgt</a> via USB ou Tizen Studio.");
      onError(new Error("packagemanager.install indisponible"));
      return;
    }
    tizen.package.install(fileURI, {
      onprogress: (id, pct) => setStatus(`Installation… ${pct}%`),
      oncomplete: () => {
        setStatus("✅ Installation réussie ! Relancement dans 2 s…");
        setTimeout(() => {
          try { tizen.application.getCurrentApplication().exit(); }
          catch { window.location.reload(); }
        }, 2000);
        onSuccess();
      }
    }, e => onError(e));
  }

  // ─── Main flow ───────────────────────────────────────────────────────────

  window.initTizenUpdate = async function(){
    if(typeof tizen === "undefined") return; // pas dans Tizen → silent
    if(isSuppressed()) return;

    let vinfo;
    try { vinfo = await fetchJSON(VERSION_URL); } catch { return; } // pas de réseau → silent

    const remoteV  = Number(vinfo.tizen_version || 0);
    const currentV = getCurrentVersion();
    if(!remoteV || !vinfo.tizen_url || remoteV * 100 <= currentV) return; // pas de mise à jour

    const overlay    = buildOverlay(vinfo);
    const refreshNav = setupRemoteNav(overlay);

    const progbar    = document.getElementById("tizen-update-progbar");
    const fill       = document.getElementById("tizen-update-fill");
    const status     = document.getElementById("tizen-update-status");
    const btnNow     = document.getElementById("tv-update-now");
    const btnLater   = document.getElementById("tv-update-later");

    function setStatus(html){ status.innerHTML = html; }

    btnLater.addEventListener("click", () => {
      suppress24h();
      overlay.remove();
    });

    btnNow.addEventListener("click", async () => {
      btnNow.disabled = true;
      btnLater.disabled = true;
      refreshNav();
      progbar.style.display = "block";
      setStatus("Téléchargement en cours…");

      let fileURI;
      try {
        const blob = await downloadWgt(vinfo.tizen_url, pct => {
          fill.style.width = Math.round(pct * 100) + "%";
          setStatus(`Téléchargement… ${Math.round(pct * 100)}%`);
        });
        fill.style.width = "100%";
        setStatus("Préparation de l'installation…");
        fileURI = await writeWgtToFilesystem(blob);
      } catch(e){
        setStatus(`❌ Erreur téléchargement : ${esc(e.message)}<br><button class='tv-btn tv-btn--secondary' id='tv-retry'>Réessayer</button>`);
        btnNow.disabled = false; btnLater.disabled = false; refreshNav();
        document.getElementById("tv-retry")?.addEventListener("click", () => btnNow.click());
        return;
      }

      setStatus("Installation en cours…");
      installWgt(fileURI, setStatus,
        () => { btnNow.disabled = true; btnLater.disabled = true; },
        e  => {
          setStatus(`❌ Erreur installation : ${esc(e.message)}<br><button class='tv-btn tv-btn--secondary' id='tv-retry'>Réessayer</button>`);
          btnNow.disabled = false; btnLater.disabled = false; refreshNav();
          document.getElementById("tv-retry")?.addEventListener("click", () => btnNow.click());
        }
      );
    });
  };

})();
