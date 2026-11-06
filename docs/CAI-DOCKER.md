# Cài Docker để cô lập sandbox

Mã do agent viết đang chạy trong sandbox **local**: nó bị giới hạn thư mục và
danh sách lệnh, nhưng không bị giới hạn RAM/CPU và không bị cắt mạng ở mức hệ
điều hành. Docker cho cả ba điều đó (§18); bộ kiểm tra `tools/check-docker.mjs`
đã chứng minh: container bị giết khi vượt trần RAM (exit 137), mạng bị cắt thật,
không ghi được ra ngoài workspace.

Cần làm **một lần**, khoảng 10 phút, tải ~500 MB.

## 1. Bật ảo hoá trong Windows

Mở PowerShell **quyền Administrator** và chạy:

```powershell
wsl --install --no-distribution
```

Máy sẽ yêu cầu khởi động lại. Nếu báo "ảo hoá chưa bật" thì vào BIOS bật
*Intel VT-x* / *AMD-V* (thường nằm trong mục Advanced → CPU Configuration).

## 2. Cài Docker Desktop

1. Tải bản Windows tại https://www.docker.com/products/docker-desktop/ (nút
   *Download for Windows – AMD64*).
2. Chạy file cài, giữ nguyên lựa chọn **Use WSL 2 instead of Hyper-V**.
3. Khởi động lại máy khi được hỏi, rồi mở Docker Desktop và chấp nhận điều khoản.
4. Vào **Settings → General**, bật *Start Docker Desktop when you sign in* để
   sandbox luôn sẵn sàng sau mỗi lần mở máy (công ty tự chạy lúc đăng nhập).

Kiểm tra trong PowerShell thường:

```powershell
docker run --rm hello-world
```

Thấy dòng "Hello from Docker!" là xong.

## 3. Bật chế độ cô lập cho P&N

Mở file `.env` ở thư mục dự án, sửa:

```
SANDBOX_DRIVER=docker
```

Ảnh dùng cho sandbox mặc định là `node:22-bookworm-slim` (đổi bằng
`SANDBOX_IMAGE=` nếu cần). Lần chạy đầu Docker tự tải ảnh (~80 MB).

Rồi khởi động lại công ty: bấm đúp `dung.cmd`, sau đó `chay.cmd` (hoặc mở
lại máy). Trang **Cài đặt → Sức khoẻ hệ thống** phải hiện mục Sandbox là
"Docker" thay vì "local".

## 4. Xác nhận cô lập thật

```powershell
node tools/check-docker.mjs
```

Năm mục phải đạt: chạy lệnh trong container, giết khi vượt RAM, cắt mạng, chặn
ghi ngoài workspace, dọn container sau khi xong.

## Nếu có trục trặc

- **"Docker Desktop requires a newer WSL kernel"** → chạy `wsl --update` rồi mở lại.
- **Docker chạy nhưng P&N vẫn báo local** → kiểm tra `.env` đã lưu đúng
  `SANDBOX_DRIVER=docker` và đã khởi động lại API.
- **Máy chậm khi Docker bật** → Settings → Resources, giảm Memory xuống 4 GB;
  sandbox chỉ cần vài trăm MB mỗi tác vụ.
- Muốn quay về chế độ cũ: đặt lại `SANDBOX_DRIVER=local` và khởi động lại.
