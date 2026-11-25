const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {assertExposure, clientIp, cookieIsSecure} = require('./exposure.cjs');
const {createLoginGuard, LOCK_MESSAGE} = require('./login-guard.cjs');
const {start} = require('./app.cjs');

test('public address requires https proxy and refuses demo data and example passwords', () => {
  assert.equal(assertExposure({host: '127.0.0.1', port: 0, cookieSecure: false, trustProxy: false}).publicBind, false);
  assert.throws(() => assertExposure({host: '0.0.0.0', port: 3212, seedDemo: true, cookieSecure: true, trustProxy: true}), /SEED_DEMO/);
  assert.throws(() => assertExposure({host: '0.0.0.0', port: 3212, cookieSecure: false, trustProxy: true}), /COOKIE_SECURE/);
  assert.throws(() => assertExposure({host: '0.0.0.0', port: 3212, cookieSecure: true, trustProxy: false}), /TRUST_PROXY/);
  assert.throws(() => assertExposure({host: '0.0.0.0', port: 3212, cookieSecure: true, trustProxy: true, adminPassword: 'change-me-now'}), /ADMIN_PASSWORD/);
  assert.equal(assertExposure({host: '0.0.0.0', port: 3212, cookieSecure: true, trustProxy: true, adminPassword: 'own-secret-1'}).publicBind, true);
});

test('proxy headers are trusted only when asked', () => {
  const req = {socket: {remoteAddress: '10.0.0.8'}, headers: {'x-forwarded-for': '203.0.113.9, 10.0.0.8', 'x-forwarded-proto': 'https'}};
  assert.equal(clientIp(req, {trustProxy: false}), '10.0.0.8');
  assert.equal(clientIp(req, {trustProxy: true}), '203.0.113.9');
  assert.equal(cookieIsSecure(req, {cookieSecure: false, trustProxy: false}), false);
  assert.equal(cookieIsSecure(req, {cookieSecure: false, trustProxy: true}), true);
  assert.equal(cookieIsSecure({headers: {}, socket: {}}, {cookieSecure: true, trustProxy: false}), true);
});

test('login lockout counts wrong passwords and then lets the right one through after the window', () => {
  let now = 1_000;
  const guard = createLoginGuard({now: () => now, accountLimit: 2, windowMs: 1000});
  assert.equal(guard.status('1.1.1.1', 'ivan').locked, false);
  guard.fail('1.1.1.1', 'ivan');
  guard.fail('1.1.1.1', 'ivan');
  assert.equal(guard.status('1.1.1.1', 'ivan').locked, true);
  assert.equal(guard.status('1.1.1.1', 'other').locked, false);
  guard.success('ivan');
  assert.equal(guard.status('1.1.1.1', 'ivan').locked, false);
  guard.fail('1.1.1.1', 'ivan');
  guard.fail('1.1.1.1', 'ivan');
  now += 1001;
  assert.equal(guard.status('1.1.1.1', 'ivan').locked, false);
  assert.match(LOCK_MESSAGE, /15 минут/);
});

function request(port, method, pathname, {body, headers} = {}) {
  const http = require('node:http');
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({hostname: '127.0.0.1', port, path: pathname, method, headers: {'Content-Type': 'application/json', 'X-Requested-With': 'ActivProfi', ...(data ? {'Content-Length': data.length} : {}), ...headers}}, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json; try { json = JSON.parse(text); } catch { json = {}; }
        resolve({status: res.statusCode, headers: res.headers, json});
      });
    });
    req.on('error', reject);
    req.end(data || undefined);
  });
}

test('secure cookie follows https behind the proxy and a locked login stays locked', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-expose-'));
  const app = await start({host: '127.0.0.1', port: 0, databasePath: path.join(dir, 'crm.sqlite'), seedDemo: false, adminLogin: 'admin', adminPassword: 'admin-pass-1', adminName: 'Ксения', sessionDays: 2, cookieSecure: false, trustProxy: true, telegramPoll: false, sipuniSync: false});
  try {
    const plain = await request(app.port, 'POST', '/api/auth/login', {body: {login: 'admin', password: 'admin-pass-1'}});
    assert.equal(plain.status, 200);
    assert.equal(String(plain.headers['set-cookie']).includes('Secure'), false);
    const secure = await request(app.port, 'POST', '/api/auth/login', {body: {login: 'admin', password: 'admin-pass-1'}, headers: {'X-Forwarded-Proto': 'https'}});
    assert.match(String(secure.headers['set-cookie']), /Secure/);
    for (let i = 0; i < 8; i += 1) {
      const failed = await request(app.port, 'POST', '/api/auth/login', {body: {login: 'nobody-lock', password: 'wrong-pass-1'}});
      assert.equal(failed.status, 401);
    }
    const locked = await request(app.port, 'POST', '/api/auth/login', {body: {login: 'nobody-lock', password: 'admin-pass-1'}});
    assert.equal(locked.status, 429);
    assert.equal(locked.json.error, LOCK_MESSAGE);
    const admin = await request(app.port, 'POST', '/api/auth/login', {body: {login: 'admin', password: 'admin-pass-1'}});
    assert.equal(admin.status, 200);
  } finally {
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
