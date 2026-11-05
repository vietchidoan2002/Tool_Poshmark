const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright-core");
const { PDFDocument, StandardFonts, degrees } = require("pdf-lib");
const { unzipSync, strFromU8 } = require("fflate");
const BASE = process.env.LABEL_TEST_URL || "http://127.0.0.1:5173";
const ID = "abcdef0123456789abcdef01";
const TRACKING = "9434650110837019925838";
let browser, tmp;
before(async () => {
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "label-tests-"));
});
after(async () => {
  await browser?.close();
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

async function fixture({
  pages = 1,
  blank = false,
  rotate = 0,
  ids = [],
} = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([288, 432]);
    page.setRotation(degrees(rotate));
    if (!blank) {
      // Deliberately shuffle content-stream order.
      page.drawText(ids[i] || ID, { x: 74, y: 360, size: 9, font });
      page.drawText("USPS TRACKING #", { x: 25, y: 120, size: 10, font });
      page.drawText(TRACKING, { x: 25, y: 100, size: 10, font });
      page.drawText("Order #", { x: 20, y: 360, size: 9, font });
      page.drawText("SAMPLE LABEL", { x: 25, y: 200, size: 14, font });
    }
  }
  return Buffer.from(await doc.save());
}
async function open(t, options = {}) {
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1100, height: 900 },
  });
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = [];
  page.ocrCount = 0;
  page.on("console", (message) => {
    if (message.text() === "LABEL_TEST_RECOGNIZE") page.ocrCount++;
  });
  page.on("worker", (worker) =>
    worker
      .evaluate(() => {
        self.addEventListener("message", (event) => {
          if (event.data?.action === "recognize")
            console.info("LABEL_TEST_RECOGNIZE");
        });
      })
      .catch(() => {}),
  );
  page.on("pageerror", (e) => errors.push(e.message));
  t.after(() => {
    if (options.blockOCR) {
      assert.equal(errors.length, 1, "one expected worker-loading failure");
      assert.match(
        errors[0],
        /Failed to execute 'importScripts'.*worker\.min/s,
      );
    } else assert.deepEqual(errors, [], "unexpected browser errors");
  });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
      if (url.pathname === "/api/session" && options.sessionFailure)
        return route.fulfill({
          status: 503,
          json: { error: "test unavailable" },
        });
      if (url.pathname === "/api/session" && options.webMode)
        return route.fulfill({
          json: {
            webMode: true,
            authenticated: !!options.signedIn,
            userId: options.signedIn ? "test-user" : null,
          },
        });
      if (url.pathname === "/api/session" && !options.webMode)
        return route.fulfill({ json: { webMode: false, authenticated: true } });
      if (url.pathname === "/api/profile" && options.webMode)
        return route.fulfill({
          json: options.phoneProfile || {
            phone: "",
            version: 0,
            reviewed: false,
            isAdmin: false,
            phoneRequired: false,
          },
        });
      if (url.pathname === "/api/profile/phone" && options.phoneProfile) {
        const body = route.request().postDataJSON();
        options.phoneProfile = {
          ...options.phoneProfile,
          phone: "+84901234567",
          version: options.phoneProfile.version + 1,
          reviewed: false,
        };
        return route.fulfill({ json: options.phoneProfile });
      }
      if (url.pathname === "/api/admin/phones" && options.phoneUsers)
        return route.fulfill({
          json: { users: options.phoneUsers, hasMore: false },
        });
      if (url.pathname.startsWith("/api/admin/phones/") && options.phoneUsers) {
        const id = url.pathname.split("/")[4];
        const user = options.phoneUsers.find((user) => user.id === id);
        const body = route.request().postDataJSON();
        if (url.pathname.endsWith("/review")) user.reviewed = body.reviewed;
        else {
          user.phone = route.request().method() === "DELETE" ? "" : body.phone;
          user.reviewed = false;
        }
        user.version++;
        return route.fulfill({ json: user });
      }
      if (url.pathname === "/api/version" && options.newVersion)
        return route.fulfill({ json: { version: "test-new-version" } });
      if (url.pathname.startsWith("/api/"))
        return route.fulfill({
          json: url.pathname.endsWith("/config")
            ? { sheetId: options.sheetId ?? "" }
            : { credentialsPresent: false, accounts: [] },
        });
      if (
        options.blockOCR &&
        !url.search &&
        /worker\.min.*\.js/.test(url.pathname) &&
        !url.pathname.includes("pdf.worker")
      )
        return route.abort();
      return route.continue();
    }
    // Tests require OCR to work without any external asset fetches.
    if (url.hostname === "fonts.googleapis.com")
      return route.fulfill({ contentType: "text/css", body: "" });
    return route.abort();
  });
  await page.goto(BASE);
  await page.getByRole("button", { name: /Cut Label/ }).click();
  return page;
}
async function upload(page, files, count) {
  await page.locator("input[type=file]").setInputFiles(files);
  await page.waitForFunction(
    (n) =>
      document.querySelectorAll(".page").length === n &&
      !document.querySelector(".spinner"),
    count,
    { timeout: 90000 },
  );
}
const pdf = (buffer, name = "labels.pdf") => ({
  name,
  mimeType: "application/pdf",
  buffer,
});
async function saved(download, file) {
  await download.saveAs(file);
  return fs.readFile(file);
}
async function checkPdf(bytes) {
  const doc = await PDFDocument.load(bytes);
  assert.equal(doc.getPageCount(), 1);
  assert.deepEqual(doc.getPage(0).getSize(), { width: 288, height: 432 });
}

