const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  hashPassword,
  checkPassword,
  mailSender,
} = require("../server/password-auth.cjs");
const { EventEmitter } = require("node:events");
test("password hashing uses random salts and rejects incorrect or malformed hashes", async () => {
  const first = await hashPassword("a-strong-test-password"),
    second = await hashPassword("a-strong-test-password");
  assert.notEqual(first, second);
  assert.equal(await checkPassword("a-strong-test-password", first), true);
  assert.equal(await checkPassword("incorrect", first), false);
  assert.equal(await checkPassword("anything", "bad-hash"), false);
});
test("Gmail mailer requires an explicitly configured admin sender and uses the connected sender only", async () => {
  assert.equal(mailSender({}, {}), null);
  assert.throws(
    () =>
      mailSender(
        {
          mailProvider: "gmail",
          mailSenderEmail: "sender@example.test",
          adminEmails: "other@example.test",
        },
        {},
      ),
    /administrator/,
  );
  let outgoing;
  const auth = new EventEmitter();
  auth.setCredentials = () => {};
  const sender = mailSender(
    {
      mailProvider: "gmail",
      mailSenderEmail: "sender@example.test",
      adminEmails: "sender@example.test",
    },
    {
      userStore: {
        findByEmail: async () => ({
          id: "S",
          email: "sender@example.test",
          tokens: "encrypted",
          token_version: 1,
        }),
        isVerified: async () => true,
        decrypt: () => ({ refresh_token: "fake" }),
        refresh: async () => {},
      },
      oauthFactory: () => auth,
      gmailFactory: () => ({
        users: {
          messages: {
            send: async (request) => {
              outgoing = request;
            },
          },
        },
      }),
    },
  );
  await sender({
    to: "recipient@example.test",
    subject: "Xác nhận email",
    text: "Test link",
  });
  const raw = Buffer.from(outgoing.requestBody.raw, "base64url").toString();
  assert.match(raw, /From: sender@example.test/);
  assert.match(raw, /To: recipient@example.test/);
  assert.equal(outgoing.userId, "me");
});
