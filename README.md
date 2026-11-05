# Poshmark Label Manager — React + JavaScript

One local app with two pages:
- **Get Label**: preserves the existing `bot.js` email parsing and Google Sheets column mapping; allows editing the Sheet ID; runs the bot from the UI; persists refreshed OAuth tokens when Google emits them.
- **Cut Label**: upload PDF labels, extract the Poshmark 24-character Order ID and USPS tracking, fall back to local Tesseract.js OCR, preview the label, choose a custom output filename, and export 4×6 inch PDFs. Batch export creates one ZIP with a tracking manifest.

## Windows setup
1. Install Node.js LTS from https://nodejs.org/.
2. Extract this folder to a normal location.
3. Create `config.json` from `config.example.json` (the app can do this on first launch) and enter the Google Sheets ID in the app UI.
4. Copy your own Google OAuth `credentials.json` into this folder. **Do not share it.** It must have a redirect URI `http://localhost:3210/oauth2callback` registered in Google Cloud Console. Enable Gmail API and Google Sheets API.
5. Double-click `Chạy Tool.bat`. The first run needs internet to install npm packages. OCR worker, core, and English language data are bundled locally by Vite.
6. Open http://127.0.0.1:5173. In Get Label, click **Kết nối / làm mới Gmail**, sign in, grant Gmail modify and Sheets permissions, then return to the app.
7. Confirm the Sheet ID, then click **Chạy Get Label**. On Cut Label, upload PDFs and check every ID before exporting.

## OAuth and tokens
- `credentials.json` contains your OAuth client secret. Keep it private.
- `token_*.json` contains account access/refresh tokens. Keep these private too.
- Existing `token_*.json` files from the old tool can be copied into the project root. If a refresh token exists, Google APIs can refresh expired access tokens; this app writes updated tokens back to the file.
- If a refresh token is revoked/expired or Google requires consent again, use **Kết nối / làm mới Gmail**.
- Do not upload `credentials.json`, `token_*.json`, or `config.json` to public repositories.

## Important behavior inherited from Get Label
The original `bot.js` reads unread Gmail messages, parses Poshmark order blocks, skips Order IDs already present in column H of the `Đơn poshmark` tab, and writes fields into columns B, C, F, G, H, J, K, L, O, R, and W. It removes the UNREAD label after processing. Review the Google Sheet and test with a small number of unread emails first.

## Limitations
- OCR is not infallible. Check Order ID before printing/exporting. It tries to correct common OCR confusions but never trust a result blindly.
- The cropper detects non-white page bounds and renders at 300 DPI (capped for oversized pages). It preserves aspect ratio inside a 4×6 inch page. Output is rasterized; test one label on your physical printer/scanner before bulk printing.
- The app binds locally to 127.0.0.1 and is intended for one desktop user.

## Development and regression checks

Use Node.js 24 (validated with 24.19.0) and npm. Run `npm ci`, `npm test`, and `npm run build`. Use `npm run dev` for the Vite frontend and Express API, or `npm start` after building to serve the built frontend and API together. These servers use loopback addresses as described above.

Get Label processes at most 25 unread messages matching `"Order Number"` or `"Order Date"` per run. It spaces Google requests and retries transient/rate-limit responses up to three times, respecting `Retry-After` within its execution budget. If messages remain, run again. Unrelated or incompletely parsed messages stay unread. If processing fails after a write, logs preserve the written/skipped counts and the API reports failure; rows already written remain in Sheets. Rerunning skips IDs present in column H. Do not run simultaneous imports into the same sheet.

Cut Label orders native PDF text using page coordinates. For scanned labels, it performs exactly one automatic-layout OCR recognition per page at 300 DPI (within a pixel cap). It does not retry OCR automatically. Native text containing both codes skips OCR entirely. Low-confidence, missing or conflicting Order IDs are left blank with a warning; inspect the extracted text and enter the ID manually. OCR errors preserve the page for manual ID entry/export. Even a high-confidence OCR ID must be checked against the label, since visually similar hexadecimal characters can still be confused.

The automated regression tests mock Google APIs and do not read or change your inbox or Sheets. They cover rate-limit retries, partial failures, duplicate detection, PDF text order, ID extraction and OCR confidence handling.

## Cut Label: filenames, tracking, and exports

