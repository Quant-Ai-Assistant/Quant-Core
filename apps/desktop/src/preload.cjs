const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("rakazoDesktop", {
  platform: process.platform,
  host: {
    state: () => ipcRenderer.invoke("desktop.host.state"),
    setKeepAwake: (on) => ipcRenderer.invoke("desktop.host.setKeepAwake", on),
    stopServer: () => ipcRenderer.invoke("desktop.host.stopServer"),
  },
  virtualDesktop: {
    state: () => ipcRenderer.invoke("desktop.virtualDesktop.state"),
    install: () => ipcRenderer.invoke("desktop.virtualDesktop.install"),
  },
  localSettings: {
    request: (pathname, body) =>
      ipcRenderer.invoke("desktop.localSettings.request", pathname, body),
  },
  window: {
    close: () => ipcRenderer.invoke("desktop.window.close"),
    minimize: () => ipcRenderer.invoke("desktop.window.minimize"),
    toggleMaximize: () => ipcRenderer.invoke("desktop.window.toggleMaximize"),
    state: () => ipcRenderer.invoke("desktop.window.state"),
  },
  update: {
    state: () => ipcRenderer.invoke("desktop.update.state"),
    check: () => ipcRenderer.invoke("desktop.update.check"),
    download: () => ipcRenderer.invoke("desktop.update.download"),
    install: () => ipcRenderer.invoke("desktop.update.install"),
  },
  edge: {
    state: () => ipcRenderer.invoke("desktop.edge.state"),
    check: () => ipcRenderer.invoke("desktop.edge.check"),
    apply: () => ipcRenderer.invoke("desktop.edge.apply"),
  },
  oauth: {
    open: (url) => ipcRenderer.invoke("desktop.oauth.open", url),
    cancel: (url) => ipcRenderer.invoke("desktop.oauth.cancel", url),
    onCallback: (listener) => {
      // The IpcRendererEvent stays in the preload: the renderer only sees the code.
      const handler = (_event, callback) => listener(callback);
      ipcRenderer.on("desktop.oauth.callback", handler);
      return () => ipcRenderer.off("desktop.oauth.callback", handler);
    },
  },
});
