const { createHmac, timingSafeEqual } = require("node:crypto");
const { normalizeUspsTracking } = require("../shared/usps-tracking.mjs");

const MAX_PDF_BYTES = 8 * 1024 * 1024;
const MAX_PDF_FILES = 50;

function pdfParts(part) {
  if (!part) return [];
  if (/^application\/pdf$/i.test(part.mimeType) || /\.pdf$/i.test(part.filename))
    return [part];
  return (part.parts || []).flatMap(pdfParts);
}

function trackingInOrder(block) {
  const candidates = new Set();
  for (const match of block.matchAll(
    /\b(?:USPS\s+tracking(?:\s+(?:number|no\.?))?|tracking\s*(?:number|no\.?|#))[\s:#>]*([A-Z]{2}(?:[ \t]*\d){9}[ \t]*US|\d[\d \t-]{18,70}\d)(?![A-Z0-9])/gi,
  )) {
    const tracking = normalizeUspsTracking(match[1]);
    if (tracking) candidates.add(tracking);
  }
  return candidates.size === 1 ? [...candidates][0] : "";
}

async function loadLabelBatch({ gmail, request, messageId, parts, orders, budget, canMarkRead }) {
  const files = [];
  const issues = [];
  for (const part of parts) {
    const filename = (part.filename || "tem.pdf").slice(0, 200);
    const body = part.body || {};
    if (budget.files >= MAX_PDF_FILES || body.size > budget.bytes || budget.bytes <= 0) {
      issues.push(`${filename}: vượt giới hạn tải PDF của lượt chạy.`);
      break;
    }
    budget.files++;
    try {
      let data = body.data;
      if (!data && body.attachmentId) {
        const response = await request(requestOptions =>
          gmail.users.messages.attachments.get({
            userId: "me", messageId, id: body.attachmentId,
          }, requestOptions),
        );
        data = response.data?.data;
      }
      if (typeof data !== "string" || !data || data.length > 4 * Math.ceil(budget.bytes / 3))
        throw Error("Invalid PDF data");
      const bytes = Buffer.from(data, "base64url");
      if (bytes.length > budget.bytes || !bytes.subarray(0, 1024).includes("%PDF-"))
        throw Error("Invalid PDF size or signature");
      budget.bytes -= bytes.length;
      files.push({ filename, data: bytes.toString("base64") });
    } catch {
      issues.push(`${filename}: không tải hoặc xác nhận được tệp PDF.`);
    }
  }
  return { messageId, orders, files, issues, confirmable: canMarkRead && !issues.length };
}

function confirmationSignature(secret, user, messageId, expires) {
  return createHmac("sha256", secret)
    .update(JSON.stringify(["gmail-label-read", user.id, user.token_version, messageId, expires]))
    .digest("base64url");
}

function issueConfirmation(secret, user, messageId, now = Date.now()) {
  const expires = now + 60 * 60 * 1000;
  return `${messageId}.${expires}.${confirmationSignature(secret, user, messageId, expires)}`;
}

function confirmedMessageId(secret, user, token, now = Date.now()) {
  if (typeof token !== "string") return null;
  const match = /^([\w-]{1,100})\.(\d{1,15})\.([\w-]{43})$/.exec(token);
  if (!match) return null;
  const [, messageId, timestamp, signature] = match;
  const expires = Number(timestamp);
  if (expires <= now) return null;
  const expected = confirmationSignature(secret, user, messageId, expires);
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected)) ? messageId : null;
}

module.exports = {
  MAX_PDF_BYTES, pdfParts, trackingInOrder, loadLabelBatch, issueConfirmation, confirmedMessageId,
};
