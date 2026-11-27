const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {start} = require('./app.cjs');
const Guide = require('../variant-b/guide.js');
const M = require('../variant-b/model.js');

function request(port, method, pathname, {body, cookie, headers, raw} = {}) {
  return new Promise((resolve, reject) => {
    const data = raw || (body === undefined ? null : Buffer.from(JSON.stringify(body)));
    const req = http.request({hostname: '127.0.0.1', port, path: pathname, method, headers: {'Content-Type': 'application/json', 'X-Requested-With': 'ActivProfi', ...(cookie ? {Cookie: cookie} : {}), ...(data ? {'Content-Length': data.length} : {}), ...headers}}, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json; try { json = JSON.parse(buf.toString('utf8')); } catch { json = undefined; }
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

test('record save ignores other records and keeps the form text on a real clash', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-audit-'));
  const app = await start({host: '127.0.0.1', port: 0, databasePath: path.join(dir, 'crm.sqlite'), seedDemo: true, seedPassword: 'demo-pass-1', adminLogin: 'admin', adminPassword: 'admin-pass-1', adminName: 'Ксения', sessionDays: 2, cookieSecure: false, telegramPoll: false, sipuniSync: false});
  try {
    const admin = await login(app.port, 'admin', 'admin-pass-1');
    const ws = await request(app.port, 'GET', '/api/workspace', {cookie: admin});
    const [first, second] = ws.json.state.clients;
    const edited = {...first, notes: ['Текст, который нельзя потерять']};
    const saved = await request(app.port, 'POST', '/api/records', {cookie: admin, body: {items: [{kind: 'client', id: first.id, rev: first.recordRev, data: edited}]}});
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    const other = {...second, statusNote: 'параллельная правка'};
    const parallel = await request(app.port, 'POST', '/api/records', {cookie: admin, body: {items: [{kind: 'client', id: second.id, rev: second.recordRev, data: other}]}});
    assert.equal(parallel.status, 200, JSON.stringify(parallel.json));
    const clash = await request(app.port, 'POST', '/api/records', {cookie: admin, body: {items: [{kind: 'client', id: first.id, rev: first.recordRev, data: {...edited, company: 'Поверх'}}]}});
    assert.equal(clash.status, 409);
    assert.match(clash.json.error, /Текст в форме сохранён/);
    const kept = parallel.json.state.clients.find(item => item.id === first.id);
    assert.equal(kept.notes[0], 'Текст, который нельзя потерять');
  } finally {
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('staged Istok lead gets a manager, refusal stage exists, phones do not duplicate', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-audit2-'));
  const app = await start({host: '127.0.0.1', port: 0, databasePath: path.join(dir, 'crm.sqlite'), seedDemo: true, seedPassword: 'demo-pass-1', adminLogin: 'admin', adminPassword: 'admin-pass-1', adminName: 'Ксения', sessionDays: 2, cookieSecure: false, telegramPoll: false, sipuniSync: false});
  try {
    const admin = await login(app.port, 'admin', 'admin-pass-1');
    const ws = await request(app.port, 'GET', '/api/workspace', {cookie: admin});
    const outbound = ws.json.state.pipelines.find(item => item.id === 'outbound');
    assert.ok(outbound.stages.some(stage => stage.kind === 'lost' && stage.name === 'Отказ'));
    assert.equal(ws.json.state.rolePermissions.pm['tasks.assign'], true);
    assert.equal(ws.json.state.rolePermissions.pm['projects.create'], true);
    const key = await request(app.port, 'POST', '/api/integration-keys', {cookie: admin, body: {name: 'Сделки', scope: 'leads:write'}});
    const staged = await request(app.port, 'POST', '/api/integrations/leads', {headers: {Authorization: 'Bearer ' + key.json.key}, body: {pipelineId: 'inbound', stage: 'Отправлено КП', leads: [{name: 'Ждёт менеджера', phone: '+79995550001', email: 'wait@example.test', company: 'Ждут'}]}});
    assert.equal(staged.status, 200, JSON.stringify(staged.json));
    const card = (await request(app.port, 'GET', '/api/clients/' + staged.json.id, {cookie: admin})).json.client;
    assert.ok(card.ownerId);
    assert.equal(card.awaitingManager, false);
    const duplicate = await request(app.port, 'POST', '/api/clients', {cookie: admin, body: {name: 'Дубль', phone: '8 999 555 00 01', email: 'other-wait@example.test', pipelineId: 'inbound', stageId: card.stageId, amount: 0}});
    assert.equal(duplicate.status, 409);
    const queue = Guide.contactQueue([{id: 'base', name: 'База', inLeadBase: true, owned: true, kind: 'open', next: 'Позвонить', when: '2026-11-20T10:00'}], '2026-11-23');
    assert.equal(queue[0].id, 'base');
    const lost = ws.json.state.pipelines[0].stages.find(stage => stage.kind === 'lost');
    const refused = await request(app.port, 'PATCH', '/api/clients/' + card.id, {cookie: admin, body: {stageId: lost.id, lossReason: 'price', returnAt: '2026-12-01', inLeadBase: false}});
    assert.equal(refused.status, 200, JSON.stringify(refused.json));
    const after = refused.json.state.clients.find(item => item.id === card.id);
    assert.equal(after.lossReason, 'price');
    assert.equal(after.returnAt, '2026-12-01');
  } finally {
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('won deal carries deadline, amount, mail and team; unknown calls stay with the duty person', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-audit3-'));
  const app = await start({host: '127.0.0.1', port: 0, databasePath: path.join(dir, 'crm.sqlite'), seedDemo: true, seedPassword: 'demo-pass-1', adminLogin: 'admin', adminPassword: 'admin-pass-1', adminName: 'Ксения', sessionDays: 2, cookieSecure: false, telegramPoll: false, sipuniSync: false, sipuniUser: '012345', sipuniSecret: 'test-secret', sipuniWebhookToken: 'hook-test-key', sipuniMock: true});
  try {
    const admin = await login(app.port, 'admin', 'admin-pass-1');
    const ws = await request(app.port, 'GET', '/api/workspace', {cookie: admin});
    const draft = structuredClone(ws.json.state);
    draft.desk = {dutyUserId: 'sales', defaultLeaderId: 'lead', defaultPmId: 'pm'};
    const set = await request(app.port, 'PUT', '/api/workspace', {cookie: admin, body: {revision: ws.json.revision, state: draft}});
    assert.equal(set.status, 200, JSON.stringify(set.json));
    const elena = await login(app.port, 'elena', 'demo-pass-1');
    const createdClient = await request(app.port, 'POST', '/api/clients', {cookie: admin, body: {name: 'Новая победа', phone: '+79997770007', email: 'win@example.test', ownerId: 'sales', pipelineId: 'inbound', stageId: set.json.state.pipelines.find(item => item.id === 'inbound').stages.find(stage => stage.kind === 'open').id, amount: 1000, source: 'Вручную'}});
    assert.equal(createdClient.status, 201, JSON.stringify(createdClient.json));
    const client = {id: createdClient.json.id};
    const won = set.json.state.pipelines.find(item => item.id === 'inbound').stages.find(stage => stage.kind === 'won');
    const moved = await request(app.port, 'PATCH', '/api/clients/' + client.id, {cookie: elena, body: {
      stageId: won.id, inLeadBase: false, next: '', when: '', email: 'client@example.test', amount: 88000,
      handover: {sold: 'Сайт и заявки', kp: 'Старт', amount: 88000, due: '2026-12-20', contacts: 'client@example.test', kpLink: '', files: []},
    }});
    assert.equal(moved.status, 200, JSON.stringify(moved.json));
    const project = moved.json.state.projects.find(item => item.sourceClientId === client.id);
    assert.equal(project.due, '2026-12-20');
    const stored = await request(app.port, 'GET', '/api/projects/' + project.id, {cookie: admin});
    assert.equal(stored.json.project.budget, 88000);
    assert.equal(project.leaderId, 'lead');
    assert.equal(project.pmId, 'pm');
    assert.equal(project.description, 'Сайт и заявки');
    assert.ok(project.recipients.some(item => item.email === 'client@example.test'));
    assert.equal(moved.json.state.clients.find(item => item.id === client.id).next, '');
    const cleared = await request(app.port, 'GET', '/api/workspace', {cookie: admin});
    const noTeam = structuredClone(cleared.json.state);
    noTeam.desk = {dutyUserId: 'sales', defaultLeaderId: '', defaultPmId: ''};
    const savedDesk = await request(app.port, 'PUT', '/api/workspace', {cookie: admin, body: {revision: cleared.json.revision, state: noTeam}});
    assert.equal(savedDesk.status, 200, JSON.stringify(savedDesk.json));
    const second = await request(app.port, 'POST', '/api/clients', {cookie: admin, body: {name: 'Без команды', phone: '+79997770008', email: 'bare@example.test', ownerId: 'sales', pipelineId: 'inbound', stageId: set.json.state.pipelines.find(item => item.id === 'inbound').stages.find(stage => stage.kind === 'open').id, amount: 500, source: 'Вручную'}});
    const bareWon = await request(app.port, 'PATCH', '/api/clients/' + second.json.id, {cookie: elena, body: {stageId: won.id, inLeadBase: false, handover: {sold: 'Без команды', amount: 500, due: '', contacts: '', kp: '', kpLink: '', files: []}}});
    if (bareWon.status !== 200) throw new Error(String(bareWon.buf));
    const unassigned = bareWon.json.state.projects.find(item => item.sourceClientId === second.json.id);
    assert.equal(unassigned.leaderId, '');
    const maria = await login(app.port, 'maria', 'demo-pass-1');
    const leaderView = await request(app.port, 'GET', '/api/projects', {cookie: maria});
    assert.ok(leaderView.json.projects.some(item => item.id === unassigned.id));
    const unknown = await request(app.port, 'POST', '/api/sipuni/event', {raw: 'event=2&call_id=unk-1&src_num=79990001122&src_type=1&dst_num=012345999&dst_type=2&status=NOANSWER&token=hook-test-key', headers: {'Content-Type': 'application/x-www-form-urlencoded'}});
    assert.equal(unknown.status, 200, String(unknown.buf));
    const ninaMade = await request(app.port, 'POST', '/api/users', {cookie: admin, body: {name: 'Нина', login: 'nina', password: 'nina-pass-1', role: 'sales'}});
    assert.equal(ninaMade.json.state.users.find(item => item.login === 'nina').probation, true);
    const nina = await login(app.port, 'nina', 'nina-pass-1');
    const hidden = await request(app.port, 'GET', '/api/sipuni', {cookie: nina});
    assert.equal(hidden.json.unknown.length, 0);
    const duty = await request(app.port, 'GET', '/api/sipuni', {cookie: elena});
    assert.ok(duty.json.unknown.some(item => item.digits === '79990001122'));
    const lead = await request(app.port, 'POST', '/api/sipuni/lead', {cookie: elena, body: {phone: '79990001122', name: 'Со звонка', confirmPhone: '8 999 000-11-22'}});
    assert.equal(lead.status, 200, JSON.stringify(lead.json));
    const created = lead.json.state.clients.find(item => item.id === lead.json.clientId);
    assert.equal(created.inLeadBase, false);
    assert.ok(created.stageId);
    assert.equal(created.ownerId, 'sales');
    assert.equal(M.has({rolePermissions: set.json.state.rolePermissions}, {id: 'pm', role: 'pm'}, 'tasks.assign'), true);
  } finally {
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
