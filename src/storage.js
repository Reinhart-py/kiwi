const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');

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

function parseBatchFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];

  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.xlsx' || ext === '.xls') {
    try {
      const workbook = xlsx.readFile(filePath);
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = xlsx.utils.sheet_to_json(sheet, { header: 1 });
      const items = [];
      for (const row of rows) {
        if (Array.isArray(row)) {
          const line = row.map((cell) => String(cell || '').trim()).filter(Boolean).join(' ');
          if (line && !line.toLowerCase().startsWith('query') && !line.toLowerCase().startsWith('keyword')) {
            items.push(line);
          }
        }
      }
      return items;
    } catch {
      return [];
    }
  }

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return content
      .split(/\r?\n/)
      .map((l) => l.trim().replace(/^["']|["']$/g, ''))
      .filter((l) => l && !l.toLowerCase().startsWith('query') && !l.toLowerCase().startsWith('keyword'));
  } catch {
    return [];
  }
}

function readCsvPreview(filePath, maxRows = 20) {
  if (!filePath || !fs.existsSync(filePath)) return [];

  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length <= 1) return [];

    const parseLine = (line) => {
      const result = [];
      let current = '';
      let insideQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
          if (insideQuotes && line[i + 1] === '"') {
            current += '"';
            i++;
          } else {
            insideQuotes = !insideQuotes;
          }
        } else if (char === ',' && !insideQuotes) {
          result.push(current.trim());
          current = '';
        } else {
          current += char;
        }
      }
      result.push(current.trim());
      return result;
    };

    const headers = parseLine(lines[0]);
    const rows = [];

    for (let i = 1; i < lines.length && rows.length < maxRows; i++) {
      const values = parseLine(lines[i]);
      const rowObj = {};
      headers.forEach((h, idx) => {
        rowObj[h] = values[idx] || '';
      });
      rows.push(rowObj);
    }

    return rows;
  } catch {
    return [];
  }
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
  const id = item.id || `${item.engine}_${Date.now()}`;
  const record = {
    id,
    engine: item.engine,
    target: item.target,
    label: item.label || item.target,
    totalQueries: item.totalQueries || 1,
    currentQueryIdx: item.currentQueryIdx || 0,
    totalSaved: item.totalSaved || 0,
    status: item.status || 'running',
    csvPath: item.csvPath || '',
    date: item.date || new Date().toISOString(),
    config: item.config || null,
    noPhoneCount: item.noPhoneCount || 0,
    failedCount: item.failedCount || 0
  };

  const filtered = history.filter((h) => h.id !== id && !(h.engine === record.engine && h.target === record.target && h.status === 'running'));
  filtered.unshift(record);

  try {
    fs.writeFileSync(getHistoryFile(), JSON.stringify(filtered.slice(0, 30), null, 2), 'utf8');
  } catch {}

  return record;
}

function updateHistoryRecord(id, updates) {
  const history = getHistory();
  const index = history.findIndex((h) => h.id === id);
  if (index !== -1) {
    history[index] = { ...history[index], ...updates };
    try {
      fs.writeFileSync(getHistoryFile(), JSON.stringify(history, null, 2), 'utf8');
    } catch {}
    return history[index];
  }
  return null;
}

function saveActiveCheckpoint(checkpoint) {
  try {
    fs.writeFileSync(getCheckpointFile(), JSON.stringify(checkpoint, null, 2), 'utf8');
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
  parseBatchFile,
  readCsvPreview,
  getHistory,
  saveHistoryItem,
  updateHistoryRecord,
  saveActiveCheckpoint,
  getActiveCheckpoint,
  clearActiveCheckpoint
};
