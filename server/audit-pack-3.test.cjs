const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {start} = require('./app.cjs');
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

async function login(port, name, password) {
  const response = await request(port, 'POST', '/api/auth/login', {body: {login: name, password}});
  assert.equal(response.status, 200, JSON.stringify(response.json));
  return response.cookie[0].split(';')[0];
}

test('old roles and stage names are tidied without dropping people', () => {
  const state = {
    users: [
      {id: 'lead', name: 'Мария', role: 'leader', permissionOverrides: {finance: false}},
      {id: 'intern', name: 'Никита', role: 'sales_intern', probation: false},
      {id: 'pm', name: 'Дмитрий', role: 'pm'},
    ],
    pipelines: [{id: 'outbound', stages: [{id: 'out-2', name: 'Первый контакт', kind: 'open'}, {id: 'out-3', name: 'Согласование', kind: 'open'}, {id: 'out-4', name: 'В проекте', kind: 'won'}]}],
    clients: [{id: 'c', stageId: 'out-2', stage: 'Первый контакт', pipelineId: 'outbound'}],
    projects: [{id: 'p', status: 'Разработка', devStage: 'dev-start', leaderId: 'lead', members: ['lead']}],
    rolePermissions: {},
  };
  M.tidyWorkspace(state);
  assert.equal(state.users.find(user => user.id === 'lead').role, 'pm');
  assert.equal(state.users.find(user => user.id === 'lead').permissionOverrides['finance.view'], true);
  assert.equal(state.users.find(user => user.id === 'intern').role, 'sales');
  assert.equal(state.users.find(user => user.id === 'intern').probation, true);
  assert.equal(state.users.find(user => user.id === 'pm').role, 'pm');
  assert.equal(state.pipelines[0].stages.find(stage => stage.id === 'out-2').name, 'Контакт');
  assert.equal(state.clients[0].stage, 'Контакт');
  assert.equal(state.clients[0].stageId, 'out-2');
  assert.ok(state.pipelines[0].stages.some(stage => stage.name === 'Сдан' && stage.kind === 'done'));
  assert.equal(state.projects[0].status, undefined);
  assert.equal(state.projects[0].devStage, 'dev-start');
  assert.equal(M.tidyWorkspace(state), false);
});

test('demo people, novice limits, handed stage and one project stage survive a reload', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-tidy-'));
  const app = await start({host: '127.0.0.1', port: 0, databasePath: path.join(dir, 'crm.sqlite'), seedDemo: true, seedPassword: 'demo-pass-1', adminLogin: 'admin', adminPassword: 'admin-pass-1', adminName: 'Ксения', sessionDays: 2, cookieSecure: false, telegramPoll: false, sipuniSync: false, sipuniWebhookToken: 'hook-test-key', sipuniMock: true});
  try {
    const admin = await login(app.port, 'admin', 'admin-pass-1');
    const ws = await request(app.port, 'GET', '/api/workspace', {cookie: admin});
    const maria = ws.json.state.users.find(user => user.login === 'maria');
    const nikita = ws.json.state.users.find(user => user.login === 'nikita');
    assert.equal(maria.role, 'pm');
    assert.equal(nikita.role, 'sales');
    assert.equal(nikita.probation, true);
    assert.equal(M.roles.sales_intern, undefined);
    assert.equal(M.roles.pm, 'Проджект');
    assert.equal(M.roles.dev_head, 'Руководитель разработки');
    const outbound = ws.json.state.pipelines.find(pipe => pipe.id === 'outbound');
    assert.ok(outbound.stages.some(stage => stage.name === 'Контакт'));
    assert.equal(outbound.stages.some(stage => stage.name === 'Первый контакт'), false);
    assert.ok(outbound.stages.some(stage => stage.name === 'Сдан'));
    assert.equal(ws.json.state.projects.every(project => project.status == null), true);
    const nina = await login(app.port, 'nikita', 'demo-pass-1');
    const mailing = await request(app.port, 'POST', '/api/mailing-selections/preview', {cookie: nina, body: {}});
    assert.equal(mailing.status, 403);
    const unknown = await request(app.port, 'POST', '/api/sipuni/event', {raw: 'event=2&call_id=tidy-unk&src_num=79990007721&src_type=1&dst_num=012345999&dst_type=2&status=NOANSWER&token=hook-test-key', headers: {'Content-Type': 'application/x-www-form-urlencoded'}});
    assert.equal(unknown.status, 200, String(unknown.buf));
    const hidden = await request(app.port, 'GET', '/api/sipuni', {cookie: nina});
    assert.equal(hidden.json.unknown.length, 0);
    const again = await request(app.port, 'GET', '/api/workspace', {cookie: admin});
    assert.equal(again.json.state.users.find(user => user.login === 'maria').id, maria.id);
    assert.equal(again.json.state.clients.length, ws.json.state.clients.length);
  } finally {
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
