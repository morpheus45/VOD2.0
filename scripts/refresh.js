/**
 * scripts/refresh.js — PIPSILY v1.0
 * ────────────────────────────────────
 * Rafraîchit TOUTES les données IPTV statiques :
 *   • series.json   — liste complète des séries
 *   • vod.json      — liste complète des films
 *   • episodes_part*.json — données épisodes (incrémental)
 *   • episodes_map.json + episodes_index.json
 *
 * Usage local  : node scripts/refresh.js
 * GitHub Actions : XTREAM_BASE / XTREAM_USER / XTREAM_PASS en secrets
 *
 * Sans secrets, lit les credentials depuis series.json existant.
 */

"use strict";

const fs    = require("fs");
const path  = require("path");
const http  = require("http");
const https = require("https");

// ─── Chemins ──────────────────────────────────────────────────────────────────
const ROOT        = path.join(__dirname, "..");
const SERIES_JSON = path.join(ROOT, "series.json");
const VOD_JSON    = path.join(ROOT, "vod.json");
const LIVE_JSON   = path.join(ROOT, "live.json");

// ─── Config ───────────────────────────────────────────────────────────────────
const CHUNK_SIZE  = 500;
const CONCURRENCY = 8;
const TIMEOUT_MS  = 20000;
const MAX_RETRIES = 2;

// ─── Helpers HTTP ─────────────────────────────────────────────────────────────
function fetchJson(url, attempt = 0){
  return new Promise(resolve => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, { timeout: TIMEOUT_MS }, res => {
      // Suivre les redirections 301/302/307/308
      if((res.statusCode === 301 || res.statusCode === 302 ||
          res.statusCode === 307 || res.statusCode === 308) && res.headers.location){
        resolve(fetchJson(res.headers.location, attempt));
        return;
      }
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", c => buf += c);
      res.on("end", () => {
        try { resolve(JSON.parse(buf)); }
        catch { resolve(null); }
      });
    });
    req.on("error", () => {
      if(attempt < MAX_RETRIES) resolve(fetchJson(url, attempt + 1));
      else resolve(null);
    });
    req.on("timeout", () => {
      req.destroy();
      if(attempt < MAX_RETRIES) resolve(fetchJson(url, attempt + 1));
      else resolve(null);
    });
  });
}

// ─── Credentials ──────────────────────────────────────────────────────────────
function getCredentials(){
  // 1. Variables d'environnement (GitHub Secrets)
  if(process.env.XTREAM_BASE && process.env.XTREAM_USER && process.env.XTREAM_PASS){
    return {
      base    : process.env.XTREAM_BASE.replace(/\/$/, ""),
      username: process.env.XTREAM_USER,
      password: process.env.XTREAM_PASS
    };
  }
  // 2. Extraire depuis series.json existant (stream_url contient username + password)
  try {
    const raw = fs.readFileSync(SERIES_JSON, "utf8");
    const d   = JSON.parse(raw);
    const all = d.items || [];
    const first = all.find(x => x.stream_url || x.url);
    if(first){
      const urlStr = first.stream_url || first.url;
      const u = new URL(urlStr);
      const base = u.origin.replace(/\/$/, "");
      const username = u.searchParams.get("username") || "";
      const password = u.searchParams.get("password") || "";
      if(username && password){
        console.log("  (credentials lus depuis series.json)");
        return { base, username, password };
      }
    }
  } catch(e) {}
  throw new Error(
    "Credentials introuvables.\n" +
    "Définissez XTREAM_BASE, XTREAM_USER, XTREAM_PASS en variables d'environnement."
  );
}

function apiUrl(creds, action, extra = ""){
  return `${creds.base}/player_api.php?username=${creds.username}&password=${creds.password}&action=${action}${extra}`;
}

// ─── Nettoyage titre ──────────────────────────────────────────────────────────
function cleanTitle(t){
  if(!t) return "";
  let s = String(t);
  s = s.replace(/^(FR|SRS|EN|VOD|SERIE)\s*[-|:]\s*/i, "");
  s = s.replace(/\s*\(\d{4}\)\s*$/, "");
  return s.replace(/\s+/g, " ").trim();
}

function inferQuality(src){
  const t = String(src || "").toLowerCase();
  if(/\b(4k|uhd|2160p?)\b/.test(t)) return "4K";
  if(/\b(fhd|full[\s-]?hd|1080p?|hd|720p?)\b/.test(t)) return "HD";
  if(/\b(sd|480p?|360p?)\b/.test(t)) return "SD";
  return "";
}

