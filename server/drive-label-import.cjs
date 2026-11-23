const { createHash } = require("node:crypto");
const { Readable } = require("node:stream");
const { PDFDocument } = require("pdf-lib");

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
const MAX_UPLOAD_BYTES = 16 * 1024 * 1024;
const MAX_LABELS = 80;
const folderType = "application/vnd.google-apps.folder";
const idPattern = /^[\w-]{6,200}$/;
const digest = (data) => createHash("sha256").update(JSON.stringify(data)).digest("hex");
const driveFileUrl = (id) => `https://drive.google.com/file/d/${id}/view?usp=drive_link`;
const fail = (status, message) => Object.assign(Error(message), { status, publicMessage: message });

function parseDriveFolder(link) {
  if (typeof link !== "string" || link.length > 1000) return null;
  try {
    const url = new URL(link.trim());
    if (url.origin !== "https://drive.google.com" || url.username || url.password) return null;
    const id = url.pathname.match(/^\/drive\/(?:u\/\d+\/)?folders\/([\w-]+)\/?$/)?.[1] ||
      (url.pathname === "/open" ? url.searchParams.get("id") : "");
    const resourceKey = url.searchParams.get("resourcekey") || "";
    if (!idPattern.test(id || "") || (resourceKey && !idPattern.test(resourceKey))) return null;
    return { id, resourceKey };
  } catch {
    return null;
  }
}

function driveOptions(folder, options) {
  return folder.resourceKey ? {
    ...options, headers: {
      ...options.headers,
      "X-Goog-Drive-Resource-Keys": `${folder.id}/${folder.resourceKey}`,
    },
  } : options;
}

async function checkDriveFolder(drive, folder, request) {
  let response;
  try {
    response = await request(options => drive.files.get({
      fileId: folder.id, supportsAllDrives: true,
      fields: "id,name,webViewLink,mimeType,driveId,capabilities(canAddChildren)",
    }, driveOptions(folder, options)));
  } catch (error) {
    const status = Number(error.response?.status || error.code);
    if (status === 403 || status === 404)
      throw fail(403, "Google chưa cho phép mở thư mục này. Hãy kiểm tra tài khoản kết nối, quyền chỉnh sửa và quyền Google Drive.");
    throw error;
  }
  const data = response.data;
  if (data?.mimeType !== folderType || !data.capabilities?.canAddChildren)
    throw fail(403, "Link phải là thư mục Google Drive mà tài khoản đang kết nối có quyền thêm tệp.");
  return {
    ...folder, driveId: data.driveId,
    webViewLink: data.webViewLink || `https://drive.google.com/drive/folders/${folder.id}`,
  };
}

function planOrders(batches) {
  const byOrder = new Map();
  const byTracking = new Map();
  for (const batch of batches) {
    for (const { orderId, tracking } of batch.orders) {
      if (!tracking) continue;
      if (!byOrder.has(orderId)) byOrder.set(orderId, new Set());
      if (!byTracking.has(tracking)) byTracking.set(tracking, new Set());
      byOrder.get(orderId).add(tracking);
      byTracking.get(tracking).add(orderId);
    }
  }
  const allowed = new Map();
  for (const [orderId, trackings] of byOrder) {
    const [tracking] = trackings;
    if (trackings.size === 1 && byTracking.get(tracking).size === 1)
      allowed.set(orderId, tracking);
  }
  for (const batch of batches) {
    for (const { orderId, tracking } of batch.orders) {
      if (!tracking || allowed.has(orderId)) continue;
      const trackings = byOrder.get(orderId);
      const orders = byTracking.get(tracking);
      if (trackings.size > 1)
        batch.issues.push(`Order ID ${orderId} có nhiều tracking: ${[...trackings].join(", ")}.`);
      else
        batch.issues.push(`Tracking ${tracking} trùng giữa các Order ID: ${[...orders].join(", ")}.`);
    }
  }
  return [...allowed].map(([orderId, tracking]) => ({ orderId, tracking }));
}

