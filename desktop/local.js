// Bibliothèque locale : les vidéos vivent dans le dossier Vidéos/Reco de l'utilisateur.
// Chaque vidéo = <id>.<ext> + <id>.json (titre, durée…) + <id>.jpg (miniature).
// L'interface est servie par le protocole reco://app/ ; les vidéos par reco://app/media/<fichier> (avec Range).
const { app, protocol, ipcMain, shell } = require("electron");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { Readable } = require("stream");

const ID_RE = /^[A-Za-z0-9]{12}$/;
const TYPES = { mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime" };
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml",
  ".woff2": "font/woff2", ".png": "image/png", ".jpg": "image/jpeg", ".json": "application/json", ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime" };

const uiDir = () => (app.isPackaged ? path.join(__dirname, "ui") : path.join(__dirname, "..", "public"));
function videosDir() {
  const d = process.env.RECO_VIDEOS_DIR || path.join(app.getPath("videos"), "Reco");
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function newId() {
  const a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from(crypto.randomBytes(12), (x) => a[x % 62]).join("");
}

function registerScheme() { // à appeler AVANT app.ready
  protocol.registerSchemesAsPrivileged([{ scheme: "reco", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);
}

async function serveFile(req, file) {
  let st;
  try { st = await fsp.stat(file); } catch { return new Response("Introuvable", { status: 404 }); }
  if (!st.isFile()) return new Response("Introuvable", { status: 404 });
  const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
  const size = st.size, range = req.headers.get("range");
  const base = { "content-type": type, "accept-ranges": "bytes", "cache-control": "no-cache" };
  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/);
    let start = m && m[1] !== "" ? Number(m[1]) : null, end = m && m[2] !== "" ? Number(m[2]) : null;
    if (start === null) { start = Math.max(0, size - (end || 0)); end = size - 1; }
    if (end === null || end >= size) end = size - 1;
    if (!m || start > end) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), { status: 206, headers: { ...base, "content-length": String(end - start + 1), "content-range": `bytes ${start}-${end}/${size}` } });
  }
  return new Response(Readable.toWeb(fs.createReadStream(file)), { headers: { ...base, "content-length": String(size) } });
}

function handleProtocol() {
  protocol.handle("reco", (req) => {
    const u = new URL(req.url);
    let p = decodeURIComponent(u.pathname);
    if (p.startsWith("/media/")) {
      const name = path.basename(p);
      if (!/^[A-Za-z0-9]{12}\.(mp4|webm|mov|jpg)$/.test(name)) return new Response("Introuvable", { status: 404 });
      return serveFile(req, path.join(videosDir(), name));
    }
    if (p === "/" || p === "") p = "/index.html";
    const root = uiDir(), f = path.normalize(path.join(root, p));
    if (!f.startsWith(root)) return new Response("Interdit", { status: 403 });
    return serveFile(req, f);
  });
}

const metaPath = (id) => path.join(videosDir(), `${id}.json`);
async function readMeta(id) {
  if (!ID_RE.test(id)) throw new Error("Vidéo inconnue.");
  return JSON.parse(await fsp.readFile(metaPath(id), "utf8"));
}
function withUrls(meta) {
  const dir = videosDir(), thumb = path.join(dir, `${meta.id}.jpg`);
  const v = fs.existsSync(thumb) ? Math.round(fs.statSync(thumb).mtimeMs) : 0;
  return { ...meta, url: `reco://app/media/${meta.id}.${meta.ext}`, thumbUrl: v ? `reco://app/media/${meta.id}.jpg?v=${v}` : "", path: path.join(dir, `${meta.id}.${meta.ext}`) };
}
async function writeMeta(meta) {
  const { url, thumbUrl, path: _p, ...clean } = meta;
  await fsp.writeFile(metaPath(meta.id), JSON.stringify(clean, null, 2));
  return withUrls(clean);
}

