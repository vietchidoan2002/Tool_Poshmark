const express = require("express");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const { Pool } = require("pg");
const helmet = require("helmet");
const { rateLimit } = require("express-rate-limit");
const crypto = require("node:crypto");
const path = require("node:path");
const { google } = require("googleapis");
const { createWebStore } = require("./web-store.cjs");
const {
  oauthDiagnostic,
  oauthFailurePage,
} = require("./oauth-diagnostics.cjs");
const {
  configurationError,
  startupDiagnostic,
} = require("./startup-diagnostics.cjs");

const asyncRoute = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
const saveSession = (req) =>
  new Promise((resolve, reject) =>
    req.session.save((e) => (e ? reject(e) : resolve())),
  );
const rotateSession = (req) =>
  new Promise((resolve, reject) =>
    req.session.regenerate((e) => (e ? reject(e) : resolve())),
  );

async function createWebApp(config, deps = {}) {
  let base;
  try {
    base = new URL(config.baseUrl);
  } catch {
    throw configurationError("CONFIG_PUBLIC_BASE_URL");
  }
  if (base.protocol !== "https:" && !config.testing)
    throw configurationError("CONFIG_PUBLIC_BASE_URL");
  if (
    base.pathname !== "/" ||
    base.search ||
    base.hash ||
    base.username ||
    base.password
  )
    throw configurationError("CONFIG_PUBLIC_BASE_URL");
  if (!config.clientId) throw configurationError("CONFIG_GOOGLE_CLIENT_ID");
  if (!config.clientSecret)
    throw configurationError("CONFIG_GOOGLE_CLIENT_SECRET");
  if (
    typeof config.sessionSecret !== "string" ||
    config.sessionSecret.length < 32
  )
    throw configurationError("CONFIG_SESSION_SECRET");
  if (
    typeof config.encryptionKey !== "string" ||
    config.encryptionKey.length < 32
  )
    throw configurationError("CONFIG_TOKEN_ENCRYPTION_KEY");
  if (config.requirePhoneReview && !String(config.adminEmails || "").trim())
    throw configurationError("CONFIG_ADMIN_EMAILS");
  const pool = config.pool;
  const store = await createWebStore(pool, config.encryptionKey);
  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
          workerSrc: ["'self'", "blob:"],
          imgSrc: ["'self'", "data:", "blob:"],
          connectSrc: ["'self'"],
          upgradeInsecureRequests: config.testing ? null : [],
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );
  // A frequent Render health probe must not wake a sleeping Neon database.
  app.get("/healthz", (req, res) => res.json({ ok: true }));
  app.get("/api/version", (req, res) => {
    res
      .set("Cache-Control", "no-store")
      .json({ version: config.version || "local" });
  });
  app.use(["/api", "/oauth2callback"], (req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  app.use(express.json({ limit: "32kb" }));
  app.use(["/api/auth/start", "/oauth2callback"], (req, res, next) => {
    req.oauthStage = "SESSION_SAVE";
    next();
  });
  app.use(
    ["/api", "/oauth2callback"],
    session({
      name: config.testing ? "pm.sid" : "__Host-pm.sid",
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      store:
        config.sessionStore ||
        new PgSession({
          pool,
          tableName: "pm_sessions",
          createTableIfMissing: true,
          pruneSessionInterval: 86400, // Avoid waking a free database every 15 minutes.
        }),
      cookie: {
        httpOnly: true,
        secure: !config.testing,
        sameSite: "lax",
        maxAge: 7 * 86400000,
        path: "/",
      },
    }),
  );
  const oauth = () =>
    deps.oauthFactory
      ? deps.oauthFactory()
      : new google.auth.OAuth2(
          config.clientId,
          config.clientSecret,
          base.origin + "/oauth2callback",
        );
  const loginLimit = rateLimit({
    windowMs: 15 * 60000,
    limit: 30,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  });
  const { mountPasswordAuth } = require("./password-auth.cjs");
  const passwordAuth = await mountPasswordAuth(app, pool, config, {
    ...deps,
    userStore: store,
    oauthFactory: oauth,
  });
  store.isVerified = passwordAuth.isVerified;
  app.get(
    "/api/session",
    asyncRoute(async (req, res) => {
      if (req.session.userId) await admin.usage.touch(req.session.userId);
      res.json({
        webMode: true,
        authenticated: !!req.session.userId,
        userId: req.session.userId || null,
        isAdmin: req.session.userId
          ? await admin.isAdmin(req.session.userId)
          : false,
        emailVerified: req.session.userId
          ? await passwordAuth.isVerified(req.session.userId)
          : false,
      });
    }),
  );
  app.get(
    "/api/auth/start",
    loginLimit,
    asyncRoute(async (req, res) => {
      req.oauthStage = "SESSION_SAVE";
      if (
        req.session.userId &&
        !(await passwordAuth.isVerified(req.session.userId))
      )
        return res
          .status(403)
          .send("Hãy xác nhận email tài khoản trước khi kết nối Google.");
      const auth = oauth();
      const { codeVerifier, codeChallenge } =
        await auth.generateCodeVerifierAsync();
      const state = crypto.randomBytes(32).toString("base64url");
      req.session.oauth = {
        userId: req.session.userId || null,
        remember: req.session.cookie.originalMaxAge !== null,
        state,
        codeVerifier,
        expires: Date.now() + 10 * 60000,
      };
      await saveSession(req);
      res.redirect(
        auth.generateAuthUrl({
          state,
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          access_type: "offline",
          prompt: "consent",
          scope: [
            "openid",
            "email",
            "https://www.googleapis.com/auth/gmail.modify",
            "https://www.googleapis.com/auth/spreadsheets",
          ],
        }),
      );
    }),
  );
  app.get(
    "/oauth2callback",
    loginLimit,
    asyncRoute(async (req, res) => {
      const pending = req.session.oauth;
      delete req.session.oauth;
      req.oauthStage = "SESSION_SAVE";
      await saveSession(req);
      if (
        !pending ||
        pending.expires < Date.now() ||
        typeof req.query.state !== "string" ||
        req.query.state !== pending.state
      )
        return res
          .status(400)
          .send(
            "Phiên đăng nhập không hợp lệ hoặc đã hết hạn. Hãy đăng nhập lại.",
          );
      if (req.query.error || typeof req.query.code !== "string")
        return res
          .status(400)
          .send("Bạn chưa cấp quyền Google. Quay lại ứng dụng để thử lại.");
      const auth = oauth();
      req.oauthStage = "TOKEN_EXCHANGE";
      const { tokens } = await auth.getToken({
        code: req.query.code,
        codeVerifier: pending.codeVerifier,
        redirect_uri: base.origin + "/oauth2callback",
      });
      req.oauthStage = "IDENTITY_VERIFY";
      if (!tokens.id_token) throw Error("Missing identity token");
      const scopes = String(tokens.scope || "").split(" ");
      if (
        ![
          "https://www.googleapis.com/auth/gmail.modify",
          "https://www.googleapis.com/auth/spreadsheets",
        ].every((scope) => scopes.includes(scope))
      )
        return res
          .status(400)
          .send("Hãy cấp đủ quyền Gmail và Google Sheets rồi kết nối lại.");
      const ticket = await auth.verifyIdToken({
        idToken: tokens.id_token,
        audience: config.clientId,
      });
      const identity = ticket.getPayload();
      if (!identity?.sub || !identity.email || !identity.email_verified)
        throw Error("Unverified Google identity");
      req.oauthStage = "ACCOUNT_SAVE";
      await passwordAuth.checkSession(req);
      if (pending.userId && req.session.userId !== pending.userId)
        return res
          .status(400)
          .send("Phiên tài khoản đã thay đổi. Hãy kết nối lại.");
      const ownerId = pending.userId || (await store.claimGoogle(identity));
      const owner = await store.get(ownerId);
      let preserveMailbox = false;
      if (!pending.userId && owner?.tokens) {
        try {
          const mailbox = store.decrypt(
            owner.tokens,
            ownerId,
          )?.pm_connected_email;
          preserveMailbox =
            mailbox && mailbox.toLowerCase() !== identity.email.toLowerCase();
        } catch {
          /* A new Google authorization can replace unreadable credentials. */
        }
      }
      if (!preserveMailbox)
        await store.connect(ownerId, owner?.email || identity.email, {
          ...tokens,
          pm_connected_email: identity.email,
        });
      const account = await passwordAuth.accounts.get(ownerId);
      if (
        account &&
        account.email.toLowerCase() === identity.email.toLowerCase()
      )
        await pool.query(
          "UPDATE pm_password_accounts SET email_verified=true WHERE user_id=$1",
          [ownerId],
        );
      req.oauthStage = "SESSION_SAVE";
      if (account) {
        await passwordAuth.authenticate(
          req,
          ownerId,
          pending.remember === true,
        );
      } else {
        await rotateSession(req);
        req.session.userId = ownerId;
        req.session.authVersion = account?.auth_version;
        req.session.accountVersion = (
          await store.get(ownerId)
        )?.session_version;
        await saveSession(req);
        await admin.usage.touch(ownerId);
      }
      res.redirect("/");
    }),
  );
  app.use("/api", (req, res, next) => {
    if (!req.session.userId)
      return res
        .status(401)
        .json({ error: "Hãy đăng nhập để sử dụng công cụ." });
    // Browser writes must come from this deployment, even with a valid cookie.
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.get("origin") !== base.origin
    )
      return res.status(403).json({ error: "Nguồn yêu cầu không hợp lệ." });
    next();
  });
  app.post(
    "/api/logout",
    asyncRoute(async (req, res) => {
      await new Promise((resolve, reject) =>
        req.session.destroy((e) => (e ? reject(e) : resolve())),
      );
      res.clearCookie(config.testing ? "pm.sid" : "__Host-pm.sid", {
        httpOnly: true,
        secure: !config.testing,
        sameSite: "lax",
        path: "/",
      });
      res.json({ ok: true });
    }),
  );
  app.use(
    "/api",
    asyncRoute(async (req, res, next) => {
      if (!(await passwordAuth.isVerified(req.session.userId)))
        return res
          .status(403)
          .json({ error: "Hãy xác nhận email trước khi sử dụng công cụ." });
      next();
    }),
  );
  const { mountPhones } = require("./phones.cjs");
  const phones = await mountPhones(app, pool, store, config);
  const { initializeIdentities } = require("./user-identity.cjs");
  Object.assign(
    store,
    await initializeIdentities(pool, store, { lockTables: !config.testing }),
  );
  const { mountAdmin } = require("./admin.cjs");
  const admin = await mountAdmin(app, pool, store, passwordAuth, config);
  app.get(
    "/api/config",
    asyncRoute(async (req, res) => {
      const user = await store.get(req.session.userId);
      res.json({ sheetId: user?.sheet_id || "" });
    }),
  );
  app.post(
    "/api/config",
    asyncRoute(async (req, res) => {
      const sheetId = String(req.body?.sheetId || "").trim();
      if (!/^[\w-]{20,}$/.test(sheetId))
        return res.status(400).json({ error: "Sheet ID chưa hợp lệ." });
      await store.setSheet(req.session.userId, sheetId);
      res.json({ ok: true, sheetId });
    }),
  );
  app.get(
    "/api/gmail/status",
    asyncRoute(async (req, res) => {
      const user = await store.get(req.session.userId);
      const tokens = user?.tokens ? store.decrypt(user.tokens, user.id) : null;
      res.json({
        credentialsPresent: true,
        accounts: tokens
          ? [
              {
                file: "personal",
                email: tokens.pm_connected_email || user.email,
                hasRefreshToken: !!tokens.refresh_token,
                expiryDate: tokens.expiry_date || null,
              },
            ]
          : [],
      });
    }),
  );
  app.post(
    "/api/gmail/delete-token",
    asyncRoute(async (req, res) => {
      if (req.body?.file !== "personal")
        return res.status(400).json({ error: "Tài khoản không hợp lệ." });
      await store.disconnect(req.session.userId);
      res.json({ ok: true });
    }),
  );
  app.post(
    "/api/get-label/run",
    asyncRoute(async (req, res) => {
      if (config.requirePhoneReview) {
        const profile = await phones.get(req.session.userId);
        if (!profile?.phone || !profile.reviewed)
          return res.status(403).json({
            error:
              "Hãy lưu số điện thoại và chờ quản trị viên kiểm tra trước khi chạy Get Label.",
          });
      }
      if (!(await passwordAuth.isVerified(req.session.userId)))
        return res
          .status(403)
          .json({ error: "Hãy xác nhận email trước khi chạy Get Label." });
      const user = await store.get(req.session.userId);
      if (!user?.sheet_id || !user.tokens)
        return res
          .status(400)
          .json({ error: "Hãy kết nối Gmail và lưu Sheet ID trước." });
      const accountName = String(req.body?.accountName || "").trim(),
        sheetName = String(req.body?.sheetName || "").trim();
      if (
        !accountName ||
        !sheetName ||
        accountName.length > 200 ||
        sheetName.length > 100 ||
        req.body?.tokenFile !== "personal"
      )
        return res.status(400).json({ error: "Thông tin chạy không hợp lệ." });
      const unlock = await store.lock(user.id, user.sheet_id);
      if (!unlock)
        return res.status(409).json({
          error:
            "Máy chủ, tài khoản hoặc bảng tính đang xử lý đơn. Vui lòng chờ.",
        });
      const logs = [];
      const refreshWrites = [];
      let runId, runStats;
      try {
        runId = await admin.usage.start(user.id, accountName);
        const auth = oauth();
        const { pm_connected_email, ...googleCredentials } = store.decrypt(
          user.tokens,
          user.id,
        );
        auth.setCredentials(googleCredentials);
        auth.on("tokens", (tokens) => {
          refreshWrites.push(
            store.refresh(user.id, user.token_version, tokens).then(
              () => true,
              () => false,
            ),
          );
        });
        const run = deps.runOrders || require("./bot.cjs").processOrders;
        const stats = await run(auth, accountName, sheetName, {
          spreadsheetId: user.sheet_id,
          log: (level, message) => logs.push(`[${level}] ${message}`),
        });
        runStats = stats;
        if ((await Promise.all(refreshWrites)).includes(false))
          throw Object.assign(Error("Token persistence failed"), {
            partialStats: stats,
          });
        await admin.usage.finish(runId, "success", stats);
        res.json({ ok: true, ...stats, output: logs.join("\n") });
      } catch (error) {
        await Promise.allSettled(refreshWrites);
        const partialStats = error.partialStats || runStats || null;
        if (runId)
          try {
            await admin.usage.finish(
              runId,
              partialStats?.writtenCount ? "partial" : "failed",
              partialStats || {},
            );
          } catch {
            console.error(
              "[USAGE_WRITE_FAILED] Could not finalize Get Label statistics.",
            );
          }
        res.status(502).json({
          ok: false,
          error:
            "Chưa hoàn tất. Có thể cần kết nối lại Google hoặc thử lại sau. Các dòng đã ghi vẫn được giữ.",
          partialStats,
          output: logs.join("\n"),
        });
      } finally {
        await unlock();
      }
    }),
  );
  app.use("/api", (req, res) =>
    res.status(404).json({ error: "Không tìm thấy API." }),
  );
  const dist = path.resolve(__dirname, "../dist");
  app.use(
    express.static(dist, {
      index: false,
      setHeaders: (res, file) => {
        res.setHeader(
          "Cache-Control",
          /[-][A-Za-z0-9_-]{8,}\./.test(file)
            ? "public, max-age=31536000, immutable"
            : "no-cache",
        );
      },
    }),
  );
  app.get("*", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.sendFile(path.join(dist, "index.html"));
  });
  app.use((error, req, res, next) => {
    if (config.testing && deps.onError) deps.onError(error);
    if (res.headersSent) return next(error);
    if (req.path === "/oauth2callback" || req.path === "/api/auth/start") {
      const diagnostic = oauthDiagnostic(error, req.oauthStage);
      // A failed explicit session save must not be retried by res.end().
      // Otherwise express-session forwards a second, raw storage error.
      req.session = null;
      console.error(
        `[${diagnostic.code}${diagnostic.databaseCode ? ":" + diagnostic.databaseCode : ""}] ${diagnostic.message}`,
      );
      return res
        .status(diagnostic.status)
        .type("html")
        .send(oauthFailurePage(diagnostic));
    }
    res
      .status(500)
      .json({ error: "Máy chủ chưa xử lý được yêu cầu. Vui lòng thử lại." });
  });
  return { app, store };
}