async function readVerifiedFiles(input, orders) {
  if (!Array.isArray(input) || !input.length || input.length > MAX_LABELS)
    throw fail(400, "Danh sách tem đã xác nhận không hợp lệ.");
  const expected = new Map(orders.map(order => [order.orderId, order.tracking]));
  const seen = new Set();
  const files = [];
  let total = 0;
  for (const item of input) {
    if (!item || typeof item !== "object") throw fail(400, "Thông tin tem không hợp lệ.");
    const { orderId, tracking, data, source, pageNo } = item;
    if (!tracking || seen.has(orderId) || expected.get(orderId) !== tracking ||
        typeof data !== "string" || data.length > 6 * 1024 * 1024 ||
        typeof source !== "string" || source.length > 205 ||
        !Number.isInteger(pageNo) || pageNo < 1 || pageNo > 80)
      throw fail(400, "Order ID, tracking hoặc PDF không hợp lệ.");
    seen.add(orderId);
    const bytes = Buffer.from(data, "base64");
    total += bytes.length;
    if (total > MAX_UPLOAD_BYTES) throw fail(413, "Tổng PDF tem vượt 16 MB. Hãy chia nhỏ lượt chạy.");
    try {
      if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw Error();
      const doc = await PDFDocument.load(bytes);
      if (doc.getPageCount() !== 1) throw Error();
      const { width, height } = doc.getPage(0).getSize();
      if (width !== 288 || height !== 432) throw Error();
    } catch {
      throw fail(400, `PDF 4×6 không hợp lệ cho Order ID ${orderId}, tracking ${tracking}.`);
    }
    files.push({ orderId, tracking, source, pageNo, bytes });
  }
  return files.sort((a, b) => a.orderId.localeCompare(b.orderId));
}