function register({ loadCfg, saveCfg }) {
  const writers = new Map();
  const userName = () => loadCfg().name || (os.userInfo().username || "Moi").replace(/^\w/, (c) => c.toUpperCase());

  ipcMain.handle("local:me", () => ({ name: userName(), folder: videosDir() }));
  ipcMain.handle("local:setName", (e, n) => { const c = loadCfg(); c.name = String(n || "").trim().slice(0, 40); saveCfg(c); return userName(); });

  ipcMain.handle("local:list", async () => {
    const dir = videosDir(), out = [];
    for (const f of await fsp.readdir(dir)) {
      if (!/^[A-Za-z0-9]{12}\.json$/.test(f)) continue;
      try {
        const m = JSON.parse(await fsp.readFile(path.join(dir, f), "utf8"));
        if (fs.existsSync(path.join(dir, `${m.id}.${m.ext}`))) out.push(withUrls(m));
      } catch { /* fichier abîmé : ignoré */ }
    }
    return out.sort((a, b) => b.created - a.created);
  });

  ipcMain.handle("local:start", async (e, ext) => {
    if (!(ext in TYPES)) throw new Error("Format non pris en charge.");
    const id = newId(), file = path.join(videosDir(), `${id}.${ext}.part`);
    writers.set(id, { ext, file, ws: fs.createWriteStream(file) });
    return { id };
  });
  ipcMain.handle("local:chunk", (e, id, buf) => new Promise((ok, ko) => {
    const w = writers.get(id);
    if (!w) return ko(new Error("Enregistrement inconnu."));
    w.ws.write(Buffer.from(buf), (err) => (err ? ko(err) : ok(true)));
  }));
  ipcMain.handle("local:finish", async (e, id, b) => {
    const w = writers.get(id);
    if (!w) throw new Error("Enregistrement inconnu.");
    await new Promise((ok) => w.ws.end(ok));
    writers.delete(id);
    const final = path.join(videosDir(), `${id}.${w.ext}`);
    await fsp.rename(w.file, final);
    const meta = { id, ext: w.ext, contentType: TYPES[w.ext], size: (await fsp.stat(final)).size, title: String(b.title || "Sans titre").slice(0, 120),
      author: userName(), created: Date.now(), duration: Number(b.duration) || 0, width: b.width || null, height: b.height || null };
    return writeMeta(meta);
  });
  ipcMain.handle("local:abort", async (e, id) => {
    const w = writers.get(id);
    if (w) { w.ws.destroy(); writers.delete(id); await fsp.rm(w.file, { force: true }); }
    return true;
  });
  ipcMain.handle("local:thumb", async (e, id, buf) => {
    if (!ID_RE.test(id)) throw new Error("Vidéo inconnue.");
    await fsp.writeFile(path.join(videosDir(), `${id}.jpg`), Buffer.from(buf));
    return withUrls(await readMeta(id));
  });
  ipcMain.handle("local:import", async (e, src, b) => {
    const ext = path.extname(src).slice(1).toLowerCase();
    if (!(ext in TYPES)) throw new Error("Formats acceptés : MP4, WebM, MOV.");
    const id = newId(), final = path.join(videosDir(), `${id}.${ext}`);
    await fsp.copyFile(src, final);
    const meta = { id, ext, contentType: TYPES[ext], size: (await fsp.stat(final)).size, title: String(b.title || path.basename(src, path.extname(src))).slice(0, 120),
      author: userName(), created: Date.now(), duration: Number(b.duration) || 0, width: b.width || null, height: b.height || null };
    return writeMeta(meta);
  });
  ipcMain.handle("local:patch", async (e, id, b) => {
    const meta = await readMeta(id);
    if (b.title) meta.title = String(b.title).trim().slice(0, 120) || meta.title;
    if (b.drive) meta.drive = b.drive;
    meta.updated = Date.now();
    return writeMeta(meta);
  });
  ipcMain.handle("local:delete", async (e, id) => {
    const meta = await readMeta(id), dir = videosDir();
    for (const f of [`${id}.${meta.ext}`, `${id}.jpg`, `${id}.json`]) await fsp.rm(path.join(dir, f), { force: true });
    return true;
  });
  ipcMain.handle("local:reveal", async (e, id) => { const m = await readMeta(id); shell.showItemInFolder(path.join(videosDir(), `${m.id}.${m.ext}`)); return true; });
  ipcMain.handle("local:openFolder", () => shell.openPath(videosDir()));
}

module.exports = { registerScheme, handleProtocol, register, videosDir, readMeta, withUrls, writeMeta };
