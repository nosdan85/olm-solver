'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('node:async_hooks');

const DATA_DIR = process.env.OLM_DATA_DIR || path.join(__dirname, '..', 'data');
const LICENSE_FILE = process.env.LICENSE_FILE || path.join(DATA_DIR, 'licenses.json');

// Map: key -> LicenseObject
const localLicenses = new Map();
const licenseScope = new AsyncLocalStorage();

function records() {
  return licenseScope.getStore() || localLicenses;
}

function withRecords(entries, callback) {
  const snapshot = new Map(entries.map((record) => [record.key, record]));
  const value = licenseScope.run(snapshot, callback);
  return { value, records: [...snapshot.values()] };
}

function ensureDataDir() {
  fs.mkdirSync(path.dirname(LICENSE_FILE), { recursive: true });
}

function normalizeName(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function formatRemaining(expiresAt) {
  if (expiresAt === null || expiresAt === undefined) return 'Vĩnh viễn';
  const diffMs = expiresAt - Date.now();
  if (diffMs <= 0) return 'Đã hết hạn';
  
  const days = Math.floor(diffMs / (24 * 3600 * 1000));
  const hours = Math.floor((diffMs % (24 * 3600 * 1000)) / (3600 * 1000));
  const minutes = Math.floor((diffMs % (3600 * 1000)) / (60 * 1000));

  if (days > 0) return `Còn ${days} ngày ${hours} giờ`;
  if (hours > 0) return `Còn ${hours} giờ ${minutes} phút`;
  return `Còn ${minutes} phút`;
}

function load() {
  ensureDataDir();
  if (fs.existsSync(LICENSE_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(LICENSE_FILE, 'utf8'));
      for (const [key, item] of Object.entries(raw)) {
        if (!item.nameNormalized && item.name) {
          item.nameNormalized = normalizeName(item.name);
        }
        records().set(key, item);
      }
      console.log(`[license-store] Loaded ${records().size} license(s) from disk`);
    } catch (err) {
      console.error(`[license-store] Failed to load licenses: ${err.message}`);
    }
  }

  // Fallback: If disk has 0 licenses, check process.env.LICENSES_BACKUP_JSON
  if (!fs.existsSync(LICENSE_FILE) && process.env.LICENSES_BACKUP_JSON) {
    try {
      const envRaw = JSON.parse(process.env.LICENSES_BACKUP_JSON);
      for (const [key, item] of Object.entries(envRaw)) {
        records().set(key, item);
      }
      console.log(`[license-store] Loaded ${records().size} license(s) from LICENSES_BACKUP_JSON env`);
      persist();
    } catch (e) {
      console.error(`[license-store] Failed to parse LICENSES_BACKUP_JSON: ${e.message}`);
    }
  }
}

let committed = new Map();

function persist() {
  if (licenseScope.getStore()) return;
  const file = LICENSE_FILE + '.tmp';
  try {
    ensureDataDir();
    fs.writeFileSync(file, JSON.stringify(Object.fromEntries(records()), null, 2), { mode: 0o600 });
    fs.renameSync(file, LICENSE_FILE);
    committed = structuredClone(records());
  } catch (err) {
    records().clear();
    for (const [key, item] of committed) records().set(key, structuredClone(item));
    throw err;
  }
}

function generateRandomKey(prefix) {
  const p1 = crypto.randomBytes(3).toString('hex').toUpperCase();
  const p2 = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `OLM-${prefix}-${p1}-${p2}`;
}

/**
 * Tạo key mới với số ngày tùy ý
 * @param {Object} opts
 * @param {string} opts.name Tên khách hàng / ghi nhớ
 * @param {number|string} opts.days Số ngày (ví dụ 1, 3, 7, 30, 90, 365, hoặc 'lifetime' / 0)
 * @param {string} opts.notes Ghi chú (Zalo, FB...)
 */