if (require.main === module) {
  process.env.APP_MODE = "web";
  const { databaseOptions } = require("./web-config.cjs");
  let poolOptions;
  try {
    poolOptions = databaseOptions(
      process.env.DATABASE_URL,
      process.env.PG_POOL_MAX,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }
  const pool = new Pool(poolOptions);
  pool.on("error", () =>
    console.error("Database connection lost; subsequent requests may retry."),
  );
  if (!process.env.DATABASE_URL) throw Error("DATABASE_URL required");
  const baseUrl =
    process.env.PUBLIC_BASE_URL ||
    (process.env.RENDER_EXTERNAL_HOSTNAME
      ? "https://" + process.env.RENDER_EXTERNAL_HOSTNAME
      : "");
  createWebApp({
    pool,
    baseUrl,
    adminEmails: process.env.ADMIN_EMAILS,
    requirePhoneReview: process.env.REQUIRE_REVIEWED_PHONE === "true",
    mailProvider: process.env.AUTH_MAIL_PROVIDER,
    mailSenderEmail: process.env.AUTH_MAIL_SENDER_EMAIL,
    resendKey: process.env.RESEND_API_KEY,
    emailFrom: process.env.AUTH_EMAIL_FROM,
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    sessionSecret: process.env.SESSION_SECRET,
    encryptionKey: process.env.TOKEN_ENCRYPTION_KEY,
    version: process.env.RENDER_GIT_COMMIT,
  })
    .then(({ app }) => {
      app.listen(Number(process.env.PORT) || 10000, "0.0.0.0", () =>
        console.log("Poshmark web server started"),
      );
    })
    .catch((error) => {
      console.error(startupDiagnostic(error));
      pool.end();
      process.exitCode = 1;
    });
}
module.exports = { createWebApp };
