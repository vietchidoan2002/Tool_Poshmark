const { test } = require("node:test");
const assert = require("node:assert/strict");
const { databaseOptions } = require("../server/web-config.cjs");
test("Neon free uses a small pool, a direct connection and full TLS verification", () => {
  const options = databaseOptions(
    "postgresql://test:fake@ep-test.us-east-2.aws.neon.tech/example?sslmode=require",
  );
  assert.equal(options.max, 4);
  assert.equal(
    new URL(options.connectionString).searchParams.get("sslmode"),
    "verify-full",
  );
  assert.ok(options.idleTimeoutMillis <= 10000);
  assert.throws(
    () =>
      databaseOptions(
        "postgresql://test:fake@ep-test-pooler.us-east-2.aws.neon.tech/example",
      ),
    /direct Neon/,
  );
});
test("connection configuration rejects invalid protocols or resource limits without revealing secrets", () => {
  for (const value of ["secret-password", "https://user:secret@host", ""]) {
    assert.throws(
      () => databaseOptions(value),
      (error) =>
        !error.message.includes("secret") &&
        error.message.includes("PostgreSQL"),
    );
  }
  for (const max of ["bad", 0, 1, 2, 11, 1.5])
    assert.throws(
      () => databaseOptions("postgresql://test:fake@localhost/db", max),
      /PG_POOL_MAX/,
    );
  assert.equal(
    databaseOptions("postgresql://test:fake@localhost/db", 3).max,
    3,
  );
});
