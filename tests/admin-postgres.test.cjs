const { test } = require("node:test");
const assert = require("node:assert/strict");
const session = require("express-session");
const { EventEmitter } = require("node:events");

test(
  "PostgreSQL dashboard uses real aggregates and atomically rolls back interrupted account edits",
  { skip: !process.env.IDENTITY_PG_MODULE },
  async (t) => {
    const { PGlite } = require(process.env.IDENTITY_PG_MODULE);
    const { createWebApp } = require("../server/web.cjs");
    const pg = new PGlite();
    await pg.query("SET TIME ZONE 'America/New_York'");
    t.after(() => pg.close());
    let interrupt = false;
    const query = async (sql, args) => {
      if (
        interrupt &&
        sql.startsWith("UPDATE pm_password_accounts SET display_name")
      )
        throw Error("test interrupted edit");
      return pg.query(sql, args);
    };
    const pool = {
      options: { max: 4 },
      query,
      connect: async () => ({ query, release() {} }),
    };
    await pool.query(
      "CREATE TABLE pm_users(id text PRIMARY KEY,email text NOT NULL,tokens text,sheet_id text NOT NULL DEFAULT '',token_version integer NOT NULL DEFAULT 0)",
    );
    await pool.query(
      "INSERT INTO pm_users(id,email) VALUES('Legacy','legacy@example.test')",
    );
    const provider = () => {
      const auth = new EventEmitter();
      auth.generateCodeVerifierAsync = async () => ({
        codeVerifier: "test",
        codeChallenge: "test",
      });
      auth.generateAuthUrl = ({ state }) =>
        "https://accounts.google.test/?state=" + state;
      auth.getToken = async ({ code }) => ({
        tokens: {
          id_token: code,
          scope:
            "https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/spreadsheets",
          refresh_token: "fake-refresh",
        },
      });
      auth.verifyIdToken = async ({ idToken }) => ({
        getPayload: () => ({
          sub: idToken,
          email: idToken.toLowerCase() + "@example.test",
          email_verified: true,
        }),
      });
      auth.setCredentials = () => {};
      return auth;
    };
    const secret = "postgres-dashboard-test-only-key-123456789012345";
    const { app } = await createWebApp(
      {
        pool,
        testing: true,
        sessionStore: new session.MemoryStore(),
        baseUrl: "http://localhost",
        clientId: "test",
        clientSecret: "test",
        sessionSecret: secret,
        encryptionKey: secret,
        adminEmails: "admin@example.test",
      },
      {
        oauthFactory: provider,
        runOrders: async () => ({ writtenCount: 2, skippedCount: 1 }),
      },
    );
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    const base = "http://127.0.0.1:" + server.address().port;
    function client() {
      let cookie = "";
      return async (path, method = "GET", body) => {
        const response = await fetch(base + path, {
          method,
          redirect: "manual",
          headers: {
            origin: "http://localhost",
            cookie,
            "content-type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (response.headers.get("set-cookie"))
          cookie = response.headers.get("set-cookie").split(";")[0];
        return response;
      };
    }
    async function login(client, id) {
      const start = await client("/api/auth/start");
      const state = new URL(start.headers.get("location")).searchParams.get(
        "state",
      );
      const response = await client(
        "/oauth2callback?state=" + state + "&code=" + id,
      );
      assert.equal(response.status, 302);
    }
    const admin = client(),
      member = client();
    await login(admin, "Admin");
    let response = await admin("/api/admin/users", "POST", {
      name: "New user",
      email: "new@example.test",
      phone: "0901234567",
      sendInvite: false,
    });
    assert.equal(response.status, 201);
    let user = (await response.json()).user;
    await login(member, "New");
    await member("/api/config", "POST", { sheetId: "z".repeat(24) });
    assert.equal(
      (
        await member("/api/get-label/run", "POST", {
          accountName: "Shop",
          sheetName: "Orders",
          tokenFile: "personal",
        })
      ).status,
      200,
    );
    const summary = await (await admin("/api/admin/dashboard?days=30")).json();
    assert.equal(summary.users.unknownCreated, 1);
    assert.equal(summary.usage.orders, 2);
    assert.equal(summary.trend[0].orders, 2);
    assert.equal(
      summary.trend[0].day,
      new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10),
    );
    assert.equal(
      (await (await admin("/api/admin/users/" + user.id)).json()).accounts[0]
        .orders,
      2,
    );
    interrupt = true;
    response = await admin("/api/admin/users/" + user.id, "PUT", {
      name: "Do not save",
      phone: user.phone,
      status: "suspended",
      version: user.version,
      phoneVersion: user.phoneVersion,
    });
    assert.equal(response.status, 500);
    interrupt = false;
    const unchanged = (
      await (await admin("/api/admin/users/" + user.id)).json()
    ).user;
    assert.equal(unchanged.name, "New user");
    assert.equal(unchanged.status, "active");
    assert.equal(unchanged.version, user.version);
    response = await admin("/api/admin/users/" + user.id, "PUT", {
      name: "Saved",
      phone: user.phone,
      status: "suspended",
      version: user.version,
      phoneVersion: user.phoneVersion,
    });
    assert.equal(response.status, 200);
    user = (await response.json()).user;
    assert.equal(
      (await (await member("/api/session")).json()).authenticated,
      false,
    );
    assert.equal(
      (
        await admin("/api/admin/users/" + user.id, "DELETE", {
          version: user.version,
        })
      ).status,
      200,
    );
    assert.equal(
      (await (await admin("/api/admin/dashboard")).json()).usage.orders,
      2,
    );
    const deleted = (
      await (await admin("/api/admin/users?status=deleted")).json()
    ).users[0];
    assert.equal(
      (
        await admin("/api/admin/users/" + user.id + "/restore", "POST", {
          version: deleted.version,
        })
      ).status,
      200,
    );
  },
);
