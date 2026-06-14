// ╔══════════════════════════════════════════════════════════════╗
// ║  PIPSILY — auth.js v1.0 — Supabase Auth + Abonnements       ║
// ║  NE PAS COMMITTER les clés Supabase dans un repo public      ║
// ╚══════════════════════════════════════════════════════════════╝
"use strict";

// ─────────────────────────────────────────────────────────────────
//  CONFIG SUPABASE — à remplir après création du projet
//  https://supabase.com → New project → Settings → API
// ─────────────────────────────────────────────────────────────────
const SUPABASE_URL  = "https://gwmuazostbbgroplnlql.supabase.co";
const SUPABASE_ANON = "sb_publishable_cNZ37Mjd57b_9nlyCvtkkA_wSIszOMR";

// E-mail du compte admin (accès illimité, panel admin visible)
const ADMIN_EMAIL   = "cedric.lago@gmail.com";

// ─────────────────────────────────────────────────────────────────
//  PAIEMENT WERO — modifiez ces valeurs avec VOTRE numéro Wero
//  (l'utilisateur verra ces infos sur la page "Mon compte")
// ─────────────────────────────────────────────────────────────────
const WERO_PHONE = atob("MDYyMjQ2MTYyNA=="); // encodé — ne jamais afficher en clair
const WERO_NAME  = "PIPSILY";

// ─────────────────────────────────────────────────────────────────
//  DÉTECTION CONFIG
// ─────────────────────────────────────────────────────────────────
const _configured = !SUPABASE_URL.includes("VOTRE_PROJET") && !SUPABASE_ANON.includes("VOTRE_ANON");

// ─────────────────────────────────────────────────────────────────
//  CLIENT SUPABASE (protégé contre CDN manquant ou config vide)
// ─────────────────────────────────────────────────────────────────
let _supa = null;
try {
  if(!window.supabase) throw new Error("Supabase CDN non chargé");
  _supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: "pipsily_auth" }
  });
} catch(e) {
  console.warn("[PIPSILY] Supabase non disponible :", e.message);
}

// ─────────────────────────────────────────────────────────────────
//  DEVICE FINGERPRINT
// ─────────────────────────────────────────────────────────────────
function getDeviceId(){
  let id = localStorage.getItem("pipsily_device_id");
  if(!id){
    id = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : "dev-" + Date.now() + "-" + Math.random().toString(36).slice(2);
    localStorage.setItem("pipsily_device_id", id);
  }
  return id;
}

function getDeviceName(){
  const ua = navigator.userAgent;
  if(/Android.*TV|SmartTV|Tizen|WebOS/i.test(ua)) return "Smart TV";
  if(/Android/i.test(ua)) return "Android";
  if(/iPad|iPhone|iPod/i.test(ua)) return "iOS";
  if(/Windows/i.test(ua)) return "PC Windows";
  if(/Mac/i.test(ua)) return "Mac";
  return "Appareil inconnu";
}

// ─────────────────────────────────────────────────────────────────
//  AUTHENTIFICATION
// ─────────────────────────────────────────────────────────────────
const _DEV_SESSION_KEY = "pipsily_dev_session"; // conservé pour le removeItem dans signOut (migration)

async function getSession(){
  if(!_supa || !_configured){ return null; }
  try {
    const { data: { session } } = await _supa.auth.getSession();
    return session;
  } catch { return null; }
}

async function signIn(email, password){
  if(!_configured || !_supa){
    return { error: { message: "⚙️ Service d'authentification indisponible. Vérifiez votre connexion et réessayez." } };
  }
  return _supa.auth.signInWithPassword({ email, password });
}

async function signUp(email, password){
  if(!_configured || !_supa){
    return { error: { message: "⚙️ Configuration en cours. Lancez SETUP.bat pour activer les inscriptions." } };
  }
  const redirectTo = new URL("login.html", location.href).href;
  return _supa.auth.signUp({ email, password, options: { emailRedirectTo: redirectTo } });
}

