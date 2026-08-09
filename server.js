// Medicine Ledger — backend
// Uses only Node's built-in modules for the app itself. The one optional
// dependency is `pg`, used only if DATABASE_URL is set — see the cloud
// backup section below for why.

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const webpush = require('web-push');
const { computeAlerts, alertsFingerprint } = require('./alerts.js');

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'data.json');
const VAPID_FILE = path.join(__dirname, 'vapid.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// JWT signing secret. For real deployment, set the JWT_SECRET environment
// variable to something long and random instead of relying on the default.
const JWT_SECRET = process.env.JWT_SECRET || (function () {
  console.warn(
    '\n[medicine-ledger] WARNING: using an auto-generated JWT secret that will\n' +
    'change every time the server restarts, logging everyone out. For real use,\n' +
    'set the JWT_SECRET environment variable to a fixed random string.\n'
  );
  return crypto.randomBytes(32).toString('hex');
})();

const TOKEN_LIFETIME_SECONDS = 60 * 60 * 24 * 30; // 30 days — "stay logged in"

// ---------------------------------------------------------------------
// Cloud backup (optional). Render's free tier has an EPHEMERAL disk —
// data.json and vapid.json can be wiped on redeploy or restart. If
// DATABASE_URL is set, every write is also mirrored to Postgres, and on
// boot we restore the latest copy from there before accepting requests.
// With no DATABASE_URL set, behavior is 100% unchanged (local file only).
// ---------------------------------------------------------------------
let pool = null;
if (process.env.DATABASE_URL) {
  try {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: true } });
  } catch (e) {
    console.error('[medicine-ledger] Could not set up cloud backup, continuing with local file only:', e.message);
  }
}
async function ensureCloudTable() {
  if (!pool) return;
  await pool.query('CREATE TABLE IF NOT EXISTS app_state (id smallint PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz DEFAULT now())');
}
function persistToCloud(db) {
  if (!pool) return Promise.resolve();
  return pool.query(
    'INSERT INTO app_state (id, data, updated_at) VALUES (1, $1, now()) ON CONFLICT (id) DO UPDATE SET data = $1, updated_at = now()',
    [JSON.stringify(db)]
  ).catch(function (e) { console.error('[medicine-ledger] Cloud backup write failed:', e.message); });
}
async function hydrateFromCloud() {
  if (!pool) return;
  try {
    const { rows } = await pool.query('SELECT data FROM app_state WHERE id = 1');
    if (rows.length) {
      var cloudData = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;
      fs.writeFileSync(DB_FILE, JSON.stringify(cloudData, null, 2));
      console.log('[medicine-ledger] Restored data from cloud backup.');
    } else if (fs.existsSync(DB_FILE)) {
      await persistToCloud(JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
      console.log('[medicine-ledger] Seeded cloud backup from local data.json.');
    }
  } catch (e) {
    console.error('[medicine-ledger] Cloud hydration failed, continuing with local file only:', e.message);
  }
}

// ---------------------------------------------------------------------
// Push notifications (Web Push / VAPID). If VAPID_PUBLIC_KEY /
// VAPID_PRIVATE_KEY env vars are set, those are used and never change —
// otherwise keys are generated once and saved to vapid.json, which is
// subject to the same disk-wipe risk described above.
// ---------------------------------------------------------------------
let vapidKeys;
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  vapidKeys = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
} else if (fs.existsSync(VAPID_FILE)) {
  vapidKeys = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
} else {
  vapidKeys = webpush.generateVAPIDKeys();
  fs.writeFileSync(VAPID_FILE, JSON.stringify(vapidKeys, null, 2));
  console.log('[medicine-ledger] Generated new push notification keys (vapid.json).');
}
webpush.setVapidDetails(
  process.env.VAPID_CONTACT_EMAIL ? 'mailto:' + process.env.VAPID_CONTACT_EMAIL : 'mailto:admin@example.com',
  vapidKeys.publicKey,
  vapidKeys.privateKey
);

