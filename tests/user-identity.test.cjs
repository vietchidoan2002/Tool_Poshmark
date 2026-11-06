const { test } = require("node:test");
const assert = require("node:assert/strict");
const { newDb } = require("pg-mem");
const { createWebStore } = require("../server/web-store.cjs");
const {
  createAccountStore,
  hashPassword,
  checkPassword,
} = require("../server/password-auth.cjs");
const { createPhoneStore } = require("../server/phones.cjs");
const {
  initializeIdentities,
  DISABLED_PASSWORD,
} = require("../server/user-identity.cjs");
const key = "identity-test-key-not-a-real-secret-123456789";

async function prepare(pool, verified = true) {
  const store = await createWebStore(pool, key);
  const passwords = await createAccountStore(pool);
  const phones = await createPhoneStore(pool);
  await pool.query(
    "INSERT INTO pm_users(id,email) VALUES('pw:owner','Owner@example.test')",
  );
  const hash = await hashPassword("existing-password");
  await pool.query(
    "INSERT INTO pm_password_accounts(user_id,email,display_name,password_hash,email_verified,terms_version) VALUES('pw:owner','owner@example.test','Owner',$1,$2,'test')",
    [hash, verified],
  );
  await store.connect("google-owner", "owner@example.test", {
    refresh_token: "old-test-refresh",
    access_token: "old-test-access",
    pm_connected_email: "owner@example.test",
  });
  await store.setSheet("google-owner", "existing-sheet-id");
  await pool.query(
    "INSERT INTO pm_phone_profiles(user_id,phone,version,reviewed,reviewed_at,reviewed_by) VALUES('google-owner','+84901234567',4,true,$1,'google-owner')",
    [new Date()],
  );
  await pool.query(
    "INSERT INTO pm_phone_profiles(user_id,phone) VALUES('pw:owner','+84902345678')",
  );
  await passwords.issue("pw:owner", "verify");
  return { store, passwords, phones, hash };
}
function memoryPool() {
  const { Pool } = newDb({ noAstCoverageCheck: true }).adapters.createPg();
  return new Pool();
}

test("legacy duplicate accounts merge once, preserve reviewed phone/Sheets/tokens and archive conflicting data", async (t) => {
  const pool = memoryPool();
  t.after(() => pool.end());
  const { store, passwords, phones, hash } = await prepare(pool);
  const identities = await initializeIdentities(pool, store, {
    lockTables: false,
  });
  assert.equal((await pool.query("SELECT * FROM pm_users")).rows.length, 1);
  assert.equal(await identities.resolveId("google-owner"), "pw:owner");
  const owner = await store.get("pw:owner");
  assert.equal(owner.email, "owner@example.test");
  assert.equal(owner.sheet_id, "existing-sheet-id");
  assert.equal(
    store.decrypt(owner.tokens, owner.id).refresh_token,
    "old-test-refresh",
  );
  assert.throws(() => store.decrypt(owner.tokens, "google-owner"));
  const phone = await phones.get(owner.id);
  assert.equal(phone.phone, "+84901234567");
  assert.equal(phone.reviewed, true);
  assert.equal(phone.version, 5);
  assert.equal((await passwords.get(owner.id)).password_hash, hash);
  assert.equal((await passwords.get(owner.id)).auth_version, 2);
  assert.equal(
    (await pool.query("SELECT * FROM pm_account_actions")).rows.length,
    0,
  );
  const archive = (await pool.query("SELECT * FROM pm_user_merge_archive"))
    .rows;
  assert.equal(archive.length, 2);
  for (const row of archive) {
    assert.ok(!row.snapshot.includes("old-test-refresh"));
    assert.ok(!row.snapshot.includes("+84901234567"));
    const snapshot = store.decrypt(row.snapshot, row.original_user_id);
    assert.equal(snapshot.user.id, row.original_user_id);
  }
  const passwordBackup = archive.find(
    (row) => row.original_user_id === "pw:owner",
  );
  assert.equal(
    store.decrypt(passwordBackup.snapshot, "pw:owner").phone.phone,
    "+84902345678",
  );
  await initializeIdentities(pool, store, { lockTables: false });
  assert.equal(
    (await pool.query("SELECT * FROM pm_user_merge_archive")).rows.length,
    2,
  );
  assert.equal(
    await identities.claimGoogle({
      sub: "google-owner",
      email: "OWNER@example.test",
      email_verified: true,
    }),
    "pw:owner",
  );
  assert.equal((await pool.query("SELECT * FROM pm_users")).rows.length, 1);
  await assert.rejects(
    pool.query(
      "INSERT INTO pm_users(id,email) VALUES('duplicate','OWNER@example.test')",
    ),
    (error) => error.code === "23505",
  );
});

