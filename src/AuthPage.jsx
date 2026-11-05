import React, { useEffect, useRef, useState } from "react";
const titles = {
  login: "Đăng nhập",
  register: "Tạo tài khoản",
  forgot: "Quên mật khẩu?",
  "reset-password": "Đặt lại mật khẩu",
  "verify-email": "Xác nhận email",
  terms: "Điều khoản sử dụng",
  privacy: "Chính sách bảo mật",
};
export default function AuthPage({
  mode,
  token,
  onNavigate,
  onBack,
  onAuth,
  onGoogle,
  verificationPending,
  backLabel = "← Quay lại công cụ",
}) {
  const [email, setEmail] = useState(""),
    [name, setName] = useState(""),
    [phone, setPhone] = useState(""),
    [password, setPassword] = useState(""),
    [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false),
    [showConfirm, setShowConfirm] = useState(false),
    [remember, setRemember] = useState(false),
    [terms, setTerms] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [success, setSuccess] = useState(""),
    [options, setOptions] = useState(null);
  const [registrationNotice, setRegistrationNotice] = useState("");
  const lock = useRef(false),
    generation = useRef(0);
  useEffect(() => {
    let alive = true;
    fetch("/api/auth/options")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (alive) setOptions(data);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    generation.current++;
    setError("");
    setSuccess("");
    setPassword("");
    setConfirm("");
    setShow(false);
    setShowConfirm(false);
  }, [mode]);
  async function submit(event) {
    event.preventDefault();
    if (lock.current) return;
    setError("");
    setSuccess("");
    if (
      (mode === "register" || mode === "reset-password") &&
      password !== confirm
    ) {
      setError("Hai mật khẩu không khớp.");
      return;
    }
    if (mode === "register" && !terms) {
      setError("Bạn cần đồng ý Điều khoản và Chính sách bảo mật.");
      return;
    }
    lock.current = true;
    setBusy(true);
    const current = generation.current;
    try {
      const endpoint = {
        login: "login",
        register: "register",
        forgot: "forgot-password",
        "reset-password": "reset-password",
        "verify-email": "verify-email",
      }[mode];
      const response = await fetch("/api/auth/" + endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          name: name.trim(),
          phone: phone.trim(),
          password,
          confirmPassword: confirm,
          remember,
          acceptTerms: terms,
          token,
        }),
      });
      const data = await response.json();
      if (!response.ok)
        throw Error(data.error || "Không thực hiện được. Vui lòng thử lại.");
      if (current !== generation.current) return;
      setPassword("");
      setConfirm("");
      if (mode === "register") {
        setRegistrationNotice(
          data.emailSent
            ? "Đã tạo tài khoản và gửi email xác nhận. Hãy đăng nhập, rồi mở liên kết trong email để kích hoạt tài khoản."
            : "Đã tạo tài khoản nhưng chưa gửi được email xác nhận. Hãy đăng nhập để gửi lại hoặc liên hệ quản trị viên.",
        );
        onNavigate("login");
      } else if (mode === "login" || mode === "verify-email")
        await onAuth(mode);
      else
        setSuccess(
          mode === "reset-password"
            ? "Đã đổi mật khẩu. Hãy đăng nhập lại bằng mật khẩu mới."
            : data.message,
        );
    } catch (reason) {
      if (current === generation.current)
        setError(reason.message || "Không kết nối được máy chủ.");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const legal = mode === "terms" || mode === "privacy";
  const passwordField = (confirmation = false) => (
    <label className="field">
      {confirmation ? "Xác nhận mật khẩu" : "Mật khẩu"}
      <div className="password-input">
        <input
          aria-label={confirmation ? "Xác nhận mật khẩu" : "Mật khẩu"}
          name={confirmation ? "confirmPassword" : "password"}
          type={(confirmation ? showConfirm : show) ? "text" : "password"}
          value={confirmation ? confirm : password}
          onChange={(event) =>
            confirmation
              ? setConfirm(event.target.value)
              : setPassword(event.target.value)
          }
          required
          minLength={mode === "login" ? undefined : 8}
          maxLength={128}
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          disabled={busy}
        />
        <button
          type="button"
          className="password-toggle"
          aria-label={
            (confirmation ? showConfirm : show)
              ? confirmation
                ? "Ẩn xác nhận mật khẩu"
                : "Ẩn mật khẩu"
              : confirmation
                ? "Hiện xác nhận mật khẩu"
                : "Hiện mật khẩu"
          }
          aria-pressed={confirmation ? showConfirm : show}
          onClick={() =>
            confirmation ? setShowConfirm(!showConfirm) : setShow(!show)
          }
          disabled={busy}
        >
          {(confirmation ? showConfirm : show) ? "Ẩn" : "Hiện"}
        </button>
      </div>
    </label>
  );
  return (
    <div className="auth-shell">
      <header className="top">
        <div className="logo">PM</div>
        <div className="headcopy">
          <h1>Poshmark Label Manager</h1>
          <p>Tài khoản của bạn. Dữ liệu của riêng bạn.</p>
        </div>
      </header>
      <main className="auth-card" aria-labelledby="auth-title">
        <span className="pill">Miễn phí sử dụng</span>
        <h2 id="auth-title">{titles[mode]}</h2>
        {legal ? (
          <>
            <p>
              {mode === "terms"
                ? "Dùng công cụ với dữ liệu và tài khoản bạn được phép truy cập. Kiểm tra mã và bản in trước khi sử dụng; OCR có thể đọc sai. Get Label có thể ghi Google Sheets và đánh dấu email đã xử lý là đã đọc. Không lạm dụng dịch vụ, đăng ký tự động hoặc chia sẻ khóa đăng nhập."
                : "Mật khẩu được băm một chiều, không lưu dạng rõ. Website lưu email, tên hiển thị, số điện thoại và cấu hình tài khoản trong database; token Google được mã hóa. Quản trị viên được phân quyền xem và kiểm tra số điện thoại. PDF Cut Label xử lý trong trình duyệt và không được chủ động tải lên máy chủ. Email xác nhận/khôi phục được gửi qua dịch vụ mà chủ website cấu hình. Không gửi mật khẩu qua email."}
            </p>
            <p>
              Không đăng mật khẩu, token, số điện thoại hoặc vận đơn cá nhân
              trong góp ý công khai. Bạn có thể ngắt kết nối Google và liên hệ
              quản trị viên qua kênh đã cung cấp của website để yêu cầu hỗ trợ
              tài khoản.
            </p>
          </>
        ) : (
          <>
            <p className="auth-intro">
              {mode === "login"
                ? "Dùng mật khẩu của tài khoản website, không phải mật khẩu Gmail. Nếu trước đây dùng Google, chọn Tiếp tục với Google."
                : mode === "register"
                  ? "Tạo tài khoản bằng email. Kết nối Gmail/Sheets sau khi đăng nhập và xác nhận email."
                  : mode === "forgot"
                    ? "Nhập email đã đăng ký. Chúng tôi sẽ gửi liên kết đặt lại mật khẩu nếu tài khoản tồn tại."
                    : mode === "reset-password"
                      ? "Chọn mật khẩu mới từ 8 đến 128 ký tự. Liên kết chỉ được dùng một lần."
                      : "Đăng nhập đúng tài khoản vừa đăng ký, rồi xác nhận email bằng liên kết đã nhận."}
            </p>
            {mode === "login" && registrationNotice && (
              <p className="auth-success" role="status">
                {registrationNotice}
              </p>
            )}
            {mode === "login" && verificationPending && (
              <p className="notice">
                Đăng nhập bằng email nhận liên kết để hoàn tất xác nhận tài
                khoản.
              </p>
            )}
            {options?.emailConfigured === false &&
              (mode === "register" || mode === "forgot") && (
                <aside className="warning">
                  Quản trị viên chưa cấu hình gửi email. Khôi phục và xác nhận
                  email chưa hoạt động; cần cấu hình trước khi dùng các chức
                  năng yêu cầu xác nhận.
                </aside>
              )}
            <form onSubmit={submit}>
              {mode === "register" && (
                <label className="field">
                  Họ và tên
                  <input
                    name="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    autoComplete="name"
                    required
                    maxLength={100}
                    disabled={busy}
                  />
                </label>
              )}
              {["login", "register", "forgot"].includes(mode) && (
                <label className="field">
                  Email
                  <input
                    name="email"
                    type="email"
                    inputMode="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete={mode === "login" ? "username" : "email"}
                    required
                    maxLength={254}
                    disabled={busy}
                  />
                </label>
              )}
              {mode === "register" && (
                <label className="field">
                  Số điện thoại
                  <input
                    aria-label="Số điện thoại"
                    name="phone"
                    type="tel"
                    inputMode="tel"
                    autoComplete="tel"
                    required
                    maxLength={40}
                    value={phone}
                    onChange={(event) => setPhone(event.target.value)}
                    disabled={busy}
                    placeholder="0901234567 hoặc +84901234567"
                    aria-describedby="registration-phone-help"
                  />
                  <small id="registration-phone-help" className="hint">
                    Nhập số đang sử dụng. Quản trị viên có thể liên hệ và kiểm
                    tra sau.
                  </small>
                </label>
              )}
              {["login", "register", "reset-password"].includes(mode) &&
                passwordField()}
              {["register", "reset-password"].includes(mode) && (
                <>
                  <small className="hint">
                    Mật khẩu từ 8 đến 128 ký tự; nên dùng mật khẩu riêng cho
                    website.
                  </small>
                  {passwordField(true)}
                </>
              )}
              {mode === "login" && (
                <div className="auth-options">
                  <label>
                    <input
                      type="checkbox"
                      checked={remember}
                      onChange={(e) => setRemember(e.target.checked)}
                      disabled={busy}
                    />{" "}
                    Ghi nhớ đăng nhập
                  </label>
                  <button
                    className="text-button"
                    type="button"
                    onClick={() => onNavigate("forgot")}
                    disabled={busy}
                  >
                    Quên mật khẩu?
                  </button>
                </div>
              )}
              {mode === "register" && (
                <label className="terms-checkbox">
                  <input
                    type="checkbox"
                    checked={terms}
                    onChange={(e) => setTerms(e.target.checked)}
                    required
                    disabled={busy}
                  />
                  <span>
                    Tôi đồng ý với{" "}
                    <a
                      href="/#/terms"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Điều khoản sử dụng
                    </a>{" "}
                    và{" "}
                    <a
                      href="/#/privacy"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Chính sách bảo mật
                    </a>
                    .
                  </span>
                </label>
              )}
              {error && (
                <p className="warning" role="alert">
                  {error}
                </p>
              )}
              {success && (
                <p className="auth-success" role="status">
                  {success}
                </p>
              )}
              <button
                className="auth-submit"
                type="submit"
                disabled={
                  busy ||
                  (mode === "forgot" && options?.emailConfigured === false)
                }
              >
                {busy
                  ? "Đang xử lý…"
                  : {
                      login: "Đăng nhập",
                      register: "Tạo tài khoản",
                      forgot: "Gửi liên kết khôi phục",
                      "reset-password": "Lưu mật khẩu mới",
                      "verify-email": "Xác nhận email",
                    }[mode]}
              </button>
            </form>
            {(mode === "login" || mode === "register") && (
              <>
                <div className="auth-divider">hoặc</div>
                <button
                  className="secondary auth-submit"
                  onClick={onGoogle}
                  disabled={busy}
                >
                  Tiếp tục với Google
                </button>
              </>
            )}
            <p className="auth-switch">
              {mode === "login" ? (
                <>
                  Chưa có tài khoản?{" "}
                  <button
                    className="text-button"
                    onClick={() => onNavigate("register")}
                    disabled={busy}
                  >
                    Đăng ký ngay
                  </button>
                </>
              ) : (
                <>
                  Đã có tài khoản?{" "}
                  <button
                    className="text-button"
                    onClick={() => onNavigate("login")}
                    disabled={busy}
                  >
                    Đăng nhập
                  </button>
                </>
              )}
            </p>
          </>
        )}
        {onBack && (
          <button
            className="text-button auth-back"
            onClick={onBack}
            disabled={busy}
          >
            {backLabel}
          </button>
        )}
      </main>
      <footer>Poshmark Label Manager · Công cụ quản lý label miễn phí</footer>
    </div>
  );
}

