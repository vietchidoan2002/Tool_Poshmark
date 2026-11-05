# Triển khai bản web xem thử trên Render

Bản này nằm ở nhánh `preview/ui-single-pass-ocr`; không gộp vào `master`. Máy chủ web/API và PostgreSQL là dịch vụ có phí trong blueprint này: xem tổng phí Render hiển thị trước khi tạo. Tên miền riêng chưa bắt buộc. Không tải credentials.json/token cá nhân lên Render hoặc GitHub.

## 1. Tạo OAuth client dành cho website

Trong Google Cloud Console, tạo/chọn project, bật Gmail API và Google Sheets API. Thiết lập Google Auth Platform/OAuth consent screen. Chọn External nếu người ngoài tổ chức cũng cần đăng nhập. Trong lúc Testing, thêm email của bạn và các người dùng thử vào Test users.

Tạo OAuth client loại **Web application** (không dùng Desktop client của tool cũ). Lấy Client ID và Client secret; chỉ nhập chúng vào mục Environment trên Render. Có thể tạo client trước, bổ sung redirect URL sau khi Render cấp địa chỉ website.

## 2. Tạo Blueprint

Trong Render, chọn **New → Blueprint**, kết nối repository `vietchidoan2002/Tool_Poshmark` và chọn nhánh **preview/ui-single-pass-ocr**. Chỉ dùng file `render.web.yaml` cho giai đoạn web đầy đủ có trả phí; không dùng Blueprint mặc định vì `render.yaml` hiện dành cho Static Site xem thử. Có thể tạo Web Service và PostgreSQL thủ công theo file `render.web.yaml`. Kiểm tra plan và chi phí trước khi xác nhận tạo tài nguyên. Nếu tài khoản không hỗ trợ đúng tên plan trong YAML, chọn plan PostgreSQL bền vững có sẵn trong tài khoản, không dùng cơ sở dữ liệu tạm thời cho tài khoản thật.

Nhập `GOOGLE_CLIENT_ID` và `GOOGLE_CLIENT_SECRET` khi Render hỏi. Database URL và hai khóa bí mật được Blueprint tạo/tham chiếu tự động. Giữ nguyên SESSION_SECRET và TOKEN_ENCRYPTION_KEY khi triển khai phiên bản sau. Mất/đổi khóa mã hóa sẽ khiến token cũ không đọc được. Không gửi các giá trị này qua chat.

Đợi deploy báo Live. Copy địa chỉ HTTPS Render cấp, ví dụ `https://ten-web.onrender.com`. Không thêm dấu / phía sau khi đặt PUBLIC_BASE_URL nếu cần override tên miền mặc định.

## 3. Đăng ký callback Google

Quay lại OAuth client của Google, thêm **Authorized redirect URI**:

`https://TEN-WEB-CUA-BAN.onrender.com/oauth2callback`

Thay phần tên bằng địa chỉ thật, không dùng ví dụ nguyên văn. Nếu dùng custom domain, đặt PUBLIC_BASE_URL trên Render bằng origin HTTPS đó và đăng ký callback tương ứng.

## 4. Kiểm tra trước khi mời nhiều người

Mở website, chọn Đăng nhập bằng Google. Mỗi tài khoản tự nhập Sheet ID; không phải upload JSON/token. Cut Label dùng được mà không đăng nhập và xử lý file ngay trong trình duyệt. Vận đơn không được gửi lên server.

Dùng hai trình duyệt/phiên riêng để đăng nhập hai người, xác nhận cấu hình và trạng thái Gmail không xuất hiện chéo. Chỉ chạy Get Label trên dữ liệu được cho phép; nó ghi Sheets và đánh dấu email đã xử lý là đã đọc. Kiểm tra logout, reconnect, restart và persistence trên Render sau triển khai. Các kiểm thử tự động dùng giả lập Google và PostgreSQL trong bộ nhớ, không thay thế kiểm tra Render/PostgreSQL thật hoặc luồng đăng nhập Google thật.

Gmail modify là quyền Google hạn chế. Chế độ Testing có giới hạn người thử và vòng đời refresh token; để mở công khai cho nhiều người có thể cần Google xác minh ứng dụng và các yêu cầu bổ sung. Không hứa phát hành công khai chỉ bằng việc deploy lên Render.

## Cập nhật về sau

Render triển khai code mới từ nhánh được liên kết theo cài đặt auto-deploy của dịch vụ. Không đổi master hoặc nhánh deploy nếu chưa duyệt. Mỗi bản build nhúng commit ID; người dùng đang mở web được báo khi có phiên bản mới, rồi tự chọn tải lại sau khi đã xuất PDF. Không tự tải lại và làm mất file đang mở.

Triển khai lại không được xóa cơ sở dữ liệu hoặc đổi khóa. Người dùng vào cùng địa chỉ web, không cần tải/cài tool lại. Khi duyệt bản web xong, mới quyết định nhánh dùng cho production.
