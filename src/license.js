const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { machineIdSync } = require('node-machine-id');
const { getAppDataDir } = require('./storage');

const API_URL = 'https://jules-api.vercel.app/api/validate';

function getHwid() {
  try {
    return machineIdSync({ original: true });
  } catch {
    return 'generic-hwid-' + process.platform;
  }
}

function getKeyFilePath() {
  return path.join(getAppDataDir(), 'license.key');
}

function getCacheFilePath() {
  return path.join(getAppDataDir(), 'license_session.json');
}

function getSavedKey() {
  const filePath = getKeyFilePath();
  if (fs.existsSync(filePath)) {
    try {
      return fs.readFileSync(filePath, 'utf8').trim();
    } catch {
      return '';
    }
  }
  return '';
}

function getCachedSession() {
  const cachePath = getCacheFilePath();
  if (fs.existsSync(cachePath)) {
    try {
      const raw = fs.readFileSync(cachePath, 'utf8');
      const data = JSON.parse(raw);
      if (data && data.passed && data.key) {
        return data;
      }
    } catch {}
  }
  return null;
}

function saveCachedSession(data) {
  try {
    fs.writeFileSync(getCacheFilePath(), JSON.stringify(data, null, 2), 'utf8');
  } catch {}
}

function saveKey(key) {
  try {
    fs.writeFileSync(getKeyFilePath(), key.trim(), 'utf8');
    return true;
  } catch {
    return false;
  }
}

function removeKey() {
  const keyPath = getKeyFilePath();
  const cachePath = getCacheFilePath();
  if (fs.existsSync(keyPath)) {
    try { fs.unlinkSync(keyPath); } catch {}
  }
  if (fs.existsSync(cachePath)) {
    try { fs.unlinkSync(cachePath); } catch {}
  }
}

function formatExpiry(isoString) {
  if (!isoString) return 'Lifetime';
  try {
    const exp = new Date(isoString);
    const now = new Date();
    const diffMs = exp.getTime() - now.getTime();
    if (diffMs <= 0) return 'Expired';
    const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    if (days > 3650) {
      return 'Lifetime';
    }
    const hours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const dateStr = exp.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    if (days > 0) return `${dateStr} (${days} days left)`;
    return `${dateStr} (${hours} hours left)`;
  } catch {
    return String(isoString).substring(0, 10);
  }
}

async function verifyKey(key) {
  const cleanKey = (key || '').trim();
  if (!cleanKey) {
    return { passed: false, msg: 'Please enter a key.' };
  }

  const hwid = getHwid();
  try {
    const res = await axios.post(
      API_URL,
      { key: cleanKey, hwid },
      { timeout: 5000 }
    );

    if (res.data && res.data.success) {
      const payload = {
        passed: true,
        key: cleanKey,
        owner: res.data.owner || 'User',
        expires: formatExpiry(res.data.expiresAt),
        rawExpires: res.data.expiresAt,
        verifiedAt: Date.now()
      };
      saveKey(cleanKey);
      saveCachedSession(payload);
      return payload;
    }

    removeKey();
    return { passed: false, msg: res.data.message || 'Key rejected.' };
  } catch (err) {
    if (err.response && err.response.data && err.response.data.message) {
      const msg = err.response.data.message;
      removeKey();
      if (msg === 'key_expired') return { passed: false, msg: 'This key has expired.' };
      if (msg === 'hwid_mismatch') return { passed: false, msg: 'Key is registered to another computer.' };
      if (msg === 'key_inactive') return { passed: false, msg: 'Key is deactivated.' };
      if (msg === 'key_not_found') return { passed: false, msg: 'Key not found.' };
      return { passed: false, msg: msg };
    }

    const cached = getCachedSession();
    if (cached && cached.key === cleanKey) {
      return cached;
    }

    return { passed: false, msg: 'Could not connect to server.' };
  }
}

async function checkSavedLicense() {
  const savedKey = getSavedKey();
  if (!savedKey) {
    return { passed: false, msg: '' };
  }

  const cached = getCachedSession();
  if (cached && cached.key === savedKey) {
    verifyKey(savedKey).catch(() => {});
    return cached;
  }

  return await verifyKey(savedKey);
}

module.exports = {
  verifyKey,
  checkSavedLicense,
  getSavedKey,
  saveKey,
  removeKey
};
