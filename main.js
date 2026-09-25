const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { verifyKey, checkSavedLicense, removeKey } = require('./src/license');
const {
  getHistory,
  getActiveCheckpoint,
  clearActiveCheckpoint,
  getExportsDir,
  readCsvPreview,
  parseBatchFile
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
    width: 1240,
    height: 840,
    minWidth: 980,
    minHeight: 660,
    backgroundColor: '#09090b',
    autoHideMenuBar: true,
    show: false,
    icon: resolveAppIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
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

ipcMain.handle('storage:get-active-checkpoint', async () => {
  return getActiveCheckpoint();
});

ipcMain.handle('storage:dismiss-checkpoint', async () => {
  clearActiveCheckpoint();
  return true;
});

ipcMain.handle('results:preview', async (event, filePath) => {
  return readCsvPreview(filePath, 20);
});

ipcMain.handle('dialog:pick-batch-file', async () => {
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
  const queries = parseBatchFile(selectedPath);
  return {
    path: selectedPath,
    name: path.basename(selectedPath),
    queries
  };
});

ipcMain.handle('shell:open-link', async (event, url) => {
  if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://') || url.startsWith('mailto:'))) {
    await shell.openExternal(url);
  }
});

ipcMain.handle('shell:open-path', async (event, targetPath) => {
  if (!targetPath) return false;
  if (fs.existsSync(targetPath)) {
    await shell.openPath(targetPath);
    return true;
  }
  return false;
});

ipcMain.handle('shell:show-in-folder', async (event, targetPath) => {
  if (!targetPath) {
    const exportsDir = getExportsDir();
    await shell.openPath(exportsDir);
    return true;
  }
  if (fs.existsSync(targetPath)) {
    shell.showItemInFolder(targetPath);
    return true;
  }
  await shell.openPath(getExportsDir());
  return true;
});

ipcMain.handle('scraper:start-gmaps', async (event, config) => {
  if (activeTask && activeTask.isRunning) {
    return { success: false, message: 'A search is already in progress.' };
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
        mainWindow.webContents.send('scraper:error', err.message || 'Scraping failed.');
      }
    })
    .finally(() => {
      if (activeTask) activeTask.isRunning = false;
    });

  return { success: true };
});

ipcMain.handle('scraper:start-twogis', async (event, config) => {
  if (activeTask && activeTask.isRunning) {
    return { success: false, message: 'A search is already in progress.' };
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
        mainWindow.webContents.send('scraper:error', err.message || 'Scraping failed.');
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
