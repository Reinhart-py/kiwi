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

function generateUniqueCsvPath(sourcePrefix, label) {
  const exportsDir = getExportsDir();
  const cleanLabel = (label || 'search')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .substring(0, 24);

  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const timeStr = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;

  let filename = `Kiri_${sourcePrefix}_${cleanLabel}_${dateStr}_${timeStr}.csv`;
  let fullPath = path.join(exportsDir, filename);

  let counter = 1;
  while (fs.existsSync(fullPath)) {
    filename = `Kiri_${sourcePrefix}_${cleanLabel}_${dateStr}_${timeStr}_${counter}.csv`;
    fullPath = path.join(exportsDir, filename);
    counter++;
  }

  return fullPath;
}

function sanitizeKeyword(raw) {
  if (!raw) return '';
  return String(raw)
    .trim()
    .replace(/^["']|["']$/g, '')
    .trim();
}

function parseRawKeywords(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return { valid: [], duplicatesCount: 0, emptyCount: 0, totalRead: 0 };
  }

  const lines = rawText.split(/\r?\n/);
  const seen = new Set();
  const valid = [];
  let duplicatesCount = 0;
  let emptyCount = 0;

  for (const line of lines) {
    const clean = sanitizeKeyword(line);
    if (!clean) {
      emptyCount++;
      continue;
    }

    const lower = clean.toLowerCase();
    if (lower === 'keyword' || lower === 'query' || lower === 'keywords' || lower === 'queries') {
      continue;
    }

    if (seen.has(lower)) {
      duplicatesCount++;
    } else {
      seen.add(lower);
      valid.push(clean);
    }
  }

  return {
    valid,
    duplicatesCount,
    emptyCount,
    totalRead: lines.length
  };
}

function parseBatchFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { valid: [], duplicatesCount: 0, emptyCount: 0, totalRead: 0 };
  }

  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.xlsx' || ext === '.xls') {
    try {
      const workbook = xlsx.readFile(filePath);
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rawRows = xlsx.utils.sheet_to_json(sheet, { header: 1 });
      const rawLines = [];

      for (const row of rawRows) {
        if (Array.isArray(row)) {
          const joined = row
            .map((cell) => (cell !== null && cell !== undefined ? String(cell).trim() : ''))
            .filter(Boolean)
            .join(' ');
          if (joined) rawLines.push(joined);
        }
      }

      return parseRawKeywords(rawLines.join('\n'));
    } catch {
      return { valid: [], duplicatesCount: 0, emptyCount: 0, totalRead: 0 };
    }
  }

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return parseRawKeywords(content);
  } catch {
    return { valid: [], duplicatesCount: 0, emptyCount: 0, totalRead: 0 };
  }
}

function readCsvPreview(filePath, maxRows = 25) {
  if (!filePath || !fs.existsSync(filePath)) return [];

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length <= 1) return [];

    const parseLine = (line) => {
      const tokens = [];
      let current = '';
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') {
          if (inQuotes && line[i + 1] === '"') {
            current += '"';
            i++;
          } else {
            inQuotes = !inQuotes;
          }
        } else if (c === ',' && !inQuotes) {
          tokens.push(current.trim());
          current = '';
        } else {
          current += c;
        }
      }
      tokens.push(current.trim());
      return tokens;
    };

    const headers = parseLine(lines[0]);
    const previewRows = [];

    for (let i = 1; i < lines.length && previewRows.length < maxRows; i++) {
      const cells = parseLine(lines[i]);
      const row = {};
      headers.forEach((h, idx) => {
        row[h] = cells[idx] || '';
      });
      previewRows.push(row);
    }

    return previewRows;
  } catch {
    return [];
  }
}

function getExistingLeadKeys(csvPath) {
  const existingSet = new Set();
  if (!csvPath || !fs.existsSync(csvPath)) return existingSet;

  try {
    const content = fs.readFileSync(csvPath, 'utf8');
    const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length <= 1) return existingSet;

    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(',');
      const title = (parts[0] || '').replace(/["']/g, '').trim().toLowerCase();
      const phone = (parts[1] || '').replace(/["']/g, '').trim();
      if (title || (phone && phone !== 'None')) {
        existingSet.add(`${title}::${phone}`);
      }
    }
  } catch {}

  return existingSet;
}

function getHistory() {
  const file = getHistoryFile();
  if (fs.existsSync(file)) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const data = JSON.parse(raw);
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }
  return [];
}

function saveHistoryItem(item) {
  const history = getHistory();
  const id = item.id || `task_${Date.now()}`;
  const record = {
    id,
    engine: item.engine,
    title: item.title,
    queries: item.queries || [],
    totalQueries: item.totalQueries || 1,
    completedQueries: item.completedQueries || 0,
    currentQueryIdx: item.currentQueryIdx || 0,
    totalSaved: item.totalSaved || 0,
    status: item.status || 'running',
    csvPath: item.csvPath || '',
    date: item.date || new Date().toISOString(),
    cap: item.cap || 0,
    noPhoneCount: item.noPhoneCount || 0,
    failedQueriesCount: item.failedQueriesCount || 0,
    config: item.config || {}
  };

  const filtered = history.filter((h) => h.id !== id);
  filtered.unshift(record);

  try {
    fs.writeFileSync(getHistoryFile(), JSON.stringify(filtered.slice(0, 50), null, 2), 'utf8');
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

function deleteHistoryItem(id) {
  const history = getHistory();
  const filtered = history.filter((h) => h.id !== id);
  try {
    fs.writeFileSync(getHistoryFile(), JSON.stringify(filtered, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
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
      if (data && (data.queries || data.target || data.query)) return data;
    } catch {
      return null;
    }
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
  generateUniqueCsvPath,
  parseRawKeywords,
  parseBatchFile,
  readCsvPreview,
  getExistingLeadKeys,
  getHistory,
  saveHistoryItem,
  updateHistoryRecord,
  deleteHistoryItem,
  saveActiveCheckpoint,
  getActiveCheckpoint,
  clearActiveCheckpoint
};
