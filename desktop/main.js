// Reco Desktop — appli autonome : les vidéos sont enregistrées sur le PC (dossier Vidéos/Reco) et partagées par Google Drive.
// (Mode serveur optionnel : RECO_SERVER=https://… ou config.server, pour utiliser un serveur Reco Cloudflare.)
// Ajoute ce que le navigateur ne sait pas faire : sélecteur d'écran/fenêtre, son de l'ordinateur (Windows),
// fenêtre de contrôle toujours au premier plan et INVISIBLE dans l'enregistrement, icône de barre système, raccourci.
const { app, BrowserWindow, session, desktopCapturer, ipcMain, shell, Tray, Menu, globalShortcut, nativeImage } = require("electron");
const path = require("path");
const fs = require("fs");
const local = require("./local");
const drive = require("./drive");
const cloud = require("./cloud");

const TEST = process.env.RECO_TEST === "1";
if (TEST) {
  app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
  app.commandLine.appendSwitch("use-fake-device-for-media-stream");
}
if (process.env.RECO_USERDATA) app.setPath("userData", process.env.RECO_USERDATA); // profil isolé (tests)
if (!app.requestSingleInstanceLock()) app.quit();
local.registerScheme();

const ICON = path.join(__dirname, "assets", "icon.png");
const CFG = () => path.join(app.getPath("userData"), "config.json");
const DEFAULTS = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, "default-server.json"), "utf8")); } catch { return {}; } })();
const loadCfg = () => { try { return JSON.parse(fs.readFileSync(CFG(), "utf8")); } catch { return {}; } };
const saveCfg = (c) => fs.writeFileSync(CFG(), JSON.stringify(c, null, 2));
const serverUrl = () => process.env.RECO_SERVER || loadCfg().server || "";
const LOCAL_MODE = () => !serverUrl();

let win = null, tray = null;

function origin(u) { try { return new URL(u).origin; } catch { return ""; } }

function createMain() {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 900, minHeight: 600, title: "Reco", icon: ICON,
    backgroundColor: "#fdfdfd", autoHideMenuBar: true, show: false,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true,
      additionalArguments: LOCAL_MODE() ? ["--reco-local"] : [] },
  });
  win.once("ready-to-show", () => win.show());
  openServer();

  // fenêtres ouvertes par la page : la mini-fenêtre de contrôle (même origine) ; tout le reste part dans le navigateur
  win.webContents.setWindowOpenHandler(({ url, frameName }) => {
    if (frameName === "reco-pip") {
      return { action: "allow", overrideBrowserWindowOptions: {
        width: 270, height: 350, minWidth: 220, minHeight: 140, alwaysOnTop: true, title: "Reco", icon: ICON,
        backgroundColor: "#1c1917", autoHideMenuBar: true, minimizable: false, maximizable: false, fullscreenable: false } };
    }
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("did-create-window", (child) => {
    child.setAlwaysOnTop(true, "screen-saver");
    child.setContentProtection(true); // la fenêtre de contrôle n'apparaît pas dans la vidéo
    const { width } = require("electron").screen.getPrimaryDisplay().workAreaSize;
    child.setPosition(width - 300, 40);
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (url.startsWith("file:") || url.startsWith("reco:")) return;
    if (origin(url) !== origin(serverUrl())) { e.preventDefault(); shell.openExternal(url); }
  });
  win.on("close", (e) => { if (!app.isQuitting && tray) { e.preventDefault(); win.hide(); } });
}

function openServer() {
  const s = serverUrl();
  if (s) win.loadURL(s);
  else win.loadURL("reco://app/index.html");
}

// ── sélecteur d'écran / de fenêtre (remplace celui du navigateur) ──
function pickSource(sources) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const p = new BrowserWindow({
      parent: win, modal: true, width: 920, height: 640, title: "Que veux-tu partager ?", icon: ICON, backgroundColor: "#fdfdfd",
      autoHideMenuBar: true, minimizable: false, webPreferences: { preload: path.join(__dirname, "picker-preload.js"), contextIsolation: true, sandbox: true },
    });
    const data = sources.map((s) => ({ id: s.id, name: s.name, screen: s.id.startsWith("screen:"), thumb: s.thumbnail.toDataURL() }));
    p.loadFile(path.join(__dirname, "picker.html"));
    p.webContents.once("did-finish-load", () => p.webContents.send("sources", data));
    const onPick = (e, id) => { if (e.sender === p.webContents) { ipcMain.removeListener("picked", onPick); finish(sources.find((s) => s.id === id) || null); p.close(); } };
    ipcMain.on("picked", onPick);
    p.on("closed", () => { ipcMain.removeListener("picked", onPick); finish(null); });
  });
}

function setupCapture() {
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = (await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 400, height: 225 } }))
        .filter((s) => !/^Reco$|Que veux-tu partager/.test(s.name));
      const choice = TEST ? (sources.find((s) => s.id.startsWith("screen:")) || sources[0]) : await pickSource(sources);
      if (!choice) return callback({});
      const audio = request.audioRequested && process.platform === "win32" ? "loopback" : undefined; // son de l'ordinateur
      callback(audio ? { video: choice, audio } : { video: choice });
    } catch (err) {
      console.error(err);
      callback({});
    }
  });
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(["media", "display-capture", "clipboard-sanitized-write", "clipboard-read", "fullscreen"].includes(perm)));
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, "assets", "tray.png")));
  tray.setToolTip("Reco");
  const showWin = () => { win.show(); win.focus(); };
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Ouvrir Reco", click: showWin },
    { label: "Nouvel enregistrement   Ctrl+Maj+R", click: () => { showWin(); win.webContents.executeJavaScript('document.querySelector("#b-new")?.click()'); } },
    { type: "separator" },
    { label: "Ouvrir le dossier des vidéos", click: () => shell.openPath(local.videosDir()) },
    { label: "Quitter", click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  tray.on("click", showWin);
}

// ── messages de la page ──
ipcMain.handle("set-server", async (e, url) => {
  let u;
  try { u = new URL(url); } catch { return { ok: false, error: "Adresse invalide." }; }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, error: "L'adresse doit commencer par https://" };
  try { const r = await fetch(`${u.origin}/api/me`); if (r.status !== 200 && r.status !== 401) throw new Error(); } catch { return { ok: false, error: "Aucun serveur Reco ne répond à cette adresse." }; }
  const c = loadCfg(); c.server = u.origin; saveCfg(c); openServer();
  return { ok: true };
});
ipcMain.on("recording", (e, on) => { if (!win) return; if (on) win.minimize(); else { win.restore(); win.show(); win.focus(); } });

app.on("second-instance", () => { if (win) { win.show(); win.focus(); } });
app.whenReady().then(() => {
  app.setAppUserModelId("app.reco.desktop");
  setupCapture();
  local.handleProtocol();
  local.register({ loadCfg, saveCfg });
  drive.register({ loadCfg, saveCfg, win: () => win });
  cloud.register({ loadCfg, saveCfg });
  createMain();
  createTray();
  globalShortcut.register("CommandOrControl+Shift+R", () => {
    win.show(); win.focus();
    win.webContents.executeJavaScript(`(() => { const s = document.querySelector("#r-stop"); if (s && !document.querySelector("#v-rec").hidden) s.click(); else document.querySelector("#b-new")?.click(); })()`);
  });
});
app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
