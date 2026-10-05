// Vérifie qu'une appli compilée démarre : node smoke.mjs <chemin de l'exécutable>
import { _electron as electron } from "playwright";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const exe = process.argv[2];
const app = await electron.launch({ executablePath: exe, env: { ...process.env, RECO_USERDATA: fs.mkdtempSync(path.join(os.tmpdir(), "reco-smoke-")) }, timeout: 60000 });
const pg = await app.firstWindow();
await pg.waitForSelector("#u", { timeout: 30000 });
const info = await app.evaluate(({ app }) => ({ name: app.getName(), version: app.getVersion(), electron: process.versions.electron, platform: process.platform, arch: process.arch }));
console.log("OK   l'appli démarre sur l'écran de premier lancement :", JSON.stringify(info));
await app.close();
