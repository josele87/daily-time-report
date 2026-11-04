// Tiny JSON-file store (zero dependencies): overrides, settings, status log, share token, cached activity.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function createStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'store.json');
  let data = { overrides: {}, settings: {}, statusLog: [], cache: {}, shareToken: null };
  if (fs.existsSync(file)) { try { data = { ...data, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* corrupt file: start fresh */ } }
  if (!data.shareToken) data.shareToken = crypto.randomBytes(16).toString('hex');
  let timer;
  const save = () => { clearTimeout(timer); timer = setTimeout(() => fs.writeFileSync(file + '.tmp', JSON.stringify(data)) || fs.renameSync(file + '.tmp', file), 50); };
  save();
  return {
    get data() { return data; },
    setOverride(date, o) { data.overrides[date] = o; save(); },
    deleteOverride(date) { delete data.overrides[date]; save(); },
    setSettings(s) { data.settings = { ...data.settings, ...s }; save(); },
    logStatus(ev) { data.statusLog.push(ev); if (data.statusLog.length > 20000) data.statusLog.shift(); save(); },
    setCache(date, v) { data.cache[date] = v; save(); },
    rotateShareToken() { data.shareToken = crypto.randomBytes(16).toString('hex'); save(); return data.shareToken; },
  };
}
module.exports = { createStore };
