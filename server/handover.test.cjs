const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {start} = require('./app.cjs');

const browser = {'X-Requested-With': 'ActivProfi'};

function request(port, method, pathname, {body, cookie} = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname, method,
      headers: {'Content-Type': 'application/json', ...browser, ...(cookie ? {Cookie: cookie} : {}), ...(data ? {'Content-Length': data.length} : {})},
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json; try { json = JSON.parse(text); } catch { json = {raw: text}; }
        const setCookie = res.headers['set-cookie'];
        resolve({status: res.statusCode, json, cookie: Array.isArray(setCookie) ? setCookie[0] : (setCookie || '')});
      });
    });
    req.on('error', reject);
    req.end(data || undefined);
  });
}

async function login(port, loginName, password) {
  const response = await request(port, 'POST', '/api/auth/login', {body: {login: loginName, password}});
  assert.equal(response.status, 200, JSON.stringify(response.json));
  return response.cookie.split(';')[0];
}

test('won deal carries a brief, the manager can discuss but not move the dev board', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-handover-'));
  const app = await start({
    host: '127.0.0.1', port: 0, databasePath: path.join(dir, 'crm.sqlite'),
    seedDemo: true, seedPassword: 'demo-pass-1', adminLogin: 'admin', adminPassword: 'admin-pass-1', adminName: 'Ксения',
    sessionDays: 2, cookieSecure: false, telegramMock: true, telegramPoll: false, telegramBotToken: '',
  });
  try {
    app.telegram.seedDemo();
    const elena = await login(app.port, 'elena', 'demo-pass-1');
    const admin = await login(app.port, 'admin', 'admin-pass-1');
    const maria = await login(app.port, 'maria', 'demo-pass-1');
    const dmitry = await login(app.port, 'dmitry', 'demo-pass-1');
    const oleg = await login(app.port, 'oleg', 'demo-pass-1');
    const anna = await login(app.port, 'anna', 'demo-pass-1');
    const before = await request(app.port, 'GET', '/api/workspace', {cookie: elena});
    const mikhail = before.json.state.clients.find(client => client.name === 'Михаил Орлов');
    const olga = before.json.state.clients.find(client => client.name === 'Ольга Новикова');
    const existing = before.json.state.projects.find(project => project.id === olga.project);
    assert.equal(existing.pmId, 'pm');
    assert.ok(existing.members.includes('anna'));
    const won = await request(app.port, 'PATCH', '/api/clients/' + mikhail.id, {
      cookie: elena,
      body: {
        stageId: 'stage-4', inLeadBase: false, stage: 'В проекте',
        handover: {sold: 'Автоматизация контента', kp: 'Старт за 55 000', amount: 55000, due: '2026-12-15', contacts: '+7 999 000-00-04\nmikhail@example.test', kpLink: 'https://kp.example/mikhail', files: ['Бриф.txt']},
      },
    });
    assert.equal(won.status, 200, JSON.stringify(won.json));
    const project = won.json.state.projects.find(item => item.sourceClientId === mikhail.id);
    assert.ok(project);
    assert.equal(project.handover.sold, 'Автоматизация контента');
    assert.equal(project.handover.kp, 'Старт за 55 000');
    assert.equal(project.handover.amount, 55000);
    assert.equal(project.handover.files[0], 'Бриф.txt');
    assert.equal(project.pmId, '');
    assert.equal(project.devStage, 'dev-start');
    assert.ok(project.members.includes('sales'));
    assert.equal((await request(app.port, 'GET', '/api/projects/' + project.id, {cookie: dmitry})).json.project.handover.sold, 'Автоматизация контента');
    assert.equal((await request(app.port, 'GET', '/api/projects/' + project.id, {cookie: anna})).status, 404);
    const blocked = await request(app.port, 'PATCH', '/api/projects/' + project.id, {cookie: elena, body: {devStage: 'dev-r1'}});
    assert.equal(blocked.status, 403);
    const kept = (await request(app.port, 'GET', '/api/projects/' + existing.id, {cookie: elena})).json.project;
    assert.equal(kept.title, 'Сервис обработки прайсов');
    assert.equal(kept.pmId, 'pm');

    const draft = (await request(app.port, 'GET', '/api/workspace', {cookie: elena})).json;
    draft.state.messages.push({id: 'handover-msg', projectId: project.id, taskId: '', from: 'sales', to: '', text: 'Передала бриф, жду проджекта', at: '2026-11-23T06:00:00.000Z'});
    const saved = await request(app.port, 'PUT', '/api/workspace', {cookie: elena, body: {revision: draft.revision, state: draft.state}});
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    const pmView = await request(app.port, 'GET', '/api/workspace', {cookie: dmitry});
    assert.ok(pmView.json.state.messages.some(item => item.text === 'Передала бриф, жду проджекта' && item.projectId === project.id));

    assert.equal((await request(app.port, 'POST', '/api/telegram/ask', {cookie: elena, body: {scope: 'assign', projectId: project.id}})).status, 200);
    const adminChat = await request(app.port, 'GET', '/api/telegram', {cookie: admin});
    assert.ok(adminChat.json.requests.some(item => item.scope === 'assign' && item.projectId === project.id && item.userName === 'Елена'));
    const leaderChat = await request(app.port, 'GET', '/api/telegram', {cookie: maria});
    assert.ok(leaderChat.json.requests.some(item => item.scope === 'assign' && item.projectTitle === project.title));
    const other = await request(app.port, 'GET', '/api/telegram', {cookie: oleg});
    assert.equal((other.json.requests || []).length, 0);

    const chat = adminChat.json.chats.find(item => item.title === 'Проект: Студия массажа');
    assert.equal((await request(app.port, 'POST', '/api/telegram/link', {cookie: admin, body: {chatId: chat.chatId, scope: 'project', projectId: project.id}})).status, 200);
    const wrong = await request(app.port, 'POST', '/api/telegram/project-send', {cookie: elena, body: {projectId: project.id, text: 'Бриф в группе', confirmTo: 'не та группа'}});
    assert.equal(wrong.status, 400);
    const sent = await request(app.port, 'POST', '/api/telegram/project-send', {cookie: elena, body: {projectId: project.id, text: 'Бриф в группе', confirmTo: 'группа проекта «' + project.title + '»'}});
    assert.equal(sent.status, 200, JSON.stringify(sent.json));
    assert.match(app.telegram.memory.sent.at(-1).text, /Елена:\nБриф в группе/);
    const badge = await request(app.port, 'GET', '/api/telegram/badge', {cookie: elena});
    assert.ok(badge.json.linkedProjects.includes(project.id));
  } finally {
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
