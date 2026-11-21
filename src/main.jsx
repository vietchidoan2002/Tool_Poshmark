import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { PDFDocument } from "pdf-lib";
import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { createWorker } from "tesseract.js";
import "./style.css";
import UserProfile from "./UserProfile.jsx";
import BrandLogo from "./BrandLogo.jsx";
import AuthPage, { ActivationPage } from "./AuthPage.jsx";
import {
  extractOrderId,
  extractUspsTracking,
  pdfText,
  recognizeLabel,
} from "./label-text.js";
import ocrWorkerUrl from "tesseract.js/dist/worker.min.js?url";
import ocrCoreUrl from "tesseract.js-core/tesseract-core-lstm.wasm.js?url";
import englishDataUrl from "@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz?url";
import { zipSync, strToU8 } from "fflate";
import {
  exportPlan,
  exportManifest,
  contentBounds,
  imagePlacement,
} from "./label-export.js";

const AdminDashboard = React.lazy(() =>
  import("./AdminDashboard.jsx").catch(() => ({
    default: ({ onRetry, pending }) => (
      <main className="panel">
        <h2>Chưa mở được trang quản trị</h2>
        <p>Kiểm tra kết nối hoặc tải lại phiên bản mới của website.</p>
        <button onClick={onRetry} disabled={pending}>
          Tải lại trang quản trị
        </button>
      </main>
    ),
  })),
);

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

let sharedPdfWorker;
const getPdfWorker = () => (sharedPdfWorker ||= new pdfjsLib.PDFWorker());
const API = ""; // Same-origin API.

function sheetNameStorageKey(userId) {
  return `pm_default_sheet_name:${userId}`;
}

function savedGetValue(key) {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

async function renderPage(page, scale = 3) {
  const base = page.getViewport({ scale: 1 });
  scale = Math.min(scale, Math.sqrt(12000000 / (base.width * base.height)));
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
  const canvas = await renderPage(page, 300 / 72);
  const langPath = new URL(".", new URL(englishDataUrl, window.location.href))
    .href;
  const result = await recognizeLabel(
    canvas,
    (lang, mode, options) =>
      createWorker(lang, mode, {
        ...options,
        workerPath: ocrWorkerUrl,
        corePath: ocrCoreUrl,
        langPath,
        errorHandler: () => {},
      }),
    setStatus,
  );
  const thumbnail = document.createElement("canvas");
  const ratio = Math.min(1, 800 / Math.max(canvas.width, canvas.height));
  thumbnail.width = Math.max(1, Math.round(canvas.width * ratio));
  thumbnail.height = Math.max(1, Math.round(canvas.height * ratio));
  thumbnail
    .getContext("2d")
    .drawImage(canvas, 0, 0, thumbnail.width, thumbnail.height);
  return { ...result, preview: thumbnail.toDataURL("image/jpeg", 0.85) };
}
async function cropToPdf(page) {
  // Render at 300 DPI (bounded for oversized PDFs); keep the barcode's aspect ratio.
  const canvas = await renderPage(page, 300 / 72);
  return exportLabelCanvas(canvas);
}

async function exportLabelCanvas(canvas, pixels) {
  const bounds = contentBounds(
    pixels || canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height),
  );
  if (!bounds) throw new Error("Trang trắng, không có nội dung label để xuất.");
  const blob = await new Promise((resolve) =>
    canvas.toBlob(resolve, "image/png"),
  );
  if (!blob)
    throw new Error("Không tạo được ảnh label. Hãy thử lại với ít trang hơn.");
  const doc = await PDFDocument.create();
  const img = await doc.embedPng(new Uint8Array(await blob.arrayBuffer()));
  doc
    .addPage([288, 432])
    .drawImage(img, imagePlacement(canvas.width, canvas.height, bounds));
  return doc.save();
}

