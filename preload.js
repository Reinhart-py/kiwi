const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  checkSavedLicense: () => ipcRenderer.invoke('license:check-saved'),
  verifyLicense: (key) => ipcRenderer.invoke('license:verify', key),
  logoutLicense: () => ipcRenderer.invoke('license:logout'),

  getHistory: () => ipcRenderer.invoke('storage:get-history'),
  getActiveCheckpoint: () => ipcRenderer.invoke('storage:get-active-checkpoint'),
  dismissCheckpoint: () => ipcRenderer.invoke('storage:dismiss-checkpoint'),
  previewResults: (path) => ipcRenderer.invoke('results:preview', path),

  pickBatchFile: () => ipcRenderer.invoke('dialog:pick-batch-file'),
  openLink: (url) => ipcRenderer.invoke('shell:open-link', url),
  openPath: (path) => ipcRenderer.invoke('shell:open-path', path),
  showInFolder: (path) => ipcRenderer.invoke('shell:show-in-folder', path),

  startGmaps: (config) => ipcRenderer.invoke('scraper:start-gmaps', config),
  startTwoGis: (config) => ipcRenderer.invoke('scraper:start-twogis', config),
  stopScraper: () => ipcRenderer.invoke('scraper:stop'),

  onProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('scraper:progress', handler);
    return () => ipcRenderer.removeListener('scraper:progress', handler);
  },
  onLog: (callback) => {
    const handler = (_event, text) => callback(text);
    ipcRenderer.on('scraper:log', handler);
    return () => ipcRenderer.removeListener('scraper:log', handler);
  },
  onFinished: (callback) => {
    const handler = (_event, summary) => callback(summary);
    ipcRenderer.on('scraper:finished', handler);
    return () => ipcRenderer.removeListener('scraper:finished', handler);
  },
  onError: (callback) => {
    const handler = (_event, msg) => callback(msg);
    ipcRenderer.on('scraper:error', handler);
    return () => ipcRenderer.removeListener('scraper:error', handler);
  }
});
