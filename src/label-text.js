// PDF content stream order is not necessarily visual reading order.
export function pdfText(content, viewport) {
  const m = viewport?.transform || [1, 0, 0, -1, 0, 0];
  const rows = [];
  const items = content.items
    .filter((x) => typeof x.str === "string" && x.str.trim())
    .map((item) => {
      const [a, b, c, d, e, f] = item.transform;
      return {
        text: item.str,
        x: m[0] * e + m[2] * f + m[4],
        y: m[1] * e + m[3] * f + m[5],
        height: Math.max(
          1,
          Math.hypot(m[2] * d + m[0] * c, m[3] * d + m[1] * c),
        ),
      };
    })
    .sort((a, b) => a.y - b.y || a.x - b.x);
  for (const item of items) {
    let row = rows.find(
      (r) =>
        Math.abs(r.y - item.y) <=
        Math.max(2, Math.min(r.height, item.height) * 0.4),
    );
    if (!row) {
      row = { y: item.y, height: item.height, items: [] };
      rows.push(row);
    }
    row.items.push(item);
  }
  return rows
    .map((row) =>
      row.items
        .sort((a, b) => a.x - b.x)
        .map((x) => x.text)
        .join(" "),
    )
    .join("\n");
}

export function extractOrderId(text, { ocr = false } = {}) {
  const raw = String(text || "")
    .normalize("NFKC")
    .replace(/[♯]/g, "#")
    .replace(/\u00a0/g, " ");
  // Keep candidates next to an Order marker. Never remove arbitrary text and
  // accidentally join unrelated fields into a plausible 24-character ID.
  const markers = /\bOrder\s*(?:#|Number\s*:?|ID\s*:?)/gi;
  const candidates = new Set();
  for (const marker of raw.matchAll(markers)) {
    const tail = raw.slice(marker.index + marker[0].length);
    const alphabet = ocr ? "a-fA-F0-9oOiIlL|!¢©®" : "a-fA-F0-9";
    const match = tail.match(
      new RegExp(
        `^\\s*([${alphabet}](?:[ \\t\\r\\n]*[${alphabet}]){23})(?![a-zA-Z0-9])`,
      ),
    );
    if (!match) continue;
    let id = match[1].replace(/\s/g, "").toLowerCase();
    if (ocr)
      id = id
        .replace(/o/g, "0")
        .replace(/[il|!]/g, "1")
        .replace(/[¢©®]/g, "c");
    if (/^[a-f0-9]{24}$/.test(id)) candidates.add(id);
  }
  return candidates.size === 1 ? [...candidates][0] : "";
}

export function extractUspsTracking(text) {
  const raw = String(text || "").normalize("NFKC");
  const candidates = new Set();
  for (const marker of raw.matchAll(
    /\bUSPS\s+(?:TRACKING(?:\s+(?:NUMBER|NO\.?))?\s*)[#:]?/gi,
  )) {
    const line = raw
      .slice(marker.index + marker[0].length)
      .trimStart()
      .split(/\r?\n/)[0];
    const numeric = line
      .match(/^([0-9][0-9 \t-]*[0-9])(?:\s|$)/)?.[1]
      ?.replace(/[ \t-]/g, "");
    if (
      numeric &&
      /^(?:9[2345])/.test(numeric) &&
      [20, 22, 26, 30].includes(numeric.length)
    )
      candidates.add(numeric);
    const international = line
      .match(/^([A-Z]{2}\s*\d{9}\s*US)\b/i)?.[1]
      ?.replace(/\s/g, "")
      .toUpperCase();
    if (international) candidates.add(international);
  }
  return candidates.size === 1 ? [...candidates][0] : "";
}

export async function recognizeLabel(
  canvas,
  createWorker,
  setStatus = () => {},
) {
  let worker;
  let expired = false;
  const deadline = Date.now() + 45000;
  const withinDeadline = async (promise) => {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => {
              expired = true;
              reject(
                new Error(
                  "OCR quá 45 giây. Hãy thử lại hoặc nhập tên file thủ công.",
                ),
              );
            },
            Math.max(0, deadline - Date.now()),
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    worker = await withinDeadline(
      createWorker("eng", 1, {
        logger: (m) => {
          if (m.status === "recognizing text")
            setStatus(
              `Đang OCR label… ${Math.round((m.progress || 0) * 100)}%`,
            );
        },
      }).then((created) => {
        if (expired) created.terminate();
        return created;
      }),
    );
    // Automatic page layout handles addresses, barcodes and separate text areas.
    await withinDeadline(
      worker.setParameters({
        tessedit_pageseg_mode: "3",
        preserve_interword_spaces: "1",
        user_defined_dpi: "300",
      }),
    );
    // A single automatic-layout pass per page. Do not silently repeat OCR.
    const { data } = await withinDeadline(
      worker.recognize(canvas, {}, { text: true, blocks: true }),
    );
    const text = data?.text || "";
    const id = extractOrderId(text, { ocr: true });
    const words = (data?.blocks || []).flatMap((block) =>
      (block.paragraphs || []).flatMap((paragraph) =>
        (paragraph.lines || []).flatMap((line) => line.words || []),
      ),
    );
    const idWords = words.filter((word) => {
      const part = String(word.text || "")
        .replace(/\s/g, "")
        .toLowerCase()
        .replace(/o/g, "0")
        .replace(/[il|!]/g, "1")
        .replace(/[¢©®]/g, "c");
      return part.length >= 4 && id.includes(part);
    });
    const confidence = idWords.length
      ? Math.min(...idWords.map((word) => Number(word.confidence) || 0))
      : 0;
    const reliable = id && confidence >= 70;
    return {
      text,
      tracking: extractUspsTracking(text),
      orderId: reliable ? id : "",
      warning: reliable
        ? ""
        : id
          ? "OCR có độ tin cậy thấp. Đối chiếu label và nhập tên file trước khi xuất."
          : "Chưa đọc được Order ID. Xem label gốc và nhập tên file trước khi xuất.",
    };
  } finally {
    if (worker) await worker.terminate();
  }
}
