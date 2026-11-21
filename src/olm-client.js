'use strict';

const { CookieJar } = require('tough-cookie');
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

function trustedOlmUrl(value, base = process.env.OLM_BASE_URL || 'https://olm.vn') {
  if (typeof value !== 'string' || !value.trim()) throw new Error('URL OLM không hợp lệ.');
  const origin = new URL(base);
  const url = new URL(value, origin);
  const isOlm = (host) => host === 'olm.vn' || host.endsWith('.olm.vn');
  const allowed = url.origin === origin.origin ||
    (isOlm(origin.hostname) && isOlm(url.hostname) && url.protocol === 'https:' && !url.port);
  if (!allowed || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('URL nằm ngoài máy chủ OLM đã cấu hình.');
  }
  return url.href;
}

function validateSubmission(response) {
  const { status, data } = response;
  if (status < 200 || status >= 300) throw new Error('OLM từ chối nộp bài (HTTP ' + status + ').');
  if (status === 204) return;
  const reject = () => { throw new Error('OLM báo chưa nộp được bài.'); };
  const failure = /(?:chưa|không thể|không) (?:xác nhận (?:đã )?)?nộp bài|nộp bài (?:không thành công|thất bại)/i;
  const success = /nộp bài thành công|đã nộp bài|bài (?:làm )?đã (?:được )?nộp|đã ghi nhận bài làm|bài làm đang được chấm/i;
  if (data && typeof data === 'object') {
    const rejected = value => value && (value.ok === false || value.success === false || value.submitted === false ||
      value.error || /^(?:error|failed|failure)$/i.test(value.status) || failure.test(value.message || ''));
    const accepted = value => value && (value.ok === true || value.success === true || value.submitted === true ||
      value.ended === true || value.ended === 1 || value.ended === '1' ||
      /^(?:success|submitted|finished)$/i.test(value.status) || /^(?:success|ok)$/i.test(value.message) || success.test(value.message || ''));
    const values = [data, data.data, data.result];
    if (values.some(rejected)) reject();
    if (values.some(accepted)) return;
  }
  if (typeof data === 'string') {
    const $ = require('cheerio').load(data);
    $('script, style, template, [hidden], [aria-hidden="true"]').remove();
    $('[style]').filter((_, el) => /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0)\s*(?:!important\s*)?(?:;|$)/i.test($(el).attr('style'))).remove();
    const text = $('body').text().replace(/\s+/g, ' ').trim();
    if ($('input[type=password]').length || failure.test(text)) reject();
    if (success.test(text) ||
        /kết quả (?:bài làm|luyện tập|bài thi)/i.test(text) && /\d+(?:[.,]\d+)?\s*(?:\/\s*(?:100|10)(?!\d)|điểm)/i.test(text)) return;
  }
  throw Object.assign(new Error('OLM chưa xác nhận đã nộp bài.'), { code: 'SUBMISSION_UNCONFIRMED' });
}

