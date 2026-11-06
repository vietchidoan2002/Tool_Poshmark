const { parsePhoneNumberFromString } = require("libphonenumber-js/max");
const fail = (status, message) => Object.assign(new Error(message), { status });
function normalizePhone(input) {
  if (typeof input !== "string" || !/^\+?[\d\s().-]{7,40}$/.test(input.trim()))
    throw fail(
      400,
      "Nhập số điện thoại hợp lệ, ví dụ 0901234567 hoặc +84901234567.",
    );
  const phone = parsePhoneNumberFromString(input.trim(), "VN");
  if (!phone || !phone.isValid() || phone.ext)
    throw fail(
      400,
      "Số điện thoại không hợp lệ. Số quốc tế phải có mã quốc gia +...",
    );
  return phone.number;
}
const fields = (row) => ({
  phone: row?.phone || "",
  version: row?.version || 0,
  reviewed: !!row?.reviewed,
  reviewedAt: row?.reviewed_at || null,
  verificationMethod: row?.reviewed ? "manual" : null,
});
async function createPhoneStore(pool) {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS pm_phone_profiles (user_id text PRIMARY KEY REFERENCES pm_users(id),phone text UNIQUE,version integer NOT NULL DEFAULT 1,reviewed boolean NOT NULL DEFAULT false,reviewed_at timestamptz,reviewed_by text)`,
  );
  await pool.query(
    `CREATE TABLE IF NOT EXISTS pm_phone_audit (id bigserial PRIMARY KEY,actor_id text NOT NULL,user_id text NOT NULL,action text NOT NULL,phone_last4 text,created_at timestamptz NOT NULL DEFAULT now())`,
  );
  const get = async (id) =>
    (await pool.query("SELECT * FROM pm_phone_profiles WHERE user_id=$1", [id]))
      .rows[0];
  return {
    get,
    async list(search, limit, offset) {
      const result = await pool.query(
        `SELECT u.id,u.email,p.phone,p.version,p.reviewed,p.reviewed_at,p.reviewed_by FROM pm_users u LEFT JOIN pm_phone_profiles p ON u.id=p.user_id WHERE u.email ILIKE $1 OR p.phone ILIKE $1 ORDER BY u.id LIMIT $2 OFFSET $3`,
        ["%" + search + "%", limit + 1, offset],
      );
      return {
        users: result.rows
          .slice(0, limit)
          .map((row) => ({ id: row.id, email: row.email, ...fields(row) })),
        hasMore: result.rows.length > limit,
      };
    },
    async write(id, actor, phone, version, reviewed) {
      if (!Number.isSafeInteger(version) || version < 0)
        throw fail(
          400,
          "Phiên bản dữ liệu không hợp lệ. Hãy tải lại danh sách.",
        );
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        let result;
        if (reviewed !== undefined) {
          if (typeof reviewed !== "boolean")
            throw fail(400, "Trạng thái kiểm tra không hợp lệ.");
          result = await client.query(
            `UPDATE pm_phone_profiles SET reviewed=$1,reviewed_at=$2,reviewed_by=$3,version=version+1 WHERE user_id=$4 AND version=$5 AND phone IS NOT NULL RETURNING *`,
            [
              reviewed,
              reviewed ? new Date() : null,
              reviewed ? actor : null,
              id,
              version,
            ],
          );
        } else if (version === 0) {
          result = await client.query(
            `INSERT INTO pm_phone_profiles(user_id,phone) VALUES($1,$2) ON CONFLICT(user_id) DO NOTHING RETURNING *`,
            [id, phone],
          );
        } else {
          const current = await client.query(
            "SELECT * FROM pm_phone_profiles WHERE user_id=$1 AND version=$2",
            [id, version],
          );
          if (current.rows[0] && current.rows[0].phone === phone) {
            await client.query("COMMIT");
            return fields(current.rows[0]);
          }
          result = await client.query(
            `UPDATE pm_phone_profiles SET phone=$1,reviewed=false,reviewed_at=NULL,reviewed_by=NULL,version=version+1 WHERE user_id=$2 AND version=$3 RETURNING *`,
            [phone, id, version],
          );
        }
        if (!result.rows.length)
          throw fail(
            409,
            "Số điện thoại đã thay đổi hoặc chưa có số để kiểm tra. Hãy tải lại dữ liệu.",
          );
        const row = result.rows[0];
        await client.query(
          "INSERT INTO pm_phone_audit(actor_id,user_id,action,phone_last4) VALUES($1,$2,$3,$4)",
          [
            actor,
            id,
            reviewed === undefined
              ? phone
                ? "save"
                : "delete"
              : reviewed
                ? "review"
                : "unreview",
            row.phone?.slice(-4) || null,
          ],
        );
        await client.query("COMMIT");
        return fields(row);
      } catch (error) {
        await client.query("ROLLBACK");
        if (error.code === "23505")
          throw fail(409, "Số điện thoại đã được dùng cho một tài khoản khác.");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
async function mountPhones(app, pool, users, config) {
  const phones = await createPhoneStore(pool);
  const admins = new Set(
    String(config.adminEmails || "")
      .split(",")
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean),
  );
  if (config.requirePhoneReview && admins.size === 0)
    throw Error("ADMIN_EMAILS is required when phone review is required");
  const isAdmin = async (id) => {
    const user = id ? await users.get(id) : null;
    return (
      !!user &&
      admins.has(user.email.toLowerCase()) &&
      (!users.isVerified || (await users.isVerified(id)))
    );
  };
  const wrap = (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res)).catch((error) =>
      error.status
        ? res.status(error.status).json({ error: error.message })
        : next(error),
    );
  app.get(
    "/api/profile",
    wrap(async (req, res) =>
      res.json({
        ...fields(await phones.get(req.session.userId)),
        isAdmin: await isAdmin(req.session.userId),
        phoneRequired: !!config.requirePhoneReview,
      }),
    ),
  );
  app.put(
    "/api/profile/phone",
    wrap(async (req, res) =>
      res.json(
        await phones.write(
          req.session.userId,
          req.session.userId,
          normalizePhone(req.body?.phone),
          req.body?.version,
        ),
      ),
    ),
  );
  app.delete(
    "/api/profile/phone",
    wrap(async (req, res) =>
      res.json(
        await phones.write(
          req.session.userId,
          req.session.userId,
          null,
          req.body?.version,
        ),
      ),
    ),
  );
  app.use("/api/admin", (req, res, next) =>
    isAdmin(req.session.userId)
      .then((allowed) =>
        allowed
          ? next()
          : res
              .status(403)
              .json({ error: "Chỉ quản trị viên được truy cập trang quản trị." }),
      )
      .catch(next),
  );
  app.get(
    "/api/admin/phones",
    wrap(async (req, res) => {
      const search = String(req.query.search || "").trim();
      const limit = Number(req.query.limit || 20),
        offset = Number(req.query.offset || 0);
      if (
        search.length > 100 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        !Number.isInteger(offset) ||
        offset < 0 ||
        offset > 100000
      )
        throw fail(400, "Bộ lọc hoặc phân trang không hợp lệ.");
      res.json(await phones.list(search, limit, offset));
    }),
  );
  const target = async (req) => {
    if (!(await users.get(req.params.id)))
      throw fail(404, "Không tìm thấy tài khoản.");
    return req.params.id;
  };
  app.put(
    "/api/admin/phones/:id",
    wrap(async (req, res) =>
      res.json(
        await phones.write(
          await target(req),
          req.session.userId,
          normalizePhone(req.body?.phone),
          req.body?.version,
        ),
      ),
    ),
  );
  app.delete(
    "/api/admin/phones/:id",
    wrap(async (req, res) =>
      res.json(
        await phones.write(
          await target(req),
          req.session.userId,
          null,
          req.body?.version,
        ),
      ),
    ),
  );
  app.post(
    "/api/admin/phones/:id/review",
    wrap(async (req, res) => {
      if (typeof req.body?.reviewed !== "boolean")
        throw fail(400, "Trạng thái kiểm tra không hợp lệ.");
      res.json(
        await phones.write(
          await target(req),
          req.session.userId,
          null,
          req.body.version,
          req.body.reviewed,
        ),
      );
    }),
  );
  return phones;
}
module.exports = { normalizePhone, createPhoneStore, mountPhones };
