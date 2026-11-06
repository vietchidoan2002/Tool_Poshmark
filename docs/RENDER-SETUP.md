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

Mở **URL Web Service mới**, không dùng URL Static Site cũ. Trang đầu là **Đăng nhập**. Có form đăng ký email/mật khẩu/SĐT và tùy chọn **Tiếp tục với Google** cho tài khoản cũ. Tài khoản mới phải xác nhận email mới vào công cụ. Mỗi người đăng nhập tài khoản riêng và tự lưu Sheet ID. Không upload credentials.json hay token_*.json lên web.

## 5. Kiểm tra trước khi mời nhiều người

- Kiểm tra /healthz trả ok và deploy báo Live.
- Đăng nhập hai tài khoản Test users bằng hai trình duyệt; kiểm tra Sheet ID, Gmail và trạng thái đăng xuất không xuất hiện chéo.
- Chạy Get Label chỉ trên dữ liệu được cho phép: ghi Sheets và đánh dấu email đã xử lý là đã đọc.
- Kiểm tra sau khi Web Service/Neon ngủ rồi thức lại; kiểm tra dữ liệu còn sau redeploy.
- Cut Label chạy trong trình duyệt sau khi đăng nhập và xác nhận email; không tải vận đơn lên máy chủ. Static Site xem thử vẫn dùng Cut Label không cần tài khoản.

## Giới hạn miễn phí

Không cấu hình tài nguyên trả phí hoặc tự nâng gói. Render Free/Neon Free có giới hạn và có thể ngủ, tạm dừng hoặc ngừng nhận thêm yêu cầu khi hết quota; lần truy cập đầu sau khi ngủ có thể chậm. Đọc chính sách hiện tại trong dashboard trước khi sử dụng, vì giới hạn/gói có thể thay đổi. Hết quota thì chờ hoặc giảm sử dụng, không tự chuyển sang trả phí.

Gmail modify là quyền hạn chế của Google. Trong Testing, chỉ dùng các email Test users; token có thể cần kết nối lại định kỳ. Phát hành công khai có thể yêu cầu Google xét duyệt và đánh giá bổ sung, nên không thể cam kết một dịch vụ công khai không giới hạn sẽ luôn miễn phí. Không cần mua tên miền để thử bằng URL Render.

## Cập nhật về sau

Bật Auto-Deploy của Web Service trên nhánh đã chọn nếu muốn nhận bản sửa sau khi push lên nhánh đó. Không tự gộp master. Người dùng đang mở web được báo phiên bản mới rồi tự tải lại sau khi xuất các label, không phải tải/cài lại phần mềm. Không xóa Neon hoặc thay khóa mã hóa khi cập nhật.

Kiểm thử tự động dùng Google giả lập và PostgreSQL trong bộ nhớ. Chúng không chứng minh kết nối Neon, đăng nhập Google, quota hay việc phục hồi sau khi Render ngủ trong dịch vụ thật. Chỉ đánh dấu triển khai hoàn tất sau khi kiểm tra những bước trên với tài khoản/cấu hình thật.

## Quản lý số điện thoại

Trong Environment của **Web Service** (không phải Static Site):

- `ADMIN_EMAILS`: email tài khoản đã xác minh của bạn; nếu có nhiều quản trị viên, phân cách bằng dấu phẩy. Không có danh sách này thì không ai được dùng API quản trị. Không cấp quyền bằng dữ liệu người dùng gửi lên.
- `REQUIRE_REVIEWED_PHONE=false` (mặc định mới): kích hoạt bằng email, thu số ngay khi đăng ký và kiểm tra thủ công sau. Với dịch vụ cũ đã đặt true, cần đổi thủ công trong Render Environment rồi deploy lại.
- Tùy chọn `REQUIRE_REVIEWED_PHONE=true`: chặn Get Label đến khi người dùng có số được quản trị viên kiểm tra. Nếu bật mà thiếu ADMIN_EMAILS, máy chủ từ chối khởi động để tránh khóa toàn bộ người dùng mà không có người duyệt.

Sau khi deploy:

1. Đăng nhập bằng đúng email quản trị đã khai báo.
2. Mở tab **Hồ sơ** → **Số điện thoại tài khoản**. Số đã nhập khi đăng ký sẽ có sẵn; tài khoản Google cũ có thể bổ sung số tại đây.
3. Mở **Quản trị · số điện thoại người dùng** → **Tìm / tải danh sách**. Bạn có thể tìm email/số, thêm số vào tài khoản website hoặc Google, sửa, xóa, đánh dấu đã kiểm tra hoặc bỏ đánh dấu. Có phân trang để không tải toàn bộ danh sách.
4. Khi bạn đã đối chiếu thủ công, chọn **Xác nhận đã kiểm tra thủ công**. Đổi số sẽ tự bỏ đánh dấu cũ. Xóa số cần xác nhận; nó không xóa tài khoản Google hay dữ liệu Sheets.
5. Người dùng có thể nhập/chỉnh số của chính họ; không xem danh sách của người khác và không tự đánh dấu đã kiểm tra. Tải lại thông tin để nhận trạng thái mới.

Số Việt Nam được chuẩn hóa theo mã +84, số quốc tế cần mã +quốc gia. Dữ liệu lưu vào bảng `pm_phone_profiles`, không phải MySQL. Có khóa duy nhất chống một số trùng nhiều tài khoản và kiểm tra phiên bản để tránh ghi đè sửa đổi mới. Lịch sử thao tác `pm_phone_audit` chỉ ghi người thao tác, tài khoản đích, hành động, thời gian và 4 số cuối, không lưu token Google hay toàn bộ số vào lịch sử.

Nên sửa qua giao diện để áp dụng chuẩn hóa, kiểm tra trùng và nhật ký; sửa trực tiếp bằng SQL có thể bỏ qua các bước này. Chủ database vẫn có quyền truy cập toàn bộ dữ liệu, vì vậy không chia sẻ DATABASE_URL với người dùng thường.

**Không có SMS OTP hay xác minh SIM chính chủ trong chức năng này.** Một số hợp định dạng vẫn có thể thuộc người khác hoặc không còn hoạt động. Nhãn hiển thị là “Đã kiểm tra thủ công”, không phải đã nhận SMS. Muốn chứng minh nhận được số cần tích hợp OTP riêng và kiểm tra chi phí nhà cung cấp. Web Service yêu cầu đăng nhập và xác nhận email cho cả hai công cụ. Cổng kiểm tra số thủ công, nếu chủ website bật, chỉ áp dụng cho Get Label.

## Trang đăng nhập/đăng ký riêng

Bản web có các form email/mật khẩu và vẫn có tùy chọn Google cho tài khoản cũ. Xem EMAIL-PASSWORD-AUTH.md. Để gửi xác nhận và khôi phục qua Gmail quản trị, đăng nhập Google bằng tài khoản trong ADMIN_EMAILS trước, rồi thêm AUTH_MAIL_PROVIDER=gmail và AUTH_MAIL_SENDER_EMAIL bằng email quản trị đã kết nối, deploy lại. Không cần đổi SESSION_SECRET hoặc TOKEN_ENCRYPTION_KEY. Chưa cấu hình gửi email thì các chức năng cần xác nhận email chưa sử dụng được; bản Static Site không có chức năng tài khoản này.
