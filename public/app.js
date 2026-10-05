// Reco — appli d'enregistrement (Chrome / Edge).
const $ = (s) => document.querySelector(s);
const show = (id) => { document.querySelectorAll(".view").forEach((v) => (v.hidden = v.id !== id)); };
const toast = (t) => { const el = $("#toast"); el.textContent = t; el.classList.add("on"); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove("on"), 2200); };
const fmtDur = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const fmtSize = (b) => (b > 1e9 ? (b / 1e9).toFixed(2) + " Go" : (b / 1e6).toFixed(0) + " Mo");
const TEST = new URLSearchParams(location.search).has("fakeScreen"); // tests automatisés

async function api(path, body, method) {
  const r = await fetch(path, { method: method || (body ? "POST" : "GET"), headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error || `Erreur ${r.status}`), { status: r.status });
  return d;
}

// ───────── connexion & bibliothèque ─────────
let me = null;
async function boot() {
  if (!("MediaStreamTrackProcessor" in window)) {
    document.body.insertAdjacentHTML("afterbegin", '<div class="warn">Reco fonctionne sur <b>Chrome</b> ou <b>Edge</b> (ordinateur). Ouvre ce lien dans l\'un des deux.</div>');
  }
  try { me = await api("/api/me"); } catch { me = null; }
  if (!me) { $("#who").innerHTML = ""; show("v-login"); return; }
  $("#who").innerHTML = `<span>${escapeHtml(me.name)}</span><button class="link" id="b-out">Déconnexion</button>`;
  $("#b-out").onclick = async () => { await api("/api/logout", {}); location.reload(); };
  loadLib();
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

$("#f-login").onsubmit = async (e) => {
  e.preventDefault(); $("#l-err").textContent = "";
  try { await api("/api/login", { name: $("#l-name").value, code: $("#l-code").value }); boot(); }
  catch (err) { $("#l-err").textContent = err.message; }
};

async function loadLib() {
  show("v-lib");
  const { videos, used, quota } = await api("/api/videos");
  $("#quota").textContent = `${videos.length} vidéo${videos.length > 1 ? "s" : ""} · ${fmtSize(used)} utilisés sur ${fmtSize(quota)} gratuits`;
  $("#empty").hidden = videos.length > 0;
  $("#grid").innerHTML = videos.map((v) => `
    <article class="vc" data-id="${v.id}">
      <a href="/v/${v.id}" target="_blank" class="th"><img src="/t/${v.id}" alt="" loading="lazy" onerror="this.style.visibility='hidden'"><span class="d">${v.duration ? fmtDur(v.duration) : ""}</span></a>
      <div class="vi"><b title="${escapeHtml(v.title)}">${escapeHtml(v.title)}</b><span class="muted">${escapeHtml(v.author)} · ${new Date(v.created).toLocaleDateString("fr-FR", { day: "numeric", month: "short" })}</span></div>
      <div class="va"><button class="btn small" data-act="copy">Copier le lien</button><button class="link" data-act="rename">Renommer</button><button class="link danger" data-act="del">Supprimer</button></div>
    </article>`).join("");
}
$("#grid").onclick = async (e) => {
  const b = e.target.closest("[data-act]"); if (!b) return;
  const id = b.closest(".vc").dataset.id, link = `${location.origin}/v/${id}`;
  if (b.dataset.act === "copy") { await navigator.clipboard.writeText(link); toast("Lien copié ✓"); }
  if (b.dataset.act === "rename") { const t = prompt("Nouveau titre"); if (t) { await api(`/api/videos/${id}`, { title: t }, "PATCH"); loadLib(); } }
  if (b.dataset.act === "del" && confirm("Supprimer définitivement cette vidéo ? Le lien ne marchera plus.")) { await api(`/api/videos/${id}`, null, "DELETE"); loadLib(); }
};

// ───────── préparation ─────────
const S = { mode: "screen+cam", corner: "bl", sys: true };
let R = null; // session d'enregistrement en cours

$("#b-new").onclick = async () => {
  show("v-setup"); $("#s-err").textContent = ""; $("#b-go").hidden = true; $("#pip-hint").hidden = true; $("#prev-hint").hidden = false;
  try { // permission pour obtenir les noms des appareils
    const tmp = await navigator.mediaDevices.getUserMedia({ video: true, audio: true }).catch(() => navigator.mediaDevices.getUserMedia({ audio: true }));
    tmp.getTracks().forEach((t) => t.stop());
  } catch { /* l'utilisateur pourra choisir « aucun » */ }
  const devs = await navigator.mediaDevices.enumerateDevices();
  const opt = (d, i, k) => `<option value="${d.deviceId}">${escapeHtml(d.label || `${k} ${i + 1}`)}</option>`;
  $("#s-cam").innerHTML = devs.filter((d) => d.kind === "videoinput").map((d, i) => opt(d, i, "Caméra")).join("");
  $("#s-mic").innerHTML = devs.filter((d) => d.kind === "audioinput").map((d, i) => opt(d, i, "Micro")).join("") + '<option value="none">Aucun micro</option>';
  refreshSetup();
};
$("#b-cancel").onclick = () => { cleanup(); loadLib(); };
$("#modes").onclick = (e) => { const b = e.target.closest(".mode"); if (!b) return; S.mode = b.dataset.mode; refreshSetup(); };
$("#corners").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; S.corner = b.dataset.c; refreshSetup(); R?.worker?.postMessage({ type: "cfg", cfg: { corner: S.corner } }); };
$("#c-sys").onchange = (e) => (S.sys = e.target.checked);
function refreshSetup() {
  document.querySelectorAll(".mode").forEach((b) => b.classList.toggle("on", b.dataset.mode === S.mode));
  document.querySelectorAll("#corners button").forEach((b) => b.classList.toggle("on", b.dataset.c === S.corner));
  $("#lab-cam").hidden = S.mode === "screen";
  $("#lab-sys").hidden = S.mode === "cam";
  $("#lab-corner").hidden = S.mode !== "screen+cam";
  $("#b-prepare").textContent = S.mode === "cam" ? "Préparer la caméra" : "Choisir l'écran et préparer";
}

