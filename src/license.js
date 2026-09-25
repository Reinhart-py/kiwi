const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { getAppDataDir } = require('./storage');

const API_URL = 'https://jules-api.vercel.app/api/validate';

function getDeviceIdFilePath() {
  return path.join(getAppDataDir(), 'device.id');
}

function getHwid() {
  const idPath = getDeviceIdFilePath();
  if (fs.existsSync(idPath)) {
    try {
      const stored = fs.readFileSync(idPath, 'utf8').trim();
      if (stored && stored.length >= 32) return stored;
    } catch {}
  }

  let mac = '';
  try {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const net of interfaces[name]) {
        if (!net.internal && net.mac && net.mac !== '00:00:00:00:00:00') {
          mac = net.mac;
          break;
        }
      }
      if (mac) break;
    }
  } catch {}

  const rawSeed = [
    mac || 'fallback-mac',
    os.hostname(),
    os.platform(),
    os.arch(),
    os.cpus().length,
    'KIRI-STATIC-DEVICE-SALT-2026'
  ].join('|');

  const generated = crypto.createHash('sha256').update(rawSeed).digest('hex');

  try {
    fs.writeFileSync(idPath, generated, 'utf8');
  } catch {}

  return generated;
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
  if (!isoString) return 'Permanent / Lifetime';
  try {
    const exp = new Date(isoString);
    const now = new Date();
    const diffMs = exp.getTime() - now.getTime();
    if (diffMs <= 0) return 'Expired';
    const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    if (days > 3650) {
      return 'Permanent / Lifetime';
    }
    const hours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const dateStr = exp.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    if (days > 0) return `${dateStr} (${days} days remaining)`;
    return `${dateStr} (${hours} hours remaining)`;
  } catch {
    return String(isoString).substring(0, 10);
  }
}

async function verifyKey(key) {
  const cleanKey = (key || '').trim();
  if (!cleanKey) {
    return { passed: false, msg: 'License key required.' };
  }

  const hwid = getHwid();
  try {
    const res = await axios.post(
      API_URL,
      { key: cleanKey, hwid },
      { timeout: 4000 }
    );

    if (res.data && res.data.success) {
      const payload = {
        passed: true,
        key: cleanKey,
        owner: res.data.owner || 'Subscriber',
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
      if (msg === 'key_expired') return { passed: false, msg: 'License duration expired.' };
      if (msg === 'hwid_mismatch') return { passed: false, msg: 'Key registered to another device.' };
      if (msg === 'key_inactive') return { passed: false, msg: 'License deactivated.' };
      if (msg === 'key_not_found') return { passed: false, msg: 'Key not found.' };
      return { passed: false, msg: `Denied: ${msg}` };
    }

    const cached = getCachedSession();
    if (cached && cached.key === cleanKey) {
      return cached;
    }

    return { passed: false, msg: 'Cannot contact license server.' };
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