function triggerDownload(file) {
  const a = document.createElement("a");
  a.href = file.url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function ExportReview({ review, onCancel, onConfirm }) {
  const dialog = useRef(null);
  useEffect(() => {
    dialog.current.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="export-review"
      aria-labelledby="review-title"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <h3 id="review-title">Kiểm tra tên file trước khi xuất</h3>
      <p>
        Các trang dưới đây có tên cần kiểm tra. Bạn có muốn tiếp tục với tên đã
        hiển thị không?
      </p>
      <ul>
        {review.entries
          .filter((entry) => entry.warnings.length)
          .map((entry) => (
            <li key={entry.job.key + ":" + entry.page.pageNo}>
              <b>
                {entry.job.fileName} · trang {entry.page.pageNo}
              </b>
              <p>
                Tên sẽ xuất: <strong>{entry.name}</strong>
              </p>
              {entry.warnings.map((warning) => (
                <p key={warning}>{warning}</p>
              ))}
            </li>
          ))}
      </ul>
      <p>
        Tên tùy chỉnh được phép sử dụng. Tên trống sẽ dùng tên file gốc kèm số
        trang; tên trùng được thêm số thứ tự.
      </p>
      <div className="inlineActions">
        <button className="secondary" onClick={onCancel} autoFocus>
          Quay lại sửa
        </button>
        <button onClick={onConfirm}>
          Tiếp tục xuất {review.entries.length} trang
        </button>
      </div>
    </dialog>
  );
}

function readAuthRoute() {
  const mode = window.location.hash.replace(/^#\/?/, "").split("?")[0];
  return [
    "login",
    "register",
    "forgot",
    "reset-password",
    "verify-email",
    "terms",
    "privacy",
  ].includes(mode)
    ? mode
    : null;
}
function App() {
  const [authView, setAuthView] = useState(readAuthRoute);
  const authToken = useRef(
    new URLSearchParams(window.location.hash.split("?")[1] || "").get(
      "token",
    ) || "",
  );
  const verifyPending = useRef(readAuthRoute() === "verify-email");
  useEffect(() => {
    const change = () => {
      const route = readAuthRoute();
      const token = new URLSearchParams(
        window.location.hash.split("?")[1] || "",
      ).get("token");
      if (token) {
        authToken.current = token;
        verifyPending.current = route === "verify-email";
        window.history.replaceState(
          null,
          "",
          window.location.pathname + window.location.search + "#/" + route,
        );
      }
      setAuthView(route);
      const appRoute = window.location.hash.replace(/^#\/?/, "").split("?")[0];
      if (["get", "cut", "profile", "admin"].includes(appRoute))
        setPage(appRoute);
    };
    change();
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  function openAuth(mode) {
    setAuthView(mode);
    window.history.pushState(
      null,
      "",
      mode ? "#/" + mode : window.location.pathname + window.location.search,
    );
  }
  async function authCompleted(mode) {
    if (mode === "verify-email") {
      verifyPending.current = false;
      authToken.current = "";
    }
    openAuth(verifyPending.current ? "verify-email" : null);
    await refresh();
  }
  const [page, setPage] = useState(
    window.location.hash === "#/admin" ? "admin" : "get",
  );
  function navigatePage(value) {
    setPage(value);
    window.history.pushState(null, "", "#/" + value);
  }
  const [authenticated, setAuthenticated] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);
  const [emailVerified, setEmailVerified] = useState(false);
  const [authError, setAuthError] = useState("");
  const [logoutError, setLogoutError] = useState("");
  const [phoneReady, setPhoneReady] = useState(true);
  const authUser = useRef(null);
  const refreshGeneration = useRef(0);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [sheetId, setSheetId] = useState("");
  const sheetDraft = useRef(null);
  const [accountName, setAccountName] = useState("");
  const [sheetName, setSheetName] = useState("");
  const [driveFolderUrl, setDriveFolderUrl] = useState("");
  const [tokenFile, setTokenFile] = useState("");
  const [gmail, setGmail] = useState({
    accounts: [],
    credentialsPresent: false,
  });
  const [getBusy, setGetBusy] = useState(false);
  const [getOutput, setGetOutput] = useState("");
  const [gmailLabels, setGmailLabels] = useState(null);
  const [labelProgress, setLabelProgress] = useState("");
  const [pendingDrive, setPendingDrive] = useState(null);
  const [configMsg, setConfigMsg] = useState("");
  const [jobs, setJobs] = useState([]);
  const [cutBusy, setCutBusy] = useState(false);
  const [cutMsg, setCutMsg] = useState("");
  const [importErrors, setImportErrors] = useState([]);
  const [exportErrors, setExportErrors] = useState([]);
  const [review, setReview] = useState(null);
  const [downloadResult, setDownloadResult] = useState(null);
  const cutLock = useRef(false);
  const documents = useRef(new Set());
  useEffect(
    () => () => {
      if (downloadResult) URL.revokeObjectURL(downloadResult.url);
    },
    [downloadResult],
  );
  useEffect(
    () => () => {
      for (const document of documents.current)
        document.destroy().catch(() => {});
    },
    [],
  );
  async function refresh() {
    const generation = ++refreshGeneration.current;
    try {
      const sessionResponse = await fetch(API + "/api/session");
      if (!sessionResponse.ok) throw new Error("Session unavailable");
      const session = await sessionResponse.json();
      if (
        session.webMode !== true ||
        typeof session.authenticated !== "boolean"
      )
        throw new Error("Invalid session response");
      if (generation !== refreshGeneration.current) return;
      setAuthError("");
      setAuthenticated(!!session.authenticated);
      setIsAdmin(!!session.authenticated && session.isAdmin === true);
      setEmailVerified(session.emailVerified === true);
      setSessionReady(true);
      if (authUser.current !== session.userId) {
        authUser.current = session.userId || null;
        sheetDraft.current = null;
        setSheetId("");
        const id = authUser.current;
        setSheetName(id ? savedGetValue(sheetNameStorageKey(id)) : "");
        setDriveFolderUrl(id ? savedGetValue(`pm_drive_folder:${id}`) : "");
        setAccountName("");
        setGetOutput("");
        setGmailLabels(null);
        setPendingDrive(null);
        setPhoneReady(false);
      }
      if (!session.authenticated) {
        setGmail({ credentialsPresent: true, accounts: [] });
        setTokenFile("");
        return;
      }
      if (!session.emailVerified) return;
      const [c, g, profile] = await Promise.all([
        fetch(API + "/api/config").then((r) => r.json()),
        fetch(API + "/api/gmail/status").then((r) => r.json()),
        fetch(API + "/api/profile").then((r) => {
          if (!r.ok) throw Error("Profile unavailable");
          return r.json();
        }),
      ]);
      if (generation !== refreshGeneration.current) return;
      setPhoneReady(!profile.phoneRequired || profile.reviewed);
      if (sheetDraft.current === null)
        setSheetId(
          c.sheetId === "PASTE_GOOGLE_SHEET_ID_HERE" ? "" : c.sheetId || "",
        );
      setGmail(g);
      setTokenFile((current) =>
        current && g.accounts?.some((account) => account.file === current)
          ? current
          : g.accounts?.[0]?.file || "",
      );
    } catch {
      if (generation !== refreshGeneration.current) return;
      setAuthError(
        "Chưa đọc được trạng thái tài khoản từ máy chủ. Hãy kiểm tra kết nối và thử lại.",
      );
      setConfigMsg(
        "Không kết nối được máy chủ. Hãy kiểm tra kết nối hoặc khởi động lại tool.",
      );
    }
  }
  // xóa token
  async function deleteToken(file, email) {
    const confirmed = window.confirm(
      `Bạn có chắc muốn xóa token Gmail ${email}? Bạn sẽ cần kết nối lại để sử dụng tài khoản này.`,
    );

    if (!confirmed) return;

    try {
      const r = await fetch(API + "/api/gmail/delete-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file }),
      });

      const data = await r.json();

      if (!r.ok) throw new Error(data.error || "Không thể xóa token.");

      setConfigMsg(`Đã xóa token của ${email}.`);
      await refresh();
    } catch (error) {
      setConfigMsg("Lỗi xóa token: " + error.message);
    }
  }

  function saveGetValue(key, value) {
    if (!authUser.current) return;
    try {
      localStorage.setItem(key, value);
    } catch {
      // Editing still works when browser storage is unavailable.
    }
  }

  useEffect(() => {
    refresh();
    const checkVersion = async () => {
      try {
        const response = await fetch("/api/version", { cache: "no-store" });
        const data = await response.json();
        if (
          typeof data.version === "string" &&
          data.version !== "local" &&
          data.version !== __APP_VERSION__
        )
          setUpdateAvailable(true);
      } catch {
        /* Keep the current session usable during a deployment. */
      }
    };
    const onFocus = () => {
      refresh();
      checkVersion();
    };
    const timer = setInterval(checkVersion, 60000);
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, []);
  function connectGoogle() {
    if (
      jobs.length &&
      !window.confirm(
        "Đăng nhập Google sẽ tải lại trang và xóa danh sách PDF đang mở. Tiếp tục?",
      )
    )
      return;
    window.location.assign(authenticated ? "/api/auth/start?drive=1" : "/api/auth/start");
  }
  async function logout() {
    if (cutBusy || getBusy) return;
    if (
      jobs.length &&
      !window.confirm(
        "Đăng xuất sẽ xóa danh sách PDF đang mở. Hãy xuất file trước. Tiếp tục?",
      )
    )
      return;
    setLogoutError("");
    try {
      const response = await fetch("/api/logout", { method: "POST" });
      if (!response.ok) throw Error("Logout failed");
      sheetDraft.current = null;
      setJobs([]);
      setReview(null);
      setDownloadResult(null);
      setImportErrors([]);
      setExportErrors([]);
      setCutMsg("");
      for (const document of documents.current)
        document.destroy().catch(() => {});
      documents.current.clear();
      setPage("get");
      openAuth("login");
      await refresh();
    } catch {
      setLogoutError(
        "Không đăng xuất được. Vui lòng kiểm tra kết nối và thử lại.",
      );
    }
  }
  function reloadVersion() {
    if (cutBusy || getBusy) return;
    if (
      jobs.length &&
      !window.confirm(
        "Tải phiên bản mới sẽ xóa danh sách PDF đang mở. Hãy xuất file trước. Tiếp tục?",
      )
    )
      return;
    window.location.reload();
  }
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
      if (sheetDraft.current === sheetId) sheetDraft.current = null;
      setConfigMsg("Đã lưu Google Sheets ID.");
    } catch (e) {
      setConfigMsg(e.message);
    }
  }
  async function saveLabelsToDrive(job) {
    const userId = authUser.current;
    setLabelProgress(`Đang lưu ${job.files.length} tem vào Drive và ghi link vào cột R…`);
    const response = await fetch(API + "/api/get-label/finish-drive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(job),
    });
    const result = await response.json();
    if (authUser.current !== userId) return;
    if (!response.ok) {
      if (response.status >= 400 && response.status < 500 && response.status !== 409)
        setPendingDrive(null);
      throw Error(result.error || "Chưa lưu được tem vào Drive.");
    }
    setPendingDrive(null);
    setGmailLabels(current => ({ ...current, result }));
    setGetOutput(current => [current,
      `Đã lưu ${result.linkedCount} tem và cập nhật cột R. Ghi mới ${result.writtenOrderCount} đơn.`,
      ...result.warnings,
    ].filter(Boolean).join("\n"));
  }

  async function runGet() {
    if (getBusy || cutBusy) return;
    if (!accountName.trim() || !sheetName.trim() || !driveFolderUrl.trim() || !tokenFile) {
      setGetOutput("Hãy nhập tên account, tên tab, link thư mục Drive và chọn Gmail.");
      return;
    }
    if (pendingDrive && !window.confirm("Bắt đầu lượt mới và thay lượt lưu Drive đang chờ?")) return;
    const userId = authUser.current;
    setGetBusy(true);
    setPendingDrive(null);
    setGmailLabels(null);
    setGetOutput("Đang kiểm tra link Drive và đọc email…");
    try {
      const response = await fetch(API + "/api/get-label/prepare-drive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountName: accountName.trim(), sheetName: sheetName.trim(),
          sheetId: sheetId.trim(), driveFolderUrl: driveFolderUrl.trim(),
        }),
      });
      const data = await response.json();
      if (authUser.current !== userId) return;
      if (!response.ok) throw Error(data.error || "Chưa đọc được email.");
      setGetOutput(data.output || "Không có email tem mới.");
      if (!data.labelBatches.length) return;

      const { prepareGmailLabels, encodeLabelFiles } = await import("./gmail-labels.js");
      const { files, ...labels } = await prepareGmailLabels(data.labelBatches, {
        openPdf: (pdf) => pdfjsLib.getDocument({ data: pdf, worker: getPdfWorker(), isEvalSupported: false }),
        renderPage,
        exportCanvas: exportLabelCanvas,
        setStatus: setLabelProgress,
      });
      if (authUser.current !== userId) return;
      setGmailLabels(labels);
      if (labels.issues.length) return;
      if (!data.token || !files.length)
        throw Error("Chưa xác minh đủ tem cho tất cả đơn. Get Label đã dừng.");
      const job = { token: data.token, files: encodeLabelFiles(files) };
      const size = job.files.reduce((total, file) => total + file.data.length, 0);
      if (size > Math.ceil(16 * 1024 * 1024 / 3) * 4 + 320)
        throw Error("Tổng PDF tem vượt 16 MB. Hãy chia nhỏ lượt chạy.");
      setPendingDrive(job);
      await saveLabelsToDrive(job);
    } catch (error) {
      if (authUser.current === userId)
        setGetOutput(current => [current, error.message].filter(Boolean).join("\n"));
    } finally {
      setLabelProgress("");
      setGetBusy(false);
    }
  }

  async function retryDrive() {
    if (!pendingDrive || getBusy) return;
    const userId = authUser.current;
    setGetBusy(true);
    try {
      await saveLabelsToDrive(pendingDrive);
    } catch (error) {
      if (authUser.current === userId) setGetOutput(error.message);
    } finally {
      setLabelProgress("");
      setGetBusy(false);
    }
  }
  async function addFiles(fileList) {
    if (cutLock.current || review) return;
    const allFiles = Array.from(fileList || []);
    const files = allFiles.filter((file) =>
      file.name.toLowerCase().endsWith(".pdf"),
    );
    if (!files.length) {
      setCutMsg("Hãy chọn file PDF.");
      return;
    }
    cutLock.current = true;
    setCutBusy(true);
    setCutMsg("Đang đọc PDF…");
    setExportErrors([]);
    const errors = allFiles
      .filter((file) => !files.includes(file))
      .map((file) => `${file.name}: không phải file PDF, đã bỏ qua.`);
    const next = [];
    try {
      for (const file of files) {
        let pdf, loading;
        try {
          if (file.size > 100 * 1024 * 1024)
            throw new Error("File lớn hơn 100 MB. Hãy chia nhỏ PDF.");
          loading = pdfjsLib.getDocument({
            data: new Uint8Array(await file.arrayBuffer()),
            worker: getPdfWorker(),
          });
          pdf = await loading.promise;
          const pages = [];
          for (let i = 1; i <= pdf.numPages; i++) {
            try {
              const pg = await pdf.getPage(i);
              let nativeText = "";
              try {
                const content = await pg.getTextContent();
                const alternatives = [
                  pdfText(content, pg.getViewport({ scale: 1 })),
                  pdfText(content),
                ];
                const score = (text) =>
                  (extractOrderId(text) ? 2 : 0) +
                  (extractUspsTracking(text) ? 1 : 0);
                nativeText = alternatives.sort(
                  (a, b) => score(b) - score(a),
                )[0];
              } catch {
                /* Image OCR can still work. */
              }
              let text = nativeText;
              let id = extractOrderId(text);
              let tracking = extractUspsTracking(text);
              let source = "PDF",
                ocrError = "",
                preview = "";
              // An Order ID alone is insufficient for the tracking cross-check.
              if (!id || !tracking) {
                setCutMsg(
                  `Đang OCR: ${file.name} · trang ${i}/${pdf.numPages}`,
                );
                try {
                  const result = await ocrPage(pg, (message) =>
                    setCutMsg(
                      `${file.name} · trang ${i}/${pdf.numPages} — ${message}`,
                    ),
                  );
                  text = result.text || nativeText;
                  preview = result.preview;
                  id = id || result.orderId;
                  tracking = tracking || result.tracking;
                  ocrError = result.warning || "";
                  source = result.text ? "OCR" : "PDF";
                } catch (error) {
                  ocrError =
                    "Không đọc được OCR: " +
                    (error?.message || String(error)) +
                    ". Bạn vẫn có thể nhập tên để xuất trang.";
                }
              }
              try {
                if (!preview)
                  preview = (await renderPage(pg, 1)).toDataURL(
                    "image/jpeg",
                    0.85,
                  );
              } catch {
                ocrError += " Không tạo được ảnh xem trước.";
              }
              pages.push({
                pageNo: i,
                pdfPage: pg,
                text,
                nativeText,
                source,
                ocrError,
                orderId: id,
                outputName: id,
                tracking,
                preview,
              });
            } catch (error) {
              errors.push(
                `${file.name} · trang ${i}: ${error.message || String(error)}`,
              );
            }
          }
          if (pages.length) {
            documents.current.add(pdf);
            next.push({ key: crypto.randomUUID(), fileName: file.name, pages });
          } else {
            await pdf.destroy();
          }
        } catch (error) {
          const reason =
            error.name === "PasswordException"
              ? "PDF có mật khẩu. Hãy mở khóa file trước khi tải lên."
              : error.name === "InvalidPDFException"
                ? "PDF hỏng hoặc không đúng định dạng."
                : error.message || String(error);
          errors.push(`${file.name}: ${reason}`);
          if (loading) await loading.destroy().catch(() => {});
        }
      }
      setJobs((previous) => [...previous, ...next]);
      setImportErrors(errors);
      setCutMsg(
        `Đã thêm ${next.length} file, ${next.reduce((sum, job) => sum + job.pages.length, 0)} trang. Kiểm tra Order ID và USPS tracking trước khi xuất.`,
      );
    } finally {
      cutLock.current = false;
      setCutBusy(false);
    }
  }
  function updateId(key, pageNo, value) {
    if (cutLock.current) return;
    setJobs((previous) =>
      previous.map((job) =>
        job.key !== key
          ? job
          : {
              ...job,
              pages: job.pages.map((p) =>
                p.pageNo !== pageNo ? p : { ...p, outputName: value },
              ),
            },
      ),
    );
  }
  function clearJobs() {
    if (cutLock.current) return;
    for (const document of documents.current)
      document.destroy().catch(() => {});
    documents.current.clear();
    setJobs([]);
    setReview(null);
    setImportErrors([]);
    setExportErrors([]);
    setDownloadResult(null);
    setCutMsg("Đã xóa danh sách.");
  }
  async function runExport(entries, batch) {
    if (cutLock.current) return;
    cutLock.current = true;
    setReview(null);
    setCutBusy(true);
    setExportErrors([]);
    setDownloadResult(null);
    const failures = [],
      successful = [],
      archive = Object.create(null);
    try {
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        setCutMsg(`Đang xuất ${i + 1}/${entries.length}: ${entry.name}`);
        try {
          const bytes = await cropToPdf(entry.page.pdfPage);
          archive[entry.name] = bytes;
          successful.push(entry);
        } catch (error) {
          failures.push(
            `${entry.job.fileName} · trang ${entry.page.pageNo}: ${error.message || String(error)}`,
          );
        }
      }
      if (!successful.length) {
        setCutMsg("Không xuất được trang nào. Xem lỗi bên dưới.");
        return;
      }
      if (batch) {
        archive["danh-sach-label.csv"] = strToU8(exportManifest(successful));
        if (failures.length)
          archive["loi-xuat.txt"] = strToU8(failures.join("\n"));
      }
      const bytes = batch
        ? zipSync(archive, { level: 0 })
        : archive[successful[0].name];
      const result = {
        name: batch ? "poshmark-labels.zip" : successful[0].name,
        url: URL.createObjectURL(
          new Blob([bytes], {
            type: batch ? "application/zip" : "application/pdf",
          }),
        ),
        batch,
      };
      setDownloadResult(result);
      triggerDownload(result);
      setCutMsg(
        `Đã xuất ${successful.length}/${entries.length} trang${failures.length ? `; ${failures.length} trang lỗi` : ""}. ${batch ? "Giải nén ZIP để lấy PDF và bảng đối chiếu tracking." : "Bạn có thể xem PDF hoặc tải lại bên dưới."}`,
      );
    } catch (error) {
      failures.push(error.message || String(error));
      setCutMsg(
        "Không hoàn tất xuất file. Xem lỗi bên dưới và thử lại với ít trang hơn.",
      );
    } finally {
      setExportErrors(failures);
      cutLock.current = false;
      setCutBusy(false);
    }
  }
  function requestExport(only) {
    if (cutLock.current || review) return;
    const entries = exportPlan(jobs, only);
    if (!entries.length) {
      setCutMsg("Chưa có trang để xuất.");
      return;
    }
    const batch = !only;
    if (entries.some((entry) => entry.warnings.length))
      setReview({ entries, batch });
    else runExport(entries, batch);
  }
  if (!sessionReady)
    return (
      <div className="auth-shell">
        <main className="auth-card" aria-busy={!authError}>
          <h1>Poshmark Label Tool</h1>
          <p role="status">{authError || "Đang kiểm tra phiên đăng nhập…"}</p>
          {authError && <button onClick={refresh}>Thử lại kết nối</button>}
        </main>
      </div>
    );
  if (authView || !authenticated)
    return (
      <AuthPage
        mode={
          authView === "verify-email" && !authenticated
            ? "login"
            : authView || "login"
        }
        verificationPending={verifyPending.current}
        token={authToken.current}
        onNavigate={openAuth}
        onBack={authenticated ? () => openAuth(null) : undefined}
        backLabel={
          !emailVerified ? "← Quay lại tài khoản" : undefined
        }
        onAuth={authCompleted}
        onGoogle={connectGoogle}
      />
    );
  if (!emailVerified)
    return (
      <ActivationPage
        key={authUser.current}
        onLogout={logout}
        onRefresh={refresh}
        logoutError={logoutError}
      />
    );
  return (
    <div className="app">
      <header className="top signed-in">
        <BrandLogo />
        <div className="headcopy">
          <h1>Poshmark Label Tool</h1>
        </div>
        <div className="header-account-actions">
          {isAdmin && (
            <button
              className={
                page === "admin" ? "profile-link active" : "secondary"
              }
              onClick={() => navigatePage("admin")}
              aria-pressed={page === "admin"}
            >
              Quản trị
            </button>
          )}
          <button
            className={
              page === "profile"
                ? "profile-link active"
                : "secondary profile-link"
            }
            onClick={() => navigatePage("profile")}
            aria-pressed={page === "profile"}
          >
            Hồ sơ
          </button>
          <button
            className="secondary"
            onClick={logout}
            disabled={getBusy || cutBusy}
          >
            Đăng xuất
          </button>
        </div>
      </header>
      {logoutError && (
        <p className="warning" role="alert">
          {logoutError}
        </p>
      )}
      {authError && (
        <aside className="warning" role="alert">
          <strong>Kết nối tài khoản chưa sẵn sàng</strong>
          <p>{authError}</p>
          <button className="secondary" onClick={refresh}>
            Thử lại kết nối
          </button>
        </aside>
      )}
      {updateAvailable && (
        <aside className="notice">
          <strong>Có phiên bản mới</strong>
          <p>Hoàn tất và xuất các label đang mở trước khi cập nhật.</p>
          <button onClick={reloadVersion} disabled={cutBusy || getBusy}>
            Tải phiên bản mới
          </button>
        </aside>
      )}
      <nav className="tabs">
        <button
          className={page === "get" ? "active" : ""}
          onClick={() => navigatePage("get")}
          aria-pressed={page === "get"}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <rect x="3" y="5" width="18" height="14" rx="3" />
            <path d="m4 7 6.7 5.1a2.2 2.2 0 0 0 2.6 0L20 7" />
          </svg>
          Get Label
        </button>
        <button
          className={page === "cut" ? "active" : ""}
          onClick={() => navigatePage("cut")}
          aria-pressed={page === "cut"}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <circle cx="6" cy="6" r="3" />
            <circle cx="6" cy="18" r="3" />
            <path d="m8.1 8.1 11.9 11.9M8.1 15.9 20 4" />
          </svg>
          Cut Label
        </button>
      </nav>
      {page === "admin" ? (
        isAdmin ? (
          <React.Suspense
            fallback={
              <main className="panel">
                <p role="status">Đang mở dashboard quản trị…</p>
              </main>
            }
          >
            <AdminDashboard
              key={authUser.current}
              onRetry={reloadVersion}
              pending={getBusy || cutBusy}
            />
          </React.Suspense>
        ) : (
          <main className="panel">
            <h2>Không có quyền quản trị</h2>
            <p>Trang này chỉ dành cho quản trị viên.</p>
            <button onClick={() => navigatePage("get")}>Về Get Label</button>
          </main>
        )
      ) : page === "profile" ? (
        <UserProfile
          key={authUser.current}
          onEligibility={setPhoneReady}
          onSetPassword={() => openAuth("forgot")}
        />
      ) : page === "get" ? (
        <main className="panel">
          <div className="panelhead">
            <div>
              <h2>Get Label</h2>
              <p>
                Đọc email chưa đọc của Gmail và ghi đơn vào Google Sheets theo
                cấu hình của bạn.
              </p>
            </div>
            <span className="pill">Gmail → Google Sheets</span>
          </div>
          {!phoneReady && (
            <aside className="warning">
              Cần kiểm tra thông tin điện thoại trước khi chạy Get Label.{" "}
              <button
                className="text-button"
                onClick={() => navigatePage("profile")}
              >
                Mở Hồ sơ
              </button>
            </aside>
          )}
          <section className="configbox">
            <h3>Google Sheets</h3>
            <label className="field">
              Spreadsheet ID
              <input
                value={sheetId}
                onChange={(e) => {
                  sheetDraft.current = e.target.value;
                  setSheetId(e.target.value);
                }}
                placeholder=""
                aria-describedby="sheet-id-help"
              />
            </label>
            <details id="sheet-id-help" className="hint">
              <summary>Cách lấy Spreadsheet ID</summary>
              <p>
                Mở Google Sheets, sao chép phần nằm giữa /d/ và /edit trong
                địa chỉ, rồi dán vào ô trên.
              </p>
            </details>
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
                className={
                  gmail.accounts?.length ? "pill green" : "pill warn"
                }
              >
                {gmail.accounts?.length || 0} token
              </span>
            </div>
            {gmail.accounts?.length ? (
              gmail.accounts.map((a) => (
                <div className="account" key={a.file}>
                  <span className="dot" />
                  <div className="accountInfo">
                    <b>{a.email}</b>
                  </div>
                  <button
                    className="danger small"
                    onClick={() => deleteToken(a.file, a.email)}
                  >
                    Xóa token
                  </button>
                </div>
              ))
            ) : (
              <p className="muted">Chưa có token Gmail được kết nối.</p>
            )}
            <div className="inlineActions">
              <button onClick={connectGoogle}>
                Kết nối / làm mới Gmail &amp; Drive
              </button>
              <button
                className="secondary"
                onClick={refresh}
                title="Đọc lại tài khoản Gmail đã kết nối, không cập nhật phiên bản phần mềm"
              >
                Cập nhật tài khoản Gmail
              </button>
            </div>
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
                onChange={(event) => {
                  const value = event.target.value;
                  setSheetName(value);
                  saveGetValue(sheetNameStorageKey(authUser.current), value);
                }}
                placeholder="Ví dụ: Đơn Poshmark"
                autoComplete="off"
              />
            </label>
            <label className="field">
              Link thư mục Google Drive lưu tem
              <input
                type="url"
                value={driveFolderUrl}
                onChange={(event) => {
                  const value = event.target.value;
                  setDriveFolderUrl(value);
                  saveGetValue(`pm_drive_folder:${authUser.current}`, value);
                }}
                placeholder="https://drive.google.com/drive/folders/..."
                autoComplete="off"
                maxLength={1000}
              />
            </label>
            <label className="field">
              Tài khoản Gmail
              <select
                value={tokenFile}
                onChange={(e) => setTokenFile(e.target.value)}
              >
                <option value="">-- Chọn Gmail --</option>
                {gmail.accounts?.map((account) => (
                  <option key={account.file} value={account.file}>
                    {account.email}
                  </option>
                ))}
              </select>
            </label>
          </section>
          <aside className="notice" role="note">
            <strong>Lưu ý</strong>
            <p>
              Khi tất cả tem khớp tracking, Get Label lưu PDF và CSV vào Drive,
              ghi link tem vào cột R rồi đánh dấu email đã đọc.
            </p>
          </aside>
          <section className="runbox">
            <div>
              <h3>Chạy lấy đơn</h3>
              <p>
                Kiểm tra tem trong email chưa đọc và ghi link tem vào tab
                “{sheetName || "đã chọn"}”.
              </p>
            </div>
            <button
              disabled={
                getBusy ||
                cutBusy ||
                !phoneReady ||
                !sheetId ||
                !gmail.accounts?.length ||
                !accountName.trim() ||
                !sheetName.trim() ||
                !driveFolderUrl.trim() ||
                !tokenFile
              }
              onClick={runGet}
            >
              {getBusy ? "Đang chạy…" : "Chạy Get Label"}
            </button>
          </section>
          {labelProgress && <p className="status" role="status">{labelProgress}</p>}
          {gmailLabels && (
            <section className="configbox">
              <h3>Tem từ Gmail</h3>
              <p>{gmailLabels.count} tem đã khớp tracking</p>
              {gmailLabels.result && (
                <div className="inlineActions">
                  <a href={gmailLabels.result.folderUrl} target="_blank" rel="noreferrer">Mở thư mục Drive</a>
                  <a href={gmailLabels.result.csvUrl} target="_blank" rel="noreferrer">Mở file CSV</a>
                </div>
              )}
              {pendingDrive && !getBusy && (
                <button className="secondary" onClick={retryDrive}>Thử lưu Drive lại</button>
              )}
              {!!gmailLabels.issues.length && (
                <>
                  <p className="warning" role="alert">Đã dừng lượt chạy trước khi lưu Drive và ghi Sheets.</p>
                  <details open>
                    <summary>Cần kiểm tra ({gmailLabels.issues.length})</summary>
                    <ul>{gmailLabels.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul>
                  </details>
                  {!!gmailLabels.reviewFiles.length && (
                    <button
                      className="secondary"
                      disabled={cutBusy || getBusy || !!review}
                      onClick={() => {
                        navigatePage("cut");
                        void addFiles(gmailLabels.reviewFiles);
                      }}
                    >
                      Kiểm tra PDF trong Cut Label
                    </button>
                  )}
                </>
              )}
            </section>
          )}
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
            <span className="pill">Quét 1 lượt / trang</span>
          </div>
          <div className="workflow" aria-label="Các bước xử lý label">
            <span>
              <b>1</b> Thêm PDF
            </span>
            <span>
              <b>2</b> Kiểm tra mã
            </span>
            <span>
              <b>3</b> Xuất label
            </span>
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
              aria-label="Thêm file PDF"
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
            <small>Chọn nhiều file cùng lúc · Tên file được điền tự động</small>
          </label>
          <div className="status" role="status" aria-live="polite">
            {cutBusy && <span className="spinner" />}
            {cutMsg || "Chưa có file nào được thêm."}
          </div>
          {importErrors.length > 0 && (
            <section className="warning" role="alert">
              <b>Các file/trang chưa đọc được</b>
              <ul>
                {importErrors.map((error, i) => (
                  <li key={i}>{error}</li>
                ))}
              </ul>
            </section>
          )}
          {exportErrors.length > 0 && (
            <section className="warning" role="alert">
              <b>Các trang xuất bị lỗi</b>
              <ul>
                {exportErrors.map((error, i) => (
                  <li key={i}>{error}</li>
                ))}
              </ul>
            </section>
          )}
          {downloadResult && (
            <div className="download-result" role="status">
              <b>{downloadResult.name}</b>
              <a href={downloadResult.url} download={downloadResult.name}>
                Tải lại file
              </a>
              {!downloadResult.batch && (
                <a
                  href={downloadResult.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Xem PDF vừa xuất
                </a>
              )}
            </div>
          )}
          {jobs.length > 0 && (
            <>
              <aside className="notice" aria-label="Lưu ý trước khi xuất">
                <strong>Kiểm tra trước khi xuất</strong>
                <p>
                  OCR có thể nhầm ký tự. Đối chiếu Order ID và USPS với label
                  gốc. Bạn có thể đổi tên file; tên cần kiểm tra sẽ được hỏi
                  trước khi xuất.
                </p>
              </aside>
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
                    onClick={clearJobs}
                    disabled={cutBusy}
                  >
                    Xóa danh sách
                  </button>
                  <button onClick={() => requestExport()} disabled={cutBusy}>
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
                          className={
                            p.orderId && p.source !== "OCR"
                              ? "pill green"
                              : "pill warn"
                          }
                        >
                          {p.orderId
                            ? p.source === "OCR"
                              ? "Đã quét · đối chiếu lại"
                              : "Đã nhận diện"
                            : "Cần kiểm tra ID"}
                        </span>
                      </div>
                      <label className="field">
                        Tên file xuất
                        <input
                          aria-label={`Tên file · ${job.fileName} · trang ${p.pageNo}`}
                          value={p.outputName}
                          disabled={cutBusy}
                          onChange={(e) =>
                            updateId(job.key, p.pageNo, e.target.value)
                          }
                          placeholder="Order ID 24 ký tự hoặc tên tùy chỉnh"
                        />
                        <small>
                          Order ID đã quét: {p.orderId || "Chưa nhận diện được"}
                        </small>
                      </label>
                      <div className="tracking-check">
                        <b>USPS tracking</b>
                        <output>
                          {p.tracking
                            ? p.tracking
                            : "Chưa đọc được mã tracking"}
                        </output>
                        <small>
                          Đọc từ label, chưa xác minh với USPS. So sánh với mã
                          dưới barcode.
                        </small>
                      </div>
                      {p.preview && (
                        <details className="label-preview">
                          <summary>Xem label gốc để đối chiếu</summary>
                          <img
                            src={p.preview}
                            alt={`Label gốc · ${job.fileName} · trang ${p.pageNo}`}
                            loading="lazy"
                          />
                        </details>
                      )}
                      {p.ocrError && (
                        <p role="alert" className="warning">
                          {p.ocrError}
                        </p>
                      )}
                      <div className="inlineActions">
                        <button
                          onClick={() =>
                            requestExport({ jobKey: job.key, pageNo: p.pageNo })
                          }
                          disabled={cutBusy}
                        >
                          Xuất trang này
                        </button>
                        <details>
                          <summary>Xem text đã đọc ({p.source})</summary>
                          <pre>{p.text || "Không có text đọc được."}</pre>
                          {p.source === "OCR" && p.nativeText && (
                            <>
                              <p>Text gốc PDF</p>
                              <pre>{p.nativeText}</pre>
                            </>
                          )}
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
      {review && (
        <ExportReview
          review={review}
          onCancel={() => setReview(null)}
          onConfirm={() => runExport(review.entries, review.batch)}
        />
      )}
    </div>
  );
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