function createKey({ name, days = 30, type = null, notes = '' }) {
  if (typeof name !== 'string' || !name.trim() || name.length > 200 || typeof notes !== 'string' || notes.length > 2000) {
    throw new Error('Tên khách hàng không được để trống');
  }

  let durationDays = null;
  let prefix = '30D';
  let resolvedType = 'custom';

  if (type === 'lifetime' || days === 'lifetime' || days === 0) {
    durationDays = null;
    prefix = 'LIFE';
    resolvedType = 'lifetime';
  } else {
    let numDays = Number(days);
    if (type === '3_days' && (!days || days === 30)) numDays = 3;
    else if (type === '7_days' && (!days || days === 30)) numDays = 7;
    else if (type === '1_day' && (!days || days === 30)) numDays = 1;
    else if (type === '1_month' && (!days || days === 30)) numDays = 30;
    else if (type === '3_months' && (!days || days === 30)) numDays = 90;
    else if (type === '1_year' && (!days || days === 30)) numDays = 365;
    else if (!Number.isInteger(numDays) || numDays <= 0 || numDays > 36500) {
      throw new Error('Số ngày phải là số nguyên dương không quá 36500.');
    }

    durationDays = Math.round(numDays);
    prefix = `${durationDays}D`;
    resolvedType = type || `${durationDays}_days`;
  }

  let key = generateRandomKey(prefix);
  while (records().has(key)) {
    key = generateRandomKey(prefix);
  }

  const lic = {
    key,
    name: name.trim(),
    nameNormalized: normalizeName(name),
    olmUsername: null, // Tài khoản OLM liên kết khi kích hoạt
    hwid: null,        // Mã máy duy nhất
    deviceName: null,  // Tên máy sử dụng
    type: resolvedType,
    durationDays,
    createdAt: Date.now(),
    activatedAt: null,
    expiresAt: null,
    status: 'unused',  // 'unused' | 'active' | 'expired' | 'revoked'
    notes: notes ? notes.trim() : '',
    lastChecked: null,
  };

  records().set(key, lic);
  persist();
  return lic;
}

function getPublicInfo(lic) {
  const isExpired = Boolean(lic.expiresAt && Date.now() > lic.expiresAt);
  const status = lic.status === 'revoked'
    ? 'revoked'
    : isExpired
    ? 'expired'
    : lic.status;

  return {
    key: lic.key,
    name: lic.name,
    olmUsername: lic.olmUsername || null,
    hwid: lic.hwid || null,
    hwidMasked: lic.hwid ? `${lic.hwid.slice(0, 8)}...${lic.hwid.slice(-6)}` : null,
    deviceName: lic.deviceName || null,
    type: lic.type,
    durationDays: lic.durationDays,
    createdAt: lic.createdAt,
    activatedAt: lic.activatedAt,
    expiresAt: lic.expiresAt,
    status,
    remainingText: status === 'unused' ? 'Chưa tính thời hạn' : formatRemaining(lic.expiresAt),
    notes: lic.notes,
  };
}

/**
 * Kích hoạt bản quyền cho 1 tài khoản OLM trên 1 máy duy nhất
 */
function activate({ key, olmUsername, hwid, deviceName = '', name = '' }) {
  if (typeof key !== 'string' || !key.trim() || key.length > 200) {
    return { ok: false, error: 'Mã bản quyền (Key) không được để trống' };
  }
  if (typeof olmUsername !== 'string' || !olmUsername.trim() || olmUsername.length > 200) {
    return { ok: false, error: 'Tài khoản OLM không được để trống' };
  }
  if (typeof hwid !== 'string' || !hwid.trim() || hwid.length > 200 || hwid.includes('...')) {
    return { ok: false, error: 'Không nhận diện được mã thiết bị (HWID)' };
  }

  const lic = records().get(key.trim().toUpperCase());
  if (!lic) {
    return { ok: false, error: 'Mã bản quyền không tồn tại trên hệ thống' };
  }

  if (lic.status === 'revoked') {
    return { ok: false, error: 'Mã bản quyền này đã bị thu hồi bởi Quản trị viên' };
  }

  const cleanOlmUser = olmUsername.trim();
  const cleanHwid = hwid.trim();
  if (typeof deviceName !== 'string' || deviceName.length > 200 || typeof name !== 'string' || name.length > 200) {
    return { ok: false, error: 'Thông tin thiết bị không hợp lệ.' };
  }
  const cleanDevice = deviceName.trim() || 'Máy tính / Thiết bị';

  // 1. Kiểm tra ràng buộc tài khoản OLM (1 key chỉ dùng cho 1 acc OLM)
  if (lic.olmUsername && normalizeName(lic.olmUsername) !== normalizeName(cleanOlmUser)) {
    return {
      ok: false,
      error: `Key này đã được liên kết với tài khoản OLM "${lic.olmUsername}". Mỗi key chỉ dùng cho 1 tài khoản OLM duy nhất! Nếu muốn đổi tài khoản, vui lòng liên hệ Admin để xóa liên kết.`,
    };
  }

  // 2. Kiểm tra ràng buộc máy tính (1 key chỉ dùng cho 1 máy duy nhất)
  if (process.env.ENFORCE_HWID !== 'false') {
    if (lic.hwid && lic.hwid !== cleanHwid) {
      return {
        ok: false,
        error: `Key này đã được kích hoạt trên máy "${lic.deviceName || 'thiết bị khác'}". Mỗi key chỉ dùng cho 1 máy duy nhất! Vui lòng liên hệ Admin để reset máy nếu bạn vừa đổi thiết bị.`,
      };
    }
  }

  const now = Date.now();

  // 3. Nếu key đã kích hoạt từ trước: kiểm tra thời hạn
  if (lic.activatedAt && lic.expiresAt && now > lic.expiresAt) {
    lic.status = 'expired';
    persist();
    return {
      ok: false,
      error: 'Mã bản quyền đã hết hạn sử dụng. Vui lòng liên hệ Admin để gia hạn hoặc mua key mới!',
      expired: true,
      expiresAt: lic.expiresAt,
    };
  }

  // 4. Kích hoạt lần đầu nếu key chưa từng dùng
  if (!lic.activatedAt) {
    lic.activatedAt = now;
    if (!lic.expiresAt) lic.expiresAt = lic.durationDays ? now + lic.durationDays * 24 * 3600 * 1000 : null;
  }

  // Gán liên kết tài khoản OLM và máy tính
  lic.olmUsername = cleanOlmUser;
  lic.hwid = cleanHwid;
  lic.deviceName = cleanDevice;
  if (name && !lic.name) lic.name = name.trim();
  lic.status = 'active';
  lic.lastChecked = now;
  persist();

  return {
    ok: true,
    license: getPublicInfo(lic),
    message: `Kích hoạt thành công cho tài khoản "${cleanOlmUser}" trên máy "${cleanDevice}"!`,
  };
}

