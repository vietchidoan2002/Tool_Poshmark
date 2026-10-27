import { test } from "node:test";
import assert from "node:assert/strict";
import {
  exportPlan,
  exportManifest,
  safeName,
  contentBounds,
  imagePlacement,
} from "../src/label-export.js";
const id = "abcdef0123456789abcdef01";
const jobs = (names) => [
  {
    key: "job",
    fileName: "labels.pdf",
    pages: names.map((outputName, i) => ({
      pageNo: i + 1,
      orderId: id,
      outputName,
      tracking: "9434650110837019925838",
    })),
  },
];

test("default scan name exports directly; custom, short and missing names need review", () => {
  const plan = exportPlan(jobs([id, "Đơn hàng của tôi", "abc123", ""]));
  assert.equal(plan[0].warnings.length, 0);
  assert.equal(plan[0].name, id + ".pdf");
  assert.ok(plan[1].warnings.length);
  assert.equal(plan[1].name, "Đơn hàng của tôi.pdf");
  assert.ok(plan[2].warnings.length);
  assert.equal(plan[3].name, "labels-trang-4.pdf");
  assert.ok(plan[3].warnings.length);
});
test("case-insensitive duplicates, including generated suffixes, never overwrite", () => {
  const plan = exportPlan(
    jobs(["Test", "test", "Test (2)", "TEST", "test.pdf"]),
  );
  assert.equal(new Set(plan.map((x) => x.name.toLowerCase())).size, 5);
  assert.equal(plan[1].name, "test (2).pdf");
  assert.ok(plan[1].warnings.some((x) => x.includes("Trùng tên")));
});
test("custom filenames are safe on Windows and preserve Vietnamese", () => {
  for (const name of [
    "CON",
    "prn.txt",
    "a/b\\c:<test>?*",
    "../label",
    "a\x00b",
  ]) {
    const safe = safeName(name);
    assert.ok(!/[<>:"/\\|?*\x00-\x1f]/.test(safe));
    assert.ok(!/^(con|prn|aux|nul)(\.|$)/i.test(safe));
  }
  assert.equal(safeName("  Đơn áo số 1.PDF  "), "Đơn áo số 1");
  assert.equal(safeName("a".repeat(300)).length, 100);
  assert.equal(safeName("..."), "");
});
test("single-page plans do not export other pages", () => {
  const plan = exportPlan(jobs(["a", "b"]), { jobKey: "job", pageNo: 2 });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].name, "b.pdf");
  assert.deepEqual(exportPlan([], null), []);
});
test("CSV preserves order ID/tracking independently of renamed files and escapes formulas", () => {
  const entries = exportPlan(jobs(['=HYPERLINK("test")']));
  const csv = exportManifest(entries);
  assert.ok(csv.startsWith("\uFEFF"));
  assert.ok(csv.includes(id));
  assert.ok(csv.includes("9434650110837019925838"));
  assert.ok(csv.includes("\"'=HYPERLINK"));
  assert.ok(csv.includes('"File gốc"'));
});
test("blank/transparent pages are detected and edge content is not clipped", () => {
  const data = new Uint8ClampedArray(10 * 20 * 4).fill(255);
  assert.equal(contentBounds({ width: 10, height: 20, data }), null);
  data[0] = 0;
  const bounds = contentBounds({ width: 10, height: 20, data });
  assert.equal(bounds.left, 0);
  assert.equal(bounds.top, 0);
  const transparent = new Uint8ClampedArray(10 * 20 * 4);
  assert.equal(
    contentBounds({ width: 10, height: 20, data: transparent }),
    null,
  );
});
test("4x6 placement preserves square, portrait and landscape aspect ratios", () => {
  for (const [width, height] of [
    [400, 400],
    [600, 900],
    [900, 600],
  ]) {
    const bounds = { left: 0, top: 0, right: width - 1, bottom: height - 1 };
    const placement = imagePlacement(width, height, bounds);
    assert.equal(placement.width / placement.height, width / height);
    assert.ok(placement.x >= 0);
    assert.ok(placement.y >= 0);
    assert.ok(placement.width <= 288 + 1e-8);
    assert.ok(placement.height <= 432 + 1e-8);
  }
});
test("multibyte filenames stay below portable filesystem byte limits", () => {
  const name = safeName("😀".repeat(100));
  assert.ok(new TextEncoder().encode(name + " (100).pdf").length < 255);
});
