const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {start} = require('./app.cjs');
const {openDatabase, migrate} = require('./db.cjs');
const {createAdmin} = require('./bootstrap.cjs');
const store = require('./store.cjs');
const {hashPassword} = require('./passwords.cjs');

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

test('source comments are stored on the contact and a fully transferred file is archived with a timestamp', async () => {
  const {app, dir} = await listen();
  try {
    const irina = await login(app.port, 'irina', 'demo-pass-1');
    const headers = ['Имя', 'Телефон', 'Комментарий менеджера', 'Примечания', 'Город'];
    const rows = [['Анна Пример', '+7 999 111-22-33', 'Ждёт коммерческое предложение', 'Уточнить бюджет', 'Москва']];
    const imported = await request(app.port, 'POST', '/api/lead-batches/import', {
      cookie: irina,
      headers: {'X-Requested-With': 'ActivProfi'},
      body: {headers, rows, map: ['name', 'phone', '', '', ''], opts: {name: 'База с комментарием', pipelineId: 'outbound', destination: 'base', kind: 'cold', file: 'comments.csv', fileDate: '2026-11-17'}},
    });
    assert.equal(imported.status, 201, JSON.stringify(imported.json));
    const batchId = imported.json.batch.id;
    const listed = await request(app.port, 'GET', '/api/clients', {cookie: irina});
    const client = listed.json.clients.find(item => item.phone?.includes('111-22-33') || item.name === 'Анна Пример');
    assert.ok(client);
    assert.equal(client.sourceComment, 'Ждёт коммерческое предложение\nУточнить бюджет');
    assert.equal(String(client.sourceComment).includes('Москва'), false);
    const promoted = await request(app.port, 'POST', '/api/lead-batches/' + encodeURIComponent(batchId) + '/promote', {
      cookie: irina,
      headers: {'X-Requested-With': 'ActivProfi'},
      body: {pipelineId: 'outbound', stageId: 'out-2'},
    });
    assert.equal(promoted.status, 200, JSON.stringify(promoted.json));
    assert.equal(promoted.json.loaded, 1);
    const stored = promoted.json.state.clients.find(item => item.id === client.id);
    assert.equal(stored.sourceComment, 'Ждёт коммерческое предложение\nУточнить бюджет');
    assert.equal(stored.inLeadBase, false);
    assert.equal(stored.stageId, 'out-2');
    const batch = promoted.json.state.leadBatches.find(item => item.id === batchId);
    assert.equal(batch.archived, true);
    assert.match(batch.lastFunnelAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+10:00$/);
    const again = await request(app.port, 'GET', '/api/workspace', {cookie: irina});
    const savedBatch = again.json.state.leadBatches.find(item => item.id === batchId);
    assert.equal(savedBatch.archived, true);
    assert.equal(savedBatch.lastFunnelAt, batch.lastFunnelAt);
    const restored = await request(app.port, 'POST', '/api/lead-batches/' + encodeURIComponent(batchId) + '/restore', {
      cookie: irina,
      headers: {'X-Requested-With': 'ActivProfi'},
      body: {},
    });
    assert.equal(restored.status, 200, JSON.stringify(restored.json));
    assert.equal(restored.json.batch.archived, false);
    assert.equal(restored.json.batch.lastFunnelAt, batch.lastFunnelAt);
    const elena = await login(app.port, 'elena', 'demo-pass-1');
    const denied = await request(app.port, 'POST', '/api/lead-batches/' + encodeURIComponent(batchId) + '/archive', {
      cookie: elena,
      headers: {'X-Requested-With': 'ActivProfi'},
      body: {},
    });
    assert.equal(denied.status, 403);
    const archived = await request(app.port, 'POST', '/api/lead-batches/' + encodeURIComponent(batchId) + '/archive', {
      cookie: irina,
      headers: {'X-Requested-With': 'ActivProfi'},
      body: {},
    });
    assert.equal(archived.status, 200, JSON.stringify(archived.json));
    assert.equal(archived.json.batch.archived, true);
    const partial = await request(app.port, 'POST', '/api/lead-batches/import', {
      cookie: irina,
      headers: {'X-Requested-With': 'ActivProfi'},
      body: {
        headers: ['Имя', 'Телефон', 'Комментарий'],
        rows: [['Борис Часть', '+7 999 444-55-66', 'Перезвонить'], ['Вера Часть', '+7 999 444-55-67', 'Ждут КП']],
        map: ['name', 'phone', 'notes'],
        opts: {name: 'Частичная база', pipelineId: 'outbound', destination: 'base', kind: 'cold', file: 'partial.csv', fileDate: '2026-11-17'},
      },
    });
    assert.equal(partial.status, 201, JSON.stringify(partial.json));
    const partialId = partial.json.batch.id;
    const boris = partial.json.state.clients.find(item => item.name === 'Борис Часть');
    boris.ownerId = 'sales';
    const moved = await request(app.port, 'PUT', '/api/workspace', {
      cookie: irina,
      headers: {'X-Requested-With': 'ActivProfi'},
      body: {revision: partial.json.state.revision, state: partial.json.state},
    });
    assert.equal(moved.status, 200, JSON.stringify(moved.json?.error || moved.status));
    const elenaLoad = await request(app.port, 'POST', '/api/lead-batches/' + encodeURIComponent(partialId) + '/promote', {
      cookie: elena,
      headers: {'X-Requested-With': 'ActivProfi'},
      body: {pipelineId: 'outbound', stageId: 'out-2'},
    });
    assert.equal(elenaLoad.status, 200, JSON.stringify(elenaLoad.json));
    assert.equal(elenaLoad.json.loaded, 1);
    const openBatch = elenaLoad.json.state.leadBatches.find(item => item.id === partialId);
    assert.equal(openBatch.archived, undefined);
    assert.equal(openBatch.funnelSent, 1);
    assert.equal(openBatch.funnelTotal, 2);
    assert.match(openBatch.lastFunnelAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+10:00$/);
    assert.equal(elenaLoad.json.state.clients.find(item => item.id === boris.id).sourceComment, 'Перезвонить');
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
    const migrations = app.db.all('SELECT id FROM schema_migrations').map(row => row.id);
    assert.ok(migrations.includes('003-proposal-stage'));
  } finally {
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('integration key can place a deal on Отправлено КП and returns its id', async () => {
  const {app, dir} = await listen();
  try {
    const admin = await login(app.port, 'admin', 'admin-pass-1');
    const key = await request(app.port, 'POST', '/api/integration-keys', {
      cookie: admin,
      headers: {'X-Requested-With': 'ActivProfi'},
      body: {name: 'Колл-центр'},
    });
    const payload = {
      pipelineId: 'inbound',
      stage: 'Отправлено КП',
      leads: [{
        name: 'Ирина Колл',
        description: 'Сеть кофеен, нужен учёт заявок',
        email: 'irina-call@example.test',
        phone: '+7 999 555-01-99',
        source: 'колл-центр',
        date: '2026-11-18',
        clientTask: 'Автоматизировать приём заявок с сайта',
        kpVariants: 'Базовый 90 000 ₽ / 3 недели; Расширенный 160 000 ₽ / 6 недель',
        kpLink: 'https://kp.example.test/maya',
        callAt: '2026-11-20T15:00',
        statusNote: 'ждём решения',
        comment: 'Просили смету на два варианта',
      }],
    };
    const created = await request(app.port, 'POST', '/api/integrations/leads', {
      body: payload,
      headers: {Authorization: 'Bearer ' + key.json.key},
    });
    assert.equal(created.status, 200, JSON.stringify(created.json));
    assert.equal(created.json.created, 1);
    assert.ok(created.json.id);
    assert.deepEqual(created.json.ids, [created.json.id]);
    const seen = await request(app.port, 'GET', '/api/clients/' + created.json.id, {cookie: admin});
    assert.equal(seen.status, 200);
    const deal = seen.json.client;
    assert.equal(deal.stage, 'Отправлено КП');
    assert.equal(deal.inLeadBase, false);
    assert.equal(deal.source, 'колл-центр');
    assert.equal(deal.email, 'irina-call@example.test');
    assert.equal(deal.description, 'Сеть кофеен, нужен учёт заявок');
    assert.equal(deal.clientTask, 'Автоматизировать приём заявок с сайта');
    assert.match(deal.kpVariants, /90 000/);
    assert.equal(deal.kpLink, 'https://kp.example.test/maya');
    assert.equal(deal.callAt, '2026-11-20T15:00');
    assert.equal(deal.statusNote, 'ждём решения');
    assert.equal(deal.dealDate, '2026-11-18');
    assert.match(deal.sourceComment, /два варианта/);
    const before = (await request(app.port, 'GET', '/api/clients', {cookie: admin})).json.clients.find(client => client.id === '1');
    const duplicate = await request(app.port, 'POST', '/api/integrations/leads', {
      body: payload,
      headers: {'X-API-Key': key.json.key},
    });
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.json.created, 0);
    assert.equal(duplicate.json.deals[0].status, 'duplicate');
    assert.equal(duplicate.json.deals[0].id, created.json.id);
    const after = (await request(app.port, 'GET', '/api/clients', {cookie: admin})).json.clients.find(client => client.id === '1');
    assert.equal(after.stageId, before.stageId);
    const missing = await request(app.port, 'POST', '/api/integrations/leads', {
      body: {pipelineId: 'inbound', stage: 'Нет такого этапа', leads: [{name: 'Пустой этап', phone: '+7 999 555-01-98'}]},
      headers: {'X-API-Key': key.json.key},
    });
    assert.equal(missing.status, 400);
    const oleg = await login(app.port, 'oleg', 'demo-pass-1');
    assert.equal((await request(app.port, 'GET', '/api/clients/' + created.json.id, {cookie: oleg})).status, 404);
  } finally {
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('project team accepts admin, dev head and pm, and keeps developer task scope', async () => {
  const {app, dir} = await listen();
  try {
    const admin = await login(app.port, 'admin', 'admin-pass-1');
    const browser = {'X-Requested-With': 'ActivProfi'};
    const created = await request(app.port, 'POST', '/api/projects', {
      cookie: admin,
      headers: browser,
      body: {
        title: 'Напоминания о сеансе',
        client: 'Студия массажа',
        description: 'Проверка команды проекта',
        start: '2026-11-18',
        due: '2026-12-25',
        budget: 250000,
        leaderId: 'devhead',
        pmId: 'pm',
        members: ['anna', 'sales'],
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const project = created.json.state.projects.find(item => item.title === 'Напоминания о сеансе');
    assert.equal(project.leaderId, 'devhead');
    assert.equal(project.pmId, 'pm');
    assert.deepEqual(project.members, ['anna', 'sales', 'devhead', 'pm']);

    const blank = await request(app.port, 'POST', '/api/projects', {
      cookie: admin,
      headers: browser,
      body: {title: 'Без команды', client: 'Заказчик', start: '2026-11-18', due: '2026-12-01', leaderId: '', pmId: '', members: []},
    });
    assert.equal(blank.status, 201, JSON.stringify(blank.json));
    const fallback = blank.json.state.projects.find(item => item.title === 'Без команды');
    assert.equal(fallback.leaderId, 'admin');
    assert.equal(fallback.pmId, '');
    assert.deepEqual(fallback.members, ['admin']);

    const badLeader = await request(app.port, 'POST', '/api/projects', {
      cookie: admin,
      headers: browser,
      body: {title: 'Чужой руководитель', client: 'Заказчик', leaderId: 'anna', pmId: '', members: []},
    });
    assert.equal(badLeader.status, 400);
    assert.match(badLeader.json.error, /Руководителем может быть/);

    const badPm = await request(app.port, 'POST', '/api/projects', {
      cookie: admin,
      headers: browser,
      body: {title: 'Чужой проджект', client: 'Заказчик', leaderId: 'admin', pmId: 'sales', members: []},
    });
    assert.equal(badPm.status, 400);
    assert.match(badPm.json.error, /Проджект-менеджером может быть/);

    const missing = await request(app.port, 'POST', '/api/projects', {
      cookie: admin,
      headers: browser,
      body: {title: 'Пустой id', client: 'Заказчик', leaderId: 'lead', pmId: 'ghost', members: []},
    });
    assert.equal(missing.status, 400);

    const taskBody = {projectId: project.id, start: '2026-11-18', due: '2026-12-01', estimate: 4, remaining: 4, type: 'work'};
    const own = await request(app.port, 'POST', '/api/tasks', {
      cookie: admin,
      headers: browser,
      body: {...taskBody, title: 'Задача Анны', assigneeId: 'anna'},
    });
    assert.equal(own.status, 201, JSON.stringify(own.json));
    const foreign = await request(app.port, 'POST', '/api/tasks', {
      cookie: admin,
      headers: browser,
      body: {...taskBody, title: 'Задача Елены', assigneeId: 'sales'},
    });
    assert.equal(foreign.status, 201, JSON.stringify(foreign.json));

    const anna = await login(app.port, 'anna', 'demo-pass-1');
    const annaProjects = await request(app.port, 'GET', '/api/projects', {cookie: anna});
    assert.ok(annaProjects.json.projects.some(item => item.id === project.id));
    assert.ok(annaProjects.json.projects.some(item => item.id === '1'));
    const annaTasks = await request(app.port, 'GET', '/api/tasks', {cookie: anna});
    const annaOnProject = annaTasks.json.tasks.filter(item => item.projectId === project.id);
    assert.deepEqual(annaOnProject.map(item => item.title), ['Задача Анны']);

    const elena = await login(app.port, 'elena', 'demo-pass-1');
    const elenaProjects = await request(app.port, 'GET', '/api/projects', {cookie: elena});
    assert.ok(elenaProjects.json.projects.some(item => item.id === project.id));
    const elenaTasks = await request(app.port, 'GET', '/api/tasks', {cookie: elena});
    assert.deepEqual(elenaTasks.json.tasks.filter(item => item.projectId === project.id).map(item => item.title), ['Задача Елены']);

    const maria = await login(app.port, 'maria', 'demo-pass-1');
    const mariaProjects = await request(app.port, 'GET', '/api/projects', {cookie: maria});
    assert.equal(mariaProjects.json.projects.some(item => item.id === project.id), false);
    assert.ok(mariaProjects.json.projects.every(item => item.leaderId === 'lead'));

    const moved = await request(app.port, 'PATCH', '/api/projects/' + project.id, {
      cookie: admin,
      headers: browser,
      body: {devStage: 'dev-r1'},
    });
    assert.equal(moved.status, 200, JSON.stringify(moved.json));
    const updated = moved.json.state.projects.find(item => item.id === project.id);
    assert.equal(updated.devStage, 'dev-r1');
    assert.equal(updated.leaderId, 'devhead');
    assert.equal(updated.pmId, 'pm');
  } finally {
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('copied profile login does not block employees, and a real duplicate still fails', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-login-'));
  const databasePath = path.join(dir, 'crm.sqlite');
  const setup = openDatabase(databasePath);
  migrate(setup);
  createAdmin(setup, {adminLogin: 'admin', adminPassword: 'admin-pass-1', adminName: 'Админ'});
  const adminRow = setup.get('SELECT data FROM users WHERE id = ?', 'admin');
  const copied = JSON.parse(adminRow.data);
  copied.id = 'test';
  copied.name = 'Тестовый';
  copied.login = 'admin';
  setup.run(
    'INSERT INTO users (id, login, password_hash, role, active, data) VALUES (?, ?, ?, ?, ?, ?)',
    'test', 'test', hashPassword('test-pass-1'), 'admin', 1, JSON.stringify(copied),
  );
  const project = {
    id: 'kept-project', title: 'Существующий проект', client: 'Старый заказчик', description: 'Нельзя потерять',
    type: 'crm', status: 'Проектирование', leaderId: 'admin', pmId: '', members: ['admin'],
    start: '2026-11-01', due: '2026-12-01', budget: 1000, next: '', recipients: [],
    board: {notes: [], links: [], comments: []}, mockup: {name: '', data: ''}, devStage: 'dev-start',
  };
  setup.run('INSERT INTO projects (id, leader_id, dev_stage, data) VALUES (?, ?, ?, ?)', project.id, 'admin', 'dev-start', JSON.stringify(project));
  const client = {
    id: 'kept-client', name: 'Старый клиент', company: 'Фирма', phone: '+7 999 000-11-22', email: 'old@example.test',
    socials: '', amount: 5000, source: 'Вручную', pipelineId: 'inbound', stageId: 'stage-new', ownerId: 'admin',
    inLeadBase: false, project: 'kept-project', notes: ['уже был'], stageHistory: [], createdAt: '2026-11-01',
  };
  setup.run(
    'INSERT INTO clients (id, owner_id, pipeline_id, stage_id, project_id, batch_id, in_lead_base, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    client.id, 'admin', 'inbound', 'stage-new', 'kept-project', '', 0, JSON.stringify(client),
  );
  setup.close();

  const boot = {
    host: '127.0.0.1', port: 0, databasePath, seedDemo: false,
    adminLogin: 'admin', adminPassword: 'admin-pass-1', adminName: 'Админ', sessionDays: 2, cookieSecure: false,
  };
  const browser = {'X-Requested-With': 'ActivProfi'};
  let app = await start(boot);
  try {
    const healed = openDatabase(databasePath);
    const testRow = healed.get('SELECT login, data FROM users WHERE id = ?', 'test');
    assert.equal(testRow.login, 'test');
    assert.equal(JSON.parse(testRow.data).login, 'test');
    assert.equal(healed.get('SELECT id FROM projects WHERE id = ?', 'kept-project').id, 'kept-project');
    healed.close();

    const admin = await login(app.port, 'admin', 'admin-pass-1');
    const testLogin = await login(app.port, 'test', 'test-pass-1');
    assert.equal(testLogin.length > 0, true);
    const ws = await request(app.port, 'GET', '/api/workspace', {cookie: admin});
    assert.equal(ws.status, 200);
    assert.deepEqual(ws.json.state.users.map(user => user.login).sort(), ['admin', 'test']);
    assert.equal(ws.json.state.projects.some(item => item.id === 'kept-project'), true);
    assert.equal(ws.json.state.clients.some(item => item.id === 'kept-client'), true);

    const stale = structuredClone(ws.json.state);
    const staleTest = stale.users.find(user => user.id === 'test');
    staleTest.login = 'admin';
    staleTest.role = 'leader';
    staleTest.name = 'Тестовый руководитель';
    const keptRole = await request(app.port, 'PUT', '/api/workspace', {cookie: admin, headers: browser, body: {revision: ws.json.revision, state: stale}});
    assert.equal(keptRole.status, 200, JSON.stringify(keptRole.json));
    const healedTest = keptRole.json.state.users.find(user => user.id === 'test');
    assert.equal(healedTest.login, 'test');
    assert.equal(healedTest.role, 'leader');
    assert.equal(healedTest.name, 'Тестовый руководитель');

    const fresh = await request(app.port, 'GET', '/api/workspace', {cookie: admin});
    const people = [
      {id: 'u-maria', name: 'Мария', login: 'maria', password: 'maria-pass-1', role: 'leader'},
      {id: 'u-pavel', name: 'Павел', login: 'Pavel', password: 'pavel-pass-1', role: 'dev_head'},
      {id: 'u-anna', name: 'Анна', login: 'anna', password: 'anna-pass-1', role: 'developer'},
    ];
    const draft = structuredClone(fresh.json.state);
    for (const person of people) draft.users.push({...person, active: true, permissionOverrides: {}});
    const created = await request(app.port, 'PUT', '/api/workspace', {cookie: admin, headers: browser, body: {revision: fresh.json.revision, state: draft}});
    assert.equal(created.status, 200, JSON.stringify(created.json));
    assert.deepEqual(created.json.state.users.map(user => user.login).sort(), ['admin', 'anna', 'maria', 'pavel', 'test']);

    const renamed = structuredClone(created.json.state);
    renamed.users.find(user => user.id === 'u-maria').role = 'pm';
    renamed.users.find(user => user.id === 'admin').name = 'Главный админ';
    const saved = await request(app.port, 'PUT', '/api/workspace', {cookie: admin, headers: browser, body: {revision: created.json.revision, state: renamed}});
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    assert.equal(saved.json.state.users.find(user => user.id === 'u-maria').role, 'pm');
    assert.equal(saved.json.state.users.find(user => user.id === 'admin').name, 'Главный админ');

    const duplicate = await request(app.port, 'POST', '/api/users', {
      cookie: admin, headers: browser,
      body: {name: 'Ещё Мария', login: 'Maria', password: 'maria-pass-2', role: 'sales'},
    });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.json.error, 'Такой логин уже занят');
    const duplicateTest = await request(app.port, 'POST', '/api/users', {
      cookie: admin, headers: browser,
      body: {name: 'Второй тест', login: 'TEST', password: 'test-pass-2', role: 'developer'},
    });
    assert.equal(duplicateTest.status, 409);

    await app.close();
    app = await start(boot);
    const again = await login(app.port, 'admin', 'admin-pass-1');
    const after = await request(app.port, 'GET', '/api/workspace', {cookie: again});
    assert.equal(after.json.state.users.find(user => user.id === 'u-maria').role, 'pm');
    assert.equal(after.json.state.users.find(user => user.id === 'u-pavel').role, 'dev_head');
    assert.equal(after.json.state.users.find(user => user.id === 'u-anna').role, 'developer');
    assert.equal(after.json.state.users.find(user => user.id === 'admin').name, 'Главный админ');
    assert.equal(after.json.state.users.find(user => user.id === 'test').login, 'test');
    assert.equal(after.json.state.projects.find(item => item.id === 'kept-project').title, 'Существующий проект');
    assert.equal(after.json.state.clients.find(item => item.id === 'kept-client').name, 'Старый клиент');
    const maria = await login(app.port, 'maria', 'maria-pass-1');
    const me = await request(app.port, 'GET', '/api/auth/me', {cookie: maria});
    assert.equal(me.json.user.login, 'maria');
    assert.equal(me.json.user.role, 'pm');
  } finally {
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
