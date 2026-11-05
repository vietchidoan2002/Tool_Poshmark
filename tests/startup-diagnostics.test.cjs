const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  startupDiagnostic,
  configurationError,
} = require("../server/startup-diagnostics.cjs");
const { createWebApp } = require("../server/web.cjs");
test("startup diagnostics identify actionable configuration, DB and TLS issues without exposing secrets", () => {
  const sensitive =
    "postgresql://user:test-secret-password@private-host/database";
  for (const code of [
    "CONFIG_SESSION_SECRET",
    "CONFIG_TOKEN_ENCRYPTION_KEY",
    "CONFIG_ADMIN_EMAILS",
    "28P01",
    "ENOTFOUND",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "42501",
  ]) {
    const result = startupDiagnostic(
      Object.assign(new Error(sensitive), { code, detail: sensitive }),
    );
    assert.ok(result.includes(code));
    assert.ok(!result.includes(sensitive));
    assert.ok(!result.includes("test-secret-password"));
  }
  assert.match(
    startupDiagnostic({
      message: "Connection terminated due to connection timeout",
    }),
    /CONNECTION_TIMEOUT/,
  );
  assert.match(
    startupDiagnostic({ errors: [{ code: "ETIMEDOUT", message: sensitive }] }),
    /ETIMEDOUT/,
  );
  assert.match(
    startupDiagnostic({ code: sensitive, message: sensitive }),
    /WEB_STARTUP:UNKNOWN/,
  );
  assert.ok(
    !startupDiagnostic({ code: sensitive, message: sensitive }).includes(
      sensitive,
    ),
  );
});
test("invalid web environment is diagnosed before any database request", async () => {
  const good = {
    baseUrl: "https://example.test",
    clientId: "test-client",
    clientSecret: "test-client-secret",
    sessionSecret: "a".repeat(64),
    encryptionKey: "b".repeat(64),
    pool: {
      query: () => {
        throw Error("Database should not be reached");
      },
    },
  };
  for (const [patch, code] of [
    [{ baseUrl: "" }, "CONFIG_PUBLIC_BASE_URL"],
    [{ baseUrl: "https://example.test/path" }, "CONFIG_PUBLIC_BASE_URL"],
    [{ clientId: "" }, "CONFIG_GOOGLE_CLIENT_ID"],
    [{ clientSecret: "" }, "CONFIG_GOOGLE_CLIENT_SECRET"],
    [{ sessionSecret: "Khóa ngẫu nhiên thứ nhất" }, "CONFIG_SESSION_SECRET"],
    [{ encryptionKey: "" }, "CONFIG_TOKEN_ENCRYPTION_KEY"],
    [{ requirePhoneReview: true, adminEmails: "" }, "CONFIG_ADMIN_EMAILS"],
  ])
    await assert.rejects(
      createWebApp({ ...good, ...patch }),
      (error) => error.code === code,
    );
  assert.equal(
    configurationError("CONFIG_SESSION_SECRET").code,
    "CONFIG_SESSION_SECRET",
  );
});