test("native PDF defaults to scanned ID, tracking is separate, exported PDF opens and can be downloaded again", async (t) => {
  const page = await open(t);
  await upload(page, pdf(await fixture()), 1);
  assert.equal(await page.locator(".page input").inputValue(), ID);
  assert.equal(page.ocrCount, 0, "native text must not trigger OCR");
  assert.equal(
    await page.locator(".tracking-check output").textContent(),
    TRACKING,
  );
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "Xuất trang này" }).click();
  const download = await pending;
  assert.equal(download.suggestedFilename(), ID + ".pdf");
  await checkPdf(await saved(download, path.join(tmp, "native.pdf")));
  assert.equal(
    await page.getByRole("link", { name: "Xem PDF vừa xuất" }).count(),
    1,
  );
  const again = page.waitForEvent("download");
  await page.getByRole("link", { name: "Tải lại file" }).click();
  assert.equal((await again).suggestedFilename(), ID + ".pdf");
});

test("custom short name prompts; cancel and Escape download nothing; confirm permits the custom name", async (t) => {
  const page = await open(t);
  await upload(page, pdf(await fixture()), 1);
  let downloads = 0;
  page.on("download", () => downloads++);
  await page.locator(".page input").fill("Đơn áo số 1");
  await page.getByRole("button", { name: "Xuất trang này" }).click();
  assert.equal(await page.getByRole("dialog").count(), 1);
  assert.match(
    await page.getByRole("dialog").textContent(),
    /labels.pdf.*trang 1/s,
  );
  await page.getByRole("button", { name: "Quay lại sửa" }).click();
  assert.equal(downloads, 0);
  await page.getByRole("button", { name: "Xuất trang này" }).click();
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("dialog").count(), 0);
  assert.equal(downloads, 0);
  assert.match(
    await page.locator(".page .field small").textContent(),
    new RegExp(ID),
  );
  await page.getByRole("button", { name: "Xuất trang này" }).click();
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "Tiếp tục xuất 1 trang" }).click();
  assert.equal((await pending).suggestedFilename(), "Đơn áo số 1.pdf");
});