/**
 * Xác thực bản quyền liên tục trong quá trình hoạt động
 */
function verify({ key, olmUsername, hwid }) {
  if (typeof key !== 'string' || !key.trim() || key.length > 200) return { ok: false, valid: false, error: 'Chưa nhập mã bản quyền' };
  if (typeof hwid !== 'string' || !hwid.trim() || hwid.length > 200 || hwid.includes('...')) {
    return { ok: false, valid: false, error: 'Không nhận diện được mã máy (HWID)' };
  }

  const lic = records().get(key.trim().toUpperCase());
  if (!lic) {
    return { ok: false, valid: false, error: 'Mã bản quyền không tồn tại' };
  }

  if (lic.status === 'revoked') {
    return { ok: false, valid: false, error: 'Mã bản quyền đã bị thu hồi' };
  }

  const now = Date.now();

  // Kiểm tra thời hạn
  if (lic.expiresAt && now > lic.expiresAt) {
    lic.status = 'expired';
    persist();
    return {
      ok: false,
      valid: false,
      expired: true,
      error: 'Mã bản quyền đã hết hạn sử dụng. Vui lòng nhập mã bản quyền mới!',
      remainingText: 'Đã hết hạn',
    };
  }

  if (!lic.activatedAt || lic.status !== 'active' || !lic.olmUsername ||
      (process.env.ENFORCE_HWID !== 'false' && !lic.hwid)) {
    return { ok: false, valid: false, error: 'Mã bản quyền cần được kích hoạt.' };
  }
  if (!olmUsername || normalizeName(lic.olmUsername) !== normalizeName(olmUsername)) {
    return { ok: false, valid: false, error: 'Mã bản quyền thuộc về tài khoản OLM khác.' };
  }
  if (process.env.ENFORCE_HWID !== 'false' && lic.hwid !== hwid.trim()) {
    return { ok: false, valid: false, error: 'Mã bản quyền đang dùng trên thiết bị khác.' };
  }
  const prevLastChecked = lic.lastChecked || 0;
  lic.lastChecked = now;
  if (now - prevLastChecked > 60_000) {
    persist();
  }

  return {
    ok: true,
    valid: true,
    license: getPublicInfo(lic),
  };
}

function listAll() {
  const list = [];
  for (const lic of records().values()) {
    list.push({
      ...getPublicInfo(lic),
      fullHwid: lic.hwid,
      notes: lic.notes,
      lastChecked: lic.lastChecked,
    });
  }
  // Sắp xếp: active -> unused -> expired -> revoked, sau đó theo createdAt giảm dần
  list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return list;
}

/**
 * Gia hạn thêm số ngày cho key
 */
