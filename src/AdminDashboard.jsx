import React, { useEffect, useRef, useState } from "react";
const number = (value) => new Intl.NumberFormat("vi-VN").format(value || 0);
const date = (value) =>
  value
    ? new Date(value).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })
    : "Chưa ghi nhận";
const statusName = {
  active: "Hoạt động",
  suspended: "Đã khóa",
  deleted: "Đã xóa",
  running: "Chưa hoàn tất",
  success: "Thành công",
  partial: "Lỗi một phần",
  failed: "Thất bại",
};
async function request(path, method = "GET", body) {
  const response = await fetch("/api/admin" + path, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok)
    throw Error(data.error || "Không tải được dữ liệu quản trị.");
  return data;
}
function Metric({ label, value, note, tone = "" }) {
  return (
    <article className={"metric " + tone}>
      <p>{label}</p>
      <strong>{number(value)}</strong>
      {note && <small>{note}</small>}
    </article>
  );
}
function dayLabel(day) {
  return day.split("-").reverse().join("/");
}
function Trend({ rows, peakOrders }) {
  const [selectedDay, setSelectedDay] = useState(null);
  const selected = rows.find((row) => row.day === selectedDay) || rows.at(-1);
  return (
    <section className="admin-card">
      <div className="admin-card-title">
        <h3>Số lượng đơn trong 1 ngày</h3>
        <span className="pill">Giờ Việt Nam</span>
      </div>
      {!selected ? (
        <p className="admin-empty">Chưa ghi nhận hoạt động trong khoảng này.</p>
      ) : (
        <>
          <div className="trend-bars" aria-label="Biểu đồ số đơn theo ngày">
            {rows.map((row) => (
              <button
                key={row.day}
                className={
                  peakOrders > 0 && row.orders === peakOrders
                    ? "trend-column trend-peak"
                    : "trend-column"
                }
                aria-label={`${dayLabel(row.day)} · ${number(row.orders)} đơn`}
                aria-pressed={row.day === selected.day}
                title={`${dayLabel(row.day)} · ${number(row.orders)} đơn`}
                onClick={() => setSelectedDay(row.day)}
              >
                <span
                  className="trend-bar"
                  style={{
                    height: Math.max(4, (100 * row.orders) / Math.max(1, peakOrders)) + "%",
                  }}
                />
                <small>{dayLabel(row.day).slice(0, 5)}</small>
              </button>
            ))}
          </div>
          <p className="trend-selection" role="status">
            <strong>{number(selected.orders)} đơn</strong>
            <span>Ngày {dayLabel(selected.day)}</span>
          </p>
        </>
      )}
    </section>
  );
}
function Insights({ rows, peakOrders }) {
  const peakDays =
    peakOrders > 0
      ? rows.filter((row) => row.orders === peakOrders).map((row) => dayLabel(row.day))
      : [];
  const shownDays = peakDays.slice(0, 3).join(", ");
  const remainingDays = peakDays.length - 3;
  return (
    <section className="admin-card growth-card">
      <h3>Gợi ý phát triển</h3>
      {peakDays.length ? (
        <div className="growth-peak">
          <p>{peakDays.length === 1 ? "Ngày có nhiều đơn nhất" : "Các ngày cùng dẫn đầu"}</p>
          <strong>{number(peakOrders)} đơn{peakDays.length > 1 ? "/ngày" : ""}</strong>
          <span>
            {shownDays}
            {remainingDays > 0 ? ` và ${number(remainingDays)} ngày khác` : ""}
          </span>
        </div>
      ) : (
        <p className="hint">Chưa ghi nhận đơn để xác định ngày dẫn đầu.</p>
      )}
    </section>
  );
}
function Editor({ user, onClose, onSaved }) {
  const [name, setName] = useState(user?.name || ""),
    [email, setEmail] = useState(user?.email || ""),
    [phone, setPhone] = useState(user?.phone || ""),
    [status, setStatus] = useState(
      user?.status === "suspended" ? "suspended" : "active",
    ),
    [sendInvite, setSendInvite] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const modal = useRef(null),
    submitLock = useRef(false);
  useEffect(() => {
    const dialog = modal.current;
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);
  async function submit(event) {
    event.preventDefault();
    if (submitLock.current) return;
    submitLock.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await request(
        user ? "/users/" + encodeURIComponent(user.id) : "/users",
        user ? "PUT" : "POST",
        {
          name,
          email,
          phone,
          status,
          version: user?.version,
          phoneVersion: user?.phoneVersion,
          sendInvite,
        },
      );
      onSaved(
        user
          ? "Đã cập nhật tài khoản."
          : result.mailError
            ? "Đã tạo tài khoản. " + result.mailError
            : result.mailSent
              ? "Đã tạo tài khoản và gửi email thiết lập mật khẩu."
              : "Đã tạo tài khoản. Người dùng có thể đăng nhập Google hoặc yêu cầu email thiết lập.",
        !!result.mailError,
      );
    } catch (reason) {
      setError(reason.message);
    } finally {
      submitLock.current = false;
      setBusy(false);
    }
  }
  return (
    <dialog
      className="admin-dialog"
      ref={modal}
      aria-labelledby="editor-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <form onSubmit={submit}>
        <div className="admin-card-title">
          <h3 id="editor-title">{user ? "Sửa tài khoản" : "Thêm tài khoản"}</h3>
          <button
            className="text-button"
            type="button"
            onClick={onClose}
            disabled={busy}
          >
            Đóng
          </button>
        </div>
        <label className="field">
          Họ và tên
          <input
            name="name"
            required
            maxLength={100}
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
          />
        </label>
        <label className="field">
          Email đăng nhập
          <input
            name="email"
            type="email"
            required
            maxLength={254}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            readOnly={!!user}
            disabled={busy}
          />
        </label>
        {user && (
          <small className="hint">Email đăng nhập được giữ cố định.</small>
        )}
        <label className="field">
          Số điện thoại
          <input
            name="phone"
            type="tel"
            required={!user}
            maxLength={40}
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            disabled={busy}
          />
        </label>
        {user ? (
          <label className="field">
            Trạng thái
            <select
              aria-label="Trạng thái"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              disabled={busy || user.isAdmin}
            >
              <option value="active">Hoạt động</option>
              <option value="suspended">Đã khóa</option>
            </select>
          </label>
        ) : (
          <label className="terms-checkbox">
            <input
              type="checkbox"
              checked={sendInvite}
              onChange={(e) => setSendInvite(e.target.checked)}
              disabled={busy}
            />
            Gửi email để người dùng tự thiết lập mật khẩu
          </label>
        )}
        {error && (
          <p className="warning" role="alert">
            {error}
          </p>
        )}
        <div className="inlineActions">
          <button disabled={busy}>
            {busy ? "Đang lưu…" : user ? "Lưu thay đổi" : "Tạo tài khoản"}
          </button>
          <button
            className="secondary"
            type="button"
            onClick={onClose}
            disabled={busy}
          >
            Hủy
          </button>
        </div>
      </form>
    </dialog>
  );
}
function Details({ id, onClose }) {
  const [data, setData] = useState(null),
    [error, setError] = useState("");
  const modal = useRef(null);
  useEffect(() => {
    modal.current.showModal();
    let active = true;
    request("/users/" + encodeURIComponent(id))
      .then((value) => {
        if (active) setData(value);
      })
      .catch((reason) => {
        if (active) setError(reason.message);
      });
    return () => {
      active = false;
    };
  }, [id]);
  return (
    <dialog
      ref={modal}
      className="admin-dialog admin-detail"
      aria-labelledby="detail-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="admin-card-title">
        <h3 id="detail-title">Chi tiết tài khoản</h3>
        <button className="secondary" onClick={onClose}>
          Đóng
        </button>
      </div>
      {error ? (
        <p role="alert" className="warning">
          {error}
        </p>
      ) : !data ? (
        <p>Đang tải…</p>
      ) : (
        <>
          <h4>{data.user.name || data.user.email}</h4>
          <p>{data.user.email}</p>
          <div className="admin-detail-metrics">
            <span>{number(data.user.orders)} đơn ghi được</span>
            <span>{number(data.user.poshmarkCount)} account Poshmark</span>
          </div>
          <h4>Account Poshmark đã sử dụng</h4>
          {data.accounts.length ? (
            <div className="admin-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Đơn ghi được</th>
                  </tr>
                </thead>
                <tbody>
                  {data.accounts.map((account) => (
                    <tr key={account.name}>
                      <td>{account.name}</td>
                      <td>{number(account.orders)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="admin-empty">Chưa chạy Get Label.</p>
          )}
          <h4>50 lượt Get Label gần nhất</h4>
          {data.runs.length ? (
            <div className="admin-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Thời gian</th>
                    <th>Account</th>
                    <th>Kết quả</th>
                    <th>Đơn</th>
                  </tr>
                </thead>
                <tbody>
                  {data.runs.map((run) => (
                    <tr key={run.id}>
                      <td>{date(run.startedAt)}</td>
                      <td>{run.accountName}</td>
                      <td>
                        <span
                          className={
                            "pill " +
                            (run.status === "success" ? "green" : "warn")
                          }
                        >
                          {statusName[run.status] || run.status}
                        </span>
                      </td>
                      <td>{number(run.orders)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      )}
    </dialog>
  );
}
export default function AdminDashboard() {
  const [days, setDays] = useState(30),
    [dashboard, setDashboard] = useState(null),
    [users, setUsers] = useState([]),
    [search, setSearch] = useState(""),
    [filter, setFilter] = useState(""),
    [status, setStatus] = useState("all"),
    [offset, setOffset] = useState(0),
    [more, setMore] = useState(false),
    [revision, setRevision] = useState(0),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [messageWarning, setMessageWarning] = useState(false),
    [editor, setEditor] = useState(null),
    [detail, setDetail] = useState(null);
  const lock = useRef(false);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    Promise.all([
      request("/dashboard?days=" + days),
      request(
        "/users?search=" +
          encodeURIComponent(filter) +
          "&status=" +
          status +
          "&offset=" +
          offset,
      ),
    ])
      .then(([data, list]) => {
        if (active) {
          setDashboard(data);
          setUsers(list.users);
          setMore(list.hasMore);
        }
      })
      .catch((reason) => {
        if (active) setError(reason.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [days, filter, status, offset, revision]);
  async function action(user, kind) {
    if (lock.current) return;
    if (
      kind === "delete" &&
      !window.confirm(
        `Xóa tài khoản ${user.email}? Người dùng sẽ bị đăng xuất, ngắt Gmail và vô hiệu hóa mật khẩu. SĐT được giải phóng; lịch sử thống kê vẫn được giữ. Có thể khôi phục tài khoản sau.`,
      )
    )
      return;
    if (
      kind === "invite" &&
      !window.confirm("Gửi email thiết lập mật khẩu đến " + user.email + "?")
    )
      return;
    lock.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    setMessageWarning(false);
    try {
      await request(
        "/users/" +
          encodeURIComponent(user.id) +
          (kind === "delete" ? "" : "/" + kind),
        kind === "delete" ? "DELETE" : "POST",
        { version: user.version },
      );
      setMessage(
        kind === "delete"
          ? "Đã xóa tài khoản; lịch sử thống kê được giữ."
          : kind === "restore"
            ? "Đã khôi phục. Người dùng cần kết nối lại Google hoặc thiết lập mật khẩu."
            : "Đã gửi email thiết lập mật khẩu.",
      );
      setRevision((value) => value + 1);
    } catch (reason) {
      setError(reason.message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const peakOrders = Math.max(0, ...(dashboard?.trend || []).map((row) => row.orders));
  return (
    <main className="admin-dashboard">
      <section className="admin-hero">
        <div>
          <span className="pill">Quản trị viên</span>
          <h2>Dashboard quản trị</h2>
          <p>Tài khoản, đơn hàng và hoạt động Get Label.</p>
        </div>
        <div className="inlineActions">
          <button
            onClick={() => {
              setMessage("");
              setEditor({});
            }}
            disabled={busy || loading}
          >
            + Thêm tài khoản
          </button>
          <button
            className="secondary"
            onClick={() => setRevision((value) => value + 1)}
            disabled={busy || loading}
          >
            Cập nhật số liệu
          </button>
        </div>
      </section>
      {error && (
        <p className="warning" role="alert">
          {error}
          <button
            className="text-button"
            onClick={() => setRevision((value) => value + 1)}
          >
            Thử lại
          </button>
        </p>
      )}
      {message && (
        <p
          className={messageWarning ? "warning" : "auth-success"}
          role="status"
        >
          {message}
        </p>
      )}
      {loading && (
        <p className="admin-loading" role="status">
          Đang tải dữ liệu quản trị…
        </p>
      )}
      {dashboard && (
        <>
          <aside className="admin-data-note">
            Hoạt động được ghi nhận từ {date(dashboard.trackingSince)}. Đơn cũ
            trong Google Sheets chưa được cộng vào thống kê.
          </aside>
          <section className="metrics-grid">
            <Metric
              label="Tài khoản đang quản lý"
              value={dashboard.users.available}
              note={`${number(dashboard.users.deleted)} đã xóa · ${number(dashboard.users.suspended)} đang khóa`}
            />
            <Metric
              label="Hoạt động trong 30 ngày"
              value={dashboard.users.active30}
              tone="metric-blue"
            />
            <Metric
              label="Gmail đang kết nối"
              value={dashboard.users.gmailConnected}
              tone="metric-green"
            />
            <Metric
              label="Tài khoản mới / 7 ngày"
              value={dashboard.users.new7}
              note={
                dashboard.users.unknownCreated
                  ? `${number(dashboard.users.unknownCreated)} tài khoản cũ chưa có ngày tạo`
                  : null
              }
            />
          </section>
          <section className="admin-period">
            <h3>Hiệu quả Get Label</h3>
            <label>
              Khoảng thời gian
              <select
                value={days}
                onChange={(event) => setDays(Number(event.target.value))}
                disabled={busy}
              >
                <option value={7}>7 ngày</option>
                <option value={30}>30 ngày</option>
                <option value={90}>90 ngày</option>
              </select>
            </label>
          </section>
          <section className="metrics-grid">
            <Metric
              label="Đơn ghi được"
              value={dashboard.usage.orders}
              tone="metric-purple"
            />
            <Metric
              label="Lượt chạy Get Label"
              value={dashboard.usage.getRuns}
              note={`${number(dashboard.usage.getUsers)} người sử dụng`}
            />
            <Metric
              label="Đơn bỏ qua / đã có"
              value={dashboard.usage.skipped}
            />
            <Metric
              label="Lượt chưa hoàn tất"
              value={dashboard.usage.failed}
              note={`${number(dashboard.usage.running)} lượt chưa chốt kết quả`}
              tone="metric-amber"
            />
          </section>
          <div className="admin-insights">
            <Trend rows={dashboard.trend} peakOrders={peakOrders} />
            <Insights rows={dashboard.trend} peakOrders={peakOrders} />
          </div>
        </>
      )}
      <section className="admin-card admin-users">
        <div className="admin-card-title">
          <h3>Quản lý tài khoản</h3>
          <span className="hint">Mỗi email một tài khoản</span>
        </div>
        <form
          className="admin-filters"
          onSubmit={(event) => {
            event.preventDefault();
            setOffset(0);
            setFilter(search.trim());
          }}
        >
          <label className="field">
            Tìm tài khoản
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Tên, email hoặc số điện thoại"
              maxLength={100}
            />
          </label>
          <label className="field">
            Trạng thái
            <select
              aria-label="Trạng thái"
              value={status}
              onChange={(event) => {
                setOffset(0);
                setStatus(event.target.value);
              }}
            >
              <option value="all">Tất cả đang quản lý</option>
              <option value="active">Hoạt động</option>
              <option value="pending">Chưa xác nhận email</option>
              <option value="suspended">Đã khóa</option>
              <option value="deleted">Đã xóa</option>
            </select>
          </label>
          <button disabled={loading}>Tìm kiếm</button>
        </form>
        <div className="admin-table-wrap">
          <table className="admin-users-table">
            <thead>
              <tr>
                <th>Tài khoản</th>
                <th>Trạng thái</th>
                <th>ACC Poshmark</th>
                <th>Đơn Get</th>
                <th>Hoạt động gần nhất</th>
                <th>Thao tác</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id}>
                  <td>
                    <strong>{user.name || "Chưa có tên"}</strong>
                    <span className="table-email">{user.email}</span>
                    <small>
                      {user.phone || "Chưa có SĐT"}
                      {user.isAdmin ? " · Quản trị viên" : ""}
                    </small>
                  </td>
                  <td>
                    <span
                      className={
                        "pill " + (user.status === "active" ? "green" : "warn")
                      }
                    >
                      {statusName[user.status]}
                    </span>
                    {!user.emailVerified && <small>Chưa xác nhận email</small>}
                  </td>
                  <td>{number(user.poshmarkCount)}</td>
                  <td>
                    <strong>{number(user.orders)}</strong>
                  </td>
                  <td>{date(user.lastSeenAt)}</td>
                  <td>
                    <div className="table-actions">
                      <button
                        className="secondary"
                        onClick={() => setDetail(user.id)}
                        disabled={busy}
                      >
                        Chi tiết
                      </button>
                      {user.status === "deleted" ? (
                        <button
                          onClick={() => action(user, "restore")}
                          disabled={busy}
                        >
                          Khôi phục
                        </button>
                      ) : (
                        <>
                          <button
                            className="secondary"
                            onClick={() => setEditor(user)}
                            disabled={busy}
                          >
                            Sửa
                          </button>
                          <button
                            className="secondary"
                            onClick={() => action(user, "invite")}
                            disabled={busy || user.status !== "active"}
                          >
                            Gửi thư
                          </button>
                          <button
                            className="danger-button"
                            onClick={() => action(user, "delete")}
                            disabled={busy || user.isAdmin}
                          >
                            Xóa
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!loading && !users.length && (
          <p className="admin-empty">Không có tài khoản phù hợp.</p>
        )}
        <p className="hint admin-count-note">
          ACC Poshmark đếm số tên account đã dùng khi chạy Get Label.
        </p>
        <div className="admin-pagination">
          <button
            className="secondary"
            onClick={() => setOffset((value) => Math.max(0, value - 20))}
            disabled={loading || offset === 0}
          >
            Trang trước
          </button>
          <span>Trang {Math.floor(offset / 20) + 1}</span>
          <button
            className="secondary"
            onClick={() => setOffset((value) => value + 20)}
            disabled={loading || !more}
          >
            Trang sau
          </button>
        </div>
      </section>
      {editor && (
        <Editor
          user={editor.id ? editor : null}
          onClose={() => setEditor(null)}
          onSaved={(text, warning) => {
            setEditor(null);
            setMessage(text);
            setMessageWarning(!!warning);
            setRevision((value) => value + 1);
          }}
        />
      )}
      {detail && <Details id={detail} onClose={() => setDetail(null)} />}
    </main>
  );
}
