# OLM Homework Assistant

PWA chạy kiểu native trên iPhone và Node/Express backend giữ session OLM, quét bài tập, giải câu hỏi qua OpenAI, rồi đi qua các bước trả lời/submission theo lịch đã cấu hình.

## Cấu trúc

```text
olm/
  server.js
  package.json
  .env.example
  src/
    answer-engine.js
    browser-engine.js
    humanize.js
    olm-client.js
    question-parser.js
    runner.js
    session-store.js
  public/
    index.html
    manifest.json
    sw.js
    css/app.css
    js/api.js
    js/app.js
    js/ui.js
    icons/icon.svg
  scripts/install-browser.js
```

## Chạy local

Yêu cầu Node.js 18+.

```bash
npm install
```

Copy `.env.example` thành `.env`, rồi điền:

```env
OPENAI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
OPENAI_API_KEY=your-gemini-key
OPENAI_MODEL=gemini-3.8-flash
```

Endpoint này là OpenAI-compatible, nên có thể đổi sang provider khác (OpenAI, Groq, OpenRouter, opencode zen...) bằng cách sửa `OPENAI_BASE_URL` và `OPENAI_MODEL`.

**Provider dự phòng** — app tự chuyển sang provider thứ hai khi provider chính lỗi (hết quota, sai key, model không có):

```env
FALLBACK_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
FALLBACK_MODELS=gemini-3.8-flash,gemini-3.6-flash,gemini-3.5-flash-lite
FALLBACK_API_KEY=your-gemini-key
```

`FALLBACK_MODELS` nhận nhiều model cách nhau bằng dấu phẩy, app sẽ thử lần lượt. Điều này quan trọng với Gemini free tier: **mỗi model có hạn mức riêng 20 req/ngày**, nên khai báo nhiều model giúp chạy được nhiều bài hơn trước khi hết quota.

**Một số endpoint dùng `x-api-key` thay vì `Authorization: Bearer`** (ví dụ opencode zen) — khi đó thêm `OPENAI_AUTH_HEADER=x-api-key`.

**Model GPT-5/6** (OpenAI, opencode zen) dùng `reasoning_effort` và `max_completion_tokens` thay cho `temperature`:

```env
OPENAI_REASONING_EFFORT=none   # none | minimal | low | medium | high | xhigh | max
OPENAI_MAX_TOKENS=2048
```

**Model Claude** (opencode zen) dùng `effort` và `max_tokens`, **không** nhận `temperature` cũng không nhận `response_format`. Mức `effort` hợp lệ: `low | medium | high | xhigh | max` — không có `none`. Engine tự chọn đúng payload dựa trên tên model.

> **Lưu ý quota Gemini free tier**: `gemini-3.8-flash` chỉ cho **20 request/ngày** ở tầng miễn phí. Hết quota sẽ trả về HTTP 429 và backend báo đúng thông báo lỗi của Google. Nâng cấp billing trong Google AI Studio, hoặc đổi sang `gemini-3.5-flash` / `gemini-3.1-flash-lite` (hạn mức cao hơn) nếu cần chạy nhiều bài. Kiểm tra quota bằng `npm run quota`.

Khởi động:

```bash
npm start
```

Mở `http://localhost:3000`. Để thêm vào màn hình chính iPhone, backend phải được expose qua HTTPS (ví dụ reverse proxy Nginx/Caddy hoặc tunnel có HTTPS), sau đó mở URL bằng Safari và chọn Share -> Add to Home Screen.

## Ứng dụng iOS (Capacitor Native App)

Dự án đã tích hợp Capacitor để đóng gói thành ứng dụng iOS native:

- **Thư mục dự án Xcode**: `ios/App/App.xcodeproj`
- **Mã định danh App**: `com.olmassistant.app`

### Các bước phát triển & đồng bộ:
1. Đồng bộ web vào iOS:
   ```bash
   npm run cap:sync
   ```
2. Mở dự án trong Xcode (trên macOS):
   ```bash
   npx cap open ios
   ```
3. Cấu hình Backend trên iOS App:
   Vào tab **Cấu hình** trong ứng dụng -> nhập địa chỉ IP máy tính/VPS chạy server Node.js (ví dụ `http://192.168.1.15:3000`) và bấm **Kiểm tra kết nối**.

### Build IPA tự động trên GitHub Actions (không cần Mac):
Dự án đã có sẵn workflow [`.github/workflows/build-ios.yml`](.github/workflows/build-ios.yml). Khi push code lên GitHub, GitHub Actions sẽ tự động build và xuất file `OLM-Solver.ipa` để tải về và cài đặt qua Sideloadly / AltStore / Scarlet.


## Browser engine

HTTP engine là mặc định nếu Puppeteer không có. Để bật browser engine:

```bash
npm install puppeteer puppeteer-extra puppeteer-extra-plugin-stealth
npx puppeteer browsers install chrome
```

Sau đó chọn `Auto` hoặc `Browser` trong PWA. Nếu dùng máy chủ không có desktop, giữ `PUPPETEER_HEADLESS=true`. Nếu có desktop và cần quan sát trình duyệt, đặt `PUPPETEER_HEADLESS=false`.

## API

- `POST /api/login`: `{ username, password }` -> `{ sessionId }`
- `GET /api/homeworks`: header `X-Session-Id`
- `POST /api/run`: chọn bài + config điểm/tốc độ/khung giờ
- `GET /api/run/:runId`: trạng thái và log gần nhất
- `GET /api/events`: SSE log real-time
- `POST /api/answer`: giải một câu hỏi; API key chỉ ở server
- `POST /api/submit`: submit thủ công
- `POST /api/logout`: xoá session token

## Ghi chú triển khai

1. Parser OLM sử dụng nhiều selector fallback. Khi OLM thay đổi HTML, xem warning trong log và cập nhật `src/question-parser.js` hoặc `src/olm-client.js`.
2. Cookie jar được lưu server-side trong `data/sessions.json`; password không được lưu.
3. Không đưa `OPENAI_API_KEY` vào frontend hoặc localStorage.
4. Service worker chỉ cache app shell. `/api/*` luôn yêu cầu mạng.
5. Không dùng service worker để tiếp tục chạy timer khi iOS đã terminate PWA. Lịch submit được giữ trong backend run; nếu cần độ bền khi restart server, dùng process manager và persistent job queue.
6. Chỉ dùng trên tài khoản và lớp học mà bạn có quyền quản lý; kiểm tra quy định của trường và OLM trước khi tự động hóa việc nộp bài.
