// Compositeur + encodeur (Web Worker) : écran + bulle caméra dans un OffscreenCanvas, encodé en H.264 + AAC (WebCodecs)
// et rangé dans un MP4 (mp4-muxer). Cadence FIXE : l'image n porte toujours l'horodatage n / fps, quelle que soit
// l'heure d'arrivée des images de l'écran ou de la caméra ; une image en retard est remplacée par la précédente.
// Le son est horodaté au nombre d'échantillons, recalé sur l'horloge si la carte son dérive.
importScripts("/mp4-muxer.js");

let cfg, canvas, ctx, preview, screenFrame = null, camFrame = null, dirty = true, stopped = false, prevBusy = false, lastPrev = 0, timer = 0;
let audioFmt = null; // { sampleRate, numberOfChannels } du premier son reçu
let rec = null;      // prise en cours

self.onmessage = (e) => {
  const d = e.data;
  if (d.type === "start") {
    cfg = d.cfg;
    canvas = new OffscreenCanvas(cfg.w, cfg.h);
    ctx = canvas.getContext("2d", { alpha: false });
    preview = d.out.getWriter();
    if (d.screen) readVideo(d.screen.getReader(), "screen");
    if (d.cam) readVideo(d.cam.getReader(), "cam");
    if (d.audio) readAudio(d.audio.getReader());
    timer = setInterval(tick, Math.max(4, 500 / cfg.fps));
  } else if (d.type === "cfg") {
    Object.assign(cfg, d.cfg); dirty = true;
  } else if (d.type === "begin") {
    begin(d).catch((err) => fail(err, d.epoch));
  } else if (d.type === "pause") {
    if (rec && !rec.paused) { tick(); rec.paused = true; rec.pauseAt = performance.now(); }
  } else if (d.type === "resume") {
    if (rec?.paused) { rec.pausedMs += performance.now() - rec.pauseAt; rec.paused = false; }
  } else if (d.type === "finish") {
    finish().catch((err) => fail(err, rec?.epoch));
  } else if (d.type === "discard") {
    discard();
  } else if (d.type === "stop") {
    stopped = true; clearInterval(timer); discard();
    screenFrame?.close(); camFrame?.close();
    preview?.close().catch(() => {});
  }
};