test("merging a verified Google identity never enables an unverified password", async (t) => {
  const pool = memoryPool();
  t.after(() => pool.end());
  const { store, passwords } = await prepare(pool, false);
  await initializeIdentities(pool, store, { lockTables: false });
  const account = await passwords.get("pw:owner");
  assert.equal(account.password_hash, DISABLED_PASSWORD);
  assert.equal(account.email_verified, true);
  assert.equal(
    await checkPassword("existing-password", account.password_hash),
    false,
  );
  assert.equal(account.auth_version, 2);
});

test("the canonical account keeps its selected Sheet and token when both copies contain configuration", async (t) => {
  const pool = memoryPool();
  t.after(() => pool.end());
  const { store } = await prepare(pool);
  await store.connect("pw:owner", "owner@example.test", {
    refresh_token: "preferred-refresh",
    pm_connected_email: "other-mailbox@example.test",
  });
  await store.setSheet("pw:owner", "preferred-sheet");
  await initializeIdentities(pool, store, { lockTables: false });
  const user = await store.get("pw:owner");
  assert.equal(user.sheet_id, "preferred-sheet");
  assert.equal(
    store.decrypt(user.tokens, user.id).refresh_token,
    "preferred-refresh",
  );
  const archive = (
    await pool.query(
      "SELECT * FROM pm_user_merge_archive WHERE original_user_id='google-owner'",
    )
  ).rows[0];
  assert.equal(
    store.decrypt(archive.snapshot, "google-owner").user.sheet_id,
    "existing-sheet-id",
  );
});

test(
  "real PostgreSQL migration rolls back an interrupted merge and retries safely",
  { skip: !process.env.IDENTITY_PG_MODULE },
  async (t) => {
    const { PGlite } = require(process.env.IDENTITY_PG_MODULE);
    const pg = new PGlite();
    t.after(() => pg.close());
    let interrupt = false;
    const pool = {
      query: (sql, args) => pg.query(sql, args),
      connect: async () => ({
        query: async (sql, args) => {
          if (interrupt && sql.startsWith("DELETE FROM pm_users"))
            throw Error("test interruption");
          return pg.query(sql, args);
        },
        release() {},
      }),
    };
    const { store, phones } = await prepare(pool);
    interrupt = true;
    await assert.rejects(
      initializeIdentities(pool, store),
      /test interruption/,
    );
    assert.equal((await pool.query("SELECT * FROM pm_users")).rows.length, 2);
    assert.equal(
      (await pool.query("SELECT * FROM pm_user_merge_archive")).rows.length,
      0,
    );
    assert.equal((await phones.get("google-owner")).reviewed, true);
    assert.equal((await phones.get("pw:owner")).phone, "+84902345678");
    interrupt = false;
    const identities = await initializeIdentities(pool, store);
    assert.equal((await pool.query("SELECT * FROM pm_users")).rows.length, 1);
    assert.equal(await identities.resolveId("google-owner"), "pw:owner");
    await initializeIdentities(pool, store);
    assert.equal(
      (await pool.query("SELECT * FROM pm_user_merge_archive")).rows.length,
      2,
    );
  },
);