test("batch ZIP reviews missing and duplicate names; includes every PDF and a tracking manifest", async (t) => {
  const page = await open(t);
  await upload(page, pdf(await fixture({ pages: 3 })), 3);
  const inputs = page.locator(".page input");
  await inputs.nth(0).fill("Áo");
  await inputs.nth(1).fill("áo");
  await inputs.nth(2).fill("");
  await page.getByRole("button", { name: "Xuất tất cả", exact: true }).click();
  const dialog = page.getByRole("dialog");
  assert.equal(await dialog.locator("li").count(), 3);
  assert.match(await dialog.textContent(), /labels-trang-3.pdf/);
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "Tiếp tục xuất 3 trang" }).click();
  const download = await pending;
  assert.equal(download.suggestedFilename(), "poshmark-labels.zip");
  const zip = unzipSync(await saved(download, path.join(tmp, "batch.zip")));
  assert.deepEqual(
    Object.keys(zip).sort(),
    [
      "Áo.pdf",
      "áo (2).pdf",
      "labels-trang-3.pdf",
      "danh-sach-label.csv",
    ].sort(),
  );
  for (const [name, bytes] of Object.entries(zip))
    if (name.endsWith(".pdf")) await checkPdf(bytes);
  const csv = strFromU8(zip["danh-sach-label.csv"]);
  assert.ok(csv.includes(ID));
  assert.ok(csv.includes(TRACKING));
  assert.ok(csv.includes("áo (2).pdf"));
});

test("corrupt/non-PDF and password-protected inputs do not discard a valid neighboring file", async (t) => {
  const page = await open(t);
  await upload(
    page,
    [
      pdf(Buffer.from("not a PDF"), "broken.pdf"),
      {
        name: "notes.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("notes"),
      },
      pdf(
        await fs.readFile(
          path.join(__dirname, "../fixtures/password-protected.pdf"),
        ),
        "locked.pdf",
      ),
      pdf(await fixture(), "good.pdf"),
    ],
    1,
  );
  const errors = await page.getByRole("alert").allTextContents();
  assert.match(errors.join(" "), /broken.pdf/);
  assert.match(errors.join(" "), /notes.txt/);
  assert.match(errors.join(" "), /locked.pdf.*mật khẩu/s);
  assert.equal(await page.locator(".jobname b").textContent(), "good.pdf");
});

test("OCR download failure preserves pages and allows a custom filename", async (t) => {
  const page = await open(t, { blockOCR: true });
  await upload(page, pdf(await fixture({ blank: true })), 1);
  assert.match(
    (await page.getByRole("alert").allTextContents()).join(" "),
    /Không đọc được OCR/,
  );
  await page.locator(".page input").fill("manual");
  assert.equal(
    await page.getByRole("button", { name: "Xuất trang này" }).isEnabled(),
    true,
  );
});

test("blank pages fail export explicitly; valid pages still export and errors are listed", async (t) => {
  const page = await open(t);
  const valid = await fixture();
  const blank = await fixture({ blank: true });
  await upload(page, [pdf(valid, "good.pdf"), pdf(blank, "blank.pdf")], 2);
  await page.getByRole("button", { name: "Xuất tất cả", exact: true }).click();
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "Tiếp tục xuất 2 trang" }).click();
  const zip = unzipSync(
    await saved(await pending, path.join(tmp, "partial.zip")),
  );
  assert.ok(zip[ID + ".pdf"]);
  assert.ok(zip["loi-xuat.txt"]);
  assert.match(strFromU8(zip["loi-xuat.txt"]), /blank.pdf.*Trang trắng/s);
  assert.match(
    await page.locator(".status").textContent(),
    /1\/2 trang.*1 trang lỗi/,
  );
  assert.match(
    (await page.getByRole("alert").allTextContents()).join(" "),
    /Trang trắng/,
  );
});

test("metadata-rotated PDFs preserve native ID/tracking and export at 4x6", async (t) => {
  const page = await open(t);
  await upload(page, pdf(await fixture({ rotate: 90 })), 1);
  assert.equal(await page.locator(".page input").inputValue(), ID);
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "Xuất trang này" }).click();
  await checkPdf(await saved(await pending, path.join(tmp, "rotated.pdf")));
});

