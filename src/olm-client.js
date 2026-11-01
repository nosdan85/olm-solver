'use strict';

const { CookieJar } = require('tough-cookie');
const cookieJarSupport = require('axios-cookiejar-support');
const wrapper = cookieJarSupport.wrapper || cookieJarSupport;
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Stealth: these UAs are all shipped by real browsers. Rotating them keeps
// requests from looking like a single fingerprint hammering the site.
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:129.0) Gecko/20100101 Firefox/129.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
];

function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function baseHeaders(ua) {
  return {
    'User-Agent': ua || randomUA(),
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    'Connection': 'keep-alive',
  };
}

// ---------------------------------------------------------------- OLM client

class OlmClient {
  constructor(cookieJar, ua) {
    this.jar = cookieJar || new CookieJar();
    this.http = wrapper(axios.create({ jar: this.jar, withCredentials: true }));
    this.ua = ua || randomUA();
    this.baseUrl = (process.env.OLM_BASE_URL || 'https://olm.vn').replace(/\/+$/, '');
    this.loginPageUrl = process.env.OLM_LOGIN_URL || `${this.baseUrl}/dangnhap`;
    this.postLoginUrl = `${this.baseUrl}/post-login`;
    this.homeworkUrl = process.env.OLM_HOMEWORK_URL || `${this.baseUrl}/hoat-dong`;
    this.activityUrl = process.env.OLM_ACTIVITY_URL || `${this.baseUrl}/bai-tap`;
  }

  static fromSerialized(jarJson, ua) {
    const jar = CookieJar.fromJSON(jarJson);
    return new OlmClient(jar, ua);
  }

  serialize() {
    return this.jar.toJSON();
  }

  async request(method, url, { data, params, headers, timeout = 20000, allowRedirects = true } = {}) {
    const res = await this.http.request({
      method,
      url,
      data,
      params,
      timeout,
      allowRedirects,
      maxRedirects: 5,
      headers: { ...baseHeaders(this.ua), ...(headers || {}) },
      validateStatus: (status) => status >= 100 && status < 600,
    });
    return res;
  }

  // Modern OLM login flow via /post-login with CSRF and device_id.
  async login(username, password) {
    const cheerio = require('cheerio');
    const crypto = require('crypto');

    // 1. Fetch login page to get session cookie & CSRF token
    const getRes = await this.request('GET', this.loginPageUrl, {
      headers: {
        'Referer': this.baseUrl,
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin',
      },
      timeout: 25000,
    });

    const html = typeof getRes.data === 'string' ? getRes.data : '';
    const $ = cheerio.load(html);
    const csrfToken = $('meta[name="csrf-token"]').attr('content') || '';

    // Generate pseudo device_id (32 hex characters)
    const deviceId = crypto.createHash('md5').update(`${username}_${this.ua}`).digest('hex');

    // 2. Post to /post-login
    const payload = {
      username: String(username).trim(),
      password: String(password),
      platform: 'web',
      device_id: deviceId,
      _token: csrfToken,
    };

    const res = await this.request('POST', this.postLoginUrl, {
      data: payload,
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-TOKEN': csrfToken,
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': this.loginPageUrl,
        'Origin': this.baseUrl,
        'Accept': 'application/json, text/plain, */*',
      },
      timeout: 25000,
    });

    if (res.status >= 400) {
      const msg = res.data?.message || `HTTP ${res.status}`;
      throw new Error(`Đăng nhập OLM thất bại: ${msg}`);
    }

    const data = res.data;
    if (typeof data === 'object' && data !== null) {
      if (data.message === 'error' || data.status === 'error') {
        const wrongPw = data.countWrongPassword ? ` (sai mật khẩu lần ${data.countWrongPassword})` : '';
        throw new Error(data.error || `Sai tên đăng nhập hoặc mật khẩu${wrongPw}`);
      }
      if (data.message === '2fa' || data.status === '2fa') {
        throw new Error('Tài khoản yêu cầu mã xác thực 2FA. Vui lòng tắt 2FA trên OLM để tiếp tục.');
      }
    }

