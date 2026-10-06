// Reco — appli d'enregistrement (Chrome / Edge sur ordinateur).
const $ = (s) => document.querySelector(s);
const show = (id) => { document.querySelectorAll(".view").forEach((v) => (v.hidden = v.id !== id)); const m = document.getElementById("mtop"); if (m) m.hidden = id !== "v-lib"; };
const toast = (t) => { const el = $("#toast"); el.textContent = t; el.classList.add("on"); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove("on"), 2200); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtDur = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const fmtDur2 = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const RTF = new Intl.RelativeTimeFormat("fr", { numeric: "auto" });
function ago(t) { const s = (t - Date.now()) / 1000, a = Math.abs(s); for (const [u, n] of [["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]]) if (a >= n) return RTF.format(Math.round(s / n), u); return "à l'instant"; }
const fmtSize = (b) => (b >= 1e9 ? `${+(b / 1e9).toFixed(2)} Go`.replace(".", ",") : `${Math.round(b / 1e6)} Mo`);
const errMsg = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const TEST = new URLSearchParams(location.search).has("fakeScreen"); // tests automatisés : écran factice
const PART = 8 * 1024 * 1024;          // taille fixe des morceaux envoyés
const LOCAL_MAX = 600 * 1024 * 1024;   // au-delà, on ne garde plus de copie locale (la vidéo est déjà en ligne)

async function api(path, body, method) {
  const r = await fetch(path, { method: method || (body ? "POST" : "GET"), headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error || `Erreur ${r.status}`), { status: r.status });
  return d;
}

// ───────── envoi par morceaux (pendant l'enregistrement ou pour un import) ─────────
class Uploader {
  constructor(ext) { this.ext = ext; this.parts = []; this.pending = []; this.pendingSize = 0; this.busy = null; this.n = 0; this.sent = 0; this.aborted = false; }
  async start() { Object.assign(this, await api("/api/upload/start", { ext: this.ext })); return this; }
  push(blob) { this.pending.push(blob); this.pendingSize += blob.size; this.pump(); }
  pump() {
    if (this.busy || this.aborted || this.pendingSize < PART) return;
    this.busy = this.sendNext(false).catch((e) => (this.error = e)).finally(() => { this.busy = null; this.pump(); });
  }
  async sendNext(last) {
    const all = new Blob(this.pending), size = last ? all.size : PART;
    const part = all.slice(0, size), rest = all.slice(size);
    this.pending = rest.size ? [rest] : []; this.pendingSize = rest.size;
    const n = ++this.n;
    for (let a = 0; ; a++) {
      if (this.aborted) throw new Error("Envoi annulé");
      try {
        const r = await fetch(`/api/upload/part?key=${encodeURIComponent(this.key)}&uploadId=${encodeURIComponent(this.uploadId)}&n=${n}`, { method: "PUT", body: part });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Erreur ${r.status}`);
        this.parts.push(await r.json()); this.sent += part.size; this.onprogress?.(); return;
      } catch (e) { if (a >= 8) throw e; await sleep(Math.min(15000, 1000 * 2 ** a)); }
    }
  }
  async finish(meta) {
    while (this.busy) await this.busy;
    if (this.error) throw this.error;
    while (this.pendingSize >= PART) await this.sendNext(false);
    if (this.pendingSize > 0 || !this.parts.length) await this.sendNext(true);
    return api("/api/upload/complete", { id: this.id, key: this.key, uploadId: this.uploadId, parts: this.parts, ...meta });
  }
  abort() { this.aborted = true; if (this.uploadId) api("/api/upload/abort", { key: this.key, uploadId: this.uploadId }).catch(() => {}); }
}

// ───────── mode local (appli de bureau) : vidéos sur le PC, partage par Google Drive ─────────
const LOCAL = !!(window.recoDesktop && window.recoDesktop.local);
const L = LOCAL ? window.recoDesktop.lib : null, D = LOCAL ? window.recoDesktop.drive : null, C = LOCAL ? window.recoDesktop.cloud : null;
class LocalWriter { // même interface que Uploader, mais écrit dans Vidéos/Reco pendant l'enregistrement
  constructor(ext) { this.ext = ext; this.sent = 0; this.pendingSize = 0; this.q = Promise.resolve(); }
  async start() { Object.assign(this, await L.start(this.ext)); return this; }
  push(blob) {
    this.pendingSize += blob.size;
    this.q = this.q.then(async () => { if (this.aborted) return; await L.chunk(this.id, await blob.arrayBuffer()); this.sent += blob.size; this.pendingSize -= blob.size; this.onprogress?.(); }).catch((e) => (this.error = e));
  }
  async finish(meta) { await this.q; if (this.error) throw this.error; return L.finish(this.id, meta); }
  abort() { this.aborted = true; if (this.id) L.abort(this.id).catch(() => {}); }
}
const Writer = LOCAL ? LocalWriter : Uploader;
const thumbOf = (v) => (LOCAL ? v.thumbUrl : `/t/${v.id}`);
const fileOf = (v) => (LOCAL ? v.url : `/f/${v.id}`);
const linkOf = (v) => (LOCAL ? v.cloud?.link || v.drive?.link || "" : `${location.origin}/v/${v.id}`);
async function saveThumb(meta, blob) {
  if (!blob) return meta;
  if (LOCAL) return L.thumb(meta.id, await blob.arrayBuffer());
  await fetch(`/api/thumb/${meta.id}`, { method: "PUT", body: blob }); return meta;
}
const patchVideo = (id, body) => (LOCAL ? L.patch(id, body) : api(`/api/videos/${id}`, body, "PATCH"));
const deleteVideo = (id) => (LOCAL ? L.del(id) : api(`/api/videos/${id}`, null, "DELETE"));
async function renderDrive() {
  const el = $("#drive-st"); if (!el || !LOCAL) return;
  const s = await D.status(); el.hidden = false;
  el.innerHTML = s.connected ? `<span class="gd on"></span><span class="gdt">Google Drive<small>${esc(s.email)}</small></span><button class="link" id="gd-x">Déconnecter</button>`
    : s.configured ? `<span class="gd"></span><span class="gdt">Google Drive<small>non connecté</small></span><button class="link" id="gd-c">Connecter</button>`
    : `<span class="gd"></span><span class="gdt">Google Drive<small>non configuré</small></span>`;
  $("#gd-x")?.addEventListener("click", async () => { if (confirm("Déconnecter Google Drive ? Les liens déjà partagés continuent de marcher.")) { await D.disconnect(); renderDrive(); } });
  $("#gd-c")?.addEventListener("click", async () => { try { await D.connect(); } catch (e) { toast(errMsg(e)); } renderDrive(); });
}
// ── « Mon serveur Reco » (Cloudflare de l'utilisateur) ──
async function renderCloud() {
  const el = $("#cloud-st"); if (!el || !LOCAL) return;
  const s = await C.status(); el.hidden = false;
  el.innerHTML = s.connected ? `<span class="gd on"></span><span class="gdt">Serveur Reco<small>${esc(s.server.replace(/^https?:\/\//, ""))}</small></span><button class="link" id="cl-x">Déconnecter</button>`
    : `<span class="gd"></span><span class="gdt">Serveur Reco<small>non connecté</small></span><button class="link" id="cl-c">Connecter</button>`;
  $("#cl-x")?.addEventListener("click", async () => { if (confirm("Déconnecter ton serveur Reco ? Les liens déjà publiés continuent de marcher.")) { await C.disconnect(); renderCloud(); } });
  $("#cl-c")?.addEventListener("click", () => connectCloud());
  return s;
}
function connectCloud() { // fenêtre de connexion ; résout true si connecté
  return new Promise((resolve) => {
    const d = $("#d-cloud"); let done = false; $("#c-err").textContent = ""; if (!$("#c-name").value && me) $("#c-name").value = me.name;
    d.showModal();
    $("#f-cloud").onsubmit = async (e) => {
      if (e.submitter?.value !== "ok") return;
      e.preventDefault(); $("#c-go").disabled = true; $("#c-err").textContent = "";
      try { await C.connect({ url: $("#c-url").value.trim(), name: $("#c-name").value.trim(), code: $("#c-code").value }); $("#c-code").value = ""; done = true; resolve(true); d.close(); renderCloud(); toast("Serveur connecté"); }
      catch (err) { $("#c-err").textContent = errMsg(err); }
      finally { $("#c-go").disabled = false; }
    };
    d.onclose = () => { if (!done) resolve(false); };
  });
}
async function publishCloud() {
  if (!X?.meta) return;
  if (!(await C.status()).connected && !(await connectCloud())) return;
  $("#x-err").textContent = ""; $("#x-cshare").disabled = true;
  try {
    setProgress(0, "Publication sur ton serveur");
    const meta = await C.publish(X.meta.id);
    uploaded(meta, true);
    await navigator.clipboard.writeText(meta.cloud.link).then(() => toast("Lien copié"), () => {});
  } catch (err) { $("#x-prog").hidden = true; $("#x-status").textContent = ""; $("#x-err").textContent = errMsg(err); }
  finally { $("#x-cshare").disabled = false; }
}
if (LOCAL) C.onProgress(({ id, f }) => { if (X?.meta?.id === id) setProgress(f, "Publication sur ton serveur"); });
if (LOCAL) D.onProgress(({ id, f }) => { if (X?.meta?.id === id) setProgress(f, "Envoi sur Google Drive"); });
async function shareDrive() {
  if (!X?.meta) return;
  const s = await D.status();
  if (!s.configured) { $("#x-err").textContent = "Google Drive n'est pas configuré dans cette version de Reco."; return; }
  $("#x-err").textContent = ""; $("#x-gshare").disabled = true;
  try {
    if (!s.connected) { $("#x-status").textContent = "Connexion à Google… (ton navigateur s'ouvre)"; await D.connect(); renderDrive(); }
    setProgress(0, "Envoi sur Google Drive");
    const meta = await D.share(X.meta.id);
    uploaded(meta, true);
    await navigator.clipboard.writeText(meta.drive.link).then(() => toast("Lien Google Drive copié"), () => {});
    $("#x-status").textContent = "✓ Partagée sur Google Drive (Google peut mettre quelques minutes à préparer la lecture)";
  } catch (err) { $("#x-prog").hidden = true; $("#x-status").textContent = ""; $("#x-err").textContent = errMsg(err); }
  finally { $("#x-gshare").disabled = false; }
}

// ───────── connexion & bibliothèque ─────────
let me = null;
async function boot() {
  if (!window.recoDesktop) $("#dl-app").hidden = false;
  if (!("MediaStreamTrackProcessor" in window)) document.body.insertAdjacentHTML("afterbegin", '<div class="warn">Pour enregistrer, ouvre Reco dans <b>Chrome</b> ou <b>Edge</b> sur ordinateur.</div>');
  if (LOCAL) {
    me = await L.me();
    $("#shell").hidden = false;
    $("#ws-name").textContent = `Espace de ${me.name}`;
    $("#who").innerHTML = `<span class="av">${esc(me.name.slice(0, 1).toUpperCase())}</span><span class="nm edit" id="b-name" title="Changer ton prénom">${esc(me.name)}</span><button class="link" id="b-folder" title="${esc(me.folder)}">Dossier</button>`;
    $("#b-folder").onclick = () => L.openFolder();
    $("#b-name").onclick = async () => { const n = prompt("Ton prénom", me.name); if (n && n.trim()) { await L.setName(n); boot(); } };
    $('#nav [data-f="all"]').hidden = true;
    renderDrive(); renderCloud();
    return loadLib();
  }
  try { me = await api("/api/me"); } catch { me = null; }
  if (!me) { $("#shell").hidden = true; show("v-login"); return; }
  $("#shell").hidden = false;
  $("#ws-name").textContent = `Espace de ${me.name}`;
  $("#who").innerHTML = `<span class="av">${esc(me.name.slice(0, 1).toUpperCase())}</span><span class="nm">${esc(me.name)}</span><button class="link" id="b-out">Déconnexion</button>`;
  $("#b-out").onclick = async () => { await api("/api/logout", {}); location.reload(); };
  loadLib();
}
$("#f-login").onsubmit = async (e) => {
  e.preventDefault(); $("#l-err").textContent = "";
  try { await api("/api/login", { name: $("#l-name").value, code: $("#l-code").value }); boot(); } catch (err) { $("#l-err").textContent = errMsg(err); }
};

let lib = [], LF = "mine";
const isMine = (v) => LOCAL || v.author.toLowerCase() === me.name.toLowerCase();
const IC = {
  link: '<svg viewBox="0 0 24 24"><path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/></svg>',
  del: '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/></svg>',
  share: '<svg viewBox="0 0 24 24"><path d="M12 15V4M7.5 8.5L12 4l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 13v5.5A1.5 1.5 0 006.5 20h11a1.5 1.5 0 001.5-1.5V13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>',
  folder: '<svg viewBox="0 0 24 24"><path d="M3.5 7.5A1.5 1.5 0 015 6h4l2 2h8a1.5 1.5 0 011.5 1.5v8A1.5 1.5 0 0119 19H5a1.5 1.5 0 01-1.5-1.5z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/></svg>',
};
async function loadLib() {
  show("v-lib");
  if (LOCAL) {
    lib = await L.list();
    const used = lib.reduce((s, v) => s + (v.size || 0), 0);
    $("#quota").textContent = `${fmtSize(used)} sur ton PC`;
    $("#c-mine").textContent = lib.length;
    return renderLib();
  }
  const { videos, used, quota } = await api("/api/videos");
  lib = videos;
  $("#quota").textContent = `${fmtSize(used)} utilisés sur ${fmtSize(quota)}`;
  $("#c-mine").textContent = videos.filter(isMine).length; $("#c-all").textContent = videos.length;
  renderLib();
}
function renderLib() {
  const q = $("#q").value.trim().toLowerCase(), sort = $("#sort").value;
  let list = lib.filter((v) => (LF === "all" || isMine(v)) && (!q || v.title.toLowerCase().includes(q) || v.author.toLowerCase().includes(q)));
  const by = { new: (a, b) => (b.updated || b.created) - (a.updated || a.created), old: (a, b) => a.created - b.created, views: (a, b) => (b.views || 0) - (a.views || 0), title: (a, b) => a.title.localeCompare(b.title, "fr") };
  list.sort(by[sort]);
  document.querySelectorAll("#nav button").forEach((b) => b.classList.toggle("on", b.dataset.f === LF));
  $("#lib-title").textContent = LF === "all" ? "Vidéos de l'espace" : "Mes vidéos";
  $("#lib-count").textContent = list.length;
  $("#empty").hidden = list.length > 0;
  $("#grid").innerHTML = list.map((v) => {
    const dur = (v.trimEnd || v.duration || 0) - (v.trimStart || 0), mine = isMine(v);
    const when = v.updated ? `Modifiée ${ago(v.updated)}` : `Créée ${ago(v.created)}`;
    return `<article class="vc" data-id="${v.id}">
      <div class="thw"><a ${LOCAL ? 'href="#" data-act="open"' : `href="/v/${v.id}" target="_blank"`} class="th"><span class="fr"><img src="${thumbOf(v)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'"></span>${dur > 0 ? `<span class="d">${fmtDur2(dur)}</span>` : ""}</a>
        <div class="hov">${LOCAL && !v.drive && !v.cloud ? `<button data-act="share" title="Partager">${IC.share}</button>` : `<button data-act="copy" title="Copier le lien">${IC.link}</button>`}${LOCAL ? `<button data-act="reveal" title="Afficher dans le dossier">${IC.folder}</button>` : ""}${mine ? `<button data-act="edit" title="Modifier">${IC.edit}</button><button data-act="del" title="Supprimer">${IC.del}</button>` : ""}</div></div>
      <div class="vi"><b title="${esc(v.title)}">${esc(v.title)}</b><span class="muted">${LF === "all" ? esc(v.author) + " · " : ""}${when}${v.views ? ` · ${v.views} vue${v.views > 1 ? "s" : ""}` : ""}${LOCAL && v.cloud ? " · En ligne" : LOCAL && v.drive ? " · Sur Drive" : ""}</span></div>
    </article>`;
  }).join("");
}
$("#q").oninput = renderLib;
$("#sort").onchange = renderLib;
$("#nav").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; LF = b.dataset.f; show("v-lib"); renderLib(); };
$("#grid").onclick = async (e) => {
  const b = e.target.closest("[data-act]"); if (!b) return;
  e.preventDefault();
  const id = b.closest(".vc").dataset.id;
  const v = lib.find((x) => x.id === id);
  if (b.dataset.act === "copy") { await navigator.clipboard.writeText(linkOf(v)); toast("Lien copié"); }
  if (b.dataset.act === "edit" || b.dataset.act === "open") openReview({ meta: v });
  if (b.dataset.act === "share") openReview({ meta: v }); // l'écran vidéo propose : mon serveur ou Google Drive
  if (b.dataset.act === "reveal") L.reveal(id);
  if (b.dataset.act === "del" && confirm(LOCAL ? "Supprimer définitivement cette vidéo de ton PC ?" : "Supprimer définitivement cette vidéo ? Le lien ne marchera plus.")) { await deleteVideo(id); loadLib(); }
};

// ───────── import d'une vidéo existante (export de Cap, OBS…) ─────────
$("#b-import").onclick = () => $("#f-import").click();
$("#f-import").onchange = async (e) => {
  const file = e.target.files[0]; e.target.value = "";
  if (!file) return;
  const ext = { "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov" }[file.type] || (file.name.match(/\.(mp4|webm|mov)$/i) || [])[1]?.toLowerCase();
  if (!ext) return toast("Formats acceptés : MP4, WebM, MOV");
  const url = URL.createObjectURL(file);
  const info = await probe(url).catch(() => ({ duration: 0, w: null, h: null, thumb: null }));
  if (LOCAL) { // copie dans le dossier Vidéos/Reco
    openReview({ localUrl: url, title: file.name.replace(/\.[^.]+$/, ""), duration: info.duration });
    setProgress(0.5, "Copie dans ton dossier");
    try { const meta = await L.importFile(file, { title: $("#x-title").value, duration: info.duration, width: info.w, height: info.h }); uploaded(await saveThumb(meta, info.thumb)); }
    catch (err) { uploadFailed(err); }
    return;
  }
  const up = new Uploader(ext);
  openReview({ localUrl: url, title: file.name.replace(/\.[^.]+$/, ""), duration: info.duration }); X.up = up;
  try {
    await up.start();
    up.onprogress = () => setProgress(up.sent / file.size, "Envoi");
    up.push(file);
    const meta = await up.finish({ title: $("#x-title").value, duration: info.duration, width: info.w, height: info.h });
    if (info.thumb) await fetch(`/api/thumb/${meta.id}`, { method: "PUT", body: info.thumb });
    uploaded(meta);
  } catch (err) { uploadFailed(err, up); }
};
function probe(url) { // durée, taille et miniature d'une vidéo locale
  return new Promise((ok, ko) => {
    const v = document.createElement("video"); v.muted = true; v.preload = "auto"; v.src = url;
    v.onerror = () => ko(new Error("vidéo illisible"));
    v.onloadedmetadata = () => { v.currentTime = Math.min(1, (v.duration || 2) / 3); };
    v.onseeked = () => {
      const c = document.createElement("canvas"); c.width = 640; c.height = Math.round(640 * v.videoHeight / v.videoWidth) || 360;
      c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
      c.toBlob((b) => ok({ duration: isFinite(v.duration) ? v.duration : 0, w: v.videoWidth, h: v.videoHeight, thumb: b }), "image/jpeg", 0.82);
    };
  });
}

// ───────── préparation ─────────
const S = { mode: "screen+cam", corner: "bl", sys: true, shape: "square" };
let R = null; // session d'enregistrement

$("#b-new").onclick = async () => {
  show("v-setup"); $("#s-err").textContent = ""; $("#b-go").hidden = true; $("#pip-hint").hidden = true; $("#prev-hint").hidden = false;
  try { const t = await navigator.mediaDevices.getUserMedia({ video: true, audio: true }).catch(() => navigator.mediaDevices.getUserMedia({ audio: true })); t.getTracks().forEach((x) => x.stop()); } catch {}
  const devs = await navigator.mediaDevices.enumerateDevices();
  const opt = (d, i, k) => `<option value="${d.deviceId}">${esc(d.label || `${k} ${i + 1}`)}</option>`;
  $("#s-cam").innerHTML = devs.filter((d) => d.kind === "videoinput").map((d, i) => opt(d, i, "Caméra")).join("");
  $("#s-mic").innerHTML = devs.filter((d) => d.kind === "audioinput").map((d, i) => opt(d, i, "Micro")).join("") + '<option value="none">Aucun micro</option>';
  refreshSetup();
};
$("#b-cancel").onclick = () => { cleanup(); loadLib(); };
$("#modes").onclick = (e) => { const b = e.target.closest(".mode"); if (b) { S.mode = b.dataset.mode; refreshSetup(); } };
$("#corners").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; S.corner = b.dataset.c; refreshSetup(); R?.worker?.postMessage({ type: "cfg", cfg: { corner: S.corner } }); };
$("#c-sys").onchange = (e) => (S.sys = e.target.checked);
$("#shapes").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; S.shape = b.dataset.s; refreshSetup(); R?.worker?.postMessage({ type: "cfg", cfg: { shape: S.shape } }); };
function refreshSetup() {
  document.querySelectorAll(".mode").forEach((b) => b.classList.toggle("on", b.dataset.mode === S.mode));
  document.querySelectorAll("#corners button").forEach((b) => b.classList.toggle("on", b.dataset.c === S.corner));
  document.querySelectorAll("#shapes button").forEach((b) => b.classList.toggle("on", b.dataset.s === S.shape));
  $("#lab-cam").hidden = S.mode === "screen"; $("#lab-sys").hidden = S.mode === "cam"; $("#lab-corner").hidden = S.mode !== "screen+cam";
  $("#b-prepare").textContent = S.mode === "cam" ? "Préparer la caméra" : "Choisir l'écran et préparer";
}
function fakeScreen() {
  if (new URLSearchParams(location.search).get("fakeScreen") === "demo") return demoScreen();
  const c = document.createElement("canvas"); c.width = 1920; c.height = 1080; const g = c.getContext("2d"); let n = 0;
  (function loop() { // contenu chargé (bruit) pour un débit réaliste
    n++; g.fillStyle = `hsl(${n % 360},60%,40%)`; g.fillRect(0, 0, 1920, 1080);
    for (let i = 0; i < 400; i++) { g.fillStyle = `hsl(${(i * 37 + n * 7) % 360},70%,${30 + ((i * 13 + n) % 40)}%)`; g.fillRect((i * 97 + n * 13) % 1920, (i * 53 + n * 7) % 1080, 60, 40); }
    g.fillStyle = "#fff"; g.font = "bold 120px sans-serif"; g.fillText(`ÉCRAN TEST ${n}`, 200, 560); requestAnimationFrame(loop); })();
  return c.captureStream(30);
}

function demoScreen() { // faux écran présentable (captures du README)
  const c = document.createElement("canvas"); c.width = 1920; c.height = 1080; const g = c.getContext("2d"); let n = 0;
  (function loop() {
    n++; const gr = g.createLinearGradient(0, 0, 1920, 1080); gr.addColorStop(0, "#1c2340"); gr.addColorStop(1, "#3b1d4a"); g.fillStyle = gr; g.fillRect(0, 0, 1920, 1080);
    g.fillStyle = "rgba(255,255,255,.06)"; g.fillRect(0, 0, 1920, 70); g.fillStyle = "#fff"; g.font = "600 30px system-ui"; g.fillText("Tableau de bord", 60, 46);
    g.font = "800 92px system-ui"; g.fillText("Lancement de la v2", 120, 260);
    g.font = "400 38px system-ui"; g.fillStyle = "rgba(255,255,255,.75)"; g.fillText("Ce qui change, en 3 minutes", 124, 330);
    [["Inscriptions", "+38 %"], ["Rétention", "92 %"], ["Temps de chargement", "0,8 s"]].forEach(([k, v], i) => {
      const x = 120 + i * 560; g.fillStyle = "rgba(255,255,255,.08)"; g.fillRect(x, 420, 500, 260); g.fillStyle = "rgba(255,255,255,.7)"; g.font = "500 32px system-ui"; g.fillText(k, x + 40, 490);
      g.fillStyle = "#ffb547"; g.font = "800 96px system-ui"; g.fillText(v, x + 40, 610); });
    g.strokeStyle = "#ffb547"; g.lineWidth = 6; g.beginPath(); for (let i = 0; i <= 60; i++) { const x = 120 + i * 28, y = 900 - 120 * Math.sin((i + n / 6) / 9) - i * 2; i ? g.lineTo(x, y) : g.moveTo(x, y); } g.stroke();
    requestAnimationFrame(loop); })();
  return c.captureStream(30);
}

$("#b-prepare").onclick = async () => {
  $("#s-err").textContent = ""; cleanup();
  R = { chunks: [], localSize: 0, paused: false, pausedMs: 0 };
  try {
    if (S.mode !== "cam") {
      R.display = TEST ? fakeScreen() : await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: S.sys, selfBrowserSurface: "exclude", surfaceSwitching: "include", systemAudio: "include" });
      R.display.getVideoTracks()[0].addEventListener("ended", () => { if (R?.rec && R.rec.state !== "inactive") stopRec(); });
    }
    if (S.mode !== "screen") R.cam = await navigator.mediaDevices.getUserMedia({ video: { deviceId: $("#s-cam").value ? { exact: $("#s-cam").value } : undefined, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } });
    if ($("#s-mic").value !== "none") R.mic = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: $("#s-mic").value ? { exact: $("#s-mic").value } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (err) {
    $("#s-err").textContent = err.name === "NotAllowedError" ? "Partage refusé. Réessaie et autorise l'écran, la caméra ou le micro." : `Impossible de démarrer : ${errMsg(err)}`;
    cleanup(); return;
  }
  let w = 1280, h = 720;
  if (R.display) { const st = R.display.getVideoTracks()[0].getSettings(); const s = Math.min(1, 1920 / (st.width || 1920), 1080 / (st.height || 1080)); w = Math.round((st.width || 1920) * s / 2) * 2; h = Math.round((st.height || 1080) * s / 2) * 2; }
  R.size = { w, h };
  R.worker = new Worker("/comp.js");
  const gen = new MediaStreamTrackGenerator({ kind: "video" });
  const msg = { type: "start", cfg: { w, h, mode: S.mode, corner: S.corner, shape: S.shape, bubble: true, big: false, hasCam: !!R.cam }, out: gen.writable }, tr = [gen.writable];
  if (R.display) { msg.screen = new MediaStreamTrackProcessor({ track: R.display.getVideoTracks()[0] }).readable; tr.push(msg.screen); }
  if (R.cam) { msg.cam = new MediaStreamTrackProcessor({ track: R.cam.getVideoTracks()[0] }).readable; tr.push(msg.cam); }
  R.worker.onmessage = (e) => { if (e.data.type === "thumb") R.thumb = e.data.blob; if (e.data.type === "error") console.warn("compositeur", e.data.message); };
  R.worker.postMessage(msg, tr);
  R.video = gen;
  const aTracks = [...(R.mic?.getAudioTracks() || []), ...(R.display?.getAudioTracks() || [])];
  if (aTracks.length > 1) { R.ac = new AudioContext(); const dst = R.ac.createMediaStreamDestination(); aTracks.forEach((t) => R.ac.createMediaStreamSource(new MediaStream([t])).connect(dst)); R.audio = dst.stream.getAudioTracks()[0]; }
  else R.audio = aTracks[0] || null;
  $("#pv").srcObject = new MediaStream([gen]);
  $("#prev-hint").hidden = true; $("#b-go").hidden = false; $("#pip-hint").hidden = !(DESKTOP || "documentPictureInPicture" in window);
};

// ───────── enregistrement ─────────
function pickMime() {
  for (const m of ["video/mp4;codecs=avc1.640028,mp4a.40.2", "video/mp4;codecs=avc1,mp4a", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"])
    if (MediaRecorder.isTypeSupported(m)) return m;
  return "";
}
const elapsed = () => { if (!R?.t0) return 0; const now = R.paused ? R.pauseAt : performance.now(); return (now - R.t0 - R.pausedMs) / 1000; };

$("#b-go").onclick = async () => {
  await openPip(); // demande un clic : on l'ouvre tout de suite
  R.mime = pickMime();
  const ext = R.mime.includes("mp4") ? "mp4" : "webm";
  R.up = await new Writer(ext).start().catch(() => null); // serveur : envoi pendant l'enregistrement ; local : écriture sur le disque
  show("v-rec"); $("#rv").srcObject = new MediaStream([R.video]);
  const c = $("#count"); c.hidden = false;
  for (const n of [3, 2, 1]) { c.textContent = n; pipCount(n); await sleep(800); }
  c.hidden = true; pipCount(null);
  R.rec = new MediaRecorder(new MediaStream([R.video, ...(R.audio ? [R.audio] : [])]), { mimeType: R.mime, videoBitsPerSecond: 4_500_000, audioBitsPerSecond: 128_000 });
  R.rec.ondataavailable = (e) => {
    if (!e.data.size) return;
    if (LOCAL && R.up) { R.localDropped = true; R.localSize += e.data.size; } // déjà sur le disque : pas de copie en mémoire
    else if (R.localSize + e.data.size <= LOCAL_MAX) { R.chunks.push(e.data); R.localSize += e.data.size; } else if (R.up) { R.chunks = []; R.localDropped = true; }
    R.up?.push(e.data);
  };
  R.rec.onstop = onStopped;
  R.rec.start(1000); R.t0 = performance.now();
  if (DESKTOP && S.mode !== "cam") window.recoDesktop.recording(true); // la fenêtre principale se range
  R.tick = setInterval(tick, 250); tick();
};
function tick() { const t = fmtDur(elapsed()); $("#r-time").textContent = t; if (R?.pip) R.pip.document.getElementById("t").textContent = t; }
function togglePause() {
  if (!R?.rec) return;
  if (R.rec.state === "recording") { R.rec.pause(); R.paused = true; R.pauseAt = performance.now(); }
  else if (R.rec.state === "paused") { R.rec.resume(); R.pausedMs += performance.now() - R.pauseAt; R.paused = false; }
  const label = R.paused ? "Reprendre" : "Pause";
  $("#r-pause").textContent = label; if (R.pip) { R.pip.document.getElementById("p").textContent = label; R.pip.document.body.classList.toggle("paused", R.paused); }
}
$("#r-pause").onclick = togglePause;
$("#r-stop").onclick = () => stopRec();
function stopRec() { if (R?.rec && R.rec.state !== "inactive") { R.duration = elapsed(); R.rec.stop(); } }

// ───────── mini-fenêtre flottante (Document Picture-in-Picture) ─────────
const DESKTOP = !!window.recoDesktop; // dans l'appli de bureau (Electron)
async function openPip() {
  if (!DESKTOP && !("documentPictureInPicture" in window)) return;
  try {
    // appli de bureau : vraie fenêtre système toujours au premier plan, invisible dans la vidéo ; navigateur : Document PiP
    const w = DESKTOP ? window.open("", "reco-pip", `width=270,height=${R.cam ? 350 : 170}`) : await documentPictureInPicture.requestWindow({ width: 260, height: R.cam ? 330 : 150 });
    if (!w) return;
    w.document.title = "Reco";
    R.pip = w;
    w.document.head.innerHTML = `<style>
      body{margin:0;background:#1c1917;color:#fafaf9;font-family:Inter,-apple-system,"Segoe UI",sans-serif;display:flex;flex-direction:column;align-items:center;gap:10px;padding:12px;box-sizing:border-box;height:100vh}
      video{width:170px;height:170px;border-radius:${S.shape === "circle" ? "50%" : "38px"};object-fit:cover;transform:scaleX(-1);background:#000;box-shadow:0 0 0 2px rgba(255,255,255,.9)}
      .bar{display:flex;align-items:center;gap:8px;font:600 22px Inter,system-ui;font-variant-numeric:tabular-nums}.dot{width:10px;height:10px;border-radius:50%;background:#e11d48}
      body.paused .dot{background:#a8a29e}.btns{display:flex;gap:8px;width:100%}
      button{flex:1;border:0;border-radius:999px;padding:10px 0;font:600 14px Inter,system-ui;cursor:pointer;background:#44403c;color:#fff}
      button:hover{background:#57534e}button.stop{background:#e11d48}button.stop:hover{background:#be123c}
      .mini{display:flex;gap:6px;width:100%}.mini button{padding:6px 0;font-size:12px;background:#292524}
      .count{position:fixed;inset:0;display:none;align-items:center;justify-content:center;font:700 90px Inter,system-ui;color:#b1aafc;background:rgba(28,25,23,.9)}</style>`;
    w.document.body.innerHTML = `${R.cam ? '<video id="v" autoplay muted playsinline></video>' : ""}
      <div class="bar"><span class="dot"></span><span id="t">0:00</span></div>
      <div class="btns"><button id="p">Pause</button><button class="stop" id="s">Stop</button></div>
      ${S.mode === "screen+cam" ? '<div class="mini"><button id="hb">Masquer bulle</button><button id="sz">Grande bulle</button><button id="mv">Déplacer</button></div>' : ""}
      <div class="count" id="c"></div>`;
    if (R.cam) w.document.getElementById("v").srcObject = R.cam;
    w.document.getElementById("p").onclick = togglePause;
    w.document.getElementById("s").onclick = () => stopRec();
    const send = (cfg) => R.worker.postMessage({ type: "cfg", cfg });
    if (S.mode === "screen+cam") {
      let bubble = true, big = false; const order = ["bl", "br", "tr", "tl"];
      w.document.getElementById("hb").onclick = (e) => { bubble = !bubble; e.target.textContent = bubble ? "Masquer bulle" : "Afficher bulle"; send({ bubble }); };
      w.document.getElementById("sz").onclick = (e) => { big = !big; e.target.textContent = big ? "Petite bulle" : "Grande bulle"; send({ big }); };
      w.document.getElementById("mv").onclick = () => { S.corner = order[(order.indexOf(S.corner) + 1) % 4]; send({ corner: S.corner }); };
    }
    w.addEventListener("pagehide", () => { if (R) R.pip = null; });
  } catch (err) { console.warn("Mini-fenêtre indisponible", err); }
}
function pipCount(n) { const c = R?.pip?.document.getElementById("c"); if (c) { c.style.display = n ? "flex" : "none"; c.textContent = n || ""; } }

// ───────── fin d'enregistrement : finalisation de l'envoi ─────────
async function onStopped() {
  clearInterval(R.tick); R.pip?.close(); stopTracks();
  if (DESKTOP) window.recoDesktop.recording(false);
  const type = R.mime.split(";")[0] || "video/webm", rec = R;
  const localUrl = rec.localDropped ? null : URL.createObjectURL(new Blob(rec.chunks, { type }));
  const title = `Enregistrement du ${new Date().toLocaleDateString("fr-FR", { day: "numeric", month: "short" })} à ${new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`;
  openReview({ localUrl, title, duration: rec.duration, download: localUrl });
  let up = rec.up; X.up = up;
  try {
    if (!up) { up = X.up = await new Writer(type.includes("mp4") ? "mp4" : "webm").start(); up.push(new Blob(rec.chunks, { type })); }
    const total = up.sent + up.pendingSize, label = LOCAL ? "Enregistrement sur ton PC" : "Finalisation de l'envoi";
    up.onprogress = () => setProgress(up.sent / Math.max(total, 1), label);
    setProgress(up.sent / Math.max(total, 1), label);
    const meta = await up.finish({ title: $("#x-title").value, duration: rec.duration, width: rec.size.w, height: rec.size.h });
    uploaded(await saveThumb(meta, rec.thumb));
  } catch (err) { uploadFailed(err, up); }
}

// ───────── écran « vidéo » : envoi, lien, titre, découpe ─────────
let X = null; // vidéo affichée
function openReview({ meta = null, localUrl = null, title = "", duration = 0, download = null }) {
  show("v-review");
  X = { meta, duration: meta?.duration || duration || 0, download, localUrl };
  if (localUrl || meta) $("#xv").src = localUrl || fileOf(meta); else $("#xv").removeAttribute("src");
  $("#x-gshare").hidden = true; $("#x-cshare").hidden = true; $("#x-reveal").hidden = true;
  $("#x-title").value = meta?.title || title;
  $("#x-err").textContent = ""; $("#x-dl").hidden = !download;
  if (meta) uploaded(meta, true); else { $("#x-share").hidden = true; $("#x-trim").hidden = true; $("#x-done").disabled = true; setProgress(0, "Envoi"); }
}
function setProgress(f, label) {
  $("#x-prog").hidden = false; $("#x-bar").style.width = `${Math.round(Math.min(1, f) * 100)}%`;
  $("#x-status").textContent = `${label}… ${Math.round(Math.min(1, f) * 100)} %`;
}
function uploaded(meta, silent) {
  X.meta = meta; X.duration = meta.duration || X.duration;
  if (LOCAL) {
    if (!X.localUrl && !$("#xv").getAttribute("src")) $("#xv").src = meta.url;
    $("#x-prog").hidden = true; $("#x-done").disabled = false; $("#x-trim").hidden = true; $("#x-dl").hidden = true;
    const link = meta.cloud?.link || meta.drive?.link;
    $("#x-status").textContent = meta.cloud ? "✓ Enregistrée sur ton PC et publiée sur ton serveur" : meta.drive ? "✓ Enregistrée sur ton PC et partagée sur Google Drive" : "✓ Enregistrée sur ton PC. Tu veux la partager ?";
    $("#x-share").hidden = !link; $("#x-cshare").hidden = !!meta.cloud; $("#x-gshare").hidden = !!meta.drive; $("#x-reveal").hidden = false;
    if (link) { $("#x-link").value = link; $("#x-open").href = link; }
    return;
  }
  $("#x-prog").hidden = true; $("#x-status").textContent = "✓ Prête à partager";
  const link = `${location.origin}/v/${meta.id}`;
  $("#x-link").value = link; $("#x-open").href = link; $("#x-share").hidden = false; $("#x-done").disabled = false;
  if (!X.download) $("#x-dl").hidden = false;
  setupTrim(meta);
  if (!silent) navigator.clipboard.writeText(link).then(() => toast("Lien copié"), () => {});
}
function uploadFailed(err, up) {
  $("#x-status").textContent = ""; $("#x-prog").hidden = true;
  $("#x-err").textContent = `Envoi impossible : ${errMsg(err)}. ${X.download ? "Télécharge la vidéo pour ne pas la perdre." : ""}`;
  $("#x-dl").hidden = !X.download; $("#x-done").disabled = false; up?.abort();
}
function setupTrim(meta) {
  const d = X.duration; $("#x-trim").hidden = !(d > 1);
  if (!(d > 1)) return;
  const ts = $("#x-ts"), te = $("#x-te");
  ts.max = te.max = d.toFixed(1); ts.step = te.step = "0.1";
  ts.value = meta.trimStart || 0; te.value = meta.trimEnd || d;
  const upd = () => { if (+ts.value > +te.value - 0.5) ts.value = Math.max(0, +te.value - 0.5); $("#x-tsl").textContent = fmtDur(+ts.value); $("#x-tel").textContent = fmtDur(+te.value); };
  ts.oninput = () => { upd(); $("#xv").currentTime = +ts.value; };
  te.oninput = () => { upd(); $("#xv").currentTime = +te.value; };
  upd();
}
async function saveReview() {
  if (!X?.meta) return;
  const d = X.duration, ts = +$("#x-ts").value, te = +$("#x-te").value;
  const body = { title: $("#x-title").value };
  if (d > 1) { body.trimStart = ts > 0.05 ? ts : 0; body.trimEnd = te < d - 0.05 ? te : null; }
  X.meta = LOCAL ? await L.patch(X.meta.id, { title: body.title }) : await patchVideo(X.meta.id, body);
}
$("#x-title").onchange = () => saveReview().catch(() => {});
$("#x-done").onclick = async () => { try { await saveReview(); } catch (e) { $("#x-err").textContent = e.message; return; } X = null; cleanup(); loadLib(); };
$("#x-gshare").onclick = () => shareDrive();
$("#x-cshare").onclick = () => publishCloud();
$("#x-reveal").onclick = () => X?.meta && L.reveal(X.meta.id);
$("#x-copy").onclick = async () => { await saveReview().catch(() => {}); await navigator.clipboard.writeText($("#x-link").value); toast("Lien copié"); };
$("#x-dl").onclick = () => { const a = document.createElement("a"); a.href = X.download || `/f/${X.meta.id}`; a.download = `${$("#x-title").value || "video"}`; a.click(); };
$("#x-discard").onclick = async () => {
  if (!confirm("Supprimer cette vidéo ? Le lien ne marchera plus.")) return;
  if (X?.meta) await deleteVideo(X.meta.id).catch(() => {}); else X?.up?.abort();
  X = null; cleanup(); loadLib();
};

function stopTracks() {
  R?.worker?.postMessage({ type: "stop" }); const w = R?.worker; setTimeout(() => w?.terminate(), 500);
  [R?.display, R?.cam, R?.mic].forEach((s) => s?.getTracks().forEach((t) => t.stop()));
  R?.video?.stop?.(); R?.ac?.close?.();
}
function cleanup() { if (R) { clearInterval(R.tick); R.pip?.close(); stopTracks(); } R = null; $("#pv").srcObject = null; }
window.addEventListener("beforeunload", (e) => { if ((R?.rec && R.rec.state !== "inactive") || (X && !X.meta)) { e.preventDefault(); e.returnValue = ""; } });

boot();
