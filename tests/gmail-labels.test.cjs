const assert = require("node:assert/strict");
const test = require("node:test");
const { processOrders } = require("../server/bot.cjs");
const { trackingInOrder, issueConfirmation, confirmedMessageId } = require("../server/gmail-labels.cjs");
const { barcodeTrackings } = require("../shared/usps-tracking.mjs");

const first = "abcdef0123456789abcdef01";
const second = "abcdef0123456789abcdef02";
const trackingA = "9400000000000000000001";
const trackingB = "9400000000000000000002";

test("reads a labeled USPS tracking only when its value is unique", () => {
  assert.equal(trackingInOrder(`Tracking Number\n> ${trackingA}\nBuyer`), trackingA);
  assert.equal(trackingInOrder(`Tracking Number: ${trackingA}\nTracking Number: ${trackingB}`), "");
  assert.equal(trackingInOrder(`Other digits: ${trackingA}`), "");
  assert.deepEqual(barcodeTrackings(`]C1420123456789\x1d${trackingA}`), [trackingA]);
  assert.deepEqual(barcodeTrackings(`garbage${trackingA}`), []);
});

test("downloads a bundled attachment and retains tracking for orders already in Sheets", async () => {
  const attachment = Buffer.from("%PDF-1.4\nfixture");
  const notices = [];
  let sheetWrite = 0;
  const gmail = { users: { messages: {
    list: async () => ({ data: { messages: [{ id: "message-1" }] } }),
    get: async () => ({ data: { payload: { mimeType: "multipart/mixed", parts: [
      { mimeType: "text/html", body: { data: Buffer.from(
        `<div>Order Number</div><div>${first}</div><div>Tracking Number</div><div>${trackingA}</div><div>Order Number</div><div>${second}</div><div>Tracking Number</div><div>${trackingB}</div>`,
      ).toString("base64url") } },
      { mimeType: "application/pdf", filename: "tem.pdf", body: { attachmentId: "attachment-1", size: attachment.length } },
    ] } } }),
    attachments: { get: async (args) => {
      notices.push(args);
      return { data: { data: attachment.toString("base64url") } };
    } },
    modify: async () => assert.fail("attachment email must stay unread until confirmation"),
  } } };
  const sheets = { spreadsheets: { values: {
    get: async () => ({ data: { values: [["id order"], [first]] } }),
    batchUpdate: async () => { sheetWrite++; },
  } } };
  const result = await processOrders(null, "Store", "Orders", {
    gmail, sheets, spreadsheetId: "sheet", includeLabels: true, request: fn => fn({}), log: () => {},
  });
  assert.equal(sheetWrite, 1);
  assert.equal(result.skippedCount, 1);
  assert.deepEqual(notices, [{ userId: "me", messageId: "message-1", id: "attachment-1" }]);
  assert.deepEqual(result.labelBatches, [{
    messageId: "message-1", confirmable: true, issues: [],
    orders: [{ orderId: first, tracking: trackingA }, { orderId: second, tracking: trackingB }],
    files: [{ filename: "tem.pdf", data: attachment.toString("base64") }],
  }]);
});

test("Gmail confirmation is bound to the account, Gmail connection and expiration", () => {
  const user = { id: "owner", token_version: 4 };
  const secret = "test secret";
  const token = issueConfirmation(secret, user, "message-1", 1000);
  assert.equal(confirmedMessageId(secret, user, token, 2000), "message-1");
  assert.equal(confirmedMessageId(secret, { ...user, id: "other" }, token, 2000), null);
  assert.equal(confirmedMessageId(secret, { ...user, token_version: 5 }, token, 2000), null);
  assert.equal(confirmedMessageId(secret, user, token.replace("message-1", "message-2"), 2000), null);
  assert.equal(confirmedMessageId(secret, user, token, 3601000), null);
});

test("preparing a Drive batch reads emails and attachments without marking read or touching Sheets", async () => {
  const pdf = Buffer.from("%PDF-1.4\nfixture");
  const gmail = { users: { messages: {
    list: async () => ({ data: { messages: [{ id: "mail-ready" }, { id: "mail-needs-review" }] } }),
    get: async ({ id }) => ({ data: { payload: { mimeType: "multipart/mixed", parts: [
      { mimeType: "text/plain", body: { data: Buffer.from(
        `Order Number ${id === "mail-ready" ? first : second}\nTracking Number: ${id === "mail-ready" ? trackingA : trackingB}`,
      ).toString("base64url") } },
      ...(id === "mail-ready"
        ? [{ mimeType: "application/pdf", filename: "label.pdf", body: { data: pdf.toString("base64url") } }]
        : []),
    ] } } }),
    modify: async () => assert.fail("A preflight must not change Gmail"),
  } } };
  const sheets = { spreadsheets: { values: {
    get: async () => assert.fail("A preflight must not need Sheets"),
    batchUpdate: async () => assert.fail("A preflight must not write Sheets"),
  } } };
  const report = await processOrders(null, "Shop", "Orders", {
    gmail, sheets, prepareDrive: true, request: fn => fn({}), log: () => {},
  });
  assert.equal(report.writtenCount, 0);
  assert.deepEqual(report.plannedOrders.map(order => order.orderId), [first, second]);
  assert.equal(report.labelBatches[0].files.length, 1);
  assert.match(report.labelBatches[1].issues[0], /thiếu PDF/);
});
