const crypto = require("node:crypto");
const { rateLimit } = require("express-rate-limit");
const { emailAddress } = require("./password-auth.cjs");
const { normalizePhone } = require("./phones.cjs");
const { DISABLED_PASSWORD } = require("./user-identity.cjs");
const fail = (status, message) => Object.assign(new Error(message), { status });
const count = (value) => Math.max(0, Number(value) || 0);
const integer = (value, min, max) =>
  Number.isSafeInteger(value) && value >= min && value <= max;
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res)).catch((error) => {
    if (error.code === "23505")
      return res
        .status(409)
        .json({ error: "Email hoặc số điện thoại đã được sử dụng." });
    if (error.status)
      return res.status(error.status).json({ error: error.message });
    next(error);
  });
function administratorEmails(config) {
  return new Set(
    String(config.adminEmails || "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
}
async function initializeUsage(pool) {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS pm_app_metadata (key text PRIMARY KEY,value text NOT NULL)`,
  );
  await pool.query(
    "INSERT INTO pm_app_metadata(key,value) VALUES('usage_since',$1) ON CONFLICT(key) DO NOTHING",
    [new Date().toISOString()],
  );
  await pool.query(`CREATE TABLE IF NOT EXISTS pm_get_runs (
 id text PRIMARY KEY,user_id text NOT NULL REFERENCES pm_users(id),account_name text NOT NULL,
 started_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,status text NOT NULL DEFAULT 'running',
 written_count integer NOT NULL DEFAULT 0,skipped_count integer NOT NULL DEFAULT 0
 )`);
  await pool.query(
    "CREATE INDEX IF NOT EXISTS pm_get_runs_user_time ON pm_get_runs(user_id,started_at)",
  );
  await pool.query(
    "CREATE INDEX IF NOT EXISTS pm_get_runs_time ON pm_get_runs(started_at)",
  );
  await pool.query(`CREATE TABLE IF NOT EXISTS pm_admin_audit (
 id bigserial PRIMARY KEY,actor_id text NOT NULL,target_id text NOT NULL,action text NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
 )`);
  return {
    async start(userId, accountName) {
      const id = crypto.randomUUID();
      await pool.query(
        "INSERT INTO pm_get_runs(id,user_id,account_name) VALUES($1,$2,$3)",
        [id, userId, accountName],
      );
      return id;
    },
    async finish(id, status, stats = {}) {
      await pool.query(
        "UPDATE pm_get_runs SET status=$1,written_count=$2,skipped_count=$3,finished_at=$4 WHERE id=$5",
        [
          status,
          count(stats.writtenOrderCount ?? stats.writtenCount),
          count(stats.skippedCount),
          new Date(),
          id,
        ],
      );
    },
    async touch(id) {
      const now = new Date();
      await pool.query(
        "UPDATE pm_users SET last_seen_at=$1 WHERE id=$2 AND (last_seen_at IS NULL OR last_seen_at<$3)",
        [now, id, new Date(now.getTime() - 5 * 60000)],
      );
    },
  };
}
async function mountAdmin(app, pool, store, passwordAuth, config) {
  const usage = await initializeUsage(pool);
  const admins = administratorEmails(config);
  const isAdmin = async (id) => {
    const user = id ? await store.get(id) : null;
    return (
      !!user &&
      !user.deleted_at &&
      user.status === "active" &&
      admins.has(user.email.toLowerCase()) &&
      (await passwordAuth.isVerified(id))
    );
  };
  app.use("/api/admin", (req, res, next) => {
    isAdmin(req.session.userId)
      .then((allowed) =>
        allowed
          ? next()
          : res
              .status(403)
              .json({ error: "Chỉ quản trị viên được truy cập dashboard." }),
      )
      .catch(next);
  });
  app.use(
    "/api/admin",
    rateLimit({
      windowMs: 15 * 60000,
      limit: 300,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: { error: "Đã đạt giới hạn thao tác quản trị. Hãy thử lại sau." },
    }),
  );
  const audit = (client, actor, target, action) =>
    client.query(
      "INSERT INTO pm_admin_audit(actor_id,target_id,action) VALUES($1,$2,$3)",
      [actor, target, action],
    );
  const totals = async () =>
    new Map(
      (
        await pool.query(
          "SELECT user_id,COUNT(*) AS runs,SUM(written_count) AS orders,SUM(skipped_count) AS skipped,COUNT(DISTINCT lower(account_name)) AS poshmark_count FROM pm_get_runs GROUP BY user_id",
        )
      ).rows.map((row) => [
        row.user_id,
        {
          getRuns: count(row.runs),
          orders: count(row.orders),
          skipped: count(row.skipped),
          poshmarkCount: count(row.poshmark_count),
        },
      ]),
    );
  const serialize = (row, metrics) => ({
    id: row.id,
    email: row.email,
    name: row.display_name || row.password_name || "",
    phone: row.phone || "",
    phoneReviewed: !!row.reviewed,
    phoneVersion: row.phone_version || 0,
    version: row.profile_version,
    status: row.deleted_at ? "deleted" : row.status,
    emailVerified: row.email_verified == null ? true : row.email_verified,
    isAdmin: admins.has(row.email.toLowerCase()),
    gmailCount: row.gmail_connected ? 1 : 0,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    ...(metrics || { getRuns: 0, orders: 0, skipped: 0, poshmarkCount: 0 }),
  });
  const userSelect =
    "SELECT u.id,u.email,u.display_name,u.created_at,u.last_seen_at,u.status,u.deleted_at,u.profile_version,(u.tokens IS NOT NULL) AS gmail_connected,p.display_name AS password_name,p.email_verified,f.phone,f.reviewed,f.version AS phone_version FROM pm_users u LEFT JOIN pm_password_accounts p ON p.user_id=u.id LEFT JOIN pm_phone_profiles f ON f.user_id=u.id";
  async function getUser(id) {
    const row = (await pool.query(userSelect + " WHERE u.id=$1", [id])).rows[0];
    if (!row) throw fail(404, "Không tìm thấy tài khoản.");
    return serialize(row, (await totals()).get(id));
  }
  app.get(
    "/api/admin/dashboard",
    wrap(async (req, res) => {
      const days = Number(req.query.days || 30);
      if (![7, 30, 90].includes(days))
        throw fail(400, "Khoảng thống kê không hợp lệ.");
      const now = Date.now(),
        since = new Date(now - days * 86400000),
        d7 = new Date(now - 7 * 86400000),
        d14 = new Date(now - 14 * 86400000),
        d30 = new Date(now - 30 * 86400000);
      const [usersResult, runsResult, trendResult, metaResult] =
        await Promise.all([
          pool.query(
            `SELECT COUNT(*) AS total,SUM(CASE WHEN u.deleted_at IS NULL THEN 1 ELSE 0 END) AS available,SUM(CASE WHEN u.deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS deleted,SUM(CASE WHEN u.deleted_at IS NULL AND u.status='suspended' THEN 1 ELSE 0 END) AS suspended,SUM(CASE WHEN u.deleted_at IS NULL AND (p.email_verified=true OR p.user_id IS NULL) THEN 1 ELSE 0 END) AS verified,SUM(CASE WHEN u.deleted_at IS NULL AND u.tokens IS NOT NULL THEN 1 ELSE 0 END) AS gmail,SUM(CASE WHEN u.deleted_at IS NULL AND u.last_seen_at>=$1 THEN 1 ELSE 0 END) AS active30,SUM(CASE WHEN u.created_at>=$2 THEN 1 ELSE 0 END) AS new7,SUM(CASE WHEN u.created_at>=$3 AND u.created_at<$2 THEN 1 ELSE 0 END) AS previous7,SUM(CASE WHEN u.created_at IS NULL THEN 1 ELSE 0 END) AS unknown_created FROM pm_users u LEFT JOIN pm_password_accounts p ON p.user_id=u.id`,
            [d30, d7, d14],
          ),
          pool.query(
            `SELECT COUNT(*) AS runs,COUNT(DISTINCT user_id) AS users,SUM(written_count) AS orders,SUM(skipped_count) AS skipped,SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS successful,SUM(CASE WHEN status='partial' OR status='failed' THEN 1 ELSE 0 END) AS failed,SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) AS running FROM pm_get_runs WHERE started_at>=$1`,
            [since],
          ),
          pool.query(
            "SELECT CAST(started_at AT TIME ZONE 'Asia/Ho_Chi_Minh' AS date) AS day,COUNT(*) AS runs,SUM(written_count) AS orders FROM pm_get_runs WHERE started_at>=$1 GROUP BY CAST(started_at AT TIME ZONE 'Asia/Ho_Chi_Minh' AS date) ORDER BY day",
            [since],
          ),
          pool.query(
            "SELECT value FROM pm_app_metadata WHERE key='usage_since'",
          ),
        ]);
      const u = usersResult.rows[0],
        r = runsResult.rows[0];
      res.json({
        days,
        trackingSince: metaResult.rows[0].value,
        users: {
          total: count(u.total),
          available: count(u.available),
          deleted: count(u.deleted),
          suspended: count(u.suspended),
          verified: count(u.verified),
          gmailConnected: count(u.gmail),
          active30: count(u.active30),
          new7: count(u.new7),
          previous7: count(u.previous7),
          unknownCreated: count(u.unknown_created),
        },
        usage: {
          getRuns: count(r.runs),
          getUsers: count(r.users),
          orders: count(r.orders),
          skipped: count(r.skipped),
          successful: count(r.successful),
          failed: count(r.failed),
          running: count(r.running),
        },
        trend: trendResult.rows.map((row) => ({
          day: new Date(row.day).toISOString().slice(0, 10),
          runs: count(row.runs),
          orders: count(row.orders),
        })),
      });
    }),
  );
  app.get(
    "/api/admin/users",
    wrap(async (req, res) => {
      const search = String(req.query.search || "").trim(),
        status = String(req.query.status || "all"),
        offset = Number(req.query.offset || 0),
        limit = Number(req.query.limit || 20);
      if (
        search.length > 100 ||
        !["all", "active", "suspended", "pending", "deleted"].includes(
          status,
        ) ||
        !integer(offset, 0, 100000) ||
        !integer(limit, 1, 100)
      )
        throw fail(400, "Bộ lọc không hợp lệ.");
      const filter =
        status === "deleted"
          ? "u.deleted_at IS NOT NULL"
          : "u.deleted_at IS NULL" +
            (status === "active"
              ? " AND u.status='active'"
              : status === "suspended"
                ? " AND u.status='suspended'"
                : status === "pending"
                  ? " AND p.email_verified=false"
                  : "");
      const rows = (
        await pool.query(
          userSelect +
            ` WHERE (${filter}) AND (u.email ILIKE $1 OR u.display_name ILIKE $1 OR p.display_name ILIKE $1 OR f.phone ILIKE $1) ORDER BY u.email LIMIT $2 OFFSET $3`,
          ["%" + search + "%", limit + 1, offset],
        )
      ).rows;
      const metrics = await totals();
      res.json({
        users: rows
          .slice(0, limit)
          .map((row) => serialize(row, metrics.get(row.id))),
        hasMore: rows.length > limit,
      });
    }),
  );
  app.get(
    "/api/admin/users/:id",
    wrap(async (req, res) => {
      const user = await getUser(req.params.id);
      const runs = (
        await pool.query(
          "SELECT id,account_name,started_at,finished_at,status,written_count,skipped_count FROM pm_get_runs WHERE user_id=$1 ORDER BY started_at DESC LIMIT 50",
          [user.id],
        )
      ).rows;
      const accounts = (
        await pool.query(
          "SELECT lower(account_name) AS key,MIN(account_name) AS name,COUNT(*) AS runs,SUM(written_count) AS orders,SUM(skipped_count) AS skipped FROM pm_get_runs WHERE user_id=$1 GROUP BY lower(account_name) ORDER BY name",
          [user.id],
        )
      ).rows.map((row) => ({
        name: row.name,
        runs: count(row.runs),
        orders: count(row.orders),
        skipped: count(row.skipped),
      }));
      res.json({
        user,
        accounts,
        runs: runs.map((row) => ({
          id: row.id,
          accountName: row.account_name,
          startedAt: row.started_at,
          finishedAt: row.finished_at,
          status: row.status,
          orders: count(row.written_count),
          skipped: count(row.skipped_count),
        })),
      });
    }),
  );
  const nameInput = (value) => {
    const name = String(value || "").trim();
    if (!name || name.length > 100)
      throw fail(400, "Nhập họ tên từ 1 đến 100 ký tự.");
    return name;
  };
  app.post(
    "/api/admin/users",
    wrap(async (req, res) => {
      const email = emailAddress(req.body?.email),
        name = nameInput(req.body?.name),
        phone = normalizePhone(req.body?.phone);
      if (admins.has(email))
        throw fail(
          403,
          "Tài khoản quản trị được thiết lập bằng ADMIN_EMAILS và đăng nhập Google.",
        );
      const client = await pool.connect();
      let id;
      try {
        await client.query("BEGIN");
        id = await passwordAuth.accounts.register(
          email,
          name,
          DISABLED_PASSWORD,
          phone,
          "admin-created",
          client,
        );
        await audit(client, req.session.userId, id, "create");
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      let mailSent = false,
        mailError = "";
      if (req.body?.sendInvite === true) {
        try {
          await passwordAuth.sendSetupEmail(id);
          mailSent = true;
        } catch (error) {
          mailError = error.status
            ? error.message
            : "Chưa gửi được thư thiết lập. Tài khoản đã được tạo; hãy thử gửi lại sau.";
        }
      }
      res
        .status(201)
        .json({ ok: true, user: await getUser(id), mailSent, mailError });
    }),
  );
  async function mutate(req, action, fn) {
    const version = req.body?.version;
    if (!integer(version, 1, 2147483647))
      throw fail(400, "Hãy tải lại thông tin tài khoản trước khi sửa.");
    const client = await pool.connect();
    let locked = false,
      releaseError;
    try {
      locked = (
        await client.query(
          "SELECT pg_try_advisory_lock(hashtext($1)) AS acquired",
          ["pm-user:" + req.params.id],
        )
      ).rows[0].acquired;
      if (!locked)
        throw fail(
          409,
          "Tài khoản đang chạy Get Label. Hãy chờ hoàn tất rồi thử lại.",
        );
      await client.query("BEGIN");
      const user = (
        await client.query("SELECT * FROM pm_users WHERE id=$1 FOR UPDATE", [
          req.params.id,
        ])
      ).rows[0];
      if (!user) throw fail(404, "Không tìm thấy tài khoản.");
      if (user.profile_version !== version)
        throw fail(409, "Thông tin đã được thay đổi. Hãy tải lại danh sách.");
      await fn(client, user);
      await audit(client, req.session.userId, user.id, action);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      if (locked)
        try {
          await client.query("SELECT pg_advisory_unlock(hashtext($1))", [
            "pm-user:" + req.params.id,
          ]);
        } catch (error) {
          releaseError = error;
        }
      client.release(releaseError);
    }
  }
  app.put(
    "/api/admin/users/:id",
    wrap(async (req, res) => {
      const name = nameInput(req.body?.name),
        status = req.body?.status;
      if (!["active", "suspended"].includes(status))
        throw fail(400, "Trạng thái tài khoản không hợp lệ.");
      if (req.body?.phone !== null && typeof req.body?.phone !== "string")
        throw fail(400, "Số điện thoại không hợp lệ.");
      const phone = req.body?.phone?.trim()
        ? normalizePhone(req.body.phone)
        : null;
      if (!integer(req.body?.phoneVersion, 0, 2147483647))
        throw fail(400, "Hãy tải lại số điện thoại trước khi sửa.");
      await mutate(req, "update", async (client, user) => {
        if (user.deleted_at)
          throw fail(409, "Tài khoản đã xóa. Hãy khôi phục trước khi sửa.");
        if (
          req.body?.email &&
          emailAddress(req.body.email) !== user.email.toLowerCase()
        )
          throw fail(
            400,
            "Email đăng nhập được giữ cố định. Bạn có thể sửa tên, số điện thoại và trạng thái.",
          );
        if (admins.has(user.email.toLowerCase()) && status !== "active")
          throw fail(403, "Không thể khóa tài khoản quản trị.");
        const previous = (
          await client.query(
            "SELECT * FROM pm_phone_profiles WHERE user_id=$1",
            [user.id],
          )
        ).rows[0];
        if ((previous?.version || 0) !== req.body.phoneVersion)
          throw fail(409, "Số điện thoại đã thay đổi. Hãy tải lại tài khoản.");
        if (
          phone &&
          (
            await client.query(
              "SELECT user_id FROM pm_phone_profiles WHERE phone=$1 AND user_id<>$2",
              [phone, user.id],
            )
          ).rows.length
        )
          throw fail(409, "Số điện thoại đã được sử dụng.");
        await client.query(
          "UPDATE pm_users SET display_name=$1,status=$2,profile_version=profile_version+1,session_version=session_version+$3 WHERE id=$4",
          [name, status, user.status === status ? 0 : 1, user.id],
        );
        await client.query(
          "UPDATE pm_password_accounts SET display_name=$1 WHERE user_id=$2",
          [name, user.id],
        );
        if ((previous?.phone || null) !== phone) {
          await client.query(
            "INSERT INTO pm_phone_profiles(user_id,phone) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET phone=$2,reviewed=false,reviewed_at=NULL,reviewed_by=NULL,version=pm_phone_profiles.version+1",
            [user.id, phone],
          );
          await client.query(
            "INSERT INTO pm_phone_audit(actor_id,user_id,action,phone_last4) VALUES($1,$2,$3,$4)",
            [
              req.session.userId,
              user.id,
              phone ? "save" : "delete",
              phone?.slice(-4) || null,
            ],
          );
        }
      });
      res.json({ ok: true, user: await getUser(req.params.id) });
    }),
  );
  app.delete(
    "/api/admin/users/:id",
    wrap(async (req, res) => {
      await mutate(req, "delete", async (client, user) => {
        if (admins.has(user.email.toLowerCase()))
          throw fail(403, "Không thể xóa tài khoản quản trị.");
        if (user.deleted_at) throw fail(409, "Tài khoản đã được xóa.");
        await client.query(
          "UPDATE pm_users SET deleted_at=$1,status='suspended',tokens=NULL,token_version=token_version+1,profile_version=profile_version+1,session_version=session_version+1 WHERE id=$2",
          [new Date(), user.id],
        );
        await client.query(
          "UPDATE pm_password_accounts SET password_hash=$1,auth_version=auth_version+1 WHERE user_id=$2",
          [DISABLED_PASSWORD, user.id],
        );
        await client.query("DELETE FROM pm_account_actions WHERE user_id=$1", [
          user.id,
        ]);
        await client.query("DELETE FROM pm_phone_profiles WHERE user_id=$1", [
          user.id,
        ]);
      });
      res.json({ ok: true });
    }),
  );
  app.post(
    "/api/admin/users/:id/restore",
    wrap(async (req, res) => {
      await mutate(req, "restore", async (client, user) => {
        if (!user.deleted_at) throw fail(409, "Tài khoản chưa bị xóa.");
        await client.query(
          "UPDATE pm_users SET deleted_at=NULL,status='active',profile_version=profile_version+1,session_version=session_version+1 WHERE id=$1",
          [user.id],
        );
      });
      res.json({ ok: true, user: await getUser(req.params.id) });
    }),
  );
  app.post(
    "/api/admin/users/:id/invite",
    wrap(async (req, res) => {
      const user = await getUser(req.params.id);
      if (user.status !== "active")
        throw fail(
          409,
          "Hãy kích hoạt hoặc khôi phục tài khoản trước khi gửi thư.",
        );
      await passwordAuth.sendSetupEmail(user.id);
      await audit(pool, req.session.userId, user.id, "send_setup");
      res.json({ ok: true });
    }),
  );
  return { usage, isAdmin };
}
module.exports = { mountAdmin, initializeUsage, administratorEmails };