// ─── Refresh séries ───────────────────────────────────────────────────────────
async function refreshSeries(creds){
  console.log("\n1/4  Séries...");
  const [seriesList, cats] = await Promise.all([
    fetchJson(apiUrl(creds, "get_series")),
    fetchJson(apiUrl(creds, "get_series_categories"))
  ]);

  if(!Array.isArray(seriesList)){
    console.error("   ✗ Impossible de charger get_series");
    return false;
  }

  // Jointure category_id → category_name
  const catMap = {};
  if(Array.isArray(cats)) cats.forEach(c => { catMap[String(c.category_id)] = c.category_name || ""; });

  const items = seriesList.map(s => {
    const catName = catMap[String(s.category_id)] || s.category_name || "";
    return {
      id            : s.series_id || s.id,
      series_id     : s.series_id || s.id,
      title         : cleanTitle(s.name || s.title || ""),
      category_id   : s.category_id || "",
      category_name : cleanTitle(catName),
      stream_icon   : s.cover || s.stream_icon || "",
      plot          : s.plot || "",
      quality       : inferQuality(`${s.name || ""} ${catName}`),
      stream_url    : `${creds.base}/player_api.php?username=${creds.username}&password=${creds.password}&action=get_series_info&series_id=${s.series_id || s.id}`,
      added         : s.added ? Number(s.added) : 0
    };
  });

  const out = {
    meta: {
      kind       : "series",
      created_at : new Date().toISOString(),
      source_base: creds.base,
      username   : creds.username,
      note       : "stream_url pointe vers get_series_info"
    },
    categories: Array.isArray(cats) ? cats : [],
    items
  };

  fs.writeFileSync(SERIES_JSON, JSON.stringify(out), "utf8");
  console.log(`   ✓ ${items.length} séries → series.json`);
  return items;
}

// ─── Refresh VOD ──────────────────────────────────────────────────────────────
async function refreshVod(creds){
  console.log("\n2/4  Films VOD...");
  const [vodList, cats] = await Promise.all([
    fetchJson(apiUrl(creds, "get_vod_streams")),
    fetchJson(apiUrl(creds, "get_vod_categories"))
  ]);

  if(!Array.isArray(vodList)){
    console.warn("   ⚠  Impossible de charger get_vod_streams — vod.json non mis à jour");
    return;
  }

  // Jointure category_id → category_name
  const catMap = {};
  if(Array.isArray(cats)) cats.forEach(c => { catMap[String(c.category_id)] = c.category_name || ""; });

  const items = vodList.map(v => {
    const catName = catMap[String(v.category_id)] || v.category_name || "";
    return {
      id            : v.stream_id || v.id,
      stream_id     : v.stream_id || v.id,
      title         : cleanTitle(v.name || v.title || ""),
      category_id   : v.category_id || "",
      category_name : cleanTitle(catName),
      stream_icon   : v.stream_icon || v.cover || "",
      plot          : v.plot || "",
      quality       : inferQuality(`${v.name || ""} ${catName}`),
      stream_url    : `${creds.base}/movie/${creds.username}/${creds.password}/${v.stream_id}.${v.container_extension || "mkv"}`,
      added         : v.added ? Number(v.added) : 0
    };
  });

  const out = {
    meta: {
      kind       : "vod",
      created_at : new Date().toISOString(),
      source_base: creds.base,
      username   : creds.username
    },
    categories: Array.isArray(cats) ? cats : [],
    items
  };

  fs.writeFileSync(VOD_JSON, JSON.stringify(out), "utf8");
  console.log(`   ✓ ${items.length} films → vod.json`);
}

