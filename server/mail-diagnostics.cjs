// Only fixed messages/codes may reach the browser or Render logs.
// Provider errors can contain tokens, request headers and personal email data.
const messages = {
  SENDER_NOT_CONNECTED: [
    503,
    "Gmail gửi thư của website chưa được kết nối. Chủ website cần đăng xuất, chọn Tiếp tục với Google và cấp quyền cho Gmail quản trị đã cấu hình.",
  ],
  SENDER_MISMATCH: [
    503,
    "Gmail đã kết nối không trùng tài khoản gửi thư đã cấu hình. Chủ website cần kết nối lại đúng Gmail quản trị.",
  ],
  TOKEN_UNREADABLE: [
    503,
    "Không đọc được kết nối Gmail gửi thư đã lưu. Chủ website cần kiểm tra khóa mã hóa và kết nối lại Gmail quản trị.",
  ],
  RECONNECT: [
    503,
    "Kết nối Gmail gửi thư đã hết hạn hoặc bị thu hồi. Chủ website cần đăng nhập Google và cấp quyền lại.",
  ],
  API_DISABLED: [
    503,
    "Gmail API chưa được bật cho dự án Google của website. Chủ website cần bật Gmail API trong Google Cloud Console.",
  ],
  PERMISSION: [
    503,
    "Gmail gửi thư chưa có đủ quyền. Chủ website cần kết nối lại Google và cấp quyền Gmail.",
  ],
  GOOGLE_CONFIG: [
    503,
    "Cấu hình Google OAuth gửi thư không còn hợp lệ. Chủ website cần kiểm tra OAuth client trên Render và kết nối lại Gmail.",
  ],
  RATE_LIMIT: [
    429,
    "Dịch vụ gửi email đang giới hạn lượt gửi. Vui lòng chờ và thử lại sau.",
  ],
  DAILY_LIMIT: [
    429,
    "Website đã đạt giới hạn 50 lượt gửi email hôm nay (UTC). Vui lòng thử lại ngày mai.",
  ],
  TIMEOUT: [
    503,
    "Kết nối gửi email bị gián đoạn hoặc hết thời gian chờ. Vui lòng thử lại sau; email có thể đến chậm.",
  ],
  DELIVERY_FAILED: [
    503,
    "Chưa gửi được email xác nhận. Vui lòng thử lại sau hoặc liên hệ quản trị viên kiểm tra Gmail gửi thư.",
  ],
};

function mailError(reason) {
  const key = Object.hasOwn(messages, reason) ? reason : "DELIVERY_FAILED";
  const [status, message] = messages[key];
  return Object.assign(new Error(message), {
    status,
    code: "AUTH_MAIL_" + key,
  });
}

function mailDiagnostic(error) {
  const ownReason = String(error?.code || "").replace(/^AUTH_MAIL_/, "");
  if (Object.hasOwn(messages, ownReason)) return mailError(ownReason);
  const body = error?.response?.data?.error;
  const reasons = [
    body?.status,
    ...(Array.isArray(body?.errors)
      ? body.errors.map((item) => item?.reason)
      : []),
    ...(Array.isArray(body?.details)
      ? body.details.map((item) => item?.reason)
      : []),
  ];
  const status = Number(
    error?.response?.status || error?.status || error?.code,
  );
  if (body === "invalid_client" || body === "unauthorized_client")
    return mailError("GOOGLE_CONFIG");
  if (body === "invalid_grant" || status === 401) return mailError("RECONNECT");
  if (
    reasons.some((reason) =>
      ["SERVICE_DISABLED", "accessNotConfigured", "serviceDisabled"].includes(
        reason,
      ),
    )
  )
    return mailError("API_DISABLED");
  if (
    status === 429 ||
    reasons.some((reason) =>
      [
        "rateLimitExceeded",
        "userRateLimitExceeded",
        "dailyLimitExceeded",
        "quotaExceeded",
        "RESOURCE_EXHAUSTED",
      ].includes(reason),
    )
  )
    return mailError("RATE_LIMIT");
  if (status === 403) return mailError("PERMISSION");
  if (
    ["ETIMEDOUT", "ECONNRESET", "EAI_AGAIN", "ENOTFOUND", "ABORT_ERR"].includes(
      error?.code,
    ) ||
    ["TimeoutError", "AbortError"].includes(error?.name)
  )
    return mailError("TIMEOUT");
  return mailError("DELIVERY_FAILED");
}

module.exports = { mailError, mailDiagnostic };
