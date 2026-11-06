const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { chromium } = require("playwright-core");
const BASE = process.env.LABEL_TEST_URL || "http://127.0.0.1:3210";
let browser;
before(async () => {
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
});
after(() => browser.close());
const template = {
  version: 1,
  phoneVersion: 1,
  phoneReviewed: false,
  emailVerified: true,
  status: "active",
  gmailCount: 1,
  createdAt: new Date().toISOString(),
  lastSeenAt: new Date().toISOString(),
  skipped: 0,
  getRuns: 0,
  orders: 0,
  poshmarkCount: 0,
  isAdmin: false,
};
async function open(t, options = {}) {
  const { admin = true, mobile = false } = options;
  const context = await browser.newContext({
    viewport: { width: mobile ? 375 : 1280, height: 900 },
  });
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  const state = {
    users: [
      {
        ...template,
        id: "admin",
        name: "Admin",
        email: "admin@example.test",
        phone: "",
        isAdmin: true,
      },
      {
        ...template,
        id: "member",
        name: "Người dùng",
        email: "member@example.test",
        phone: "+84901234567",
        getRuns: 4,
        orders: 12,
        poshmarkCount: 2,
      },
    ],
    calls: [],
  };
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url()),
      path = url.pathname,
      method = route.request().method();
    if (path.startsWith("/api/")) {
      if (path.startsWith("/api/admin"))
        state.calls.push({
          path,
          method,
          search: url.search,
          body: method === "GET" ? null : route.request().postDataJSON(),
        });
      if (path === "/api/session")
        return route.fulfill({
          json: {
            webMode: true,
            authenticated: true,
            emailVerified: true,
            isAdmin: admin,
            userId: "admin",
          },
        });
      if (path === "/api/profile")
        return route.fulfill({
          json: {
            phone: "",
            version: 0,
            reviewed: false,
            phoneRequired: false,
            isAdmin: admin,
          },
        });
      if (path === "/api/config")
        return route.fulfill({ json: { sheetId: "" } });
      if (path === "/api/gmail/status")
        return route.fulfill({
          json: { credentialsPresent: true, accounts: [] },
        });
      if (path === "/api/admin/dashboard")
        return route.fulfill({
          json: {
            days: Number(url.searchParams.get("days") || 30),
            trackingSince: new Date(Date.now() - 20 * 86400000).toISOString(),
            users: {
              total: state.users.length,
              available: state.users.filter((u) => u.status !== "deleted")
                .length,
              deleted: state.users.filter((u) => u.status === "deleted").length,
              suspended: 0,
              verified: 2,
              gmailConnected: 2,
              active30: 2,
              new7: 1,
              previous7: 1,
              unknownCreated: 0,
            },
            usage: {
              getRuns: 4,
              getUsers: 1,
              orders: 12,
              skipped: 2,
              successful: 3,
              failed: 1,
              running: 0,
            },
            trend: [
              { day: "2026-11-05", orders: 5, runs: 2 },
              { day: "2026-11-06", orders: 7, runs: 2 },
            ],
          },
        });
      if (path === "/api/admin/users" && method === "GET") {
        const filter = url.searchParams.get("status"),
          search = url.searchParams.get("search") || "";
        return route.fulfill({
          json: {
            users: state.users.filter(
              (u) =>
                (filter === "deleted"
                  ? u.status === "deleted"
                  : u.status !== "deleted") &&
                (u.email.includes(search) || u.name.includes(search)),
            ),
            hasMore: false,
          },
        });
      }
      if (path === "/api/admin/users" && method === "POST") {
        const body = route.request().postDataJSON();
        if (state.users.some((u) => u.email === body.email))
          return route.fulfill({
            status: 409,
            json: { error: "Email đã được sử dụng." },
          });
        const user = {
          ...template,
          id: "new",
          name: body.name,
          email: body.email,
          phone: body.phone,
          gmailCount: 0,
          emailVerified: false,
        };
        state.users.push(user);
        return route.fulfill({
          status: 201,
          json: { ok: true, user, mailSent: false, mailError: "" },
        });
      }
      if (path.startsWith("/api/admin/users/")) {
        const parts = path.split("/"),
          id = decodeURIComponent(parts[4]),
          action = parts[5],
          user = state.users.find((u) => u.id === id);
        if (method === "GET")
          return route.fulfill({
            json: {
              user,
              accounts: [
                { name: "Shop One", runs: 3, orders: 9, skipped: 1 },
                { name: "Shop Two", runs: 1, orders: 3, skipped: 1 },
              ],
              runs: [
                {
                  id: "r",
                  accountName: "Shop One",
                  startedAt: new Date().toISOString(),
                  status: "success",
                  orders: 3,
                  skipped: 0,
                },
              ],
            },
          });
        const body = route.request().postDataJSON();
        if (method === "PUT")
          Object.assign(user, {
            name: body.name,
            phone: body.phone,
            status: body.status,
            version: user.version + 1,
          });
        else if (method === "DELETE")
          Object.assign(user, { status: "deleted", version: user.version + 1 });
        else if (action === "restore")
          Object.assign(user, { status: "active", version: user.version + 1 });
        return route.fulfill({ json: { ok: true, user } });
      }
      return route.fulfill({ json: { version: "local" } });
    }
    if (options.blockChunk && /AdminDashboard.*\.js$/.test(path))
      return route.abort();
    if (url.origin === new URL(BASE).origin) return route.continue();
    if (url.hostname === "fonts.googleapis.com")
      return route.fulfill({ contentType: "text/css", body: "" });
    return route.abort();
  });
  await page.goto(BASE + "/#/admin");
  return { page, state };
}
test("admin dashboard displays real metric fields, changes periods and opens account details", async (t) => {
  const { page, state } = await open(t);
  await page
    .getByRole("heading", { name: "Dashboard quản trị", exact: true })
    .waitFor();
  await page
    .getByRole("heading", { name: "Quản lý tài khoản", exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Quản trị", exact: true })
      .getAttribute("aria-pressed"),
    "true",
  );
  await page.getByLabel("Khoảng thời gian").selectOption("7");
  await page.waitForFunction(
    () => document.querySelector(".admin-period select").value === "7",
  );
  await page
    .getByRole("row")
    .filter({ hasText: "member@example.test" })
    .getByRole("button", { name: "Chi tiết", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("heading", { name: "Chi tiết tài khoản", exact: true })
    .waitFor();
  await dialog.getByText("Shop Two", { exact: true }).waitFor();
  assert.ok(
    state.calls.some(
      (call) =>
        call.path === "/api/admin/dashboard" && call.search.includes("days=7"),
    ),
  );
  await dialog.getByRole("button", { name: "Đóng", exact: true }).click();
});
test("admin can create, edit, send setup mail, delete and restore from the dashboard", async (t) => {
  const { page, state } = await open(t);
  await page
    .getByRole("button", { name: "+ Thêm tài khoản", exact: true })
    .click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Họ và tên", { exact: true }).fill("Tài khoản mới");
  await dialog
    .getByLabel("Email đăng nhập", { exact: true })
    .fill("new@example.test");
  await dialog.getByLabel("Số điện thoại", { exact: true }).fill("0901234567");
  await dialog.getByRole("checkbox").uncheck();
  await dialog
    .getByRole("button", { name: "Tạo tài khoản", exact: true })
    .click();
  let row = page.getByRole("row").filter({ hasText: "new@example.test" });
  await row.waitFor();
  assert.equal(
    state.calls.find(
      (call) => call.path === "/api/admin/users" && call.method === "POST",
    ).body.sendInvite,
    false,
  );
  await row.getByRole("button", { name: "Sửa", exact: true }).click();
  dialog = page.getByRole("dialog");
  assert.equal(
    await dialog
      .getByLabel("Email đăng nhập", { exact: true })
      .getAttribute("readonly"),
    "",
  );
  await dialog.getByLabel("Họ và tên", { exact: true }).fill("Tên đã sửa");
  await dialog
    .getByRole("button", { name: "Lưu thay đổi", exact: true })
    .click();
  await row.getByText("Tên đã sửa", { exact: true }).waitFor();
  page.once("dialog", (d) => d.accept());
  await row.getByRole("button", { name: "Gửi thư", exact: true }).click();
  await page
    .getByText("Đã gửi email thiết lập mật khẩu.", { exact: true })
    .waitFor();
  page.once("dialog", (d) => d.dismiss());
  await row.getByRole("button", { name: "Xóa", exact: true }).click();
  assert.equal(await row.count(), 1);
  page.once("dialog", (d) => d.accept());
  await row.getByRole("button", { name: "Xóa", exact: true }).click();
  await row.waitFor({ state: "detached" });
  await page
    .locator(".admin-filters")
    .getByLabel("Trạng thái", { exact: true })
    .selectOption("deleted");
  await row.waitFor();
  await row.getByRole("button", { name: "Khôi phục", exact: true }).click();
  await row.waitFor({ state: "detached" });
  await page
    .locator(".admin-filters")
    .getByLabel("Trạng thái", { exact: true })
    .selectOption("all");
  await row.waitFor();
});
test("duplicate creation stays in the form and does not report a new account", async (t) => {
  const { page, state } = await open(t);
  await page
    .getByRole("button", { name: "+ Thêm tài khoản", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Họ và tên", { exact: true }).fill("Duplicate");
  await dialog
    .getByLabel("Email đăng nhập", { exact: true })
    .fill("member@example.test");
  await dialog.getByLabel("Số điện thoại", { exact: true }).fill("0901234567");
  await dialog
    .getByRole("button", { name: "Tạo tài khoản", exact: true })
    .click();
  await dialog.getByRole("alert").waitFor();
  assert.equal(state.users.length, 2);
  assert.equal(
    await dialog.getByLabel("Email đăng nhập", { exact: true }).inputValue(),
    "member@example.test",
  );
});
test("non-admin opening the dashboard URL cannot see or request administrator data", async (t) => {
  const { page, state } = await open(t, { admin: false });
  await page
    .getByRole("heading", { name: "Không có quyền quản trị", exact: true })
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Quản trị", exact: true }).count(),
    0,
  );
  assert.equal(state.calls.length, 0);
});
test("dashboard and account editor fit a mobile screen", async (t) => {
  const { page } = await open(t, { mobile: true });
  await page
    .getByRole("heading", { name: "Quản lý tài khoản", exact: true })
    .waitFor();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page
    .getByRole("button", { name: "+ Thêm tài khoản", exact: true })
    .click();
  const box = await page.getByRole("dialog").boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 375);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Hủy", exact: true })
    .click();
});

test("a dashboard chunk download failure shows a retry page and recovers after reload", async (t) => {
  const options = { blockChunk: true };
  const { page } = await open(t, options);
  await page
    .getByRole("heading", { name: "Chưa mở được trang quản trị", exact: true })
    .waitFor();
  options.blockChunk = false;
  await page
    .getByRole("button", { name: "Tải lại trang quản trị", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Dashboard quản trị", exact: true })
    .waitFor();
});
