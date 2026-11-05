# Gmail/Sheets trên gói miễn phí: Render Free + Neon Free

Bản Static Site đang dùng không có API phía máy chủ, nên không thể bật Gmail chỉ bằng bỏ dòng thông báo. Tạo một Web Service gói **Free**, dùng PostgreSQL gói **Free** của Neon. Cấu hình nằm ở render.web.yaml trên nhánh preview/ui-single-pass-ocr; không đổi master. Không tạo Render PostgreSQL hoặc chọn plan trả phí.

## 1. Tạo cơ sở dữ liệu Neon Free

- Đăng ký tại https://console.neon.tech, tạo project với plan **Free**.
- Chọn region gần Render. Mở **Connect**, tắt **Connection pooling** và lấy connection string trực tiếp, không có `-pooler` trong hostname.
- Chỉ dán chuỗi này vào **DATABASE_URL** trong Environment của Render. Đây là mật khẩu truy cập database, không gửi qua chat hay commit lên Git.
- Ứng dụng dùng PostgreSQL session locks để tránh ghi trùng; transaction-pooler không phù hợp. Với Neon, mã máy chủ buộc `sslmode=verify-full`, không tắt xác minh chứng chỉ.

## 2. Tạo OAuth client cho web

- Vào https://console.cloud.google.com/, tạo/chọn project; bật **Gmail API** và **Google Sheets API**.
- Trong Google Auth Platform/OAuth consent, chọn External nếu có người ngoài tổ chức. Để Testing trước và thêm email của từng người thử vào **Test users**.
- Tạo OAuth client loại **Web application**, không dùng Desktop client cũ.
- Lưu Client ID và Client secret trong Environment của Render bằng các tên bên dưới. Không gửi secret/token qua chat.

## 3. Tạo Render Web Service Free

Chọn **New → Web Service**, kết nối repo vietchidoan2002/Tool_Poshmark. Đây là dịch vụ mới; Static Site cũ vẫn chỉ là Cut Label.

| Mục | Giá trị |
| --- | --- |
| Branch | preview/ui-single-pass-ocr |
| Runtime | Node |
| Build Command | npm ci --include=dev && npm test && npm run build:web |
| Start Command | npm run start:web |
| Instance Type | Free |
| Health Check Path | /healthz |

Thêm Environment Variables:

| Tên | Nội dung |
| --- | --- |
| NODE_ENV | production |
| APP_MODE | web |
| PG_POOL_MAX | 4 |
| DATABASE_URL | Connection string Neon trực tiếp |
| GOOGLE_CLIENT_ID | OAuth Web Client ID |
| GOOGLE_CLIENT_SECRET | OAuth Web Client secret |
| SESSION_SECRET | Chuỗi ngẫu nhiên riêng, ít nhất 32 ký tự |
| TOKEN_ENCRYPTION_KEY | Chuỗi ngẫu nhiên riêng khác, ít nhất 32 ký tự |

Dùng nút tạo giá trị ngẫu nhiên nếu giao diện có. Có thể tạo tại máy của bạn bằng Node: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` — chạy hai lần, mỗi kết quả dùng cho một khóa. Không gửi kết quả qua chat. Giữ nguyên hai khóa này qua các lần deploy sau, nếu không sẽ mất phiên đăng nhập hoặc không đọc được token đã lưu.

Không đặt VITE_PREVIEW_ONLY=true cho Web Service. Script build:web cũng chủ động bỏ cờ xem thử. Khi Render hiển thị Instance Free và không yêu cầu chấp thuận dịch vụ trả phí, hãy tạo service.

## 4. Callback Google

Khi Render cấp URL, ví dụ https://ten-web.onrender.com, thêm vào **Authorized redirect URIs** của OAuth Web client:

`https://TEN-WEB-THAT.onrender.com/oauth2callback`

Dùng đúng tên miền thật. Mặc định máy chủ lấy RENDER_EXTERNAL_HOSTNAME; nếu có custom domain thì đặt PUBLIC_BASE_URL bằng origin HTTPS của tên miền đó và đăng ký callback tương ứng.

Mở **URL Web Service mới**, không dùng URL Static Site cũ. Trang Get Label sẽ có **Đăng nhập bằng Google** thay cho thông báo “sẽ được bổ sung sau”. Mỗi người đăng nhập tài khoản riêng và tự lưu Sheet ID. Không upload credentials.json hay token_*.json lên web.

## 5. Kiểm tra trước khi mời nhiều người

- Kiểm tra /healthz trả ok và deploy báo Live.
- Đăng nhập hai tài khoản Test users bằng hai trình duyệt; kiểm tra Sheet ID, Gmail và trạng thái đăng xuất không xuất hiện chéo.
- Chạy Get Label chỉ trên dữ liệu được cho phép: ghi Sheets và đánh dấu email đã xử lý là đã đọc.
- Kiểm tra sau khi Web Service/Neon ngủ rồi thức lại; kiểm tra dữ liệu còn sau redeploy.
- Cut Label vẫn chạy trong trình duyệt, không cần đăng nhập và không tải vận đơn lên máy chủ.

## Giới hạn miễn phí

Không cấu hình tài nguyên trả phí hoặc tự nâng gói. Render Free/Neon Free có giới hạn và có thể ngủ, tạm dừng hoặc ngừng nhận thêm yêu cầu khi hết quota; lần truy cập đầu sau khi ngủ có thể chậm. Đọc chính sách hiện tại trong dashboard trước khi sử dụng, vì giới hạn/gói có thể thay đổi. Hết quota thì chờ hoặc giảm sử dụng, không tự chuyển sang trả phí.

Gmail modify là quyền hạn chế của Google. Trong Testing, chỉ dùng các email Test users; token có thể cần kết nối lại định kỳ. Phát hành công khai có thể yêu cầu Google xét duyệt và đánh giá bổ sung, nên không thể cam kết một dịch vụ công khai không giới hạn sẽ luôn miễn phí. Không cần mua tên miền để thử bằng URL Render.

## Cập nhật về sau

Bật Auto-Deploy của Web Service trên nhánh đã chọn nếu muốn nhận bản sửa sau khi push lên nhánh đó. Không tự gộp master. Người dùng đang mở web được báo phiên bản mới rồi tự tải lại sau khi xuất các label, không phải tải/cài lại phần mềm. Không xóa Neon hoặc thay khóa mã hóa khi cập nhật.

Kiểm thử tự động dùng Google giả lập và PostgreSQL trong bộ nhớ. Chúng không chứng minh kết nối Neon, đăng nhập Google, quota hay việc phục hồi sau khi Render ngủ trong dịch vụ thật. Chỉ đánh dấu triển khai hoàn tất sau khi kiểm tra những bước trên với tài khoản/cấu hình thật.
