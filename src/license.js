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
  if (!key || !key.trim()) {
    return { passed: false, msg: 'License key required.' };
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
      if (msg === 'key_expired') return { passed: false, msg: 'License duration expired.' };
      if (msg === 'hwid_mismatch') return { passed: false, msg: 'Key registered to another workstation.' };
      if (msg === 'key_inactive') return { passed: false, msg: 'License deactivated.' };
      if (msg === 'key_not_found') return { passed: false, msg: 'Key not found.' };
      return { passed: false, msg: `Denied: ${msg}` };
    }
    return { passed: false, msg: 'Connection to auth node failed.' };
  }
}

module.exports = {
  verifyKey,
  getSavedKey,
  saveKey,
  removeKey
};
