const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {start} = require('./app.cjs');
const M = require('../variant-b/model.js');
const notify = require('./notify.cjs');

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

function titles(list) {
  return (list?.items || []).map(item => item.title);
}

test('completion is the same for everyone and money splits by stage', () => {
  const state = {
    users: [{id: 'admin', role: 'admin', name: 'Ксения'}, {id: 'anna', role: 'developer', name: 'Анна'}, {id: 'lead', role: 'leader', name: 'Мария', active: true}, {id: 'pm', role: 'pm', name: 'Дмитрий', active: true}],
    pipelines: [{id: 'in', stages: [{id: 'open', kind: 'open'}, {id: 'won', kind: 'won'}, {id: 'lost', kind: 'lost'}]}],
    projects: [{id: 'p', leaderId: 'lead', pmId: '', members: ['anna', 'lead'], title: 'Сайт'}],
    tasks: [
      {id: 't1', projectId: 'p', status: 'Готово', assigneeId: 'anna'},
      {id: 't2', projectId: 'p', status: 'В работе', assigneeId: 'lead'},
    ],
    clients: [
      {id: 'a', ownerId: 'sales', inLeadBase: false, pipelineId: 'in', stageId: 'open', amount: 100, createdAt: '2026-11-02'},
      {id: 'b', ownerId: 'sales', inLeadBase: false, pipelineId: 'in', stageId: 'won', amount: 40, createdAt: '2026-11-03'},
      {id: 'c', ownerId: '', inLeadBase: false, pipelineId: 'in', stageId: 'open', amount: 10, createdAt: '2026-11-25', source: 'Исток'},
      {id: 'd', ownerId: 'sales', inLeadBase: false, pipelineId: 'in', stageId: 'lost', amount: 7, createdAt: '2026-11-01'},
    ],
    desk: {},
  };
  const admin = state.users[0];
  const anna = state.users[1];
  assert.equal(M.progress(state, admin, 'p'), 50);
  assert.equal(M.progress(state, anna, 'p'), 50);
  assert.deepEqual(M.ownTaskShare(state, anna, 'p'), {done: 1, total: 1});
  assert.deepEqual(M.ownTaskShare(state, admin, 'p'), {done: 0, total: 0});
  const report = M.report(state, admin);
  assert.equal(report.openTotal, 110);
  assert.equal(report.wonTotal, 40);
  assert.equal(report.lostTotal, 7);
  const snap = M.salesSnapshot(state, admin, {today: '2026-11-27', missed: [{name: 'Анна', phone: '1'}]});
  assert.equal(snap.waiting.length, 1);
  assert.equal(snap.istok.length, 1);
  assert.equal(snap.month.openTotal, 110);
  assert.equal(snap.missed.length, 1);
  const bare = notify.plan({projects: [], tasks: [], clients: [], users: state.users, desk: {}}, state, 'sales');
  assert.ok(bare.some(item => item.kind === 'project-bare' && item.userId === 'pm'));
});

