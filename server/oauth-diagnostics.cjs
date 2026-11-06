// Provider errors may include OAuth codes/secrets and database connection URLs.
// Select fixed messages only, for both the browser and server logs.
const messages = {
  ACCOUNT_DISABLED: [
    403,
    "Tài khoản này đã bị khóa hoặc xóa. Vui lòng liên hệ quản trị viên.",
  ],
  CLIENT_CONFIG: [
    503,
    "GOOGLE_CLIENT_ID và GOOGLE_CLIENT_SECRET trên Render không khớp hoặc không còn hợp lệ. Chủ website cần lấy cả hai từ cùng một OAuth Web client, lưu trên Render rồi deploy lại.",
  ],
  REDIRECT_URI: [
    503,
    "Địa chỉ chuyển hướng Google chưa khớp. Chủ website cần kiểm tra Authorized redirect URIs của đúng OAuth client và PUBLIC_BASE_URL trên Render.",
  ],
  GRANT_EXPIRED: [
    400,
    "Phiên cấp quyền Google đã hết hạn hoặc đã được sử dụng. Hãy quay lại trang đăng nhập và bắt đầu lại; không tải lại trang callback này.",
  ],
  GOOGLE_UNAVAILABLE: [
    503,
    "Chưa kết nối được với Google. Vui lòng chờ một lát rồi bắt đầu đăng nhập lại.",
  ],
  TOKEN_EXCHANGE: [
    502,
    "Google chưa hoàn tất cấp quyền truy cập. Chủ website cần kiểm tra cấu hình OAuth Web client trên Render, rồi bạn bắt đầu đăng nhập lại.",
  ],
  IDENTITY_VERIFY: [
    502,
    "Chưa xác minh được danh tính Google. Hãy bắt đầu đăng nhập lại; nếu vẫn lỗi, chủ website cần kiểm tra OAuth client và kết nối Google.",
  ],
  ACCOUNT_SAVE: [
    503,
    "Chưa lưu được kết nối Google vào cơ sở dữ liệu. Chủ website cần kiểm tra Neon và quyền truy cập database trong Render Logs.",
  ],
  SESSION_SAVE: [
    503,
    "Chưa lưu được phiên đăng nhập. Vui lòng thử lại sau; nếu vẫn lỗi, chủ website cần kiểm tra kết nối Neon và bảng phiên đăng nhập.",
  ],
  UNKNOWN: [
    500,
    "Chưa hoàn tất đăng nhập Google. Hãy quay lại trang đăng nhập và thử lại; nếu vẫn lỗi, gửi mã lỗi bên dưới cho quản trị viên.",
  ],
};

function oauthDiagnostic(error, stage) {
  const providerCode = error?.response?.data?.error;
  let reason = Object.hasOwn(messages, stage) ? stage : "UNKNOWN";
  if (error?.code === "ACCOUNT_DISABLED") reason = "ACCOUNT_DISABLED";
  if (
    [
      "invalid_client",
      "unauthorized_client",
      "deleted_client",
      "disabled_client",
    ].includes(providerCode)
  )
    reason = "CLIENT_CONFIG";
  else if (providerCode === "redirect_uri_mismatch") reason = "REDIRECT_URI";
  else if (providerCode === "invalid_grant") reason = "GRANT_EXPIRED";
  else if (
    ["TOKEN_EXCHANGE", "IDENTITY_VERIFY"].includes(stage) &&
    ([
      "ENOTFOUND",
      "EAI_AGAIN",
      "ETIMEDOUT",
      "ECONNRESET",
      "ECONNREFUSED",
    ].includes(error?.code) ||
      Number(error?.response?.status) >= 500)
  )
    reason = "GOOGLE_UNAVAILABLE";
  const [status, message] = messages[reason];
  // Include only whitelisted SQL error codes, never the query/detail/host.
  const databaseCode =
    ["ACCOUNT_SAVE", "SESSION_SAVE"].includes(reason) &&
    [
      "28P01",
      "28000",
      "3D000",
      "42501",
      "42P01",
      "42703",
      "23505",
      "53300",
      "57P03",
    ].includes(error?.code)
      ? error.code
      : null;
  return { status, code: "OAUTH_" + reason, message, databaseCode };
}

function oauthFailurePage(diagnostic) {
  // All interpolated values come from oauthDiagnostic's fixed allowlists.
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Đăng nhập Google · Poshmark Label Manager</title><style>body{margin:0;background:#eef2ff;color:#253354;font:16px/1.7 system-ui,sans-serif;padding:24px}main{max-width:540px;margin:8vh auto;padding:30px;background:white;border:1px solid #dce3f0;border-radius:20px;box-shadow:0 15px 50px #34487515}h1{font-size:23px;line-height:1.4}code{overflow-wrap:anywhere}a{display:inline-block;padding:11px 18px;border-radius:10px;background:#6241c5;color:white;text-decoration:none}small{color:#526078}</style></head><body><main><small>Poshmark Label Manager</small><h1>Chưa hoàn tất đăng nhập Google</h1><p>${diagnostic.message}</p><p>Mã lỗi: <code>${diagnostic.code}${diagnostic.databaseCode ? ":" + diagnostic.databaseCode : ""}</code></p><a href="/">Quay lại đăng nhập</a></main></body></html>`;
}

module.exports = { oauthDiagnostic, oauthFailurePage };
