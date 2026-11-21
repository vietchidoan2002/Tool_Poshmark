import { readBarcodes, prepareZXingModule } from "zxing-wasm/reader";
import wasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";
import { zipSync, strToU8 } from "fflate";
import { barcodeTrackings } from "../shared/usps-tracking.mjs";
import { exportManifest } from "./label-export.js";

const MAX_PAGES = 80;

prepareZXingModule({ overrides: { locateFile: () => wasmUrl } });

function asPdfFile({ filename, data }) {
  const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
  const name = /\.pdf$/i.test(filename) ? filename : filename + ".pdf";
  return new File([bytes], name, { type: "application/pdf" });
}

export async function prepareGmailLabels(batches, { openPdf, renderPage, exportCanvas, setStatus }) {
  const issues = [];
  const confirmations = [];
  const reviewFiles = [];
  const entries = [];
  const archive = Object.create(null);
  const exported = new Set();
  let scanned = 0;

  for (const [index, batch] of batches.entries()) {
    const batchIssues = [...batch.issues];
    const batchFiles = [];
    const orders = new Map();
    const matches = new Map();
    for (const { orderId, tracking } of batch.orders) {
      if (!tracking) {
        batchIssues.push(`Đơn ${orderId} thiếu tracking rõ ràng trong email.`);
        continue;
      }
      if (!orders.has(tracking)) orders.set(tracking, new Set());
      orders.get(tracking).add(orderId);
    }

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
            batchIssues.push(`${location}: đã đạt giới hạn ${MAX_PAGES} trang trong lượt này.`);
            break;
          }
          scanned++;
          setStatus(`Đang đọc barcode · ${location}`);
          let canvas;
          try {
            const page = await pdf.getPage(pageNo);
            canvas = await renderPage(page, 300 / 72);
            const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
            const codes = await readBarcodes(pixels, {
              formats: ["Code128"], textMode: "Plain", tryHarder: true, maxNumberOfSymbols: 16,
            });
            const trackings = new Set(
              codes.filter(code => code.isValid).flatMap(code => {
                const candidates = barcodeTrackings(code.text);
                const expected = candidates.filter(tracking => orders.has(tracking));
                return expected.length === 1 ? expected : candidates;
              }),
            );
            if (trackings.size !== 1) {
              batchIssues.push(`${location}: ${trackings.size > 1 ? "có nhiều tracking trên một trang" : "không đọc được barcode USPS"}.`);
              continue;
            }
            const [tracking] = trackings;
            const orderIds = orders.get(tracking);
            if (orderIds?.size !== 1) {
              batchIssues.push(`${location}: tracking không khớp duy nhất với một đơn trong email.`);
              continue;
            }
            const [orderId] = orderIds;
            if (matches.has(tracking)) {
              matches.set(tracking, null);
              batchIssues.push(`${location}: tracking lặp trong cùng email.`);
              continue;
            }
            const bytes = await exportCanvas(canvas, pixels);
            matches.set(tracking, {
              bytes, job: { fileName: file.name }, page: { pageNo, orderId, tracking },
            });
          } catch {
            batchIssues.push(`${location}: không xử lý được trang PDF.`);
          } finally {
            if (canvas) canvas.width = 0;
          }
        }
      } catch {
        batchIssues.push(`${attachment.filename}: không mở được PDF.`);
      } finally {
        await loading?.destroy().catch(() => {});
      }
    }

    for (const tracking of orders.keys()) {
      if (!matches.get(tracking)) {
        batchIssues.push(`Chưa có tem khớp tracking ${tracking}.`);
        continue;
      }
      const { bytes, ...entry } = matches.get(tracking);
      const { orderId } = entry.page;
      const pair = `${orderId}:${tracking}`;
      if (exported.has(pair)) continue;
      exported.add(pair);
      const defaultName = `${orderId}.pdf`;
      const name = archive[defaultName] ? `${orderId}-${tracking}.pdf` : defaultName;
      archive[name] = bytes;
      entries.push({ ...entry, name });
    }

    if (!batchIssues.length && matches.size && batch.confirmation)
      confirmations.push(batch.confirmation);
    if (batchIssues.length) {
      issues.push(...batchIssues.map(issue => `Email ${index + 1} · ${issue}`));
      reviewFiles.push(...batchFiles);
    }
  }

  if (entries.length) {
    archive["danh-sach-label.csv"] = strToU8(exportManifest(entries));
    if (issues.length) archive["can-kiem-tra.txt"] = strToU8(issues.join("\n"));
  }
  return {
    zip: entries.length ? new Blob([zipSync(archive, { level: 0 })], { type: "application/zip" }) : null,
    count: entries.length, issues, confirmations, reviewFiles,
  };
}
