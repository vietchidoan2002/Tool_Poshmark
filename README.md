# Poshmark Label Tool — React + JavaScript

One web app with two tools:
- **Get Label**: preserves the existing `server/bot.cjs` email parsing and Google Sheets column mapping; allows editing the Sheet ID; runs the bot from the UI; persists refreshed OAuth tokens when Google emits them.
- **Cut Label**: upload PDF labels, extract the Poshmark 24-character Order ID and USPS tracking, fall back to local Tesseract.js OCR, preview the label, choose a custom output filename, and export 4×6 inch PDFs. Batch export creates one ZIP with a tracking manifest.

## Setup

Use Node.js 24 and run `npm ci`, `npm test`, and `npm run build`. Configure PostgreSQL and Google OAuth as described in [RENDER-SETUP.md](docs/RENDER-SETUP.md), then run `npm start` behind HTTPS. The Render blueprint is `render.yaml`.

Sign in, verify your email and connect Gmail/Sheets from Get Label. The server encrypts the Google connection per user.

## Important behavior inherited from Get Label
The original `server/bot.cjs` reads unread Gmail messages, parses Poshmark order blocks, skips Order IDs already present in column H of the `Đơn poshmark` tab, and writes fields into columns B, C, F, G, H, J, K, L, O, R, and W. It removes the UNREAD label after processing. Review the Google Sheet and test with a small number of unread emails first.

## Limitations
- OCR is not infallible. Check Order ID before printing/exporting. It tries to correct common OCR confusions but never trust a result blindly.
- The cropper detects non-white page bounds and renders at 300 DPI (capped for oversized pages). It preserves aspect ratio inside a 4×6 inch page. Output is rasterized; test one label on your physical printer/scanner before bulk printing.

## Development and regression checks

Get Label asks Gmail for up to 25 messages with the `UNREAD` label and matching order keywords per run. The bot checks each message’s current labels before parsing it or fetching attachments. It spaces Google requests and retries transient/rate-limit responses up to three times, respecting `Retry-After` within its execution budget. If messages remain, run again. Unrelated or incompletely parsed messages stay unread. If processing fails after a write, logs preserve the written/skipped counts and the API reports failure; rows already written remain in Sheets. Rerunning skips IDs present in column H. Do not run simultaneous imports into the same sheet.

Cut Label orders native PDF text using page coordinates. For scanned labels, it performs exactly one automatic-layout OCR recognition per page at 300 DPI (within a pixel cap). It does not retry OCR automatically. Native text containing both codes skips OCR entirely. Low-confidence, missing or conflicting Order IDs are left blank with a warning; inspect the extracted text and enter the ID manually. OCR errors preserve the page for manual ID entry/export. Even a high-confidence OCR ID must be checked against the label, since visually similar hexadecimal characters can still be confused.

The automated regression tests mock Google APIs and do not read or change your inbox or Sheets. They cover rate-limit retries, partial failures, duplicate detection, PDF text order, ID extraction and OCR confidence handling.

## Get Label: shipping PDFs from Gmail

In **Thông tin chạy Get Label**, paste an editable Google Drive folder link. **Chạy Get Label** collects the shipping PDFs attached to unread order emails. The browser reads USPS Code 128 barcodes and matches each page against the tracking numbers listed alongside Order IDs in its own email. A PDF can contain multiple pages in any order. There is no OCR step in this automatic flow.

Get Label records valid orders in Sheets first. It then saves each matched 4×6 PDF and a CSV manifest to the chosen Drive folder and writes the corresponding link to column R for orders that do not already have a link. If any row for an Order ID already has a link, Get Label skips that order for Drive uploads and column R updates. A PDF that cannot be linked appears under **Cần kiểm tra**, with its barcode tracking and the relevant Order IDs and email tracking. Open those PDFs in Cut Label for manual review. Emails with PDFs are marked read once their labels are all verified and linked. Each run can collect up to 50 PDFs (8 MiB total), scan up to 80 pages, and upload up to 16 MiB of converted PDFs.

Enable the Google Drive API for the OAuth project, then select **Kết nối / làm mới Gmail & Drive** and grant the Drive permission. The linked Google account must be allowed to add files to the chosen folder. Existing Drive files are reused when retrying after a partial failure.

## Cut Label: filenames, tracking, and exports

