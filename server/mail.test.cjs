const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {openDatabase, migrate} = require('./db.cjs');
const {createAdmin} = require('./bootstrap.cjs');
const store = require('./store.cjs');
const {hashPassword} = require('./passwords.cjs');
const {start} = require('./app.cjs');
const {createSmtp, mailSettings} = require('./mail.cjs');

function listen() {
  const messages = [];
  const server = net.createServer(socket => {
    let buffer = '';
    let mode = 'command';
    let body = '';
    const reply = (line) => socket.write(line + '\r\n');
    reply('220 fake ready');
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);
        if (mode === 'data') {
          if (line === '.') { messages.push(body); body = ''; mode = 'command'; reply('250 queued'); }
          else body += line + '\n';
          continue;
        }
        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) reply('250 AUTH LOGIN');
        else if (upper.startsWith('AUTH LOGIN')) reply('334 VXNlcm5hbWU6');
        else if (line === Buffer.from('crm').toString('base64')) reply('334 UGFzc3dvcmQ6');
        else if (line === Buffer.from('secret').toString('base64')) reply('235 ok');
        else if (upper.startsWith('MAIL FROM')) reply('250 ok');
        else if (upper.startsWith('RCPT TO')) reply('250 ok');
        else if (upper === 'DATA') { mode = 'data'; reply('354 go'); }
        else if (upper === 'QUIT') { reply('221 bye'); socket.end(); }
        else reply('250 ok');
      }
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({server, port: server.address().port, messages})));
}

test('SMTP delivery reaches a local server and rejects a missing setup', async () => {
  assert.equal(mailSettings({}).configured, false);
  const mailer = createSmtp({settings: mailSettings({})});
  await assert.rejects(() => mailer.send({to: 'a@b.c', subject: 'x', text: 'y'}), /Почта не подключена/);
  const fake = await listen();
  try {
    const live = createSmtp({settings: mailSettings({SMTP_HOST: '127.0.0.1', SMTP_PORT: String(fake.port), SMTP_SECURE: '0', SMTP_USER: 'crm', SMTP_PASS: 'secret', SMTP_FROM: 'crm@studio.test', SMTP_FROM_NAME: 'Студия'})});
    await live.send({to: 'anna@example.test', subject: 'Счёт', text: 'Здравствуйте', attachments: [{name: 'kp.txt', mime: 'text/plain', bytes: Buffer.from('КП')}]});
    const raw = fake.messages.join('\n');
    assert.match(raw, /0JfQtNGA0LDQstGB0YLQstGD0LnRgtC1/);
    assert.match(raw, /0JrQnw==/);
  } finally {
    fake.server.close();
  }
});

function baseDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-mail-'));
  const databasePath = path.join(dir, 'crm.sqlite');
  const db = openDatabase(databasePath);
  migrate(db);
  createAdmin(db, {adminLogin: 'admin', adminPassword: 'admin-pass-1', adminName: 'Админ'});
  const state = store.load(db);
  state.users.push({id: 'sales', name: 'Елена', role: 'sales', active: true, login: 'elena'});
  state.users.push({id: 'sales2', name: 'Олег', role: 'sales', active: true, login: 'oleg'});
  state.projects.push({id: 'studio', title: 'Студия', client: 'Альфа', description: '', type: 'crm', status: 'Проектирование', leaderId: 'admin', pmId: '', members: ['admin', 'sales'], start: '2026-11-01', due: '2026-12-01', budget: 0, next: '', recipients: [{id: 'r1', name: 'Офис', email: 'office@example.test'}], board: {notes: [], links: [], comments: []}, mockup: {name: '', data: ''}, devStage: 'dev-start'});
  state.clients.push({id: 'anna', name: 'Анна', company: 'Альфа', phone: '+79990000001', email: 'anna@example.test', ownerId: 'sales', project: 'studio', pipelineId: state.pipelines[0].id, stageId: state.pipelines[0].stages[0].id, amount: 1000, kpLink: 'https://kp.example/1', notes: [], inLeadBase: false});
  state.clients.push({id: 'olga', name: 'Ольга', company: 'Вектор', phone: '+79990000002', email: 'olga@example.test', ownerId: 'sales2', project: '', pipelineId: state.pipelines[0].id, stageId: state.pipelines[0].stages[0].id, amount: 1000, notes: [], inLeadBase: false});
  state.materials.push({id: 'file1', projectId: 'studio', name: 'kp.txt', mime: 'text/plain', data: 'data:text/plain;base64,' + Buffer.from('Коммерческое предложение').toString('base64'), createdBy: 'admin', createdAt: '2026-11-01'});
  store.save(db, state, {passwords: {sales: hashPassword('elena-pass-1'), sales2: hashPassword('oleg-pass-1')}});
  db.close();
  return {dir, databasePath};
}

