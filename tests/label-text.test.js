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
test("OCR falls back to sparse layout and always cleans up its worker", async () => {
  const modes = [];
  let calls = 0,
    terminated = false;
  const result = await recognizeLabel({}, async () => ({
    setParameters: async (p) => modes.push(p.tessedit_pageseg_mode),
    recognize: async () => ({
      data: {
        text: ++calls === 1 ? "unreadable" : `Order # ${id}`,
        blocks: [
          {
            paragraphs: [
              { lines: [{ words: [{ text: id, confidence: 95 }] }] },
            ],
          },
        ],
      },
    }),
    terminate: async () => {
      terminated = true;
    },
  }));
  assert.equal(result.orderId, id);
  assert.deepEqual(modes, ["3", "11"]);
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
test("conflicting OCR readings require manual review even at high confidence", async () => {
  let calls = 0;
  const result = await recognizeLabel({}, async () => ({
    setParameters: async () => {},
    recognize: async () => {
      const candidate = ++calls === 1 ? id : "abedef0123456789abedef01";
      return {
        data: {
          text: `Order # ${candidate}`,
          blocks: [
            {
              paragraphs: [
                { lines: [{ words: [{ text: candidate, confidence: 95 }] }] },
              ],
            },
          ],
        },
      };
    },
    terminate: async () => {},
  }));
  assert.equal(result.orderId, "");
  assert.match(result.warning, /khác nhau/);
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
test("tracking conflict across OCR layouts does not silently select a code", async () => {
  let calls = 0;
  const result = await recognizeLabel({}, async () => ({
    setParameters: async () => {},
    recognize: async () => ({
      data: {
        text: `USPS TRACKING # ${++calls === 1 ? "9434650110837019925838" : "9434650110837019925839"}`,
      },
    }),
    terminate: async () => {},
  }));
  assert.equal(result.tracking, "");
});
test("one failed OCR pass retains a reliable reading from the other pass", async () => {
  let calls = 0;
  const result = await recognizeLabel({}, async () => ({
    setParameters: async () => {},
    recognize: async () => {
      if (++calls === 2) throw Error("temporary OCR failure");
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
    terminate: async () => {},
  }));
  assert.equal(result.orderId, id);
  assert.match(result.warning, /Một lượt OCR bị lỗi/);
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