function fakeScreen() { // écran factice animé (tests)
  const c = document.createElement("canvas"); c.width = 1920; c.height = 1080; const g = c.getContext("2d"); let n = 0;
  (function loop() { n++; g.fillStyle = `hsl(${n % 360},60%,40%)`; g.fillRect(0, 0, 1920, 1080); g.fillStyle = "#fff"; g.font = "bold 120px sans-serif"; g.fillText(`ÉCRAN TEST ${n}`, 200, 560); requestAnimationFrame(loop); })();
  return c.captureStream(30);
}

$("#b-prepare").onclick = async () => {
  $("#s-err").textContent = "";
  cleanup();
  R = { chunks: [], paused: false, pausedMs: 0 };
  try {
    if (S.mode !== "cam") {
      R.display = TEST ? fakeScreen() : await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: S.sys, selfBrowserSurface: "exclude", surfaceSwitching: "include", systemAudio: "include" });
      R.display.getVideoTracks()[0].addEventListener("ended", () => { if (R?.rec && R.rec.state !== "inactive") stopRec(); });
    }
    if (S.mode !== "screen") R.cam = await navigator.mediaDevices.getUserMedia({ video: { deviceId: $("#s-cam").value ? { exact: $("#s-cam").value } : undefined, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } });
    if ($("#s-mic").value !== "none") R.mic = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: $("#s-mic").value ? { exact: $("#s-mic").value } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (err) {
    $("#s-err").textContent = err.name === "NotAllowedError" ? "Partage refusé. Réessaie et autorise l'écran, la caméra ou le micro." : `Impossible de démarrer : ${err.message}`;
    cleanup(); return;
  }
  // taille de sortie : celle de l'écran, plafonnée à 1920x1080 ; caméra seule : 1280x720
  let w = 1280, h = 720;
  if (R.display) { const st = R.display.getVideoTracks()[0].getSettings(); const s = Math.min(1, 1920 / (st.width || 1920), 1080 / (st.height || 1080)); w = Math.round((st.width || 1920) * s / 2) * 2; h = Math.round((st.height || 1080) * s / 2) * 2; }
  R.size = { w, h };
  // compositeur
  R.worker = new Worker("/comp.js");
  const gen = new MediaStreamTrackGenerator({ kind: "video" });
  const msg = { type: "start", cfg: { w, h, mode: S.mode, corner: S.corner, bubble: true, big: false, hasCam: !!R.cam }, out: gen.writable };
  const tr = [gen.writable];
  if (R.display) { msg.screen = new MediaStreamTrackProcessor({ track: R.display.getVideoTracks()[0] }).readable; tr.push(msg.screen); }
  if (R.cam) { msg.cam = new MediaStreamTrackProcessor({ track: R.cam.getVideoTracks()[0] }).readable; tr.push(msg.cam); }
  R.worker.onmessage = (e) => { if (e.data.type === "thumb") R.thumb = e.data.blob; if (e.data.type === "error") console.warn("compositeur", e.data.message); };
  R.worker.postMessage(msg, tr);
  R.video = gen;
  // audio : micro + son de l'ordinateur mixés
  const aTracks = [...(R.mic?.getAudioTracks() || []), ...(R.display?.getAudioTracks() || [])];
  if (aTracks.length > 1) {
    R.ac = new AudioContext(); const dst = R.ac.createMediaStreamDestination();
    aTracks.forEach((t) => R.ac.createMediaStreamSource(new MediaStream([t])).connect(dst));
    R.audio = dst.stream.getAudioTracks()[0];
  } else R.audio = aTracks[0] || null;
  $("#pv").srcObject = new MediaStream([gen]);
  $("#prev-hint").hidden = true; $("#b-go").hidden = false; $("#pip-hint").hidden = !("documentPictureInPicture" in window);
};