// ---------------------------------------------------------------------
// Email sending (optional). If RESEND_API_KEY is set, emails are sent via
// Resend (https://resend.com — free tier, no extra npm package needed
// since Node 18+ has fetch built in). Without it, the email content is
// just logged to the console — handy for local testing, and means this
// never crashes a deployment that hasn't set it up yet.
// ---------------------------------------------------------------------
async function sendEmail(toEmail, subject, html) {
  if (!process.env.RESEND_API_KEY) {
    console.log('[medicine-ledger] RESEND_API_KEY not set — would have emailed ' + toEmail + ': "' + subject + '"');
    return;
  }
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.RESEND_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.RESET_EMAIL_FROM || 'Medicine Ledger <onboarding@resend.dev>',
        to: toEmail,
        subject: subject,
        html: html,
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error('[medicine-ledger] Resend API error:', resp.status, errText);
    }
  } catch (e) {
    console.error('[medicine-ledger] Failed to send email:', e.message);
  }
}

// ---------------------------------------------------------------------
// Tiny JSON-file database. Fine for a single hospital's worth of data;
// see README.md for notes on moving to a real database if this ever
// needs to handle serious concurrent write volume.
// ---------------------------------------------------------------------
function readDB() {
  try {
    var db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (!db.pushSubscriptions) db.pushSubscriptions = {}; // userId -> [subscription, ...]
    if (!db.lastNotified) db.lastNotified = {};             // userId -> { fingerprint, at }
    if (!db.lastEmailed) db.lastEmailed = {};                // userId -> { fingerprint, at }
    if (!db.passwordResets) db.passwordResets = [];          // [{ token, userId, expiresAt }, ...]
    return db;
  } catch (e) {
    return { users: [], ledgers: {}, pushSubscriptions: {}, lastNotified: {}, lastEmailed: {}, passwordResets: [] };
  }
}
function writeDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  persistToCloud(db); // fire-and-forget — local write already succeeded, this just mirrors it
}
if (!fs.existsSync(DB_FILE)) writeDB({ users: [], ledgers: {}, pushSubscriptions: {}, lastNotified: {}, lastEmailed: {}, passwordResets: [] });

// ---------------------------------------------------------------------
// Password hashing (scrypt — built into Node's crypto module, no bcrypt
// package needed) and a minimal hand-rolled HS256 JWT implementation.
// ---------------------------------------------------------------------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return salt + ':' + hash;
}
function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(check, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(input) {
  input = input.replace(/-/g, '+').replace(/_/g, '/');
  while (input.length % 4) input += '=';
  return Buffer.from(input, 'base64').toString('utf8');
}
function signToken(payload) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body = Object.assign({}, payload, { iat: now, exp: now + TOKEN_LIFETIME_SECONDS });
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(body));
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(h + '.' + p).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return h + '.' + p + '.' + sig;
}
function verifyToken(token) {
  try {
    const [h, p, sig] = String(token).split('.');
    if (!h || !p || !sig) return null;
    const expected = crypto.createHmac('sha256', JWT_SECRET).update(h + '.' + p).digest('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const a = Buffer.from(sig), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(b64urlDecode(p));
    if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------
function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  });
  res.end(body);
}
function readJSONBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 5 * 1024 * 1024) { req.destroy(); reject(new Error('Body too large')); }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}
function getAuthUser(req, db) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  const payload = verifyToken(token);
  if (!payload || !payload.uid) return null;
  return db.users.find((u) => u.id === payload.uid) || null;
}
function publicUser(u) {
  return { id: u.id, hospitalName: u.hospitalName, username: u.username, email: u.email, emailAlertsEnabled: u.emailAlertsEnabled !== false };
}
function findByIdentifier(db, identifier) {
  const id = String(identifier || '').trim().toLowerCase();
  return db.users.find((u) => u.username.toLowerCase() === id || u.email.toLowerCase() === id);
}