function csvFor(files) {
  const cell = value => {
    const text = String(value);
    return '"' + (/^[=+\-@\t\r]/.test(text) ? "'" : "") + text.replace(/"/g, '""') + '"';
  };
  return Buffer.from("\uFEFF" + [
    ["File gốc", "Trang", "Order ID", "Tracking USPS", "Tên tệp", "Link Google Drive"],
    ...files.map(f => [f.source, f.pageNo, f.orderId, f.tracking, f.name, f.url]),
  ].map(row => row.map(cell).join(",")).join("\r\n"), "utf8");
}

async function saveDriveFiles({ drive, folder, files, userId, request }) {
  const pdfs = files.map(file => ({
    ...file, name: `${file.orderId}.pdf`,
    mimeType: "application/pdf",
    key: digest(["pm-label", userId, file.orderId, file.tracking]),
  }));
  const csvKey = digest(["pm-csv", userId, pdfs.map(f => [f.orderId, f.tracking])]);
  const keys = [...pdfs.map(f => f.key), csvKey];
  const found = new Map();
  for (let i = 0; i < keys.length; i += 12) {
    const filters = keys.slice(i, i + 12).map(key => `appProperties has { key='pmLabelKey' and value='${key}' }`).join(" or ");
    let pageToken;
    do {
      const data = (await request(options => drive.files.list({
        q: `'${folder.id}' in parents and trashed = false and (${filters})`,
        fields: "nextPageToken,files(id,name,appProperties)",
        pageSize: 100, supportsAllDrives: true, includeItemsFromAllDrives: true,
        ...(folder.driveId ? { corpora: "drive", driveId: folder.driveId } : { corpora: "user" }),
        ...(pageToken ? { pageToken } : {}),
      }, driveOptions(folder, options)))).data;
      for (const file of data.files || []) found.set(file.appProperties?.pmLabelKey, file);
      pageToken = data.nextPageToken;
    } while (pageToken);
  }
  const missing = keys.filter(key => !found.has(key));
  const ids = missing.length ? (await request(options => drive.files.generateIds({
    count: missing.length, space: "drive",
  }, options))).data.ids : [];
  if (ids?.length !== missing.length)
    throw fail(502, "Google Drive chưa cấp được mã tệp. Hãy thử lại.");
  const reserved = new Map(missing.map((key, index) => [key, ids[index]]));

  async function save(file) {
    const previous = found.get(file.key);
    if (previous) return { name: previous.name, url: driveFileUrl(previous.id) };
    const id = reserved.get(file.key);
    const fields = "id,name,appProperties";
    let data;
    try {
      ({ data } = await request(options => drive.files.create({
        requestBody: {
          id, name: file.name, mimeType: file.mimeType,
          parents: [folder.id], appProperties: { pmLabelKey: file.key },
        },
        media: { mimeType: file.mimeType, body: Readable.from([file.bytes]) },
        supportsAllDrives: true, fields,
      }, driveOptions(folder, options))));
    } catch (error) {
      if (Number(error.response?.status || error.code) !== 409) throw error;
      // A retried create may find the ID that the previous request already created.
      ({ data } = await request(options => drive.files.get({
        fileId: id, supportsAllDrives: true, fields,
      }, driveOptions(folder, options))));
      if (data.appProperties?.pmLabelKey !== file.key) throw error;
    }
    return { name: data.name || file.name, url: driveFileUrl(data.id) };
  }

  const saved = [];
  for (const pdf of pdfs) saved.push({ ...pdf, ...await save(pdf) });
  const csv = await save({
    key: csvKey, name: `danh-sach-label-${csvKey.slice(0, 12)}.csv`,
    mimeType: "text/csv", bytes: csvFor(saved),
  });
  return { links: new Map(saved.map(f => [f.orderId, f.url])), csvUrl: csv.url };
}

function hasFileLink(cell) {
  if (!cell) return false;
  return Boolean(
    cell.hyperlink ||
    cell.userEnteredFormat?.textFormat?.link?.uri ||
    cell.textFormatRuns?.some(run => run.format?.link?.uri) ||
    /\bHYPERLINK\s*\(/i.test(cell.userEnteredValue?.formulaValue || "") ||
    /^(?:https?:\/\/|(?:drive|docs)\.google\.com\/)/i.test(
      (cell.userEnteredValue?.stringValue ?? cell.formattedValue ?? "").trim(),
    )
  );
}

async function sheetRows(sheets, plan, request) {
  const sheet = `'${plan.sheetName.replace(/'/g, "''")}'!`;
  const cellFields = [
    "formattedValue", "userEnteredValue", "hyperlink",
    "userEnteredFormat(textFormat(link))", "textFormatRuns(format(link))",
  ].join(",");
  const { data } = await request(options => sheets.spreadsheets.get({
    spreadsheetId: plan.sheetId,
    ranges: [sheet + "H:H", sheet + "R:R"],
    fields: `sheets(data(startRow,startColumn,rowData(values(${cellFields}))))`,
  }, options));
  const grids = data.sheets?.[0]?.data || [];
  const orderGrid = grids.find(grid => grid.startColumn === 7);
  const linkGrid = grids.find(grid => grid.startColumn === 17);
  const existing = new Map();
  const linkedOrders = new Set();
  for (const [index, row] of (orderGrid?.rowData || []).entries()) {
    const id = row.values?.[0]?.formattedValue?.trim().toLowerCase();
    if (!id || id === "id order") continue;
    const rowIndex = (orderGrid.startRow || 0) + index;
    const linkCell = linkGrid?.rowData?.[rowIndex - (linkGrid.startRow || 0)]?.values?.[0];
    if (!existing.has(id)) existing.set(id, []);
    existing.get(id).push(rowIndex + 1);
    if (hasFileLink(linkCell)) linkedOrders.add(id);
  }
  return { sheet, existing, linkedOrders };
}

async function writeDriveLinks(sheets, plan, rows, links, request) {
  const data = [];
  for (const [orderId, url] of links) {
    if (rows.linkedOrders.has(orderId)) continue;
    for (const row of rows.existing.get(orderId) || [])
      data.push({ range: `${rows.sheet}R${row}`, values: [[url]] });
  }
  if (data.length) await request(options => sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: plan.sheetId,
    resource: { valueInputOption: "USER_ENTERED", data },
  }, options));
}

function completedMessages(plan, completedBatches, files) {
  const linked = new Map(files.map(({ orderId, tracking }) => [orderId, tracking]));
  const indexes = new Set(Array.isArray(completedBatches) ? completedBatches : []);
  return plan.batches.flatMap((batch, index) =>
    indexes.has(index) && batch.confirmable && batch.orders.length &&
    batch.orders.every(({ orderId, tracking }) => tracking && linked.get(orderId) === tracking)
      ? [batch.messageId]
      : [],
  );
}

module.exports = {
  DRIVE_SCOPE, MAX_UPLOAD_BYTES, parseDriveFolder, checkDriveFolder, planOrders,
  readVerifiedFiles, saveDriveFiles, sheetRows, writeDriveLinks, completedMessages,
};
