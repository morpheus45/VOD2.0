/**
 * tizen-tv.js — PIPSILY TV — Adaptations Samsung Smart TV
 * Télécommande D-pad, touches média, boutons couleur, exit dialog, anti-screensaver
 * Exposé via window.initTizenTV()
 */
(function () {
  "use strict";

  // ─── Keycodes Samsung TV ────────────────────────────────────────────────────

  const KC = {
    // Navigation
    UP:    38, DOWN:  40, LEFT:  37, RIGHT: 39, ENTER: 13,
    BACK:  10009, MENU: 10135,
    // Média
    PLAY:        415, PAUSE:       19,  PLAY_PAUSE: 10252,
    STOP:        413, FAST_FORWARD: 417, REWIND:     412,
    // Boutons couleur
    RED:   403, GREEN: 404, YELLOW: 405, BLUE: 406,
    // Chiffres
    NUM0: 48, NUM1: 49, NUM2: 50, NUM3: 51, NUM4: 52,
    NUM5: 53, NUM6: 54, NUM7: 55, NUM8: 56, NUM9: 57,
  };

  // Touches à enregistrer explicitement pour Tizen (sinon pas reçues)
  const KEYS_TO_REGISTER = [
    "MediaPlay", "MediaPause", "MediaPlayPause", "MediaStop",
    "MediaFastForward", "MediaRewind",
    "ColorF0Red", "ColorF1Green", "ColorF2Yellow", "ColorF3Blue",
    "0","1","2","3","4","5","6","7","8","9",
  ];

  // ─── Helpers DOM ────────────────────────────────────────────────────────────

  function $(id){ return document.getElementById(id); }

  function _videoEl(){
    return $("pip-video") || document.querySelector("video");
  }

  function _playerOpen(){
    const el = $("pip-player");
    return el && !el.hasAttribute("hidden") && el.style.display !== "none";
  }

  function _panelOpen(){
    const el = $("seriesPanel");
    return el && !el.hasAttribute("hidden") && el.style.display !== "none";
  }

  // ─── Lecture / Seek ─────────────────────────────────────────────────────────

  function _togglePlayPause(){
    const v = _videoEl();
    if(!v) return;
    if(v.paused) v.play(); else v.pause();
  }

  function _seek(sec){
    const v = _videoEl();
    if(!v || !isFinite(v.duration)) return;
    v.currentTime = Math.max(0, Math.min(v.duration, v.currentTime + sec));
  }

  // ─── Boutons couleur ────────────────────────────────────────────────────────

  function _colorRed(){
    // Rouge → toggle favoris si player ouvert, sinon filtrer favoris
    if(_playerOpen()){
      const btn = $("pip-fav");
      if(btn) btn.click();
    } else {
      const favBtn = $("favFilterBtn");
      if(favBtn) favBtn.click();
    }
  }

  function _colorGreen(){
    // Vert → plein écran si player ouvert
    if(_playerOpen()){
      const btn = $("pip-fullscreen");
      if(btn) btn.click();
    }
  }

  function _colorYellow(){
    // Jaune → épisode suivant si disponible
    if(_playerOpen()){
      const btn = $("pip-next");
      if(btn && !btn.disabled) btn.click();
    }
  }

  function _colorBlue(){
    // Bleu → épisode précédent si disponible
    if(_playerOpen()){
      const btn = $("pip-prev");
      if(btn && !btn.disabled) btn.click();
    }
  }

  // ─── Exit dialog ────────────────────────────────────────────────────────────

  let _exitDialog = null;

  function _showExitDialog(){
    if(_exitDialog) return;

    const overlay = document.createElement("div");
    overlay.id = "tv-exit-dialog";
    overlay.style.cssText = [
      "position:fixed","inset:0","z-index:999999",
      "display:flex","align-items:center","justify-content:center",
      "background:rgba(5,8,15,.88)","backdrop-filter:blur(8px)",
      "font-family:system-ui,sans-serif",
    ].join(";");

    overlay.innerHTML = `
      <div style="background:linear-gradient(135deg,#0d1a31,#1a1060);
                  border:1px solid rgba(107,63,224,.5);border-radius:20px;
                  padding:36px 40px;text-align:center;
                  box-shadow:0 24px 64px rgba(0,0,0,.8);min-width:300px;">
        <div style="font-size:20px;font-weight:800;color:#eef4ff;margin-bottom:24px;">
          Quitter PIPSILY ?
        </div>
        <div style="display:flex;gap:14px;justify-content:center;">
          <button id="tv-exit-yes" style="padding:14px 28px;border-radius:12px;border:none;
            background:linear-gradient(135deg,#7B5FE8,#38A8E8);
            color:#fff;font-size:16px;font-weight:800;cursor:pointer;outline:none;">
            Quitter
          </button>
          <button id="tv-exit-no" style="padding:14px 28px;border-radius:12px;border:none;
            background:rgba(255,255,255,.08);color:#a89be0;
            border:1px solid rgba(255,255,255,.12);
            font-size:16px;font-weight:800;cursor:pointer;outline:none;">
            Annuler
          </button>
        </div>
      </div>`;

    document.body.appendChild(overlay);
    _exitDialog = overlay;

    const btnYes = $("tv-exit-yes");
    const btnNo  = $("tv-exit-no");
    let focused  = 0; // 0=Quitter, 1=Annuler
    const btns   = [btnYes, btnNo];

    function _focus(i){
      focused = i;
      btns.forEach((b, idx) => {
        b.style.boxShadow = idx === i
          ? "0 0 0 3px rgba(107,63,224,.8)"
          : "none";
        b.style.transform = idx === i ? "scale(1.05)" : "scale(1)";
      });
      btns[i].focus();
    }

    function _close(){
      overlay.remove();
      _exitDialog = null;
    }

    overlay.addEventListener("keydown", e => {
      if(e.keyCode === KC.LEFT || e.keyCode === KC.RIGHT){
        _focus(focused === 0 ? 1 : 0);
        e.preventDefault(); e.stopPropagation();
      } else if(e.keyCode === KC.ENTER){
        btns[focused].click();
        e.preventDefault(); e.stopPropagation();
      } else if(e.keyCode === KC.BACK || e.keyCode === 27){
        _close();
        e.preventDefault(); e.stopPropagation();
      }
    });

    btnYes.addEventListener("click", () => {
      try { tizen.application.getCurrentApplication().exit(); }
      catch { window.close(); }
    });

    btnNo.addEventListener("click", _close);

    _focus(0); // focus sur "Quitter" par défaut
  }

  // ─── Touche Retour ──────────────────────────────────────────────────────────

  function _handleBack(){
    // Priorité 1 — exit dialog ouvert → le fermer
    if(_exitDialog){ _exitDialog.querySelector("#tv-exit-no")?.click(); return; }

    // Priorité 2 — lecteur ouvert → fermer lecteur
    if(_playerOpen()){
      const btn = $("pip-back");
      if(btn){ btn.click(); return; }
    }

    // Priorité 3 — panel séries ouvert → fermer panel
    if(_panelOpen()){
      const closeBtn = document.querySelector(".series-panel-close, [data-close-panel]");
      if(closeBtn){ closeBtn.click(); return; }
      // fallback : masquer directement
      const panel = $("seriesPanel");
      if(panel){ panel.hidden = true; return; }
    }

    // Priorité 4 — page racine → proposer de quitter
    _showExitDialog();
  }

  // ─── Gestionnaire de touches (capture) ──────────────────────────────────────

  function _onKeydown(e){
    const kc = e.keyCode;

    switch(kc){
      // Navigation : laisser le comportement natif du focus
      case KC.UP: case KC.DOWN: case KC.LEFT: case KC.RIGHT: case KC.ENTER:
        break;

      case KC.BACK:
        _handleBack(); e.preventDefault(); break;

      case KC.PLAY: case KC.PLAY_PAUSE:
        _togglePlayPause(); e.preventDefault(); break;

      case KC.PAUSE:
        { const v = _videoEl(); if(v) v.pause(); e.preventDefault(); } break;

      case KC.STOP:
        { const v = _videoEl(); if(v){ v.pause(); v.currentTime = 0; } e.preventDefault(); } break;

      case KC.FAST_FORWARD:
        _seek(+10); e.preventDefault(); break;

      case KC.REWIND:
        _seek(-10); e.preventDefault(); break;

      case KC.RED:   _colorRed();    e.preventDefault(); break;
      case KC.GREEN: _colorGreen();  e.preventDefault(); break;
      case KC.YELLOW:_colorYellow(); e.preventDefault(); break;
      case KC.BLUE:  _colorBlue();   e.preventDefault(); break;
    }
  }

  // ─── Anti-screensaver ────────────────────────────────────────────────────────
  // Simule une activité toutes les 3 min pour éviter le screensaver Samsung

  let _antiSsTimer = null;

  function _startAntiScreensaver(){
    if(_antiSsTimer) return;
    _antiSsTimer = setInterval(() => {
      try {
        // Déclenche un événement synthétique (non visible) pour réinitialiser l'idle timer
        document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
      } catch {}
    }, 3 * 60 * 1000); // 3 minutes
  }

  // ─── Focus observer ──────────────────────────────────────────────────────────
  // Garantit qu'un élément focusable est toujours actif (sinon la télécommande ne fonctionne plus)

  let _focusObserver = null;

  function _installFocusObserver(){
    if(_focusObserver) return;

    function _ensureFocus(){
      if(document.activeElement && document.activeElement !== document.body) return;
      // Chercher un élément focusable visible
      const target = document.querySelector(
        ".nav-btn, .grid-card, .quality-pill, #categorySelect, [tabindex]:not([tabindex='-1'])"
      );
      if(target) target.focus({ preventScroll: true });
    }

    document.addEventListener("focusin", () => {}, true);

    // Observer les mutations du DOM (panels, overlays) pour re-focaliser si besoin
    _focusObserver = new MutationObserver(() => {
      requestAnimationFrame(_ensureFocus);
    });

    _focusObserver.observe(document.body, {
      childList: true,
      subtree:   true,
      attributes:true,
      attributeFilter: ["hidden", "style"],
    });

    // Focaliser immédiatement au démarrage
    setTimeout(_ensureFocus, 300);
  }

  // ─── Enregistrement des touches Tizen ────────────────────────────────────────

  function _registerKeys(){
    if(typeof tizen === "undefined" || !tizen.tvinputdevice) return;
    KEYS_TO_REGISTER.forEach(key => {
      try { tizen.tvinputdevice.registerKey(key); } catch {}
    });
  }

  // ─── Point d'entrée public ───────────────────────────────────────────────────

  window.initTizenTV = function(){
    // Enregistrer les touches hardware Samsung
    _registerKeys();

    // Écouter toutes les touches en phase de capture (avant les handlers locaux)
    document.addEventListener("keydown", _onKeydown, true);

    // Observer le focus pour éviter la perte de navigation
    _installFocusObserver();

    // Démarrer l'anti-screensaver
    _startAntiScreensaver();

    // Style global TV : cacher le curseur souris
    document.documentElement.style.cursor = "none";
    document.addEventListener("mousemove", () => {
      document.documentElement.style.cursor = "none";
    }, { passive: true });
  };

})();
