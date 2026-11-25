const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {start} = require('./app.cjs');

function request(port, method, pathname, {body, cookie, headers} = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({hostname: '127.0.0.1', port, path: pathname, method, headers: {'Content-Type': 'application/json', 'X-Requested-With': 'ActivProfi', ...(cookie ? {Cookie: cookie} : {}), ...(data ? {'Content-Length': data.length} : {}), ...headers}}, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json; try { json = JSON.parse(text); } catch { json = {}; }
        resolve({status: res.statusCode, json, cookie: res.headers['set-cookie']});
      });
    });
    req.on('error', reject);
    req.end(data || undefined);
  });
}

async function login(port, loginName, password) {
  const response = await request(port, 'POST', '/api/auth/login', {body: {login: loginName, password}});
  assert.equal(response.status, 200, JSON.stringify(response.json));
  return response.cookie[0].split(';')[0];
}

test('new sales manager changes the temporary password and sees only assigned leads', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-novice-'));
  const app = await start({host: '127.0.0.1', port: 0, databasePath: path.join(dir, 'crm.sqlite'), seedDemo: false, adminLogin: 'admin', adminPassword: 'admin-pass-1', adminName: 'Ксения', sessionDays: 2, cookieSecure: false, telegramPoll: false, sipuniSync: false});
  try {
    const admin = await login(app.port, 'admin', 'admin-pass-1');
    const created = await request(app.port, 'POST', '/api/users', {cookie: admin, body: {name: 'Иван', login: 'ivan', password: 'temp-pass-1', role: 'sales'}});
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const ivanUser = created.json.state.users.find(item => item.login === 'ivan');
    assert.equal(ivanUser.probation, true);
    assert.equal(ivanUser.mustChangePassword, true);
    const developer = await request(app.port, 'POST', '/api/users', {cookie: admin, body: {name: 'Пётр', login: 'petr', password: 'temp-pass-2', role: 'developer'}});
    assert.equal(developer.json.state.users.find(item => item.login === 'petr').probation, false);

    const first = await request(app.port, 'POST', '/api/auth/login', {body: {login: 'ivan', password: 'temp-pass-1'}});
    assert.equal(first.json.user.mustChangePassword, true);
    const ivan = first.cookie[0].split(';')[0];
    const wrong = await request(app.port, 'POST', '/api/auth/password', {cookie: ivan, body: {currentPassword: 'nope-pass', password: 'own-pass-1'}});
    assert.equal(wrong.status, 400);
    const changed = await request(app.port, 'POST', '/api/auth/password', {cookie: ivan, body: {currentPassword: 'temp-pass-1', password: 'own-pass-1'}});
    assert.equal(changed.status, 200, JSON.stringify(changed.json));
    assert.equal(changed.json.user.mustChangePassword, false);
    const oldPassword = await request(app.port, 'POST', '/api/auth/login', {body: {login: 'ivan', password: 'temp-pass-1'}});
    assert.equal(oldPassword.status, 401);
    const fresh = await login(app.port, 'ivan', 'own-pass-1');

    const home = await request(app.port, 'GET', '/api/workspace', {cookie: admin});
    const stage = home.json.state.pipelines[0].stages[0].id;
    const pipe = home.json.state.pipelines[0].id;
    const own = await request(app.port, 'POST', '/api/clients', {cookie: admin, body: {name: 'Свой клиент', phone: '+79991110001', email: 'own@example.test', ownerId: ivanUser.id, pipelineId: pipe, stageId: stage, amount: 1000}});
    assert.equal(own.status, 201, JSON.stringify(own.json));
    const foreign = await request(app.port, 'POST', '/api/clients', {cookie: admin, body: {name: 'Чужой клиент', phone: '+79991110002', email: 'foreign@example.test', ownerId: 'admin', pipelineId: pipe, stageId: stage, amount: 2000}});
    assert.equal(foreign.status, 201, JSON.stringify(foreign.json));
    const seen = await request(app.port, 'GET', '/api/workspace', {cookie: fresh});
    assert.deepEqual(seen.json.state.clients.map(item => item.name), ['Свой клиент']);
    const hidden = await request(app.port, 'GET', '/api/clients/' + encodeURIComponent(foreign.json.id), {cookie: fresh});
    assert.equal(hidden.status, 404);
    const guide = await request(app.port, 'GET', '/guide.js');
    assert.equal(guide.status, 200);

    const batch = await request(app.port, 'POST', '/api/lead-batches/import', {cookie: admin, body: {headers: ['Имя', 'Телефон'], rows: [['База Иван', '+79991110003'], ['База чужая', '+79991110004']], map: ['name', 'phone'], opts: {name: 'Файл новичка', pipelineId: pipe, destination: 'base', kind: 'cold', file: 'novice.csv', fileDate: '2026-11-25'}}});
    assert.equal(batch.status, 201, JSON.stringify(batch.json));
    const draft = structuredClone(batch.json.state);
    draft.clients.find(item => item.name === 'База Иван').ownerId = ivanUser.id;
    const sourceFile = draft.leadBatches.find(item => item.name === 'Файл новичка');
    sourceFile.funnelTotal = 2;
    sourceFile.skipped = 4;
    sourceFile.lastDistribution = {count: 2};
    draft.users.find(item => item.id === ivanUser.id).permissionOverrides = {'clients.all': true, 'leads.manage': true};
    const widened = await request(app.port, 'PUT', '/api/workspace', {cookie: admin, body: {revision: batch.json.revision, state: draft}});
    assert.equal(widened.status, 200, JSON.stringify(widened.json));
    const limited = await request(app.port, 'GET', '/api/workspace', {cookie: fresh});
    assert.deepEqual(limited.json.state.clients.map(item => item.name).sort(), ['База Иван', 'Свой клиент']);
    const file = limited.json.state.leadBatches.find(item => item.name === 'Файл новичка');
    assert.equal(file.funnelTotal, undefined);
    assert.equal(file.skipped, undefined);
    assert.equal(file.lastDistribution, undefined);
    assert.equal(widened.json.state.leadBatches.find(item => item.name === 'Файл новичка').funnelTotal, 2);
    const imported = await request(app.port, 'POST', '/api/lead-batches/import', {cookie: fresh, body: {headers: ['Имя', 'Телефон'], rows: [['Нельзя', '+79991110005']], map: ['name', 'phone'], opts: {name: 'Чужая загрузка', pipelineId: pipe, destination: 'base', kind: 'cold', file: 'no.csv', fileDate: '2026-11-25'}}});
    assert.equal(imported.status, 403);
    const removed = await request(app.port, 'POST', '/api/lead-batches/' + encodeURIComponent(file.id) + '/archive', {cookie: fresh, body: {}});
    assert.equal(removed.status, 403);
    const dump = await request(app.port, 'GET', '/api/migration/export', {cookie: fresh});
    assert.equal(dump.status, 403);

    const liftedState = await request(app.port, 'GET', '/api/workspace', {cookie: admin});
    const next = structuredClone(liftedState.json.state);
    const person = next.users.find(item => item.id === ivanUser.id);
    person.probation = false;
    person.permissionOverrides = {'clients.all': true};
    const lifted = await request(app.port, 'PUT', '/api/workspace', {cookie: admin, body: {revision: liftedState.json.revision, state: next}});
    assert.equal(lifted.status, 200, JSON.stringify(lifted.json));
    const after = await request(app.port, 'GET', '/api/workspace', {cookie: fresh});
    assert.equal(after.json.state.users.find(item => item.id === ivanUser.id).probation, false);
    assert.ok(after.json.state.clients.some(item => item.name === 'Чужой клиент'));
    assert.ok(after.json.state.clients.some(item => item.name === 'База чужая'));
  } finally {
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
