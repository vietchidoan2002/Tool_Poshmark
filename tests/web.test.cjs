const { test } = require("node:test");
const assert = require("node:assert/strict");
const { newDb, DataType } = require("pg-mem");
const session = require("express-session");
const { EventEmitter } = require("node:events");
const { createWebApp } = require("../server/web.cjs");
async function waitForMail(messages, count) {
  const deadline = Date.now() + 2000;
  while (messages.length < count) {
    if (Date.now() > deadline)
      throw Error("Expected test email was not delivered");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
const secret = "test-only-not-a-real-key-12345678901234567890";
function database() {
  const db = newDb({ noAstCoverageCheck: true });
  const locks = new Set();
  db.public.registerOperator({
    operator: "AT TIME ZONE",
    left: DataType.timestamptz,
    right: DataType.text,
    returns: DataType.timestamp,
    implementation: (value, zone) => {
      assert.equal(zone, "Asia/Ho_Chi_Minh");
      return new Date(value.getTime() + 7 * 3600000);
    },
  });
  db.public.registerFunction({
    name: "to_timestamp",
    args: [DataType.float],
    returns: DataType.timestamp,
    implementation: (n) => new Date(n * 1000),
  });
  db.public.none(
    "CREATE TABLE pm_sessions (sid varchar PRIMARY KEY, sess json NOT NULL, expire timestamp NOT NULL)",
  );
  db.public.registerFunction({
    name: "hashtext",
    args: [DataType.text],
    returns: DataType.integer,
    implementation: (s) =>
      Array.from(s).reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 0),
  });
  db.public.registerFunction({
    name: "pg_try_advisory_lock",
    args: [DataType.integer],
    returns: DataType.bool,
    impure: true,
    implementation: (k) => {
      if (locks.has(k)) return false;
      locks.add(k);
      return true;
    },
  });
  db.public.registerFunction({
    name: "pg_advisory_unlock",
    args: [DataType.integer],
    returns: DataType.bool,
    impure: true,
    implementation: (k) => locks.delete(k),
  });
  const { Pool } = db.adapters.createPg();
  return new Pool();
}
function provider() {
  const auth = new EventEmitter();
  auth.generateCodeVerifierAsync = async () => ({
    codeVerifier: "test-verifier",
    codeChallenge: "test-challenge",
  });
  auth.generateAuthUrl = (opts) =>
    "https://accounts.google.test/?state=" + opts.state;
  auth.getToken = async ({ code, codeVerifier }) => {
    assert.equal(codeVerifier, "test-verifier");
    return {
      tokens: {
        scope:
          "https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/spreadsheets",
        id_token: code,
        refresh_token: "test-refresh-" + code,
        access_token: "test-access-" + code,
      },
    };
  };
  auth.verifyIdToken = async ({ idToken }) => ({
    getPayload: () => ({
      sub: idToken,
      email: idToken + "@example.test",
      email_verified: true,
    }),
  });
  auth.setCredentials = (tokens) => {
    auth.credentials = tokens;
  };
  return auth;
}
async function fixture(t, runOrders, options = {}) {
  const pool = database();
  const { app, store } = await createWebApp(
    {
      pool,
      sessionStore: options.sessionStore || new session.MemoryStore(),
      baseUrl: "http://localhost",
      testing: true,
      clientId: "test-client",
      clientSecret: "test-secret",
      sessionSecret: secret,
      encryptionKey: secret,
      adminEmails: options.adminEmails,
      requirePhoneReview: options.requirePhoneReview,
      mailProvider: options.mailProvider,
      mailSenderEmail: options.mailSenderEmail,
    },
    {
      oauthFactory: options.oauthFactory || provider,
      runOrders,
      ...(options.sendEmail ? { sendEmail: options.sendEmail } : {}),
      ...(options.gmailFactory ? { gmailFactory: options.gmailFactory } : {}),
    },
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = "http://127.0.0.1:" + server.address().port;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await pool.end();
  });
  function browser() {
    let cookie = "";
    return async (url, opts = {}) => {
      const response = await fetch(base + url, {
        redirect: "manual",
        ...opts,
        headers: {
          origin: "http://localhost",
          cookie,
          "content-type": "application/json",
          ...opts.headers,
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
      if (response.headers.get("set-cookie"))
        cookie = response.headers.get("set-cookie").split(";")[0];
      return response;
    };
  }
  async function login(client, id) {
    const start = await client("/api/auth/start");
    assert.equal(start.status, 302);
    const state = new URL(start.headers.get("location")).searchParams.get(
      "state",
    );
    const callback = await client(
      "/oauth2callback?state=" + state + "&code=" + id,
    );
    assert.equal(callback.status, 302);
    return callback;
  }
  return { browser, login, store, pool, app };
}

test("web APIs require login, enforce OAuth state and origin checks", async (t) => {
  const { browser, login } = await fixture(t);
  const a = browser();
  assert.equal((await a("/api/config")).status, 401);
  assert.equal((await a("/api/gmail/status")).status, 401);
  assert.equal((await a("/oauth2callback?state=wrong&code=A")).status, 400);
  await login(a, "A");
  assert.equal(
    (
      await a("/api/config", {
        method: "POST",
        headers: { origin: "https://attacker.test" },
        body: { sheetId: "a".repeat(24) },
      })
    ).status,
    403,
  );
  assert.equal(
    (await a("/api/config", { method: "POST", body: { sheetId: "short" } }))
      .status,
    400,
  );
});

test("two users have isolated Sheets and encrypted Google tokens; disconnect cannot affect another user", async (t) => {
  const { browser, login, store, pool } = await fixture(t);
  const a = browser(),
    b = browser();
  await login(a, "A");
  await login(b, "B");
  assert.equal(
    (await (await a("/api/account")).json()).email,
    "a@example.test",
  );
  assert.equal(
    (await (await b("/api/account")).json()).email,
    "b@example.test",
  );
  for (const [client, id] of [
    [a, "a".repeat(24)],
    [b, "b".repeat(24)],
  ])
    assert.equal(
      (
        await client("/api/config", {
          method: "POST",
          body: { sheetId: id, userId: "B" },
        })
      ).status,
      200,
    );
  assert.equal((await (await a("/api/config")).json()).sheetId, "a".repeat(24));
  assert.equal((await (await b("/api/config")).json()).sheetId, "b".repeat(24));
  const row = await store.get("A");
  assert.ok(!row.tokens.includes("test-refresh"));
  assert.equal(store.decrypt(row.tokens, "A").refresh_token, "test-refresh-A");
  assert.throws(() => store.decrypt(row.tokens, "B"));
  assert.equal(
    (
      await a("/api/gmail/delete-token", {
        method: "POST",
        body: { file: "token_B.json" },
      })
    ).status,
    400,
  );
  await a("/api/gmail/delete-token", {
    method: "POST",
    body: { file: "personal", userId: "B" },
  });
  assert.equal(
    (await (await a("/api/gmail/status")).json()).accounts.length,
    0,
  );
  assert.equal(
    (await (await b("/api/gmail/status")).json()).accounts[0].email,
    "B@example.test",
  );
  const previous = await store.get("B");
  await store.disconnect("B");
  await store.refresh("B", previous.token_version, {
    access_token: "test-stale",
  });
  assert.equal((await store.get("B")).tokens, null);
  await a("/api/logout", { method: "POST" });
  assert.equal((await a("/api/config")).status, 401);
  // Configuration is actually stored in the SQL table, not only in session state.
  assert.equal(
    (await pool.query("SELECT sheet_id FROM pm_users WHERE id=$1", ["A"]))
      .rows[0].sheet_id,
    "a".repeat(24),
  );
});

test("imports use only the session-owned token and sheet; parallel imports are blocked; partial failures are reported", async (t) => {
  let release, entered;
  const started = new Promise((r) => (entered = r));
  const pending = new Promise((r) => (release = r));
  const { browser, login } = await fixture(
    t,
    async (auth, accountName, sheetName, options) => {
      assert.equal(auth.credentials.refresh_token, "test-refresh-A");
      assert.equal(options.spreadsheetId, "a".repeat(24));
      options.log("INFO", "test log");
      entered();
      await pending;
      throw Object.assign(new Error("test quota"), {
        partialStats: { writtenCount: 1, skippedCount: 0 },
      });
    },
  );
  const a = browser();
  await login(a, "A");
  await a("/api/config", { method: "POST", body: { sheetId: "a".repeat(24) } });
  const body = {
    accountName: "Test",
    sheetName: "Orders",
    tokenFile: "personal",
    userId: "B",
    sheetId: "b".repeat(24),
  };
  const first = a("/api/get-label/run", { method: "POST", body });
  await started;
  assert.equal(
    (await a("/api/get-label/run", { method: "POST", body })).status,
    409,
  );
  release();
  const result = await first;
  assert.equal(result.status, 502);
  assert.deepEqual((await result.json()).partialStats, {
    writtenCount: 1,
    skippedCount: 0,
  });
});

test("scope refresh persists, identity tokens are not stored, and the database lock is released", async (t) => {
  const { store } = await fixture(t);
  await store.connect("A", "a@example.test", {
    refresh_token: "test-original",
    id_token: "test-id",
  });
  await store.connect("A", "a@example.test", { access_token: "test-new" });
  let row = await store.get("A");
  let tokens = store.decrypt(row.tokens, "A");
  assert.equal(tokens.refresh_token, "test-original");
  assert.equal(tokens.id_token, undefined);
  await store.refresh("A", row.token_version, {
    access_token: "test-refreshed",
  });
  tokens = store.decrypt((await store.get("A")).tokens, "A");
  assert.equal(tokens.access_token, "test-refreshed");
  const unlock = await store.lock("A", "sheet");
  assert.equal(await store.lock("A", "other"), null);
  assert.equal(await store.lock("B", "sheet"), null);
  await unlock();
  const again = await store.lock("B", "sheet");
  assert.ok(again);
  await again();
});

test("health probes do not wake a free database", async (t) => {
  const { pool, browser } = await fixture(t);
  let queries = 0;
  const original = pool.query.bind(pool);
  pool.query = (...args) => {
    queries++;
    return original(...args);
  };
  const client = browser();
  assert.equal((await client("/healthz")).status, 200);
  assert.equal(queries, 0);
});
test("import concurrency reserves database capacity for sessions and token writes", async (t) => {
  const { store } = await fixture(t);
  const first = await store.lock("A", "sheet-a"),
    second = await store.lock("B", "sheet-b");
  assert.ok(first);
  assert.ok(second);
  assert.equal(await store.lock("C", "sheet-c"), null);
  await first();
  const third = await store.lock("C", "sheet-c");
  assert.ok(third);
  await third();
  await second();
});

test("phone format, ownership boundaries, duplicates, admin CRUD and stale edits", async (t) => {
  const { browser, login, pool } = await fixture(t, undefined, {
    adminEmails: "A@example.test",
  });
  const admin = browser(),
    user = browser();
  await login(admin, "A");
  await login(user, "B");
  assert.equal((await user("/api/admin/phones")).status, 403);
  assert.equal((await admin("/api/profile")).status, 200);
  const invalid = await user("/api/profile/phone", {
    method: "PUT",
    body: { phone: "abc 123", version: 0 },
  });
  assert.equal(invalid.status, 400);
  let result = await user("/api/profile/phone", {
    method: "PUT",
    body: { phone: "0901 234 567", version: 0, reviewed: true, userId: "A" },
  });
  assert.equal(result.status, 200);
  let saved = await result.json();
  assert.equal(saved.phone, "+84901234567");
  assert.equal(saved.reviewed, false);
  assert.equal((await (await admin("/api/profile")).json()).phone, "");
  assert.equal(
    (
      await admin("/api/profile/phone", {
        method: "PUT",
        body: { phone: "+84901234567", version: 0 },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await user("/api/admin/phones/A", {
        method: "PUT",
        body: { phone: "0901234567", version: 0 },
      })
    ).status,
    403,
  );
  const list = await (
    await admin("/api/admin/phones?search=B%40example.test")
  ).json();
  assert.equal(list.users.length, 1);
  assert.equal(list.users[0].email, "b@example.test");
  assert.equal(list.users[0].tokens, undefined);
  assert.equal(
    (
      await admin("/api/admin/phones/B/review", {
        method: "POST",
        body: { version: saved.version },
      })
    ).status,
    400,
  );
  result = await admin("/api/admin/phones/B/review", {
    method: "POST",
    body: { version: saved.version, reviewed: true },
  });
  assert.equal(result.status, 200);
  let reviewed = await result.json();
  assert.equal(reviewed.verificationMethod, "manual");
  const same = await user("/api/profile/phone", {
    method: "PUT",
    body: { phone: "0901234567", version: reviewed.version },
  });
  assert.equal(same.status, 200);
  assert.equal((await same.json()).reviewed, true);
  assert.equal(
    (
      await user("/api/profile/phone", {
        method: "PUT",
        body: { phone: "0902345678", version: saved.version },
      })
    ).status,
    409,
  );
  result = await admin("/api/admin/phones/B", {
    method: "PUT",
    body: { phone: "0902345678", version: reviewed.version },
  });
  assert.equal(result.status, 200);
  let edited = await result.json();
  assert.equal(edited.reviewed, false);
  assert.equal(edited.phone, "+84902345678");
  result = await admin("/api/admin/phones/B", {
    method: "DELETE",
    body: { version: edited.version },
  });
  assert.equal(result.status, 200);
  assert.equal((await (await user("/api/profile")).json()).phone, "");
  const audit = (await pool.query("SELECT * FROM pm_phone_audit")).rows;
  assert.ok(audit.length >= 4);
  assert.ok(!JSON.stringify(audit).includes("+8490"));
  assert.equal((await admin("/api/admin/phones?offset=-1")).status, 400);
  assert.equal((await admin("/api/admin/phones?limit=101")).status, 400);
});

test("phone review gate is enforced on server and cannot be self-approved", async (t) => {
  let runs = 0;
  const { browser, login } = await fixture(
    t,
    async () => {
      runs++;
      return { writtenCount: 0, skippedCount: 0 };
    },
    { adminEmails: "A@example.test", requirePhoneReview: true },
  );
  const admin = browser(),
    user = browser();
  await login(admin, "A");
  await login(user, "B");
  await user("/api/config", {
    method: "POST",
    body: { sheetId: "b".repeat(24) },
  });
  const body = {
    accountName: "Test",
    sheetName: "Orders",
    tokenFile: "personal",
  };
  assert.equal(
    (await user("/api/get-label/run", { method: "POST", body })).status,
    403,
  );
  const profile = await (
    await user("/api/profile/phone", {
      method: "PUT",
      body: { phone: "0901234567", version: 0, reviewed: true },
    })
  ).json();
  assert.equal(
    (await user("/api/get-label/run", { method: "POST", body })).status,
    403,
  );
  await admin("/api/admin/phones/B/review", {
    method: "POST",
    body: { version: profile.version, reviewed: true },
  });
  assert.equal(
    (await user("/api/get-label/run", { method: "POST", body })).status,
    200,
  );
  assert.equal(runs, 1);
});

test("password registration, verification, remember session and Google linking stay separated", async (t) => {
  const messages = [];
  const { browser, login, pool } = await fixture(t, undefined, {
    adminEmails: "new@example.test",
    sendEmail: async (message) => messages.push(message),
  });
  const user = browser();
  const data = {
    name: "Người thử",
    phone: "0901 234 567",
    email: "NEW@example.test",
    password: "test-password-123",
    confirmPassword: "test-password-123",
    acceptTerms: true,
  };
  assert.equal(
    (
      await user("/api/auth/register", {
        method: "POST",
        headers: { origin: "https://bad.test" },
        body: data,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await user("/api/auth/register", {
        method: "POST",
        body: { ...data, acceptTerms: false },
      })
    ).status,
    400,
  );
  const registered = await user("/api/auth/register", {
    method: "POST",
    body: data,
  });
  assert.equal(registered.status, 201);
  assert.equal(
    (await (await user("/api/session")).json()).authenticated,
    false,
  );
  assert.equal((await user("/api/config")).status, 401);
  const loginResponse = await user("/api/auth/login", {
    method: "POST",
    body: data,
  });
  assert.equal(loginResponse.status, 200);
  assert.equal(
    loginResponse.headers.get("set-cookie").includes("Expires="),
    false,
  );
  const identity = await (await user("/api/session")).json();
  assert.ok(identity.userId.startsWith("pw:"));
  assert.equal(identity.authenticated, true);
  assert.equal(identity.emailVerified, false);
  assert.equal((await user("/api/config")).status, 403);
  assert.equal((await user("/api/gmail/status")).status, 403);
  assert.equal((await user("/api/profile")).status, 403);
  assert.equal(
    (await user("/api/get-label/run", { method: "POST", body: {} })).status,
    403,
  );
  const phoneRecord = (
    await pool.query("SELECT * FROM pm_phone_profiles WHERE user_id=$1", [
      identity.userId,
    ])
  ).rows[0];
  assert.equal(phoneRecord.phone, "+84901234567");
  assert.equal(phoneRecord.reviewed, false);
  const record = (
    await pool.query("SELECT * FROM pm_password_accounts WHERE user_id=$1", [
      identity.userId,
    ])
  ).rows[0];
  assert.ok(record.password_hash.startsWith("scrypt-v1$"));
  assert.ok(!record.password_hash.includes(data.password));
  assert.equal(record.email_verified, false);
  assert.equal((await user("/api/admin/phones")).status, 403);
  assert.equal((await user("/api/auth/start")).status, 403);
  assert.equal(messages.length, 1);
  const token = new URL(messages[0].text.split("\n")[1]).hash.split(
    "token=",
  )[1];
  const outsider = browser();
  assert.equal(
    (
      await outsider("/api/auth/verify-email", {
        method: "POST",
        body: { token },
      })
    ).status,
    401,
  );
  assert.equal(
    (await user("/api/auth/verify-email", { method: "POST", body: { token } }))
      .status,
    200,
  );
  assert.equal(
    (await user("/api/auth/verify-email", { method: "POST", body: { token } }))
      .status,
    400,
  );
  assert.equal((await user("/api/admin/phones")).status, 200);
  assert.equal((await (await user("/api/session")).json()).emailVerified, true);
  assert.equal((await user("/api/config")).status, 200);
  // Linking a different Gmail preserves the website account and its identity.
  const connected = await login(user, "ConnectedGoogle");
  assert.equal(connected.headers.get("set-cookie").includes("Expires="), false);
  assert.equal(
    (await (await user("/api/session")).json()).userId,
    identity.userId,
  );
  assert.equal(
    (await (await user("/api/gmail/status")).json()).accounts[0].email,
    "ConnectedGoogle@example.test",
  );
  await user("/api/logout", { method: "POST" });
  const wrong = await user("/api/auth/login", {
    method: "POST",
    body: { email: data.email, password: "wrong" },
  });
  assert.equal(wrong.status, 401);
  const signed = await user("/api/auth/login", {
    method: "POST",
    body: { email: data.email, password: data.password, remember: true },
  });
  assert.equal(signed.status, 200);
  assert.ok(signed.headers.get("set-cookie").includes("Expires="));
  assert.equal(
    (await user("/api/auth/register", { method: "POST", body: data })).status,
    409,
  );
});

test("forgot password is generic; reset is single-use, rejects expired tokens and invalidates old sessions", async (t) => {
  const messages = [];
  const { browser, pool } = await fixture(t, undefined, {
    sendEmail: async (message) => messages.push(message),
  });
  const a = browser(),
    b = browser();
  const details = {
    name: "Reset Test",
    phone: "0901234567",
    email: "reset@example.test",
    password: "old-password-123",
    confirmPassword: "old-password-123",
    acceptTerms: true,
  };
  await a("/api/auth/register", { method: "POST", body: details });
  await a("/api/auth/login", { method: "POST", body: details });
  await b("/api/auth/login", {
    method: "POST",
    body: { email: details.email, password: details.password, remember: true },
  });
  const unknown = await a("/api/auth/forgot-password", {
    method: "POST",
    body: { email: "missing@example.test" },
  });
  const known = await a("/api/auth/forgot-password", {
    method: "POST",
    body: { email: details.email },
  });
  assert.deepEqual(await unknown.json(), await known.json());
  await waitForMail(messages, 2);
  let token = new URL(messages.at(-1).text.split("\n")[1]).hash.split(
    "token=",
  )[1];
  const rows = (await pool.query("SELECT * FROM pm_account_actions")).rows;
  assert.ok(!JSON.stringify(rows).includes(token));
  await pool.query("UPDATE pm_account_actions SET expires_at=$1", [
    new Date(0),
  ]);
  assert.equal(
    (
      await a("/api/auth/reset-password", {
        method: "POST",
        body: {
          token,
          password: "new-password-123",
          confirmPassword: "new-password-123",
        },
      })
    ).status,
    400,
  );
  await a("/api/auth/forgot-password", {
    method: "POST",
    body: { email: details.email },
  });
  await waitForMail(messages, 3);
  token = new URL(messages.at(-1).text.split("\n")[1]).hash.split("token=")[1];
  const body = {
    token,
    password: "new-password-123",
    confirmPassword: "new-password-123",
  };
  assert.equal(
    (await a("/api/auth/reset-password", { method: "POST", body })).status,
    200,
  );
  assert.equal(
    (await a("/api/auth/reset-password", { method: "POST", body })).status,
    400,
  );
  assert.equal((await (await b("/api/session")).json()).authenticated, false);
  assert.equal(
    (
      await b("/api/auth/login", {
        method: "POST",
        body: { email: details.email, password: details.password },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await b("/api/auth/login", {
        method: "POST",
        body: { email: details.email, password: body.password },
      })
    ).status,
    200,
  );
  assert.equal((await (await b("/api/account")).json()).emailVerified, true);
});

test("password recovery reports missing mail setup honestly; passwords must meet length and match", async (t) => {
  const { browser } = await fixture(t);
  const user = browser();
  assert.equal(
    (
      await user("/api/auth/forgot-password", {
        method: "POST",
        body: { email: "a@example.test" },
      })
    ).status,
    503,
  );
  for (const patch of [
    { password: "short", confirmPassword: "short" },
    { password: "long-password", confirmPassword: "different" },
    { email: "bad<address>@example.test" },
  ]) {
    assert.equal(
      (
        await user("/api/auth/register", {
          method: "POST",
          body: {
            name: "Test",
            phone: "0901234567",
            email: "a@example.test",
            password: "test-password",
            confirmPassword: "test-password",
            acceptTerms: true,
            ...patch,
          },
        })
      ).status,
      400,
    );
  }
});

test("existing Google users can set an email password by verified recovery without losing their Google account", async (t) => {
  const messages = [];
  const { browser, login } = await fixture(t, undefined, {
    sendEmail: async (message) => messages.push(message),
  });
  const user = browser();
  await login(user, "LegacyOwner");
  await user("/api/auth/forgot-password", {
    method: "POST",
    body: { email: "legacyowner@example.test" },
  });
  await waitForMail(messages, 1);
  const token = new URL(messages.at(-1).text.split("\n")[1]).hash.split(
    "token=",
  )[1];
  const body = {
    token,
    password: "new-password-123",
    confirmPassword: "new-password-123",
  };
  assert.equal(
    (await user("/api/auth/reset-password", { method: "POST", body })).status,
    200,
  );
  assert.equal(
    (
      await user("/api/auth/login", {
        method: "POST",
        body: { email: "LEGACYOWNER@example.test", password: body.password },
      })
    ).status,
    200,
  );
  assert.equal(
    (await (await user("/api/session")).json()).userId,
    "LegacyOwner",
  );
  assert.equal(
    (await (await user("/api/gmail/status")).json()).accounts.length,
    1,
  );
});

test(
  "forgot password does not wait on provider latency or expose known accounts by delivery outcome",
  { timeout: 3000 },
  async (t) => {
    let hold = false,
      release;
    const delivery = new Promise((resolve) => (release = resolve));
    t.after(() => release());
    const { browser } = await fixture(t, undefined, {
      sendEmail: async () => {
        if (hold) await delivery;
      },
    });
    const client = browser();
    await client("/api/auth/register", {
      method: "POST",
      body: {
        name: "Test",
        phone: "0901234567",
        email: "timing@example.test",
        password: "test-password",
        confirmPassword: "test-password",
        acceptTerms: true,
      },
    });
    hold = true;
    const response = await client("/api/auth/forgot-password", {
      method: "POST",
      body: { email: "timing@example.test" },
    });
    assert.equal(response.status, 200);
    release();
  },
);

test("repeated wrong passwords lock briefly and an expired lock permits correct credentials", async (t) => {
  const { browser, pool } = await fixture(t);
  const user = browser();
  const email = "lock@example.test",
    password = "test-password-123";
  await user("/api/auth/register", {
    method: "POST",
    body: {
      name: "Lock Test",
      phone: "0901234567",
      email,
      password,
      confirmPassword: password,
      acceptTerms: true,
    },
  });
  await user("/api/logout", { method: "POST" });
  for (let i = 0; i < 10; i++)
    assert.equal(
      (
        await user("/api/auth/login", {
          method: "POST",
          body: { email, password: "wrong" },
        })
      ).status,
      401,
    );
  assert.equal(
    (
      await user("/api/auth/login", {
        method: "POST",
        body: { email, password },
      })
    ).status,
    401,
  );
  await pool.query("UPDATE pm_password_accounts SET locked_until=$1", [
    new Date(0),
  ]);
  assert.equal(
    (
      await user("/api/auth/login", {
        method: "POST",
        body: { email, password },
      })
    ).status,
    200,
  );
});

test("email budget stops further verification deliveries rather than sending without limits", async (t) => {
  let delivered = 0;
  const { browser, pool } = await fixture(t, undefined, {
    sendEmail: async () => {
      delivered++;
    },
  });
  const user = browser();
  await user("/api/auth/register", {
    method: "POST",
    body: {
      name: "Mail Test",
      phone: "0901234567",
      email: "budget@example.test",
      password: "test-password",
      confirmPassword: "test-password",
      acceptTerms: true,
    },
  });
  assert.equal(delivered, 1);
  await user("/api/auth/login", {
    method: "POST",
    body: { email: "budget@example.test", password: "test-password" },
  });
  await pool.query("UPDATE pm_mail_budget SET used=50");
  assert.equal(
    (await user("/api/auth/resend-verification", { method: "POST" })).status,
    429,
  );
  assert.equal(delivered, 1);
});

test("registration requires a valid unique phone and leaves existing accounts unchanged on rejection", async (t) => {
  const { browser, pool } = await fixture(t);
  const user = browser();
  const details = {
    name: "Phone signup",
    email: "phone@example.test",
    phone: "0901 234 567",
    password: "test-password",
    confirmPassword: "test-password",
    acceptTerms: true,
  };
  for (const phone of [
    undefined,
    "",
    "abc 123",
    "123456",
    "+999123456789",
    "0901234567 ext 1",
  ]) {
    const response = await user("/api/auth/register", {
      method: "POST",
      body: { ...details, phone },
    });
    assert.equal(response.status, 400);
  }
  assert.equal((await pool.query("SELECT * FROM pm_users")).rows.length, 0);
  assert.equal(
    (await user("/api/auth/register", { method: "POST", body: details }))
      .status,
    201,
  );
  const result = await user("/api/auth/register", {
    method: "POST",
    body: { ...details, email: "second@example.test", phone: "+84901234567" },
  });
  assert.equal(result.status, 409);
  assert.equal((await pool.query("SELECT * FROM pm_users")).rows.length, 1);
  assert.equal(
    (await pool.query("SELECT * FROM pm_password_accounts")).rows.length,
    1,
  );
  assert.equal(
    (await pool.query("SELECT * FROM pm_phone_profiles")).rows.length,
    1,
  );
  assert.equal(
    (await (await user("/api/session")).json()).authenticated,
    false,
  );
});

test("mail delivery failure never reports activation or logs a new account in", async (t) => {
  const { browser } = await fixture(t, undefined, {
    sendEmail: async () => {
      throw Error("test delivery unavailable");
    },
  });
  const user = browser();
  const details = {
    name: "Mail signup",
    email: "delivery@example.test",
    phone: "0901234567",
    password: "test-password",
    confirmPassword: "test-password",
    acceptTerms: true,
  };
  const registered = await user("/api/auth/register", {
    method: "POST",
    body: details,
  });
  assert.equal(registered.status, 201);
  assert.deepEqual(await registered.json(), {
    ok: true,
    emailSent: false,
    emailConfigured: true,
    emailVerified: false,
  });
  assert.equal(
    (await (await user("/api/session")).json()).authenticated,
    false,
  );
  await user("/api/auth/login", { method: "POST", body: details });
  assert.equal(
    (await (await user("/api/account")).json()).emailVerified,
    false,
  );
  assert.equal((await user("/api/config")).status, 403);
  assert.equal((await user("/api/logout", { method: "POST" })).status, 200);
});

test("admin Gmail bootstrap reuses one account and revokes an unverified pre-registration password", async (t) => {
  const diagnostics = [];
  t.mock.method(console, "error", (message) => diagnostics.push(message));
  const messages = [];
  const { browser, login, pool } = await fixture(t, undefined, {
    adminEmails: "Admin@example.test",
    mailProvider: "gmail",
    mailSenderEmail: "Admin@example.test",
    gmailFactory: () => ({
      users: { messages: { send: async (request) => messages.push(request) } },
    }),
  });
  const user = browser();
  const details = {
    name: "Admin signup",
    email: "Admin@example.test",
    phone: "0901234567",
    password: "test-password",
    confirmPassword: "test-password",
    acceptTerms: true,
  };
  const signup = await user("/api/auth/register", {
    method: "POST",
    body: details,
  });
  assert.equal(signup.status, 201);
  assert.equal((await signup.json()).emailSent, false);
  assert.equal(messages.length, 0);
  await user("/api/auth/login", { method: "POST", body: details });
  const passwordId = (await (await user("/api/session")).json()).userId;
  const failed = await user("/api/auth/resend-verification", {
    method: "POST",
  });
  assert.equal(failed.status, 503);
  const error = await failed.json();
  assert.equal(error.code, "AUTH_MAIL_SENDER_NOT_CONNECTED");
  assert.match(error.error, /Tiếp tục với Google/);
  assert.equal(
    (await pool.query("SELECT * FROM pm_mail_budget")).rows.length,
    0,
    "missing sender must not consume the daily mail allowance",
  );
  assert.ok(
    diagnostics.every((line) =>
      line.startsWith("[AUTH_MAIL_SENDER_NOT_CONNECTED]"),
    ),
  );
  assert.equal((await user("/api/admin/phones")).status, 403);
  await user("/api/logout", { method: "POST" });
  await login(user, "Admin");
  assert.equal((await (await user("/api/session")).json()).userId, passwordId);
  assert.equal(
    (await (await user("/api/account")).json()).needsPasswordSetup,
    true,
  );
  assert.equal((await pool.query("SELECT * FROM pm_users")).rows.length, 1);
  await user("/api/logout", { method: "POST" });
  assert.equal(
    (await user("/api/auth/login", { method: "POST", body: details })).status,
    401,
    "the unverified password must not gain access to the Google owner's account",
  );
  assert.equal(
    (
      await user("/api/auth/forgot-password", {
        method: "POST",
        body: { email: details.email },
      })
    ).status,
    200,
  );
  await waitForMail(messages, 1);
  const raw = Buffer.from(messages[0].requestBody.raw, "base64url").toString();
  const text = Buffer.from(
    raw.split("\r\n\r\n")[1].replace(/\r\n/g, ""),
    "base64",
  ).toString();
  const token = new URL(text.split("\n")[1]).hash.split("token=")[1];
  assert.equal(
    (
      await user("/api/auth/reset-password", {
        method: "POST",
        body: {
          token,
          password: "new-trusted-password",
          confirmPassword: "new-trusted-password",
        },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await user("/api/auth/login", {
        method: "POST",
        body: { email: details.email, password: "new-trusted-password" },
      })
    ).status,
    200,
  );
  const identity = await (await user("/api/session")).json();
  assert.equal(identity.userId, passwordId);
  assert.equal(identity.emailVerified, true);
});

test("OAuth callback explains failures at each stage without exposing codes, secrets or database details", async (t) => {
  const logs = [];
  t.mock.method(console, "error", (message) => logs.push(message));
  const privateValue = "fake-private-code-secret-db-password";
  for (const scenario of ["client", "identity", "database", "session"]) {
    const memory = new session.MemoryStore();
    const save = memory.set;
    if (scenario === "session")
      memory.set = function (id, data, done) {
        if (data.userId)
          return done(
            Object.assign(new Error(privateValue), { code: "53300" }),
          );
        return save.call(this, id, data, done);
      };
    const { browser, store } = await fixture(t, undefined, {
      sessionStore: memory,
      oauthFactory: () => {
        const auth = provider();
        if (scenario === "client")
          auth.getToken = async () => {
            throw Object.assign(new Error(privateValue), {
              response: {
                data: {
                  error: "invalid_client",
                  error_description: privateValue,
                },
              },
            });
          };
        if (scenario === "identity")
          auth.verifyIdToken = async () => {
            throw Error(privateValue);
          };
        return auth;
      },
    });
    if (scenario === "database")
      store.connect = async () => {
        throw Object.assign(new Error(privateValue), {
          code: "42501",
          detail: privateValue,
        });
      };
    const user = browser();
    const start = await user("/api/auth/start");
    const state = new URL(start.headers.get("location")).searchParams.get(
      "state",
    );
    const callback = await user(
      "/oauth2callback?state=" + state + "&code=" + privateValue,
    );
    const body = await callback.text();
    const expected = {
      client: "OAUTH_CLIENT_CONFIG",
      identity: "OAUTH_IDENTITY_VERIFY",
      database: "OAUTH_ACCOUNT_SAVE:42501",
      session: "OAUTH_SESSION_SAVE:53300",
    }[scenario];
    assert.equal(callback.status, scenario === "identity" ? 502 : 503);
    assert.match(callback.headers.get("content-type"), /text\/html/);
    assert.ok(body.includes(expected));
    assert.ok(body.includes("Quay lại đăng nhập"));
    assert.ok(!body.includes(privateValue));
    assert.equal(
      (await (await user("/api/session")).json()).authenticated,
      false,
    );
  }
  assert.equal(logs.length, 4, JSON.stringify(logs.map(String)));
  assert.ok(
    logs.every(
      (line) => line.startsWith("[OAUTH_") && !line.includes(privateValue),
    ),
  );
});

test("password recovery reports a disconnected sender before acknowledging known or unknown addresses", async (t) => {
  t.mock.method(console, "error", () => {});
  const { browser, pool } = await fixture(t, undefined, {
    adminEmails: "Sender@example.test",
    mailProvider: "gmail",
    mailSenderEmail: "Sender@example.test",
  });
  const user = browser();
  await user("/api/auth/register", {
    method: "POST",
    body: {
      name: "Recovery User",
      email: "recovery@example.test",
      phone: "0901234567",
      password: "test-password",
      confirmPassword: "test-password",
      acceptTerms: true,
    },
  });
  const responses = [];
  for (const email of ["recovery@example.test", "missing@example.test"]) {
    const result = await user("/api/auth/forgot-password", {
      method: "POST",
      body: { email },
    });
    assert.equal(result.status, 503);
    responses.push(await result.json());
  }
  assert.deepEqual(responses[0], responses[1]);
  assert.equal(responses[0].code, "AUTH_MAIL_SENDER_NOT_CONNECTED");
  assert.match(responses[0].error, /Tiếp tục với Google/);
  assert.equal(
    (await pool.query("SELECT * FROM pm_account_actions WHERE purpose='reset'"))
      .rows.length,
    0,
  );
  assert.equal(
    (await pool.query("SELECT * FROM pm_mail_budget")).rows.length,
    0,
  );
});

test("password recovery reports the daily sender limit identically for known and unknown addresses", async (t) => {
  let delivered = 0;
  const { browser, pool } = await fixture(t, undefined, {
    sendEmail: async () => {
      delivered++;
    },
  });
  const user = browser();
  await user("/api/auth/register", {
    method: "POST",
    body: {
      name: "Recovery User",
      email: "recovery@example.test",
      phone: "0901234567",
      password: "test-password",
      confirmPassword: "test-password",
      acceptTerms: true,
    },
  });
  await pool.query("UPDATE pm_mail_budget SET used=50");
  const responses = [];
  for (const email of ["recovery@example.test", "missing@example.test"]) {
    const result = await user("/api/auth/forgot-password", {
      method: "POST",
      body: { email },
    });
    assert.equal(result.status, 429);
    responses.push(await result.json());
  }
  assert.deepEqual(responses[0], responses[1]);
  assert.equal(responses[0].code, "AUTH_MAIL_DAILY_LIMIT");
  assert.equal(delivered, 1);
  assert.equal(
    (await pool.query("SELECT * FROM pm_account_actions WHERE purpose='reset'"))
      .rows.length,
    0,
  );
});

test("password recovery reports a busy mail queue instead of silently dropping requests", async (t) => {
  let hold = false,
    release;
  const delivery = new Promise((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  const { browser } = await fixture(t, undefined, {
    sendEmail: async () => {
      if (hold) await delivery;
    },
  });
  const user = browser();
  await user("/api/auth/register", {
    method: "POST",
    body: {
      name: "Recovery User",
      email: "recovery@example.test",
      phone: "0901234567",
      password: "test-password",
      confirmPassword: "test-password",
      acceptTerms: true,
    },
  });
  hold = true;
  for (let i = 0; i < 10; i++) {
    const result = await user("/api/auth/forgot-password", {
      method: "POST",
      headers: { "x-forwarded-for": "198.51.100." + (i + 1) },
      body: { email: "recovery@example.test" },
    });
    assert.equal(result.status, 200);
  }
  for (const email of ["recovery@example.test", "missing@example.test"]) {
    const result = await user("/api/auth/forgot-password", {
      method: "POST",
      headers: { "x-forwarded-for": "198.51.100.100" },
      body: { email },
    });
    assert.equal(result.status, 429);
    assert.match((await result.json()).error, /đang xử lý nhiều email/);
  }
  release();
});

test("Google and a verified password sign in to one email account without losing its phone or Sheet", async (t) => {
  const messages = [];
  const { browser, login, pool } = await fixture(t, undefined, {
    sendEmail: async (message) => messages.push(message),
  });
  const user = browser();
  const details = {
    name: "Verified user",
    email: "Verified@example.test",
    phone: "0901234567",
    password: "trusted-password",
    confirmPassword: "trusted-password",
    acceptTerms: true,
  };
  await user("/api/auth/register", { method: "POST", body: details });
  await user("/api/auth/login", { method: "POST", body: details });
  const original = (await (await user("/api/session")).json()).userId;
  const token = new URL(messages[0].text.split("\n")[1]).hash.split(
    "token=",
  )[1];
  await user("/api/auth/verify-email", { method: "POST", body: { token } });
  await user("/api/config", {
    method: "POST",
    body: { sheetId: "saved-sheet-id-12345678901234" },
  });
  await user("/api/logout", { method: "POST" });
  await login(user, "Verified");
  assert.equal((await (await user("/api/session")).json()).userId, original);
  assert.equal(
    (await (await user("/api/profile")).json()).phone,
    "+84901234567",
  );
  assert.equal(
    (await (await user("/api/config")).json()).sheetId,
    "saved-sheet-id-12345678901234",
  );
  assert.equal(
    (await (await user("/api/account")).json()).needsPasswordSetup,
    false,
  );
  assert.equal((await pool.query("SELECT * FROM pm_users")).rows.length, 1);
  await user("/api/logout", { method: "POST" });
  assert.equal(
    (await user("/api/auth/login", { method: "POST", body: details })).status,
    200,
  );
  assert.equal(
    (
      await user("/api/auth/register", {
        method: "POST",
        body: { ...details, email: "VERIFIED@example.test" },
      })
    ).status,
    409,
  );
});

test("Google claiming an unverified email revokes the old password, active sessions and pending links", async (t) => {
  const messages = [];
  const { browser, login, pool } = await fixture(t, undefined, {
    sendEmail: async (message) => messages.push(message),
  });
  const attacker = browser(),
    owner = browser();
  const details = {
    name: "Unverified signup",
    email: "Victim@example.test",
    phone: "0901234567",
    password: "untrusted-password",
    confirmPassword: "untrusted-password",
    acceptTerms: true,
  };
  await attacker("/api/auth/register", { method: "POST", body: details });
  await attacker("/api/auth/login", { method: "POST", body: details });
  const original = (await (await attacker("/api/session")).json()).userId;
  const oldToken = new URL(messages[0].text.split("\n")[1]).hash.split(
    "token=",
  )[1];
  await login(owner, "Victim");
  assert.equal((await (await owner("/api/session")).json()).userId, original);
  assert.equal(
    (await (await attacker("/api/session")).json()).authenticated,
    false,
  );
  assert.equal(
    (await attacker("/api/auth/login", { method: "POST", body: details }))
      .status,
    401,
  );
  assert.equal(
    (
      await owner("/api/auth/verify-email", {
        method: "POST",
        body: { token: oldToken },
      })
    ).status,
    400,
  );
  assert.equal(
    (await (await owner("/api/account")).json()).needsPasswordSetup,
    true,
  );
  assert.equal((await pool.query("SELECT * FROM pm_users")).rows.length, 1);
});

test("connecting another mailbox does not turn that mailbox's Google login into the website owner", async (t) => {
  const { browser, login, pool } = await fixture(t);
  const owner = browser(),
    other = browser();
  await login(owner, "Owner");
  await login(owner, "Mailbox");
  assert.equal((await (await owner("/api/session")).json()).userId, "Owner");
  await login(other, "Mailbox");
  assert.equal((await (await other("/api/session")).json()).userId, "Mailbox");
  assert.equal(
    (await (await other("/api/account")).json()).email,
    "mailbox@example.test",
  );
  assert.equal((await pool.query("SELECT * FROM pm_users")).rows.length, 2);
  await owner("/api/logout", { method: "POST" });
  await login(owner, "Owner");
  assert.equal(
    (await (await owner("/api/gmail/status")).json()).accounts[0].email,
    "Mailbox@example.test",
    "sign-in alone must preserve the selected processing mailbox",
  );
});

test("legacy Google and password sessions must sign in again after their duplicate records merge", async (t) => {
  const { browser, login, pool, store } = await fixture(t);
  const googleSession = browser(),
    passwordSession = browser();
  await login(googleSession, "Old");
  await pool.query("DROP INDEX pm_users_email_unique");
  await pool.query(
    "INSERT INTO pm_users(id,email) VALUES('pw:old','old@example.test')",
  );
  const { hashPassword } = require("../server/password-auth.cjs");
  const hash = await hashPassword("existing-password");
  await pool.query(
    "INSERT INTO pm_password_accounts(user_id,email,display_name,password_hash,email_verified,terms_version) VALUES('pw:old','old@example.test','Old',$1,true,'test')",
    [hash],
  );
  await passwordSession("/api/auth/login", {
    method: "POST",
    body: { email: "old@example.test", password: "existing-password" },
  });
  assert.equal(
    (await (await passwordSession("/api/session")).json()).authenticated,
    true,
  );
  const { initializeIdentities } = require("../server/user-identity.cjs");
  await initializeIdentities(pool, store, { lockTables: false });
  assert.equal(
    (await (await googleSession("/api/session")).json()).authenticated,
    false,
  );
  assert.equal(
    (await (await passwordSession("/api/session")).json()).authenticated,
    false,
  );
  await login(googleSession, "Old");
  assert.equal(
    (await (await googleSession("/api/session")).json()).userId,
    "pw:old",
  );
  assert.equal((await (await googleSession("/api/profile")).json()).phone, "");
  assert.equal((await pool.query("SELECT * FROM pm_users")).rows.length, 1);
});

test("dashboard is admin-only, never exposes credentials and protects administrator accounts", async (t) => {
  const { browser, login } = await fixture(t, undefined, {
    adminEmails: "Admin@example.test",
  });
  const guest = browser(),
    member = browser(),
    admin = browser();
  assert.equal((await guest("/api/admin/dashboard")).status, 401);
  await login(member, "Member");
  for (const path of ["/api/admin/dashboard", "/api/admin/users"])
    assert.equal((await member(path)).status, 403);
  assert.equal(
    (
      await member("/api/admin/users", {
        method: "POST",
        body: { role: "admin", email: "x@example.test" },
      })
    ).status,
    403,
  );
  await login(admin, "Admin");
  assert.equal((await (await admin("/api/session")).json()).isAdmin, true);
  const summary = await admin("/api/admin/dashboard");
  assert.equal(summary.status, 200);
  const list = await (await admin("/api/admin/users")).json();
  assert.equal(list.users.length, 2);
  assert.ok(
    !JSON.stringify(list).match(
      /password_hash|refresh_token|access_token|test-refresh|test-secret/,
    ),
  );
  const owner = list.users.find((user) => user.isAdmin);
  assert.equal(
    (
      await admin("/api/admin/users/" + owner.id, {
        method: "DELETE",
        body: { version: owner.version },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await admin("/api/admin/users/" + owner.id, {
        method: "PUT",
        body: {
          version: owner.version,
          phoneVersion: owner.phoneVersion,
          name: "Admin",
          phone: "",
          status: "suspended",
        },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await admin("/api/admin/users", {
        method: "POST",
        body: {
          name: "Other Admin",
          email: "admin@example.test",
          phone: "0901234567",
        },
      })
    ).status,
    403,
  );
  assert.equal((await admin("/api/admin/dashboard?days=1000")).status, 400);
});

test("admin account create/edit/suspend/delete/restore handles duplicates, sessions and stale phone edits", async (t) => {
  const { browser, login, pool } = await fixture(t, undefined, {
    adminEmails: "Admin@example.test",
  });
  const admin = browser(),
    member = browser(),
    oldSession = browser();
  await login(admin, "Admin");
  let response = await admin("/api/admin/users", {
    method: "POST",
    body: {
      name: "New user",
      email: "NEW@example.test",
      phone: "0901234567",
      sendInvite: false,
    },
  });
  assert.equal(response.status, 201);
  let user = (await response.json()).user;
  const id = user.id;
  assert.equal(user.email, "new@example.test");
  assert.equal(user.emailVerified, false);
  assert.equal(user.orders, 0);
  assert.equal(
    (
      await admin("/api/admin/users", {
        method: "POST",
        body: {
          name: "Duplicate",
          email: "NEW@example.test",
          phone: "0902345678",
        },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await admin("/api/admin/users", {
        method: "POST",
        body: { name: "Invalid", email: "invalid@example.test", phone: "123" },
      })
    ).status,
    400,
  );
  await login(member, "New");
  await login(oldSession, "New");
  const memberProfile = await (await member("/api/profile")).json();
  await member("/api/profile/phone", {
    method: "PUT",
    body: { phone: "0902345678", version: memberProfile.version },
  });
  response = await admin("/api/admin/users/" + id, {
    method: "PUT",
    body: {
      name: "Changed",
      email: user.email,
      phone: user.phone,
      status: "active",
      version: user.version,
      phoneVersion: user.phoneVersion,
    },
  });
  assert.equal(response.status, 409);
  user = (await (await admin("/api/admin/users/" + id)).json()).user;
  response = await admin("/api/admin/users/" + id, {
    method: "PUT",
    body: {
      name: "Updated",
      email: user.email,
      phone: user.phone,
      status: "suspended",
      version: user.version,
      phoneVersion: user.phoneVersion,
    },
  });
  assert.equal(response.status, 200);
  user = (await response.json()).user;
  assert.equal(
    (await (await member("/api/session")).json()).authenticated,
    false,
  );
  const start = await member("/api/auth/start");
  const state = new URL(start.headers.get("location")).searchParams.get(
    "state",
  );
  const denied = await member("/oauth2callback?state=" + state + "&code=New");
  assert.equal(denied.status, 403);
  assert.match(await denied.text(), /OAUTH_ACCOUNT_DISABLED/);
  response = await admin("/api/admin/users/" + id, {
    method: "PUT",
    body: {
      name: "Updated",
      email: user.email,
      phone: user.phone,
      status: "active",
      version: user.version,
      phoneVersion: user.phoneVersion,
    },
  });
  user = (await response.json()).user;
  assert.equal(
    (await (await oldSession("/api/session")).json()).authenticated,
    false,
    "unblocking does not revive old sessions",
  );
  assert.equal(
    (
      await admin("/api/admin/users/" + id, {
        method: "PUT",
        body: {
          name: "Other",
          email: "changed@example.test",
          phone: user.phone,
          status: "active",
          version: user.version,
          phoneVersion: user.phoneVersion,
        },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await admin("/api/admin/users/" + id, {
        method: "DELETE",
        body: { version: user.version - 1 },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await admin("/api/admin/users/" + id, {
        method: "DELETE",
        body: { version: user.version },
      })
    ).status,
    200,
  );
  assert.equal(
    (await (await admin("/api/admin/users")).json()).users.length,
    1,
  );
  const deleted = (
    await (await admin("/api/admin/users?status=deleted")).json()
  ).users[0];
  assert.equal(deleted.status, "deleted");
  assert.equal(deleted.gmailCount, 0);
  assert.equal(deleted.phone, "");
  assert.equal(
    (await admin("/api/admin/users/" + id + "/invite", { method: "POST" }))
      .status,
    409,
  );
  response = await admin("/api/admin/users/" + id + "/restore", {
    method: "POST",
    body: { version: deleted.version },
  });
  assert.equal(response.status, 200);
  await login(member, "New");
  assert.equal((await (await member("/api/session")).json()).userId, id);
  const audit = (
    await pool.query("SELECT action FROM pm_admin_audit")
  ).rows.map((row) => row.action);
  assert.deepEqual(audit, ["create", "update", "update", "delete", "restore"]);
});

test("dashboard records real Get Label counts including partial writes and counts distinct account names", async (t) => {
  let calls = 0;
  const { browser, login, pool } = await fixture(
    t,
    async () => {
      calls++;
      if (calls === 3)
        throw Object.assign(Error("test partial failure"), {
          partialStats: {
            writtenCount: 3,
            writtenOrderCount: 1,
            skippedCount: 2,
          },
        });
      return { writtenCount: 4, writtenOrderCount: 2, skippedCount: 1 };
    },
    { adminEmails: "Admin@example.test" },
  );
  const admin = browser(),
    member = browser();
  await login(admin, "Admin");
  await login(member, "Member");
  await member("/api/config", {
    method: "POST",
    body: { sheetId: "a".repeat(24) },
  });
  assert.equal(
    (
      await member("/api/get-label/run", {
        method: "POST",
        body: { accountName: "Bad", sheetName: "Orders", tokenFile: "wrong" },
      })
    ).status,
    400,
  );
  assert.equal((await pool.query("SELECT * FROM pm_get_runs")).rows.length, 0);
  for (const accountName of ["Shop One", "shop one", "Shop Two"])
    await member("/api/get-label/run", {
      method: "POST",
      body: { accountName, sheetName: "Orders", tokenFile: "personal" },
    });
  const response = await admin("/api/admin/dashboard?days=30");
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.usage.orders, 5);
  assert.equal(data.usage.skipped, 4);
  assert.equal(data.usage.getRuns, 3);
  assert.equal(data.usage.successful, 2);
  assert.equal(data.usage.failed, 1);
  assert.equal(
    data.trend.reduce((sum, row) => sum + row.orders, 0),
    5,
  );
  assert.ok(data.trackingSince);
  const members = (await (await admin("/api/admin/users?search=member")).json())
    .users;
  assert.equal(members.length, 1);
  assert.equal(members[0].orders, 5);
  assert.equal(members[0].poshmarkCount, 2);
  assert.equal(members[0].gmailCount, 1);
  const details = await (
    await admin("/api/admin/users/" + members[0].id)
  ).json();
  assert.equal(details.accounts.length, 2);
  assert.equal(details.runs.length, 3);
  assert.ok(
    details.runs.some((run) => run.status === "partial" && run.orders === 1),
  );
  assert.equal(
    (
      await admin("/api/admin/users/" + members[0].id, {
        method: "DELETE",
        body: { version: members[0].version },
      })
    ).status,
    200,
  );
  assert.equal(
    (await (await admin("/api/admin/dashboard")).json()).usage.orders,
    5,
    "deleting a user preserves historical order totals",
  );
});

test("admin changes wait for an in-progress import instead of disabling an account mid-write", async (t) => {
  let release, entered;
  const wait = new Promise((resolve) => (release = resolve)),
    started = new Promise((resolve) => (entered = resolve));
  t.after(() => release());
  const { browser, login } = await fixture(
    t,
    async () => {
      entered();
      await wait;
      return { writtenCount: 3, skippedCount: 0 };
    },
    { adminEmails: "Admin@example.test" },
  );
  const admin = browser(),
    member = browser();
  await login(admin, "Admin");
  await login(member, "Member");
  await member("/api/config", {
    method: "POST",
    body: { sheetId: "b".repeat(24) },
  });
  const running = member("/api/get-label/run", {
    method: "POST",
    body: { accountName: "Shop", sheetName: "Orders", tokenFile: "personal" },
  });
  await started;
  const user = (await (await admin("/api/admin/users?search=member")).json())
    .users[0];
  assert.equal(
    (
      await admin("/api/admin/users/" + user.id, {
        method: "DELETE",
        body: { version: user.version },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await admin("/api/admin/users/" + user.id, {
        method: "PUT",
        body: {
          name: "Member",
          phone: "",
          status: "suspended",
          version: user.version,
          phoneVersion: user.phoneVersion,
        },
      })
    ).status,
    409,
  );
  release();
  assert.equal((await running).status, 200);
  assert.equal(
    (await (await admin("/api/admin/dashboard")).json()).usage.orders,
    3,
  );
});

test("admin-created account survives invite failure and initial access requires email ownership", async (t) => {
  t.mock.method(console, "error", () => {});
  const { browser, login, pool } = await fixture(t, undefined, {
    adminEmails: "Admin@example.test",
    sendEmail: async () => {
      throw Error("fake-private-provider-error");
    },
  });
  const admin = browser();
  await login(admin, "Admin");
  const result = await admin("/api/admin/users", {
    method: "POST",
    body: {
      name: "Invited",
      email: "invited@example.test",
      phone: "0901234567",
      sendInvite: true,
    },
  });
  assert.equal(result.status, 201);
  const body = await result.json();
  assert.equal(body.mailSent, false);
  assert.ok(body.mailError);
  assert.ok(!JSON.stringify(body).includes("fake-private-provider-error"));
  assert.equal(
    (
      await pool.query(
        "SELECT * FROM pm_users WHERE email='invited@example.test'",
      )
    ).rows.length,
    1,
  );
  const account = (
    await pool.query("SELECT * FROM pm_password_accounts WHERE user_id=$1", [
      body.user.id,
    ])
  ).rows[0];
  assert.equal(account.terms_version, "admin-created");
  assert.equal(account.email_verified, false);
});
