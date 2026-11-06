const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  oauthDiagnostic,
  oauthFailurePage,
} = require("../server/oauth-diagnostics.cjs");

test("OAuth failures select actionable fixed messages and hide provider/query credentials", () => {
  const secret = "fake-private-code-secret-db-password";
  for (const [stage, error, code] of [
    [
      "TOKEN_EXCHANGE",
      { response: { data: { error: "invalid_client" } } },
      "CLIENT_CONFIG",
    ],
    [
      "TOKEN_EXCHANGE",
      { response: { data: { error: "invalid_grant" } } },
      "GRANT_EXPIRED",
    ],
    [
      "TOKEN_EXCHANGE",
      { response: { data: { error: "redirect_uri_mismatch" } } },
      "REDIRECT_URI",
    ],
    ["TOKEN_EXCHANGE", { code: "ETIMEDOUT" }, "GOOGLE_UNAVAILABLE"],
    ["IDENTITY_VERIFY", { response: { status: 503 } }, "GOOGLE_UNAVAILABLE"],
    ["TOKEN_EXCHANGE", {}, "TOKEN_EXCHANGE"],
    ["IDENTITY_VERIFY", {}, "IDENTITY_VERIFY"],
    ["ACCOUNT_SAVE", { code: "42501" }, "ACCOUNT_SAVE"],
    ["SESSION_SAVE", { code: "53300" }, "SESSION_SAVE"],
    [secret, { code: secret }, "UNKNOWN"],
  ]) {
    const result = oauthDiagnostic(
      Object.assign(
        new Error(secret),
        { request: { url: secret }, detail: secret },
        error,
      ),
      stage,
    );
    assert.equal(result.code, "OAUTH_" + code);
    const page = oauthFailurePage(result);
    assert.match(page, /href="\/"/);
    assert.ok(!page.includes(secret));
    assert.ok(!JSON.stringify(result).includes(secret));
    if (["ACCOUNT_SAVE", "SESSION_SAVE"].includes(stage))
      assert.equal(result.databaseCode, error.code);
    else assert.equal(result.databaseCode, null);
  }
});
