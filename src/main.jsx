import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { PDFDocument } from "pdf-lib";
import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { createWorker } from "tesseract.js";
import "./style.css";
import PhoneManager from "./PhoneManager.jsx";
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

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

let sharedPdfWorker;
const getPdfWorker = () => (sharedPdfWorker ||= new pdfjsLib.PDFWorker());
const PREVIEW_ONLY = import.meta.env.VITE_PREVIEW_ONLY === "true";
const API = ""; // Same-origin API; Vite proxies local development requests.

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
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const bounds = contentBounds(
    ctx.getImageData(0, 0, canvas.width, canvas.height),
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
  const [page, setPage] = useState(PREVIEW_ONLY ? "cut" : "get");
  const [webMode, setWebMode] = useState(PREVIEW_ONLY);
  const [authenticated, setAuthenticated] = useState(false);
  const [sessionReady, setSessionReady] = useState(PREVIEW_ONLY);
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
  const [sheetName, setSheetName] = useState(
    () => localStorage.getItem("pm_default_sheet_name") || "",
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
    if (PREVIEW_ONLY) return;
    const generation = ++refreshGeneration.current;
    try {
      const sessionResponse = await fetch(API + "/api/session");
      if (!sessionResponse.ok) throw new Error("Session unavailable");
      const session = await sessionResponse.json();
      if (
        typeof session.webMode !== "boolean" ||
        typeof session.authenticated !== "boolean"
      )
        throw new Error("Invalid session response");
      if (generation !== refreshGeneration.current) return;
      setAuthError("");
      setWebMode(!!session.webMode);
      setAuthenticated(!!session.authenticated);
      setEmailVerified(session.emailVerified === true);
      setSessionReady(true);
      if (session.webMode && authUser.current !== session.userId) {
        authUser.current = session.userId || null;
        sheetDraft.current = null;
        setSheetId("");
        setSheetName("");
        setAccountName("");
        setGetOutput("");
        setPhoneReady(false);
      }
      if (session.webMode && !session.authenticated) {
        setGmail({ credentialsPresent: true, accounts: [] });
        setTokenFile("");
        return;
      }
      if (session.webMode && !session.emailVerified) return;
      const [c, g, profile] = await Promise.all([
        fetch(API + "/api/config").then((r) => r.json()),
        fetch(API + "/api/gmail/status").then((r) => r.json()),
        session.webMode
          ? fetch(API + "/api/profile").then((r) => {
              if (!r.ok) throw Error("Profile unavailable");
              return r.json();
            })
          : null,
      ]);
      if (generation !== refreshGeneration.current) return;
      if (profile) setPhoneReady(!profile.phoneRequired || profile.reviewed);
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

  function changeSheetName(value) {
    setSheetName(value);
    if (!webMode) localStorage.setItem("pm_default_sheet_name", value);
  }

  useEffect(() => {
    refresh();
    const checkVersion = async () => {
      if (PREVIEW_ONLY) return;
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
    if (webMode) {
      if (
        jobs.length &&
        !window.confirm(
          "Đăng nhập Google sẽ tải lại trang và xóa danh sách PDF đang mở. Tiếp tục?",
        )
      )
        return;
      window.location.assign("/api/auth/start");
    } else window.open("/api/auth/start", "_blank", "noopener,noreferrer");
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
      if (!r.ok)
        setGetOutput(
          (d.error || "Get Label thất bại.") + "\n" + (d.output || ""),
        );
      await refresh();
    } catch (e) {
      setGetOutput("Lỗi kết nối: " + e.message);
    } finally {
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
  if (!PREVIEW_ONLY && !sessionReady)
    return (
      <div className="auth-shell">
        <main className="auth-card" aria-busy={!authError}>
          <h1>Poshmark Label Manager</h1>
          <p role="status">{authError || "Đang kiểm tra phiên đăng nhập…"}</p>
          {authError && <button onClick={refresh}>Thử lại kết nối</button>}
        </main>
      </div>
    );
  const requiredAuth = !PREVIEW_ONLY && webMode && !authenticated;
  if ((authView || requiredAuth) && !PREVIEW_ONLY)
    return (
      <AuthPage
        mode={
          authView === "verify-email" && requiredAuth
            ? "login"
            : authView || "login"
        }
        verificationPending={verifyPending.current}
        token={authToken.current}
        onNavigate={openAuth}
        onBack={!webMode || authenticated ? () => openAuth(null) : undefined}
        backLabel={
          webMode && !emailVerified ? "← Quay lại tài khoản" : undefined
        }
        onAuth={authCompleted}
        onGoogle={connectGoogle}
      />
    );
  if (!PREVIEW_ONLY && webMode && !emailVerified)
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
      <header className="top">
        <div className="logo">PM</div>
        <div className="headcopy">
          <h1>Poshmark Label Manager</h1>
          <p>Đơn hàng gọn gàng. Label sẵn sàng.</p>
        </div>
        {!PREVIEW_ONLY && webMode && !authenticated && (
          <div className="account-actions">
            <button className="secondary" onClick={() => openAuth("login")}>
              Đăng nhập
            </button>
            <button onClick={() => openAuth("register")}>Đăng ký</button>
          </div>
        )}
      </header>
      {logoutError && (
        <p className="warning" role="alert">
          {logoutError}
        </p>
      )}
      {authError && !PREVIEW_ONLY && (
        <aside className="warning" role="alert">
          <strong>Kết nối tài khoản chưa sẵn sàng</strong>
          <p>{authError}</p>
          <button className="secondary" onClick={refresh}>
            Thử lại kết nối
          </button>
        </aside>
      )}
      {webMode && authenticated && (
        <div className="inlineActions">
          <button
            className="secondary"
            onClick={logout}
            disabled={getBusy || cutBusy}
          >
            Đăng xuất
          </button>
        </div>
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
      {PREVIEW_ONLY && (
        <aside className="notice">
          <strong>Bản xem thử · chưa kết nối Gmail/Sheets</strong>
          <p>
            Cut Label hoạt động trong trình duyệt. PDF không được tải lên máy
            chủ. Chưa cần đăng nhập hoặc cài phần mềm.
          </p>
        </aside>
      )}
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
        {webMode && authenticated && !PREVIEW_ONLY && (
          <button
            className={page === "profile" ? "active" : ""}
            onClick={() => setPage("profile")}
          >
            Hồ sơ / Quản trị
          </button>
        )}
      </nav>
      {page === "profile" && webMode && authenticated ? (
        <main className="panel">
          <div className="panelhead">
            <div>
              <h2>Hồ sơ tài khoản</h2>
              <p>
                Cập nhật số điện thoại. Quản trị viên quản lý thông tin người
                dùng tại đây.
              </p>
            </div>
          </div>
          <PhoneManager key={authUser.current} onEligibility={setPhoneReady} />
        </main>
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
          {webMode && !authenticated ? (
            <section className="configbox">
              <h3>
                {PREVIEW_ONLY
                  ? "Gmail/Sheets sẽ được bổ sung sau"
                  : "Đăng nhập hoặc tạo tài khoản"}
              </h3>
              <p>
                {PREVIEW_ONLY
                  ? "Bản xem thử chưa bật tài khoản Google. Chọn Cut Label để thử quét và xuất PDF ngay trong trình duyệt."
                  : "Đăng nhập hoặc đăng ký bằng email và mật khẩu. Sau khi xác nhận email, bạn kết nối Gmail/Sheets riêng. Tài khoản Google cũ vẫn đăng nhập được bằng tùy chọn Google."}
              </p>
              <div className="inlineActions">
                {!PREVIEW_ONLY && (
                  <>
                    <button onClick={() => openAuth("login")}>
                      Mở trang đăng nhập
                    </button>
                    <button className="secondary" onClick={connectGoogle}>
                      Đăng nhập bằng Google
                    </button>
                  </>
                )}
              </div>
            </section>
          ) : (
            <>
              {webMode && !phoneReady && (
                <aside className="warning">
                  Cần kiểm tra thông tin điện thoại trước khi chạy Get Label.{" "}
                  <button
                    className="text-button"
                    onClick={() => setPage("profile")}
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
                {!gmail.credentialsPresent && (
                  <p className="warning">
                    Thiếu credentials.json. Hãy đặt file OAuth credentials vào
                    thư mục gốc theo README.
                  </p>
                )}
                {gmail.accounts?.length ? (
                  gmail.accounts.map((a) => (
                    <div className="account" key={a.file}>
                      <span className="dot" />
                      <div className="accountInfo">
                        <b>{a.email}</b>
                        <small>
                          {a.hasRefreshToken
                            ? "Có refresh token — tự làm mới khi hết hạn"
                            : "Không có refresh token — có thể cần kết nối lại"}
                        </small>
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
                    Kết nối / làm mới Gmail
                  </button>
                  <button
                    className="secondary"
                    onClick={refresh}
                    title="Đọc lại tài khoản Gmail đã kết nối, không cập nhật phiên bản phần mềm"
                  >
                    Cập nhật tài khoản Gmail
                  </button>
                </div>
                <p className="hint">
                  Token còn refresh token sẽ được tự làm mới và lưu lại. Nếu bị
                  thu hồi, hãy kết nối Gmail lại.
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
                <p className="hint">
                  Tên account Poshmark không được lưu. Tên tab sẽ được lưu trên
                  máy và tự điền lần sau.
                </p>
              </section>
              <aside className="notice" role="note">
                <strong>Lưu ý: thao tác trên dữ liệu thật</strong>
                <p>
                  Get Label ghi vào Google Sheets và đánh dấu email đã xử lý là
                  đã đọc. Kiểm tra đúng Gmail, Sheet và tên tab trước khi chạy.
                </p>
              </aside>
              <section className="runbox">
                <div>
                  <h3>Chạy lấy đơn</h3>
                  <p>
                    Quét email chưa đọc, bỏ qua Order ID đã có trong Sheet, ghi
                    dữ liệu vào tab “{sheetName || "đã chọn"}”.
                  </p>
                </div>
                <button
                  disabled={
                    getBusy ||
                    (webMode && !phoneReady) ||
                    !sheetId ||
                    !gmail.accounts?.length ||
                    !accountName.trim() ||
                    !sheetName.trim() ||
                    !tokenFile
                  }
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
            </>
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
