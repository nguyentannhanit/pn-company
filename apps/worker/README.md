# apps/worker — chạy agent run trong sandbox

**Phase:** 2 (§18, §23)
**Stack:** BullMQ, Redis, `@pn/orchestrator`, `@pn/sandbox`

Nhận việc từ hàng đợi `pn-agent-runs` và chạy agent trong sandbox. Tách khỏi API
vì một lượt agent chạy có thể mất vài phút và ăn nhiều RAM; để trong API thì một
dự án nặng làm chậm cả dashboard.

## Chỉ chạy khi có Redis

Không đặt `REDIS_URL` thì API dùng hàng đợi trong bộ nhớ và tự chạy agent — hệ
thống vẫn hoạt động đầy đủ, chỉ là mọi thứ nằm trong một tiến trình. Worker chỉ
có việc để làm khi API và worker cùng trỏ vào một Redis.

## Chạy

```bash
npm run dev:worker
```

Cần các biến sau, **giống hệt** giá trị của tiến trình API:
`REDIS_URL`, `DATABASE_URL`, `PN_SERVICE_SECRET`, `API_PUBLIC_URL`,
`SANDBOX_ROOT`, `SANDBOX_DRIVER`.

Worker **không** cần `PN_MASTER_KEY`.

## Ranh giới được giữ nguyên

- Không giữ master key. Token GitHub xin từ API qua `/internal/github/config`,
  đúng cách tiến trình Telegram bot vẫn làm (§19, §69).
- Không gọi thẳng provider. Mọi lượt gọi model đi qua `/ai/generate`, nên ngân
  sách, định tuyến và `cost_records` vẫn được áp như cũ (§89).
- Phiên dịch vụ mang vai trò `AGENT`, không phải `SYSTEM`: worker không bao giờ
  có quyền phê duyệt (§20, §83).
- Event đi qua Redis pub/sub nên văn phòng 3D vẫn thấy agent chuyển động dù việc
  chạy ở tiến trình khác (§21, §22).

## Đánh đổi đã biết

Worker chạy `concurrency: 1`. Các run của cùng một dự án thao tác trên cùng cây
thư mục nên phải nối tiếp; BullMQ bản mã nguồn mở không có hàng đợi theo nhóm,
nên cách chắc chắn duy nhất là chạy tuần tự. Hệ quả: hai dự án khác nhau cũng
không chạy song song. Đó là cái giá cho việc không bao giờ có hai agent cùng ghi
vào một thư mục.