    const cookies = await this.jar.getCookies(this.baseUrl);
    if (!cookies || cookies.length === 0) {
      throw new Error('OLM không trả về session cookie. Vui lòng thử lại.');
    }

    return { ok: true, cookies: cookies.length };
  }

  // Look at the real login form so we post the fields OLM actually expects.
  async probeLoginFields() {
    const fallback = { username: 'username', password: 'password', extra: {} };
    try {
      const res = await this.request('GET', this.loginUrl, { timeout: 20000 });
      const html = typeof res.data === 'string' ? res.data : '';
      if (!html) return fallback;

      const cheerio = require('cheerio');
      const $ = cheerio.load(html);

      let username = null;
      let password = null;
      const extra = {};

      $('form').each((_, form) => {
        const $form = $(form);
        const action = $form.attr('action');
        if (action && !action.startsWith('/') && !action.startsWith('http')) {
          // relative action, fine
        }
        $form.find('input').each((__, input) => {
          const name = $(input).attr('name');
          const type = ($(input).attr('type') || 'text').toLowerCase();
          if (!name) return;
          if (type === 'password' && !password) password = name;
          else if (type === 'text' && !username) username = name;
          else if (type === 'hidden') extra[name] = $(input).attr('value') || '';
          else if (type === 'checkbox' && $(input).attr('checked') !== undefined) extra[name] = 'on';
        });
      });

      return {
        username: username || fallback.username,
        password: password || fallback.password,
        extra,
      };
    } catch (err) {
      return fallback;
    }
  }

  // Fetch the homework list. Uses OLM's official student courseware API first,
  // falling back to scraping if unavailable.
  async fetchHomeworks() {
    const allRawItems = [];
    let page = 1;
    let lastPage = 1;

    try {
      while (page <= lastPage) {
        const apiUrl = `${this.baseUrl}/classes/courseware/list-courseware-of-student?page=${page}&limit=50`;
        const res = await this.request('GET', apiUrl, {
          headers: {
            'Accept': 'application/json, text/plain, */*',
            'X-Requested-With': 'XMLHttpRequest',
            'Referer': `${this.baseUrl}/lop-hoc-cua-toi`,
          },
          timeout: 25000,
        });

        if (res.status === 200 && res.data && Array.isArray(res.data.list)) {
          allRawItems.push(...res.data.list);
          if (res.data.pagi_info?.last) {
            lastPage = Number(res.data.pagi_info.last);
          } else {
            break;
          }
          if (res.data.list.length === 0 || !res.data.pagi_info?.hasNextPage) {
            break;
          }
          page++;
        } else {
          break;
        }
      }

      if (allRawItems.length > 0) {
        const items = allRawItems.map((item) => {
          const hwUrl = item._url || item.url || '';
          const abs = hwUrl.startsWith('http') ? hwUrl : new URL(hwUrl, this.baseUrl).toString();
          const subject = item.subject?.title || (item.group?.group_name ? `Lớp ${item.group.group_name}` : '');
          const status = item.isDone ? 'Đã xong' : (item.isExpired ? 'Hết hạn' : 'Chưa làm');
          const deadline = item.expiredDate || (item.deadlineTimestamp ? new Date(item.deadlineTimestamp * 1000).toLocaleDateString('vi-VN') : '');
          return {
            id: String(item._id || item.id_skill || item.title),
            title: item.title,
            subject,
            deadline,
            status,
            url: abs,
            teacher: item.user?.name || '',
            isDone: !!item.isDone,
            isExpired: !!item.isExpired,
            score: item.record?.score_10 ?? null,
          };
        });

        items.sort((a, b) => {
          if (a.isDone === b.isDone) return 0;
          return a.isDone ? 1 : -1;
        });

        return { url: `${this.baseUrl}/classes/courseware/list-courseware-of-student`, items };
      }
    } catch (err) {
      console.warn(`[fetchHomeworks API] ${err.message}`);
    }

    // Fallback: candidate URLs
    const candidates = [
      `${this.baseUrl}/lop-hoc-cua-toi`,
      `${this.baseUrl}/bai-tap-duoc-giao`,
      this.homeworkUrl,
      this.activityUrl,
    ];
    const errors = [];

    for (const url of candidates) {
      try {
        const res = await this.request('GET', url, { timeout: 25000 });
        if (res.status !== 200) {
          errors.push(`${url} -> HTTP ${res.status}`);
          continue;
        }
        const html = typeof res.data === 'string' ? res.data : '';
        const items = parseHomeworks(html, url);
        if (items.length > 0) return { url, items };
        errors.push(`${url} -> 0 items parsed`);
      } catch (err) {
        errors.push(`${url} -> ${err.message}`);
      }
    }

    const err = new Error('Không thể tải danh sách bài tập. Thử lại hoặc dán link bài tập thủ công.');
    err.code = 'HOMEWORKS_NOT_FOUND';
    throw err;
  }

  async fetchHomeworkPage(url) {
    const res = await this.request('GET', url, { timeout: 25000 });
    if (res.status !== 200) throw new Error(`Homework page HTTP ${res.status}`);
    return typeof res.data === 'string' ? res.data : '';
  }

  async submitHomework(url, payload) {
    const res = await this.request('POST', url, {
      data: payload,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': url,
        'Origin': this.baseUrl,
      },
      timeout: 25000,
    });
    return res;
  }
}

