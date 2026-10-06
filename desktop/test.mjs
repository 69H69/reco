// Test de bout en bout de l'appli de bureau en MODE LOCAL (vidéos sur le PC + partage Google Drive simulé).
// Lancer : node test.mjs   (ou RECO_EXE=dist/win-unpacked/Reco.exe node test.mjs)   (avec `npx wrangler dev --port 8787 --local` lancé à la racine pour la publication sur « mon serveur »)
import { _electron as electron } from "playwright";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ok = (c, m) => { console.log((c ? "OK   " : "ÉCHEC ") + m); if (!c) { process.exitCode = 1; throw new Error(m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reco-local-"));
const VIDS = path.join(tmp, "videos");
const probe = (f, args) => JSON.parse(execFileSync("ffprobe", ["-v", "error", ...args, "-of", "json", f]).toString());
// cadence fixe : tous les écarts entre images valent exactement 1/fps
function cadence(f) {
  const v = probe(f, ["-select_streams", "v:0", "-show_entries", "stream=r_frame_rate,avg_frame_rate,width,height,codec_name:packet=pts", "-show_entries", "stream=time_base"]);
  const pts = v.packets.map((p) => +p.pts).sort((a, b) => a - b), d = new Set(pts.slice(1).map((x, i) => x - pts[i]));
  return { ...v.streams[0], frames: pts.length, deltas: [...d] };
}
// attend la fin de l'écriture : n vidéos finies dans le dossier (aucun .part) et l'écran de fin affiché
async function waitSaved(pg, n) {
  for (let i = 0; i < 150; i++) {
    const f = fs.readdirSync(VIDS);
    if (f.filter((x) => x.endsWith(".mp4")).length === n && !f.some((x) => x.endsWith(".part")) && await pg.isVisible("#x-info") && /images\/s/.test(await pg.textContent("#x-info"))) return;
    await sleep(200);
  }
  throw new Error("vidéo jamais finalisée");
}
const durOf = (f, sel) => +probe(f, ["-select_streams", sel, "-show_entries", "stream=duration"]).streams[0].duration;

// RECO_EXE=dist/win-unpacked/Reco.exe : teste l'appli compilée au lieu des sources
const env = { ...process.env, RECO_TEST: "1", RECO_SERVER: "", RECO_USERDATA: path.join(tmp, "profil"), RECO_VIDEOS_DIR: VIDS, RECO_DRIVE_MOCK: "1" };
const app = await electron.launch(process.env.RECO_EXE ? { executablePath: process.env.RECO_EXE, env }
  : { args: ["."], cwd: path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")), env });
try {
  const pg = await app.firstWindow();
  pg.on("console", (m) => { if (m.type() === "warning" || m.type() === "error") console.log("   [page]", m.text()); });
  await pg.waitForSelector("#v-lib:not([hidden])", { timeout: 30000 });
  ok(pg.url().startsWith("reco://app/"), `interface intégrée à l'appli (${pg.url()}), sans serveur`);
  ok(await pg.isVisible("#shell") && !(await pg.isVisible("#v-login")), "pas d'écran de connexion");
  ok((await pg.textContent("#sharing-sum")) === "à configurer", "barre latérale : « Partage — à configurer »");
  await pg.click("#b-sharing"); await pg.waitForSelector("#d-sharing[open]");
  ok((await pg.textContent("#drive-st")).includes("il reste à connecter") && await pg.isVisible("#gd-c"), "fenêtre Partage : Google Drive prêt, bouton « Connecter » visible");
  await pg.click("#d-sharing [data-close]");

  // 1) écran + caméra, 720p à 60 i/s, avec « Recommencer » pendant l'enregistrement
  await pg.click("#b-new"); await pg.click('.mode[data-mode="screen+cam"]');
  await pg.selectOption("#s-quality", "720"); await pg.click('#fpss [data-fps="60"]');
  ok((await pg.textContent("#q-hint")).includes("60 images par seconde"), `réglages affichés : « ${await pg.textContent("#q-hint")} »`);
  await pg.click("#b-prepare");
  await pg.waitForSelector("#b-go:not([hidden])", { timeout: 20000 });
  const pipP = app.waitForEvent("window"); await pg.click("#b-go"); const pip = await pipP;
  await sleep(2400 + 3000);
  const first = fs.readdirSync(VIDS).find((f) => f.endsWith(".part"));
  ok(first && fs.statSync(path.join(VIDS, first)).size > 0, `la vidéo s'écrit sur le disque PENDANT l'enregistrement (${first}, ${(fs.statSync(path.join(VIDS, first)).size / 1e6).toFixed(1)} Mo)`);
  await pip.click("#rt"); // Recommencer
  await sleep(600);
  ok(!fs.existsSync(path.join(VIDS, first)), "« Recommencer » efface la première prise du disque");
  await sleep(2400 + 6000);
  await pip.click("#s");
  await pg.waitForFunction(() => document.querySelector("#x-status").textContent.includes("Enregistrée sur ton PC"), null, { timeout: 30000 });
  let files = fs.readdirSync(VIDS);
  const vid = files.find((f) => /\.mp4$/.test(f)), id = vid.split(".")[0], fvid = path.join(VIDS, vid);
  ok(files.length === 3 && files.includes(`${id}.json`) && files.includes(`${id}.jpg`), `une seule vidéo gardée, la 2e prise : ${files.join(", ")}`);
  const meta = JSON.parse(fs.readFileSync(path.join(VIDS, `${id}.json`), "utf8"));
  ok(meta.duration > 5 && meta.duration < 7.5 && meta.fps === 60 && meta.height === 720, `durée ${meta.duration.toFixed(2)} s (seulement la 2e prise), ${meta.width}×${meta.height} à ${meta.fps} i/s`);
  const c1 = cadence(fvid);
  ok(c1.codec_name === "h264" && c1.r_frame_rate === "60/1" && c1.avg_frame_rate === "60/1", `H.264, cadence ${c1.r_frame_rate} (moyenne ${c1.avg_frame_rate})`);
  ok(c1.deltas.length === 1, `cadence FIXE : ${c1.frames} images, un seul écart entre images (${c1.deltas.join(", ")} × ${c1.time_base})`);
  const da = durOf(fvid, "a:0"), dv = durOf(fvid, "v:0");
  ok(Math.abs(da - dv) < 0.1, `son présent et de même longueur que l'image (son ${da.toFixed(3)} s, image ${dv.toFixed(3)} s)`);
  ok((await pg.textContent("#x-info")).includes("60 images/s"), `infos de la vidéo : « ${await pg.textContent("#x-info")} »`);
  await pg.waitForFunction(() => document.querySelector("#xv").readyState >= 1, null, { timeout: 15000 });
  ok(await pg.evaluate(() => document.querySelector("#xv").src.startsWith("reco://app/media/")), "lecture de la vidéo depuis le disque dans l'appli");
  await pg.evaluate(() => { const v = document.querySelector("#xv"); v.currentTime = 4; });
  await sleep(800);
  ok((await pg.evaluate(() => document.querySelector("#xv").currentTime)) > 3.5, "avance rapide dans la vidéo locale (lecture partielle)");
  // titre
  await pg.fill("#x-title", "Test local"); await pg.dispatchEvent("#x-title", "change"); await sleep(400);
  ok(await pg.isVisible("#x-cshare") && await pg.isVisible("#x-gshare") && await pg.isVisible("#x-retake"), "fin d'enregistrement : Google Drive, mon serveur Reco, et « Refaire »");
  ok((await pg.textContent("#x-gsub")).includes("Connexion à ton compte Google"), `sous-titre Drive : « ${await pg.textContent("#x-gsub")} »`);
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
  ok(remote.equals(fs.readFileSync(fvid)), `le fichier en ligne est identique à l'octet près au fichier du PC (${(remote.length / 1e6).toFixed(1)} Mo)`);
  const page = await (await fetch(clink)).text();
  ok(page.includes("Test local") && (await fetch(`http://localhost:8787/t/${cid}`)).status === 200, "page de partage avec le titre et la miniature");
  ok((await pg.textContent("#cloud-st")).includes("localhost:8787"), "serveur affiché comme connecté dans la fenêtre Partage");
  // partage Google Drive (simulé) en plus
  ok(!(await pg.evaluate(() => document.querySelector("#d-cloud").open)), "la fenêtre de connexion s'est refermée");
  ok(await pg.isVisible("#x-gshare"), "Google Drive reste proposé en plus");
  await pg.click("#x-gshare");
  await pg.waitForFunction(() => document.querySelector("#x-gshare").hidden && /Google Drive/.test(document.querySelector("#x-status").textContent), null, { timeout: 30000 });
  const link = await pg.inputValue("#x-link");
  ok(link.startsWith("http://localhost:8787/v/"), "le lien affiché reste celui de mon serveur (prioritaire)");
  const saved = JSON.parse(fs.readFileSync(path.join(VIDS, `${id}.json`), "utf8"));
  ok(saved.cloud?.link === clink && saved.drive?.link.startsWith("https://drive.google.com/file/d/"), "les deux liens (serveur + Drive) sont mémorisés avec la vidéo");
  ok((await pg.textContent("#drive-st")).includes("test@exemple.com") && (await pg.textContent("#sharing-sum")) === "Drive + serveur connectés", "Google Drive connecté, barre latérale à jour");
  await pg.click("#x-done"); await pg.waitForSelector(".vc");
  const card = await pg.textContent(`.vc[data-id="${id}"]`);
  ok(card.includes("Test local") && card.includes("En ligne"), "la bibliothèque affiche la vidéo, son titre et « En ligne »");

  // 2) écran seul, 1080p à 30 i/s (réglages mémorisés d'une fois sur l'autre), puis « Refaire » depuis l'écran de fin
  await pg.click("#b-new");
  ok((await pg.inputValue("#s-quality")) === "720" && await pg.getAttribute('#fpss [data-fps="60"]', "class") === "on", "les réglages de qualité sont mémorisés");
  await pg.click('.mode[data-mode="screen"]'); await pg.selectOption("#s-quality", "1080"); await pg.click('#fpss [data-fps="30"]');
  await pg.click("#b-prepare"); await pg.waitForSelector("#b-go:not([hidden])", { timeout: 20000 });
  let pp = app.waitForEvent("window"); await pg.click("#b-go"); let pip2 = await pp;
  await sleep(2400 + 2000); await pip2.click("#s");
  await waitSaved(pg, 2);
  const before = fs.readdirSync(VIDS).filter((f) => f.endsWith(".mp4") && f !== vid);
  ok(before.length === 1, "2e vidéo enregistrée");
  pg.once("dialog", (d) => d.accept());
  pp = app.waitForEvent("window");
  await pg.click("#x-retake");
  await pg.waitForSelector("#b-go:not([hidden])", { timeout: 20000 });
  ok(!fs.existsSync(path.join(VIDS, before[0])), "« Refaire » supprime la vidéo et prépare un nouvel enregistrement avec les mêmes réglages");
  await pg.click("#b-go"); pip2 = await pp;
  await sleep(2400 + 2000); await pip2.click("#p"); await sleep(1500); await pip2.click("#p"); await sleep(2000); // pause de 1,5 s au milieu
  await pip2.click("#s");
  await waitSaved(pg, 2);
  const v2 = fs.readdirSync(VIDS).find((f) => f.endsWith(".mp4") && f !== vid), f2 = path.join(VIDS, v2), c2 = cadence(f2);
  ok(c2.r_frame_rate === "30/1" && c2.deltas.length === 1 && +c2.height === 1080, `écran seul 1080p : ${c2.width}×${c2.height}, cadence fixe ${c2.r_frame_rate}, ${c2.frames} images`);
  const d2 = durOf(f2, "v:0"), a2 = durOf(f2, "a:0");
  ok(d2 > 3.6 && d2 < 4.6 && Math.abs(a2 - d2) < 0.1, `la pause n'est pas dans la vidéo : ${d2.toFixed(2)} s d'image, ${a2.toFixed(2)} s de son (≈ 4 s attendues)`);
  await pg.click("#x-done"); await pg.waitForSelector(".vc");

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
