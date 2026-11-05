# Bản xem thử không tạo dịch vụ trả phí

Trong Render chọn **New → Static Site** (không chọn Web Service hoặc PostgreSQL).

1. Kết nối GitHub repository `vietchidoan2002/Tool_Poshmark`.
2. Branch: `preview/ui-single-pass-ocr`.
3. Name: tên tùy chọn, ví dụ `poshmark-label-preview`.
4. Build Command: `npm ci --include=dev && npm run build:preview`.
5. Publish Directory: `dist`.
6. Environment Variable: `VITE_PREVIEW_ONLY` = `true`.
7. Kiểm tra đây là Static Site và Render không yêu cầu xác nhận dịch vụ trả phí. Chọn Deploy Static Site.
8. Khi báo Live, mở địa chỉ HTTPS Render cấp. Mời người thử bằng cùng địa chỉ đó.

Có thể dùng New → Blueprint với render.yaml mặc định; file này cũng chỉ chứa Static Site. `render.web.yaml` là cấu hình cho bản web đầy đủ có tài nguyên trả phí, không sử dụng trong giai đoạn xem thử này.

Bản thử có Cut Label thật, nhập PDF/OCR/đổi tên/xuất file trong trình duyệt. Không upload PDF lên máy chủ. Không kết nối Gmail/Sheets, không yêu cầu credentials/token. Giao diện ghi rõ giới hạn này. Chỉ bật Gmail sau khi triển khai máy chủ đăng nhập và cơ sở dữ liệu, đã cấu hình Google OAuth và kiểm tra tài khoản riêng trên dịch vụ thật.

Để các bản sửa sau tự xuất hiện trên cùng URL, bật Auto-Deploy cho nhánh xem thử trong Settings của Static Site. Người dùng tải lại trang để nhận bản mới; hãy xuất các label đang mở trước khi tải lại.
