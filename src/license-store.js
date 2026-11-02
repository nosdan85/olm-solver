'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const LICENSE_FILE = path.join(DATA_DIR, 'licenses.json');

// Map: key -> LicenseObject
const licenses = new Map();

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
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
  if (!fs.existsSync(LICENSE_FILE)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(LICENSE_FILE, 'utf8'));
    for (const [key, item] of Object.entries(raw)) {
      licenses.set(key, item);
    }
    console.log(`[license-store] Loaded ${licenses.size} license(s) from disk`);
  } catch (err) {
    console.error(`[license-store] Failed to load licenses: ${err.message}`);
  }
}

let persistTimer = null;
function persist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    ensureDataDir();
    const out = {};
    for (const [key, item] of licenses) {
      out[key] = item;
    }
    try {
      fs.writeFileSync(LICENSE_FILE, JSON.stringify(out, null, 2));
    } catch (err) {
      console.error(`[license-store] Failed to persist licenses: ${err.message}`);
    }
  }, 400);
}

function generateRandomKey(prefix) {
  const p1 = crypto.randomBytes(3).toString('hex').toUpperCase();
  const p2 = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `OLM-${prefix}-${p1}-${p2}`;
}

function createKey({ name, type = '1_month', notes = '' }) {
  if (!name || !name.trim()) {
    throw new Error('Tên khách hàng không được để trống');
  }

  let prefix = '30D';
  let durationDays = 30;
  if (type === '3_days') {
    prefix = '3D';
    durationDays = 3;
  } else if (type === 'lifetime') {
    prefix = 'LIFE';
    durationDays = null;
  } else {
    type = '1_month';
  }

  let key = generateRandomKey(prefix);
  while (licenses.has(key)) {
    key = generateRandomKey(prefix);
  }

  const lic = {
    key,
    name: name.trim(),
    nameNormalized: normalizeName(name),
    type, // '3_days' | '1_month' | 'lifetime'
    durationDays,
    createdAt: Date.now(),
    activatedAt: null,
    expiresAt: null,
    hwid: null,
    deviceInfo: null,
    status: 'unused', // 'unused' | 'active' | 'expired' | 'revoked'
    notes: notes ? notes.trim() : '',
    lastChecked: null,
  };

  licenses.set(key, lic);
  persist();
  return lic;
}

function getPublicInfo(lic) {
  const isExpired = lic.expiresAt && Date.now() > lic.expiresAt;
  const status = lic.status === 'revoked'
    ? 'revoked'
    : isExpired
    ? 'expired'
    : lic.status;

  return {
    key: lic.key,
    name: lic.name,
    type: lic.type,
    durationDays: lic.durationDays,
    createdAt: lic.createdAt,
    activatedAt: lic.activatedAt,
    expiresAt: lic.expiresAt,
    status,
    remainingText: formatRemaining(lic.expiresAt),
    hwid: lic.hwid ? `${lic.hwid.slice(0, 8)}...${lic.hwid.slice(-6)}` : null,
    deviceInfo: lic.deviceInfo,
    notes: lic.notes,
  };
}

