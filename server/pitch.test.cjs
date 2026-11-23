const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {start} = require('./app.cjs');
const {suggestDeck, moneyList} = require('./pitch.cjs');

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
        resolve({status: res.statusCode, json, buf, cookie: Array.isArray(setCookie) ? setCookie[0] : (setCookie || '')});
      });
    });
    req.on('error', reject);
    req.end(data || undefined);
  });
}

function listenMail() {
  const messages = [];
  const server = net.createServer(socket => {
    let buffer = '', mode = 'command', body = '';
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

const deck = {
  title: 'Презентация · Альфа',
  slides: [
    {title: 'Задача', body: 'Убрать ручные таблицы в учебном центре'},
    {title: 'Решение', body: 'Портал, запуск потока и отчёты'},
    {title: 'Следующий шаг', body: 'Согласовать вариант и счёт'},
  ],
};

test('presentation and payments stay on the owner deal', async () => {
  assert.equal(suggestDeck().ready, false);
  assert.deepEqual(moneyList({payments: [{kind: 'invoice', amount: 100000}, {kind: 'payment', amount: 40000}]}), {invoiced: 100000, paid: 40000, left: 60000});
  const mail = await listenMail();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-pitch-'));
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
    const before = await request(app.port, 'GET', '/api/workspace', {cookie: elena});
    const olga = before.json.state.clients.find(client => client.id === '5');
    assert.equal(olga.payments, undefined);
    assert.equal(olga.decks, undefined);
    assert.equal((await request(app.port, 'PUT', '/api/pitch/template', {cookie: elena, body: {title: 'Нет', intro: 'Нет', footer: 'Нет'}})).status, 403);
    assert.equal((await request(app.port, 'PUT', '/api/pitch/template', {cookie: admin, body: {title: 'Презентация', intro: 'Коротко о студии', footer: 'АктивПрофи'}})).status, 200);
    assert.equal((await request(app.port, 'POST', '/api/pitch/documents', {cookie: oleg, body: {clientId: '1', deck}})).status, 403);
    const saved = await request(app.port, 'POST', '/api/pitch/documents', {cookie: elena, body: {clientId: '1', deck}});
    assert.equal(saved.status, 200, JSON.stringify(saved.json.error || saved.json));
    const anna = saved.json.state.clients.find(client => client.id === '1');
    assert.equal(anna.decks[0].version, 1);
    assert.equal(anna.stage, before.json.state.clients.find(client => client.id === '1').stage);
    const file = await request(app.port, 'GET', '/api/pitch/files/' + anna.decks[0].fileId, {cookie: elena});
    assert.equal(file.buf.slice(0, 5).toString(), '%PDF-');
    assert.equal((await request(app.port, 'GET', '/api/pitch/files/' + anna.decks[0].fileId, {cookie: oleg})).status, 403);
    const sent = await request(app.port, 'POST', '/api/pitch/send', {cookie: elena, body: {clientId: '1', deckId: anna.decks[0].id, to: 'anna@example.test', confirmTo: 'anna@example.test', subject: 'Презентация', text: 'Смотрите слайды'}});
    assert.equal(sent.status, 200, JSON.stringify(sent.json));
    assert.match(sent.json.state.clients.find(client => client.id === '1').notes[0], /Отправлена презентация v1/);
    assert.match(mail.messages.join('\n'), /Deck-v1\.pdf/);
    const invoice = await request(app.port, 'POST', '/api/payments/invoice', {cookie: elena, body: {clientId: '1', amount: 439000, note: 'Вариант Оптимальный'}});
    assert.equal(invoice.status, 200, JSON.stringify(invoice.json));
    assert.equal(invoice.json.totals.left, 439000);
    const paid = await request(app.port, 'POST', '/api/payments', {cookie: elena, body: {clientId: '1', amount: 200000, note: 'Предоплата'}});
    assert.equal(paid.json.totals.paid, 200000);
    assert.equal(paid.json.totals.left, 239000);
    assert.equal((await request(app.port, 'POST', '/api/payments', {cookie: oleg, body: {clientId: '1', amount: 1, note: 'чужое'}})).status, 403);
    const untouched = (await request(app.port, 'GET', '/api/workspace', {cookie: elena})).json.state.clients.find(client => client.id === '5');
    assert.equal(untouched.amount, olga.amount);
    assert.equal(untouched.payments, undefined);
  } finally {
    await app.close();
    mail.server.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
