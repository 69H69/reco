// Checks that a built app starts: node smoke.mjs <path to the executable>
import { _electron as electron } from "playwright";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const exe = process.argv[2];
console.log("launching", exe);
setTimeout(() => { console.log("FAIL timed out"); process.exit(1); }, 120000).unref();
const app = await electron.launch({ executablePath: exe, env: { ...process.env, RECO_VIDEOS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "reco-smoke-v-")), RECO_USERDATA: fs.mkdtempSync(path.join(os.tmpdir(), "reco-smoke-")) }, timeout: 60000 });
const pg = await app.firstWindow();
await pg.waitForSelector("#shell:not([hidden])", { timeout: 30000 }); // local mode: the library shows up right away
const info = await app.evaluate(({ app }) => ({ name: app.getName(), version: app.getVersion(), electron: process.versions.electron, platform: process.platform, arch: process.arch }));
console.log("OK   the app starts and shows the local library:", JSON.stringify(info));
await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); // the app hides in the tray instead of closing: force quit
process.exit(0);
