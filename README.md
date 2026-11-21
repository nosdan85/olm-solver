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
npm ci
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

Trên máy chạy server, mở [trang bán key](http://127.0.0.1:3000/), [trang Giải OLM](http://127.0.0.1:3000/giai-olm) hoặc [trang quản lý key](http://127.0.0.1:3000/quan-ly-key). Để thêm vào màn hình chính iPhone, backend cần có địa chỉ HTTPS. Mở địa chỉ đó bằng Safari và chọn Share → Add to Home Screen.

## Browser engine

Cần Node.js 22.12 trở lên. Nếu máy đã có Chrome, server có thể dùng Chrome đã cài hoặc đường dẫn trong `PUPPETEER_EXECUTABLE_PATH`. Để tải trình duyệt dành cho Puppeteer, chạy `npm run install:browser`.

Ứng dụng dùng máy chủ đang phục vụ trang theo mặc định. Để bật Cloudflare Tunnel trên Windows, chạy `CHAY_OLM.bat` với `cloudflared.exe` trong thư mục dự án, hoặc đặt `AUTO_TUNNEL=true`. Mở đường dẫn HTTPS được in ra trên điện thoại.

Đặt `ADMIN_PASSWORD` riêng trước khi mở trang quản trị. Đặt `SESSION_SECRET` ngẫu nhiên để lưu phiên OLM đã mã hóa qua lần khởi động lại. Nếu bỏ trống, phiên chỉ lưu trong bộ nhớ. Có thể đặt `OLM_DATA_DIR` đến ổ đĩa bền vững khi triển khai. Dữ liệu license, phiên và proxy là dữ liệu cục bộ.

## API

- POST /api/login xác thực tài khoản và mật khẩu OLM rồi tạo cookie phiên web HttpOnly. Cookie phiên OLM được giữ trên máy chủ.
- Trình duyệt gửi cookie phiên cho API người dùng. API đọc bài, chạy, giải hoặc nộp thêm X-License-Key và X-Device-HWID đã kích hoạt.
- GET /api/run/:runId và GET /api/runs chỉ trả tác vụ thuộc phiên hiện tại.
- GET /api/events và GET /api/admin/events dùng các cookie phiên riêng cho sự kiện tác vụ và quản trị.
- POST /api/admin/login tạo cookie phiên quản trị HttpOnly có thời hạn. Trình duyệt cần đăng nhập lại khi cập nhật từ bản cũ dùng token trong bộ nhớ web.

## Ghi chú triển khai

1. Parser OLM sử dụng nhiều selector fallback. Khi OLM thay đổi HTML, xem warning trong log và cập nhật `src/question-parser.js` hoặc `src/olm-client.js`.
2. Cookie jar được mã hóa trong `data/sessions.json` khi có `SESSION_SECRET`.
3. Không đưa `OPENAI_API_KEY` vào frontend hoặc localStorage.
4. Service worker chỉ cache app shell. `/api/*` luôn yêu cầu mạng.
5. Không dùng service worker để tiếp tục chạy timer khi iOS đã terminate PWA. Lịch submit được giữ trong backend run; nếu cần độ bền khi restart server, dùng process manager và persistent job queue.
6. Chỉ dùng trên tài khoản và lớp học mà bạn có quyền quản lý; kiểm tra quy định của trường và OLM trước khi tự động hóa việc nộp bài.

## Triển khai giaiolm.com

| Đường dẫn | Vai trò | Hạ tầng |
| --- | --- | --- |
| / | Giới thiệu, bảng giá và đặt key qua Facebook | Vercel, tệp tĩnh |
| /giai-olm | Đăng nhập OLM, kích hoạt key, chạy và theo dõi tác vụ | Vercel gọi Render API |
| /quan-ly-key | Đăng nhập quản trị, tạo key, quản lý thiết bị và sao lưu | Vercel gọi Render API |
| api.giaiolm.com | Phiên, license, API và hàng đợi | Render Web Service và PostgreSQL |
| Worker | Chromium, HTTP engine và xử lý tác vụ | Render Background Worker |

### Thứ tự kết nối

1. Đồng bộ Blueprint trong render.yaml với repository. Blueprint tạo hai API instance trả phí, một worker và PostgreSQL cùng vùng. Điền ADMIN_PASSWORD và OPENAI_API_KEY trong Render. Nếu dùng nhà cung cấp AI khác, đặt OPENAI_BASE_URL và OPENAI_MODEL tương ứng. API và worker phải dùng cùng SESSION_SECRET và DATABASE_URL.
2. Xác minh /api/ready trả 200 trên API Render. Thêm api.giaiolm.com trong Render và trỏ bản ghi DNS theo giá trị Render cung cấp. Đợi HTTPS hoạt động trước khi mở đăng nhập từ frontend.
3. Nhập repository vào một dự án Vercel Pro dành cho website thương mại. Dùng cấu hình vercel.json trong thư mục gốc, rồi thêm giaiolm.com và cấu hình chuyển hướng www về domain chính. Bản build mặc định gọi https://api.giaiolm.com. Với staging, dùng frontend và API HTTPS cùng site (ví dụ preview.giaiolm.com và api-staging.giaiolm.com). Đặt PUBLIC_API_ORIGIN trên Vercel và thêm origin frontend chính xác vào PUBLIC_ORIGINS trên Render.
4. Nếu có key cũ, xuất JSON từ trang quản trị cũ và dùng Nhập JSON trên trang quản trị mới. Người dùng đăng nhập lại để tạo phiên PostgreSQL. Tạo thử một key 3 tháng và chạy thử với tài khoản kiểm thử trước khi công khai.
5. Với reverse proxy khác Render, đặt TRUST_PROXY phù hợp đường đi của request. Chỉ cấp quyền Postgres cho dịch vụ nội bộ. Worker dùng Chromium trong container riêng. PUPPETEER_NO_SANDBOX=true chỉ áp dụng cho worker trong Blueprint.

### Kiểm chứng tải trước khi mở bán

- Trang giới thiệu tĩnh có thể kiểm tải riêng với cache Vercel đang bật. Lượt xem bảng giá và bấm mua không gọi Render.
- Đo riêng lượt đăng nhập, quét bài, theo dõi tác vụ và số tác vụ giải đồng thời. Dùng dữ liệu tổng hợp hoặc upstream staging, tăng tải theo bậc đến mục tiêu 10.000 phiên đang hoạt động. Theo dõi tỷ lệ 5xx, p95, CPU, RAM worker, số kết nối PostgreSQL và thời gian chờ trong hàng đợi.
- WORKER_RUN_SLOTS nhân với số worker cho biết số run xử lý song song tối đa. WORKER_HOMEWORK_CONCURRENCY giới hạn số bài trong từng run. MAX_QUEUED_RUNS giới hạn tổng run chờ và đang chạy. API trả 503 kèm Retry-After khi đầy. Tăng số worker dựa trên kết quả đo và giới hạn OLM, nhà cung cấp AI.
- Kiểm tra redeploy, dừng worker và khôi phục cơ sở dữ liệu trên staging. Job đang chờ được lưu trong PostgreSQL. Nếu mất worker sau khi bắt đầu, job được đánh dấu gián đoạn để người dùng kiểm tra OLM trước khi thử lại. Bật HA PostgreSQL trên gói đủ điều kiện nếu cần chuyển đổi dự phòng, và theo dõi uptime từ bên ngoài.
