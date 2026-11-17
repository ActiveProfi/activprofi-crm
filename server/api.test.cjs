const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {start} = require('./app.cjs');

async function listen() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-'));
  const app = await start({
    host: '127.0.0.1',
    port: 0,
    databasePath: path.join(dir, 'crm.sqlite'),
    seedDemo: true,
    seedPassword: 'demo-pass-1',
    adminLogin: 'admin',
    adminPassword: 'admin-pass-1',
    adminName: 'Ксения',
    sessionDays: 2,
    cookieSecure: false,
  });
  return {app, dir};
}

function request(port, method, pathname, {body, cookie, headers, raw} = {}) {
  return new Promise((resolve, reject) => {
    const data = raw || (body === undefined ? null : Buffer.from(JSON.stringify(body)));
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname, method,
      headers: {
        ...(data ? {'Content-Type': 'application/json', 'Content-Length': data.length} : {}),
        ...(cookie ? {Cookie: cookie} : {}),
        ...headers,
      },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json;
        try { json = JSON.parse(buf.toString('utf8')); } catch { json = undefined; }
        resolve({status: res.statusCode, headers: res.headers, json, buf});
      });
    });
    req.on('error', reject);
    req.end(data || undefined);
  });
}

function cookieOf(response) {
  const raw = response.headers['set-cookie']?.[0] || '';
  return raw.split(';')[0];
}

async function login(port, loginName, password) {
  const response = await request(port, 'POST', '/api/auth/login', {
    body: {login: loginName, password},
    headers: {'X-Requested-With': 'ActivProfi'},
  });
  assert.equal(response.status, 200, JSON.stringify(response.json));
  return cookieOf(response);
}

