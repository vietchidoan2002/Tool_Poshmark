import { test } from "node:test";
import assert from "node:assert/strict";
import { extractOrderId, pdfText, recognizeLabel } from "../src/label-text.js";
const id = "abcdef0123456789abcdef01";

test("PDF text is ordered by page coordinates instead of content-stream order", () => {
  const item = (str, x, y) => ({ str, transform: [10, 0, 0, 10, x, y] });
  const text = pdfText({
    items: [
      item("Address", 10, 50),
      item(id, 70, 100),
      item("Order #", 10, 100),
    ],
  });
  assert.equal(text, `Order # ${id}\nAddress`);
  assert.equal(extractOrderId(text), id);
});
test("extracts wrapped and spaced IDs; supports Order Number and ID markers", () => {
  for (const marker of ["Order #", "Order Number:", "Order ID:", "ORDER ＃"]) {
    assert.equal(
      extractOrderId(
        `${marker}\n${id.slice(0, 12)} \n ${id.slice(12)}\nSHIP TO`,
      ),
      id,
    );
  }
});
test("OCR corrections apply only to anchored OCR candidates", () => {
  const corrupted = "abcdefO123456789abcdefO1";
  assert.equal(extractOrderId(`Order # ${corrupted}`, { ocr: true }), id);
  assert.equal(extractOrderId(`Order # ${corrupted}`), "");
  for (const text of [
    id,
    `Tracking # ${id}`,
    `Order # ${id}a`,
    "Order # abc address def0123456789abcdef01",
  ])
    assert.equal(extractOrderId(text, { ocr: true }), "");
});
test("OCR recognizes once, uses automatic layout and cleans up", async () => {
  let calls = 0,
    terminated = false;
  const modes = [];
  const result = await recognizeLabel({}, async () => ({
    setParameters: async (p) => modes.push(p.tessedit_pageseg_mode),
    recognize: async () => {
      calls++;
      return {
        data: {
          text: `Order # ${id}`,
          blocks: [
            {
              paragraphs: [
                { lines: [{ words: [{ text: id, confidence: 95 }] }] },
              ],
            },
          ],
        },
      };
    },
    terminate: async () => {
      terminated = true;
    },
  }));
  assert.equal(calls, 1);
  assert.deepEqual(modes, ["3"]);
  assert.equal(result.orderId, id);
  assert.equal(terminated, true);
});
test("OCR errors propagate with worker cleanup", async () => {
  let terminated = false;
  await assert.rejects(
    recognizeLabel({}, async () => ({
      setParameters: async () => {},
      recognize: async () => {
        throw Error("worker failed");
      },
      terminate: async () => {
        terminated = true;
      },
    })),
    /worker failed/,
  );
  assert.equal(terminated, true);
});

test("valid-looking IDs with low OCR confidence are not auto-filled", async () => {
  const result = await recognizeLabel({}, async () => ({
    setParameters: async () => {},
    recognize: async () => ({
      data: {
        text: `Order # ${id}`,
        blocks: [
          {
            paragraphs: [
              { lines: [{ words: [{ text: id, confidence: 31 }] }] },
            ],
          },
        ],
      },
    }),
    terminate: async () => {},
  }));
  assert.equal(result.orderId, "");
  assert.match(result.warning, /tin cậy thấp/);
});
test("missing Order ID is clearly flagged without repeating recognition", async () => {
  let calls = 0;
  const result = await recognizeLabel({}, async () => ({
    setParameters: async () => {},
    recognize: async () => {
      calls++;
      return { data: { text: "unreadable" } };
    },
    terminate: async () => {},
  }));
  assert.equal(calls, 1);
  assert.equal(result.orderId, "");
  assert.match(result.warning, /Chưa đọc được/);
});

test("USPS numeric and international tracking are read only next to the tracking marker", async () => {
  const { extractUspsTracking } = await import("../src/label-text.js");
  for (const text of [
    "USPS TRACKING #\n9434 6501 1083 7019 9258 38",
    "USPS Tracking Number: 9434650110837019925838",
  ]) {
    assert.equal(extractUspsTracking(text), "9434650110837019925838");
  }
  assert.equal(
    extractUspsTracking("USPS TRACKING #\nEC123456789US"),
    "EC123456789US",
  );
  for (const text of [
    "9434650110837019925838",
    "Order # 9434650110837019925838",
    "USPS TRACKING # 94346501108370199258X8",
    "USPS TRACKING # 943465011083701992583",
  ])
    assert.equal(extractUspsTracking(text), "");
  assert.equal(
    extractUspsTracking(
      "USPS TRACKING # 9434650110837019925838\nUSPS TRACKING # 9434650110837019925839",
    ),
    "",
  );
});
test("conflicting tracking markers in one scan are left blank", async () => {
  const result = await recognizeLabel({}, async () => ({
    setParameters: async () => {},
    recognize: async () => ({
      data: {
        text: "USPS TRACKING # 9434650110837019925838\nUSPS TRACKING # 9434650110837019925839",
      },
    }),
    terminate: async () => {},
  }));
  assert.equal(result.tracking, "");
});
test("OCR failure is not retried automatically", async () => {
  let calls = 0;
  await assert.rejects(
    recognizeLabel({}, async () => ({
      setParameters: async () => {},
      recognize: async () => {
        calls++;
        throw Error("failed");
      },
      terminate: async () => {},
    })),
    /failed/,
  );
  assert.equal(calls, 1);
});
test("stalled OCR initialization times out and cleans up a worker that arrives late", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let resolveWorker,
    terminated = false;
  const pending = recognizeLabel(
    {},
    () =>
      new Promise((resolve) => {
        resolveWorker = resolve;
      }),
  );
  const rejected = assert.rejects(pending, /OCR quá 45 giây/);
  t.mock.timers.tick(45001);
  await rejected;
  resolveWorker({
    terminate: async () => {
      terminated = true;
    },
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(terminated, true);
});

test("conflicting order IDs on the same page are not auto-selected", () => {
  assert.equal(
    extractOrderId(`Order # ${id}\nOrder # 0123456789abcdef01234567`),
    "",
  );
  assert.equal(extractOrderId(`Order # ${id}\nOrder # ${id}`), id);
});