// ---------------------------------------------------------------------
// Sends a push notification to every device a user has subscribed on.
// Mutates db.pushSubscriptions in place to drop dead subscriptions
// (HTTP 410 = the browser/OS says this device unsubscribed) — caller is
// responsible for calling writeDB(db) afterwards to persist that.
// ---------------------------------------------------------------------
async function sendToUser(db, userId, notification) {
  const subs = db.pushSubscriptions[userId] || [];
  let sent = 0, failed = 0;
  const stillValid = [];
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, JSON.stringify(notification));
      sent++;
      stillValid.push(sub);
    } catch (err) {
      failed++;
      if (err.statusCode !== 410 && err.statusCode !== 404) {
        stillValid.push(sub); // keep it — could be a transient failure, not a dead subscription
      }
      console.warn('[push] failed for', userId, '-', err.statusCode || err.message);
    }
  }
  db.pushSubscriptions[userId] = stillValid;
  return { sent, failed };
}

// ---------------------------------------------------------------------
// Periodically checks every hospital's stock/expiry and sends a push
// when there's something new to flag — at most once per CHECK_COOLDOWN
// per hospital, so it doesn't repeat the same notification every cycle.
// ---------------------------------------------------------------------
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;   // check every 6 hours
const CHECK_COOLDOWN_MS = 20 * 60 * 60 * 1000;  // don't repeat the same alert set within 20 hours

function buildAlertEmailHtml(user, alerts) {
  function rows(items, cols) {
    return items.map(function (it) {
      return '<tr>' + cols.map(function (c) { return '<td style="padding:6px 10px;border-bottom:1px solid #eee;">' + c(it) + '</td>'; }).join('') + '</tr>';
    }).join('');
  }
  var sections = [];
  if (alerts.lowStock.length) {
    sections.push(
      '<h3 style="margin:20px 0 8px;font-family:sans-serif;color:#0F172A;">Low / out of stock (' + alerts.lowStock.length + ')</h3>' +
      '<table style="width:100%;border-collapse:collapse;font-family:sans-serif;font-size:14px;color:#0F172A;">' +
      rows(alerts.lowStock, [
        function (a) { return a.name; },
        function (a) { return a.remaining + ' ' + (a.unit || ''); },
        function (a) { return a.status === 'empty' ? '<span style="color:#D6362E;font-weight:600;">Empty</span>' : '<span style="color:#B45309;font-weight:600;">Low</span>'; },
      ]) +
      '</table>'
    );
  }
  if (alerts.expiring.length) {
    sections.push(
      '<h3 style="margin:20px 0 8px;font-family:sans-serif;color:#0F172A;">Expiring within 30 days (' + alerts.expiring.length + ')</h3>' +
      '<table style="width:100%;border-collapse:collapse;font-family:sans-serif;font-size:14px;color:#0F172A;">' +
      rows(alerts.expiring, [
        function (a) { return a.name; },
        function (a) { return a.remaining + ' ' + (a.unit || ''); },
        function (a) { return a.days < 0 ? '<span style="color:#D6362E;font-weight:600;">Expired ' + Math.abs(a.days) + 'd ago</span>' : '<span style="color:#B45309;font-weight:600;">' + a.days + 'd left</span>'; },
      ]) +
      '</table>'
    );
  }
  return (
    '<div style="font-family:sans-serif;">' +
    '<p style="color:#0F172A;">Here\'s the current alert summary for <b>' + user.hospitalName + '</b>.</p>' +
    sections.join('') +
    '<p style="margin-top:24px;font-size:12px;color:#94A3B8;">You\'re receiving this because email alerts are enabled on your Medicine Ledger account. You can turn them off from the app\'s settings.</p>' +
    '</div>'
  );
}