export function ActivationPage({ onLogout, onRefresh, logoutError }) {
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [account, setAccount] = useState(null),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    fetch("/api/account")
      .then((r) => {
        if (!r.ok)
          throw Error(
            "Chưa tải được thông tin tài khoản. Hãy thử kiểm tra lại.",
          );
        return r.json();
      })
      .then((data) => {
        if (active) setAccount(data);
      })
      .catch((error) => {
        if (active) setMessage(error.message);
      });
    return () => {
      active = false;
    };
  }, [loadAttempt]);
  async function resend() {
    if (busy) return;
    setBusy(true);
    try {
      const r = await fetch("/api/auth/resend-verification", {
          method: "POST",
        }),
        data = await r.json();
      if (!r.ok) throw Error(data.error);
      setMessage("Đã gửi yêu cầu xác nhận. Kiểm tra email và thư rác.");
    } catch (error) {
      setMessage(
        error.message || "Không kết nối được máy chủ. Vui lòng thử lại.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-shell">
      <header className="top">
        <div className="logo">PM</div>
        <div className="headcopy">
          <h1>Poshmark Label Manager</h1>
          <p>Kích hoạt tài khoản để bắt đầu.</p>
        </div>
      </header>
      <main className="auth-card" aria-labelledby="activation-title">
        <span className="pill">Bước cuối cùng</span>
        <h2 id="activation-title">Xác nhận email của bạn</h2>
        {logoutError && (
          <p className="warning" role="alert">
            {logoutError}
          </p>
        )}
        {account?.email && (
          <p>
            <strong>{account.email}</strong>
          </p>
        )}
        <p>
          {!account
            ? message
              ? "Bấm Kiểm tra lại để tải lại thông tin tài khoản."
              : "Đang tải thông tin tài khoản…"
            : account.emailConfigured
              ? "Mở email xác nhận và bấm vào liên kết để kích hoạt tài khoản. Hãy kiểm tra cả mục Thư rác."
              : "Chưa thể gửi email xác nhận. Vui lòng liên hệ quản trị viên để hoàn tất cấu hình gửi email."}
        </p>
        <button
          className="secondary"
          onClick={resend}
          disabled={busy || !account?.emailConfigured}
        >
          {busy ? "Đang gửi…" : "Gửi lại email xác nhận"}
        </button>
        {message && (
          <p className="notice" role="status">
            {message}
          </p>
        )}
        <div className="inlineActions">
          <button
            className="secondary"
            onClick={() => {
              setLoadAttempt((value) => value + 1);
              onRefresh();
            }}
          >
            Tôi đã xác nhận · Kiểm tra lại
          </button>
          <button className="text-button" onClick={onLogout}>
            Đăng xuất
          </button>
        </div>
      </main>
    </div>
  );
}