async function signOut(){
  localStorage.removeItem(_DEV_SESSION_KEY);
  localStorage.removeItem("pipsily_session_token");
  if(!_supa || !_configured){ window.location.href = "./login.html"; return; }
  const session = await getSession();
  if(session){
    try { await _supa.from("sessions").delete().eq("user_id", session.user.id); } catch {}
  }
  return _supa.auth.signOut();
}

// ─────────────────────────────────────────────────────────────────
//  PROFIL & ABONNEMENT
// ─────────────────────────────────────────────────────────────────
async function getProfile(userId){
  if(!_supa) return null;
  try {
    const { data, error } = await _supa.from("profiles").select("*").eq("id", userId).single();
    return error ? null : data;
  } catch { return null; }
}

async function checkSubscription(userId){
  // Mode dev : admin illimité
  if(!_configured || !_supa){
    const sess = await getSession();
    if(sess?.user?.email?.toLowerCase() === ADMIN_EMAIL.toLowerCase())
      return { ok: true, unlimited: true, plan: "admin", devices_allowed: 99,
               email: sess.user.email, id: sess.user.id };
    return { ok: false, plan: "pending" };
  }
  const prof = await getProfile(userId);
  if(!prof) return { ok: false, plan: null };
  if(prof.plan === "admin" || prof.plan === "unlimited")
    return { ok: true, unlimited: true, ...prof };
  const expires = prof.subscription_expires_at ? new Date(prof.subscription_expires_at) : null;
  const ok = !!(expires && expires > new Date());
  return { ok, unlimited: false, ...prof };
}

// ─────────────────────────────────────────────────────────────────
//  SESSION UNIQUE (1 connexion simultanée max)
// ─────────────────────────────────────────────────────────────────
//  GÉOLOCALISATION IP SILENCIEUSE (aucune permission requise)
// ─────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────
//  SESSIONS — une ligne par appareil, purge 24h
// ─────────────────────────────────────────────────────────────────

const SESSION_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24h sans heartbeat = session expirée
const ACTIVE_WINDOW_MS   = 10 * 60 * 1000;       // 10 min = "connecté maintenant"

// Limite de connexions simultanées par plan
const MAX_CONCURRENT = { admin: Infinity, unlimited: 4, default: 1 };
// Limite d'appareils enregistrés par plan
const MAX_DEVICES    = { admin: Infinity, unlimited: 3, default: 1 };

async function registerSession(userId){
  const token    = crypto.randomUUID?.() || ("tok" + Date.now());
  const deviceId = getDeviceId();
  localStorage.setItem("pipsily_session_token", token);
  if(!_supa) return { token, blocked: false };
  try {
    // Purge des sessions inactives (> 24h)
    const cutoff = new Date(Date.now() - SESSION_TIMEOUT_MS).toISOString();
    await _supa.from("sessions").delete().eq("user_id", userId).lt("last_seen", cutoff);

    // Plan de l'utilisateur
    const { data: prof } = await _supa.from("profiles").select("plan").eq("id", userId).maybeSingle();
    const plan = prof?.plan || "active";
    const maxConcurrent = plan === "admin" ? Infinity
      : plan === "unlimited" ? MAX_CONCURRENT.unlimited
      : MAX_CONCURRENT.default;

    // Vérifier les connexions simultanées (autres appareils actifs ces 10 dernières minutes)
    if(isFinite(maxConcurrent)){
      const activeCutoff = new Date(Date.now() - ACTIVE_WINDOW_MS).toISOString();
      const { count: activeCount } = await _supa.from("sessions")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .neq("device_id", deviceId)
        .gt("last_seen", activeCutoff);
      if((activeCount ?? 0) >= maxConcurrent){
        return { token: null, blocked: true, reason: "concurrent", maxConcurrent };
      }
    }

    // Upsert : une seule ligne par (user_id, device_id)
    const now = new Date().toISOString();
    const { data: existing } = await _supa.from("sessions").select("id")
      .eq("user_id", userId).eq("device_id", deviceId).maybeSingle();
    if(existing){
      await _supa.from("sessions").update({ token, last_seen: now }).eq("id", existing.id);
    } else {
      await _supa.from("sessions").insert({
        user_id: userId, device_id: deviceId, device_name: getDeviceName(),
        token, last_seen: now, created_at: now
      });
    }
  } catch(e){ console.warn("[PIPSILY] registerSession:", e.message); }
  return { token, blocked: false };
}