function activate({ key, name, hwid, deviceInfo = '' }) {
  if (!key || !key.trim()) {
    return { ok: false, error: 'Mã bản quyền không được để trống' };
  }
  if (!name || !name.trim()) {
    return { ok: false, error: 'Tên người dùng không được để trống' };
  }
  if (!hwid || !hwid.trim()) {
    return { ok: false, error: 'Không nhận diện được mã thiết bị (HWID)' };
  }

  const lic = licenses.get(key.trim().toUpperCase());
  if (!lic) {
    return { ok: false, error: 'Mã bản quyền không tồn tại trên hệ thống' };
  }

  if (lic.status === 'revoked') {
    return { ok: false, error: 'Mã bản quyền này đã bị thu hồi' };
  }

  // So khớp tên
  if (normalizeName(name) !== lic.nameNormalized) {
    return {
      ok: false,
      error: `Tên người dùng không khớp với tên đăng ký của mã này (Tên đã đăng ký: "${lic.name}")`,
    };
  }

  // Kiểm tra HWID
  if (lic.hwid && lic.hwid !== hwid.trim()) {
    return {
      ok: false,
      error: 'Mã bản quyền này đã được kích hoạt trên một thiết bị khác! Mỗi key chỉ dùng cho 1 thiết bị duy nhất.',
    };
  }

  const now = Date.now();

  // Kích hoạt lần đầu
  if (!lic.activatedAt) {
    lic.activatedAt = now;
    lic.hwid = hwid.trim();
    lic.deviceInfo = deviceInfo ? deviceInfo.trim() : 'Mobile/Web';
    lic.status = 'active';

    if (lic.type === '3_days') {
      lic.expiresAt = now + 3 * 24 * 3600 * 1000;
    } else if (lic.type === '1_month') {
      lic.expiresAt = now + 30 * 24 * 3600 * 1000;
    } else if (lic.type === 'lifetime') {
      lic.expiresAt = null;
    }
  }

  // Kiểm tra thời hạn
  if (lic.expiresAt && now > lic.expiresAt) {
    lic.status = 'expired';
    persist();
    return {
      ok: false,
      error: 'Mã bản quyền đã hết hạn sử dụng. Vui lòng liên hệ để mua hoặc gia hạn key!',
      expired: true,
      expiresAt: lic.expiresAt,
    };
  }

  lic.lastChecked = now;
  persist();

  return {
    ok: true,
    license: getPublicInfo(lic),
    message: 'Kích hoạt bản quyền thành công!',
  };
}

function verify({ key, hwid }) {
  if (!key) return { ok: false, valid: false, error: 'Chưa có mã bản quyền' };
  if (!hwid) return { ok: false, valid: false, error: 'Không có HWID thiết bị' };

  const lic = licenses.get(key.trim().toUpperCase());
  if (!lic) {
    return { ok: false, valid: false, error: 'Mã bản quyền không tồn tại' };
  }

  if (lic.status === 'revoked') {
    return { ok: false, valid: false, error: 'Mã bản quyền đã bị thu hồi' };
  }

  if (!lic.hwid || lic.hwid !== hwid.trim()) {
    return {
      ok: false,
      valid: false,
      error: 'Thiết bị chưa được kích hoạt với mã bản quyền này',
    };
  }

  const now = Date.now();
  if (lic.expiresAt && now > lic.expiresAt) {
    lic.status = 'expired';
    persist();
    return {
      ok: false,
      valid: false,
      expired: true,
      error: 'Mã bản quyền đã hết hạn sử dụng',
      remainingText: 'Đã hết hạn',
    };
  }

  lic.lastChecked = now;
  persist();

  return {
    ok: true,
    valid: true,
    license: getPublicInfo(lic),
  };
}

function listAll() {
  const now = Date.now();
  const list = [];
  for (const lic of licenses.values()) {
    if (lic.expiresAt && now > lic.expiresAt && lic.status !== 'revoked') {
      lic.status = 'expired';
    }
    list.push({
      ...getPublicInfo(lic),
      fullHwid: lic.hwid,
      notes: lic.notes,
      lastChecked: lic.lastChecked,
    });
  }
  // Sort: active first, then unused, then expired, then revoked
  list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return list;
}

function extendKey(key, addDays = 30) {
  const lic = licenses.get(key.trim().toUpperCase());
  if (!lic) throw new Error('Không tìm thấy mã bản quyền');

  const now = Date.now();
  const base = (lic.expiresAt && lic.expiresAt > now) ? lic.expiresAt : now;
  lic.expiresAt = base + Number(addDays) * 24 * 3600 * 1000;
  lic.status = 'active';
  persist();
  return getPublicInfo(lic);
}

function resetHwid(key) {
  const lic = licenses.get(key.trim().toUpperCase());
  if (!lic) throw new Error('Không tìm thấy mã bản quyền');

  lic.hwid = null;
  lic.deviceInfo = null;
  persist();
  return getPublicInfo(lic);
}

function deleteKey(key) {
  const k = key.trim().toUpperCase();
  const deleted = licenses.delete(k);
  if (deleted) persist();
  return deleted;
}

// Auto-load on require
load();

module.exports = {
  createKey,
  activate,
  verify,
  listAll,
  extendKey,
  resetHwid,
  deleteKey,
  formatRemaining,
};
