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
OPENAI_API_KEY=sk-...
```

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
