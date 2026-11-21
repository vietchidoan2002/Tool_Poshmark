import { readBarcodes, prepareZXingModule } from "zxing-wasm/reader";
import wasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";
import { barcodeTrackings } from "../shared/usps-tracking.mjs";

const MAX_PAGES = 80;

prepareZXingModule({ overrides: { locateFile: () => wasmUrl } });

function asPdfFile({ filename, data }) {
  const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
  const name = /\.pdf$/i.test(filename) ? filename : filename + ".pdf";
  return new File([bytes], name, { type: "application/pdf" });
}

export function encodeLabelFiles(files) {
  return files.map(({ bytes, ...file }) => {
    const parts = [];
    for (let i = 0; i < bytes.length; i += 16384)
      parts.push(String.fromCharCode(...bytes.subarray(i, i + 16384)));
    return { ...file, data: btoa(parts.join("")) };
  });
}

export async function prepareGmailLabels(batches, { openPdf, renderPage, exportCanvas, setStatus }) {
  const issues = [];
  const reviewFiles = [];
  const files = new Map();
  let scanned = 0;

  for (const [index, batch] of batches.entries()) {
    const batchIssues = [...batch.issues];
    const pageIssues = [];
    const batchFiles = [];
    const orders = new Map();
    const matches = new Map();
    for (const { orderId, tracking } of batch.orders) {
      if (!tracking) continue;
      if (!orders.has(tracking)) orders.set(tracking, new Set());
      orders.get(tracking).add(orderId);
    }

    const report = (location, reason, trackings = []) =>
      pageIssues.push({ location, reason, trackings: [...trackings] });

    for (const attachment of batch.files) {
      let loading;
      try {
        const file = asPdfFile(attachment);
        batchFiles.push(file);
        loading = openPdf(new Uint8Array(await file.arrayBuffer()));
        const pdf = await loading.promise;
        for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
          const location = `${file.name} · trang ${pageNo}`;
          if (scanned >= MAX_PAGES) {
            report(location, `đã đạt giới hạn ${MAX_PAGES} trang trong lượt này`);
            break;
          }
          scanned++;
          setStatus(`Đang đọc barcode · ${location}`);
          let canvas;
          let trackings;
          try {
            const page = await pdf.getPage(pageNo);
            canvas = await renderPage(page, 300 / 72);
            const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
            const codes = await readBarcodes(pixels, {
              formats: ["Code128"], textMode: "Plain", tryHarder: true, maxNumberOfSymbols: 16,
            });
            trackings = new Set(
              codes.filter(code => code.isValid).flatMap(code => {
                const candidates = barcodeTrackings(code.text);
                const expected = candidates.filter(tracking => orders.has(tracking));
                return expected.length === 1 ? expected : candidates;
              }),
            );
            if (trackings.size !== 1) {
              report(location, trackings.size > 1 ? "có nhiều tracking trên một trang" : "không đọc được barcode USPS", trackings);
              continue;
            }
            const [tracking] = trackings;
            const orderIds = orders.get(tracking);
            if (orderIds?.size !== 1) {
              report(location, "tracking không khớp duy nhất với một đơn trong email", trackings);
              continue;
            }
            const [orderId] = orderIds;
            if (matches.has(tracking)) {
              matches.set(tracking, null);
              report(location, "tracking lặp trong cùng email", trackings);
              continue;
            }
            const bytes = await exportCanvas(canvas, pixels);
            matches.set(tracking, { bytes, orderId, tracking, source: file.name, pageNo });
          } catch {
            report(location, "không xử lý được trang PDF", trackings);
          } finally {
            if (canvas) canvas.width = 0;
          }
        }
      } catch {
        report(attachment.filename, "không mở được PDF");
      } finally {
        await loading?.destroy().catch(() => {});
      }
    }

    const unmatched = batch.orders.filter(order => !matches.get(order.tracking));
    const reported = new Set();
    const describe = ({ orderId, tracking }) =>
      `Order ID ${orderId} (tracking trong email: ${tracking || "chưa xác định"})`;
    for (const { location, reason, trackings } of pageIssues) {
      const exact = batch.orders.filter(order => trackings.includes(order.tracking));
      const candidates = exact.length ? exact : unmatched;
      for (const order of candidates) reported.add(order.orderId);
      batchIssues.push(
        `${location}: ${reason}. Tracking trên tem: ${trackings.join(", ") || "chưa đọc được"}. ` +
        (candidates.length
          ? `${exact.length ? "Đơn liên quan" : "Đơn cần đối chiếu"}: ${candidates.map(describe).join("; ")}.`
          : `Order ID: chưa xác định.${batch.orders.length
            ? ` Đơn trong email: ${batch.orders.map(describe).join("; ")}.`
            : ""}`),
      );
    }
    for (const order of unmatched)
      if (!reported.has(order.orderId))
        batchIssues.push(`Chưa có tem khớp với ${describe(order)}.`);

    for (const label of matches.values()) {
      if (label && !files.has(label.orderId)) files.set(label.orderId, label);
    }

    if (batchIssues.length) {
      issues.push(...batchIssues.map(issue => `Email ${index + 1} · ${issue}`));
      reviewFiles.push(...batchFiles);
    }
  }

  return { files: [...files.values()], count: files.size, issues, reviewFiles };
}
