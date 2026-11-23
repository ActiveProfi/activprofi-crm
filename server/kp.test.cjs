const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {start} = require('./app.cjs');
const {variantMath, renderPdf, suggestProposal} = require('./kp.cjs');

const browser = {'X-Requested-With': 'ActivProfi'};

function request(port, method, pathname, {body, cookie} = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({hostname: '127.0.0.1', port, path: pathname, method, headers: {'Content-Type': 'application/json', ...browser, ...(cookie ? {Cookie: cookie} : {}), ...(data ? {'Content-Length': data.length} : {})}}, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json; try { json = JSON.parse(buf.toString('utf8')); } catch { json = {raw: buf}; }
        const setCookie = res.headers['set-cookie'];
        resolve({status: res.statusCode, json, cookie: Array.isArray(setCookie) ? setCookie[0] : (setCookie || ''), buf});
      });
    });
    req.on('error', reject);
    req.end(data || undefined);
  });
}

function listenMail() {
  const messages = [];
  const server = net.createServer(socket => {
    let buffer = '';
    let mode = 'command';
    let body = '';
    const reply = line => socket.write(line + '\r\n');
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
        else if (upper === 'DATA') { mode = 'data'; reply('354 go'); }
        else if (upper === 'QUIT') { reply('221 bye'); socket.end(); }
        else reply('250 ok');
      }
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({server, port: server.address().port, messages})));
}

async function login(port, loginName, password) {
  const response = await request(port, 'POST', '/api/auth/login', {body: {login: loginName, password}});
  assert.equal(response.status, 200, JSON.stringify(response.json));
  return response.cookie.split(';')[0];
}

const documentKp = {
  task: 'Сократить ручное обучение',
  solution: 'Портал, запуск и кабинеты',
  stages: '1. Обследование\n2. Портал\n3. Запуск',
  timeline: 'от 2 недель до 3 месяцев',
  kpLink: 'https://kp.example/train',
  choice: 'Оптимальный',
  variants: [
    {name: 'Базовый', duration: '2 недели', discount: 0, fromPrice: false, lines: [{name: 'Обследование и программа запуска', unit: 'проект', qty: 1, price: 126000}, {name: 'Учебный портал', unit: 'проект', qty: 1, price: 99000}]},
    {name: 'Оптимальный', duration: '1–1,5 месяца', discount: 0, fromPrice: true, lines: [{name: 'Базовый контур', unit: 'проект', qty: 1, price: 225000}, {name: 'Запуск и сопровождение', unit: 'проект', qty: 1, price: 214000}]},
    {name: 'Максимум', duration: '2,5–3 месяца', discount: 0, fromPrice: true, lines: [{name: 'Оптимальный контур', unit: 'проект', qty: 1, price: 439000}, {name: 'Кабинеты, отчёты и интеграции', unit: 'проект', qty: 1, price: 625000}]},
  ],
};

test('variant totals match the training-centre bands', () => {
  assert.equal(variantMath(documentKp.variants[0]).total, 225000);
  assert.equal(variantMath(documentKp.variants[1]).total, 439000);
  assert.equal(variantMath(documentKp.variants[2]).total, 1064000);
  assert.equal(suggestProposal().ready, false);
  const pdf = renderPdf({title: 'Коммерческое предложение', intro: 'Вступление', terms: 'Условия', footer: 'АктивПрофи'}, {name: 'Анна', company: 'Альфа'}, documentKp);
  assert.equal(pdf.slice(0, 5).toString(), '%PDF-');
  assert.ok(pdf.length > 100000);
});

test('manager saves and sends only her own КП; admin owns the price list', async () => {
  const mail = await listenMail();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-kp-'));
  const app = await start({
    host: '127.0.0.1', port: 0, databasePath: path.join(dir, 'crm.sqlite'),
    seedDemo: true, seedPassword: 'demo-pass-1', adminLogin: 'admin', adminPassword: 'admin-pass-1', adminName: 'Ксения',
    sessionDays: 2, cookieSecure: false, telegramMock: true, telegramPoll: false, telegramBotToken: '',
    smtp: {host: '127.0.0.1', port: String(mail.port), secure: '0', user: 'crm', pass: 'secret', from: 'crm@studio.test', fromName: 'АктивПрофи'},
  });
  try {
    const elena = await login(app.port, 'elena', 'demo-pass-1');
    const oleg = await login(app.port, 'oleg', 'demo-pass-1');
    const admin = await login(app.port, 'admin', 'admin-pass-1');
    const denied = await request(app.port, 'PUT', '/api/kp/catalogue', {cookie: elena, body: {services: [{name: 'Чужое', price: 1}]}});
    assert.equal(denied.status, 403);
    const priced = await request(app.port, 'PUT', '/api/kp/catalogue', {cookie: admin, body: {services: [{id: 'survey', name: 'Обследование и программа запуска', description: 'План', unit: 'проект', price: 126000, days: 14}]}});
    assert.equal(priced.status, 200, JSON.stringify(priced.json));
    const seen = await request(app.port, 'GET', '/api/kp', {cookie: elena});
    assert.equal(seen.json.catalogue[0].price, 126000);
    const foreign = await request(app.port, 'POST', '/api/kp/documents', {cookie: oleg, body: {clientId: '1', document: documentKp}});
    assert.equal(foreign.status, 403);
    const saved = await request(app.port, 'POST', '/api/kp/documents', {cookie: elena, body: {clientId: '1', document: documentKp}});
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    const anna = saved.json.state.clients.find(client => client.id === '1');
    assert.equal(anna.proposals.length, 1);
    assert.equal(anna.proposals[0].version, 1);
    assert.equal(anna.kpChoice, 'Оптимальный');
    assert.equal(anna.amount, 439000);
    assert.match(anna.kpVariants, /Оптимальный/);
    const file = await request(app.port, 'GET', '/api/kp/files/' + anna.proposals[0].fileId, {cookie: elena});
    assert.equal(file.status, 200);
    assert.equal(file.buf.slice(0, 5).toString(), '%PDF-');
    const hidden = await request(app.port, 'GET', '/api/kp/files/' + anna.proposals[0].fileId, {cookie: oleg});
    assert.equal(hidden.status, 403);
    const sent = await request(app.port, 'POST', '/api/kp/send', {cookie: elena, body: {clientId: '1', proposalId: anna.proposals[0].id, to: 'anna@example.test', confirmTo: 'anna@example.test', subject: 'КП', text: 'Направляем варианты'}});
    assert.equal(sent.status, 200, JSON.stringify(sent.json));
    assert.equal(sent.json.stage, 'Отправлено КП');
    const after = sent.json.state.clients.find(client => client.id === '1');
    assert.equal(after.stage, 'Отправлено КП');
    assert.match(after.stageHistory.at(-1).reason, /Отправлено КП v1/);
    assert.match(mail.messages.join('\n'), /KP-v1\.pdf/);
    const again = await request(app.port, 'POST', '/api/kp/documents', {cookie: elena, body: {clientId: '1', document: documentKp}});
    assert.equal(again.json.state.clients.find(client => client.id === '1').proposals.at(-1).version, 2);
  } finally {
    await app.close();
    mail.server.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