async function validateSession(userId){
  if(!_supa) return true;
  const localToken = localStorage.getItem("pipsily_session_token");
  if(!localToken) return false;
  try {
    const { data } = await _supa.from("sessions").select("id")
      .eq("user_id", userId).eq("token", localToken).maybeSingle();
    return !!data;
  } catch { return true; }
}

// ─────────────────────────────────────────────────────────────────
//  SURVEILLANCE SESSION — heartbeat 30s (mise à jour last_seen)
//  Purge silencieuse des sessions inactives — pas de déconnexion forcée
// ─────────────────────────────────────────────────────────────────
let _watchInterval = null;

async function _heartbeat(userId){
  if(!_supa) return;
  const localToken = localStorage.getItem("pipsily_session_token");
  if(!localToken) return; // token absent : ne rien faire, pas de déconnexion forcée
  try {
    // Mettre à jour last_seen de cette session
    const { data } = await _supa.from("sessions").select("id")
      .eq("user_id", userId).eq("token", localToken).maybeSingle();
    if(data){
      await _supa.from("sessions").update({ last_seen: new Date().toISOString() }).eq("id", data.id);
    }

    // Purge silencieuse des sessions inactives (autres appareils déconnectés)
    const cutoff = new Date(Date.now() - SESSION_TIMEOUT_MS).toISOString();
    await _supa.from("sessions").delete()
      .eq("user_id", userId).lt("last_seen", cutoff);
  } catch { /* erreur réseau : ne pas déconnecter */ }
}

async function startSessionWatcher(userId){
  if(!_supa || !userId) return;

  // Heartbeat toutes les 5 minutes — mise à jour last_seen
  _watchInterval = setInterval(() => _heartbeat(userId), 5 * 60_000);

  // Heartbeat immédiat quand l'app repasse au premier plan (TV en veille, onglet réactivé)
  document.addEventListener("visibilitychange", () => {
    if(document.visibilityState === "visible") _heartbeat(userId);
  });
}

// ─────────────────────────────────────────────────────────────────
//  GESTION DES APPAREILS
// ─────────────────────────────────────────────────────────────────
async function ensureDevice(userId){
  if(!_supa) return { newDevice: false, blocked: false };
  try {
    const deviceId   = getDeviceId();
    const deviceName = getDeviceName();

    const { data: existing } = await _supa
      .from("devices")
      .select("id")
      .eq("user_id", userId)
      .eq("device_id", deviceId)
      .maybeSingle();  // maybeSingle ne throw pas si 0 ligne (contrairement à single)

    if(existing){
      // Mise à jour last_seen
      await _supa.from("devices")
        .update({ last_seen: new Date().toISOString() })
        .eq("user_id", userId).eq("device_id", deviceId);
      return { newDevice: false, blocked: false };
    }

    // Nouvel appareil — vérifier la limite selon le plan
    const { data: prof } = await _supa
      .from("profiles").select("plan").eq("id", userId).maybeSingle();

    const plan = prof?.plan || "active";
    const maxDevices = plan === "admin" ? Infinity
      : plan === "unlimited" ? MAX_DEVICES.unlimited
      : MAX_DEVICES.default;

    if(isFinite(maxDevices)){
      const { count } = await _supa
        .from("devices").select("id", { count: "exact", head: true }).eq("user_id", userId);
      if((count ?? 0) >= maxDevices){
        return { newDevice: true, blocked: true, plan, current: count, maxDevices };
      }
    }

    await _supa.from("devices").insert({ user_id: userId, device_id: deviceId, device_name: deviceName, monthly_fee: 0 });
    return { newDevice: false, blocked: false };
  } catch(e){
    console.warn("[PIPSILY] ensureDevice:", e.message);
    return { newDevice: false, blocked: false }; // en cas d'erreur → laisser passer
  }
}

