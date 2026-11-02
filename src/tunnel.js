'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

let tunnelProcess = null;
let currentPublicUrl = '';

const BIN_PATH = path.join(__dirname, '..', 'cloudflared.exe');
const DATA_FILE = path.join(__dirname, '..', 'data', 'tunnel.json');

function getUrl() {
  if (currentPublicUrl) return currentPublicUrl;
  try {
    if (fs.existsSync(DATA_FILE)) {
      const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      return data.url || '';
    }
  } catch {}
  return '';
}

function start(port = 3000) {
  if (tunnelProcess) return Promise.resolve(currentPublicUrl);
  if (!fs.existsSync(BIN_PATH)) {
    console.log('[tunnel] Không tìm thấy cloudflared.exe, bỏ qua tạo tunnel công khai.');
    return Promise.resolve('');
  }

  return new Promise((resolve) => {
    try {
      console.log(`[tunnel] Đang khởi tạo Cloudflare Tunnel cho cổng ${port}...`);
      tunnelProcess = spawn(BIN_PATH, ['tunnel', '--url', `http://127.0.0.1:${port}`], {
        windowsHide: true,
      });

      const urlRegex = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
      let resolved = false;

      const handleData = (chunk) => {
        const text = chunk.toString();
        const match = text.match(urlRegex);
        if (match && !resolved) {
          resolved = true;
          currentPublicUrl = match[0];
          try {
            fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
            fs.writeFileSync(DATA_FILE, JSON.stringify({ url: currentPublicUrl, updatedAt: Date.now() }, null, 2));
          } catch {}

          console.log('\n  ╔══════════════════════════════════════════════════════════════════════════════╗');
          console.log(`  ║  ĐƯỜNG DẪN DÙNG TRÊN ĐIỆN THOẠI (BẤT KỲ MẠNG 4G / 5G / WIFI KHÁC):           ║`);
          console.log(`  ║  👉 ${currentPublicUrl.padEnd(70, ' ')} ║`);
          console.log('  ╚══════════════════════════════════════════════════════════════════════════════╝\n');
          resolve(currentPublicUrl);
        }
      };

      tunnelProcess.stdout.on('data', handleData);
      tunnelProcess.stderr.on('data', handleData);

      tunnelProcess.on('error', (err) => {
        console.warn('[tunnel] Lỗi khởi động tunnel:', err.message);
        if (!resolved) { resolved = true; resolve(''); }
      });

      tunnelProcess.on('exit', () => {
        tunnelProcess = null;
        currentPublicUrl = '';
      });

      // Timeout fallback after 15s
      setTimeout(() => {
        if (!resolved) { resolved = true; resolve(currentPublicUrl); }
      }, 15000);
    } catch (err) {
      console.warn('[tunnel] Exception:', err.message);
      resolve('');
    }
  });
}

function stop() {
  if (tunnelProcess) {
    try {
      tunnelProcess.kill('SIGTERM');
    } catch {}
    tunnelProcess = null;
  }
}

process.on('exit', stop);
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

module.exports = { start, getUrl, stop };
