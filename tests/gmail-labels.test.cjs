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
    get: async () => ({ data: { labelIds: ["UNREAD"], payload: { mimeType: "multipart/mixed", parts: [
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

test("collecting labels keeps ordinary order writes even when emails have no usable label", async () => {
  const pdf = Buffer.from("%PDF-1.4\nfixture");
  const marked = [];
  const written = [];
  const third = "abcdef0123456789abcdef03";
  const gmail = { users: { messages: {
    list: async () => ({ data: { messages: [
      { id: "mail-with-tem" }, { id: "mail-without-tem" },
      { id: "mail-incomplete" }, { id: "irrelevant" },
    ] } }),
    get: async ({ id }) => {
      const text = id === "mail-with-tem"
        ? `Order Number ${first}\nTracking Number: ${trackingA}\nOrder Number means your order reference`
        : id === "mail-without-tem"
          ? `Order Number ${second}\nOrder Number means your order reference`
          : id === "mail-incomplete"
            ? `Order Number ${third}\nTracking Number: ${trackingA}\nOrder Number:\nTracking Number: ${trackingB}`
            : "Order Number means your order reference";
      return { data: { labelIds: ["UNREAD"], payload: { mimeType: "multipart/mixed", parts: [
        { mimeType: "text/plain", body: { data: Buffer.from(text).toString("base64url") } },
        ...(id === "mail-with-tem" || id === "mail-incomplete"
          ? [{ mimeType: "application/pdf", filename: "label.pdf", body: { data: pdf.toString("base64url") } }]
          : []),
      ] } } };
    },
    modify: async ({ id }) => { marked.push(id); },
  } } };
  const sheets = { spreadsheets: { values: {
    get: async () => ({ data: { values: [["ID Order"]] } }),
    batchUpdate: async ({ resource }) => {
      written.push(...resource.data.filter(cell => /!H\d+$/.test(cell.range)).map(cell => cell.values[0][0]));
    },
  } } };
  const report = await processOrders(null, "Shop", "Orders", {
    gmail, sheets, includeLabels: true, request: fn => fn({}), log: () => {},
  });
  assert.equal(report.writtenCount, 3);
  assert.deepEqual(written, [first, second, third]);
  assert.deepEqual(marked, ["mail-without-tem"]);
  assert.equal(report.labelBatches.length, 2);
  assert.equal(report.labelBatches[0].confirmable, true);
  assert.equal(report.labelBatches[1].confirmable, false);
  assert.deepEqual(report.labelBatches[0].orders, [{ orderId: first, tracking: trackingA }]);
});

test("a cross-email tracking conflict does not block unrelated matched labels", () => {
  const { planOrders } = require("../server/drive-label-import.cjs");
  const third = "abcdef0123456789abcdef03";
  const batches = [
    { issues: [], orders: [{ orderId: first, tracking: trackingA }, { orderId: third, tracking: trackingB }] },
    { issues: [], orders: [{ orderId: second, tracking: trackingA }] },
  ];
  assert.deepEqual(planOrders(batches), [{ orderId: third, tracking: trackingB }]);
  assert.match(batches[0].issues[0], /trùng giữa các Order ID/);
  assert.ok(batches[1].issues[0].includes(second));
});

test("Get Label enforces the Gmail unread filter before processing a mixed thread", async () => {
  const third = "abcdef0123456789abcdef03";
  const read = [];
  const attachments = [];
  const written = [];
  const messages = {
    "already-read": { labelIds: ["INBOX"], orderId: first },
    "still-unread": { labelIds: ["INBOX", "UNREAD"], orderId: second },
    "no-labels": { orderId: third },
  };
  const gmail = { users: { messages: {
    list: async ({ labelIds, q }) => {
      assert.deepEqual(labelIds, ["UNREAD"]);
      assert.match(q, /Order Number/);
      // Simulate labels changing after the unread list was generated.
      return { data: { messages: Object.keys(messages).map(id => ({ id, threadId: "same-thread" })) } };
    },
    get: async ({ id, format }) => {
      assert.equal(format, "full");
      const { labelIds, orderId } = messages[id];
      return { data: { labelIds, payload: { mimeType: "multipart/mixed", parts: [
        { mimeType: "text/plain", body: { data: Buffer.from(
          `Order Number ${orderId}\nTracking Number: ${trackingA}`
        ).toString("base64url") } },
        { mimeType: "application/pdf", filename: "label.pdf", body: { attachmentId: id } },
      ] } } };
    },
    attachments: { get: async ({ messageId }) => {
      attachments.push(messageId);
      return { data: { data: Buffer.from("%PDF-1.4\nfixture").toString("base64url") } };
    } },
    modify: async ({ id }) => { read.push(id); },
  } } };
  const sheets = { spreadsheets: { values: {
    get: async () => ({ data: { values: [["ID Order"]] } }),
    batchUpdate: async ({ resource }) => {
      written.push(...resource.data.filter(cell => /!H\d+$/.test(cell.range)).map(cell => cell.values[0][0]));
    },
  } } };
  const logs = [];
  const stats = await processOrders(null, "Shop", "Orders", {
    gmail, sheets, includeLabels: true, request: fn => fn({}), log: (_level, line) => logs.push(line),
  });
  assert.equal(stats.writtenOrderCount, 1);
  assert.deepEqual(written, [second]);
  assert.deepEqual(attachments, ["still-unread"]);
  assert.deepEqual(read, []);
  assert.deepEqual(stats.labelBatches.map(({ messageId }) => messageId), ["still-unread"]);
  assert.ok(logs.some(line => line.includes("bỏ qua 2 email không còn nhãn chưa đọc")));
});

test("a fully linked email is marked read without re-fetching PDFs and incomplete emails stay unread", async () => {
  const third = "abcdef0123456789abcdef03";
  const marked = [];
  const downloaded = [];
  const written = [];
  const emails = {
    done: `Order Number: ${first}\nTracking Number: ${trackingA}\nUse the Order Number and Order Date to identify your shipment.`,
    incomplete: `Order Number: ${second}\nTracking Number: ${trackingA}\nOrder Number:\nTracking Number: ${trackingB}`,
    new: `Order Number: ${third}\nTracking Number: ${trackingB}\nUse the Order Number and Order Date to identify your shipment.`,
  };
  const gmail = { users: { messages: {
    list: async ({ labelIds }) => {
      assert.deepEqual(labelIds, ["UNREAD"]);
      return { data: { messages: Object.keys(emails).map(id => ({ id })) } };
    },
    get: async ({ id }) => ({ data: { labelIds: ["UNREAD"], payload: { mimeType: "multipart/mixed", parts: [
      { mimeType: "text/plain", body: { data: Buffer.from(emails[id]).toString("base64url") } },
      { mimeType: "application/pdf", filename: "tem.pdf", body: { attachmentId: id } },
    ] } } }),
    attachments: { get: async ({ messageId }) => {
      downloaded.push(messageId);
      return { data: { data: Buffer.from("%PDF-1.4\nfixture").toString("base64url") } };
    } },
    modify: async ({ id, resource }) => {
      assert.deepEqual(resource.removeLabelIds, ["UNREAD"]);
      marked.push(id);
    },
  } } };
  const link = { values: [{ hyperlink: "https://drive.google.com/file/d/saved-label/view" }] };
  const sheets = { spreadsheets: {
    get: async ({ ranges }) => {
      assert.deepEqual(ranges, ["'Orders'!H:H", "'Orders'!R:R"]);
      return { data: { sheets: [{ data: [
        { startColumn: 7, rowData: ["ID Order", first, second].map(formattedValue => ({ values: [{ formattedValue }] })) },
        { startColumn: 17, startRow: 1, rowData: [link, link] },
      ] }] } };
    },
    values: { batchUpdate: async ({ resource }) => {
      written.push(...resource.data.filter(cell => /!H\d+$/.test(cell.range)));
    } },
  } };
  const logs = [];
  const stats = await processOrders(null, "Shop", "Orders", {
    gmail, sheets, spreadsheetId: "sheet", includeLabels: true, resolveLinkedEmails: true,
    request: operation => operation({}), log: (_level, line) => logs.push(line),
  });
  assert.deepEqual(marked, ["done"]);
  assert.deepEqual(downloaded, ["incomplete", "new"]);
  assert.deepEqual(written, [{ range: "'Orders'!H4", values: [[third]] }]);
  assert.deepEqual(stats.labelBatches.map(({ messageId, confirmable }) => [messageId, confirmable]), [
    ["incomplete", false], ["new", true],
  ]);
  assert.ok(logs.some(line => line.includes("đủ link tem ở cột R")));
});
