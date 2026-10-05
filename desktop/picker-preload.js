const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("picker", {
  onSources: (cb) => ipcRenderer.on("sources", (e, data) => cb(data)),
  pick: (id) => ipcRenderer.send("picked", id),
});
