const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mailDiagnostic } = require("../server/mail-diagnostics.cjs");

test("mail failures give actionable fixed messages without exposing provider payloads", () => {
  const cases = [
    [
      { response: { status: 400, data: { error: "invalid_grant" } } },
      "RECONNECT",
    ],
    [{ response: { status: 401 } }, "RECONNECT"],
    [
      { response: { status: 400, data: { error: "invalid_client" } } },
      "GOOGLE_CONFIG",
    ],
    [
      {
        response: {
          status: 403,
          data: { error: { details: [{ reason: "SERVICE_DISABLED" }] } },
        },
      },
      "API_DISABLED",
    ],
    [
      {
        response: {
          status: 403,
          data: { error: { errors: [{ reason: "accessNotConfigured" }] } },
        },
      },
      "API_DISABLED",
    ],
    [
      {
        response: {
          status: 403,
          data: { error: { errors: [{ reason: "userRateLimitExceeded" }] } },
        },
      },
      "RATE_LIMIT",
    ],
    [{ response: { status: 429 } }, "RATE_LIMIT"],
    [{ response: { status: 403 } }, "PERMISSION"],
    [{ code: "ETIMEDOUT" }, "TIMEOUT"],
    [{ name: "AbortError" }, "TIMEOUT"],
    [{ response: { status: 500 } }, "DELIVERY_FAILED"],
  ];
  for (const [provider, reason] of cases) {
    const result = mailDiagnostic(
      Object.assign(new Error("fake-private-token request URL"), provider, {
        request: { headers: { Authorization: "fake-private-token" } },
      }),
    );
    assert.equal(result.code, "AUTH_MAIL_" + reason);
    assert.equal(result.status, reason === "RATE_LIMIT" ? 429 : 503);
    assert.ok(!result.message.includes("fake-private-token"));
    assert.ok(!JSON.stringify(result).includes("fake-private-token"));
  }
});