async function addExtraDevice(userId){
  if(!_supa) return;
  const deviceId   = getDeviceId();
  const deviceName = getDeviceName();
  const extra_cost = 1.50;
  try {
    const { data: prof } = await _supa
      .from("profiles").select("devices_allowed").eq("id", userId).single();
    const newAllowed = (prof?.devices_allowed ?? 1) + 1;
    await _supa.from("profiles").update({ devices_allowed: newAllowed }).eq("id", userId);
    await _supa.from("devices").insert({
      user_id: userId, device_id: deviceId, device_name: deviceName, monthly_fee: extra_cost
    });
    await _supa.from("payments").insert({
      user_id: userId, amount: extra_cost, type: "extra_device",
      notes: `Appareil supplémentaire : ${deviceName}`
    });
  } catch(e){ console.warn("[PIPSILY] addExtraDevice:", e.message); }
}

// ─────────────────────────────────────────────────────────────────
//  CODE PARENTAL
// ─────────────────────────────────────────────────────────────────
async function getParentalPin(userId){
  if(!_supa) return null;
  try {
    const { data } = await _supa.from("profiles").select("parental_pin").eq("id", userId).single();
    return data?.parental_pin || null;
  } catch { return null; }
}

async function setParentalPin(userId, pin){
  if(!_supa) return { error: { message: "Non configuré" } };
  return _supa.from("profiles").update({ parental_pin: pin }).eq("id", userId);
}

