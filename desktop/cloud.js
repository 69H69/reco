// "My Reco server": publish a video from the computer to YOUR Cloudflare server (deployed with the Deploy to Cloudflare button).
// You connect with the server address, your first name and the invite code; the video is uploaded in 8 MB chunks
// through the server API, which returns the share page link (/v/…) with views, seeking and link previews.
const { ipcMain, safeStorage } = require("electron");
const fsp = require("fs/promises");
const fs = require("fs");
const path = require("path");
const local = require("./local");

const PART = 8 * 1024 * 1024; // fixed chunk size (R2 requires all parts but the last to be the same size)
const seal = (s) => (safeStorage.isEncryptionAvailable() ? "enc:" + safeStorage.encryptString(s).toString("base64") : "raw:" + s);
const unseal = (s) => (!s ? "" : s.startsWith("enc:") ? safeStorage.decryptString(Buffer.from(s.slice(4), "base64")) : s.replace(/^raw:/, ""));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function register({ loadCfg, saveCfg }) {
  const status = () => { const c = loadCfg().cloud; return { connected: !!c?.cookie, server: c?.server || "", name: c?.name || "" }; };

  async function call(p, opt = {}) {
    const c = loadCfg().cloud;
    if (!c?.cookie) throw new Error("No Reco server connected.");
    const r = await fetch(c.server + p, { ...opt, headers: { cookie: `reco_session=${unseal(c.cookie)}`, ...(opt.headers || {}) } });
    if (r.status === 401) throw new Error("Session expired: reconnect your Reco server.");
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `Server error (${r.status}).`);
    return d;
  }

  ipcMain.handle("cloud:status", () => status());

  ipcMain.handle("cloud:connect", async (e, { url, name, code }) => {
    let origin;
    try { const u = new URL(/^https?:\/\//.test(url) ? url : `https://${url}`); origin = u.origin; } catch { throw new Error("Invalid server address."); }
    let r;
    try { r = await fetch(`${origin}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, code }) }); }
    catch { throw new Error("No server responds at this address."); }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || (r.status === 404 ? "This is not a Reco server." : `Error ${r.status}.`));
    const cookie = (r.headers.getSetCookie?.() || [r.headers.get("set-cookie") || ""]).join(";").match(/reco_session=([^;]+)/)?.[1];
    if (!cookie) throw new Error("The server did not open a session.");
    const cfg = loadCfg(); cfg.cloud = { server: origin, name: d.name || name, cookie: seal(cookie) }; saveCfg(cfg);
    return status();
  });

  ipcMain.handle("cloud:disconnect", () => { const cfg = loadCfg(); delete cfg.cloud; saveCfg(cfg); return status(); });

  ipcMain.handle("cloud:publish", async (e, id) => {
    const meta = await local.readMeta(id), dir = local.videosDir(), file = path.join(dir, `${meta.id}.${meta.ext}`);
    const size = (await fsp.stat(file)).size, send = (f) => e.sender.send("cloud:progress", { id, f });
    const s = await call("/api/upload/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ext: meta.ext }) });
    const parts = [], fh = await fsp.open(file, "r");
    try {
      for (let pos = 0, n = 1; pos < size || n === 1; pos += PART, n++) {
        const len = Math.min(PART, size - pos), buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, pos);
        for (let a = 0; ; a++) {
          try {
            parts.push(await call(`/api/upload/part?key=${encodeURIComponent(s.key)}&uploadId=${encodeURIComponent(s.uploadId)}&n=${n}`, { method: "PUT", body: buf }));
            break;
          } catch (err) { if (a >= 6 || /Session expired/.test(err.message)) throw err; await sleep(1000 * 2 ** a); }
        }
        send(Math.min(0.97, (pos + len) / size));
        if (pos + len >= size) break;
      }
    } catch (err) {
      call("/api/upload/abort", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: s.key, uploadId: s.uploadId }) }).catch(() => {});
      throw err;
    } finally { await fh.close(); }
    const done = await call("/api/upload/complete", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: s.id, key: s.key, uploadId: s.uploadId, parts, title: meta.title, duration: meta.duration, width: meta.width, height: meta.height, fps: meta.fps }) });
    const thumb = path.join(dir, `${meta.id}.jpg`);
    if (fs.existsSync(thumb)) await call(`/api/thumb/${done.id}`, { method: "PUT", body: await fsp.readFile(thumb) }).catch(() => {});
    send(1);
    const m2 = await local.readMeta(id);
    m2.cloud = { id: done.id, link: `${loadCfg().cloud.server}/v/${done.id}`, at: Date.now() };
    return local.writeMeta(m2);
  });
}

module.exports = { register };