// ---------------------------------------------------------- HTML parsing

function parseHomeworks(html, baseUrl) {
  const cheerio = require('cheerio');
  const $ = cheerio.load(html);
  const items = [];
  const seen = new Set();

  const push = (el) => {
    const $el = $(el);
    const title = ($el.attr('title') || $el.data('title') || $el.find('.title, .name, h3, h4, h5').first().text() || '').trim();
    if (!title) return;

    const link = $el.find('a[href]').first().attr('href') || $el.closest('a').attr('href') || $el.attr('href');
    const abs = link ? new URL(link, baseUrl).toString() : '';

    const statusText = ($el.find('.status, .state, .badge, .label, .chip').first().text() || '').trim();
    const deadlineText = ($el.find('.deadline, .due, .time, .expire, .han-deadline').first().text() || '').trim();
    const subject = ($el.find('.subject, .mon, .mon-hoc, .category').first().text() || '').trim();

    const idAttr = $el.attr('data-id') || $el.attr('id') || '';
    const id = idAttr || (abs ? abs.split('/').pop() : title);

    const key = `${id}|${title}`;
    if (seen.has(key)) return;
    seen.add(key);

    items.push({
      id: String(id),
      title,
      subject,
      deadline: deadlineText,
      status: statusText || 'unknown',
      url: abs,
    });
  };

  // Try a set of container selectors that cover the layouts OLM has used.
  const selectors = [
    '.homework-item',
    '.exercise-item',
    '.assignment-item',
    '.task-item',
    '.card-homework',
    '.row-homework',
    'li.homework',
    '[data-homework-id]',
    'article.homework',
  ];

  for (const sel of selectors) {
    const found = $(sel);
    if (found.length > 0) {
      found.each((_, el) => push(el));
      if (items.length) break;
    }
  }

  if (!items.length) {
    // Generic fallback: any link that looks like it points at a homework.
    $('a[href*="bai-tap"], a[href*="homework"], a[href*="baitap"], a[href*="lam-bai"]').each((_, el) => {
      const $el = $(el);
      const href = $el.attr('href');
      const title = $el.text().trim();
      if (!href || !title || title.length < 4) return;
      const abs = new URL(href, baseUrl).toString();
      if (seen.has(abs)) return;
      seen.add(abs);
      items.push({
        id: abs.split('/').pop() || title,
        title,
        subject: '',
        deadline: '',
        status: 'unknown',
        url: abs,
      });
    });
  }

  return items;
}

module.exports = { OlmClient, parseHomeworks, randomUA, baseHeaders, USER_AGENTS };