class OlmClient {
  constructor(cookieJar, ua) {
    this.jar = cookieJar || new CookieJar();
    const proxy = require('./proxy');
    this.http = proxy.createAxiosClient(this.jar);
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

  async request(method, url, { data, params, headers, timeout = 20000, allowRedirects = true, signal, responseType, maxContentLength } = {}) {
    const res = await this.http.request({
      method,
      url: trustedOlmUrl(url, this.baseUrl),
      data,
      params,
      timeout,
      signal,
      responseType,
      maxContentLength,
      maxRedirects: allowRedirects ? 5 : 0,
      beforeRedirect: (options) => {
        trustedOlmUrl(options.href, this.baseUrl);
      },
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

    if (!data || typeof data !== 'object' ||
        ![data.ok, data.success, data.status, data.message].some((value) => value === true || value === 'success')) {
      const confirmed = await this.getAuthenticatedUsername();
      const loginInput = String(username || '').trim();
      const isEmailOrPhone = loginInput.includes('@') || /^\+?\d[\d\s.-]{6,}$/.test(loginInput);
      if (!confirmed || (!isEmailOrPhone && confirmed.toLowerCase() !== loginInput.toLowerCase())) {
        throw new Error('OLM không xác nhận đúng tài khoản đăng nhập.');
      }
    }
    const cookies = await this.jar.getCookies(this.baseUrl);
    if (!cookies || cookies.length === 0) {
      throw new Error('OLM không trả về session cookie. Vui lòng thử lại.');
    }

    return { ok: true, cookies: cookies.length };
  }

  async getAuthenticatedUsername() {
    const url = process.env.OLM_PROFILE_URL || this.baseUrl + '/lop-hoc-cua-toi';
    const res = await this.request('GET', url, { timeout: 15000 });
    if (res.status === 200) {
      const data = res.data;
      if (data && typeof data === 'object' && data.authenticated !== false) {
        const username = data.user?.username || data.data?.user?.username;
        if (typeof username === 'string' && username.trim()) return username.trim();
      }
      if (typeof data === 'string') {
        const userMatch = data.match(/window\._data_classroom\s*=\s*\{.*?"user"\s*:\s*\{.*?"username"\s*:\s*"([^"]+)"/s) ||
          data.match(/"user"\s*:\s*\{[^}]*?"username"\s*:\s*"([^"]+)"/) ||
          data.match(/"username"\s*:\s*"([^"]+)"/);
        if (userMatch && userMatch[1] && userMatch[1].trim()) return userMatch[1].trim();

        const $ = require('cheerio').load(data);
        const signedIn = $('a[href*="dangxuat"], a[href*="logout"], form[action*="logout"], form[action*="dangxuat"]').length > 0;
        const username = $('meta[name="auth-username"]').attr('content') ||
          $('#current-user[data-username], .current-user[data-username]').first().attr('data-username') ||
          $('input[name="username"][readonly]').first().val();
        if (signedIn && typeof username === 'string' && username.trim()) return username.trim();
      }
    }
    throw new Error('OLM chưa xác nhận tài khoản đăng nhập.');
  }

  // Look at the real login form so we post the fields OLM actually expects.
  async probeLoginFields() {
    const fallback = { username: 'username', password: 'password', extra: {} };
    try {
      const res = await this.request('GET', this.loginPageUrl, { timeout: 20000 });
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
  async fetchHomeworks({ signal, coursewareOnly = false } = {}) {
    const allRawItems = [];
    let page = 1;
    let lastPage = 1;
    let foundCoursewareList = false;

    try {
      while (page <= Math.min(lastPage, 50)) {
        const apiUrl = `${this.baseUrl}/classes/courseware/list-courseware-of-student?page=${page}&limit=50`;
        const res = await this.request('GET', apiUrl, {
          signal,
          headers: {
            'Accept': 'application/json, text/plain, */*',
            'X-Requested-With': 'XMLHttpRequest',
            'Referer': `${this.baseUrl}/lop-hoc-cua-toi`,
          },
          timeout: 25000,
        });

        if (res.status === 200 && res.data && Array.isArray(res.data.list)) {
          foundCoursewareList = true;
          allRawItems.push(...res.data.list);
          if (res.data.pagi_info?.last) {
            lastPage = Number(res.data.pagi_info.last);
          } else if (res.data.pagi_info?.total_page) {
            lastPage = Number(res.data.pagi_info.total_page);
          }
          if (res.data.list.length === 0) {
            break;
          }
          if (page >= lastPage) {
            break;
          }
          page++;
        } else {
          break;
        }
      }

      if (foundCoursewareList) {
        const items = allRawItems.map((item) => {
          const hwUrl = item._url || item.url || '';
          const abs = hwUrl.startsWith('http') ? hwUrl : new URL(hwUrl, this.baseUrl).toString();
          const subject = item.subject?.title || (item.group?.group_name ? `Lớp ${item.group.group_name}` : '');

          // Nhận diện trạng thái hoàn thành thực sự của bài tập:
          // Một bài chỉ coi là ĐÃ XONG (isDone = true) khi OLM API xác nhận đã hoàn thành/nộp bài,
          // hỗ trợ cả kiểu boolean, số (1/0), chuỗi ('1'/'true'), record dạng object hoặc array,
          // date_end dạng timestamp hoặc chuỗi ngày, và percent/progress >= 100.
          // Nếu học sinh chỉ mới bấm vào bài (tạo user_history_id) hoặc mới làm dở (ended === 0, date_end rỗng)
          // thì KHÔNG coi là đã xong, mà đánh dấu "Đang làm dở".
          const rec = Array.isArray(item.record)
            ? item.record[0]
            : (item.record && typeof item.record === 'object' ? item.record : null);
          const isTruthyFlag = (v) => v === true || v === 1 || v === '1' || v === 'true';
          const isExplicitFalse = (v) => v === false || v === 0 || v === '0' || v === 'false';
          const hasValidDateEnd = (v) => {
            if (v === null || v === undefined || v === '' || v === 0 || v === '0') return false;
            if (typeof v === 'number') return v > 0;
            const s = String(v).trim();
            if (!s || /^0{4}-0{2}-0{2}/.test(s) || /^null$/i.test(s)) return false;
            const n = Number(s);
            if (!Number.isNaN(n)) return n > 0;
            return !Number.isNaN(Date.parse(s));
          };
          const percentVal = Number(item.percent ?? item.progress ?? rec?.percent ?? rec?.progress ?? NaN);
          const isFullPercent = !Number.isNaN(percentVal) && percentVal >= 100;
          const rawScore = rec?.score_10 ?? rec?.score ?? item.score_10 ?? item.score ?? null;
          const hasScore = rawScore !== null && rawScore !== undefined && rawScore !== '' && !Number.isNaN(Number(rawScore));
          const rawItemStatus = String(
            item.status_text || item.status_name || (typeof item.status === 'string' ? item.status : '') || ''
          ).trim();
          const hasDoneStatusText = /^(done|completed|finished|submitted|passed|đã\s*xong|hoàn\s*thành|đã\s*hoàn\s*thành|đã\s*làm|đã\s*nộp)$/i.test(rawItemStatus);
          const recNotEndedFalse = !isExplicitFalse(rec?.ended);

          const isReallyDone = Boolean(
            isTruthyFlag(item.isDone) ||
            isTruthyFlag(item.is_done) ||
            isTruthyFlag(item.done) ||
            isTruthyFlag(item.completed) ||
            isTruthyFlag(item.complete) ||
            isTruthyFlag(item.isCompleted) ||
            isTruthyFlag(item.is_completed) ||
            hasDoneStatusText ||
            (rec && (
              isTruthyFlag(rec.ended) ||
              isTruthyFlag(rec.isDone) ||
              isTruthyFlag(rec.is_done) ||
              isTruthyFlag(rec.completed) ||
              isTruthyFlag(rec.complete) ||
              (recNotEndedFalse && hasValidDateEnd(rec.date_end)) ||
              (recNotEndedFalse && isFullPercent) ||
              (recNotEndedFalse && hasScore && (
                isTruthyFlag(item.tried) ||
                Number(item.tried) > 0 ||
                Boolean(item.user_history_id) ||
                Number(rec.time_do) > 0 ||
                Number(rec.totalq) > 0 ||
                (Number(rec.correct || 0) + Number(rec.wrong || 0)) > 0
              ))
            )) ||
            (recNotEndedFalse && isFullPercent)
          );

          // Kiểm tra xem bài có đang làm dở không
          const isInProgress = !isReallyDone && Boolean(
            isExplicitFalse(rec?.ended) ||
            item.user_history_id ||
            (item.num_done && Number(item.num_done) > 0) ||
            (!Number.isNaN(percentVal) && percentVal > 0 && percentVal < 100) ||
            isTruthyFlag(item.tried) ||
            (item.tried && Number(item.tried) > 0)
          );

          const isDone = isReallyDone;
          const deadline = item.expiredDate || (item.deadlineTimestamp ? new Date(item.deadlineTimestamp * 1000).toLocaleDateString('vi-VN') : '');
          const prefix = item.cate?.prefix || item.cate?.name || item.type_name || '';
          const isExamType = /đề thi|đề thông minh|kiểm tra|kiem tra|(?<![\p{L}\p{N}])thi(?![\p{L}\p{N}])/iu.test(prefix) || [2, 10, 13, 14, 21].includes(Number(item.cate?.type));
          const isPracticePrefix = /luyện tập/i.test(prefix) || Number(item.cate?.type) === 3;
          const opts = (item.options && !Array.isArray(item.options) && typeof item.options === 'object') ? item.options : {};
          const optRedo = opts.redo !== undefined ? Number(opts.redo) : undefined;
          const optLimitRedo = opts.limit_redo !== undefined ? Number(opts.limit_redo) : 0;
          const doneRedoCount = Number(rec?.count_redo ?? rec?.num_redo ?? (isDone ? 1 : 0));
          // Lưu ý: Trên OLM, limit_redo === 0 nghĩa là KHÔNG GIỚI HẠN số lần làm lại (khi redo === 1).
          // Còn limit_redo > 0 là giới hạn số lần làm tối đa.
          const hitRedoLimit = optLimitRedo > 0 && doneRedoCount >= optLimitRedo;

          let canRetry = false;
          if (isDone && !item.isExpired) {
            if (optRedo === 0 || hitRedoLimit) {
              canRetry = false;
            } else if (optRedo === 1) {
              canRetry = true;
            } else if (isPracticePrefix && !/đề thi|kiểm tra|đề thông minh/i.test(prefix)) {
              canRetry = true;
            } else if (!isExamType) {
              canRetry = true;
            }
          }

          let status = 'Chưa làm';
          if (isDone) {
            status = 'Đã xong';
          } else if (item.isExpired) {
            status = 'Hết hạn';
          } else if (isInProgress) {
            const doneQ = rec?.correct !== undefined ? (Number(rec.correct) + Number(rec.wrong || 0)) : (Number(item.num_done) || 0);
            status = doneQ > 0 ? `Đang làm dở (${doneQ} câu)` : 'Đang làm dở';
          }
          let categoryType = 'practice';
          if (/ma trận|matrix/i.test(prefix)) {
            categoryType = 'matrix_exam';
          } else if (/pdf|phiếu tô|omr/i.test(prefix)) {
            categoryType = 'pdf_exam';
          } else if (/tự luận|tu luan|essay/i.test(prefix)) {
            categoryType = 'essay';
          } else if (isExamType) {
            categoryType = 'exam';
          } else if (/video tương tác|interactive/i.test(prefix)) {
            categoryType = 'interactive_video';
          } else if (/lý thuyết|video|bài giảng|bai giang/i.test(prefix)) {
            categoryType = 'theory';
          } else if (/sgk|học liệu|hoc lieu|sách giáo khoa/i.test(prefix)) {
            categoryType = 'textbook';
          } else if (/đấu trường|dau truong|trò chơi|game/i.test(prefix)) {
            categoryType = 'game';
          } else if (/scorm|slide/i.test(prefix)) {
            categoryType = 'scorm';
          } else if (/linh hoạt/i.test(prefix)) {
            categoryType = 'flex_practice';
          } else {
            categoryType = 'practice';
          }
          return {
            id: String(item._id || item.id_skill || item.title),
            categoryPrefix: prefix,
            categoryType,
            title: item.title,
            subject,
            deadline,
            status,
            url: abs,
            teacher: item.user?.name || '',
            isDone: isDone,
            isExpired: !!item.isExpired,
            canRetry,
            score: rawScore,
          };
        });

        items.sort((a, b) => {
          if (a.isDone === b.isDone) return 0;
          return a.isDone ? 1 : -1;
        });

        return { url: `${this.baseUrl}/classes/courseware/list-courseware-of-student`, items };
      }
    } catch (err) {
      signal?.throwIfAborted();
      console.warn(`[fetchHomeworks API] ${err.message}`);
    }

    if (coursewareOnly) return { items: [] };

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
        const res = await this.request('GET', url, { timeout: 25000, signal });
        if (res.status !== 200) {
          errors.push(`${url} -> HTTP ${res.status}`);
          continue;
        }
        const html = typeof res.data === 'string' ? res.data : '';
        const items = parseHomeworks(html, url);
        if (items.length > 0) return { url, items };
        errors.push(`${url} -> 0 items parsed`);
      } catch (err) {
        signal?.throwIfAborted();
        if (err.code === 'NO_SESSION') throw err;
        errors.push(`${url} -> ${err.message}`);
      }
    }

    const err = new Error('Không thể tải danh sách bài tập. Thử lại hoặc dán link bài tập thủ công.');
    err.code = 'HOMEWORKS_NOT_FOUND';
    throw err;
  }

  async fetchHomeworkPage(url, { signal } = {}) {
    const res = await this.request('GET', url, { timeout: 25000, signal });
    if (res.status !== 200) throw new Error(`Homework page HTTP ${res.status}`);
    return typeof res.data === 'string' ? res.data : '';
  }

  async fetchQuestionImage(src, referer, signal) {
    const url = trustedOlmUrl(new URL(src, referer).href, this.baseUrl);
    const response = await this.request('GET', url, {
      signal, timeout: 8000, responseType: 'arraybuffer', maxContentLength: 3 * 1024 * 1024,
      headers: { Referer: referer, Accept: 'image/png,image/jpeg,image/webp' },
    });
    const type = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (response.status !== 200 || !['image/jpeg', 'image/png', 'image/webp'].includes(type) || !response.data?.length) {
      throw new Error('Không đọc được hình trong câu hỏi bằng HTTP.');
    }
    return { type, base64: Buffer.from(response.data).toString('base64') };
  }

  async submitHomework(url, payload, { method = 'post', signal, homeworkUrl, originalHtml } = {}) {
    const isGet = method.toLowerCase() === 'get';
    const form = new URLSearchParams();
    for (const [name, value] of Object.entries(payload)) {
      for (const entry of Array.isArray(value) ? value : [value]) form.append(name, entry);
    }
    const res = await this.request(isGet ? 'GET' : 'POST', url, {
      ...(isGet ? { params: form } : { data: form.toString() }),
      signal,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': url,
        'Origin': this.baseUrl,
      },
      timeout: 25000,
    });
    try {
      validateSubmission(res);
    } catch (error) {
      if (error.code !== 'SUBMISSION_UNCONFIRMED' || !homeworkUrl || typeof originalHtml !== 'string') throw error;
      // Some forms redirect to an intermediate page. Confirm a fresh result
      // by reading the original assignment, without replaying the submission.
      const hasReceipt = html => {
        try {
          validateSubmission({ status: 200, data: html });
          return true;
        } catch {
          return false;
        }
      };
      if (hasReceipt(originalHtml)) throw error;
      const page = await this.request('GET', homeworkUrl, { timeout: 8000, signal }).catch(() => null);
      signal?.throwIfAborted();
      if (page?.status !== 200 || typeof page.data !== 'string' || !hasReceipt(page.data)) throw error;
    }
    return res;
  }
}

// ---------------------------------------------------------- HTML parsing

function parseHomeworks(html, baseUrl) {
  const cheerio = require('cheerio');
  const $ = cheerio.load(html);
  const items = [];
  const seen = new Set();

  // If page is a login page or session expired page, throw NO_SESSION
  const isLoginPage = /id=["']login-form["']|class=["'][^"']*login-form|action=["'][^"']*\/dangnhap|\/social\/google|quên mật khẩu|ghi nhớ đăng nhập/i.test(html) &&
                      !$('.homework-item, .exercise-item, .card-homework, [data-homework-id]').length;
  if (isLoginPage) {
    const err = new Error('Phiên đăng nhập OLM đã hết hạn hoặc chưa đăng nhập.');
    err.code = 'NO_SESSION';
    throw err;
  }

  const push = (el) => {
    const $el = $(el);
    const title = ($el.attr('title') || $el.data('title') || $el.find('.title, .name, h3, h4, h5').first().text() || '').trim();
    if (!title || /đăng nhập|đăng ký|quên mật khẩu/i.test(title)) return;

    const link = $el.find('a[href]').first().attr('href') || $el.closest('a').attr('href') || $el.attr('href');
    if (!link || /\/social\/|\/dangnhap|\/login|\/auth\/|\/logout|\/quenmatkhau|\/register|redirect_url=/i.test(link)) return;
    const abs = link ? new URL(link, baseUrl).toString() : '';

    const statusText = $el.find('.status, .state, .badge, .label, .chip')
      .map((_, s) => $(s).text().trim())
      .get()
      .filter(Boolean)
      .join(' ');
    const deadlineText = ($el.find('.deadline, .due, .time, .expire, .han-deadline').first().text() || '').trim();
    const subject = ($el.find('.subject, .mon, .mon-hoc, .category').first().text() || '').trim();

    const idAttr = $el.attr('data-id') || $el.attr('id') || '';
    const id = idAttr || (abs ? abs.split('/').pop() : title);

    const key = `${id}|${title}`;
    if (seen.has(key)) return;
    seen.add(key);

    const fullText = $el.text();
    const isDone = /đã\s*xong|hoàn\s*thành|đã\s*làm|đã\s*nộp/i.test(statusText) ||
      /đã\s*hoàn\s*thành|luyện\s*tập\s*lại|làm\s*lại\s*bài/i.test(fullText);
    const canRetry = isDone && /luyện\s*tập|làm\s*lại|thi\s*lại|luyentaplai/i.test(fullText);

    items.push({
      id: String(id),
      title,
      subject,
      deadline: deadlineText,
      status: statusText || 'unknown',
      url: abs,
      isDone,
      isExpired: /hết\s*hạn/i.test(statusText),
      canRetry,
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
      if (/\/social\/|\/dangnhap|\/login|\/auth\/|\/logout|\/quenmatkhau|\/register|redirect_url=/i.test(href)) return;
      if (/đăng nhập|đăng ký|quên mật khẩu/i.test(title)) return;
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
        isDone: false,
        isExpired: false,
        canRetry: false,
      });
    });
  }

  return items;
}

module.exports = { OlmClient, parseHomeworks, randomUA, baseHeaders, USER_AGENTS, trustedOlmUrl, validateSubmission };
