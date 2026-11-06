# Dashboard quản trị

## Tài khoản và địa chỉ quản trị

Dùng Gmail quản trị hiện tại trong `ADMIN_EMAILS` trên Render. Tài khoản này phải xác nhận email hoặc đăng nhập Google thành công. Không tạo tài khoản trùng email và không có mật khẩu quản trị mặc định dùng chung.

Sau deploy, đăng nhập lại rồi bấm **Quản trị** ở góc phải trên. Địa chỉ trực tiếp: `https://poshmark-label-web.onrender.com/#/admin`. Người dùng thường không thấy nút; API quản trị cũng kiểm tra quyền ở máy chủ. Chỉ thêm người quản trị khác bằng cách chủ website cập nhật `ADMIN_EMAILS` trên Render. Form tài khoản không cho tự cấp quyền quản trị.

Bản cập nhật bổ sung các cột quản lý vào `pm_users`, bảng `pm_get_runs`, `pm_admin_audit`, `pm_app_metadata` và các index. Giữ nguyên database/khóa phiên/khóa mã hóa. Người dùng cần đăng nhập lại lần đầu sau cập nhật vì phiên được bổ sung phiên bản tài khoản để khóa/xóa có hiệu lực. Không cần dịch vụ trả phí mới.

## Thêm, sửa, khóa và xóa

- **Thêm tài khoản**: nhập họ tên, email và SĐT hợp lệ. Nếu chọn gửi thư, người dùng nhận liên kết tự đặt mật khẩu. Admin không biết hoặc nhận mật khẩu của người dùng. Tài khoản cũng có thể đăng nhập Google đúng email. Tài khoản do admin tạo ghi nhận `admin-created`, không giả lập việc người dùng đã tích đồng ý điều khoản đăng ký.
- Nếu gửi thư thất bại, giao diện nói rõ **đã tạo tài khoản nhưng chưa gửi được thư**. Không tạo lại; dùng **Gửi thư** trên dòng tài khoản sau khi sửa kết nối gửi mail.
- **Sửa**: thay đổi họ tên, SĐT và trạng thái Hoạt động/Đã khóa. Email đăng nhập là định danh cố định. Thay SĐT bỏ trạng thái kiểm tra số cũ. Lưu cùng phiên bản dữ liệu và phiên bản SĐT; nếu dữ liệu đã thay đổi, đóng form, cập nhật danh sách rồi sửa lại.
- **Khóa**: chặn đăng nhập/API và vô hiệu hóa phiên cũ. Mở khóa không tự làm sống lại các cookie cũ. Tài khoản quản trị trong `ADMIN_EMAILS` không bị khóa/xóa từ dashboard để tránh mất quyền truy cập.
- **Xóa** là xóa khỏi hoạt động: người dùng bị ngắt phiên, ngắt Gmail trên website, mật khẩu bị vô hiệu hóa, SĐT được giải phóng. Email/tên và lịch sử thống kê được giữ trong mục **Đã xóa**; đây không phải chức năng xóa vĩnh viễn mọi dữ liệu cá nhân. Google không tạo lại một tài khoản trùng email đã xóa.
- **Khôi phục**: mở mục Đã xóa, chọn Khôi phục. Người dùng cần kết nối lại Google hoặc tự đặt mật khẩu qua email và bổ sung SĐT.
- Nếu tài khoản đang chạy Get Label, sửa/khóa/xóa trả thông báo chờ hoàn tất. Không vô hiệu hóa giữa chừng khi đang ghi Sheets.

Có tìm theo tên/email/SĐT, lọc trạng thái và phân trang. **Chi tiết** hiển thị các tên account Poshmark đã dùng và 50 lượt Get Label gần nhất. Các thao tác quản lý được lưu bằng mã tài khoản và hành động trong `pm_admin_audit`, không lưu mật khẩu hay nội dung email.

## Các chỉ số

- Hoạt động chỉ được ghi từ mốc **Hoạt động được ghi nhận từ…** ở dashboard. Không tự đọc lại Google Sheets/email của mọi người để cộng lịch sử cũ.
- Tài khoản cũ chưa có ngày đăng ký được giữ `created_at=NULL`, hiển thị chưa ghi nhận và không tính thành người đăng ký mới khi deploy.
- **Đơn ghi được**: số Order ID được ghi thành công trong lượt chạy. Một đơn nhiều sản phẩm vẫn tính một đơn; bộ đếm dòng sản phẩm cũ của bot vẫn được giữ riêng. Nếu lượt chạy lỗi sau khi ghi được một phần, phần đã ghi vẫn được thống kê. Đây là số lần xử lý đơn theo lượt chạy, không phải doanh thu hay số đơn duy nhất trên toàn Poshmark qua mọi bảng tính.
- **Lượt chạy / người sử dụng / bỏ qua / lỗi** lấy từ kết quả máy chủ. Các yêu cầu thiếu cấu hình hoặc bị chặn quyền không được coi là một lượt đã bắt đầu. Lượt chưa chốt được hiển thị riêng; không khẳng định đã thành công. Khi database không chốt được thống kê, máy chủ ghi `[USAGE_WRITE_FAILED]` và lượt có thể tiếp tục ở trạng thái chưa chốt.
- **Gmail** là số kết nối đang lưu trên website (hiện mỗi người tối đa một Gmail). Không gọi Google hàng loạt để kiểm tra token còn hiệu lực khi mở dashboard.
- **ACC Poshmark** là số tên account đã dùng khi chạy Get Label, không phân biệt chữ hoa/thường. Công cụ hiện không đăng nhập trực tiếp Poshmark, nên không coi đây là số danh tính được Poshmark xác minh hay số kết nối OAuth Poshmark.
- Hoạt động gần nhất được cập nhật khi đăng nhập/mở web; việc ghi nhận phiên được giới hạn tối đa một lần mỗi 5 phút. Biểu đồ nhóm ngày theo giờ Việt Nam, bộ lọc 7/30/90 ngày áp dụng cho kết quả Get Label; cột số liệu từng người là toàn bộ lịch sử đã ghi nhận.
- Gợi ý phát triển sử dụng tỷ lệ kích hoạt, kết nối Gmail, người chạy Get Label và lỗi. Cần đủ 14 ngày để so sánh người đăng ký mới hai tuần. Không tạo điểm tiềm năng/doanh thu dự báo khi chưa có dữ liệu.

PDF Cut Label vẫn xử lý trong trình duyệt. Dashboard không lưu PDF, nội dung Gmail, buyer, tracking hay Order ID vào bảng thống kê; chỉ lưu tổng số, tên account cấu hình và thời gian.

## Kiểm thử

`npm test` kiểm tra quyền, CRUD, trạng thái/phiên, dữ liệu trùng, thống kê thành công/lỗi một phần, khóa khi đang nhập đơn và kiểm đếm đơn nhiều sản phẩm. `npm run test:browser` kiểm tra dashboard, form thêm/sửa/xóa/khôi phục, thông báo lỗi, chi tiết, phân quyền giao diện và màn hình điện thoại, cùng các kiểm thử label cũ.

Với `IDENTITY_PG_MODULE` trỏ đến package PGlite tạm như hướng dẫn EMAIL-PASSWORD-AUTH.md, bộ kiểm thử bổ sung PostgreSQL thực cho câu truy vấn dashboard và rollback khi sửa/gộp bị gián đoạn. Không gọi Gmail/Sheets thật trong các kiểm thử tự động. Cần kiểm tra một lượt Get Label đã được phép trên dữ liệu thật sau khi deploy để xác nhận cấu hình Google và số liệu vận hành.
