import React, { useEffect, useState } from "react";
import PhoneManager from "./PhoneManager.jsx";

export default function UserProfile({ onEligibility, onSetPassword }) {
  const [account, setAccount] = useState(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setError("");
    fetch("/api/account")
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw Error(data.error || "Chưa tải được hồ sơ.");
        return data;
      })
      .then((data) => {
        if (active) setAccount(data);
      })
      .catch(() => {
        if (active)
          setError("Chưa tải được thông tin tài khoản. Vui lòng thử lại.");
      });
    return () => {
      active = false;
    };
  }, [attempt]);
  const initials = Array.from(account?.name?.trim() || account?.email || "PM")
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <main className="panel user-profile">
      <div className="panelhead">
        <div>
          <h2>Hồ sơ của bạn</h2>
          <p>Thông tin tài khoản và liên hệ.</p>
        </div>
      </div>
      {error ? (
        <div className="warning" role="alert">
          <p>{error}</p>
          <button
            className="secondary"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Thử lại hồ sơ
          </button>
        </div>
      ) : !account ? (
        <p role="status">Đang tải hồ sơ…</p>
      ) : (
        <section className="profile-summary" aria-label="Thông tin tài khoản">
          <div className="profile-avatar" aria-hidden="true">
            {initials}
          </div>
          <div className="profile-identity">
            <h3>{account.name || "Tài khoản của bạn"}</h3>
            <p>{account.email}</p>
            <span className="pill green">
              {account.emailVerified
                ? "Email đã xác nhận"
                : "Email chưa xác nhận"}
            </span>
          </div>
        </section>
      )}
      <PhoneManager onEligibility={onEligibility} />
      {account?.needsPasswordSetup && (
        <aside className="notice">
          <strong>Thiết lập mật khẩu</strong>
          <p>
            Bạn có thể tiếp tục đăng nhập bằng Google. Để dùng thêm email và mật
            khẩu, hãy tạo mật khẩu mới qua email.
          </p>
          <button className="secondary" onClick={onSetPassword}>
            Thiết lập mật khẩu qua email
          </button>
        </aside>
      )}
    </main>
  );
}
