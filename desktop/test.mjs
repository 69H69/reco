// Test de bout en bout de l'appli de bureau en MODE LOCAL (vidéos sur le PC + partage Google Drive simulé).
// Lancer : node test.mjs      (aucun serveur nécessaire)
import { _electron as electron } from "playwright";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ok = (c, m) => { console.log((c ? "OK   " : "ÉCHEC ") + m); if (!c) { process.exitCode = 1; throw new Error(m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reco-local-"));
const VIDS = path.join(tmp, "videos");

const app = await electron.launch({ args: ["."], cwd: path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")),
  env: { ...process.env, RECO_TEST: "1", RECO_SERVER: "", RECO_USERDATA: path.join(tmp, "profil"), RECO_VIDEOS_DIR: VIDS, RECO_DRIVE_MOCK: "1" } });
try {
  const pg = await app.firstWindow();
  await pg.waitForSelector("#v-lib:not([hidden])", { timeout: 30000 });
  ok(pg.url().startsWith("reco://app/"), `interface intégrée à l'appli (${pg.url()}), sans serveur`);
  ok(await pg.isVisible("#shell") && !(await pg.isVisible("#v-login")), "pas d'écran de connexion");
  ok((await pg.textContent("#drive-st")).includes("non connecté"), "Google Drive affiché comme non connecté");
  // enregistrement (vrai écran, faux micro et fausse caméra)
  await pg.click("#b-new"); await pg.click('.mode[data-mode="screen+cam"]'); await pg.click("#b-prepare");
  await pg.waitForSelector("#b-go:not([hidden])", { timeout: 20000 });
  const pipP = app.waitForEvent("window"); await pg.click("#b-go"); const pip = await pipP;
  await sleep(3000 + 6000);
  const part = fs.readdirSync(VIDS).find((f) => f.endsWith(".part"));
  ok(part && fs.statSync(path.join(VIDS, part)).size > 0, `la vidéo s'écrit sur le disque PENDANT l'enregistrement (${part}, ${(fs.statSync(path.join(VIDS, part)).size / 1e6).toFixed(1)} Mo)`);
  await pip.click("#s");
  await pg.waitForFunction(() => document.querySelector("#x-status").textContent.includes("Enregistrée sur ton PC"), null, { timeout: 30000 });
  const files = fs.readdirSync(VIDS);
  const vid = files.find((f) => /\.(mp4|webm)$/.test(f)), id = vid.split(".")[0];
  ok(files.includes(`${id}.json`) && files.includes(`${id}.jpg`) && !files.some((f) => f.endsWith(".part")), `fichiers dans le dossier : ${files.join(", ")}`);
  const meta = JSON.parse(fs.readFileSync(path.join(VIDS, `${id}.json`), "utf8"));
  ok(meta.duration > 5 && meta.duration < 8, `durée ${meta.duration.toFixed(1)} s enregistrée`);
  const info = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height", "-of", "json", path.join(VIDS, vid)]).toString());
  ok(info.streams.some((s) => s.codec_type === "video") && info.streams.some((s) => s.codec_type === "audio"), `vidéo lisible : ${info.streams.map((s) => s.codec_name).join(" + ")}`);
  await pg.waitForFunction(() => document.querySelector("#xv").readyState >= 1, null, { timeout: 15000 });
  ok(await pg.evaluate(() => document.querySelector("#xv").src.startsWith("reco://app/media/")), "lecture de la vidéo depuis le disque dans l'appli");
  await pg.evaluate(() => { const v = document.querySelector("#xv"); v.currentTime = 4; });
  await sleep(800);
  ok((await pg.evaluate(() => document.querySelector("#xv").currentTime)) > 3.5, "avance rapide dans la vidéo locale (lecture partielle)");
  // titre + partage Drive (simulé)
  await pg.fill("#x-title", "Test local"); await pg.dispatchEvent("#x-title", "change");
  await pg.click("#x-gshare");
  await pg.waitForSelector("#x-share:not([hidden])", { timeout: 20000 });
  const link = await pg.inputValue("#x-link");
  ok(link.startsWith("https://drive.google.com/file/d/"), `lien Google Drive obtenu : ${link}`);
  ok(JSON.parse(fs.readFileSync(path.join(VIDS, `${id}.json`), "utf8")).drive?.link === link, "lien mémorisé avec la vidéo");
  ok((await pg.textContent("#drive-st")).includes("test@exemple.com"), "Google Drive affiché comme connecté");
  await pg.click("#x-done"); await pg.waitForSelector(".vc");
  const card = await pg.textContent(`.vc[data-id="${id}"]`);
  ok(card.includes("Test local") && card.includes("Partagée"), "la bibliothèque affiche la vidéo, son titre et « Partagée »");
  // suppression
  pg.once("dialog", (d) => d.accept());
  await pg.hover(`.vc[data-id="${id}"]`); await pg.click(`.vc[data-id="${id}"] [data-act="del"]`);
  await pg.waitForFunction((i) => !document.querySelector(`.vc[data-id="${i}"]`), id);
  ok(!fs.readdirSync(VIDS).some((f) => f.startsWith(id)), "supprimée de la bibliothèque et du disque");
} finally {
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await sleep(1500);
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch { console.log("(dossier temporaire laissé : " + tmp + ")"); }
}