1. Upload one or more PDFs (up to 100 MB per file). File names must end in `.pdf`. Corrupt or password-protected files are listed separately; valid neighboring files remain available. Unlock password-protected PDFs before importing them.
2. The first editable field defaults to the scanned Order ID. The original scanned ID stays visible when you choose a custom filename. Any nonempty custom name is allowed after review; it does not have to be an Order ID.
3. USPS tracking is displayed as a continuous code without spaces below the name, with the original-label preview for visual comparison. Tracking is extracted from printed text, not decoded from the barcode or verified with the USPS service. Missing/conflicting tracking stays blank rather than being invented.
4. Exporting a short/custom/empty/duplicate/unsupported name opens a review dialog listing the source file, page, reason and exact proposed output name. Choose **Quay lại sửa** (or Escape) to cancel without downloading, or **Tiếp tục xuất** to approve. Missing names fall back to the source filename plus page number. Duplicate names get numeric suffixes; unsupported filename characters are cleaned for Windows compatibility.
5. **Xuất trang này** downloads one PDF. **Xuất tất cả** downloads a ZIP containing separate PDFs and `danh-sach-label.csv` with source, page, scanned ID, tracking and output filename. A failed page is listed in the UI and in `loi-xuat.txt`; successful pages remain in the ZIP. Blank pages are rejected.
6. A persistent **Tải lại file** link is available after export. Single-PDF exports also offer **Xem PDF vừa xuất**. These links remain available until the next export, clearing the list, or closing/reloading the app. Processing happens in the browser; reloading the app clears imported PDFs.

OCR has a 45-second time budget per page. It warns on unreliable/missing IDs, and keeps the page available for manual naming if recognition fails. A single shared PDF worker and disabled import/export controls prevent overlapping operations while processing. Large batches may still need to be split to fit the browser's available memory.

### Browser regression suite

With Chromium installed (default `/usr/bin/chromium`, override with `CHROMIUM_PATH`), run `npm run dev` in another terminal, then `npm run test:browser`. To test a built instance, run `npm run build` and `npm start`, then use `LABEL_TEST_URL=http://127.0.0.1:3210 npm run test:browser`.

The browser suite covers native/scanned labels, custom/default/missing/duplicate names, cancel/Escape, ZIP contents and manifest, valid PDFs surviving corrupt/encrypted neighbors, OCR asset failure, blank-page partial failure, page rotation, clear/re-import, busy controls, actual offline OCR and download/re-download. It verifies exported PDFs parse and have exactly one 4×6 inch page. It mocks the backend and never modifies Gmail or Sheets. The encrypted fixture uses fictional content and password `test-password`.

An optional private reference PDF can be tested using `LABEL_SAMPLE_PDF`, `LABEL_SAMPLE_ORDER_ID` and `LABEL_SAMPLE_TRACKING`; do not commit real shipping labels or credentials. The suite skips this optional check when no sample path is provided. Validation covers these specified cases in Chromium; it does not establish every possible PDF, OCR result, browser or printer behavior.

The interface uses local system fonts (no font-CDN requests), highlights cautions in amber and errors in red, and provides a keyboard-accessible upload field. OCR progress identifies the file and page. An OCR render is reused to create the preview instead of rendering the page twice. Mobile layout, direct tracking display and one-recognition-per-page behavior are covered by regression tests. OCR accuracy remains dependent on the source image; always check the original label, especially visually similar hexadecimal characters.

## Render preview and multi-user web mode

For the no-paid-services preview, follow [RENDER-PREVIEW.md](docs/RENDER-PREVIEW.md). The default render.yaml creates a static Cut Label preview only, built with VITE_PREVIEW_ONLY=true. It has no Gmail APIs, database or login.

The separate `npm run start:web` entrypoint implements Google login, user-scoped encrypted credentials/Sheet IDs, origin checks and import locks with PostgreSQL. This is not the local `npm start` server. The full free-tier configuration (Render Free plus external Neon Free database) is in render.web.yaml and is not deployed by the default preview blueprint. See [RENDER-SETUP.md](docs/RENDER-SETUP.md). Live Google/Render/PostgreSQL verification is still required before a full multi-user launch; automated backend tests use fake Google, in-memory SQL and session storage. Never expose the old local-file API server publicly.

For Gmail/Sheets without choosing paid infrastructure, follow [RENDER-SETUP.md](docs/RENDER-SETUP.md). The free web service is separate from the static Cut Label preview. Google OAuth secrets and the Neon direct database URL must be set securely in Render Environment; the static site cannot host those APIs. Free plans have quotas/sleep behavior, and live provider configuration must still be verified.

Phone management is available only in authenticated web mode. ADMIN_EMAILS selects administrators using verified Google email addresses. Users can save only their own normalized phone; administrators can search, edit, delete and manually review phones. REQUIRE_REVIEWED_PHONE=true gates Get Label on manual review, not Cut Label. Formatting checks are not SMS verification or proof of SIM ownership. Review setup and schema notes in docs/RENDER-SETUP.md.
