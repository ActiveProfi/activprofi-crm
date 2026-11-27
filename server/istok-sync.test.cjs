const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {start} = require('./app.cjs');

function request(port, method, pathname, {body, cookie, headers} = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname, method,
      headers: {
        ...(data ? {'Content-Type': 'application/json', 'Content-Length': data.length} : {}),
        ...(cookie ? {Cookie: cookie} : {}),
        'X-Requested-With': 'ActivProfi',
        ...headers,
      },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json;
        try { json = JSON.parse(buf.toString('utf8')); } catch { json = undefined; }
        resolve({status: res.statusCode, json, buf, cookie: res.headers['set-cookie']});
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

test('Istok updates an existing card, keeps the stage, and exports a selection by the right key', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-istok-'));
  const app = await start({
    host: '127.0.0.1', port: 0, databasePath: path.join(dir, 'crm.sqlite'),
    seedDemo: true, seedPassword: 'demo-pass-1', adminLogin: 'admin', adminPassword: 'admin-pass-1', adminName: 'Ксения',
    sessionDays: 2, cookieSecure: false, telegramPoll: false, sipuniSync: false,
  });
  try {
    const admin = await login(app.port, 'admin', 'admin-pass-1');
    const writeKey = await request(app.port, 'POST', '/api/integration-keys', {cookie: admin, body: {name: 'Исток пишет', scope: 'leads:write'}});
    const readKey = await request(app.port, 'POST', '/api/integration-keys', {cookie: admin, body: {name: 'Исток читает', scope: 'export:read'}});
    assert.equal(writeKey.json.scope, 'leads:write');
    assert.equal(readKey.json.scope, 'export:read');
    const home = await request(app.port, 'GET', '/api/workspace', {cookie: admin});
    const pipe = home.json.state.pipelines[0];
    const stage = pipe.stages.find(item => item.kind === 'open');
    const placed = await request(app.port, 'POST', '/api/clients', {cookie: admin, body: {
      name: 'Марина', company: '', phone: '+79991110001', email: 'marina@example.test', ownerId: 'sales',
      pipelineId: pipe.id, stageId: stage.id, amount: 1000, source: 'Сайт', inLeadBase: false,
    }});
    assert.equal(placed.status, 201, JSON.stringify(placed.json));
    const incoming = await request(app.port, 'POST', '/api/integrations/leads', {
      headers: {Authorization: 'Bearer ' + writeKey.json.key},
      body: {batchName: 'Исток · кофе', leads: [{
        name: 'Марина Кофе', company: 'Кофейня «Маяк»', phone: '+7 999 111-00-01', email: 'new-marina@example.test',
        site: 'https://mayak.example', other: 'https://vk.com/mayak_cafe', city: 'Владивосток', segment: 'кофе, опт',
        istokId: 'istok-77', comment: 'новый телефон и сайт', source: 'Исток',
      }, {
        name: 'Без контакта', company: 'Пусто',
      }]},
    });
    assert.equal(incoming.status, 200, JSON.stringify(incoming.json));
    assert.equal(incoming.json.updated, 1);
    assert.equal(incoming.json.skipped, 1);
    assert.equal(incoming.json.created, 0);
    const card = (await request(app.port, 'GET', '/api/clients/' + placed.json.id, {cookie: admin})).json.client;
    assert.equal(card.stageId, stage.id);
    assert.equal(card.ownerId, 'sales');
    assert.equal(card.pipelineId, pipe.id);
    assert.equal(card.company, 'Кофейня «Маяк»');
    assert.match(card.site, /mayak\.example/);
    assert.match(card.socials, /vk\.com\/mayak_cafe/);
    assert.equal(card.city, 'Владивосток');
    assert.deepEqual(card.tags, ['кофе', 'опт']);
    assert.equal(card.istokId, 'istok-77');
    assert.ok(card.emails.includes('new-marina@example.test'));
    assert.ok(card.notes.some(note => String(note).includes('обновлено из Истока')));

    const fresh = await request(app.port, 'POST', '/api/integrations/leads', {
      headers: {'X-API-Key': writeKey.json.key},
      body: {leads: [{name: 'Олег Склад', company: 'Склад Север', phone: '+79992220002', email: 'sklad@example.test', city: 'Артём', istokId: 'istok-2', source: 'Исток'}]},
    });
    assert.equal(fresh.json.created, 1);
    const created = (await request(app.port, 'GET', '/api/clients/' + fresh.json.ids[0], {cookie: admin})).json.client;
    assert.equal(created.company, 'Склад Север');
    assert.equal(created.city, 'Артём');
    assert.equal(created.inLeadBase, true);
    assert.equal(created.ownerId, '');

    const deniedExport = await request(app.port, 'GET', '/api/integrations/selections?status=new', {headers: {Authorization: 'Bearer ' + writeKey.json.key}});
    assert.equal(deniedExport.status, 403);
    const deniedWrite = await request(app.port, 'POST', '/api/integrations/leads', {headers: {Authorization: 'Bearer ' + readKey.json.key}, body: {leads: [{name: 'Нет', phone: '+79990000099'}]}});
    assert.equal(deniedWrite.status, 403);

    const noviceMade = await request(app.port, 'POST', '/api/users', {cookie: admin, body: {name: 'Новичок Нина', login: 'nina', password: 'nina-pass-1', role: 'sales'}});
    const nina = noviceMade.json.state.users.find(user => user.login === 'nina');
    assert.equal(nina.probation, true);
    const own = await request(app.port, 'POST', '/api/clients', {cookie: admin, body: {name: 'Свой Нины', phone: '+79993330003', email: 'nina-own@example.test', ownerId: nina.id, pipelineId: pipe.id, stageId: stage.id, source: 'Исток', amount: 1}});
    const quiet = await request(app.port, 'POST', '/api/clients', {cookie: admin, body: {name: 'Не звонить', phone: '+79993330004', email: 'nina-quiet@example.test', ownerId: nina.id, pipelineId: pipe.id, stageId: stage.id, source: 'Исток', amount: 1, doNotContact: true}});
    const foreign = await request(app.port, 'POST', '/api/clients', {cookie: admin, body: {name: 'Чужой для Нины', phone: '+79993330005', email: 'nina-foreign@example.test', ownerId: 'sales', pipelineId: pipe.id, stageId: stage.id, source: 'Исток', amount: 1}});
    assert.equal(own.status, 201);
    assert.equal(quiet.status, 201);
    assert.equal(foreign.status, 201);
    const ninaCookie = await login(app.port, 'nina', 'nina-pass-1');
    const selection = await request(app.port, 'POST', '/api/mailing-selections', {cookie: ninaCookie, body: {name: 'Рассылка Нины', source: 'Исток', ownerId: 'sales'}});
    assert.equal(selection.status, 201, JSON.stringify(selection.json));
    assert.equal(selection.json.count, 1);
    const hidden = await request(app.port, 'GET', '/api/mailing-selections', {cookie: await login(app.port, 'elena', 'demo-pass-1')});
    assert.equal(hidden.json.selections.some(item => item.id === selection.json.id), false);
    const visible = await request(app.port, 'GET', '/api/mailing-selections', {cookie: admin});
    assert.equal(visible.json.selections.some(item => item.id === selection.json.id && item.status === 'new'), true);

    const csv = await request(app.port, 'GET', '/api/integrations/selections/' + selection.json.id + '?format=csv', {headers: {Authorization: 'Bearer ' + readKey.json.key}});
    assert.equal(csv.status, 200, csv.buf.toString('utf8'));
    assert.equal(csv.buf[0], 0xEF);
    assert.equal(csv.buf[1], 0xBB);
    assert.equal(csv.buf[2], 0xBF);
    const text = csv.buf.toString('utf8').replace(/^\uFEFF/, '');
    const header = text.split('\r\n')[0];
    assert.equal(header, 'Название,Контакт,Телефон,Email,VK,Telegram,Сайт,Город,Комментарий,CRM-ID');
    assert.match(text, /Свой Нины/);
    assert.equal(text.includes('Не звонить'), false);
    assert.equal(text.includes('Чужой для Нины'), false);
    const json = await request(app.port, 'GET', '/api/integrations/selections/' + selection.json.id + '?format=json', {headers: {'X-API-Key': readKey.json.key}});
    assert.equal(json.json.rows.length, 1);
    assert.equal(json.json.rows[0]['CRM-ID'], own.json.id);
    const ack = await request(app.port, 'POST', '/api/integrations/selections/' + selection.json.id + '/ack', {headers: {Authorization: 'Bearer ' + readKey.json.key}});
    assert.equal(ack.json.status, 'taken');
    const again = await request(app.port, 'GET', '/api/integrations/selections?status=new', {headers: {Authorization: 'Bearer ' + readKey.json.key}});
    assert.equal(again.json.selections.some(item => item.id === selection.json.id), false);
  } finally {
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