test('bell, reviewer, time, balance, mailing preview and telegram link', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-audit2-'));
  const app = await start({
    host: '127.0.0.1', port: 0, databasePath: path.join(dir, 'crm.sqlite'),
    seedDemo: true, seedPassword: 'demo-pass-1', adminLogin: 'admin', adminPassword: 'admin-pass-1', adminName: 'Ксения',
    sessionDays: 2, cookieSecure: false, telegramMock: true, telegramPoll: false, telegramBotToken: '',
    sipuniUser: '012345', sipuniSecret: 'test-secret', sipuniWebhookToken: 'hook-test-key', sipuniMock: true, sipuniSync: false,
  });
  try {
    const admin = await login(app.port, 'admin', 'admin-pass-1');
    const anna = await login(app.port, 'anna', 'demo-pass-1');
    const elena = await login(app.port, 'elena', 'demo-pass-1');
    const adminView = await request(app.port, 'GET', '/api/workspace', {cookie: admin});
    const annaView = await request(app.port, 'GET', '/api/workspace', {cookie: anna});
    const adminProject = adminView.json.state.projects.find(item => item.id === '1');
    const annaProject = annaView.json.state.projects.find(item => item.id === '1');
    assert.equal(adminProject.completion, annaProject.completion);
    assert.ok(annaProject.myTasks.total > 0);
    assert.ok(annaProject.myTasks.total < adminView.json.state.tasks.filter(task => task.projectId === '1').length);

    const created = await request(app.port, 'POST', '/api/records', {cookie: admin, body: {items: [{kind: 'task', id: 'task-bell', rev: 0, data: {projectId: '1', title: 'Проверить макет', due: '2026-12-01', start: '2026-11-27', estimate: 8, remaining: 8, type: 'work', assigneeId: 'anna', reviewerId: 'lead'}}]}});
    assert.equal(created.status, 200, JSON.stringify(created.json));
    const annaNotes = await request(app.port, 'GET', '/api/notifications', {cookie: anna});
    assert.ok(titles(annaNotes.json).includes('Новая задача'));
    const task = created.json.state.tasks.find(item => item.id === 'task-bell');
    const review = await request(app.port, 'POST', '/api/records', {cookie: admin, body: {items: [{kind: 'task', id: 'task-bell', rev: task.recordRev, data: {...task, status: 'На проверке'}}]}});
    assert.equal(review.status, 200, JSON.stringify(review.json));
    const maria = await login(app.port, 'maria', 'demo-pass-1');
    const reviewNotes = await request(app.port, 'GET', '/api/notifications', {cookie: maria});
    assert.ok(titles(reviewNotes.json).includes('Задача на проверке'));
    const reviewed = review.json.state.tasks.find(item => item.id === 'task-bell');
    const back = await request(app.port, 'POST', '/api/records', {cookie: maria, body: {items: [{kind: 'task', id: 'task-bell', rev: reviewed.recordRev, data: {...reviewed, status: 'В работе'}}]}});
    assert.equal(back.status, 200, JSON.stringify(back.json));
    const rework = await request(app.port, 'GET', '/api/notifications', {cookie: anna});
    assert.ok(titles(rework.json).includes('Задачу вернули на доработку'));

    const lead = await request(app.port, 'POST', '/api/clients', {cookie: admin, body: {name: 'Лид Елене', phone: '+79995550111', email: 'lead-elena@example.test', ownerId: 'sales', pipelineId: 'inbound', stageId: 'stage-0', amount: 1000, source: 'Исток'}});
    assert.equal(lead.status, 201, JSON.stringify(lead.json));
    const elenaNotes = await request(app.port, 'GET', '/api/notifications', {cookie: elena});
    assert.ok(titles(elenaNotes.json).includes('Вам назначен лид'));

    const desk = structuredClone((await request(app.port, 'GET', '/api/workspace', {cookie: admin})).json);
    desk.state.desk = {dutyUserId: 'sales', defaultLeaderId: '', defaultPmId: '', hourRate: 2000};
    const savedDesk = await request(app.port, 'PUT', '/api/workspace', {cookie: admin, body: {revision: desk.revision, state: desk.state}});
    assert.equal(savedDesk.status, 200, JSON.stringify(savedDesk.json));
    const open = savedDesk.json.state.pipelines.find(item => item.id === 'inbound').stages.find(stage => stage.kind === 'open');
    const won = savedDesk.json.state.pipelines.find(item => item.id === 'inbound').stages.find(stage => stage.kind === 'won');
    const bareClient = await request(app.port, 'POST', '/api/clients', {cookie: admin, body: {name: 'Без команды 2', phone: '+79995550112', email: 'bare2@example.test', ownerId: 'sales', pipelineId: 'inbound', stageId: open.id, amount: 500}});
    const bareWon = await request(app.port, 'PATCH', '/api/clients/' + bareClient.json.id, {cookie: elena, body: {stageId: won.id, inLeadBase: false, handover: {sold: 'Сайт', amount: 500, due: '', contacts: '', kp: '', kpLink: '', files: []}}});
    assert.equal(bareWon.status, 200, JSON.stringify(bareWon.json));
    const mariaNotes = await request(app.port, 'GET', '/api/notifications', {cookie: maria});
    const dmitry = await login(app.port, 'dmitry', 'demo-pass-1');
    const dmitryNotes = await request(app.port, 'GET', '/api/notifications', {cookie: dmitry});
    assert.ok(titles(mariaNotes.json).includes('Новый проект без команды') || titles(dmitryNotes.json).includes('Новый проект без команды'));

    const missed = await request(app.port, 'POST', '/api/sipuni/event', {raw: 'event=2&call_id=miss-1&src_num=79990000001&src_type=1&dst_num=012345201&dst_type=2&status=NOANSWER&token=hook-test-key', headers: {'Content-Type': 'application/x-www-form-urlencoded'}});
    assert.equal(missed.status, 200, String(missed.buf));
    const afterCall = await request(app.port, 'GET', '/api/notifications', {cookie: elena});
    assert.ok(titles(afterCall.json).includes('Пропущенный звонок'));

    const link = await request(app.port, 'POST', '/api/notifications/telegram', {cookie: anna, body: {}});
    assert.equal(link.status, 200, JSON.stringify(link.json));
    assert.equal(link.json.bellOnly, false);
    assert.ok(link.json.code);
    app.telegram.applyUpdate({update_id: 50, message: {message_id: 50, date: 1, chat: {id: 900, type: 'private'}, text: '/start ' + link.json.code}});
    const logged = await request(app.port, 'POST', '/api/tasks/time', {cookie: anna, body: {taskId: 'task-bell', hours: 2.5, date: '2026-11-27', comment: 'Макет'}});
    assert.equal(logged.status, 200, JSON.stringify(logged.json));
    const stored = logged.json.state.tasks.find(item => item.id === 'task-bell');
    assert.equal(M.loggedHours(stored), 2.5);
    const again = await request(app.port, 'POST', '/api/records', {cookie: admin, body: {items: [{kind: 'task', id: 'task-bell-2', rev: 0, data: {projectId: '1', title: 'Вторая задача', due: '2026-12-02', start: '2026-11-27', estimate: 4, remaining: 4, type: 'work', assigneeId: 'anna'}}]}});
    assert.equal(again.status, 200, JSON.stringify(again.json));
    const sentAfter = app.telegram.memory.sent.filter(item => String(item.chat_id) === '900');
    assert.ok(sentAfter.some(item => item.text.includes('Готово')));
    assert.ok(sentAfter.some(item => item.text.includes('Вторая задача')));

    const tooBig = await request(app.port, 'POST', '/api/payments/invoice', {cookie: elena, body: {clientId: '4', amount: 90000, note: 'Много'}});
    assert.equal(tooBig.status, 409);
    assert.match(tooBig.json.error, /больше суммы сделки/);
    const invoice = await request(app.port, 'POST', '/api/payments/invoice', {cookie: elena, body: {clientId: '4', amount: 90000, note: 'Много', confirmOver: true}});
    assert.equal(invoice.status, 200, JSON.stringify(invoice.json));
    const paid = await request(app.port, 'POST', '/api/payments', {cookie: elena, body: {clientId: '4', amount: 10000, note: 'Часть'}});
    const card = paid.json.state.clients.find(item => item.id === '4');
    assert.equal(M.clientMoney(card).balance, 45000);

    const kp = {task: 'Сайт', solution: 'Форма', stages: '1. Макет', timeline: 'неделя', choice: 'Старт', variants: [{name: 'Старт', duration: 'неделя', discount: 0, fromPrice: false, lines: [{name: 'Сайт', unit: 'проект', qty: 1, price: 70000}]}]};
    const savedKp = await request(app.port, 'POST', '/api/kp/documents', {cookie: elena, body: {clientId: '4', document: kp}});
    assert.equal(savedKp.status, 200, JSON.stringify(savedKp.json));
    assert.equal(savedKp.json.state.clients.find(item => item.id === '4').amount, 55000);
    assert.equal(savedKp.json.state.clients.find(item => item.id === '4').kpChoice || '', '');

    const preview = await request(app.port, 'POST', '/api/mailing-selections/preview', {cookie: admin, body: {}});
    assert.equal(preview.status, 200, JSON.stringify(preview.json));
    assert.equal(preview.json.people.some(item => item.id === '5'), false);
    const withWon = await request(app.port, 'POST', '/api/mailing-selections/preview', {cookie: admin, body: {includeWon: true}});
    assert.equal(withWon.json.people.some(item => item.id === '5'), true);
    assert.ok(withWon.json.count > preview.json.count);

    const read = await request(app.port, 'POST', '/api/notifications/read', {cookie: anna, body: {all: true}});
    assert.equal(read.json.unread, 0);
  } finally {
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