// ─── Refresh Live TV ─────────────────────────────────────────────────────────
async function refreshLive(creds){
  console.log("\n3/4  Chaînes TV en direct...");
  const [streams, cats] = await Promise.all([
    fetchJson(apiUrl(creds, "get_live_streams")),
    fetchJson(apiUrl(creds, "get_live_categories"))
  ]);

  if(!Array.isArray(streams)){
    console.warn("   ⚠  Impossible de charger get_live_streams — live.json non mis à jour");
    return;
  }

  const catMap = {};
  if(Array.isArray(cats)) cats.forEach(c => { catMap[String(c.category_id)] = c.category_name || ""; });

  function cleanLiveTitle(t){
    if(!t) return "";
    let s = String(t);
    // Supprimer les séparateurs décoratifs ##### NOM #####
    s = s.replace(/^#{2,}\s*/, "").replace(/\s*#{2,}$/, "").trim();
    s = s.replace(/^(FR|EN|EU)\s*[-|:]\s*/i, "");
    return s.replace(/\s+/g, " ").trim();
  }

  const items = streams.map(s => ({
    id           : s.stream_id,
    stream_id    : s.stream_id,
    title        : cleanLiveTitle(s.name || ""),
    category_id  : s.category_id || "",
    category_name: cleanTitle(catMap[String(s.category_id)] || s.category_name || "Autre"),
    stream_icon  : s.stream_icon || "",
    stream_url   : `${creds.base}/live/${creds.username}/${creds.password}/${s.stream_id}.m3u8`,
    type         : "live"
  }));

  const out = {
    meta: {
      kind       : "live",
      created_at : new Date().toISOString(),
      source_base: creds.base,
      username   : creds.username
    },
    categories: Array.isArray(cats) ? cats : [],
    items
  };

  fs.writeFileSync(LIVE_JSON, JSON.stringify(out), "utf8");
  console.log(`   ✓ ${items.length} chaînes TV → live.json`);
}

// ─── Refresh épisodes (incrémental) ──────────────────────────────────────────
async function refreshEpisodes(creds, seriesItems){
  console.log("\n4/4  Épisodes (incrémental)...");

  // Charger cache existant
  const existing = {};
  for(let i = 1; i <= 20; i++){
    const f = path.join(ROOT, `episodes_part${i}.json`);
    if(!fs.existsSync(f)) break;
    try { Object.assign(existing, JSON.parse(fs.readFileSync(f, "utf8"))); }
    catch {}
  }
  console.log(`   Cache : ${Object.keys(existing).length} séries existantes`);

  // Séries manquantes
  const missing = seriesItems.filter(s => {
    const sid = String(s.series_id || s.id || "");
    return sid && !existing[sid];
  });
  console.log(`   À fetcher : ${missing.length} nouvelles séries`);

  if(missing.length === 0){
    console.log("   ✓ Base épisodes déjà à jour");
    writeChunks(existing);
    return;
  }

  let fetched = 0;
  let found   = 0;

  async function fetchOne(s){
    const sid = String(s.series_id || s.id || "");
    const url = `${creds.base}/player_api.php?username=${creds.username}&password=${creds.password}&action=get_series_info&series_id=${sid}`;
    const data = await fetchJson(url);
    if(!data) return;

    const seasons = {};
    const seasonsMeta = [];

    if(data.episodes && typeof data.episodes === "object"){
      Object.entries(data.episodes).forEach(([sk, list]) => {
        if(!Array.isArray(list) || !list.length) return;
        seasons[sk] = list
          .filter(ep => ep && (ep.id || ep.episode_num))
          .map(ep => {
            let epUrl = ep.url;
            if(!epUrl || epUrl.includes("player_api") || epUrl.includes("get_series_info")){
              const ext = ep.container_extension || "mkv";
              epUrl = ep.id ? `${creds.base}/series/${creds.username}/${creds.password}/${ep.id}.${ext}` : "";
            }
            return {
              id         : ep.id,
              episode_num: Number(ep.episode_num) || 1,
              season     : Number(ep.season || sk),
              title      : ep.title || ep.name || "",
              url        : epUrl,
              ext        : ep.container_extension || "mkv",
              duration   : ep.info?.duration || "",
              plot       : ep.info?.plot || "",
              thumb      : ep.info?.movie_image || ""
            };
          })
          .sort((a, b) => a.episode_num - b.episode_num);
      });
    }

    if(Array.isArray(data.seasons)){
      data.seasons.filter(s => s.season_number > 0).forEach(s => {
        seasonsMeta.push({
          num  : s.season_number,
          name : s.name || `Saison ${s.season_number}`,
          cover: s.cover_big || s.cover || "",
          count: s.episode_count || 0
        });
      });
      seasonsMeta.sort((a, b) => a.num - b.num);
    }

    if(Object.keys(seasons).length === 0) return;

    existing[sid] = {
      meta: {
        cover: data.info?.cover || data.info?.movie_image || "",
        plot : data.info?.plot || data.info?.description || ""
      },
      seasons,
      seasonsMeta
    };
    found++;
  }

  // Batches parallèles
  for(let i = 0; i < missing.length; i += CONCURRENCY){
    const batch = missing.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(fetchOne));
    fetched += batch.length;
    if(fetched % 200 === 0 || fetched >= missing.length){
      process.stdout.write(`\r   ${fetched}/${missing.length} fetchés, ${found} avec épisodes…`);
    }
  }
  console.log(`\n   ✓ ${found} nouvelles séries avec épisodes`);

  writeChunks(existing);
}

