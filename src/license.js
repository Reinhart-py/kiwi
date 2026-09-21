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

function saveKey(key) {
  const filePath = getKeyFilePath();
  try {
    fs.writeFileSync(filePath, key.trim(), 'utf8');
    return true;
  } catch {
    return false;
  }
}

function removeKey() {
  const filePath = getKeyFilePath();
  if (fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
    } catch {}
  }
}

function formatExpiry(isoString) {
  if (!isoString) return 'Lifetime License';
  try {
    const exp = new Date(isoString);
    const now = new Date();
    const diffMs = exp.getTime() - now.getTime();
    if (diffMs <= 0) return 'Expired';
    const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const dateStr = exp.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    if (days > 0) return `${dateStr} (${days} days left)`;
    return `${dateStr} (${hours} hours left)`;
  } catch {
    return isoString.substring(0, 10);
  }
}

async function verifyKey(key) {
  if (!key || !key.trim()) {
    return { passed: false, msg: 'Please enter a license key.' };
  }

  const hwid = getHwid();
  try {
    const res = await axios.post(
      API_URL,
      { key: key.trim(), hwid },
      { timeout: 7000 }
    );

    if (res.data && res.data.success) {
      return {
        passed: true,
        owner: res.data.owner || 'Subscriber',
        expires: formatExpiry(res.data.expiresAt),
        rawExpires: res.data.expiresAt
      };
    }

    return { passed: false, msg: res.data.message || 'Key rejected.' };
  } catch (err) {
    if (err.response && err.response.data && err.response.data.message) {
      const msg = err.response.data.message;
      if (msg === 'key_expired') return { passed: false, msg: 'This license has expired.' };
      if (msg === 'hwid_mismatch') return { passed: false, msg: 'Key is registered to another device.' };
      if (msg === 'key_inactive') return { passed: false, msg: 'This key has been deactivated.' };
      if (msg === 'key_not_found') return { passed: false, msg: 'Invalid license key.' };
      return { passed: false, msg: `Access denied: ${msg}` };
    }
    return { passed: false, msg: 'Could not reach license server. Check your internet connection.' };
  }
}

module.exports = {
  verifyKey,
  getSavedKey,
  saveKey,
  removeKey
};