// Prompt PIN parental — retourne true si validé
function promptParentalPin(storedPin){
  return new Promise(resolve => {
    const overlay = document.createElement("div");
    overlay.id = "parentalOverlay";
    overlay.innerHTML = `
      <div style="position:fixed;inset:0;background:rgba(5,8,15,.95);z-index:9999;
        display:flex;align-items:center;justify-content:center;padding:20px">
        <div style="background:#0c1422;border:1px solid rgba(255,255,255,.1);border-radius:20px;
          padding:32px;max-width:320px;width:100%;text-align:center">
          <div style="font-size:40px;margin-bottom:12px">🔞</div>
          <h3 style="margin:0 0 8px;color:#eef4ff;font-size:18px">Contenu pour adultes</h3>
          <p style="color:#7a9cc0;font-size:13px;margin:0 0 20px;line-height:1.5">
            Entrez votre code parental pour accéder à ce contenu.
          </p>
          <input id="pinInput" type="password" maxlength="6" inputmode="numeric"
            placeholder="Code PIN"
            style="width:100%;padding:12px 16px;border-radius:12px;
            border:1px solid rgba(255,255,255,.15);background:rgba(255,255,255,.08);
            color:#fff;font-size:18px;text-align:center;letter-spacing:6px;margin-bottom:12px" />
          <div id="pinError" style="color:#a084f0;font-size:12px;margin-bottom:12px;display:none">
            Code incorrect — 3 tentatives max
          </div>
          <button id="pinOkBtn" style="width:100%;padding:13px;border-radius:12px;border:none;
            background:linear-gradient(135deg,#7B5FE8,#38A8E8);color:#fff;
            font-weight:700;font-size:15px;cursor:pointer;margin-bottom:8px">
            Confirmer
          </button>
          <button id="pinCancelBtn" style="width:100%;padding:11px;border-radius:12px;
            border:1px solid rgba(255,255,255,.15);background:transparent;
            color:#7a9cc0;font-size:13px;cursor:pointer">
            Annuler
          </button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    let attempts = 0;
    const inp = overlay.querySelector("#pinInput");
    const errEl = overlay.querySelector("#pinError");
    inp.focus();

    const validate = () => {
      if(inp.value === storedPin){
        overlay.remove(); resolve(true);
      } else {
        attempts++;
        errEl.style.display = "block";
        errEl.textContent = `Code incorrect (${attempts}/3)`;
        inp.value = "";
        if(attempts >= 3){ overlay.remove(); resolve(false); }
      }
    };

    overlay.querySelector("#pinOkBtn").onclick = validate;
    overlay.querySelector("#pinCancelBtn").onclick = () => { overlay.remove(); resolve(false); };
    inp.addEventListener("keydown", e => { if(e.key === "Enter") validate(); });
  });
}

// ─────────────────────────────────────────────────────────────────
//  AUTH GATE — appelé au démarrage de l'app (index.html)
//  Conçu pour être robuste même si les tables Supabase ne sont pas
//  encore créées (erreurs DB catchées, jamais de crash silencieux).
// ─────────────────────────────────────────────────────────────────

// Coupe-boucle : empêche un aller-retour infini login ↔ index/cosmos
// (ex : dépendance auth manquante sur une page). Au-delà de 4 rebonds,
// on stoppe et on affiche un message au lieu de reboucler.
function _gotoLogin(){
  try{
    const n = (parseInt(sessionStorage.getItem("pf_auth_bounce") || "0", 10) || 0) + 1;
    sessionStorage.setItem("pf_auth_bounce", String(n));
    if(n > 4){
      document.body.innerHTML =
        '<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;'+
        'text-align:center;font-family:sans-serif;color:#fff;background:#04060d;padding:24px">'+
        '<div><h2>Connexion impossible</h2>'+
        '<p style="color:#9ab;max-width:440px;margin:12px auto;line-height:1.6">La session ne se '+
        'charge pas correctement sur cette page. Vérifiez votre connexion internet, puis reconnectez-vous.</p>'+
        '<button onclick="try{sessionStorage.removeItem(\'pf_auth_bounce\')}catch(e){};location.href=\'./login.html\'" '+
        'style="margin-top:16px;padding:12px 28px;border:none;border-radius:999px;'+
        'background:linear-gradient(135deg,#7B5FE8,#38A8E8);color:#fff;font-weight:700;cursor:pointer">'+
        'Se reconnecter</button></div></div>';
      return;
    }
  }catch(e){}
  window.location.href = "./login.html";
}

async function authGate(){
  // ── Supabase non configuré → rediriger vers login ──
  if(!_configured || !_supa){
    console.warn("[PIPSILY] Supabase non configuré — redirection login");
    _gotoLogin();
    return null;
  }

  // ── Lecture session locale (localStorage, pas d'appel réseau) ──
  let session = null;
  try { session = await getSession(); }
  catch(e){ console.warn("[PIPSILY] getSession:", e.message); }

  if(!session){
    _gotoLogin();
    return null;
  }

  // Session valide → réinitialiser le compteur de rebonds
  try{ sessionStorage.removeItem("pf_auth_bounce"); }catch(e){}

  // ── Abonnement (erreur table = on laisse passer plutôt que de bloquer) ──
  let sub = { ok: false, plan: null };
  try {
    sub = await checkSubscription(session.user.id);
  } catch(e) {
    console.warn("[PIPSILY] checkSubscription:", e.message);
    // Tables probablement absentes → accès gracieux selon l'e-mail
    sub = session.user.email === ADMIN_EMAIL
      ? { ok: true, plan: "admin",  unlimited: true  }
      : { ok: true, plan: "active", unlimited: false };
  }

  // ── Admin → accès illimité sans restriction ──
  if(session.user.email === ADMIN_EMAIL || sub.plan === "admin"){
    // Créer/mettre à jour le profil admin (fire-and-forget — ne bloque pas)
    if(_supa && (!sub.plan || sub.plan === "free")){
      _supa.from("profiles")
        .upsert({ id: session.user.id, email: session.user.email,
                  plan: "admin", devices_allowed: 999 })
        .catch(e => console.warn("[PIPSILY] upsert admin profile:", e.message));
    }
    registerSession(session.user.id).catch(() => {});
    return { session, sub: { ...sub, ok: true, unlimited: true, plan: "admin" } };
  }

  // ── Abonnement inactif → paywall ──
  if(!sub.ok){
    _showPaywall(sub);
    return null;
  }

  // ── Vérifier connexions simultanées (unlimited=4 max, autres=1 max) ──
  const sesResult = await registerSession(session.user.id)
    .catch(() => ({ token: null, blocked: false }));
  if(sesResult.blocked){
    _showConcurrentLimit(sesResult.maxConcurrent);
    return null;
  }

  // ── Vérifier limite d'appareils (unlimited=3 max, autres=1 max) ──
  const devResult = await ensureDevice(session.user.id)
    .catch(() => ({ newDevice: false, blocked: false }));
  if(devResult.blocked){
    _showDeviceLimit(sub.plan);
    return null;
  }

  return { session, sub };
}

// ─────────────────────────────────────────────────────────────────
//  ÉCRANS BLOQUANTS (inline — pas de fichier séparé)
// ─────────────────────────────────────────────────────────────────
function _showPaywall(sub){
  const expired = !!(sub.subscription_expires_at);
  document.body.innerHTML = `
    <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;
      background:radial-gradient(ellipse at 50% 0%,rgba(123,95,232,.15),transparent 60%),#05080f;
      color:#eef4ff;font-family:'Segoe UI',system-ui,sans-serif;padding:20px;box-sizing:border-box">
      <div style="max-width:380px;width:100%;text-align:center">
        <div style="font-size:56px;margin-bottom:16px">${expired ? "⏳" : "🔒"}</div>
        <div style="font-size:13px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;
          color:#7B5FE8;margin-bottom:10px">PIPSILY</div>
        <h2 style="margin:0 0 12px;font-size:22px;font-weight:800">
          ${expired ? "Abonnement expiré" : "Compte en attente"}
        </h2>
        <p style="color:#7a9cc0;margin:0 0 28px;line-height:1.65;font-size:14px">
          ${expired
            ? "Votre abonnement a expiré. Renouvelez-le pour continuer à profiter de PIPSILY."
            : "Votre compte est en attente d'activation. Contactez l'administrateur pour activer votre accès."}
        </p>
        <div style="background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);
          border-radius:16px;padding:20px;margin-bottom:20px">
          <div style="font-size:32px;font-weight:900;color:#38A8E8;margin-bottom:4px">4,99 €</div>
          <div style="font-size:13px;color:#7a9cc0">/mois · accès illimité</div>
          <div style="margin-top:12px;font-size:12px;color:#7a9cc0">
            Appareils supplémentaires : <strong style="color:#eef4ff">+1,50 €/mois chacun</strong>
          </div>
        </div>
        <a href="account.html" style="display:block;padding:14px 24px;border-radius:13px;
          background:linear-gradient(135deg,#7B5FE8,#38A8E8);color:#fff;
          text-decoration:none;font-weight:700;font-size:15px;margin-bottom:10px">
          Mon compte &amp; renouvellement
        </a>
        <button onclick="window.PIPSILY_AUTH.signOut().then(()=>location.href='login.html')"
          style="width:100%;padding:12px;border-radius:12px;border:1px solid rgba(255,255,255,.12);
          background:transparent;color:#7a9cc0;font-size:13px;cursor:pointer">
          Se déconnecter
        </button>
      </div>
    </div>`;
}

function _showDeviceLimit(plan){
  const maxDevices = plan === "unlimited" ? MAX_DEVICES.unlimited : MAX_DEVICES.default;
  const msg = maxDevices === 1
    ? "Votre compte autorise un seul appareil enregistré. Déconnectez-vous de l'appareil actuel ou contactez l'administrateur."
    : `Votre compte autorise ${maxDevices} appareils. Gérez vos appareils depuis la page Mon compte.`;
  document.body.innerHTML = `
    <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;
      background:radial-gradient(ellipse at 50% 0%,rgba(59,124,244,.15),transparent 60%),#05080f;
      color:#eef4ff;font-family:'Segoe UI',system-ui,sans-serif;padding:20px;box-sizing:border-box">
      <div style="max-width:380px;width:100%;text-align:center">
        <div style="font-size:56px;margin-bottom:16px">📱</div>
        <div style="font-size:13px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;
          color:#7B5FE8;margin-bottom:10px">PIPSILY</div>
        <h2 style="margin:0 0 12px;font-size:22px;font-weight:800">Limite d'appareils atteinte</h2>
        <p style="color:#7a9cc0;margin:0 0 24px;line-height:1.65;font-size:14px">${msg}</p>
        <a href="account.html" style="display:block;padding:14px 24px;border-radius:13px;
          background:linear-gradient(135deg,#7B5FE8,#38A8E8);color:#fff;
          text-decoration:none;font-weight:700;font-size:15px;margin-bottom:10px">
          Gérer mes appareils
        </a>
        <button onclick="window.PIPSILY_AUTH.signOut().then(()=>location.href='login.html')"
          style="width:100%;padding:12px;border-radius:12px;border:1px solid rgba(255,255,255,.12);
          background:transparent;color:#7a9cc0;font-size:13px;cursor:pointer">
          Se déconnecter
        </button>
      </div>
    </div>`;
}

function _showConcurrentLimit(maxConcurrent){
  const nb = isFinite(maxConcurrent) ? maxConcurrent : 1;
  const label = nb === 1 ? "une seule connexion simultanée" : `${nb} connexions simultanées`;
  document.body.innerHTML = `
    <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;
      background:radial-gradient(ellipse at 50% 0%,rgba(232,100,60,.12),transparent 60%),#05080f;
      color:#eef4ff;font-family:'Segoe UI',system-ui,sans-serif;padding:20px;box-sizing:border-box">
      <div style="max-width:380px;width:100%;text-align:center">
        <div style="font-size:56px;margin-bottom:16px">🔒</div>
        <div style="font-size:13px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;
          color:#7B5FE8;margin-bottom:10px">PIPSILY</div>
        <h2 style="margin:0 0 12px;font-size:22px;font-weight:800">Trop d'appareils connectés</h2>
        <p style="color:#7a9cc0;margin:0 0 24px;line-height:1.65;font-size:14px">
          Votre compte autorise ${label}.<br>
          Déconnectez-vous d'un autre appareil, puis reconnectez-vous ici.
        </p>
        <a href="login.html" style="display:block;padding:14px 24px;border-radius:13px;
          background:linear-gradient(135deg,#7B5FE8,#38A8E8);color:#fff;
          text-decoration:none;font-weight:700;font-size:15px;margin-bottom:10px">
          Se reconnecter
        </a>
        <a href="account.html" style="display:block;padding:12px;border-radius:12px;
          border:1px solid rgba(255,255,255,.12);color:#7a9cc0;
          text-decoration:none;font-size:13px">
          Gérer mes appareils
        </a>
      </div>
    </div>`;
}

function _showSessionExpired(){
  document.body.innerHTML = `
    <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;
      background:#05080f;color:#eef4ff;font-family:'Segoe UI',system-ui,sans-serif;padding:20px">
      <div style="max-width:360px;text-align:center">
        <div style="font-size:52px;margin-bottom:16px">📵</div>
        <h2 style="margin:0 0 12px;font-size:22px">Session expirée</h2>
        <p style="color:#7a9cc0;margin:0 0 24px;line-height:1.6;font-size:14px">
          Votre compte a été connecté depuis un autre appareil.<br>
          Une seule connexion simultanée est autorisée par compte.
        </p>
        <a href="login.html" style="display:block;padding:14px;border-radius:12px;
          background:linear-gradient(135deg,#7B5FE8,#38A8E8);color:#fff;
          text-decoration:none;font-weight:700;font-size:15px">
          Se reconnecter
        </a>
      </div>
    </div>`;
}

// ─────────────────────────────────────────────────────────────────
//  EXPORT GLOBAL
// ─────────────────────────────────────────────────────────────────
window.PIPSILY_AUTH = {
  supabase           : _supa,
  ADMIN_EMAIL,
  WERO_PHONE,
  WERO_NAME,
  getSession,
  signIn,
  signUp,
  signOut,
  getProfile,
  checkSubscription,
  registerSession,
  validateSession,
  ensureDevice,
  addExtraDevice,
  getParentalPin,
  setParentalPin,
  promptParentalPin,
  authGate,
  getDeviceId,
  getDeviceName,
  startSessionWatcher
};

// ─────────────────────────────────────────────────────────────────
//  SQL SUPABASE — Coller dans l'éditeur SQL de votre projet
// ─────────────────────────────────────────────────────────────────
/*
-- ① Profils utilisateurs
create table profiles (
  id                     uuid references auth.users primary key,
  email                  text,
  plan                   text default 'pending',  -- pending | active | unlimited | admin
  subscription_expires_at timestamptz,
  devices_allowed        integer default 1,
  parental_pin           text,
  created_at             timestamptz default now()
);

-- ② Appareils
create table devices (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references profiles(id) on delete cascade,
  device_id   text,
  device_name text,
  monthly_fee numeric default 0,
  last_seen   timestamptz default now(),
  created_at  timestamptz default now(),
  unique(user_id, device_id)
);

-- ③ Sessions (multi-appareils — heartbeat 30s)
create table sessions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references profiles(id) on delete cascade,
  device_id   text,
  device_name text,
  token       text,
  ip          text,
  country     text,
  city        text,
  region      text,
  isp         text,
  last_seen   timestamptz default now(),
  created_at  timestamptz default now()
);

-- Migration si table sessions existe déjà (coller séparément si besoin) :
-- alter table sessions add column if not exists device_name text;
-- alter table sessions add column if not exists ip          text;
-- alter table sessions add column if not exists country     text;
-- alter table sessions add column if not exists city        text;
-- alter table sessions add column if not exists region      text;
-- alter table sessions add column if not exists isp         text;
-- alter table sessions add column if not exists last_seen   timestamptz default now();

-- ④ Paiements (suivi manuel Wero)
create table payments (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references profiles(id) on delete cascade,
  amount        numeric,
  type          text default 'subscription', -- subscription | extra_device
  period_start  date,
  period_end    date,
  confirmed_at  timestamptz,
  confirmed_by  uuid,
  notes         text,
  created_at    timestamptz default now()
);

-- ⑤ Trigger auto-création profil à l'inscription (exception-safe)
create or replace function handle_new_user()
returns trigger language plpgsql security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, plan)
  values (new.id, new.email,
    case when new.email = 'cedric.lago@gmail.com' then 'admin' else 'pending' end)
  on conflict (id) do nothing;
  return new;
exception when others then
  -- Ne jamais bloquer la création d'un utilisateur
  raise warning 'handle_new_user error: %', sqlerrm;
  return new;
end;
$$;
-- Supprimer l'ancien trigger s'il existe avant de recréer
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure handle_new_user();

-- ⑥ RLS (Row Level Security)
alter table profiles enable row level security;
alter table devices  enable row level security;
alter table sessions enable row level security;
alter table payments enable row level security;

-- Lecture/écriture de son propre profil
create policy "own profile" on profiles for all using (auth.uid() = id);
-- Admin lit tout
create policy "admin all profiles" on profiles for all
  using ((select plan from profiles where id = auth.uid()) = 'admin');

create policy "own devices"  on devices  for all using (auth.uid() = user_id);
create policy "own sessions" on sessions for all using (auth.uid() = user_id);
create policy "own payments" on payments for all using (auth.uid() = user_id);
create policy "admin all devices"  on devices  for all
  using ((select plan from profiles where id = auth.uid()) = 'admin');
create policy "admin all payments" on payments for all
  using ((select plan from profiles where id = auth.uid()) = 'admin');
create policy "admin all sessions" on sessions for all
  using ((select plan from profiles where id = auth.uid()) = 'admin');
*/
