// Partage par Google Drive : connexion OAuth (application de bureau, PKCE + redirection 127.0.0.1),
// envoi « reprenable » par morceaux de 8 Mo, puis lien lisible par toute personne qui l'a.
// Champ d'accès : drive.file — Reco ne voit QUE les fichiers qu'il a lui-même créés, jamais le reste du Drive.
const { ipcMain, shell, safeStorage } = require("electron");
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const local = require("./local");

const SCOPE = "https://www.googleapis.com/auth/drive.file";
const PART = 8 * 1024 * 1024; // multiple de 256 Ko, exigé par Google
const MOCK = process.env.RECO_DRIVE_MOCK === "1"; // tests : simule Google Drive

function client() {
  if (process.env.RECO_GOOGLE_CLIENT_ID) return { id: process.env.RECO_GOOGLE_CLIENT_ID, secret: process.env.RECO_GOOGLE_CLIENT_SECRET || "" };
  try { const c = JSON.parse(fs.readFileSync(path.join(__dirname, "google-client.json"), "utf8")); return c.client_id ? { id: c.client_id, secret: c.client_secret || "" } : null; } catch { return null; }
}
const b64u = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const seal = (s) => (safeStorage.isEncryptionAvailable() ? "enc:" + safeStorage.encryptString(s).toString("base64") : "raw:" + s);
const unseal = (s) => (!s ? "" : s.startsWith("enc:") ? safeStorage.decryptString(Buffer.from(s.slice(4), "base64")) : s.replace(/^raw:/, ""));

