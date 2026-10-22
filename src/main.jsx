import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { PDFDocument } from "pdf-lib";
import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { createWorker } from "tesseract.js";
import "./style.css";
pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
const API = "http://127.0.0.1:3210";

function extractOrderId(text) {
  const raw = String(text || "")
    .replace(/[＃♯]/g, "#")
    .replace(/\u00a0/g, " ");

  const match = raw.match(/Order\s*#\s*([\s\S]{0,120})/i);
  if (!match) return "";

  let candidate = match[1]
    .replace(/[\r\n]+/g, "")
    .replace(/[^a-zA-Z0-9¢©®|!Il]/g, "")
    .replace(/[¢©®]/g, "c")
    .replace(/[oO]/g, "0")
    .replace(/[|!Il]/g, "1")
    .toLowerCase();

  const id = candidate.match(/[a-f0-9]{24}/);
  return id ? id[0] : "";
}

async function renderPage(page, scale = 3) {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({
    canvasContext: ctx,
    viewport,
    background: "rgb(255,255,255)",
  }).promise;
  return canvas;
}
async function ocrPage(page, setStatus) {
  const canvas = await renderPage(page, 3.5);
  let worker;
  try {
    worker = await createWorker("eng", 1, {
      logger: (m) => {
        if (m.status === "recognizing text")
          setStatus(`Đang OCR label… ${Math.round((m.progress || 0) * 100)}%`);
      },
    });
    await worker.setParameters({
      tessedit_pageseg_mode: "6",
      preserve_interword_spaces: "1",
    });
    const result = await worker.recognize(canvas);
    return result?.data?.text || "";
  } finally {
    if (worker) await worker.terminate();
  }
}
async function cropToPdf(page) {
  const canvas = await renderPage(page, 2.5),
    ctx = canvas.getContext("2d", { willReadFrequently: true });
  const { width, height } = canvas,
    data = ctx.getImageData(0, 0, width, height).data;
  const rows = new Uint32Array(height),
    cols = new Uint32Array(width);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (data[i] < 225 || data[i + 1] < 225 || data[i + 2] < 225) {
        rows[y]++;
        cols[x]++;
      }
    }
  let t = 0,
    b = height - 1,
    l = 0,
    r = width - 1;
  const rowMin = Math.max(3, Math.floor(width * 0.0004)),
    colMin = Math.max(3, Math.floor(height * 0.0004));
  while (t < height - 1 && rows[t] < rowMin) t++;
  while (b > t && rows[b] < rowMin) b--;
  while (l < width - 1 && cols[l] < colMin) l++;
  while (r > l && cols[r] < colMin) r--;
  const px = Math.round((r - l) * 0.012),
    py = Math.round((b - t) * 0.012);
  l = Math.max(0, l - px);
  r = Math.min(width - 1, r + px);
  t = Math.max(0, t - py);
  b = Math.min(height - 1, b + py);
  const out = document.createElement("canvas");
  out.width = r - l + 1;
  out.height = b - t + 1;
  out
    .getContext("2d")
    .drawImage(
      canvas,
      l,
      t,
      out.width,
      out.height,
      0,
      0,
      out.width,
      out.height,
    );
  const blob = await new Promise((resolve) => out.toBlob(resolve, "image/png"));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const doc = await PDFDocument.create(),
    img = await doc.embedPng(bytes),
    p = doc.addPage([288, 432]);
  p.drawImage(img, { x: 0, y: 0, width: 288, height: 432 });
  return await doc.save();
}
function download(name, bytes) {
  const url = URL.createObjectURL(
    new Blob([bytes], { type: "application/pdf" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2500);
}
function App() {
  const [page, setPage] = useState("get");
  const [sheetId, setSheetId] = useState("");
  const [accountName, setAccountName] = useState("");
  const [sheetName, setSheetName] = useState(
    () => localStorage.getItem("pm_default_sheet_name") || ""
  );
  const [tokenFile, setTokenFile] = useState("");
  const [gmail, setGmail] = useState({
    accounts: [],
    credentialsPresent: false,
  });
  const [getBusy, setGetBusy] = useState(false);
  const [getOutput, setGetOutput] = useState("");
  const [configMsg, setConfigMsg] = useState("");
  const [jobs, setJobs] = useState([]);
  const [cutBusy, setCutBusy] = useState(false);
  const [cutMsg, setCutMsg] = useState("");
  async function refresh() {
    try {
      const [c, g] = await Promise.all([
        fetch(API + "/api/config").then((r) => r.json()),
        fetch(API + "/api/gmail/status").then((r) => r.json()),
      ]);
      setSheetId(c.sheetId || "");
      setGmail(g);
      setTokenFile((current) =>
        current && g.accounts?.some((account) => account.file === current)
          ? current
          : (g.accounts?.[0]?.file || "")
      );
    } catch {
      setConfigMsg(
        "Không kết nối được backend. Hãy chạy Start Poshmark Label Manager.bat.",
      );
    }
  }
  // xóa token
async function deleteToken(file, email) {
  const confirmed = window.confirm(
    `Bạn có chắc muốn xóa token Gmail ${email}? Bạn sẽ cần kết nối lại để sử dụng tài khoản này.`
  );

  if (!confirmed) return;

  try {
    const r = await fetch(API + '/api/gmail/delete-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file })
    });

    const data = await r.json();

    if (!r.ok) throw new Error(data.error || 'Không thể xóa token.');

    setConfigMsg(`Đã xóa token của ${email}.`);
    await refresh();
  } catch (error) {
    setConfigMsg('Lỗi xóa token: ' + error.message);
  }
}

  function changeSheetName(value) {
    setSheetName(value);
    localStorage.setItem("pm_default_sheet_name", value);
  }

  useEffect(() => {
    refresh();
  }, []);
  async function saveConfig() {
    setConfigMsg("Đang lưu…");
    try {
      const r = await fetch(API + "/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sheetId }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setConfigMsg("Đã lưu Google Sheets ID.");
    } catch (e) {
      setConfigMsg(e.message);
    }
  }
  async function runGet() {
    if (!accountName.trim()) {
      setGetOutput("Hãy nhập tên account Poshmark.");
      return;
    }
    if (!sheetName.trim()) {
      setGetOutput("Hãy nhập tên tab Google Sheets.");
      return;
    }
    if (!tokenFile) {
      setGetOutput("Hãy chọn tài khoản Gmail.");
      return;
    }

    setGetBusy(true);
    setGetOutput("Đang chạy Get Label…");
    try {
      const r = await fetch(API + "/api/get-label/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountName: accountName.trim(),
          sheetName: sheetName.trim(),
          tokenFile,
        }),
      });
      const d = await r.json();
      setGetOutput(d.output || d.error || "Không có log.");
      if (!r.ok) setGetOutput((d.error || "Get Label thất bại.") + "\n" + (d.output || ""));
      await refresh();
    } catch (e) {
      setGetOutput("Lỗi kết nối: " + e.message);
    } finally {
      setGetBusy(false);
    }
  }
  async function addFiles(fileList) {
    const files = Array.from(fileList || []).filter((f) =>
      f.name.toLowerCase().endsWith(".pdf"),
    );
    if (!files.length) {
      setCutMsg("Hãy chọn PDF.");
      return;
    }
    setCutBusy(true);
    setCutMsg("Đang đọc PDF…");
    try {
      const next = [];
      for (const file of files) {
        const data = new Uint8Array(await file.arrayBuffer());
        const pdf = await pdfjsLib.getDocument({ data }).promise;
        const pages = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          const pg = await pdf.getPage(i);
          const content = await pg.getTextContent();
          let text = content.items.map((x) => x.str).join(" ");
          let id = extractOrderId(text);
          if (!id) {
            setCutMsg(`Đang thử OCR: ${file.name} trang ${i}/${pdf.numPages}`);
            const ocr = await ocrPage(pg, setCutMsg);
            text = [text, ocr].filter(Boolean).join("\n");
            id = extractOrderId(ocr) || extractOrderId(text);
          }
          pages.push({ pageNo: i, pdfPage: pg, text, orderId: id });
        }
        next.push({
          key:
            file.name +
            "-" +
            file.size +
            "-" +
            Date.now() +
            "-" +
            Math.random(),
          fileName: file.name,
          pages,
        });
      }
      setJobs((prev) => [...prev, ...next]);
      setCutMsg(
        `Đã đọc ${files.length} file. Hãy kiểm tra Order ID trước khi xuất.`,
      );
    } catch (e) {
      setCutMsg("Lỗi đọc PDF/OCR: " + e.message);
    } finally {
      setCutBusy(false);
    }
  }
  function updateId(key, pageNo, value) {
    setJobs((prev) =>
      prev.map((j) =>
        j.key !== key
          ? j
          : {
              ...j,
              pages: j.pages.map((p) =>
                p.pageNo !== pageNo ? p : { ...p, orderId: value },
              ),
            },
      ),
    );
  }
  async function exportPage(job, p) {
    const id = String(p.orderId || "").trim();
    if (!/^[a-f0-9]{24}$/i.test(id)) {
      setCutMsg(
        `Trang ${p.pageNo}: Order ID phải gồm 24 ký tự hex. Kiểm tra hoặc nhập lại.`,
      );
      return;
    }
    setCutBusy(true);
    setCutMsg("Đang cắt label…");
    try {
      const bytes = await cropToPdf(p.pdfPage);
      download(id + ".pdf", bytes);
      setCutMsg("Đã xuất " + id + ".pdf");
    } catch (e) {
      setCutMsg("Lỗi xuất PDF: " + e.message);
    } finally {
      setCutBusy(false);
    }
  }
  async function exportAll() {
    for (const job of jobs)
      for (const p of job.pages) {
        if (!/^[a-f0-9]{24}$/i.test(String(p.orderId || "").trim())) {
          setCutMsg(
            `Còn Order ID chưa hợp lệ: ${job.fileName}, trang ${p.pageNo}. Sửa trước khi xuất tất cả.`,
          );
          return;
        }
      }
    for (const job of jobs) for (const p of job.pages) await exportPage(job, p);
  }
  return (
    <div className="app">
      <header className="top">
        <div className="logo">PM</div>
        <div className="headcopy">
          <h1>Poshmark Label Manager</h1>
          <p>Get Label · Cut Label · Chạy cục bộ trên máy</p>
        </div>
        <button className="ghost refresh" onClick={refresh}>
          Làm mới trạng thái
        </button>
      </header>
      <nav className="tabs">
        <button
          className={page === "get" ? "active" : ""}
          onClick={() => setPage("get")}
        >
          ✉ Get Label
        </button>
        <button
          className={page === "cut" ? "active" : ""}
          onClick={() => setPage("cut")}
        >
          ▣ Cut Label
        </button>
      </nav>
      {page === "get" ? (
        <main className="panel">
          <div className="panelhead">
            <div>
              <h2>Get Label</h2>
              <p>
                Đọc email chưa đọc của Gmail và ghi đơn vào Google Sheets theo
                logic tool gốc.
              </p>
            </div>
            <span className="pill">Node.js backend</span>
          </div>
          <section className="configbox">
            <h3>Google Sheets</h3>
            <label className="field">
              Spreadsheet ID
              <input
                value={sheetId}
                onChange={(e) => setSheetId(e.target.value)}
                placeholder="Dán ID nằm giữa /d/ và /edit trong URL"
              />
            </label>
            <div className="inlineActions">
              <button className="secondary" onClick={saveConfig}>
                Lưu Sheet ID
              </button>
              <span className="muted">{configMsg}</span>
            </div>
          </section>
          <section className="configbox">
            <div className="linehead">
              <h3>Kết nối Gmail</h3>
              <span
                className={gmail.accounts?.length ? "pill green" : "pill warn"}
              >
                {gmail.accounts?.length || 0} token
              </span>
            </div>
            {!gmail.credentialsPresent && (
              <p className="warning">
                Thiếu credentials.json. Hãy đặt file OAuth credentials vào thư
                mục gốc theo README.
              </p>
            )}
            {
gmail.accounts?.length ? gmail.accounts.map(a => (
  <div className="account" key={a.file}>
    <span className="dot" />
    <div className="accountInfo">
      <b>{a.email}</b>
      <small>
        {a.hasRefreshToken
          ? 'Có refresh token — tự làm mới khi hết hạn'
          : 'Không có refresh token — có thể cần kết nối lại'}
      </small>
    </div>
    <button
      className="danger small"
      onClick={() => deleteToken(a.file, a.email)}
    >
      Xóa token
    </button>
  </div>
)) : (
  <p className="muted">Chưa có token Gmail được kết nối.</p>
)
}
            <div className="inlineActions">
              <button
                onClick={() =>
                  window.open(
                    API + "/api/auth/start",
                    "_blank",
                    "noopener,noreferrer",
                  )
                }
              >
                Kết nối / làm mới Gmail
              </button>
              <button className="secondary" onClick={refresh}>
                Kiểm tra token
              </button>
            </div>
            <p className="hint">
              Token còn refresh token sẽ được tự làm mới và lưu lại. Nếu bị thu
              hồi, hãy kết nối Gmail lại.
            </p>
          </section>
          <section className="configbox">
            <h3>Thông tin chạy Get Label</h3>
            <label className="field">
              Tên account Poshmark
              <input
                value={accountName}
                onChange={(e) => setAccountName(e.target.value)}
                placeholder="Nhập tên account:"
                autoComplete="off"
              />
            </label>
            <label className="field">
              Tên tab Google Sheets
              <input
                value={sheetName}
                onChange={(e) => changeSheetName(e.target.value)}
                placeholder="Ví dụ: Đơn Poshmark"
                autoComplete="off"
              />
            </label>
            <label className="field">
              Tài khoản Gmail
              <select value={tokenFile} onChange={(e) => setTokenFile(e.target.value)}>
                <option value="">-- Chọn Gmail --</option>
                {gmail.accounts?.map((account) => (
                  <option key={account.file} value={account.file}>{account.email}</option>
                ))}
              </select>
            </label>
            <p className="hint">
              Tên account Poshmark không được lưu. Tên tab sẽ được lưu trên máy và tự điền lần sau.
            </p>
          </section>
          <section className="runbox">
            <div>
              <h3>Chạy lấy đơn</h3>
              <p>
                Quét email chưa đọc, bỏ qua Order ID đã có trong Sheet, ghi dữ
                liệu vào tab “Đơn poshmark”.
              </p>
            </div>
            <button
              disabled={getBusy || !sheetId || !gmail.accounts?.length || !accountName.trim() || !sheetName.trim() || !tokenFile}
              onClick={runGet}
            >
              {getBusy ? "Đang chạy…" : "Chạy Get Label"}
            </button>
          </section>
          {getOutput && (
            <section className="logs">
              <div className="linehead">
                <h3>Kết quả / Log</h3>
                <button
                  className="ghost small"
                  onClick={() => setGetOutput("")}
                >
                  Xóa log
                </button>
              </div>
              <pre>{getOutput}</pre>
            </section>
          )}
        </main>
      ) : (
        <main className="panel">
          <div className="panelhead">
            <div>
              <h2>Cut Label</h2>
              <p>
                Tải shipping label PDF lên, nhận diện Order # và xuất mỗi trang
                thành PDF 4×6 inch.
              </p>
            </div>
            <span className="pill">OCR</span>
          </div>
          <label
            className={"dropzone " + (cutBusy ? "disabled" : "")}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (!cutBusy) addFiles(e.dataTransfer.files);
            }}
          >
            <input
              type="file"
              accept="application/pdf,.pdf"
              multiple
              disabled={cutBusy}
              onChange={(e) => {
                addFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <span className="uploadIcon">↑</span>
            <b>Kéo thả PDF vào đây hoặc bấm để chọn</b>
            <small>PDF nhiều trang · OCR chạy trong trình duyệt</small>
          </label>
          <div className="status">
            {cutBusy && <span className="spinner" />}
            {cutMsg || "Chưa có file nào được thêm."}
          </div>
          {jobs.length > 0 && (
            <>
              <div className="linehead listHead">
                <div>
                  <h3>Danh sách label</h3>
                  <p>
                    {jobs.length} file ·{" "}
                    {jobs.reduce((n, j) => n + j.pages.length, 0)} trang
                  </p>
                </div>
                <div className="inlineActions">
                  <button
                    className="secondary"
                    onClick={() => {
                      setJobs([]);
                      setCutMsg("Đã xóa danh sách.");
                    }}
                  >
                    Xóa danh sách
                  </button>
                  <button onClick={exportAll} disabled={cutBusy}>
                    Xuất tất cả
                  </button>
                </div>
              </div>
              {jobs.map((job) => (
                <article className="job" key={job.key}>
                  <div className="jobname">
                    <span className="pdf">PDF</span>
                    <b>{job.fileName}</b>
                    <small>{job.pages.length} trang</small>
                  </div>
                  {job.pages.map((p) => (
                    <div className="page" key={p.pageNo}>
                      <div className="linehead">
                        <b>Trang {p.pageNo}</b>
                        <span
                          className={p.orderId ? "pill green" : "pill warn"}
                        >
                          {p.orderId ? "Đã nhận diện" : "Cần kiểm tra ID"}
                        </span>
                      </div>
                      <label className="field">
                        Order ID / tên file
                        <input
                          value={p.orderId}
                          onChange={(e) =>
                            updateId(job.key, p.pageNo, e.target.value)
                          }
                          placeholder="24 ký tự hex sau Order #"
                        />
                        <small>{p.orderId || "Chưa có ID"}.pdf</small>
                      </label>
                      <div className="inlineActions">
                        <button
                          onClick={() => exportPage(job, p)}
                          disabled={cutBusy || !p.orderId}
                        >
                          Xuất trang này
                        </button>
                        <details>
                          <summary>Xem text OCR</summary>
                          <pre>{p.text || "Không có text đọc được."}</pre>
                        </details>
                      </div>
                    </div>
                  ))}
                </article>
              ))}
            </>
          )}
        </main>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
