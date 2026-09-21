const { app } = require('electron');
const fs = require('fs');
const path = require('path');

function getAppDataDir() {
  const dir = path.join(app.getPath('userData'), 'Data');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getExportsDir() {
  const dir = path.join(app.getPath('downloads'), 'Kiri_Exports');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getHistoryFile() {
  return path.join(getAppDataDir(), 'history.json');
}

function getCheckpointFile() {
  return path.join(getAppDataDir(), 'checkpoint.json');
}

function getHistory() {
  const file = getHistoryFile();
  if (fs.existsSync(file)) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function saveHistoryItem(item) {
  const history = getHistory();
  const filtered = history.filter(
    (h) => !(h.engine === item.engine && h.target === item.target)
  );
  filtered.unshift(item);
  const sliced = filtered.slice(0, 25);
  try {
    fs.writeFileSync(getHistoryFile(), JSON.stringify(sliced, null, 2), 'utf8');
  } catch {}
}

function updateProgress(engine, target, step, totalSaved) {
  const history = getHistory();
  const existing = history.find(
    (h) => h.engine === engine && h.target === target
  );
  if (existing) {
    existing.lastStep = step;
    existing.totalSaved = totalSaved;
  } else {
    history.unshift({
      engine,
      target,
      lastStep: step,
      totalSaved,
      date: new Date().toISOString()
    });
  }
  try {
    fs.writeFileSync(getHistoryFile(), JSON.stringify(history.slice(0, 25), null, 2), 'utf8');
  } catch {}

  saveActiveCheckpoint({
    engine,
    target,
    lastStep: step,
    totalSaved
  });
}

function saveActiveCheckpoint(data) {
  try {
    fs.writeFileSync(getCheckpointFile(), JSON.stringify(data, null, 2), 'utf8');
  } catch {}
}

function getActiveCheckpoint() {
  const file = getCheckpointFile();
  if (fs.existsSync(file)) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const data = JSON.parse(raw);
      if (data && data.target) return data;
    } catch {}
  }
  return null;
}

function clearActiveCheckpoint() {
  const file = getCheckpointFile();
  if (fs.existsSync(file)) {
    try {
      fs.unlinkSync(file);
    } catch {}
  }
}

module.exports = {
  getAppDataDir,
  getExportsDir,
  getHistory,
  saveHistoryItem,
  updateProgress,
  getActiveCheckpoint,
  clearActiveCheckpoint
};
