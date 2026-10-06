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
  // titre
  await pg.fill("#x-title", "Test local"); await pg.dispatchEvent("#x-title", "change"); await sleep(400);
  ok(await pg.isVisible("#x-cshare") && await pg.isVisible("#x-gshare"), "fin d'enregistrement : choix « mon serveur Reco » ou « Google Drive »");
  // publication sur « mon serveur Reco » (serveur local de test, qui imite un serveur Cloudflare)
  await pg.click("#x-cshare");
  await pg.waitForSelector("#d-cloud[open]");
  await pg.fill("#c-url", "http://localhost:8787"); await pg.fill("#c-name", "Alex"); await pg.fill("#c-code", "mauvais"); await pg.click("#c-go");
  await pg.waitForFunction(() => document.querySelector("#c-err").textContent.length > 0);
  const cerr = await pg.textContent("#c-err");
  ok(cerr === "Code d'invitation incorrect.", `mauvais code refusé, message clair : « ${cerr} »`);
  await pg.fill("#c-code", "test-local-123"); await pg.click("#c-go");
  await pg.waitForSelector("#x-share:not([hidden])", { timeout: 60000 });
  const clink = await pg.inputValue("#x-link"), cid = clink.split("/").pop();
  ok(clink.startsWith("http://localhost:8787/v/"), `publiée sur mon serveur : ${clink}`);
  const remote = Buffer.from(await (await fetch(`http://localhost:8787/f/${cid}`)).arrayBuffer());
  ok(remote.equals(fs.readFileSync(path.join(VIDS, vid))), `le fichier en ligne est identique à l'octet près au fichier du PC (${(remote.length / 1e6).toFixed(1)} Mo)`);
  const page = await (await fetch(clink)).text();
  ok(page.includes("Test local") && (await fetch(`http://localhost:8787/t/${cid}`)).status === 200, "page de partage avec le titre et la miniature");
  ok((await pg.textContent("#cloud-st")).includes("localhost:8787"), "serveur affiché comme connecté dans la barre latérale");
  // partage Google Drive (simulé) en plus
  ok(!(await pg.evaluate(() => document.querySelector("#d-cloud").open)), "la fenêtre de connexion s'est refermée");
  ok(await pg.isVisible("#x-gshare"), "Google Drive reste proposé en plus");
  await pg.click("#x-gshare");
  await pg.waitForFunction(() => document.querySelector("#x-gshare").hidden && /Google Drive/.test(document.querySelector("#x-status").textContent), null, { timeout: 30000 });
  const link = await pg.inputValue("#x-link");
  ok(link.startsWith("http://localhost:8787/v/"), "le lien affiché reste celui de mon serveur (prioritaire)");
  const saved = JSON.parse(fs.readFileSync(path.join(VIDS, `${id}.json`), "utf8"));
  ok(saved.cloud?.link === clink && saved.drive?.link.startsWith("https://drive.google.com/file/d/"), "les deux liens (serveur + Drive) sont mémorisés avec la vidéo");
  ok((await pg.textContent("#drive-st")).includes("test@exemple.com"), "Google Drive affiché comme connecté");
  await pg.click("#x-done"); await pg.waitForSelector(".vc");
  const card = await pg.textContent(`.vc[data-id="${id}"]`);
  ok(card.includes("Test local") && card.includes("En ligne"), "la bibliothèque affiche la vidéo, son titre et « En ligne »");
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
