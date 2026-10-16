const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("quantServerOff", {
  platform: process.platform,
  start: () => ipcRenderer.invoke("desktop.serverOff.start"),
  quit: () => ipcRenderer.invoke("desktop.serverOff.quit"),
});
