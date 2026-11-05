const { test } = require("node:test");
const assert = require("node:assert/strict");
const { newDb, DataType } = require("pg-mem");
const session = require("express-session");
const { EventEmitter } = require("node:events");
const { createWebApp } = require("../server/web.cjs");
const secret = "test-only-not-a-real-key-12345678901234567890";
function database() {
  const db = newDb();
  const locks = new Set();
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
async function fixture(t, runOrders) {
  const pool = database();
  const { app, store } = await createWebApp(
    {
      pool,
      sessionStore: new session.MemoryStore(),
      baseUrl: "http://localhost",
      testing: true,
      clientId: "test-client",
      clientSecret: "test-secret",
      sessionSecret: secret,
      encryptionKey: secret,
    },
    { oauthFactory: provider, runOrders },
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
