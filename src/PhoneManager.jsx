import React, { useEffect, useRef, useState } from "react";

export default function PhoneManager({ onEligibility }) {
  const [profile, setProfile] = useState(null),
    [phone, setPhone] = useState(""),
    [message, setMessage] = useState("");
  const [rows, setRows] = useState([]),
    [drafts, setDrafts] = useState({}),
    [search, setSearch] = useState(""),
    [filter, setFilter] = useState(""),
    [offset, setOffset] = useState(0),
    [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const alive = useRef(true);
  async function request(path, method = "GET", body) {
    const response = await fetch(path, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json();
    if (!response.ok)
      throw Error(data.error || "Không thực hiện được. Hãy thử lại.");
    return data;
  }
  function apply(data) {
    if (!alive.current) return;
    setProfile(data);
    setPhone(data.phone);
    onEligibility(!data.phoneRequired || data.reviewed);
  }
  useEffect(() => {
    alive.current = true;
    let active = true;
    request("/api/profile")
      .then((data) => {
        if (active) apply(data);
      })
      .catch((error) => {
        if (active) {
          setMessage(error.message);
          onEligibility(false);
        }
      });
    return () => {
      active = false;
      alive.current = false;
    };
  }, []);
  async function action(fn) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setMessage("");
    try {
      await fn();
    } catch (error) {
      setMessage(error.message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function list(value = filter, start = offset) {
    const result = await request(
      "/api/admin/phones?search=" +
        encodeURIComponent(value) +
        "&offset=" +
        start +
        "&limit=20",
    );
    setRows(result.users);
    setDrafts(
      Object.fromEntries(result.users.map((user) => [user.id, user.phone])),
    );
    setMore(result.hasMore);
    setOffset(start);
    setFilter(value);
  }
  async function saveOwn() {
    await action(async () => {
      const saved = await request("/api/profile/phone", "PUT", {
        phone,
        version: profile.version,
      });
      apply(await request("/api/profile"));
      setMessage(
        saved.reviewed
          ? "Số không thay đổi; giữ trạng thái đã kiểm tra."
          : "Đã lưu số. Quản trị viên cần kiểm tra số mới.",
      );
    });
  }
  async function changeUser(user, method, reviewed) {
    if (
      method === "DELETE" &&
      !window.confirm("Xóa số điện thoại của " + user.email + "?")
    )
      return;
    await action(async () => {
      await request(
        "/api/admin/phones/" +
          encodeURIComponent(user.id) +
          (reviewed === undefined ? "" : "/review"),
        method,
        {
          version: user.version,
          ...(reviewed === undefined
            ? { phone: drafts[user.id] }
            : { reviewed }),
        },
      );
      await list();
      apply(await request("/api/profile"));
      setMessage("Đã cập nhật số điện thoại.");
    });
  }
  return (
    <section className="configbox phone-manager">
      <h3>Số điện thoại tài khoản</h3>
      <p className="hint">
        Số được kiểm tra định dạng và lưu theo mã quốc gia. Chưa có SMS OTP;
        kiểm tra thủ công không xác minh SIM chính chủ.
      </p>
      {profile && (
        <>
          <label className="field">
            Số điện thoại của bạn
            <input
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              disabled={busy}
              placeholder="0901234567 hoặc +84901234567"
            />
          </label>
          <div className="inlineActions">
            <button onClick={saveOwn} disabled={busy || !phone.trim()}>
              Lưu số điện thoại
            </button>
            <span className={"pill " + (profile.reviewed ? "green" : "warn")}>
              {profile.reviewed ? "Đã kiểm tra thủ công" : "Chưa kiểm tra"}
            </span>
          </div>
          {profile.phoneRequired && !profile.reviewed && (
            <p className="warning">
              Cần lưu số và được quản trị viên kiểm tra trước khi chạy Get
              Label.
            </p>
          )}
          {profile.isAdmin && (
            <details className="phone-admin">
              <summary>Quản trị · số điện thoại người dùng</summary>
              <form
                className="inlineActions"
                onSubmit={(event) => {
                  event.preventDefault();
                  action(() => list(search, 0));
                }}
              >
                <label className="field">
                  Tìm email hoặc số điện thoại
                  <input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    disabled={busy}
                    maxLength={100}
                  />
                </label>
                <button disabled={busy}>Tìm / tải danh sách</button>
              </form>
              <p className="hint">
                Danh sách gồm tài khoản website và tài khoản Google. Sửa số sẽ bỏ
                trạng thái kiểm tra cũ; không thể đổi quyền quản trị từ đây.
              </p>
              {rows.map((user) => (
                <article className="phone-account" key={user.id}>
                  <b>{user.email}</b>
                  <span
                    className={"pill " + (user.reviewed ? "green" : "warn")}
                  >
                    {user.reviewed ? "Đã kiểm tra thủ công" : "Chưa kiểm tra"}
                  </span>
                  <label className="field">
                    Số điện thoại · {user.email}
                    <input
                      type="tel"
                      inputMode="tel"
                      value={drafts[user.id] || ""}
                      disabled={busy}
                      onChange={(event) =>
                        setDrafts({ ...drafts, [user.id]: event.target.value })
                      }
                    />
                  </label>
                  <div className="inlineActions">
                    <button
                      disabled={busy || !drafts[user.id]?.trim()}
                      onClick={() => changeUser(user, "PUT")}
                    >
                      Lưu số
                    </button>
                    <button
                      className="secondary"
                      disabled={busy || !user.phone}
                      onClick={() => changeUser(user, "POST", !user.reviewed)}
                    >
                      {user.reviewed
                        ? "Bỏ đánh dấu kiểm tra"
                        : "Xác nhận đã kiểm tra thủ công"}
                    </button>
                    <button
                      className="secondary"
                      disabled={busy || !user.phone}
                      onClick={() => changeUser(user, "DELETE")}
                    >
                      Xóa số
                    </button>
                  </div>
                  {user.reviewedAt && (
                    <small>
                      Kiểm tra:{" "}
                      {new Date(user.reviewedAt).toLocaleString("vi-VN")}
                    </small>
                  )}
                </article>
              ))}
              <div className="inlineActions">
                <button
                  className="secondary"
                  disabled={busy || offset === 0}
                  onClick={() =>
                    action(() => list(filter, Math.max(0, offset - 20)))
                  }
                >
                  Trang trước
                </button>
                <button
                  className="secondary"
                  disabled={busy || !more}
                  onClick={() => action(() => list(filter, offset + 20))}
                >
                  Trang sau
                </button>
              </div>
            </details>
          )}
        </>
      )}
      <div className="inlineActions">
        <button
          className="secondary"
          disabled={busy}
          onClick={() =>
            action(async () => apply(await request("/api/profile")))
          }
        >
          Tải lại thông tin số điện thoại
        </button>
      </div>
      {message && (
        <p className="warning" role="status">
          {message}
        </p>
      )}
    </section>
  );
}
