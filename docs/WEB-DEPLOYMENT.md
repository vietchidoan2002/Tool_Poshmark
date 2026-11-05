# Central web deployment: agreed direction

Status: web-mode implementation available for preview deployment, not yet verified with live Google login or Render/PostgreSQL. Run `npm run start:web` for authenticated, user-scoped APIs backed by PostgreSQL. The original `npm start`/`npm run dev` server is still a LOCAL single-user tool and must never be exposed publicly. See RENDER-SETUP.md for deployment steps and costs.

The requested model is one centrally updated website with each person connecting their own Gmail and Sheets. The API is now same-origin so the frontend does not call a visitor's local machine. Vite proxies API requests during local development. Production build and API must be served together behind HTTPS.

## Implemented design and release requirements

- Sign in with Google and keep a secure server-side session for each person. Bind Google OAuth state to the browser session, register the chosen HTTPS callback URL, and rotate sessions after login.
- Use Google's stable user identifier to scope all token, Sheet configuration, account-status, deletion and Get Label operations. Client parameters must never select another person's token file.
- Replace shared credentials/config/token files with persistent per-user storage. Encrypt refresh tokens using a server-held key, and never return them to the frontend or place them in logs.
- Run imports with per-user locks and quotas; propagate partial failures. Keep development's local-file workflow separate from production's user-scoped workflow.
- Keep Cut Label PDFs/OCR in the browser. Deploy the bundled OCR assets with the site. Do not upload shipping labels to the server for this workflow.
- Use persistent database/storage, HTTPS, secured cookies and CSRF/origin checks. OAuth client secrets and encryption keys must be configured securely in hosting settings, never in chat or source code.
- Serve HTML without permanent caching and use Vite's hashed asset versions. Notify active users when a new version is available; do not force a reload while imported PDFs or exports are in memory.

## Release gates

Test two users concurrently: A cannot read/change/delete B's token, Sheet ID or import. Test expired/revoked tokens, failed consent, bad OAuth state, logout, server restart, database restoration, quota backoff and concurrent imports. Retain the browser regression suite for Cut Label. Run these before production launch; local tests do not demonstrate multi-user isolation.

## Deployment inputs still needed

Choose hosting and a domain/HTTPS URL, then configure Google OAuth for that URL and the storage/key requirements. Changes stay on the preview branch until the owner approves merging. Publishing a Codex environment is not publishing this website.