async function runAlertCheck() {
  const db = readDB();
  let changed = false;
  for (const user of db.users) {
    const ledger = db.ledgers[user.id] || { medicines: [], logs: {} };
    const alerts = computeAlerts(ledger.medicines, ledger.logs);
    if (alerts.lowStock.length === 0 && alerts.expiring.length === 0) continue;

    const fingerprint = alertsFingerprint(alerts);
    const parts = [];
    if (alerts.lowStock.length) parts.push(alerts.lowStock.length + ' medicine' + (alerts.lowStock.length > 1 ? 's' : '') + ' low/out of stock');
    if (alerts.expiring.length) parts.push(alerts.expiring.length + ' expiring within 30 days');

    // Push notification — only reaches devices that subscribed
    const subs = db.pushSubscriptions[user.id] || [];
    if (subs.length > 0) {
      const last = db.lastNotified[user.id];
      const cooledDown = !last || (Date.now() - last.at) > CHECK_COOLDOWN_MS;
      if (!last || last.fingerprint !== fingerprint || cooledDown) {
        const result = await sendToUser(db, user.id, {
          title: 'Medicine Ledger — ' + user.hospitalName,
          body: parts.join(' · '),
          tag: 'stock-alert',
        });
        db.lastNotified[user.id] = { fingerprint: fingerprint, at: Date.now() };
        changed = true;
        console.log('[push] alert sent to', user.username, '-', result.sent, 'device(s)');
      }
    }

    // Email digest — independent channel, reaches anyone with an email on
    // file regardless of whether they've ever opened the app on this device.
    if (user.emailAlertsEnabled !== false && user.email) {
      const lastEmail = db.lastEmailed[user.id];
      const emailCooledDown = !lastEmail || (Date.now() - lastEmail.at) > CHECK_COOLDOWN_MS;
      if (!lastEmail || lastEmail.fingerprint !== fingerprint || emailCooledDown) {
        await sendEmail(user.email, 'Medicine Ledger alerts — ' + user.hospitalName, buildAlertEmailHtml(user, alerts));
        db.lastEmailed[user.id] = { fingerprint: fingerprint, at: Date.now() };
        changed = true;
        console.log('[email] alert digest sent to', user.username);
      }
    }
  }
  if (changed) writeDB(db);
}

