# P&N — Hướng dẫn chạy thử

Cần Node.js 20.10 trở lên và npm (chạy `npm install` ở thư mục dự án trước).
Ngoài ra cần **hai thứ bắt buộc**: một PostgreSQL và một API key AI.

---

## Bước 1 — Cài PostgreSQL

Chọn **một** trong hai cách.

### Cách A — cài trên máy (khuyến nghị, chạy offline được)

Mở **PowerShell với quyền Administrator**, chạy:

```powershell
winget install PostgreSQL.PostgreSQL.17
```

Trình cài sẽ hỏi mật khẩu cho user `postgres` — **nhớ mật khẩu này**, lát nữa
điền vào `.env`. Các mục còn lại cứ bấm Next, để mặc định (cổng 5432).

Cài xong, mở PowerShell **mới** rồi tạo database:

```powershell
& "C:\Program Files\PostgreSQL\17\bin\createdb.exe" -U postgres -h localhost pn_company
```

Nó sẽ hỏi mật khẩu vừa đặt. Không báo gì tức là đã tạo xong.

### Cách B — dùng Supabase (không cài gì, cần mạng)

1. Vào https://supabase.com → tạo tài khoản → **New project**.
2. Đặt mật khẩu database, chọn region gần (Singapore).
3. Vào **Project Settings → Database → Connection string → URI**, copy chuỗi đó.

---

## Bước 2 — Điền `.env`

Tạo `.env` từ file mẫu và sinh ba khoá bí mật:

```powershell
Copy-Item .env.example .env
node -e "for (const k of ['PN_MASTER_KEY','JWT_SECRET','PN_SERVICE_SECRET']) console.log(k + '=' + require('crypto').randomBytes(32).toString('base64'))"
```

Mở `.env`, thay ba dòng `PN_MASTER_KEY=`, `JWT_SECRET=`, `PN_SERVICE_SECRET=` bằng ba dòng vừa in ra.
Rồi sửa dòng `DATABASE_URL`:

**Nếu dùng cách A:**

```env
DATABASE_URL=postgresql://postgres:MAT_KHAU_CUA_BAN@localhost:5432/pn_company
```

**Nếu dùng cách B (Supabase):**

```env
DATABASE_URL=<chuỗi URI Supabase vừa copy>
DATABASE_SSL=true
```

> Nếu mật khẩu có ký tự đặc biệt (`@`, `#`, `/`, `:`) thì phải mã hoá URL.
> Ví dụ `p@ss#1` → `p%40ss%231`. Cách tránh phiền: đặt mật khẩu chỉ gồm chữ và số.

---

## Bước 3 — Tạo bảng và chạy

Mở terminal ở thư mục dự án:

```bash
npm run db:migrate
```

Kết quả mong đợi: `applied 0001_init.sql`, `0002_api_center.sql`,
`0003_knowledge.sql` — tổng 41 bảng.

Rồi mở **hai terminal**:

```bash
# Terminal 1 — API, AI Gateway, WebSocket
npm run dev:api
```

```bash
# Terminal 2 — Dashboard
npm run dev:web
```

Mở trình duyệt: **http://localhost:3000**

---

## Bước 4 — Thiết lập trong giao diện

1. Màn hình đầu tiên là **Welcome to P&N** — tạo tài khoản CEO (email, tên, mật
   khẩu tối thiểu 8 ký tự).
2. Vào **Cài đặt** → ô **Anthropic** → dán API key → **Lưu** → **Test Connection**.
   - Lấy key ở https://console.anthropic.com → API Keys.
   - Key được mã hoá AES-256-GCM rồi mới lưu; tải lại trang sẽ chỉ thấy
     `sk-ant…abcd`, không lấy lại được key thô (§88.3).
3. Vẫn ở Cài đặt, mục **Định tuyến model** → bấm **Tạo bảng định tuyến mặc định**.
   - Nó gán model theo đúng nguyên tắc §15: CTO/Architect dùng hạng mạnh,
     PM/QA dùng hạng trung, việc cơ học dùng hạng rẻ.
4. Về **Tổng quan** → **Giao việc mới** → mô tả bằng tiếng Việt, ví dụ:

   > Làm web đặt bàn cho quán cà phê. Khách chọn ngày, giờ, số người và để lại số
   > điện thoại. Chủ quán xem danh sách đặt bàn theo ngày.

5. Xem CTO phân rã kế hoạch, rồi các nhân vật trong văn phòng 3D lần lượt chuyển
   sang trạng thái **đang làm**.

---

## Chi phí thật

Mỗi lần giao việc là gọi model thật và **tốn tiền thật**. Trần mặc định trong
`.env` là **$5 mỗi dự án** (`DEFAULT_PROJECT_BUDGET_USD=5`), chạm 80% thì cảnh
báo, chạm 100% thì agent dừng lại. Một dự án nhỏ như ví dụ trên thường tốn khoảng
$0.30–$1.50 tuỳ độ phức tạp.

Muốn thử rẻ hơn: đổi định tuyến của các vai trò về model hạng `cheap`
(Claude Haiku 4.5) ở Cài đặt trước khi giao việc đầu tiên.

---

## Hai thứ tuỳ chọn

### Telegram Bot (§5)

1. Trên Telegram, nhắn **@BotFather** → `/newbot` → đặt tên → nhận token.
2. Nhắn **@userinfobot** để lấy chat id của bạn.
3. Điền vào `.env`:
   ```env
   TELEGRAM_BOT_TOKEN=<token từ BotFather>
   TELEGRAM_ALLOWED_CHAT_IDS=<chat id của bạn>
   ```
4. Vào dashboard → **Cài đặt** → thêm tài khoản có `telegramChatId` là chat id đó
   (hoặc cập nhật tài khoản CEO), rồi chạy terminal thứ ba:
   ```bash
   npm run dev:bot
   ```
5. Nhắn `/start` cho bot.

> Không cấu hình Telegram thì mọi thứ khác vẫn chạy bình thường.

### GitHub (§17)

Không có GitHub thì agent vẫn viết code vào thư mục `workspaces/`, chỉ là không
commit lên repo. Muốn có:

1. https://github.com/settings/tokens → **Generate new token (classic)** →
   tick quyền `repo`.
2. Dashboard → Cài đặt → GitHub → dán token.
3. Khi giao việc, điền `repoFullName` dạng `tên-tài-khoản/tên-repo`.

---

## Khi gặp trục trặc

| Hiện tượng | Nguyên nhân thường gặp |
|---|---|
| `ECONNREFUSED ... 5432` | PostgreSQL chưa chạy. Mở `services.msc`, tìm `postgresql-x64-17`, bấm Start. |
| `password authentication failed` | Sai mật khẩu trong `DATABASE_URL`, hoặc mật khẩu có ký tự đặc biệt chưa mã hoá URL. |
| `database "pn_company" does not exist` | Chưa chạy lệnh `createdb` ở Bước 1. |
| Dashboard báo "Không kết nối được tới máy chủ P&N" | Terminal chạy `npm run dev:api` đã tắt hoặc lỗi — xem log ở terminal đó. |
| Giao việc báo lỗi 503 | Chưa cấu hình provider AI, hoặc chưa tạo bảng định tuyến (Bước 4.2 và 4.3). |
| Giao việc báo lỗi 402 | Đã chạm trần ngân sách dự án. Tăng ở Cài đặt → Ngân sách. |

Kiểm tra nhanh mọi thứ đã sẵn sàng chưa: vào **Cài đặt**, khối **Tình trạng hệ
thống** liệt kê từng mục còn thiếu.