function register({ loadCfg, saveCfg, win }) {
  let access = null; // { token, exp }

  const status = () => {
    const d = loadCfg().drive || {};
    return { configured: MOCK || !!client(), connected: !!d.refresh, email: d.email || "" };
  };

  async function token() {
    if (MOCK) return "mock";
    if (access && access.exp > Date.now() + 60000) return access.token;
    const d = loadCfg().drive || {}, c = client();
    if (!d.refresh || !c) throw new Error("Google Drive n'est pas connecté.");
    const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: c.id, client_secret: c.secret, refresh_token: unseal(d.refresh), grant_type: "refresh_token" }) });
    const j = await r.json();
    if (!r.ok) { if (j.error === "invalid_grant") { const cfg = loadCfg(); delete cfg.drive; saveCfg(cfg); } throw new Error("Connexion Google expirée : reconnecte Google Drive."); }
    access = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
    return access.token;
  }
  const g = async (url, opt = {}) => fetch(url, { ...opt, headers: { authorization: `Bearer ${await token()}`, ...(opt.headers || {}) } });

  ipcMain.handle("drive:status", () => status());

  ipcMain.handle("drive:connect", async () => {
    if (MOCK) { const cfg = loadCfg(); cfg.drive = { refresh: seal("mock"), email: "test@exemple.com" }; saveCfg(cfg); return status(); }
    const c = client();
    if (!c) throw new Error("Google Drive n'est pas configuré dans cette version de Reco.");
    const verifier = b64u(crypto.randomBytes(32)), challenge = b64u(crypto.createHash("sha256").update(verifier).digest()), state = b64u(crypto.randomBytes(16));
    const code = await new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        const u = new URL(req.url, "http://127.0.0.1");
        if (!u.searchParams.has("code") && !u.searchParams.has("error")) { res.writeHead(404); return res.end(); }
        const ok = u.searchParams.get("state") === state && u.searchParams.get("code");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;display:grid;place-items:center;height:90vh;color:#0c0a09;background:#fdfdfd"><div style="text-align:center"><h2>${ok ? "C'est bon !" : "Connexion annulée"}</h2><p style="color:#78716c">${ok ? "Tu peux fermer cet onglet et revenir dans Reco." : "Reviens dans Reco pour réessayer."}</p></div>`);
        srv.close(); clearTimeout(timer);
        ok ? resolve({ code: ok, redirect: `http://127.0.0.1:${srv.address()?.port ?? port}` }) : reject(new Error("Connexion à Google annulée."));
      });
      let port;
      const timer = setTimeout(() => { srv.close(); reject(new Error("Délai dépassé pour la connexion Google.")); }, 5 * 60 * 1000);
      srv.listen(0, "127.0.0.1", () => {
        port = srv.address().port;
        const q = new URLSearchParams({ client_id: c.id, redirect_uri: `http://127.0.0.1:${port}`, response_type: "code", scope: SCOPE,
          code_challenge: challenge, code_challenge_method: "S256", access_type: "offline", prompt: "consent", state });
        shell.openExternal(`https://accounts.google.com/o/oauth2/v2/auth?${q}`);
      });
    });
    const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code: code.code, client_id: c.id, client_secret: c.secret, redirect_uri: code.redirect, grant_type: "authorization_code", code_verifier: verifier }) });
    const j = await r.json();
    if (!r.ok || !j.refresh_token) throw new Error(`Google a refusé la connexion (${j.error_description || j.error || r.status}).`);
    access = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
    const me = await (await g("https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)")).json().catch(() => ({}));
    const cfg = loadCfg(); cfg.drive = { refresh: seal(j.refresh_token), email: me?.user?.emailAddress || "" }; saveCfg(cfg);
    win()?.show(); win()?.focus();
    return status();
  });

  ipcMain.handle("drive:disconnect", async () => {
    const cfg = loadCfg(), d = cfg.drive;
    if (d?.refresh && !MOCK) fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(unseal(d.refresh))}`, { method: "POST" }).catch(() => {});
    delete cfg.drive; saveCfg(cfg); access = null;
    return status();
  });

  async function folder() {
    const cfg = loadCfg();
    if (cfg.drive?.folder) {
      const r = await g(`https://www.googleapis.com/drive/v3/files/${cfg.drive.folder}?fields=id,trashed`);
      if (r.ok && !(await r.json()).trashed) return cfg.drive.folder;
    }
    const r = await g("https://www.googleapis.com/drive/v3/files?fields=id", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Reco", mimeType: "application/vnd.google-apps.folder" }) });
    const j = await r.json();
    if (!r.ok) throw new Error(`Création du dossier Drive impossible (${j.error?.message || r.status}).`);
    const c2 = loadCfg(); c2.drive.folder = j.id; saveCfg(c2);
    return j.id;
  }

  ipcMain.handle("drive:share", async (e, id) => {
    const meta = await local.readMeta(id), file = path.join(local.videosDir(), `${meta.id}.${meta.ext}`);
    const size = (await fsp.stat(file)).size, send = (f) => e.sender.send("drive:progress", { id, f });
    let fileId;
    if (MOCK) {
      for (let s = 0; s <= size; s += Math.max(PART, size / 4)) { send(Math.min(1, s / size)); await new Promise((r) => setTimeout(r, 150)); }
      fileId = `mock_${id}`;
    } else {
      const parent = await folder();
      const init = await g("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id", { method: "POST",
        headers: { "content-type": "application/json; charset=UTF-8", "x-upload-content-type": meta.contentType, "x-upload-content-length": String(size) },
        body: JSON.stringify({ name: `${meta.title}.${meta.ext}`, parents: [parent], description: "Enregistré avec Reco" }) });
      if (!init.ok) throw new Error(`Envoi sur Google Drive refusé (${(await init.json().catch(() => ({}))).error?.message || init.status}).`);
      const session = init.headers.get("location");
      const fh = await fsp.open(file, "r");
      try {
        let pos = 0, tries = 0;
        while (pos < size) {
          const len = Math.min(PART, size - pos), buf = Buffer.alloc(len);
          await fh.read(buf, 0, len, pos);
          let r;
          try {
            r = await fetch(session, { method: "PUT", headers: { "content-length": String(len), "content-range": `bytes ${pos}-${pos + len - 1}/${size}` }, body: buf });
          } catch (err) { r = { status: 0 }; }
          if (r.status === 308) { const rg = r.headers.get("range"); pos = rg ? Number(rg.split("-")[1]) + 1 : pos + len; tries = 0; send(pos / size); continue; }
          if (r.status === 200 || r.status === 201) { fileId = (await r.json()).id; pos = size; send(1); break; }
          if (++tries > 6) throw new Error("Envoi interrompu (réseau). Réessaie, l'envoi reprendra du début.");
          await new Promise((res) => setTimeout(res, 1000 * 2 ** tries));
          const q = await fetch(session, { method: "PUT", headers: { "content-length": "0", "content-range": `bytes */${size}` } }).catch(() => null); // où en est Google ?
          if (q && q.status === 308) { const rg = q.headers.get("range"); pos = rg ? Number(rg.split("-")[1]) + 1 : 0; }
          else if (q && (q.status === 200 || q.status === 201)) { fileId = (await q.json()).id; pos = size; }
        }
      } finally { await fh.close(); }
      const p = await g(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions?fields=id`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "reader", type: "anyone" }) });
      if (!p.ok) throw new Error("Vidéo envoyée, mais impossible de la rendre visible avec le lien.");
    }
    const link = `https://drive.google.com/file/d/${fileId}/view?usp=sharing`;
    const m2 = await local.readMeta(id); m2.drive = { id: fileId, link, at: Date.now() };
    return local.writeMeta(m2);
  });
}

module.exports = { register };
