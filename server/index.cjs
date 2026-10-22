const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { google } = require('googleapis');
const app = express();
const ROOT = path.resolve(__dirname, '..');
const PORT = 3210;
const CONFIG_PATH = path.join(ROOT, 'config.json');
const CREDENTIALS_PATH = path.join(ROOT, 'credentials.json');
app.use((req, res, next) => { res.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1:5173'); res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type'); if (req.method === 'OPTIONS') return res.sendStatus(204); next(); });
app.use(express.json({ limit: '1mb' }));
function readConfig() { try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return { sheetId: '' }; } }
function writeConfig(value) { fs.writeFileSync(CONFIG_PATH, JSON.stringify(value, null, 2)); }
function tokenFiles() { return fs.readdirSync(ROOT).filter(f => /^token_.+\.json$/i.test(f)); }
function loadOAuth() {
  if (!fs.existsSync(CREDENTIALS_PATH)) throw new Error('Thiếu credentials.json. Hãy sao chép credentials.example.json thành credentials.json và cấu hình OAuth của Google.');
  const c = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  const k = c.installed || c.web;
  if (!k || !k.client_id || !k.client_secret) throw new Error('credentials.json không có client_id/client_secret hợp lệ.');
  return new google.auth.OAuth2(k.client_id, k.client_secret, 'http://localhost:3210/oauth2callback');
}
function connectTokenPersistence(auth, tokenPath) {
  auth.on('tokens', fresh => {
    try {
      const old = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
      fs.writeFileSync(tokenPath, JSON.stringify({ ...old, ...fresh }, null, 2));
    } catch (e) { console.error('Không lưu được token refresh:', e.message); }
  });
}
app.get('/api/config', (req, res) => res.json({ sheetId: readConfig().sheetId || '' }));
app.post('/api/config', (req, res) => {
  const sheetId = String(req.body?.sheetId || '').trim();
  if (!sheetId || !/^[\w-]{20,}$/.test(sheetId)) return res.status(400).json({ error: 'Sheet ID chưa hợp lệ. Hãy dán ID nằm giữa /d/ và /edit trong URL Google Sheets.' });
  writeConfig({ ...readConfig(), sheetId });
  res.json({ ok: true, sheetId });
});
app.get('/api/gmail/status', (req, res) => {
  const files = tokenFiles();
  res.json({ credentialsPresent: fs.existsSync(CREDENTIALS_PATH), accounts: files.map(file => {
    let email = file.slice(6, -5), hasRefreshToken = false, expiryDate = null;
    try { const t = JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8')); hasRefreshToken = !!t.refresh_token; expiryDate = t.expiry_date || null; } catch {}
    return { file, email, hasRefreshToken, expiryDate };
  }) });
});
app.get('/api/auth/start', (req, res) => {
  try {
    const auth = loadOAuth();
    const url = auth.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: ['https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/spreadsheets'] });
    res.redirect(url);
  } catch (e) { res.status(500).send(`<h2>Không thể kết nối Gmail</h2><p>${String(e.message).replace(/</g,'&lt;')}</p><p>Kiểm tra credentials.json và redirect URI http://localhost:3210/oauth2callback.</p>`); }
});
app.get('/oauth2callback', async (req, res) => {
  try {
    if (req.query.error) throw new Error(String(req.query.error));
    const auth = loadOAuth();
    const { tokens } = await auth.getToken(String(req.query.code || ''));
    auth.setCredentials(tokens);
    const gmail = google.gmail({ version: 'v1', auth });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    const email = String(profile.data.emailAddress || `account_${Date.now()}`).toLowerCase();
    const tokenPath = path.join(ROOT, `token_${email}.json`);
    let previous = {};
    try { previous = JSON.parse(fs.readFileSync(tokenPath, 'utf8')); } catch {}
    fs.writeFileSync(tokenPath, JSON.stringify({ ...previous, ...tokens }, null, 2));
    res.send('<h2>Đã kết nối Gmail thành công</h2><p>Token đã được lưu. Bạn có thể đóng tab này và quay lại Poshmark Label Manager.</p><script>setTimeout(()=>window.close(),1800)</script>');
  } catch (e) { res.status(500).send(`<h2>Không thể hoàn tất xác thực</h2><pre>${String(e.message).replace(/</g,'&lt;')}</pre>`); }
});
app.post('/api/get-label/run', async (req, res) => {
  const config = readConfig();
  if (!config.sheetId) return res.status(400).json({ error: 'Hãy lưu Google Sheets ID trước khi chạy.' });
  const files = tokenFiles();
  if (!files.length) return res.status(400).json({ error: 'Chưa có token Gmail. Bấm “Kết nối / làm mới Gmail”.' });
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'bot.cjs')], { cwd: ROOT, windowsHide: true });
  let output = '', settled = false;
  child.stdout.on('data', d => output += d.toString());
  child.stderr.on('data', d => output += d.toString());
  // Existing bot prompts for account selection only when multiple tokens exist, then asks account label per account.
  child.stdin.write(files.length > 1 ? ('0\n' + '\n'.repeat(files.length)) : '\n');
  const timeout = setTimeout(() => { if (!settled) { child.kill(); res.status(504).json({ error: 'Get Label chạy quá 3 phút và đã dừng.', output }); settled = true; } }, 180000);
  child.on('close', code => { clearTimeout(timeout); if (settled) return; settled = true; res.json({ ok: code === 0, code, output }); });
  child.on('error', e => { clearTimeout(timeout); if (settled) return; settled = true; res.status(500).json({ error: e.message, output }); });
});
const dist = path.join(ROOT, 'dist');
if (fs.existsSync(dist)) { app.use(express.static(dist)); app.get('*', (req, res) => res.sendFile(path.join(dist, 'index.html'))); }
app.listen(PORT, '127.0.0.1', () => console.log(`Poshmark Label Manager API: http://127.0.0.1:${PORT}`));
