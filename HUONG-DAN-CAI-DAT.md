# P&N — Hướng dẫn cài đặt

**Build. Learn. Evolve.**

Tài liệu này dành cho người cài lần đầu trên máy Windows. Không cần biết lập trình.

---

## Cần có sẵn hai thứ

| Phần mềm | Lệnh cài | Vì sao cần |
|---|---|---|
| Node.js 20.10 trở lên | `winget install OpenJS.NodeJS.LTS` | Toàn bộ hệ thống chạy trên Node |
| PostgreSQL 17 | `winget install PostgreSQL.PostgreSQL.17` | Nơi lưu dự án, task, chi phí, API key đã mã hoá |

Mở **PowerShell** (bấm Start, gõ "powershell"), dán lệnh vào, Enter. Cài PostgreSQL sẽ hỏi mật khẩu cho tài khoản `postgres` — **ghi lại mật khẩu đó**, lát nữa cần dùng.

Cài xong thì **đóng và mở lại PowerShell** để máy nhận lệnh mới.

---

## Cài đặt

Bấm đúp vào **`cai-dat.cmd`**.

Script sẽ tự làm lần lượt:

1. Kiểm tra Node.js và PostgreSQL — thiếu thì báo đúng lệnh cần chạy rồi dừng
2. Hỏi mật khẩu `postgres`, tạo database `pn_company`
3. Tạo tệp `.env` với khoá mã hoá sinh riêng cho máy này
4. Cài thư viện (lần đầu mất vài phút)
5. Biên dịch backend và dashboard
6. Tạo bảng trong database
7. Chạy bộ test để chắc mọi thứ đúng

Chạy lại `cai-dat.cmd` nhiều lần không sao — bước nào xong rồi thì bỏ qua, và **`.env` đã có thì không bị ghi đè**.

> **Sao lưu tệp `.env`.** Trong đó có `PN_MASTER_KEY` — khoá giải mã mọi API key bạn lưu vào hệ thống. Mất khoá này thì phải nhập lại toàn bộ key.

---

## Khởi động

Bấm đúp **`chay.cmd`**, đợi dòng chữ xanh, rồi mở **http://localhost:3000**.

Dừng lại: bấm đúp **`dung.cmd`**.

Log nằm trong thư mục `logs/` nếu có gì đó không lên được.

---

## Bốn bước đầu tiên trong ứng dụng

1. **Tạo tài khoản CEO.** Lần đầu vào, trang đăng nhập cho tạo tài khoản chủ. Chỉ tạo được một lần.
2. **Vào Cài đặt → AI Providers.** Dán API key của Anthropic, OpenAI hoặc Google, bấm **Test Connection**. Kết nối thành công thì bảng định tuyến model được tạo luôn.
3. **Kiểm tra Cài đặt → Định tuyến model.** Phải thấy vai trò `CTO_ORCHESTRATOR` đã có model. Chưa có thì bấm "Tạo bảng định tuyến mặc định".
4. **Ra trang Tổng quan, giao việc đầu tiên.** Gõ mục tiêu vào ô giao việc. CTO sẽ phân rã thành task và văn phòng 3D bắt đầu chuyển động.

Nếu bấm giao việc mà bị chặn, thông báo sẽ nói rõ đang thiếu bước nào và cần vào đâu.

---

## Lấy API key ở đâu

| Nhà cung cấp | Trang lấy key |
|---|---|
| Anthropic (Claude) | https://console.anthropic.com/settings/keys |
| OpenAI | https://platform.openai.com/api-keys |
| Google (Gemini) | https://aistudio.google.com/apikey |

Key được mã hoá AES-256-GCM rồi mới lưu xuống database. Giao diện và API **không bao giờ** trả lại key nguyên bản — chỉ hiện dạng che `sk-…abcd`.

---

## Khi gặp trục trặc

| Hiện tượng | Cách xử lý |
|---|---|
| `cai-dat.cmd` báo thiếu Node hoặc PostgreSQL | Chạy lệnh `winget` trong bảng trên, mở lại PowerShell, cài lại |
| "Khong ket noi duoc PostgreSQL" | Mở Services, bật dịch vụ `postgresql-x64-17`; kiểm tra lại mật khẩu |
| Dashboard mở được nhưng trắng trang | Xem `logs/web.err.log` |
| Giao việc xong không thấy gì chạy | Vào dự án, bấm vào ô task đang bị chặn — lý do hiện ngay trong đó |
| Quên mật khẩu CEO | Hiện chưa có màn đặt lại; xoá dòng trong bảng `users` rồi tạo lại tài khoản đầu |

---

## Cần biết trước khi dùng thật

- Đây là bản chạy trên máy cá nhân, mở cổng ở `localhost`. Muốn cho người khác truy cập thì phải đặt sau reverse proxy có HTTPS.
- Mỗi lần agent gọi model là tốn tiền thật của tài khoản AI của bạn. Đặt trần ngân sách ở **Cài đặt → Ngân sách** trước khi giao việc lớn.
- Triển khai lên production luôn phải qua bước bạn duyệt. Agent không có quyền tự deploy.
