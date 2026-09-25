const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  checkSavedLicense: () => ipcRenderer.invoke('license:check-saved'),
  verifyLicense: (key) => ipcRenderer.invoke('license:verify', key),
  logoutLicense: () => ipcRenderer.invoke('license:logout'),

  getHistory: () => ipcRenderer.invoke('storage:get-history'),
  deleteHistory: (id) => ipcRenderer.invoke('storage:delete-history', id),
  getActiveCheckpoint: () => ipcRenderer.invoke('storage:get-active-checkpoint'),
  dismissCheckpoint: () => ipcRenderer.invoke('storage:dismiss-checkpoint'),
  previewCsv: (path) => ipcRenderer.invoke('storage:preview-csv', path),

  pickFile: () => ipcRenderer.invoke('dialog:pick-file'),
  parseFilePath: (path) => ipcRenderer.invoke('file:parse-path', path),
  parseRawText: (text) => ipcRenderer.invoke('file:parse-text', text),

  openLink: (url) => ipcRenderer.invoke('shell:open-link', url),
  openFile: (path) => ipcRenderer.invoke('shell:open-file', path),
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
  onFailed: (callback) => {
    const handler = (_event, err) => callback(err);
    ipcRenderer.on('scraper:failed', handler);
    return () => ipcRenderer.removeListener('scraper:failed', handler);
  }
});