// ---------------------------------------------------------------------
// Static file serving for the frontend (single-page app in /public)
// ---------------------------------------------------------------------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/manifest+json' };
function serveStatic(req, res) {
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.join(PUBLIC_DIR, path.normalize(filePath).replace(/^(\.\.[\/\\])+/, ''));
  fs.readFile(filePath, (err, content) => {
    if (err) {
      // SPA fallback — unknown paths get index.html too
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, indexContent) => {
        if (err2) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(indexContent);
      });
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

// ---------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    });
    return res.end();
  }

  const url = req.url.split('?')[0];

  if (!url.startsWith('/api/')) return serveStatic(req, res);

  try {
    const db = readDB();

    if (url === '/api/signup' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const hospitalName = String(body.hospitalName || '').trim();
      const username = String(body.username || '').trim();
      const email = String(body.email || '').trim();
      const password = String(body.password || '');

      if (!hospitalName || !username || !email || !password) {
        return sendJSON(res, 400, { error: 'Hospital name, username, email, and password are all required.' });
      }
      if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) {
        return sendJSON(res, 400, { error: 'Username should be 3-32 characters: letters, numbers, dots, dashes, underscores.' });
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return sendJSON(res, 400, { error: 'Please enter a valid email address.' });
      }
      if (password.length < 6) {
        return sendJSON(res, 400, { error: 'Password should be at least 6 characters.' });
      }
      if (findByIdentifier(db, username) || findByIdentifier(db, email)) {
        return sendJSON(res, 409, { error: 'That username or email is already taken.' });
      }

      const id = crypto.randomUUID();
      const user = {
        id, hospitalName, username, email,
        passwordHash: hashPassword(password),
        createdAt: new Date().toISOString(),
      };
      db.users.push(user);
      db.ledgers[id] = { medicines: [], logs: {}, updatedAt: new Date().toISOString() };
      writeDB(db);

      return sendJSON(res, 200, { token: signToken({ uid: id }), user: publicUser(user) });
    }

    if (url === '/api/login' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const identifier = body.identifier;
      const password = String(body.password || '');
      const user = findByIdentifier(db, identifier);
      if (!user || !verifyPassword(password, user.passwordHash)) {
        return sendJSON(res, 401, { error: 'Incorrect username/email or password.' });
      }
      return sendJSON(res, 200, { token: signToken({ uid: user.id }), user: publicUser(user) });
    }

    if (url === '/api/forgot-password' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const user = findByIdentifier(db, body.identifier);
      // Always respond the same way whether or not the account exists —
      // otherwise this endpoint could be used to check who has an account.
      const genericMsg = { ok: true, message: 'If an account matches, a reset link has been sent to its email address.' };
      if (user) {
        // Clear out any old tokens for this user, then issue a fresh one.
        db.passwordResets = db.passwordResets.filter((r) => r.userId !== user.id);
        const token = crypto.randomBytes(32).toString('hex');
        const expiresAt = Date.now() + 30 * 60 * 1000; // 30 minutes
        db.passwordResets.push({ token, userId: user.id, expiresAt });
        writeDB(db);
        const frontendUrl = (process.env.FRONTEND_URL || '').replace(/\/$/, '');
        const resetUrl = (frontendUrl || 'https://your-app.vercel.app') + '/?reset=' + token;
        var resetHtml =
          '<p>Someone requested a password reset for your Medicine Ledger account.</p>' +
          '<p><a href="' + resetUrl + '">Click here to set a new password</a> (link expires in 30 minutes).</p>' +
          '<p>If you didn\'t request this, you can safely ignore this email.</p>';
        sendEmail(user.email, 'Reset your Medicine Ledger password', resetHtml); // fire-and-forget, response doesn't wait on it
      }
      return sendJSON(res, 200, genericMsg);
    }

    if (url === '/api/reset-password' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const token = String(body.token || '');
      const newPassword = String(body.newPassword || '');
      if (newPassword.length < 6) {
        return sendJSON(res, 400, { error: 'Password should be at least 6 characters.' });
      }
      const entry = db.passwordResets.find((r) => r.token === token);
      if (!entry || entry.expiresAt < Date.now()) {
        return sendJSON(res, 400, { error: 'This reset link is invalid or has expired. Request a new one.' });
      }
      const user = db.users.find((u) => u.id === entry.userId);
      if (!user) return sendJSON(res, 400, { error: 'This reset link is invalid or has expired. Request a new one.' });
      user.passwordHash = hashPassword(newPassword);
      db.passwordResets = db.passwordResets.filter((r) => r.userId !== user.id); // single-use
      writeDB(db);
      return sendJSON(res, 200, { ok: true, token: signToken({ uid: user.id }), user: publicUser(user) });
    }

    if (url === '/api/me' && req.method === 'GET') {
      const user = getAuthUser(req, db);
      if (!user) return sendJSON(res, 401, { error: 'Not logged in.' });
      return sendJSON(res, 200, { user: publicUser(user) });
    }

    if (url === '/api/settings/email-alerts' && req.method === 'POST') {
      const user = getAuthUser(req, db);
      if (!user) return sendJSON(res, 401, { error: 'Not logged in.' });
      const body = await readJSONBody(req);
      user.emailAlertsEnabled = body.enabled !== false;
      writeDB(db);
      return sendJSON(res, 200, { user: publicUser(user) });
    }

    if (url === '/api/ledger' && req.method === 'GET') {
      const user = getAuthUser(req, db);
      if (!user) return sendJSON(res, 401, { error: 'Not logged in.' });
      const ledger = db.ledgers[user.id] || { medicines: [], logs: {} };
      return sendJSON(res, 200, ledger);
    }

    if (url === '/api/ledger' && req.method === 'PUT') {
      const user = getAuthUser(req, db);
      if (!user) return sendJSON(res, 401, { error: 'Not logged in.' });
      const body = await readJSONBody(req);
      if (!Array.isArray(body.medicines) || typeof body.logs !== 'object') {
        return sendJSON(res, 400, { error: 'Malformed ledger payload.' });
      }
      db.ledgers[user.id] = { medicines: body.medicines, logs: body.logs, updatedAt: new Date().toISOString() };
      writeDB(db);
      return sendJSON(res, 200, { ok: true, updatedAt: db.ledgers[user.id].updatedAt });
    }

    if (url === '/api/push/vapid-public-key' && req.method === 'GET') {
      return sendJSON(res, 200, { publicKey: vapidKeys.publicKey });
    }

    if (url === '/api/push/subscribe' && req.method === 'POST') {
      const user = getAuthUser(req, db);
      if (!user) return sendJSON(res, 401, { error: 'Not logged in.' });
      const body = await readJSONBody(req);
      if (!body.subscription || !body.subscription.endpoint) {
        return sendJSON(res, 400, { error: 'Missing push subscription.' });
      }
      if (!db.pushSubscriptions[user.id]) db.pushSubscriptions[user.id] = [];
      const already = db.pushSubscriptions[user.id].some((s) => s.endpoint === body.subscription.endpoint);
      if (!already) db.pushSubscriptions[user.id].push(body.subscription);
      writeDB(db);
      return sendJSON(res, 200, { ok: true, deviceCount: db.pushSubscriptions[user.id].length });
    }

    if (url === '/api/push/unsubscribe' && req.method === 'POST') {
      const user = getAuthUser(req, db);
      if (!user) return sendJSON(res, 401, { error: 'Not logged in.' });
      const body = await readJSONBody(req);
      if (db.pushSubscriptions[user.id]) {
        db.pushSubscriptions[user.id] = db.pushSubscriptions[user.id].filter((s) => s.endpoint !== body.endpoint);
      }
      writeDB(db);
      return sendJSON(res, 200, { ok: true });
    }

    if (url === '/api/push/status' && req.method === 'GET') {
      const user = getAuthUser(req, db);
      if (!user) return sendJSON(res, 401, { error: 'Not logged in.' });
      const subs = db.pushSubscriptions[user.id] || [];
      return sendJSON(res, 200, { deviceCount: subs.length });
    }

    if (url === '/api/push/test' && req.method === 'POST') {
      const user = getAuthUser(req, db);
      if (!user) return sendJSON(res, 401, { error: 'Not logged in.' });
      const subs = db.pushSubscriptions[user.id] || [];
      if (subs.length === 0) {
        return sendJSON(res, 400, { error: 'No devices subscribed yet — enable notifications first.' });
      }
      const result = await sendToUser(db, user.id, {
        title: 'Medicine Ledger',
        body: 'Test notification — if you can see this, alerts are working.',
        tag: 'test',
      });
      writeDB(db);
      return sendJSON(res, 200, { ok: true, sent: result.sent, failed: result.failed });
    }

    return sendJSON(res, 404, { error: 'Not found.' });
  } catch (err) {
    console.error(err);
    return sendJSON(res, 500, { error: 'Server error: ' + err.message });
  }
});

(async function boot() {
  await ensureCloudTable();
  await hydrateFromCloud();
  server.listen(PORT, () => {
    console.log(`Medicine Ledger running at http://localhost:${PORT}`);
    // First check shortly after boot, then on a regular interval.
    setTimeout(runAlertCheck, 30 * 1000);
    setInterval(runAlertCheck, CHECK_INTERVAL_MS);
  });
})();
