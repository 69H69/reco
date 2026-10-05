// Test de bout en bout de l'appli de bureau (Electron) contre le serveur local.
// Prérequis : `npx wrangler dev --port 8787 --local` à la racine. Lancer : node test.mjs
import { _electron as electron } from "playwright";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = "http://localhost:8787";
const ok = (c, m) => { console.log((c ? "OK   " : "ÉCHEC ") + m); if (!c) { process.exitCode = 1; throw new Error(m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const app = await electron.launch({ args: ["."], cwd: path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")),
  env: { ...process.env, RECO_TEST: "1", RECO_SERVER: BASE, RECO_USERDATA: fs.mkdtempSync(path.join(os.tmpdir(), "reco-test-")) } });
try {
  const pg = await app.firstWindow();
  await pg.waitForSelector("#l-name");
  ok(await pg.evaluate(() => !!window.recoDesktop && window.recoDesktop.platform), "appli de bureau détectée par la page");
  ok(await pg.isHidden("#dl-app"), "le lien « Télécharger l'app » est masqué dans l'appli");
  await pg.fill("#l-name", "Alex"); await pg.fill("#l-code", "test-local-123"); await pg.click("#f-login button");
  await pg.waitForSelector("#v-lib:not([hidden])");
  await pg.click("#b-new"); await pg.click('.mode[data-mode="screen+cam"]'); await pg.click("#b-prepare");
  await pg.waitForSelector("#b-go:not([hidden])", { timeout: 20000 });
  const src = await pg.evaluate(() => { const t = R.display.getVideoTracks()[0]; return { label: t.label, audio: R.display.getAudioTracks().length }; });
  ok(true, `capture de l'écran réel par l'appli (source « ${src.label} », son de l'ordinateur : ${src.audio ? "oui" : "non"})`);
  const pipP = app.waitForEvent("window");
  await pg.click("#b-go");
  const pip = await pipP;
  await sleep(3200);
  const wins = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => ({ t: w.getTitle(), top: w.isAlwaysOnTop(), min: w.isMinimized(), w: w.getBounds().width })));
  const small = wins.find((w) => w.w < 400), main = wins.find((w) => w.w >= 900);
  ok(small && small.top, "mini-fenêtre de contrôle ouverte et toujours au premier plan");
  ok(main && main.min, "fenêtre principale réduite pendant l'enregistrement");
  ok((await pip.textContent("#t")).match(/^0:0\d$/), `chrono dans la mini-fenêtre : ${await pip.textContent("#t")}`);
  await sleep(5000);
  await pip.click("#s"); // Stop depuis la mini-fenêtre
  await pg.waitForSelector("#x-share:not([hidden])", { timeout: 60000 });
  const restored = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.getBounds().width >= 900).map((w) => w.isMinimized()));
  ok(restored.length && !restored[0], "fenêtre principale revenue à l'arrêt");
  const link = await pg.inputValue("#x-link"), id = link.split("/").pop();
  ok(link.includes("/v/"), `lien prêt : ${link}`);
  // contrôle du fichier, sans regarder l'image (c'est ton vrai écran) : taille et luminosité moyenne
  const buf = Buffer.from(await (await fetch(`${BASE}/f/${id}`)).arrayBuffer());
  const f = path.join(os.tmpdir(), `reco-desktop-${id}.mp4`); fs.writeFileSync(f, buf);
  const info = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height", "-of", "json", f]).toString());
  const v = info.streams.find((s) => s.codec_type === "video"), a = info.streams.find((s) => s.codec_type === "audio");
  ok(v && a, `fichier ${v.codec_name} ${v.width}x${v.height} + ${a?.codec_name}`);
  const luma = execFileSync("ffmpeg", ["-v", "error", "-ss", "3", "-i", f, "-frames:v", "1", "-vf", "scale=64:36,format=gray", "-f", "rawvideo", "-"]);
  const mean = luma.reduce((s, x) => s + x, 0) / luma.length;
  ok(mean > 8, `l'image n'est pas noire (luminosité moyenne ${mean.toFixed(0)}/255)`);
  // ménage : on supprime cette vidéo (ton vrai écran) du stockage local et du disque
  ok((await pg.evaluate((i) => fetch(`/api/videos/${i}`, { method: "DELETE" }).then((r) => r.status), id)) === 200, "vidéo de test supprimée");
  fs.unlinkSync(f);
} finally {
  await app.close();
}
