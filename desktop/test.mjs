// End-to-end test of the desktop app in LOCAL MODE (videos on the computer + simulated Google Drive sharing).
// Run: node test.mjs   (or RECO_EXE=dist/win-unpacked/Reco.exe node test.mjs)   with `npx wrangler dev --port 8787 --local` running at the repo root (for "my server" publishing)
import { _electron as electron } from "playwright";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ok = (c, m) => { console.log((c ? "OK   " : "FAIL ") + m); if (!c) { process.exitCode = 1; throw new Error(m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reco-local-"));
const VIDS = path.join(tmp, "videos");
const probe = (f, args) => JSON.parse(execFileSync("ffprobe", ["-v", "error", ...args, "-of", "json", f]).toString());
// constant frame rate: every gap between frames is exactly 1/fps
function cadence(f) {
  const v = probe(f, ["-select_streams", "v:0", "-show_entries", "stream=r_frame_rate,avg_frame_rate,width,height,codec_name:packet=pts", "-show_entries", "stream=time_base"]);
  const pts = v.packets.map((p) => +p.pts).sort((a, b) => a - b), d = new Set(pts.slice(1).map((x, i) => x - pts[i]));
  return { ...v.streams[0], frames: pts.length, deltas: [...d] };
}
// waits until writing is done: n finished videos in the folder (no .part) and the end screen shown
async function waitSaved(pg, n) {
  for (let i = 0; i < 150; i++) {
    const f = fs.readdirSync(VIDS);
    if (f.filter((x) => x.endsWith(".mp4")).length === n && !f.some((x) => x.endsWith(".part")) && await pg.isVisible("#x-info") && /fps/.test(await pg.textContent("#x-info"))) return;
    await sleep(200);
  }
  throw new Error("video never finalized");
}
const durOf = (f, sel) => +probe(f, ["-select_streams", sel, "-show_entries", "stream=duration"]).streams[0].duration;

// RECO_EXE=dist/win-unpacked/Reco.exe: tests the built app instead of the sources
const env = { ...process.env, RECO_TEST: "1", RECO_SERVER: "", RECO_USERDATA: path.join(tmp, "profile"), RECO_VIDEOS_DIR: VIDS, RECO_DRIVE_MOCK: "1" };
const app = await electron.launch(process.env.RECO_EXE ? { executablePath: process.env.RECO_EXE, env }
  : { args: ["."], cwd: path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")), env });
try {
  const pg = await app.firstWindow();
  pg.on("console", (m) => { if (m.type() === "error") console.log("   [page]", m.text()); });
  await pg.waitForSelector("#v-lib:not([hidden])", { timeout: 30000 });
  ok(pg.url().startsWith("reco://app/"), `UI bundled in the app (${pg.url()}), no server`);
  ok(await pg.isVisible("#shell") && !(await pg.isVisible("#v-login")), "no sign-in screen");
  ok((await pg.textContent("#lib-title")) === "My videos" && (await pg.textContent("#b-new")).includes("Record"), "UI in English");
  ok((await pg.textContent("#sharing-sum")) === "not set up", "sidebar: “Sharing — not set up”");
  await pg.click("#b-sharing"); await pg.waitForSelector("#d-sharing[open]");
  ok((await pg.textContent("#drive-st")).includes("just connect your Google account") && await pg.isVisible("#gd-c"), "Sharing dialog: Google Drive ready, “Connect” button visible");
  await pg.click("#d-sharing [data-close]");

  // 1) screen + camera, 720p at 60 fps, with “Restart” during the recording
  await pg.click("#b-new"); await pg.click('.mode[data-mode="screen+cam"]');
  await pg.selectOption("#s-quality", "720"); await pg.click('#fpss [data-fps="60"]');
  ok((await pg.textContent("#q-hint")).includes("60 frames per second"), `settings shown: “${await pg.textContent("#q-hint")}”`);
  await pg.click("#b-prepare");
  await pg.waitForSelector("#b-go:not([hidden])", { timeout: 20000 });
  const pipP = app.waitForEvent("window"); await pg.click("#b-go"); const pip = await pipP;
  await sleep(2400 + 3000);
  const first = fs.readdirSync(VIDS).find((f) => f.endsWith(".part"));
  ok(first && fs.statSync(path.join(VIDS, first)).size > 0, `the video is written to disk WHILE recording (${first}, ${(fs.statSync(path.join(VIDS, first)).size / 1e6).toFixed(1)} MB)`);
  ok((await pip.textContent("#rt")).includes("Restart"), "mini window in English");
  await pip.click("#rt"); // Restart
  await sleep(600);
  ok(!fs.existsSync(path.join(VIDS, first)), "“Restart” deletes the first take from disk");
  await sleep(2400 + 6000);
  await pip.click("#s");
  await pg.waitForFunction(() => document.querySelector("#x-status").textContent.includes("Saved on your computer"), null, { timeout: 30000 });
  let files = fs.readdirSync(VIDS);
  const vid = files.find((f) => /\.mp4$/.test(f)), id = vid.split(".")[0], fvid = path.join(VIDS, vid);
  ok(files.length === 3 && files.includes(`${id}.json`) && files.includes(`${id}.jpg`), `a single video kept, the 2nd take: ${files.join(", ")}`);
  const meta = JSON.parse(fs.readFileSync(path.join(VIDS, `${id}.json`), "utf8"));
  ok(meta.duration > 5 && meta.duration < 7.5 && meta.fps === 60 && meta.height === 720, `duration ${meta.duration.toFixed(2)} s (2nd take only), ${meta.width}×${meta.height} at ${meta.fps} fps`);
  const c1 = cadence(fvid);
  ok(c1.codec_name === "h264" && c1.r_frame_rate === "60/1" && c1.avg_frame_rate === "60/1", `H.264, frame rate ${c1.r_frame_rate} (average ${c1.avg_frame_rate})`);
  ok(c1.deltas.length === 1, `CONSTANT frame rate: ${c1.frames} frames, a single gap between frames (${c1.deltas.join(", ")} × ${c1.time_base})`);
  const da = durOf(fvid, "a:0"), dv = durOf(fvid, "v:0");
  ok(Math.abs(da - dv) < 0.1, `audio present and as long as the video (audio ${da.toFixed(3)} s, video ${dv.toFixed(3)} s)`);
  ok((await pg.textContent("#x-info")).includes("60 fps"), `video info: “${await pg.textContent("#x-info")}”`);
  await pg.waitForFunction(() => document.querySelector("#xv").readyState >= 1, null, { timeout: 15000 });
  ok(await pg.evaluate(() => document.querySelector("#xv").src.startsWith("reco://app/media/")), "the video plays from disk inside the app");
  await pg.evaluate(() => { const v = document.querySelector("#xv"); v.currentTime = 4; });
  await sleep(800);
  ok((await pg.evaluate(() => document.querySelector("#xv").currentTime)) > 3.5, "seeking in the local video (partial reads)");
  // title
  await pg.fill("#x-title", "Local test"); await pg.dispatchEvent("#x-title", "change"); await sleep(400);
  ok(await pg.isVisible("#x-cshare") && await pg.isVisible("#x-gshare") && await pg.isVisible("#x-retake"), "end of recording: Google Drive, my Reco server, and “Redo”");
  ok((await pg.textContent("#x-gsub")).includes("Sign in to Google"), `Drive subtitle: “${await pg.textContent("#x-gsub")}”`);
  // publishing to "my Reco server" (local test server standing in for a Cloudflare server)
  await pg.click("#x-cshare");
  await pg.waitForSelector("#d-cloud[open]");
  await pg.fill("#c-url", "http://localhost:8787"); await pg.fill("#c-name", "Alex"); await pg.fill("#c-code", "wrong"); await pg.click("#c-go");
  await pg.waitForFunction(() => document.querySelector("#c-err").textContent.length > 0);
  const cerr = await pg.textContent("#c-err");
  ok(cerr === "Wrong invite code.", `wrong code rejected with a clear message: “${cerr}”`);
  await pg.fill("#c-code", "test-local-123"); await pg.click("#c-go");
  await pg.waitForSelector("#x-share:not([hidden])", { timeout: 60000 });
  const clink = await pg.inputValue("#x-link"), cid = clink.split("/").pop();
  ok(clink.startsWith("http://localhost:8787/v/"), `published to my server: ${clink}`);
  const remote = Buffer.from(await (await fetch(`http://localhost:8787/f/${cid}`)).arrayBuffer());
  ok(remote.equals(fs.readFileSync(fvid)), `the online file is byte-identical to the file on the computer (${(remote.length / 1e6).toFixed(1)} MB)`);
  const page = await (await fetch(clink)).text();
  ok(page.includes("Local test") && page.includes("Copy link") && (await fetch(`http://localhost:8787/t/${cid}`)).status === 200, "share page (in English) with the title and thumbnail");
  ok((await pg.textContent("#cloud-st")).includes("localhost:8787"), "server shown as connected in the Sharing dialog");
  // Google Drive sharing (simulated) on top
  ok(!(await pg.evaluate(() => document.querySelector("#d-cloud").open)), "the sign-in dialog closed");
  ok(await pg.isVisible("#x-gshare"), "Google Drive is still offered as well");
  await pg.click("#x-gshare");
  await pg.waitForFunction(() => document.querySelector("#x-gshare").hidden && /Google Drive/.test(document.querySelector("#x-status").textContent), null, { timeout: 30000 });
  const link = await pg.inputValue("#x-link");
  ok(link.startsWith("http://localhost:8787/v/"), "the link shown stays the server one (takes priority)");
  const saved = JSON.parse(fs.readFileSync(path.join(VIDS, `${id}.json`), "utf8"));
  ok(saved.cloud?.link === clink && saved.drive?.link.startsWith("https://drive.google.com/file/d/"), "both links (server + Drive) are stored with the video");
  ok((await pg.textContent("#drive-st")).includes("test@example.com") && (await pg.textContent("#sharing-sum")) === "Drive + server connected", "Google Drive connected, sidebar up to date");
  await pg.click("#x-done"); await pg.waitForSelector(".vc");
  const card = await pg.textContent(`.vc[data-id="${id}"]`);
  ok(card.includes("Local test") && card.includes("Online"), "the library shows the video, its title and “Online”");

  // 2) screen only, 1080p at 30 fps (quality settings remembered), then “Redo” from the end screen
  await pg.click("#b-new");
  ok((await pg.inputValue("#s-quality")) === "720" && await pg.getAttribute('#fpss [data-fps="60"]', "class") === "on", "quality settings are remembered");
  await pg.click('.mode[data-mode="screen"]'); await pg.selectOption("#s-quality", "1080"); await pg.click('#fpss [data-fps="30"]');
  await pg.click("#b-prepare"); await pg.waitForSelector("#b-go:not([hidden])", { timeout: 20000 });
  let pp = app.waitForEvent("window"); await pg.click("#b-go"); let pip2 = await pp;
  await sleep(2400 + 2000); await pip2.click("#s");
  await waitSaved(pg, 2);
  const before = fs.readdirSync(VIDS).filter((f) => f.endsWith(".mp4") && f !== vid);
  ok(before.length === 1, "2nd video saved");
  pg.once("dialog", (d) => d.accept());
  pp = app.waitForEvent("window");
  await pg.click("#x-retake");
  await pg.waitForSelector("#b-go:not([hidden])", { timeout: 20000 });
  ok(!fs.existsSync(path.join(VIDS, before[0])), "“Redo” deletes the video and gets a new recording ready with the same settings");
  await pg.click("#b-go"); pip2 = await pp;
  await sleep(2400 + 2000); await pip2.click("#p"); await sleep(1500); await pip2.click("#p"); await sleep(2000); // 1.5 s pause in the middle
  await pip2.click("#s");
  await waitSaved(pg, 2);
  const v2 = fs.readdirSync(VIDS).find((f) => f.endsWith(".mp4") && f !== vid), f2 = path.join(VIDS, v2), c2 = cadence(f2);
  ok(c2.r_frame_rate === "30/1" && c2.deltas.length === 1 && +c2.height === 1080, `screen only 1080p: ${c2.width}×${c2.height}, constant ${c2.r_frame_rate}, ${c2.frames} frames`);
  const d2 = durOf(f2, "v:0"), a2 = durOf(f2, "a:0");
  ok(d2 > 3.6 && d2 < 4.6 && Math.abs(a2 - d2) < 0.1, `the pause is not in the video: ${d2.toFixed(2)} s of video, ${a2.toFixed(2)} s of audio (≈ 4 s expected)`);
  await pg.click("#x-done"); await pg.waitForSelector(".vc");

  // deletion
  pg.once("dialog", (d) => d.accept());
  await pg.hover(`.vc[data-id="${id}"]`); await pg.click(`.vc[data-id="${id}"] [data-act="del"]`);
  await pg.waitForFunction((i) => !document.querySelector(`.vc[data-id="${i}"]`), id);
  ok(!fs.readdirSync(VIDS).some((f) => f.startsWith(id)), "deleted from the library and from disk");
} finally {
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await sleep(1500);
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch { console.log("(temporary folder left behind: " + tmp + ")"); }
}
