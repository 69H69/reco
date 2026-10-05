// Pont minimal et sûr entre la page Reco et l'appli de bureau.
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("recoDesktop", {
  platform: process.platform,
  setServer: (url) => ipcRenderer.invoke("set-server", url),
  recording: (on) => ipcRenderer.send("recording", !!on),
});
