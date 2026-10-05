// Reco — serveur : connexion par code d'invitation, envoi des vidéos par morceaux vers R2,
// liens de partage publics (/v/:id), lecture avec support Range (/f/:id), miniatures (/t/:id).

const ID_RE = /^[A-Za-z0-9]{12}$/;
const TYPES = { mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime" };
const KEY_RE = /^v\/[A-Za-z0-9]{12}\.(mp4|webm|mov)$/;
const COOKIE = "reco_session";
const MAX_PART = 64 * 1024 * 1024;
const enc = new TextEncoder();

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
const bad = (msg, status = 400) => json({ error: msg }, status);

function newId() {
  const a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const b = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(b, (x) => a[x % 62]).join("");
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ── sessions signées (HMAC-SHA256) ──
async function hmac(secret, data) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64u(s) { return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function unb64u(s) { return decodeURIComponent(escape(atob(s.replace(/-/g, "+").replace(/_/g, "/")))); }

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function makeSession(env, name) {
  const exp = Date.now() + 30 * 24 * 3600 * 1000;
  const payload = `${b64u(name)}.${exp}`;
  return `${payload}.${await hmac(env.SESSION_SECRET, payload)}`;
}

async function readSession(req, env) {
  const m = (req.headers.get("cookie") || "").match(new RegExp(`${COOKIE}=([^;]+)`));
  if (!m) return null;
  const [n, exp, sig] = m[1].split(".");
  if (!n || !exp || !sig) return null;
  if (!safeEqual(sig, await hmac(env.SESSION_SECRET, `${n}.${exp}`))) return null;
  if (Date.now() > Number(exp)) return null;
  try { return { name: unb64u(n) }; } catch { return null; }
}

async function getMeta(env, id) {
  if (!ID_RE.test(id)) return null;
  const o = await env.VIDEOS.get(`m/${id}.json`);
  return o ? o.json() : null;
}

// ── lecture vidéo avec Range (indispensable pour l'avance rapide et Safari) ──
async function serveObject(req, env, key, contentType) {
  const head = await env.VIDEOS.head(key);
  if (!head) return new Response("Introuvable", { status: 404 });
  const size = head.size;
  const range = req.headers.get("range");
  const base = { "accept-ranges": "bytes", "content-type": contentType, "cache-control": "public, max-age=86400" };
  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/);
    if (!m) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    let start = m[1] === "" ? null : Number(m[1]);
    let end = m[2] === "" ? null : Number(m[2]);
    if (start === null) { start = Math.max(0, size - (end ?? 0)); end = size - 1; }
    if (end === null || end >= size) end = size - 1;
    if (start > end || start >= size) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    if (req.method === "HEAD") return new Response(null, { status: 206, headers: { ...base, "content-length": String(end - start + 1), "content-range": `bytes ${start}-${end}/${size}` } });
    const obj = await env.VIDEOS.get(key, { range: { offset: start, length: end - start + 1 } });
    return new Response(obj.body, { status: 206, headers: { ...base, "content-length": String(end - start + 1), "content-range": `bytes ${start}-${end}/${size}` } });
  }
  if (req.method === "HEAD") return new Response(null, { headers: { ...base, "content-length": String(size) } });
  const obj = await env.VIDEOS.get(key);
  return new Response(obj.body, { headers: { ...base, "content-length": String(size) } });
}

function playerPage(origin, meta) {
  const url = `${origin}/v/${meta.id}`;
  const date = new Date(meta.created).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
  const d = (meta.trimEnd || meta.duration || 0) - (meta.trimStart || 0);
  const dur = d > 0 ? `${Math.floor(d / 60)}:${String(Math.floor(d % 60)).padStart(2, "0")}` : "";
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(meta.title)} · Reco</title>
<meta property="og:type" content="video.other"><meta property="og:title" content="${esc(meta.title)}">
<meta property="og:description" content="Vidéo de ${esc(meta.author)}${dur ? " · " + dur : ""}">
<meta property="og:url" content="${esc(url)}"><meta property="og:image" content="${esc(origin)}/t/${meta.id}">
<meta property="og:video" content="${esc(origin)}/f/${meta.id}"><meta property="og:video:type" content="${esc(meta.contentType)}">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/style.css"></head>
<body class="player"><main class="pwrap">
<a class="brand" href="/"><span class="logo"></span>Reco</a>
<video id="pv" controls playsinline preload="metadata" poster="/t/${meta.id}" src="/f/${meta.id}${meta.trimStart || meta.trimEnd ? `#t=${meta.trimStart || 0}${meta.trimEnd ? "," + meta.trimEnd : ""}` : ""}"></video>
<div class="pmeta"><div><h1>${esc(meta.title)}</h1><p class="muted">${esc(meta.author)} · ${esc(date)}${dur ? " · " + dur : ""}</p></div>
<div class="pact"><button class="btn" id="copy">Copier le lien</button><a class="btn ghost" href="/f/${meta.id}" download="${esc(meta.title)}.${meta.ext}">Télécharger</a></div></div>
</main><script>
const v=document.getElementById("pv"),T0=${Number(meta.trimStart) || 0},T1=${Number(meta.trimEnd) || 0};let counted=false;
v.addEventListener("loadedmetadata",()=>{if(T0&&v.currentTime<T0)v.currentTime=T0});
v.addEventListener("timeupdate",()=>{if(T1&&v.currentTime>=T1){v.pause();v.currentTime=T1}if(T0&&v.currentTime<T0-0.3)v.currentTime=T0});
v.addEventListener("play",()=>{if(T1&&v.currentTime>=T1-0.05)v.currentTime=T0;if(!counted){counted=true;fetch("/api/view/${meta.id}",{method:"POST"}).catch(()=>{})}});
document.getElementById("copy").onclick=async(e)=>{await navigator.clipboard.writeText(location.href);e.target.textContent="Lien copié ✓";setTimeout(()=>e.target.textContent="Copier le lien",1800)};
</script></body></html>`;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    const m = req.method;

    // ── public ──
    if (p.startsWith("/v/")) {
      const meta = await getMeta(env, p.slice(3));
      if (!meta) return new Response("Cette vidéo n'existe pas (ou a été supprimée).", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
      return new Response(playerPage(url.origin, meta), { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (p.startsWith("/f/") && (m === "GET" || m === "HEAD")) {
      const meta = await getMeta(env, p.slice(3));
      if (!meta) return new Response("Introuvable", { status: 404 });
      return serveObject(req, env, meta.key, meta.contentType);
    }
    if (p.startsWith("/t/") && (m === "GET" || m === "HEAD")) {
      const id = p.slice(3);
      if (!ID_RE.test(id)) return new Response("Introuvable", { status: 404 });
      return serveObject(req, env, `t/${id}.jpg`, "image/jpeg");
    }

    const vw = p.match(/^\/api\/view\/([A-Za-z0-9]{12})$/);
    if (vw && m === "POST") {
      const meta = await getMeta(env, vw[1]);
      if (!meta) return bad("Introuvable.", 404);
      meta.views = (meta.views || 0) + 1;
      await env.VIDEOS.put(`m/${meta.id}.json`, JSON.stringify(meta), { httpMetadata: { contentType: "application/json" } });
      return json({ ok: true });
    }

    // ── installateur de l'appli de bureau (déposé dans R2 : apps/Reco-Setup.exe) ──
    if (p === "/download" && (m === "GET" || m === "HEAD")) {
      const obj = await env.VIDEOS.get("apps/Reco-Setup.exe");
      if (!obj) return new Response("L'appli de bureau n'est pas encore disponible sur ce serveur.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
      return new Response(m === "HEAD" ? null : obj.body, { headers: { "content-type": "application/octet-stream", "content-length": String(obj.size), "content-disposition": 'attachment; filename="Reco-Setup.exe"' } });
    }

    // ── connexion ──
    if (p === "/api/login" && m === "POST") {
      const body = await req.json().catch(() => ({}));
      const name = String(body.name || "").trim().slice(0, 40);
      if (!name) return bad("Indique ton prénom.");
      if (!env.INVITE_CODE || !safeEqual(String(body.code || ""), env.INVITE_CODE)) return bad("Code d'invitation incorrect.", 401);
      const v = await makeSession(env, name);
      return json({ ok: true, name }, 200, { "set-cookie": `${COOKIE}=${v}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${30 * 24 * 3600}` });
    }
    if (p === "/api/logout" && m === "POST") {
      return json({ ok: true }, 200, { "set-cookie": `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });
    }

    // ── tout le reste de /api demande une session ──
    if (!p.startsWith("/api/")) return env.ASSETS.fetch(req);
    const user = await readSession(req, env);
    if (!user) return bad("Non connecté.", 401);

    if (p === "/api/me") return json({ name: user.name });

    if (p === "/api/upload/start" && m === "POST") {
      const body = await req.json().catch(() => ({}));
      const ext = body.ext in TYPES ? body.ext : null;
      if (!ext) return bad("Format non pris en charge.");
      const id = newId();
      const key = `v/${id}.${ext}`;
      const up = await env.VIDEOS.createMultipartUpload(key, { httpMetadata: { contentType: TYPES[ext] } });
      return json({ id, key, uploadId: up.uploadId });
    }

    if (p === "/api/upload/part" && m === "PUT") {
      const key = url.searchParams.get("key") || "";
      const uploadId = url.searchParams.get("uploadId") || "";
      const n = Number(url.searchParams.get("n"));
      if (!KEY_RE.test(key) || !uploadId || !(n >= 1 && n <= 10000)) return bad("Paramètres invalides.");
      const buf = await req.arrayBuffer();
      if (!buf.byteLength || buf.byteLength > MAX_PART) return bad("Morceau trop gros.");
      const part = await env.VIDEOS.resumeMultipartUpload(key, uploadId).uploadPart(n, buf);
      return json({ partNumber: part.partNumber, etag: part.etag });
    }

    if (p === "/api/upload/complete" && m === "POST") {
      const b = await req.json().catch(() => ({}));
      const { id, key, uploadId, parts } = b;
      if (!ID_RE.test(id || "") || key !== `v/${id}.${key?.split(".").pop()}` || !Array.isArray(parts) || !parts.length) return bad("Paramètres invalides.");
      const ext = key.split(".").pop();
      if (!(ext in TYPES)) return bad("Format non pris en charge.");
      const obj = await env.VIDEOS.resumeMultipartUpload(key, uploadId).complete(parts);
      const meta = {
        id, key, ext, contentType: TYPES[ext], size: obj.size,
        title: String(b.title || "Sans titre").trim().slice(0, 120) || "Sans titre",
        author: user.name, created: Date.now(),
        duration: Math.max(0, Math.min(Number(b.duration) || 0, 6 * 3600)),
        width: Number(b.width) || null, height: Number(b.height) || null,
      };
      await env.VIDEOS.put(`m/${id}.json`, JSON.stringify(meta), { httpMetadata: { contentType: "application/json" } });
      return json(meta);
    }

    if (p === "/api/upload/abort" && m === "POST") {
      const b = await req.json().catch(() => ({}));
      if (KEY_RE.test(b.key || "") && b.uploadId) await env.VIDEOS.resumeMultipartUpload(b.key, b.uploadId).abort().catch(() => {});
      return json({ ok: true });
    }

    const tm = p.match(/^\/api\/thumb\/([A-Za-z0-9]{12})$/);
    if (tm && m === "PUT") {
      const buf = await req.arrayBuffer();
      if (!buf.byteLength || buf.byteLength > 2 * 1024 * 1024) return bad("Miniature invalide.");
      if (!(await getMeta(env, tm[1]))) return bad("Vidéo inconnue.", 404);
      await env.VIDEOS.put(`t/${tm[1]}.jpg`, buf, { httpMetadata: { contentType: "image/jpeg" } });
      return json({ ok: true });
    }

    if (p === "/api/videos" && m === "GET") {
      const out = [];
      let cursor;
      do {
        const l = await env.VIDEOS.list({ prefix: "m/", cursor, limit: 1000 });
        const metas = await Promise.all(l.objects.map((o) => env.VIDEOS.get(o.key).then((r) => (r ? r.json() : null))));
        out.push(...metas.filter(Boolean));
        cursor = l.truncated ? l.cursor : undefined;
      } while (cursor);
      out.sort((a, b) => b.created - a.created);
      return json({ videos: out, used: out.reduce((s, v) => s + (v.size || 0), 0), quota: 10e9 });
    }

    const vm = p.match(/^\/api\/videos\/([A-Za-z0-9]{12})$/);
    if (vm) {
      const meta = await getMeta(env, vm[1]);
      if (!meta) return bad("Vidéo inconnue.", 404);
      if ((m === "PATCH" || m === "DELETE") && meta.author.toLowerCase() !== user.name.toLowerCase()) return bad("Seul l'auteur peut modifier ou supprimer cette vidéo.", 403);
      if (m === "PATCH") {
        const b = await req.json().catch(() => ({}));
        meta.title = String(b.title || meta.title).trim().slice(0, 120) || meta.title;
        if ("trimStart" in b || "trimEnd" in b) {
          const d = meta.duration || 6 * 3600;
          const ts = Math.max(0, Math.min(Number(b.trimStart) || 0, d));
          const te = b.trimEnd == null ? null : Math.max(ts + 0.5, Math.min(Number(b.trimEnd), d));
          meta.trimStart = ts > 0 ? Math.round(ts * 10) / 10 : 0;
          meta.trimEnd = te && te < d ? Math.round(te * 10) / 10 : null;
        }
        await env.VIDEOS.put(`m/${meta.id}.json`, JSON.stringify(meta), { httpMetadata: { contentType: "application/json" } });
        return json(meta);
      }
      if (m === "DELETE") {
        await env.VIDEOS.delete([meta.key, `t/${meta.id}.jpg`, `m/${meta.id}.json`]);
        return json({ ok: true });
      }
    }
    return bad("Introuvable.", 404);
  },
};
