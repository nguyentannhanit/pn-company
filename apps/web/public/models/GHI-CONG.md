# Mô hình 3D trong thư mục này

Tất cả của **Quaternius**, tải qua poly.pizza. Trang gốc quaternius.com ghi CC0
cho cả hai bộ "Ultimate Modular Men/Women"; poly.pizza ghi một vài mẫu là
CC-BY 3.0. Ghi công ở đây cho chắc, vì làm vậy thoả cả hai giấy phép.

| Tệp | Dùng cho | Bộ |
|---|---|---|
| `le-tan-nam.glb` | Khang — trợ lý ở khung hỏi đáp và sảnh văn phòng 3D | Ultimate Modular Men |
| `nv-nam-thuong.glb` | Nhân viên phòng ban | Ultimate Modular Men |
| `nv-nam-hoodie.glb` | Nhân viên phòng ban | Ultimate Modular Men |
| `nv-nu-thuong.glb` | Nhân viên phòng ban | Ultimate Modular Women |
| `bao-ve.glb` | Hai bảo vệ đi tuần ngoài sân (mẫu "SWAT") | Ultimate Modular Men |


## Cần biết khi sửa

- Tên clip động tác có tiền tố `CharacterArmature|` (xem `src/three/Reception.tsx`).
- Tên xương khi nạp vào three.js **mất dấu chấm**: `UpperLeg.L` thành `UpperLegL`
  (xem `BONE` trong `src/three/human.ts`).
- Xương bàn chân nằm dưới `Root`, KHÔNG dưới cẳng chân. Uốn chân mà quên dời bàn
  chân thì giày đứng rời tại chỗ cũ.
- Tư thế gốc là đứng thẳng, tay buông, mặt nhìn về +Z. Mọi cử động phải xoay
  THÊM từ tư thế gốc (`rest * delta`), gán đè góc thì đầu quay ngược, tay vung
  ra sau.
- Tay và chân KHÔNG xoay quanh trục riêng của xương: trục đó mỗi mẫu một kiểu
  (mẫu nữ lệch hẳn mẫu nam) và tư thế gốc chân phải đã chĩa ra trước ~22°. Tay
  chân được đặt theo HƯỚNG đích trong khung cơ thể (`poseLimb` trong
  `Employee.tsx`). Xoay trục riêng từng gây: chân mẫu nữ chéo ra sau xuyên
  ghế, tay gõ phím chắp trước ngực, tay ăn mừng bắt chéo chữ X. Chỉ
  đầu và thân còn gật quanh trục riêng (trục ở đó thẳng).
- Hai mẫu áo bảo hộ (`nv-*-ky-thuat`) đã xoá: không muốn nhân viên
  công ty phần mềm đội mũ công trường.
- Vật liệu gốc đặt kim loại 0.4 và rất bóng nên mặt low-poly lên thành ô loang
  lổ; `useHuman` làm mờ lại (kim loại 0, nhám 0.78).
- Trợ lý chạy clip quay sẵn; nhân viên phòng ban thì đặt góc khớp theo trạng
  thái công việc (`src/three/Employee.tsx`), giữ đúng chuyển động của nhân vật
  khối cũ.