const fail = (err, epoch) => self.postMessage({ type: "error", epoch, message: String(err?.message || err) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readVideo(reader, kind) {
  for (;;) {
    const { value, done } = await reader.read();
    if (done || stopped) { value?.close(); break; }
    if (kind === "screen") { screenFrame?.close(); screenFrame = value; } else { camFrame?.close(); camFrame = value; }
    dirty = true; tick();
  }
}

// ───────── dessin ─────────
function drawCover(frame, x, y, w, h, mirror) {
  const fw = frame.displayWidth, fh = frame.displayHeight;
  const s = Math.max(w / fw, h / fh), sw = w / s, sh = h / s;
  const sx = (fw - sw) / 2, sy = (fh - sh) / 2;
  ctx.save();
  if (mirror) { ctx.translate(x + w, y); ctx.scale(-1, 1); ctx.drawImage(frame, sx, sy, sw, sh, 0, 0, w, h); }
  else ctx.drawImage(frame, sx, sy, sw, sh, x, y, w, h);
  ctx.restore();
}

function render() {
  dirty = false;
  const W = cfg.w, H = cfg.h;
  ctx.fillStyle = "#0b0c10"; ctx.fillRect(0, 0, W, H);
  if (cfg.mode === "cam") {
    if (camFrame) drawCover(camFrame, 0, 0, W, H, true);
  } else {
    if (screenFrame) {
      const fw = screenFrame.displayWidth, fh = screenFrame.displayHeight, s = Math.min(W / fw, H / fh);
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(screenFrame, (W - fw * s) / 2, (H - fh * s) / 2, fw * s, fh * s);
    }
    if (cfg.mode === "screen+cam" && cfg.bubble && camFrame) {
      const d = Math.round(H * (cfg.big ? 0.42 : 0.26)), m = Math.round(H * 0.035);
      const x = cfg.corner.includes("r") ? W - d - m : m;
      const y = cfg.corner.includes("t") ? m : H - d - m;
      // forme : carré aux coins très arrondis (par défaut) ou rond
      const shape = (inset) => { ctx.beginPath(); if (cfg.shape === "circle") ctx.arc(x + d / 2, y + d / 2, d / 2 - inset, 0, Math.PI * 2); else ctx.roundRect(x + inset, y + inset, d - 2 * inset, d - 2 * inset, d * 0.22); };
      ctx.save();
      ctx.shadowColor = "rgba(0,0,0,.35)"; ctx.shadowBlur = H * 0.035; ctx.shadowOffsetY = H * 0.01;
      shape(0); ctx.fillStyle = "#000"; ctx.fill();
      ctx.restore();
      ctx.save(); shape(0); ctx.clip();
      drawCover(camFrame, x, y, d, d, true); ctx.restore();
      shape(0.5); ctx.lineWidth = Math.max(1.5, H * 0.0025); ctx.strokeStyle = "rgba(255,255,255,.85)"; ctx.stroke();
    }
  }
  // aperçu dans l'appli (sans attendre : il ne doit jamais ralentir l'enregistrement)
  if (!prevBusy) {
    prevBusy = true; lastPrev = performance.now();
    preview.write(new VideoFrame(canvas, { timestamp: Math.round(lastPrev * 1000) })).catch(() => {}).finally(() => (prevBusy = false));
  }
}

// ───────── horloge : appelée par chaque image reçue, chaque morceau de son et un minuteur ─────────
function tick() {
  if (stopped || !cfg) return;
  const now = performance.now();
  if (rec && rec.ready && !rec.paused && !rec.finishing) {
    const target = Math.floor((now - rec.t0 - rec.pausedMs) * cfg.fps / 1000);
    while (rec.n <= target) { if (dirty || rec.n === 0) render(); encodeVideo(rec.n++); }
    // source de son muette ou coupée : on comble avec du silence pour garder le son et l'image ensemble
    if (rec.aenc && (now - rec.t0 - rec.pausedMs) / 1000 * rec.sr - rec.apos > rec.sr * 0.5) silence(Math.round((now - rec.t0 - rec.pausedMs - 100) / 1000 * rec.sr) - rec.apos);
  } else if (dirty && now - lastPrev >= 900 / cfg.fps) render();
}

function encodeVideo(n) {
  const fps = cfg.fps;
  if (rec.venc.encodeQueueSize > fps * 4) { rec.skipped++; if (!rec.warned) { rec.warned = true; self.postMessage({ type: "warn", message: "L'ordinateur n'arrive pas à suivre : baisse la qualité ou les images par seconde." }); } return; }
  const f = new VideoFrame(canvas, { timestamp: Math.round(n * 1e6 / fps), duration: Math.round(1e6 / fps) });
  rec.venc.encode(f, { keyFrame: n % (fps * 2) === 0 });
  f.close();
  if (!rec.thumbDone && n >= Math.round(fps * 1.2)) {
    rec.thumbDone = true;
    const tc = new OffscreenCanvas(640, Math.round(640 * cfg.h / cfg.w));
    tc.getContext("2d").drawImage(canvas, 0, 0, tc.width, tc.height);
    tc.convertToBlob({ type: "image/jpeg", quality: 0.82 }).then((blob) => self.postMessage({ type: "thumb", blob }));
  }
}

// ───────── son ─────────
async function readAudio(reader) {
  for (;;) {
    const { value, done } = await reader.read();
    if (done || stopped) { value?.close(); break; }
    if (!audioFmt) audioFmt = { sampleRate: value.sampleRate, numberOfChannels: Math.min(2, value.numberOfChannels) };
    if (rec?.aenc && rec.ready && !rec.paused && !rec.finishing) onAudio(value); else value.close();
    tick();
  }
}

function onAudio(ad) {
  const sr = rec.sr, frames = ad.numberOfFrames;
  // position « horloge » du début de ce morceau, comparée au nombre d'échantillons déjà écrits
  const tRec = (performance.now() - rec.t0 - rec.pausedMs) / 1000;
  const diff = Math.round(tRec * sr) - frames - rec.apos;
  if (!rec.aStarted) { rec.aStarted = true; rec.evalAt = tRec; if (diff > 0) silence(diff); }
  else {
    // les morceaux arrivent parfois en retard, jamais en avance : le plus petit écart sur 2 s est le vrai décalage
    rec.minDiff = Math.min(rec.minDiff, diff);
    if (tRec - rec.evalAt > 2) {
      const m = rec.minDiff; rec.minDiff = Infinity; rec.evalAt = tRec;
      if (m > sr * 0.06) silence(m); else if (m < -sr * 0.06) rec.drop = -m;
    }
  }
  let skip = 0;
  if (rec.drop > 0) { skip = Math.min(frames, rec.drop); rec.drop -= skip; }
  if (skip >= frames) { ad.close(); return; }
  const n = frames - skip, ch = rec.ch, buf = new Float32Array(n * ch);
  for (let c = 0; c < ch; c++) ad.copyTo(buf.subarray(c * n, (c + 1) * n), { planeIndex: Math.min(c, ad.numberOfChannels - 1), frameOffset: skip, frameCount: n, format: "f32-planar" });
  ad.close();
  pushAudio(buf, n);
}
function silence(n) {
  for (let left = Math.max(0, Math.round(n)); left > 0;) { const k = Math.min(left, rec.sr); pushAudio(new Float32Array(k * rec.ch), k); left -= k; }
}
function pushAudio(buf, n) {
  const a = new AudioData({ format: "f32-planar", sampleRate: rec.sr, numberOfFrames: n, numberOfChannels: rec.ch, timestamp: Math.round(rec.apos * 1e6 / rec.sr), data: buf });
  rec.aenc.encode(a); a.close();
  rec.apos += n;
}

// ───────── choix des encodeurs ─────────
function avcLevel(w, h, fps) { // niveau H.264 minimal pour la taille et la cadence
  const fs = Math.ceil(w / 16) * Math.ceil(h / 16), mbps = fs * fps;
  for (const [lv, maxFs, maxMbps] of [[0x1f, 3600, 108000], [0x20, 5120, 216000], [0x28, 8192, 245760], [0x2a, 8704, 522240], [0x32, 22080, 589824], [0x33, 36864, 983040], [0x34, 36864, 2073600]])
    if (fs <= maxFs && mbps <= maxMbps) return lv;
  return 0x34;
}
async function videoConfig(w, h, fps, bitrate) {
  const lv = avcLevel(w, h, fps).toString(16).padStart(2, "0");
  for (const profile of ["6400", "4d00", "4200"]) for (const hw of ["no-preference", "prefer-software"]) {
    const c = { codec: `avc1.${profile}${lv}`, width: w, height: h, bitrate, framerate: fps, bitrateMode: "variable", latencyMode: "quality", hardwareAcceleration: hw, avc: { format: "avc" } };
    if ((await VideoEncoder.isConfigSupported(c).catch(() => ({}))).supported) return c;
  }
  throw new Error(`l'encodeur vidéo refuse ${w}×${h} à ${fps} i/s : choisis une qualité plus basse`);
}
async function audioConfig({ sampleRate, numberOfChannels }) {
  for (const [codec, mux] of [["mp4a.40.2", "aac"], ["opus", "opus"]]) {
    const c = { codec, sampleRate, numberOfChannels, bitrate: 160000 };
    if ((await AudioEncoder.isConfigSupported(c).catch(() => ({}))).supported) return { config: c, mux };
  }
  return null;
}

// ───────── une prise : début, fin, abandon ─────────
async function begin(d) {
  discard();
  const r = rec = { epoch: d.epoch, ready: false, n: 0, skipped: 0, apos: 0, minDiff: Infinity, drop: 0, pausedMs: 0, paused: false };
  const { w, h, fps } = cfg;
  if (cfg.hasAudio) for (let i = 0; i < 50 && !audioFmt; i++) await sleep(20); // attend le premier son pour connaître son format
  const vc = await videoConfig(w, h, fps, d.bitrate);
  const ac = audioFmt ? await audioConfig(audioFmt) : null;
  if (rec !== r) return; // abandonnée entre-temps
  const epoch = d.epoch;
  r.muxer = new Mp4Muxer.Muxer({
    // écrit au fil de l'eau (≈ toutes les 0,5 s) : en cas de plantage, presque tout est déjà sur le disque
    target: new Mp4Muxer.StreamTarget({ onData: (data, pos) => { const b = data.slice(); self.postMessage({ type: "data", epoch, buf: b.buffer, pos }, [b.buffer]); } }),
    video: { codec: "avc", width: w, height: h, frameRate: fps },
    audio: ac ? { codec: ac.mux, sampleRate: ac.config.sampleRate, numberOfChannels: ac.config.numberOfChannels } : undefined,
    fastStart: d.fragmented ? "fragmented" : false, // fichier : MP4 classique (en-tête réécrit à la fin) ; envoi en ligne : fragments
    firstTimestampBehavior: "strict",
  });
  r.venc = new VideoEncoder({ output: (chunk, meta) => r.muxer.addVideoChunk(chunk, meta), error: (err) => fail(err, epoch) });
  r.venc.configure(vc);
  if (ac) {
    r.sr = ac.config.sampleRate; r.ch = ac.config.numberOfChannels;
    r.aenc = new AudioEncoder({ output: (chunk, meta) => r.muxer.addAudioChunk(chunk, meta), error: (err) => fail(err, epoch) });
    r.aenc.configure(ac.config);
  }
  r.t0 = performance.now(); r.ready = true; dirty = true;
  self.postMessage({ type: "began", epoch, codec: vc.codec, audio: ac?.config.codec || null });
  tick();
}

async function finish() {
  const r = rec;
  if (!r) return;
  if (!r.ready) { for (let i = 0; i < 100 && !r.ready && rec === r; i++) await sleep(20); if (!r.ready) return; }
  if (!r.paused) tick();
  r.finishing = true;
  if (r.aenc) { const end = Math.round(r.n / cfg.fps * r.sr); if (end > r.apos) silence(end - r.apos); } // le son finit avec l'image
  await r.venc.flush();
  if (r.aenc) await r.aenc.flush();
  r.muxer.finalize();
  r.venc.close(); r.aenc?.close();
  if (rec === r) rec = null;
  self.postMessage({ type: "done", epoch: r.epoch, duration: r.n / cfg.fps, frames: r.n, skipped: r.skipped });
}

function discard() {
  const r = rec; rec = null;
  if (!r) return;
  try { r.venc?.state !== "closed" && r.venc?.close(); } catch {}
  try { r.aenc?.state !== "closed" && r.aenc?.close(); } catch {}
}
