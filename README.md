# Poshmark Label Manager — React + JavaScript

One local app with two pages:
- **Get Label**: preserves the existing `bot.js` email parsing and Google Sheets column mapping; allows editing the Sheet ID; runs the bot from the UI; persists refreshed OAuth tokens when Google emits them.
- **Cut Label**: upload PDF labels, attempt to extract the Poshmark 24-character Order ID after `Order #`, fall back to Tesseract.js OCR, edit the ID if needed, and export each page as a 4×6 inch PDF named `<OrderID>.pdf`.

## Windows setup
1. Install Node.js LTS from https://nodejs.org/.
2. Extract this folder to a normal location.
3. Create `config.json` from `config.example.json` (the app can do this on first launch) and enter the Google Sheets ID in the app UI.
4. Copy your own Google OAuth `credentials.json` into this folder. **Do not share it.** It must have a redirect URI `http://localhost:3210/oauth2callback` registered in Google Cloud Console. Enable Gmail API and Google Sheets API.
5. Double-click `Start Poshmark Label Manager.bat`. The first run needs internet to install npm packages and download OCR language data.
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
- The cropper detects non-white page bounds and rasterizes the result. Fine print/barcodes may be softer than original vector PDFs; test one label before bulk printing.
- The app binds locally to 127.0.0.1 and is intended for one desktop user.