function extendKey(key, addDays = 30) {
  const lic = records().get(key.trim().toUpperCase());
  if (!lic) throw new Error('Không tìm thấy mã bản quyền');

  const daysNum = Number(addDays);
  if (!Number.isInteger(daysNum) || daysNum <= 0 || daysNum > 36500) {
    throw new Error('Số ngày gia hạn phải là số nguyên dương');
  }

  const now = Date.now();
  if (lic.status === 'revoked') throw new Error('Mã bản quyền đã bị thu hồi.');
  if (lic.type === 'lifetime') return getPublicInfo(lic);
  if (!lic.activatedAt) {
    lic.durationDays = (lic.durationDays ?? 0) + daysNum;
    persist();
    return getPublicInfo(lic);
  }
  const base = Math.max(lic.expiresAt || now, now);
  lic.expiresAt = base + daysNum * 24 * 3600 * 1000;
  lic.status = 'active';
  persist();
  return getPublicInfo(lic);
}

/**
 * Reset HWID để key có thể dùng trên máy khác
 */
function resetHwid(key) {
  const lic = records().get(key.trim().toUpperCase());
  if (!lic) throw new Error('Không tìm thấy mã bản quyền');

  lic.hwid = null;
  lic.deviceName = null;
  persist();
  return getPublicInfo(lic);
}

/**
 * Xóa liên kết giữa key và tài khoản OLM để key có thể dùng cho acc OLM khác
 */
function unbindOlm(key) {
  const lic = records().get(key.trim().toUpperCase());
  if (!lic) throw new Error('Không tìm thấy mã bản quyền');

  lic.olmUsername = null;
  persist();
  return getPublicInfo(lic);
}

function deleteKey(key) {
  const k = key.trim().toUpperCase();
  const deleted = records().delete(k);
  if (deleted) persist();
  return deleted;
}

function exportAll() {
  const out = {};
  for (const [key, item] of records()) {
    out[key] = item;
  }
  return out;
}

function importAll(data, { merge = true } = {}) {
  if (!data || typeof data !== 'object') {
    throw new Error('Dữ liệu khôi phục không hợp lệ');
  }

  const entries = Array.isArray(data) ? data.map((item) => [item?.key, item]) : Object.entries(data);
  if (!entries.length) throw new Error('Không tìm thấy dữ liệu license trong file');
  const next = new Map();
  for (const [rawKey, item] of entries) {
    const key = typeof rawKey === 'string' ? rawKey.trim().toUpperCase() : '';
    if (!key || !/^[A-Z0-9-]{1,200}$/.test(key) || !item || typeof item !== 'object' || Array.isArray(item) || next.has(key) ||
        (item.key != null && (typeof item.key !== 'string' || item.key.trim().toUpperCase() !== key)) ||
        ['name', 'olmUsername', 'hwid', 'deviceName', 'type', 'notes'].some((field) =>
          item[field] != null && (typeof item[field] !== 'string' || item[field].length > 2000)) ||
        ['createdAt', 'activatedAt', 'expiresAt', 'lastChecked', 'durationDays'].some((field) =>
          item[field] != null && (!Number.isSafeInteger(item[field]) || item[field] < 0)) ||
        (item.status && !['unused', 'active', 'expired', 'revoked'].includes(item.status))) {
      throw new Error('Tệp chứa bản ghi license không hợp lệ hoặc trùng key.');
    }
    next.set(key, {
      key, name: item.name || 'Khách hàng', nameNormalized: normalizeName(item.name),
      olmUsername: item.olmUsername || null, hwid: item.hwid || null, deviceName: item.deviceName || null,
      type: item.type || '30_days', durationDays: item.durationDays !== undefined ? item.durationDays : 30,
      createdAt: item.createdAt || Date.now(), activatedAt: item.activatedAt || null, expiresAt: item.expiresAt || null,
      status: item.status || 'unused', notes: item.notes || '', lastChecked: item.lastChecked || null,
    });
  }

  if (!merge) records().clear();
  for (const [key, item] of next) records().set(key, item);
  persist();
  return { count: next.size, total: records().size };
}

function clearAll() {
  records().clear();
  persist();
  return true;
}

// Auto-load on require
if (!process.env.DATABASE_URL) load();
committed = structuredClone(records());

module.exports = {
  withRecords,
  createKey,
  activate,
  verify,
  listAll,
  extendKey,
  resetHwid,
  unbindOlm,
  deleteKey,
  clearAll,
  formatRemaining,
  exportAll,
  importAll,
};
