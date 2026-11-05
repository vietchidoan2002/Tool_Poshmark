const crypto = require("node:crypto");
const { promisify } = require("node:util");
const derive = promisify(crypto.scrypt);
const { rateLimit } = require("express-rate-limit");
const { normalizePhone } = require("./phones.cjs");
const { mailError, mailDiagnostic } = require("./mail-diagnostics.cjs");
const fail = (status, message) => Object.assign(new Error(message), { status });
const emailAddress = (value) => {
  const email = String(value || "")
    .trim()
    .toLowerCase();
  if (
    email.length > 254 ||
    !/^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,63}$/i.test(email) ||
    !email
      .split("@")[1]
      .split(".")
      .every((label) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))
  )
    throw fail(400, "Email không hợp lệ.");
  return email;
};
function passwordValid(value) {
  if (
    typeof value !== "string" ||
    Array.from(value).length < 8 ||
    Array.from(value).length > 128 ||
    Buffer.byteLength(value) > 1024
  )
    throw fail(400, "Mật khẩu phải có từ 8 đến 128 ký tự.");
  return value;
}
let workers = 0;
const queue = [];
async function hashWork(fn) {
  if (workers >= 2) {
    if (queue.length >= 8)
      throw fail(429, "Máy chủ đang bận. Vui lòng thử lại.");
    await new Promise((resolve) => queue.push(resolve));
  } else workers++;
  try {
    return await fn();
  } finally {
    const next = queue.shift();
    if (next) next();
    else workers--;
  }
}
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await hashWork(() =>
    derive(password, salt, 64, {
      N: 32768,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    }),
  );
  return `scrypt-v1$${salt.toString("base64")}$${key.toString("base64")}`;
}
async function checkPassword(password, hash) {
  const parts = String(hash || "").split("$");
  const salt =
    parts[0] === "scrypt-v1"
      ? Buffer.from(parts[1] || "", "base64")
      : Buffer.alloc(16);
  const expected = Buffer.from(parts[2] || "", "base64");
  const valid =
    parts[0] === "scrypt-v1" &&
    parts.length === 3 &&
    salt.length === 16 &&
    expected.length === 64;
  const key = await hashWork(() =>
    derive(
      String(password).slice(0, 1024),
      valid ? salt : Buffer.alloc(16),
      64,
      { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
    ),
  );
  return valid && crypto.timingSafeEqual(key, expected);
}
const digest = (token) =>
  crypto.createHash("sha256").update(token).digest("hex");
async function createAccountStore(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS pm_password_accounts (
    user_id text PRIMARY KEY REFERENCES pm_users(id),email text UNIQUE NOT NULL,display_name text NOT NULL,
    password_hash text NOT NULL,email_verified boolean NOT NULL DEFAULT false,auth_version integer NOT NULL DEFAULT 1,
    terms_version text NOT NULL,failed_attempts integer NOT NULL DEFAULT 0,locked_until timestamptz
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS pm_account_actions (
    token_hash text PRIMARY KEY,user_id text NOT NULL REFERENCES pm_users(id),purpose text NOT NULL,expires_at timestamptz NOT NULL
  )`);
  return {
    async get(id) {
      return (
        await pool.query(
          "SELECT * FROM pm_password_accounts WHERE user_id=$1",
          [id],
        )
      ).rows[0];
    },
    async byEmail(email) {
      return (
        await pool.query("SELECT * FROM pm_password_accounts WHERE email=$1", [
          email,
        ])
      ).rows[0];
    },
    async recipient(email) {
      const account = await this.byEmail(email);
      return (
        account ||
        (
          await pool.query(
            "SELECT id AS user_id,email FROM pm_users WHERE lower(email)=$1 ORDER BY id LIMIT 1",
            [email],
          )
        ).rows[0]
      );
    },
    async register(email, name, hash, phone) {
      const client = await pool.connect();
      const id = "pw:" + crypto.randomUUID();
      try {
        await client.query("BEGIN");
        if (
          (
            await client.query(
              "SELECT id FROM pm_users WHERE lower(email)=$1",
              [email],
            )
          ).rows.length
        )
          throw fail(
            409,
            "Email đã có tài khoản. Hãy đăng nhập hoặc dùng Quên mật khẩu.",
          );
        if (
          (
            await client.query(
              "SELECT user_id FROM pm_phone_profiles WHERE phone=$1",
              [phone],
            )
          ).rows.length
        )
          throw fail(
            409,
            "Email hoặc số điện thoại đã được sử dụng. Hãy đăng nhập hoặc liên hệ quản trị viên.",
          );
        await client.query("INSERT INTO pm_users(id,email) VALUES($1,$2)", [
          id,
          email,
        ]);
        await client.query(
          "INSERT INTO pm_password_accounts(user_id,email,display_name,password_hash,terms_version) VALUES($1,$2,$3,$4,$5)",
          [id, email, name, hash, "2026-11-v1"],
        );
        await client.query(
          "INSERT INTO pm_phone_profiles(user_id,phone) VALUES($1,$2)",
          [id, phone],
        );
        await client.query("COMMIT");
        return id;
      } catch (error) {
        await client.query("ROLLBACK");
        if (error.code === "23505")
          throw fail(
            409,
            "Email hoặc số điện thoại đã được sử dụng. Hãy đăng nhập hoặc liên hệ quản trị viên.",
          );
        throw error;
      } finally {
        client.release();
      }
    },
    async issue(id, purpose) {
      const token = crypto.randomBytes(32).toString("base64url");
      await pool.query(
        "DELETE FROM pm_account_actions WHERE user_id=$1 AND purpose=$2",
        [id, purpose],
      );
      await pool.query(
        "INSERT INTO pm_account_actions(token_hash,user_id,purpose,expires_at) VALUES($1,$2,$3,$4)",
        [
          digest(token),
          id,
          purpose,
          new Date(
            Date.now() + (purpose === "reset" ? 30 * 60000 : 24 * 3600000),
          ),
        ],
      );
      return token;
    },
    async consume(token, purpose, passwordHash, currentUser) {
      if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token))
        throw fail(400, "Liên kết không hợp lệ hoặc đã hết hạn.");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // Consume atomically; a second use cannot change a password again.
        const query =
          purpose === "verify"
            ? await client.query(
                "DELETE FROM pm_account_actions WHERE token_hash=$1 AND purpose=$2 AND expires_at>now() AND user_id=$3 RETURNING user_id",
                [digest(token), purpose, currentUser || ""],
              )
            : await client.query(
                "DELETE FROM pm_account_actions WHERE token_hash=$1 AND purpose=$2 AND expires_at>now() RETURNING user_id",
                [digest(token), purpose],
              );
        const id = query.rows[0]?.user_id;
        if (!id)
          throw fail(
            400,
            "Liên kết không hợp lệ, đã dùng hoặc hết hạn. Hãy yêu cầu gửi lại.",
          );
        if (purpose === "verify")
          await client.query(
            "UPDATE pm_password_accounts SET email_verified=true WHERE user_id=$1",
            [id],
          );
        else {
          const user = (
            await client.query("SELECT email FROM pm_users WHERE id=$1", [id])
          ).rows[0];
          await client.query(
            `INSERT INTO pm_password_accounts(user_id,email,display_name,password_hash,email_verified,terms_version)
            VALUES($1,$2,$2,$3,true,$4) ON CONFLICT(user_id) DO UPDATE SET password_hash=$3,email_verified=true,auth_version=pm_password_accounts.auth_version+1,failed_attempts=0,locked_until=NULL`,
            [id, emailAddress(user.email), passwordHash, "legacy-google-reset"],
          );
          await client.query(
            "DELETE FROM pm_account_actions WHERE user_id=$1",
            [id],
          );
        }
        await client.query("COMMIT");
        return id;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async failed(id) {
      await pool.query(
        "UPDATE pm_password_accounts SET failed_attempts=failed_attempts+1 WHERE user_id=$1",
        [id],
      );
      const row = await this.get(id);
      if (row.failed_attempts >= 10)
        await pool.query(
          "UPDATE pm_password_accounts SET locked_until=$1 WHERE user_id=$2",
          [new Date(Date.now() + 15 * 60000), id],
        );
    },
    async success(id) {
      await pool.query(
        "UPDATE pm_password_accounts SET failed_attempts=0,locked_until=NULL WHERE user_id=$1",
        [id],
      );
    },
  };
}
function mailSender(config, deps) {
  if (deps.sendEmail) return deps.sendEmail;
  if (config.mailProvider === "gmail" && config.mailSenderEmail) {
    let sender;
    try {
      sender = emailAddress(config.mailSenderEmail);
    } catch {
      throw require("./startup-diagnostics.cjs").configurationError(
        "CONFIG_AUTH_MAIL_SENDER",
      );
    }
    const admins = String(config.adminEmails || "")
      .split(",")
      .map((email) => email.trim().toLowerCase());
    if (!admins.includes(sender))
      throw require("./startup-diagnostics.cjs").configurationError(
        "CONFIG_AUTH_MAIL_SENDER",
      );
    const prepare = async () => {
      const user = await deps.userStore.findByEmail(sender);
      if (!user?.tokens || !(await deps.userStore.isVerified(user.id)))
        throw mailError("SENDER_NOT_CONNECTED");
      let stored;
      try {
        stored = deps.userStore.decrypt(user.tokens, user.id);
        if (!stored || typeof stored !== "object") throw Error("Invalid token");
      } catch {
        throw mailError("TOKEN_UNREADABLE");
      }
      const { pm_connected_email, ...credentials } = stored;
      if (String(pm_connected_email || user.email).toLowerCase() !== sender)
        throw mailError("SENDER_MISMATCH");
      return { user, credentials };
    };
    const send = async (message, prepared) => {
      const { user, credentials } = prepared || (await prepare());
      const auth = deps.oauthFactory();
      auth.setCredentials(credentials);
      const writes = [];
      auth.on("tokens", (tokens) =>
        writes.push(
          deps.userStore
            .refresh(user.id, user.token_version, tokens)
            .catch(() => null),
        ),
      );
      const to = emailAddress(message.to);
      const raw = [
        "From: " + sender,
        "To: " + to,
        "Subject: =?UTF-8?B?" +
          Buffer.from(message.subject).toString("base64") +
          "?=",
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=UTF-8",
        "Content-Transfer-Encoding: base64",
        "",
        Buffer.from(message.text)
          .toString("base64")
          .match(/.{1,76}/g)
          .join("\r\n"),
      ].join("\r\n");
      const gmail = deps.gmailFactory
        ? deps.gmailFactory(auth)
        : require("googleapis").google.gmail({ version: "v1", auth });
      await gmail.users.messages.send(
        {
          userId: "me",
          requestBody: { raw: Buffer.from(raw).toString("base64url") },
        },
        { timeout: 15000, retry: false },
      );
      await Promise.all(writes);
    };
    send.prepare = prepare;
    return send;
  }
  if (!config.resendKey || !config.emailFrom) return null;
  return async (message) => {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + config.resendKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: config.emailFrom,
        to: [message.to],
        subject: message.subject,
        text: message.text,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw Error("Email delivery failed");
  };
}
async function mountPasswordAuth(app, pool, config, deps) {
  const accounts = await createAccountStore(pool),
    sendEmail = mailSender(config, deps);
  await pool.query(
    "CREATE TABLE IF NOT EXISTS pm_mail_budget (day_key text PRIMARY KEY, used integer NOT NULL)",
  );
  const pendingMail = new Set();
  const deliver = sendEmail;
  const sendBounded = deliver
    ? async (message) => {
        // Check the configured Gmail before reserving a daily send attempt.
        let prepared;
        try {
          prepared = await deliver.prepare?.();
        } catch (error) {
          const diagnostic = mailDiagnostic(error);
          console.error(`[${diagnostic.code}] ${diagnostic.message}`);
          throw diagnostic;
        }
        const day = new Date().toISOString().slice(0, 10);
        await pool.query(
          "INSERT INTO pm_mail_budget(day_key,used) VALUES($1,0) ON CONFLICT(day_key) DO NOTHING",
          [day],
        );
        const result = await pool.query(
          "UPDATE pm_mail_budget SET used=used+1 WHERE day_key=$1 AND used<50 RETURNING used",
          [day],
        );
        try {
          if (!result.rows.length) throw mailError("DAILY_LIMIT");
          await deliver(message, prepared);
        } catch (error) {
          const diagnostic = mailDiagnostic(error);
          console.error(`[${diagnostic.code}] ${diagnostic.message}`);
          throw diagnostic;
        }
      }
    : null;
  const wrap = (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res)).catch((error) =>
      error.status
        ? res
            .status(error.status)
            .json({
              error: error.message,
              ...(String(error.code || "").startsWith("AUTH_MAIL_")
                ? { code: error.code }
                : {}),
            })
        : next(error),
    );
  const origin = (req, res, next) =>
    req.get("origin") === new URL(config.baseUrl).origin
      ? next()
      : res.status(403).json({ error: "Nguồn yêu cầu không hợp lệ." });
  const limits = rateLimit({
    windowMs: 15 * 60000,
    limit: 60,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Quá nhiều yêu cầu đăng nhập. Vui lòng thử lại sau." },
  });
  const registrationLimits = rateLimit({
    windowMs: 15 * 60000,
    limit: 20,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Quá nhiều đăng ký. Vui lòng thử lại sau." },
  });
  const emailLimits = rateLimit({
    windowMs: 15 * 60000,
    limit: 5,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Đã đạt giới hạn gửi email. Vui lòng thử lại sau." },
  });
  async function checkSession(req) {
    if (!req.session.userId) return;
    const account = await accounts.get(req.session.userId);
    if (
      account &&
      (req.session.authVersion !== account.auth_version ||
        (req.session.authExpires && req.session.authExpires < Date.now()))
    ) {
      delete req.session.userId;
      delete req.session.authVersion;
    }
  }
  async function authenticate(req, id, remember) {
    await new Promise((resolve, reject) =>
      req.session.regenerate((error) => (error ? reject(error) : resolve())),
    );
    const account = await accounts.get(id);
    req.session.userId = id;
    req.session.authVersion = account?.auth_version;
    req.session.authExpires =
      Date.now() + (remember ? 30 * 86400000 : 12 * 3600000);
    req.session.cookie.maxAge = remember ? 30 * 86400000 : null;
    await new Promise((resolve, reject) =>
      req.session.save((error) => (error ? reject(error) : resolve())),
    );
  }
  async function sendAction(account, purpose) {
    const token = await accounts.issue(account.user_id, purpose);
    const link =
      new URL(config.baseUrl).origin +
      "/#/" +
      (purpose === "reset" ? "reset-password" : "verify-email") +
      "?token=" +
      token;
    await sendBounded({
      to: account.email,
      subject:
        purpose === "reset"
          ? "Đặt lại mật khẩu Poshmark Label Manager"
          : "Xác nhận email Poshmark Label Manager",
      text:
        (purpose === "reset"
          ? "Liên kết đặt lại mật khẩu có hiệu lực 30 phút."
          : "Đăng nhập bằng tài khoản vừa đăng ký rồi mở liên kết xác nhận (hiệu lực 24 giờ).") +
        "\n" +
        link +
        "\nNếu bạn không yêu cầu, hãy bỏ qua email này. Không chia sẻ liên kết hoặc mật khẩu.",
    });
  }
  app.use("/api", (req, res, next) =>
    checkSession(req)
      .then(() => next())
      .catch(next),
  );
  // Session validation must call next(), not terminate the middleware chain.
  app.get("/api/auth/options", (req, res) =>
    res.json({
      passwordAuth: true,
      emailConfigured: !!sendEmail,
      minPasswordLength: 8,
    }),
  );
  app.post(
    "/api/auth/register",
    origin,
    limits,
    registrationLimits,
    wrap(async (req, res) => {
      const email = emailAddress(req.body?.email),
        password = passwordValid(req.body?.password),
        name = String(req.body?.name || "").trim();
      if (!name || name.length > 100)
        throw fail(400, "Nhập tên hiển thị từ 1 đến 100 ký tự.");
      if (req.body?.confirmPassword !== password)
        throw fail(400, "Hai mật khẩu không khớp.");
      if (req.body?.acceptTerms !== true)
        throw fail(400, "Bạn cần đồng ý Điều khoản và Chính sách bảo mật.");
      const phone = normalizePhone(req.body?.phone);
      const id = await accounts.register(
        email,
        name,
        await hashPassword(password),
        phone,
      );
      let emailSent = false;
      if (sendEmail)
        try {
          await sendAction(await accounts.get(id), "verify");
          emailSent = true;
        } catch {}
      res.status(201).json({
        ok: true,
        emailSent,
        emailConfigured: !!sendEmail,
        emailVerified: false,
      });
    }),
  );
  app.post(
    "/api/auth/login",
    origin,
    limits,
    wrap(async (req, res) => {
      const email = emailAddress(req.body?.email);
      const password = String(req.body?.password || "");
      if (password.length > 1024)
        throw fail(400, "Thông tin đăng nhập không hợp lệ.");
      const account = await accounts.byEmail(email);
      const valid = await checkPassword(password, account?.password_hash);
      if (
        !account ||
        !valid ||
        (account.locked_until && new Date(account.locked_until) > new Date())
      ) {
        if (account) await accounts.failed(account.user_id);
        throw fail(
          401,
          "Email hoặc mật khẩu không đúng, hoặc tài khoản tạm khóa.",
        );
      }
      await accounts.success(account.user_id);
      await authenticate(req, account.user_id, req.body?.remember === true);
      res.json({ ok: true });
    }),
  );
  app.post(
    "/api/auth/forgot-password",
    origin,
    emailLimits,
    wrap(async (req, res) => {
      const email = emailAddress(req.body?.email);
      if (!sendEmail)
        throw fail(
          503,
          "Chưa cấu hình gửi email khôi phục. Vui lòng liên hệ quản trị viên.",
        );
      const account = await accounts.recipient(email);
      if (account && pendingMail.size < 10) {
        // Return independently of the mail provider's latency, for both known and unknown emails.
        const task = sendAction(account, "reset").catch(() => {});
        pendingMail.add(task);
        task.finally(() => pendingMail.delete(task));
      }
      res.json({
        ok: true,
        message:
          "Nếu email có tài khoản, hướng dẫn khôi phục sẽ được gửi. Vui lòng kiểm tra cả thư rác.",
      });
    }),
  );
  app.post(
    "/api/auth/reset-password",
    origin,
    limits,
    wrap(async (req, res) => {
      const password = passwordValid(req.body?.password);
      if (password !== req.body?.confirmPassword)
        throw fail(400, "Hai mật khẩu không khớp.");
      await accounts.consume(
        req.body?.token,
        "reset",
        await hashPassword(password),
      );
      if (req.session.userId)
        await new Promise((resolve, reject) =>
          req.session.destroy((error) => (error ? reject(error) : resolve())),
        );
      res.json({ ok: true });
    }),
  );
  app.post(
    "/api/auth/resend-verification",
    origin,
    emailLimits,
    wrap(async (req, res) => {
      if (!req.session.userId) throw fail(401, "Hãy đăng nhập trước.");
      if (!sendEmail)
        throw fail(
          503,
          "Chưa cấu hình gửi email xác nhận. Vui lòng liên hệ quản trị viên.",
        );
      const account = await accounts.get(req.session.userId);
      if (account && !account.email_verified)
        await sendAction(account, "verify");
      res.json({ ok: true });
    }),
  );
  app.post(
    "/api/auth/verify-email",
    origin,
    limits,
    wrap(async (req, res) => {
      if (!req.session.userId)
        throw fail(
          401,
          "Hãy đăng nhập đúng tài khoản đã đăng ký để xác nhận email.",
        );
      await accounts.consume(
        req.body?.token,
        "verify",
        null,
        req.session.userId,
      );
      res.json({ ok: true });
    }),
  );
  app.get(
    "/api/account",
    wrap(async (req, res) => {
      if (!req.session.userId) throw fail(401, "Hãy đăng nhập.");
      const account = await accounts.get(req.session.userId);
      res.json({
        passwordAccount: !!account,
        emailVerified: account ? account.email_verified : true,
        email: account?.email || "",
        name: account?.display_name || "",
        emailConfigured: !!sendEmail,
      });
    }),
  );
  return {
    accounts,
    authenticate,
    checkSession,
    isVerified: async (id) => {
      const account = await accounts.get(id);
      return !account || account.email_verified;
    },
  };
}
module.exports = {
  mountPasswordAuth,
  hashPassword,
  checkPassword,
  emailAddress,
  passwordValid,
  mailSender,
};
