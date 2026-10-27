export const isOrderId = (value) =>
  /^[a-f0-9]{24}$/i.test(String(value || "").trim());

export function safeName(value) {
  let name = String(value || "")
    .normalize("NFC")
    .trim()
    .replace(/\.pdf$/i, "")
    .replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, "_")
    .replace(/[. ]+$/g, "");
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))
    name = "_" + name;
  // Keep Unicode filenames, including Vietnamese, without exceeding common limits.
  const encoder = new TextEncoder();
  let bytes = 0;
  name = Array.from(name)
    .slice(0, 100)
    .filter((char) => {
      bytes += encoder.encode(char).length;
      return bytes <= 180;
    })
    .join("");
  return name;
}

export function exportPlan(jobs, only) {
  const used = new Set();
  const entries = [];
  for (const job of jobs)
    for (const page of job.pages) {
      if (only && (job.key !== only.jobKey || page.pageNo !== only.pageNo))
        continue;
      const raw = String(page.outputName || "").trim();
      let name = safeName(raw);
      const warnings = [];
      if (!name) {
        name = safeName(job.fileName) || "label";
        name += `-trang-${page.pageNo}`;
        warnings.push("Chưa có tên; sẽ dùng tên file gốc và số trang.");
      } else {
        if (!isOrderId(raw.replace(/\.pdf$/i, "")))
          warnings.push("Tên tùy chỉnh, không phải Order ID đủ 24 ký tự hex.");
        if (safeName(raw) !== raw.replace(/\.pdf$/i, ""))
          warnings.push(
            "Tên chứa ký tự không hỗ trợ hoặc quá dài; sẽ dùng tên đã làm sạch.",
          );
        if (page.orderId && name.toLowerCase() !== page.orderId.toLowerCase())
          warnings.push("Tên xuất khác Order ID đã quét.");
      }
      let candidate = name,
        count = 2;
      while (used.has(candidate.toLowerCase()))
        candidate = `${name} (${count++})`;
      if (candidate !== name)
        warnings.push("Trùng tên; đã thêm số thứ tự để không ghi đè.");
      used.add(candidate.toLowerCase());
      entries.push({ job, page, name: candidate + ".pdf", warnings });
    }
  return entries;
}

export function exportManifest(entries) {
  const cell = (value) => {
    let text = String(value ?? "");
    if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  };
  return (
    "\uFEFF" +
    [
      [
        "File gốc",
        "Trang",
        "Order ID đã quét",
        "USPS tracking (đọc từ label)",
        "Tên file xuất",
      ],
      ...entries.map(({ job, page, name }) => [
        job.fileName,
        page.pageNo,
        page.orderId,
        page.tracking,
        name,
      ]),
    ]
      .map((row) => row.map(cell).join(","))
      .join("\r\n")
  );
}

export function contentBounds({ width, height, data }) {
  let left = width,
    right = -1,
    top = height,
    bottom = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (
        data[i + 3] &&
        (data[i] < 225 || data[i + 1] < 225 || data[i + 2] < 225)
      ) {
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
  if (right < left) return null;
  const pad = Math.max(
    2,
    Math.round(Math.min(right - left + 1, bottom - top + 1) * 0.012),
  );
  return {
    left: Math.max(0, left - pad),
    top: Math.max(0, top - pad),
    right: Math.min(width - 1, right + pad),
    bottom: Math.min(height - 1, bottom + pad),
  };
}

export function imagePlacement(width, height, bounds) {
  const w = bounds.right - bounds.left + 1,
    h = bounds.bottom - bounds.top + 1;
  const scale = Math.min(288 / w, 432 / h);
  return {
    x: (288 - w * scale) / 2 - bounds.left * scale,
    y: (432 - h * scale) / 2 - (height - 1 - bounds.bottom) * scale,
    width: width * scale,
    height: height * scale,
  };
}
