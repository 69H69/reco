// Compositeur (Web Worker) : écran + bulle caméra dans un OffscreenCanvas.
// Cadencé par les images reçues (pas par un timer) : ne gèle pas quand l'onglet est en arrière-plan.
let cfg, canvas, ctx, writer, screenFrame = null, camFrame = null, busy = false, stopped = false, thumbDone = false, t0 = 0;

self.onmessage = (e) => {
  const d = e.data;
  if (d.type === "start") {
    cfg = d.cfg;
    canvas = new OffscreenCanvas(cfg.w, cfg.h);
    ctx = canvas.getContext("2d", { alpha: false });
    writer = d.out.getWriter();
    t0 = performance.now();
    if (d.screen) read(d.screen.getReader(), "screen");
    if (d.cam) read(d.cam.getReader(), "cam");
  } else if (d.type === "cfg") {
    Object.assign(cfg, d.cfg);
  } else if (d.type === "stop") {
    stopped = true;
    screenFrame?.close(); camFrame?.close();
    writer?.close().catch(() => {});
  }
};

async function read(reader, kind) {
  for (;;) {
    const { value, done } = await reader.read();
    if (done || stopped) { value?.close(); break; }
    if (kind === "screen") { screenFrame?.close(); screenFrame = value; } else { camFrame?.close(); camFrame = value; }
    // l'horloge : la caméra si elle existe (30 i/s constants), sinon l'écran
    const driver = cfg.hasCam ? "cam" : "screen";
    if (kind === driver) await emit();
  }
}

function drawCover(frame, x, y, w, h, mirror) {
  const fw = frame.displayWidth, fh = frame.displayHeight;
  const s = Math.max(w / fw, h / fh), sw = w / s, sh = h / s;
  const sx = (fw - sw) / 2, sy = (fh - sh) / 2;
  ctx.save();
  if (mirror) { ctx.translate(x + w, y); ctx.scale(-1, 1); ctx.drawImage(frame, sx, sy, sw, sh, 0, 0, w, h); }
  else ctx.drawImage(frame, sx, sy, sw, sh, x, y, w, h);
  ctx.restore();
}

async function emit() {
  if (busy || stopped) return;
  busy = true;
  try {
    const W = cfg.w, H = cfg.h;
    ctx.fillStyle = "#0b0c10"; ctx.fillRect(0, 0, W, H);
    if (cfg.mode === "cam") {
      if (camFrame) drawCover(camFrame, 0, 0, W, H, true);
    } else {
      if (screenFrame) {
        const fw = screenFrame.displayWidth, fh = screenFrame.displayHeight, s = Math.min(W / fw, H / fh);
        ctx.drawImage(screenFrame, (W - fw * s) / 2, (H - fh * s) / 2, fw * s, fh * s);
      }
      if (cfg.mode === "screen+cam" && cfg.bubble && camFrame) {
        const d = Math.round(H * (cfg.big ? 0.42 : 0.26)), m = Math.round(H * 0.035);
        const x = cfg.corner.includes("r") ? W - d - m : m;
        const y = cfg.corner.includes("t") ? m : H - d - m;
        ctx.save();
        ctx.shadowColor = "rgba(0,0,0,.45)"; ctx.shadowBlur = H * 0.03; ctx.shadowOffsetY = H * 0.008;
        ctx.beginPath(); ctx.arc(x + d / 2, y + d / 2, d / 2, 0, Math.PI * 2); ctx.fillStyle = "#000"; ctx.fill();
        ctx.restore();
        ctx.save(); ctx.beginPath(); ctx.arc(x + d / 2, y + d / 2, d / 2, 0, Math.PI * 2); ctx.clip();
        drawCover(camFrame, x, y, d, d, true); ctx.restore();
        ctx.beginPath(); ctx.arc(x + d / 2, y + d / 2, d / 2 - 1, 0, Math.PI * 2);
        ctx.lineWidth = Math.max(2, H * 0.004); ctx.strokeStyle = "rgba(255,255,255,.9)"; ctx.stroke();
      }
    }
    const frame = new VideoFrame(canvas, { timestamp: Math.round((performance.now() - t0) * 1000) });
    await writer.write(frame);
    if (!thumbDone && performance.now() - t0 > 1200) {
      thumbDone = true;
      const tc = new OffscreenCanvas(640, Math.round(640 * H / W));
      tc.getContext("2d").drawImage(canvas, 0, 0, tc.width, tc.height);
      self.postMessage({ type: "thumb", blob: await tc.convertToBlob({ type: "image/jpeg", quality: 0.82 }) });
    }
  } catch (err) {
    self.postMessage({ type: "error", message: String(err) });
  } finally {
    busy = false;
  }
}