function request(port, method, pathname, {body, cookie} = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({hostname: '127.0.0.1', port, path: pathname, method, headers: {'Content-Type': 'application/json', 'X-Requested-With': 'ActivProfi', ...(cookie ? {Cookie: cookie} : {}), ...(data ? {'Content-Length': data.length} : {})}}, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json; try { json = JSON.parse(text); } catch { json = {raw: text}; }
        resolve({status: res.statusCode, json, cookie: res.headers['set-cookie']});
      });
    });
    req.on('error', reject);
    req.end(data || undefined);
  });
}

test('manager sends mail and telegram only for her own client', async () => {
  const fake = await listen();
  const {dir, databasePath} = baseDb();
  const smtp = {host: '127.0.0.1', port: String(fake.port), secure: '0', user: 'crm', pass: 'secret', from: 'crm@studio.test', fromName: 'Студия'};
  const app = await start({host: '127.0.0.1', port: 0, databasePath, seedDemo: false, adminLogin: 'admin', adminPassword: 'admin-pass-1', adminName: 'Админ', sessionDays: 2, cookieSecure: false, telegramMock: true, telegramPoll: false, telegramBotToken: '', smtp});
  try {
    app.telegram.seedDemo();
    const adminLogin = await request(app.port, 'POST', '/api/auth/login', {body: {login: 'admin', password: 'admin-pass-1'}});
    const admin = adminLogin.cookie[0].split(';')[0];
    const overview = await request(app.port, 'GET', '/api/telegram', {cookie: admin});
    const project = overview.json.chats.find(chat => chat.title.includes('Студия'));
    assert.equal((await request(app.port, 'POST', '/api/telegram/link', {cookie: admin, body: {chatId: project.chatId, scope: 'project', projectId: 'studio'}})).status, 200);
    const tested = await request(app.port, 'POST', '/api/mail/test', {cookie: admin, body: {to: 'admin@studio.test'}});
    assert.equal(tested.status, 200, JSON.stringify(tested.json));
    const elenaLogin = await request(app.port, 'POST', '/api/auth/login', {body: {login: 'elena', password: 'elena-pass-1'}});
    const elena = elenaLogin.cookie[0].split(';')[0];
    const status = await request(app.port, 'GET', '/api/mail', {cookie: elena});
    assert.equal(status.json.configured, true);
    const denied = await request(app.port, 'POST', '/api/mail/send', {cookie: elena, body: {clientId: 'olga', to: 'olga@example.test', confirmTo: 'olga@example.test', subject: 'Чужое', text: 'нет'}});
    assert.equal(denied.status, 403);
    const sent = await request(app.port, 'POST', '/api/mail/send', {cookie: elena, body: {clientId: 'anna', to: 'anna@example.test', confirmTo: 'anna@example.test', subject: 'КП', text: 'Смотрите предложение', materialId: 'file1', includeKpLink: true}});
    assert.equal(sent.status, 200, JSON.stringify(sent.json));
    assert.equal(sent.json.delivery.status, 'sent');
    assert.match(sent.json.state.clients.find(item => item.id === 'anna').notes[0], /Отправлено \(почта\)/);
    assert.equal(sent.json.state.externalMessages.some(item => item.status === 'sent' && item.text.includes('Смотрите предложение')), true);
    const raw = fake.messages.join('\n');
    assert.match(raw, /filename="kp.txt"/);
    assert.match(raw, /LmV4YW1wbGUvMQ/);
    const telegram = await request(app.port, 'POST', '/api/telegram/client-send', {cookie: elena, body: {clientId: 'anna', text: 'Написали в группу', confirmTo: 'группа проекта «Студия»'}});
    assert.equal(telegram.status, 200, JSON.stringify(telegram.json));
    assert.equal(app.telegram.memory.sent.at(-1).text.includes('Елена:'), true);
    const missing = await request(app.port, 'POST', '/api/telegram/client-send', {cookie: elena, body: {clientId: 'olga', text: 'нет', confirmTo: 'нет'}});
    assert.equal(missing.status, 403);
  } finally {
    await app.close();
    fake.server.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
