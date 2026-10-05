// Pont minimal et sûr entre la page Reco et l'appli de bureau.
const { contextBridge, ipcRenderer, webUtils } = require("electron");
const inv = (c, ...a) => ipcRenderer.invoke(c, ...a);
contextBridge.exposeInMainWorld("recoDesktop", {
  platform: process.platform,
  local: process.argv.includes("--reco-local"), // vidéos sur le PC + partage Google Drive
  setServer: (url) => inv("set-server", url),
  recording: (on) => ipcRenderer.send("recording", !!on),
  lib: {
    me: () => inv("local:me"), setName: (n) => inv("local:setName", n), list: () => inv("local:list"),
    start: (ext) => inv("local:start", ext), chunk: (id, buf) => inv("local:chunk", id, buf), finish: (id, m) => inv("local:finish", id, m),
    abort: (id) => inv("local:abort", id), thumb: (id, buf) => inv("local:thumb", id, buf),
    importFile: (file, m) => inv("local:import", webUtils.getPathForFile(file), m),
    patch: (id, b) => inv("local:patch", id, b), del: (id) => inv("local:delete", id),
    reveal: (id) => inv("local:reveal", id), openFolder: () => inv("local:openFolder"),
  },
  drive: {
    status: () => inv("drive:status"), connect: () => inv("drive:connect"), disconnect: () => inv("drive:disconnect"),
    share: (id) => inv("drive:share", id), onProgress: (cb) => ipcRenderer.on("drive:progress", (e, d) => cb(d)),
  },
});
