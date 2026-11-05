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

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1:5173');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '1mb' }));

function readConfig() {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    // Migrate the old example placeholder without changing a real saved ID.
    if (config.sheetId === 'PASTE_GOOGLE_SHEET_ID_HERE') config.sheetId = '';
    return config;
  }
  catch { return { sheetId: '' }; }
}
function writeConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}
function tokenFiles() {
  return fs.readdirSync(ROOT).filter(file => /^token_.+\.json$/i.test(file));
}
function loadOAuth() {
  if (!fs.existsSync(CREDENTIALS_PATH)) throw new Error('Thiếu credentials.json trong thư mục gốc.');
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  const key = credentials.installed || credentials.web;
  if (!key?.client_id || !key?.client_secret) throw new Error('credentials.json thiếu client_id hoặc client_secret.');
  return new google.auth.OAuth2(key.client_id, key.client_secret, 'http://localhost:3210/oauth2callback');
}

app.get('/api/config', (req, res) => {
  const config = readConfig();
  res.json({ sheetId: config.sheetId || '' });
});
app.post('/api/config', (req, res) => {
  const sheetId = String(req.body?.sheetId || '').trim();
  if (!sheetId || !/^[\w-]{20,}$/.test(sheetId)) {
    return res.status(400).json({ error: 'Sheet ID chưa hợp lệ. Hãy dán ID nằm giữa /d/ và /edit trong URL Google Sheets.' });
  }
  const config = readConfig();
  writeConfig({ ...config, sheetId });
  res.json({ ok: true, sheetId });
});

app.get('/api/gmail/status', (req, res) => {
  const accounts = tokenFiles().map(file => {
    let hasRefreshToken = false;
    let expiryDate = null;
    try {
      const token = JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
      hasRefreshToken = !!token.refresh_token;
      expiryDate = token.expiry_date || null;
    } catch {}
    return { file, email: file.slice(6, -5), hasRefreshToken, expiryDate };
  });
  res.json({ credentialsPresent: fs.existsSync(CREDENTIALS_PATH), accounts });
});

app.post('/api/gmail/delete-token', (req, res) => {
  const file = String(req.body?.file || '').trim();
  if (!/^token_.+\.json$/i.test(file)) return res.status(400).json({ error: 'Tên file token không hợp lệ.' });
  if (!tokenFiles().includes(file)) return res.status(404).json({ error: 'Không tìm thấy token Gmail này.' });
  try {
    fs.unlinkSync(path.join(ROOT, file));
    res.json({ ok: true, message: 'Đã xóa token Gmail.' });
  } catch (error) {
    res.status(500).json({ error: 'Không thể xóa token: ' + error.message });
  }
});

app.get('/api/auth/start', (req, res) => {
  try {
    const auth = loadOAuth();
    const url = auth.generateAuthUrl({
      access_type: 'offline', prompt: 'consent',
      scope: ['https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/spreadsheets']
    });
    res.redirect(url);
  } catch (error) {
    res.status(500).send(`<h2>Không thể kết nối Gmail</h2><p>${String(error.message).replace(/</g, '&lt;')}</p><p>Kiểm tra credentials.json và redirect URI http://localhost:3210/oauth2callback.</p>`);
  }
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
  } catch (error) {
    res.status(500).send(`<h2>Không thể hoàn tất xác thực</h2><pre>${String(error.message).replace(/</g, '&lt;')}</pre>`);
  }
});

app.post('/api/get-label/run', (req, res) => {
  const config = readConfig();
  if (!config.sheetId) return res.status(400).json({ error: 'Hãy lưu Google Sheets ID trước khi chạy.' });

  const accountName = String(req.body?.accountName || '').trim();
  const sheetName = String(req.body?.sheetName || '').trim();
  const tokenFile = String(req.body?.tokenFile || '').trim();
  if (!accountName) return res.status(400).json({ error: 'Hãy nhập tên account Poshmark.' });
  if (!sheetName) return res.status(400).json({ error: 'Hãy nhập tên tab Google Sheets.' });
  if (!/^token_.+\.json$/i.test(tokenFile) || !tokenFiles().includes(tokenFile)) {
    return res.status(400).json({ error: 'Hãy chọn một tài khoản Gmail hợp lệ.' });
  }
  if (!fs.existsSync(CREDENTIALS_PATH)) return res.status(400).json({ error: 'Thiếu credentials.json trong thư mục gốc.' });

  const child = spawn(process.execPath, [path.join(__dirname, 'bot.cjs')], {
    cwd: ROOT, windowsHide: true,
    env: { ...process.env, PM_ACCOUNT_NAME: accountName, PM_SHEET_NAME: sheetName, PM_TOKEN_FILE: tokenFile }
  });
  let output = '';
  let settled = false;
  child.stdout.on('data', data => { output += data.toString(); });
  child.stderr.on('data', data => { output += data.toString(); });

  const timeout = setTimeout(() => {
    if (settled) return;
    settled = true;
    child.kill();
    res.status(504).json({ error: 'Get Label chạy quá 3 phút và đã dừng.', output });
  }, 180000);

  child.on('close', code => {
    clearTimeout(timeout);
    if (settled) return;
    settled = true;
    res.status(code === 0 ? 200 : 500).json({ ok: code === 0, code, output });
  });
  child.on('error', error => {
    clearTimeout(timeout);
    if (settled) return;
    settled = true;
    res.status(500).json({ error: error.message, output });
  });
});

const dist = path.join(ROOT, 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get('*', (req, res) => res.sendFile(path.join(dist, 'index.html')));
}
app.listen(PORT, '127.0.0.1', () => console.log(`Poshmark Label Manager API: http://127.0.0.1:${PORT}`));