test('login, workspace scope and logout', async () => {
  const {app, dir} = await listen();
  try {
    const anon = await request(app.port, 'GET', '/api/workspace');
    assert.equal(anon.status, 401);
    const bad = await request(app.port, 'POST', '/api/auth/login', {body: {login: 'admin', password: 'wrong-pass'}, headers: {'X-Requested-With': 'ActivProfi'}});
    assert.equal(bad.status, 401);
    const admin = await login(app.port, 'admin', 'admin-pass-1');
    const mine = await request(app.port, 'GET', '/api/auth/me', {cookie: admin});
    assert.equal(mine.json.user.login, 'admin');
    assert.equal(mine.json.user.password, undefined);
    const ws = await request(app.port, 'GET', '/api/workspace', {cookie: admin});
    assert.equal(ws.status, 200);
    assert.equal(ws.json.state.clients.length, 5);
    assert.ok(ws.json.state.projects[0].budget > 0);
    const elena = await login(app.port, 'elena', 'demo-pass-1');
    const sales = await request(app.port, 'GET', '/api/clients', {cookie: elena});
    assert.equal(sales.status, 200);
    assert.ok(sales.json.clients.length > 0);
    assert.ok(sales.json.clients.every(client => client.ownerId === 'sales'));
    const hidden = ws.json.state.clients.find(client => client.ownerId === 'sales2');
    const denied = await request(app.port, 'GET', '/api/clients/' + hidden.id, {cookie: elena});
    assert.equal(denied.status, 404);
    const anna = await login(app.port, 'anna', 'demo-pass-1');
    const devClients = await request(app.port, 'GET', '/api/clients', {cookie: anna});
    assert.equal(devClients.json.clients.length, 0);
    const devProjects = await request(app.port, 'GET', '/api/projects', {cookie: anna});
    assert.ok(devProjects.json.projects.every(project => project.budget === undefined));
    const out = await request(app.port, 'POST', '/api/auth/logout', {cookie: elena, headers: {'X-Requested-With': 'ActivProfi'}});
    assert.equal(out.status, 200);
    const again = await request(app.port, 'GET', '/api/auth/me', {cookie: elena});
    assert.equal(again.status, 401);
  } finally {
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('manager cannot edit foreign data; own client and task rights hold', async () => {
  const {app, dir} = await listen();
  try {
    const elena = await login(app.port, 'elena', 'demo-pass-1');
    const admin = await login(app.port, 'admin', 'admin-pass-1');
    const full = await request(app.port, 'GET', '/api/workspace', {cookie: admin});
    const foreign = full.json.state.clients.find(client => client.ownerId === 'sales2');
    const tamper = await request(app.port, 'PUT', '/api/workspace', {
      cookie: elena,
      headers: {'X-Requested-With': 'ActivProfi'},
      body: {revision: full.json.revision, state: {...(await request(app.port, 'GET', '/api/workspace', {cookie: elena})).json.state, clients: [...(await request(app.port, 'GET', '/api/clients', {cookie: elena})).json.clients, {...foreign, notes: ['чужая правка']}] }},
    });
    assert.equal(tamper.status, 403);

    const own = await request(app.port, 'GET', '/api/workspace', {cookie: elena});
    const client = own.json.state.clients[0];
    const patched = await request(app.port, 'PATCH', '/api/clients/' + client.id, {
      cookie: elena,
      headers: {'X-Requested-With': 'ActivProfi'},
      body: {notes: ['Созвон согласован', ...client.notes]},
    });
    assert.equal(patched.status, 200, JSON.stringify(patched.json));
    const seen = await request(app.port, 'GET', '/api/clients/' + client.id, {cookie: admin});
    assert.equal(seen.json.client.notes[0], 'Созвон согласован');

    const dup = await request(app.port, 'POST', '/api/clients', {
      cookie: elena,
      headers: {'X-Requested-With': 'ActivProfi'},
      body: {name: 'Дубль', phone: client.phone, email: 'other@example.test', source: 'Тест', pipelineId: client.pipelineId, stageId: client.stageId},
    });
    assert.equal(dup.status, 409);

    const created = await request(app.port, 'POST', '/api/clients', {
      cookie: elena,
      headers: {'X-Requested-With': 'ActivProfi'},
      body: {name: 'Новый контакт Елены', phone: '+7 999 111-22-33', email: 'elena-new@example.test', source: 'Вручную', ownerId: 'sales2', pipelineId: client.pipelineId, stageId: client.stageId},
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const createdClient = created.json.state.clients.find(item => item.name === 'Новый контакт Елены');
    assert.equal(createdClient.ownerId, 'sales');

    const tasks = await request(app.port, 'GET', '/api/tasks', {cookie: elena});
    const task = tasks.json.tasks.find(item => item.assigneeId === 'sales');
    const assign = await request(app.port, 'PATCH', '/api/tasks/' + task.id, {
      cookie: elena,
      headers: {'X-Requested-With': 'ActivProfi'},
      body: {assigneeId: 'anna'},
    });
    assert.equal(assign.status, 403);
    const anna = await login(app.port, 'anna', 'demo-pass-1');
    const annaTasks = await request(app.port, 'GET', '/api/tasks', {cookie: anna});
    const ownTask = annaTasks.json.tasks.find(item => item.status !== 'Готово');
    const status = await request(app.port, 'PATCH', '/api/tasks/' + ownTask.id, {
      cookie: anna,
      headers: {'X-Requested-With': 'ActivProfi'},
      body: {status: 'В работе', remaining: 4},
    });
    assert.equal(status.status, 200, JSON.stringify(status.json));
    const title = await request(app.port, 'PATCH', '/api/tasks/' + ownTask.id, {
      cookie: anna,
      headers: {'X-Requested-With': 'ActivProfi'},
      body: {title: 'Нельзя менять название'},
    });
    assert.equal(title.status, 403);
  } finally {
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('import deduplicates on the server and integration key accepts Istok leads', async () => {
  const {app, dir} = await listen();
  try {
    const elena = await login(app.port, 'elena', 'demo-pass-1');
    const denied = await request(app.port, 'POST', '/api/lead-batches/import', {
      cookie: elena,
      headers: {'X-Requested-With': 'ActivProfi'},
      body: {headers: ['Имя', 'Телефон'], rows: [['А', '+79990001122']], map: ['name', 'phone'], opts: {name: 'База', pipelineId: 'outbound', destination: 'base', kind: 'cold'}},
    });
    assert.equal(denied.status, 403);

    const irina = await login(app.port, 'irina', 'demo-pass-1');
    const headers = ['Имя', 'Телефон', 'Email', 'Комментарий'];
    const rows = [
      ['Сергей Тестов', '+7 999 222-33-44', 'sergey@example.test', 'Перезвонить завтра'],
      ['Повтор', '8 999 222-33-44', 'other@example.test', ''],
      ['Мария Тестова', '', 'maria.lead@example.test', 'Ждут КП'],
    ];
    const opts = {name: 'Проверка импорта', pipelineId: 'outbound', destination: 'base', kind: 'cold', source: 'Тест', file: 'test.csv', fileDate: '2026-11-01'};
    const imported = await request(app.port, 'POST', '/api/lead-batches/import', {
      cookie: irina,
      headers: {'X-Requested-With': 'ActivProfi'},
      body: {headers, rows, map: ['name', 'phone', 'email', 'notes'], opts},
    });
    assert.equal(imported.status, 201, JSON.stringify(imported.json));
    assert.equal(imported.json.batch.skipped, 1);
    const again = await request(app.port, 'POST', '/api/lead-batches/import', {
      cookie: irina,
      headers: {'X-Requested-With': 'ActivProfi'},
      body: {headers, rows: [['Сергей ещё раз', '+79992223344', 'third@example.test', '']], map: ['name', 'phone', 'email', 'notes'], opts: {...opts, name: 'Повторная база'}},
    });
    assert.equal(again.status, 400);

    const admin = await login(app.port, 'admin', 'admin-pass-1');
    const forbiddenKey = await request(app.port, 'POST', '/api/integration-keys', {cookie: elena, headers: {'X-Requested-With': 'ActivProfi'}, body: {name: 'Исток'}});
    assert.equal(forbiddenKey.status, 403);
    const key = await request(app.port, 'POST', '/api/integration-keys', {cookie: admin, headers: {'X-Requested-With': 'ActivProfi'}, body: {name: 'Исток тест'}});
    assert.equal(key.status, 201);
    assert.ok(key.json.key.startsWith('apk_'));
    const noKey = await request(app.port, 'POST', '/api/integrations/leads', {body: [{name: 'Без ключа', phone: '+79990000000'}]});
    assert.equal(noKey.status, 401);
    const leads = [
      {name: 'Иван Истоков', vk: 'https://vk.com/ivan_istok', telegram: '@ivan_istok', phone: '+7 999 555-66-77', email: 'ivan@example.test', comment: 'Интересовался CRM', postUrl: 'https://vk.com/wall-1_2', source: 'Исток', date: '2026-11-02'},
      {name: 'Тот же Иван', vk: 'https://vk.com/ivan_istok', comment: 'повтор'},
    ];
    const ingested = await request(app.port, 'POST', '/api/integrations/leads', {body: {leads, batchName: 'Исток тест'}, headers: {Authorization: 'Bearer ' + key.json.key}});
    assert.equal(ingested.status, 200, JSON.stringify(ingested.json));
    assert.equal(ingested.json.created, 1);
    assert.equal(ingested.json.duplicates, 1);
    const second = await request(app.port, 'POST', '/api/integrations/leads', {body: leads, headers: {'X-API-Key': key.json.key}});
    assert.equal(second.status, 200);
    assert.equal(second.json.created, 0);
    assert.ok(second.json.duplicates >= 1);
    const listed = await request(app.port, 'GET', '/api/clients', {cookie: admin});
    const ivan = listed.json.clients.find(client => client.email === 'ivan@example.test');
    assert.ok(ivan);
    assert.ok(ivan.socials.includes('vk.com/ivan_istok'));
    assert.ok(ivan.socials.includes('t.me/ivan_istok'));
    assert.equal(ivan.ownerId, '');
    const revoke = await request(app.port, 'DELETE', '/api/integration-keys/' + key.json.id, {cookie: admin, headers: {'X-Requested-With': 'ActivProfi'}});
    assert.equal(revoke.status, 200);
    const after = await request(app.port, 'POST', '/api/integrations/leads', {body: leads, headers: {'X-API-Key': key.json.key}});
    assert.equal(after.status, 401);
  } finally {
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('project file is stored on the server and hidden from other projects', async () => {
  const {app, dir} = await listen();
  try {
    const anna = await login(app.port, 'anna', 'demo-pass-1');
    const id = 'file-anna-1';
    const uploaded = await request(app.port, 'PUT', '/api/files/' + id, {
      cookie: anna,
      raw: Buffer.from('demo-file'),
      headers: {'X-Requested-With': 'ActivProfi', 'Content-Type': 'text/plain', 'X-File-Name': encodeURIComponent('заметка.txt'), 'X-Project-Id': '1'},
    });
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.json));
    const read = await request(app.port, 'GET', '/api/files/' + id, {cookie: anna});
    assert.equal(read.status, 200);
    assert.equal(read.buf.toString(), 'demo-file');
    const oleg = await login(app.port, 'oleg', 'demo-pass-1');
    const foreignProject = await request(app.port, 'PUT', '/api/files/file-oleg-1', {
      cookie: oleg,
      raw: Buffer.from('nope'),
      headers: {'X-Requested-With': 'ActivProfi', 'Content-Type': 'text/plain', 'X-File-Name': 'x.txt', 'X-Project-Id': '1'},
    });
    assert.equal(foreignProject.status, 403);
  } finally {
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('admin export and import keeps passwords and synthetic scope', async () => {
  const {app, dir} = await listen();
  try {
    const admin = await login(app.port, 'admin', 'admin-pass-1');
    const elena = await login(app.port, 'elena', 'demo-pass-1');
    const denied = await request(app.port, 'GET', '/api/migration/export', {cookie: elena});
    assert.equal(denied.status, 403);
    const exported = await request(app.port, 'GET', '/api/migration/export', {cookie: admin});
    assert.equal(exported.status, 200);
    assert.equal(exported.json.state.users.some(user => user.password || user.password_hash), false);
    exported.json.state.clients.push({id: 'import-1', name: 'Импортированный', phone: '+7 999 777-66-55', email: 'import@example.test', source: 'JSON', ownerId: 'sales', pipelineId: 'inbound', stageId: 'stage-0', notes: [], inLeadBase: false, stageHistory: []});
    const imported = await request(app.port, 'POST', '/api/migration/import', {cookie: admin, headers: {'X-Requested-With': 'ActivProfi'}, body: exported.json});
    assert.equal(imported.status, 200, JSON.stringify(imported.json?.error || imported.json?.temporaryPasswords));
    const again = await login(app.port, 'admin', 'admin-pass-1');
    const clients = await request(app.port, 'GET', '/api/clients', {cookie: again});
    assert.ok(clients.json.clients.some(client => client.id === 'import-1'));
    const tables = app.db.all("SELECT name FROM sqlite_master WHERE type = 'table'").map(row => row.name);
    assert.ok(tables.includes('integration_api_keys'));
    assert.ok(tables.includes('mailings'));
    assert.ok(tables.includes('contact_keys'));
  } finally {
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
