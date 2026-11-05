# Đăng nhập/đăng ký email và mật khẩu

Mở URL gốc của Web Service sẽ hiện form đăng nhập. Phải đăng nhập và xác nhận email mới vào được Get Label, Cut Label và Hồ sơ. Bản Web Service có các trang `/#/login`, `/#/register`, `/#/forgot`, `/#/reset-password` và `/#/verify-email`. Static Site xem thử vẫn chỉ có Cut Label, không có máy chủ để lưu mật khẩu.

- Đăng ký: tên hiển thị, email, **số điện thoại bắt buộc**, mật khẩu 8–128 ký tự, xác nhận mật khẩu, đồng ý điều khoản. Tài khoản mới được tạo riêng với mật khẩu băm scrypt và salt ngẫu nhiên. Không gửi hoặc lưu mật khẩu dạng rõ. Số được kiểm tra định dạng, chuẩn hóa E.164 và chống trùng ở máy chủ; tài khoản và số được lưu trong cùng giao dịch. Đăng ký không tự đăng nhập: giao diện quay về form đăng nhập kèm thông báo kết quả gửi email.
- Đăng nhập: email/mật khẩu, hiện/ẩn mật khẩu, trạng thái loading và ghi nhớ đăng nhập. Không chọn ghi nhớ: cookie theo phiên trình duyệt, phiên máy chủ tối đa 12 giờ. Có ghi nhớ: tối đa 30 ngày. Nên không chọn trên máy dùng chung.
- Tài khoản mới đăng nhập khi chưa xác nhận email sẽ chỉ thấy trang kích hoạt: gửi lại email, kiểm tra lại trạng thái hoặc đăng xuất. Chưa xác nhận thì API công cụ cũng từ chối yêu cầu. Không tự gộp tài khoản chưa xác nhận với một danh tính Google chỉ vì trùng email.
- Google cũ vẫn đăng nhập được bằng tùy chọn Google. Người dùng email/mật khẩu xác nhận email rồi kết nối Google: token gắn với tài khoản website đang đăng nhập, không đổi danh tính website sang tài khoản Gmail được kết nối.
- Quên mật khẩu gửi thông báo giống nhau cho email có/không có tài khoản và không chờ độ trễ gửi thư của nhà cung cấp. Tác vụ gửi chạy trong tiến trình máy chủ với hàng chờ nhỏ; restart/deploy giữa chừng có thể làm mất lần gửi đang chạy, lúc đó người dùng yêu cầu lại. Liên kết reset hết hạn sau 30 phút, xác nhận email sau 24 giờ, chỉ dùng một lần và chỉ lưu hash token. Token nằm trong fragment URL, được xóa khỏi thanh địa chỉ sau khi đọc; không gửi token trong query string cho máy chủ hoặc ghi log. Xác nhận email yêu cầu đăng nhập đúng tài khoản đăng ký; nếu chưa đăng nhập, giao diện yêu cầu đăng nhập và giữ liên kết trong bộ nhớ để tiếp tục xác nhận. Nếu liên kết hết hạn, quay lại tài khoản để gửi lại.
- Reset mật khẩu vô hiệu hóa mọi phiên mật khẩu cũ. Tài khoản Google cũ có thể tạo mật khẩu bằng luồng khôi phục email; quyền kết nối Google/Sheet vẫn giữ nguyên. Luồng này được ghi nhận là legacy-google-reset, không giả lập đồng ý đăng ký mới.
- Giới hạn thử đăng nhập/gửi mail theo IP, khóa tạm sau nhiều lần sai và ngân sách tối đa 50 lần gửi email/ngày UTC. Tài nguyên băm mật khẩu cũng được giới hạn đồng thời để tránh vượt RAM Free.

## Số điện thoại và hồ sơ

Số điện thoại được thu ngay trong form đăng ký. Sau khi đăng nhập và xác nhận email, mở **Hồ sơ / Quản trị** để sửa số; quản trị viên có thể tìm, sửa, xóa, kiểm tra số. Get Label chỉ hiển thị cấu hình Gmail/Sheets, không chen form điện thoại.