test("clear removes results and permits a fresh import", async (t) => {
  const page = await open(t);
  await upload(page, pdf(await fixture()), 1);
  await page.getByRole("button", { name: "Xóa danh sách" }).click();
  assert.equal(await page.locator(".page").count(), 0);
  await upload(page, pdf(await fixture()), 1);
  assert.equal(await page.locator(".page input").inputValue(), ID);
});

test("real offline OCR reads a scanned image-only numeric label and USPS tracking", async (t) => {
  const page = await open(t);
  const image = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 1200;
    canvas.height = 1800;
    const c = canvas.getContext("2d");
    c.fillStyle = "white";
    c.fillRect(0, 0, 1200, 1800);
    c.fillStyle = "black";
    c.font = "36px monospace";
    c.fillText("Order # 012345678901234567890123", 50, 180);
    c.font = "36px sans-serif";
    c.fillText("USPS TRACKING #", 50, 1000);
    c.fillText("9434650110837019925838", 50, 1060);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  const doc = await PDFDocument.create();
  const img = await doc.embedPng(Buffer.from(image, "base64"));
  doc
    .addPage([288, 432])
    .drawImage(img, { x: 0, y: 0, width: 288, height: 432 });
  await upload(page, pdf(Buffer.from(await doc.save())), 1);
  assert.equal(
    await page.locator(".page input").inputValue(),
    "012345678901234567890123",
  );
  assert.equal(
    await page.locator(".tracking-check output").textContent(),
    TRACKING,
  );
  assert.equal(
    page.ocrCount,
    1,
    "image-only page must run recognition exactly once",
  );
});

test("unique valid default names batch-export directly without a confirmation", async (t) => {
  const page = await open(t);
  const second = "0123456789abcdef01234567";
  await upload(page, pdf(await fixture({ pages: 2, ids: [ID, second] })), 2);
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "Xuất tất cả", exact: true }).click();
  const zip = unzipSync(
    await saved(await pending, path.join(tmp, "defaults.zip")),
  );
  assert.ok(zip[ID + ".pdf"]);
  assert.ok(zip[second + ".pdf"]);
  assert.equal(await page.getByRole("dialog").count(), 0);
});

test("busy import disables rename, export, and clear; duplicate clicks cannot start an export", async (t) => {
  const page = await open(t);
  await upload(page, pdf(await fixture()), 1);
  await page.route("**/*worker.min*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.continue();
  });
  await page
    .locator("input[type=file]")
    .setInputFiles(pdf(await fixture({ blank: true }), "slow.pdf"));
  await page.waitForSelector(".spinner");
  assert.equal(await page.locator(".page input").isDisabled(), true);
  assert.equal(
    await page.getByRole("button", { name: "Xóa danh sách" }).isDisabled(),
    true,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Xuất tất cả", exact: true })
      .isDisabled(),
    true,
  );
  await page.waitForFunction(
    () => !document.querySelector(".spinner"),
    {},
    { timeout: 90000 },
  );
});

test(
  "supplied reference label matches its expected Order ID and tracking",
  { skip: !process.env.LABEL_SAMPLE_PDF },
  async (t) => {
    const page = await open(t);
    await upload(
      page,
      pdf(
        await fs.readFile(process.env.LABEL_SAMPLE_PDF),
        "reference-label.pdf",
      ),
      1,
    );
    assert.equal(
      await page.locator(".page input").inputValue(),
      process.env.LABEL_SAMPLE_ORDER_ID,
    );
    if (process.env.LABEL_SAMPLE_TRACKING)
      assert.equal(
        await page.locator(".tracking-check output").textContent(),
        process.env.LABEL_SAMPLE_TRACKING,
      );
    const pending = page.waitForEvent("download");
    await page.getByRole("button", { name: "Xuất trang này" }).click();
    const download = await pending;
    assert.equal(
      download.suggestedFilename(),
      process.env.LABEL_SAMPLE_ORDER_ID + ".pdf",
    );
    await checkPdf(await saved(download, path.join(tmp, "reference.pdf")));
  },
);