// ───────── enregistrement ─────────
function pickMime() {
  for (const m of ["video/mp4;codecs=avc1.640028,mp4a.40.2", "video/mp4;codecs=avc1,mp4a", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"])
    if (MediaRecorder.isTypeSupported(m)) return m;
  return "";
}
const elapsed = () => { if (!R?.t0) return 0; const now = R.paused ? R.pauseAt : performance.now(); return (now - R.t0 - R.pausedMs) / 1000; };

$("#b-go").onclick = async () => {
  await openPip(); // nécessite le clic : on l'ouvre tout de suite
  show("v-rec"); $("#rv").srcObject = new MediaStream([R.video]);
  const c = $("#count"); c.hidden = false;
  for (const n of [3, 2, 1]) { c.textContent = n; pipCount(n); await new Promise((r) => setTimeout(r, 800)); }
  c.hidden = true; pipCount(null);
  const stream = new MediaStream([R.video, ...(R.audio ? [R.audio] : [])]);
  R.mime = pickMime();
  R.rec = new MediaRecorder(stream, { mimeType: R.mime, videoBitsPerSecond: 4_500_000, audioBitsPerSecond: 128_000 });
  R.rec.ondataavailable = (e) => e.data.size && R.chunks.push(e.data);
  R.rec.onstop = onStopped;
  R.rec.start(1000); R.t0 = performance.now();
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
async function openPip() {
  if (!("documentPictureInPicture" in window)) return;
  try {
    const w = await documentPictureInPicture.requestWindow({ width: 260, height: R.cam ? 330 : 150 });
    R.pip = w;
    w.document.head.innerHTML = `<style>
      body{margin:0;background:#0b0c10;color:#f5f3ee;font-family:system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;gap:10px;padding:12px;box-sizing:border-box;height:100vh}
      video{width:170px;height:170px;border-radius:50%;object-fit:cover;transform:scaleX(-1);border:3px solid #fff;background:#000}
      .bar{display:flex;align-items:center;gap:8px;font:600 22px system-ui}.dot{width:10px;height:10px;border-radius:50%;background:#ff3b30}
      body.paused .dot{background:#ffb547}.btns{display:flex;gap:8px;width:100%}
      button{flex:1;border:0;border-radius:12px;padding:11px 0;font:600 14px system-ui;cursor:pointer;background:#22252d;color:#fff}
      button.stop{background:#ff3b30}.mini{display:flex;gap:6px;width:100%}.mini button{padding:6px 0;font-size:12px;background:#16181d}
      .count{position:fixed;inset:0;display:none;align-items:center;justify-content:center;font:800 90px system-ui;background:rgba(11,12,16,.85)}</style>`;
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
    w.addEventListener("pagehide", () => { R && (R.pip = null); });
  } catch (err) { console.warn("PiP indisponible", err); }
}
function pipCount(n) { const c = R?.pip?.document.getElementById("c"); if (!c) return; c.style.display = n ? "flex" : "none"; c.textContent = n || ""; }

// ───────── relecture & envoi ─────────
function onStopped() {
  clearInterval(R.tick);
  R.blob = new Blob(R.chunks, { type: R.mime.split(";")[0] || "video/webm" });
  R.pip?.close();
  stopTracks();
  show("v-review");
  $("#xv").src = URL.createObjectURL(R.blob);
  $("#x-title").value = `Enregistrement du ${new Date().toLocaleDateString("fr-FR", { day: "numeric", month: "short" })} à ${new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`;
  $("#x-share").hidden = true; $("#x-prog").hidden = true; $("#x-err").textContent = ""; $("#x-up").disabled = false;
}
$("#x-dl").onclick = () => { const a = document.createElement("a"); a.href = $("#xv").src; a.download = `${$("#x-title").value || "enregistrement"}.${R.blob.type.includes("mp4") ? "mp4" : "webm"}`; a.click(); };
$("#x-discard").onclick = () => { if (confirm("Supprimer cet enregistrement sans l'envoyer ?")) { cleanup(); loadLib(); } };
$("#x-up").onclick = async () => {
  $("#x-up").disabled = true; $("#x-err").textContent = ""; $("#x-prog").hidden = false;
  const bar = $("#x-bar"), blob = R.blob, ext = blob.type.includes("mp4") ? "mp4" : "webm";
  let s;
  try {
    s = await api("/api/upload/start", { ext });
    const CH = 8 * 1024 * 1024, parts = [], n = Math.max(1, Math.ceil(blob.size / CH));
    for (let i = 0; i < n; i++) {
      let ok = false, last;
      for (let a = 0; a < 3 && !ok; a++) {
        try {
          const r = await fetch(`/api/upload/part?key=${encodeURIComponent(s.key)}&uploadId=${encodeURIComponent(s.uploadId)}&n=${i + 1}`, { method: "PUT", body: blob.slice(i * CH, (i + 1) * CH) });
          if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Erreur ${r.status}`);
          parts.push(await r.json()); ok = true;
        } catch (err) { last = err; await new Promise((r) => setTimeout(r, 1000 * (a + 1))); }
      }
      if (!ok) throw last;
      bar.style.width = `${Math.round(((i + 1) / n) * 95)}%`;
    }
    const meta = await api("/api/upload/complete", { id: s.id, key: s.key, uploadId: s.uploadId, parts, title: $("#x-title").value, duration: R.duration, width: R.size.w, height: R.size.h });
    if (R.thumb) await fetch(`/api/thumb/${meta.id}`, { method: "PUT", body: R.thumb });
    bar.style.width = "100%";
    const link = `${location.origin}/v/${meta.id}`;
    $("#x-link").value = link; $("#x-open").href = link; $("#x-share").hidden = false;
    await navigator.clipboard.writeText(link).then(() => toast("Lien copié ✓"), () => {});
  } catch (err) {
    $("#x-err").textContent = `Envoi impossible : ${err.message}. Ta vidéo est toujours là, réessaie ou télécharge-la.`;
    $("#x-up").disabled = false;
    if (s) api("/api/upload/abort", { key: s.key, uploadId: s.uploadId }).catch(() => {});
  }
};
$("#x-copy").onclick = async () => { await navigator.clipboard.writeText($("#x-link").value); toast("Lien copié ✓"); };

function stopTracks() {
  R?.worker?.postMessage({ type: "stop" });
  setTimeout(() => R?.worker?.terminate(), 500);
  [R?.display, R?.cam, R?.mic].forEach((s) => s?.getTracks().forEach((t) => t.stop()));
  R?.video?.stop?.(); R?.ac?.close?.();
}
function cleanup() { if (R) { clearInterval(R.tick); R.pip?.close(); stopTracks(); } R = null; $("#pv").srcObject = null; }
window.addEventListener("beforeunload", (e) => { if (R?.rec && R.rec.state !== "inactive") { e.preventDefault(); e.returnValue = ""; } });

boot();
