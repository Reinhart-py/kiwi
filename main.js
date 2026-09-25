const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { verifyKey, checkSavedLicense, removeKey } = require('./src/license');
const {
  getHistory,
  deleteHistoryItem,
  getActiveCheckpoint,
  clearActiveCheckpoint,
  getExportsDir,
  readCsvPreview,
  parseBatchFile,
  parseRawKeywords
} = require('./src/storage');
const { runGmaps } = require('./src/scraper-gmaps');
const { runTwoGis } = require('./src/scraper-2gis');

let mainWindow = null;
let activeTask = null;

function resolveAppIcon() {
  const pngPath = path.join(__dirname, 'images', 'logo.png');
  const icoPath = path.join(__dirname, 'images', 'icon.ico');
  if (fs.existsSync(pngPath)) return pngPath;
  if (fs.existsSync(icoPath)) return icoPath;
  return undefined;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1060,
    minHeight: 700,
    backgroundColor: '#09090b',
    autoHideMenuBar: true,
    show: false,
    icon: resolveAppIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('license:check-saved', async () => {
  return await checkSavedLicense();
});

ipcMain.handle('license:verify', async (event, key) => {
  return await verifyKey(key);
});

ipcMain.handle('license:logout', async () => {
  removeKey();
  return true;
});

ipcMain.handle('storage:get-history', async () => {
  return getHistory();
});

ipcMain.handle('storage:delete-history', async (event, id) => {
  return deleteHistoryItem(id);
});

ipcMain.handle('storage:get-active-checkpoint', async () => {
  return getActiveCheckpoint();
});

ipcMain.handle('storage:dismiss-checkpoint', async () => {
  clearActiveCheckpoint();
  return true;
});

ipcMain.handle('storage:preview-csv', async (event, filePath) => {
  return readCsvPreview(filePath, 25);
});

ipcMain.handle('file:parse-path', async (event, filePath) => {
  if (!filePath || !fs.existsSync(filePath)) {
    return { success: false, message: 'File not found.' };
  }
  const result = parseBatchFile(filePath);
  return {
    success: true,
    filename: path.basename(filePath),
    path: filePath,
    ...result
  };
});

ipcMain.handle('file:parse-text', async (event, rawText) => {
  const result = parseRawKeywords(rawText);
  return {
    success: true,
    ...result
  };
});

ipcMain.handle('dialog:pick-file', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'Spreadsheets & Text', extensions: ['csv', 'xlsx', 'xls', 'txt'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });

  if (res.canceled || !res.filePaths || res.filePaths.length === 0) {
    return null;
  }

  const selectedPath = res.filePaths[0];
  const parsed = parseBatchFile(selectedPath);
  return {
    path: selectedPath,
    filename: path.basename(selectedPath),
    ...parsed
  };
});

ipcMain.handle('shell:open-link', async (event, url) => {
  if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
    await shell.openExternal(url);
  }
});

ipcMain.handle('shell:open-file', async (event, targetPath) => {
  if (!targetPath) return false;
  if (fs.existsSync(targetPath)) {
    await shell.openPath(targetPath);
    return true;
  }
  return false;
});

ipcMain.handle('shell:show-in-folder', async (event, targetPath) => {
  if (targetPath && fs.existsSync(targetPath)) {
    shell.showItemInFolder(targetPath);
    return true;
  }
  await shell.openPath(getExportsDir());
  return true;
});

ipcMain.handle('scraper:start-gmaps', async (event, config) => {
  if (activeTask && activeTask.isRunning) {
    return { success: false, message: 'Another search is currently running.' };
  }

  activeTask = { isRunning: true, cancelled: false };

  const notifyProgress = (data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('scraper:progress', data);
    }
  };

  const notifyLog = (text) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('scraper:log', text);
    }
  };

  runGmaps(config, activeTask, notifyProgress, notifyLog)
    .then((summary) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('scraper:finished', summary);
      }
    })
    .catch((err) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('scraper:failed', {
          message: err.message || 'Scraping operation failed.'
        });
      }
    })
    .finally(() => {
      if (activeTask) activeTask.isRunning = false;
    });

  return { success: true };
});

ipcMain.handle('scraper:start-twogis', async (event, config) => {
  if (activeTask && activeTask.isRunning) {
    return { success: false, message: 'Another search is currently running.' };
  }

  activeTask = { isRunning: true, cancelled: false };

  const notifyProgress = (data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('scraper:progress', data);
    }
  };

  const notifyLog = (text) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('scraper:log', text);
    }
  };

  runTwoGis(config, activeTask, notifyProgress, notifyLog)
    .then((summary) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('scraper:finished', summary);
      }
    })
    .catch((err) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('scraper:failed', {
          message: err.message || 'Scraping operation failed.'
        });
      }
    })
    .finally(() => {
      if (activeTask) activeTask.isRunning = false;
    });

  return { success: true };
});

ipcMain.handle('scraper:stop', async () => {
  if (activeTask) {
    activeTask.cancelled = true;
  }
  return true;
});