1. Upload one or more PDFs (up to 100 MB per file). File names must end in `.pdf`. Corrupt or password-protected files are listed separately; valid neighboring files remain available. Unlock password-protected PDFs before importing them.
2. The first editable field defaults to the scanned Order ID. The original scanned ID stays visible when you choose a custom filename. Any nonempty custom name is allowed after review; it does not have to be an Order ID.
3. USPS tracking is displayed as a continuous code without spaces below the name, with the original-label preview for visual comparison. Tracking is extracted from printed text, not decoded from the barcode or verified with the USPS service. Missing/conflicting tracking stays blank rather than being invented.
4. Exporting a short/custom/empty/duplicate/unsupported name opens a review dialog listing the source file, page, reason and exact proposed output name. Choose **Quay lại sửa** (or Escape) to cancel without downloading, or **Tiếp tục xuất** to approve. Missing names fall back to the source filename plus page number. Duplicate names get numeric suffixes; unsupported filename characters are cleaned for Windows compatibility.
5. **Xuất trang này** downloads one PDF. **Xuất tất cả** downloads a ZIP containing separate PDFs and `danh-sach-label.csv` with source, page, scanned ID, tracking and output filename. A failed page is listed in the UI and in `loi-xuat.txt`; successful pages remain in the ZIP. Blank pages are rejected.
6. A persistent **Tải lại file** link is available after export. Single-PDF exports also offer **Xem PDF vừa xuất**. These links remain available until the next export, clearing the list, or closing/reloading the app. Processing happens in the browser; reloading the app clears imported PDFs.

OCR has a 45-second time budget per page. It warns on unreliable/missing IDs, and keeps the page available for manual naming if recognition fails. A single shared PDF worker and disabled import/export controls prevent overlapping operations while processing. Large batches may still need to be split to fit the browser's available memory.

### Browser regression suite

With Chromium installed (default `/usr/bin/chromium`, override with `CHROMIUM_PATH`), run `npm run test:browser` against a running build. The default test URL is `http://127.0.0.1:10000`. Set `LABEL_TEST_URL` to use a different test deployment.

The browser suite covers native/scanned labels, custom/default/missing/duplicate names, cancel/Escape, ZIP contents and manifest, valid PDFs surviving corrupt/encrypted neighbors, OCR asset failure, blank-page partial failure, page rotation, clear/re-import, busy controls, actual offline OCR and download/re-download. It verifies exported PDFs parse and have exactly one 4×6 inch page. It mocks the backend and never modifies Gmail or Sheets. The encrypted fixture uses fictional content and password `test-password`.

An optional private reference PDF can be tested using `LABEL_SAMPLE_PDF`, `LABEL_SAMPLE_ORDER_ID` and `LABEL_SAMPLE_TRACKING`; do not commit real shipping labels or credentials. The suite skips this optional check when no sample path is provided. Validation covers these specified cases in Chromium; it does not establish every possible PDF, OCR result, browser or printer behavior.

The interface uses local system fonts (no font-CDN requests), highlights cautions in amber and errors in red, and provides a keyboard-accessible upload field. OCR progress identifies the file and page. An OCR render is reused to create the preview instead of rendering the page twice. Mobile layout, direct tracking display and one-recognition-per-page behavior are covered by regression tests. OCR accuracy remains dependent on the source image; always check the original label, especially visually similar hexadecimal characters.

## Deployment

The Render Free blueprint runs the web app on the `preview/ui-single-pass-ocr` branch and uses an external Neon PostgreSQL database. See [RENDER-SETUP.md](docs/RENDER-SETUP.md). Test live Gmail, Sheets and Neon on the deployed service before onboarding users.

Phone management is available only in authenticated web mode. ADMIN_EMAILS selects administrators using verified account email addresses. Users can save only their own normalized phone; administrators can search, edit, delete and manually review phones. REQUIRE_REVIEWED_PHONE=true gates Get Label on manual review, not Cut Label. Formatting checks are not SMS verification or proof of SIM ownership. Review setup and schema notes in docs/RENDER-SETUP.md.

## Email/password account pages

The full web service opens on sign-in and requires an authenticated, email-verified session before displaying either tool. Sign-up requires a name, email, phone and confirmed password; it returns to sign-in rather than logging in automatically. Phone editing and administration live in the separate Hồ sơ tab. REQUIRE_REVIEWED_PHONE=false (the new deployment default) allows phone review after email activation; update this variable manually on existing Render services if previously true. Dedicated forgot/reset password and email verification pages remain available. See [EMAIL-PASSWORD-AUTH.md](docs/EMAIL-PASSWORD-AUTH.md) for cookie lifetimes, email delivery setup, Google-account compatibility and recovery. Gmail/Sheets connection stays separate from website credentials. Admin Gmail API delivery is opt-in through AUTH_MAIL_PROVIDER=gmail and AUTH_MAIL_SENDER_EMAIL; existing OAuth/SMTP credentials are not automatically used to send emails. Missing mail setup is shown in the UI.

Each normalized email now has one website account across Google and password sign-in. Startup reconciles legacy duplicate rows transactionally, archives the originals encrypted, preserves phone/configuration, and enforces a case-insensitive unique email index. Unverified pre-registration passwords are disabled when Google proves ownership; verified passwords are retained. See docs/EMAIL-PASSWORD-AUTH.md for migration and recovery behavior.

The administrator dashboard at /#/admin provides account creation, profile edits, suspension, soft deletion/restore and Get Label statistics by user/account. Access uses verified ADMIN_EMAILS; setup invitations contain no shared passwords. Tracking starts at this release and does not import historical Sheet totals. See [ADMIN-DASHBOARD.md](docs/ADMIN-DASHBOARD.md).