// ─── Écriture chunks ──────────────────────────────────────────────────────────
function writeChunks(db){
  const entries    = Object.entries(db);
  const chunkCount = Math.ceil(entries.length / CHUNK_SIZE);
  const epMap      = {};

  for(let c = 0; c < chunkCount; c++){
    const slice = entries.slice(c * CHUNK_SIZE, (c + 1) * CHUNK_SIZE);
    const chunk = Object.fromEntries(slice);
    const file  = path.join(ROOT, `episodes_part${c + 1}.json`);
    fs.writeFileSync(file, JSON.stringify(chunk), "utf8");
    const kb = Math.round(fs.statSync(file).size / 1024);
    slice.forEach(([sid]) => { epMap[sid] = c + 1; });
    console.log(`   ✓ episodes_part${c + 1}.json  (${slice.length} séries, ${kb} KB)`);
  }

  // Supprimer les anciens chunks en surplus
  for(let c = chunkCount + 1; c <= 20; c++){
    const f = path.join(ROOT, `episodes_part${c}.json`);
    if(fs.existsSync(f)){ fs.unlinkSync(f); console.log(`   ✓ episodes_part${c}.json supprimé`); }
  }

  fs.writeFileSync(path.join(ROOT, "episodes_map.json"), JSON.stringify(epMap), "utf8");
  const idx = { chunks: chunkCount, total: entries.length, generated: new Date().toISOString() };
  fs.writeFileSync(path.join(ROOT, "episodes_index.json"), JSON.stringify(idx), "utf8");
  console.log(`   ✓ Index : ${chunkCount} chunks, ${entries.length} séries total`);
}

// ─── Génération M3U ──────────────────────────────────────────────────────────
function generateVodM3u(creds) {
  console.log("\n5/5  Génération vod.m3u...");
  let data;
  try {
    data = JSON.parse(fs.readFileSync(VOD_JSON, "utf8"));
  } catch {
    console.warn("   ⚠  vod.json introuvable — vod.m3u non généré");
    return;
  }

  const items = data.items || [];
  const lines = ["#EXTM3U"];
  for (const v of items) {
    const logo     = v.stream_icon ? ` tvg-logo="${v.stream_icon}"` : "";
    const group    = v.category_name || "Films";
    const title    = v.title || "";
    const url      = v.stream_url || "";
    if (!url) continue;
    lines.push(`#EXTINF:-1${logo} group-title="${group}",${title}`);
    lines.push(url);
  }
  fs.writeFileSync(path.join(ROOT, "vod.m3u"), lines.join("\n"), "utf8");
  console.log(`   ✓ ${items.length} films → vod.m3u`);
}

function generateSeriesM3u(creds) {
  console.log("      Génération series.m3u...");
  let data;
  try {
    data = JSON.parse(fs.readFileSync(SERIES_JSON, "utf8"));
  } catch {
    console.warn("   ⚠  series.json introuvable — series.m3u non généré");
    return;
  }

  const items = data.items || [];
  const lines = ["#EXTM3U"];
  for (const s of items) {
    const logo  = s.stream_icon ? ` tvg-logo="${s.stream_icon}"` : "";
    const group = s.category_name || "Séries";
    const title = s.title || "";
    const url   = `${creds.base}/player_api.php?username=${creds.username}&password=${creds.password}&action=get_series_info&series_id=${s.series_id || s.id}`;
    lines.push(`#EXTINF:-1${logo} group-title="${group}",${title}`);
    lines.push(url);
  }
  fs.writeFileSync(path.join(ROOT, "series.m3u"), lines.join("\n"), "utf8");
  console.log(`   ✓ ${items.length} séries → series.m3u`);
}

function generateLiveM3u(creds) {
  console.log("      Génération live.m3u...");
  let data;
  try {
    data = JSON.parse(fs.readFileSync(LIVE_JSON, "utf8"));
  } catch {
    console.warn("   ⚠  live.json introuvable — live.m3u non généré");
    return;
  }

  const items = data.items || [];
  const lines = ["#EXTM3U"];
  for (const ch of items) {
    const logo  = ch.stream_icon ? ` tvg-logo="${ch.stream_icon}"` : "";
    const group = ch.category_name || "TV";
    const title = ch.title || "";
    const url   = ch.stream_url || "";
    if (!url) continue;
    lines.push(`#EXTINF:-1${logo} group-title="${group}",${title}`);
    lines.push(url);
  }
  fs.writeFileSync(path.join(ROOT, "live.m3u"), lines.join("\n"), "utf8");
  console.log(`   ✓ ${items.length} chaînes → live.m3u`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main(){
  console.log("╔══════════════════════════════════════╗");
  console.log("║  PIPSILY — Refresh données IPTV    ║");
  console.log("╚══════════════════════════════════════╝");

  const creds = getCredentials();
  console.log(`\n📡  API : ${creds.base}  (user: ${creds.username})`);

  const seriesItems = await refreshSeries(creds);
  if(!seriesItems){ process.exit(1); }

  await refreshVod(creds);
  await refreshLive(creds);
  await refreshEpisodes(creds, seriesItems);

  console.log("\n5/5  Fichiers M3U...");
  generateVodM3u(creds);
  generateSeriesM3u(creds);
  generateLiveM3u(creds);

  console.log("\n✅  Refresh terminé avec succès !");
}

main().catch(e => {
  console.error("\n❌", e.message);
  process.exit(1);
});
