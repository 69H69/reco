// Captures de l'interface à plusieurs tailles de fenêtre (contrôle visuel de la mise en page).
// node shots.mjs <dossier de sortie> [largeurxhauteur ...]
import { _electron as electron } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const out = process.argv[2] || "shots"; fs.mkdirSync(out, { recursive: true });
const sizes = (process.argv.slice(3).length ? process.argv.slice(3) : ["1280x820", "1000x700", "800x600", "700x560"]).map((s) => s.split("x").map(Number));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reco-shots-"));
const app = await electron.launch({ args: ["."], cwd: path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")),
  env: { ...process.env, RECO_TEST: "1", RECO_SERVER: "", RECO_USERDATA: path.join(tmp, "p"), RECO_VIDEOS_DIR: path.join(tmp, "v"), RECO_DRIVE_MOCK: process.env.MOCK || "" } });
const pg = await app.firstWindow();
await pg.waitForSelector("#v-lib:not([hidden])");
const views = { lib: async () => { await pg.evaluate(() => document.querySelector("#b-cancel")?.click()); await pg.waitForSelector("#v-lib:not([hidden])"); },
  setup: async () => { await pg.click("#b-new"); await pg.waitForSelector("#v-setup:not([hidden])"); await pg.waitForTimeout(600); },
  sharing: async () => { await pg.click("#b-sharing"); await pg.waitForSelector("#d-sharing[open]"); },
  gsetup: async () => { await pg.click("#gd-setup"); await pg.waitForSelector("#d-gsetup[open]"); },
  review: async () => { await pg.evaluate(() => document.querySelectorAll("dialog[open]").forEach((d) => d.close())); },
  review2: async () => { await pg.evaluate(() => { document.querySelectorAll(".view").forEach((v) => (v.hidden = v.id !== "v-review")); document.querySelector("#mtop").hidden = true; ["#x-cshare", "#x-gshare", "#x-reveal", "#x-retake"].forEach((s) => { const e = document.querySelector(s); if (e) e.hidden = false; }); }); } };
for (const [w, h] of sizes) {
  await app.evaluate(({ BrowserWindow }, [w, h]) => { const b = BrowserWindow.getAllWindows()[0]; b.setMinimumSize(300, 300); b.setSize(w, h); }, [w, h]);
  await pg.waitForTimeout(400);
  for (const [k, f] of Object.entries(views)) { await f(); if (k === "review") continue; await pg.screenshot({ path: path.join(out, `${k}-${w}x${h}.png`) }); }
}
await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