test("mobile layout fits the screen and warnings remain readable", async (t) => {
  const page = await open(t);
  await page.setViewportSize({ width: 375, height: 812 });
  await upload(
    page,
    pdf(
      await fixture(),
      "a-very-long-original-shipping-label-filename-that-must-wrap.pdf",
    ),
    1,
  );
  assert.equal(await page.getByLabel("Lưu ý trước khi xuất").isVisible(), true);
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  );
  await page.locator(".page input").fill("Tên tùy chỉnh");
  await page.getByRole("button", { name: "Xuất trang này" }).click();
  assert.equal(await page.getByRole("dialog").isVisible(), true);
  await page.getByRole("button", { name: "Quay lại sửa" }).click();
  assert.equal(await page.getByRole("dialog").count(), 0);
});

test("upload is keyboard-focusable and missing tracking is clearly shown", async (t) => {
  const page = await open(t, { blockOCR: true });
  await page.getByLabel("Thêm file PDF").focus();
  assert.equal(
    await page
      .getByLabel("Thêm file PDF")
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await upload(page, pdf(await fixture({ blank: true })), 1);
  assert.equal(
    await page.locator(".tracking-check output").textContent(),
    "Chưa đọc được mã tracking",
  );
  assert.equal(await page.getByRole("alert").isVisible(), true);
});

test("Spreadsheet ID starts empty with hidden help; saved IDs persist", async (t) => {
  for (const stored of ["", "PASTE_GOOGLE_SHEET_ID_HERE", ID]) {
    const page = await open(t, { sheetId: stored });
    await page.getByRole("button", { name: /Get Label/ }).click();
    await page
      .getByRole("button", { name: "Cập nhật tài khoản Gmail" })
      .click();
    await page.waitForFunction(
      (expected) =>
        document.querySelector(".configbox input")?.value === expected,
      stored === ID ? ID : "",
    );
    const input = page.getByLabel("Spreadsheet ID", { exact: true });
    assert.equal(await input.inputValue(), stored === ID ? ID : "");
    assert.equal(await input.getAttribute("placeholder"), "");
    assert.equal(
      await page.locator("#sheet-id-help").getAttribute("open"),
      null,
    );
    await page.getByText("Cách lấy Spreadsheet ID", { exact: true }).click();
    assert.equal(await page.locator("#sheet-id-help").getAttribute("open"), "");
    assert.equal(
      await page.getByRole("button", { name: "Làm mới trạng thái" }).count(),
      0,
    );
  }
});

test("refreshing Gmail does not overwrite an unsaved Sheet ID", async (t) => {
  const page = await open(t, { sheetId: ID });
  await page.getByRole("button", { name: /Get Label/ }).click();
  await page
    .getByLabel("Spreadsheet ID", { exact: true })
    .fill("unsaved-sheet-id");
  const response = page.waitForResponse((r) =>
    r.url().endsWith("/api/gmail/status"),
  );
  await page.getByRole("button", { name: "Cập nhật tài khoản Gmail" }).click();
  await response;
  assert.equal(
    await page.getByLabel("Spreadsheet ID", { exact: true }).inputValue(),
    "unsaved-sheet-id",
  );
});

test("web guests can use Cut Label without exposing Gmail configuration", async (t) => {
  const page = await open(t, { webMode: true });
  await page.getByRole("button", { name: /Get Label/ }).click();
  assert.equal(
    await page
      .getByRole("button", { name: "Đăng nhập bằng Google" })
      .isVisible(),
    true,
  );
  assert.equal(
    await page.getByLabel("Spreadsheet ID", { exact: true }).count(),
    0,
  );
  await page.getByRole("button", { name: /Cut Label/ }).click();
  await upload(page, pdf(await fixture()), 1);
  assert.equal(await page.locator(".page input").inputValue(), ID);
});

test("version notice never reloads a page containing unexported labels", async (t) => {
  const page = await open(t, { newVersion: true });
  await upload(page, pdf(await fixture()), 1);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.getByRole("button", { name: "Tải phiên bản mới" }).waitFor();
  assert.equal(await page.locator(".page").count(), 1);
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Tải phiên bản mới" }).click();
  assert.equal(await page.locator(".page").count(), 1);
});

test("signed-in users can save a phone without claiming SMS or SIM verification", async (t) => {
  const page = await open(t, {
    webMode: true,
    signedIn: true,
    phoneProfile: {
      phone: "",
      version: 0,
      reviewed: false,
      isAdmin: false,
      phoneRequired: true,
    },
  });
  await page.getByRole("button", { name: /Get Label/ }).click();
  await page
    .getByLabel("Số điện thoại của bạn", { exact: true })
    .fill("0901 234 567");
  await page
    .getByRole("button", { name: "Lưu số điện thoại", exact: true })
    .click();
  await page.waitForFunction(
    () => document.querySelector("input[type=tel]")?.value === "+84901234567",
  );
  assert.equal(
    await page.getByText("Chưa kiểm tra", { exact: true }).isVisible(),
    true,
  );
  assert.equal(
    await page
      .getByText("Quản trị · số điện thoại người dùng", { exact: true })
      .count(),
    0,
  );
});

test("phone admin can list, edit, review and cancel or confirm deletion", async (t) => {
  const users = [
    {
      id: "B",
      email: "b@example.test",
      phone: "+84901234567",
      version: 1,
      reviewed: false,
    },
  ];
  const page = await open(t, {
    webMode: true,
    signedIn: true,
    phoneProfile: {
      phone: "",
      version: 0,
      reviewed: false,
      isAdmin: true,
      phoneRequired: true,
    },
    phoneUsers: users,
  });
  await page.getByRole("button", { name: /Get Label/ }).click();
  await page
    .getByText("Quản trị · số điện thoại người dùng", { exact: true })
    .click();
  await page.getByRole("button", { name: "Tìm / tải danh sách" }).click();
  const input = page.getByLabel("Số điện thoại · b@example.test", {
    exact: true,
  });
  await input.fill("+84902345678");
  await page.getByRole("button", { name: "Lưu số", exact: true }).click();
  await page
    .getByRole("button", { name: "Xác nhận đã kiểm tra thủ công" })
    .click();
  await page.getByRole("button", { name: "Bỏ đánh dấu kiểm tra" }).waitFor();
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Xóa số", exact: true }).click();
  assert.equal(await input.inputValue(), "+84902345678");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Xóa số", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector(".phone-account input")?.value === "",
  );
});

test("web login and registration are visible from Cut Label and use the Google account flow", async (t) => {
  const page = await open(t, { webMode: true });
  assert.equal(
    await page
      .getByRole("button", { name: "Đăng nhập", exact: true })
      .isVisible(),
    true,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Đăng ký", exact: true })
      .isVisible(),
    true,
  );
  await page.route("**/api/auth/start", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "Test Google authentication entrypoint",
    }),
  );
  await page.getByRole("button", { name: "Đăng ký", exact: true }).click();
  await page.waitForURL("**/api/auth/start");
});

test("failed session lookup is visible and retry restores login without discarding labels", async (t) => {
  const options = { webMode: true, sessionFailure: true };
  const page = await open(t, options);
  await page.getByRole("button", { name: "Thử lại kết nối" }).waitFor();
  await upload(page, pdf(await fixture()), 1);
  options.sessionFailure = false;
  await page.getByRole("button", { name: "Thử lại kết nối" }).click();
  await page.getByRole("button", { name: "Đăng nhập", exact: true }).waitFor();
  assert.equal(await page.locator(".page input").inputValue(), ID);
  assert.equal(
    await page.getByRole("button", { name: "Thử lại kết nối" }).count(),
    0,
  );
});