Để kích hoạt bằng **email** và kiểm tra SĐT sau, đặt `REQUIRE_REVIEWED_PHONE=false` trong Render → Environment rồi deploy lại. Đổi blueprint không tự ghi đè biến đã nhập thủ công trong dịch vụ cũ. Đây cũng là mặc định của render.web.yaml mới. Nếu chủ website chủ động bật `true`, Get Label vẫn yêu cầu kiểm tra số thủ công; xác nhận email không thay thế bước đó. Không có SMS OTP và không xác minh SIM chính chủ.

## Gửi email bằng Gmail của quản trị viên

Không bắt buộc mua dịch vụ SMS hoặc dùng SMTP. Phương án mặc định được chuẩn bị là Gmail API (HTTPS), dùng tài khoản Gmail mà bạn đồng ý dùng làm người gửi. Google vẫn có giới hạn gửi thư và chính sách chống spam, không phải gửi không giới hạn.

1. Giữ OAuth Web client hiện tại và callback đã đăng ký.
2. Chủ website đăng nhập bằng nút **Tiếp tục với Google**, dùng chính email trong ADMIN_EMAILS và cấp đủ quyền. Cách này vẫn hoạt động để bạn vào quản trị dù chưa cấu hình gửi email cho tài khoản mật khẩu.
3. Trong Render Web Service → Environment, thêm:
   - `AUTH_MAIL_PROVIDER=gmail`
   - `AUTH_MAIL_SENDER_EMAIL`: đúng email Gmail quản trị viên đã kết nối ở bước 2.
4. Deploy lại. Chỉ sau cấu hình này, ứng dụng mới dùng Gmail đó để gửi email xác nhận/khôi phục. Không tự dùng token của người dùng khác làm người gửi.
5. Tạo tài khoản thử bằng email khác, kiểm tra nhận mail (kể cả Spam), xác nhận đúng phiên, reset một lần rồi thử đăng nhập lại. Không chia sẻ link reset hoặc secret.

Nếu Gmail quản trị chưa kết nối, đã ngắt kết nối, sai tài khoản gửi hoặc vượt quota, email có thể không đến; tài khoản mới vẫn ở trạng thái chưa xác nhận. Không đánh dấu email đã gửi/thành công chỉ dựa trên việc bấm nút. Email xuất hiện trong Sent của người gửi theo hành vi Gmail bình thường. Ứng dụng không gửi PDF hoặc nội dung đơn hàng trong email xác nhận.

Nếu không có cấu hình gửi email, giao diện thông báo rõ. Quên mật khẩu trả lỗi chưa cấu hình, không giả vờ đã gửi. Tài khoản đăng ký mới sẽ cần chờ quản trị viên bật gửi mail rồi chọn **Gửi lại email xác nhận**.

## Tùy chọn dịch vụ email khác

Có hỗ trợ adapter Resend với `RESEND_API_KEY` và `AUTH_EMAIL_FROM` nếu bạn đã có sender/domain được nhà cung cấp xác nhận. Không cam kết gửi cho mọi người miễn phí khi chưa có domain và chưa kiểm tra hạn mức. Không đặt hai phương án cùng lúc nếu chưa xác định muốn dùng Gmail hay Resend.

## Vận hành

Các bảng `pm_password_accounts`, `pm_account_actions` và `pm_mail_budget` được tạo thêm; không xóa users/token/phone cũ. Không đổi SESSION_SECRET hoặc TOKEN_ENCRYPTION_KEY để cài tính năng này. Quyền admin vẫn do ADMIN_EMAILS phía máy chủ, không phải checkbox/body mà người dùng gửi lên. Chưa xác nhận email thì không được admin, dù nhập trùng email admin trong form.

Kiểm thử tự động dùng email giả lập; chưa gửi email Gmail thật hoặc kiểm tra Google/Render thật thay cho cấu hình của bạn. Điều khoản/chính sách hiển thị cần chủ website xem lại và bổ sung kênh liên hệ hỗ trợ trước khi mở đăng ký công khai.
