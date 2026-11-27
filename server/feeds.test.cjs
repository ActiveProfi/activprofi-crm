const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {start} = require('./app.cjs');
const M = require('../variant-b/model.js');
const Feed = require('../variant-b/feed-model.js');
const Guide = require('../variant-b/guide.js');

function request(port, method, pathname, {body, cookie} = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({hostname: '127.0.0.1', port, path: pathname, method, headers: {'Content-Type': 'application/json', 'X-Requested-With': 'ActivProfi', ...(cookie ? {Cookie: cookie} : {}), ...(data ? {'Content-Length': data.length} : {})}}, res => {
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

test('old notes, mail, telegram and calls stay in the client feed; team chat stays on the project', () => {
  const state = {
    conversations: [{id: 'chat', clientId: '1', channel: 'telegram'}],
    externalMessages: [{id: 'tg1', conversationId: 'chat', text: 'Напишите в Telegram', at: '2026-11-02T10:00:00', status: 'sent'}],
    outbox: [{id: 'mail1', to: 'anna@example.test', subject: 'Счёт', createdAt: '2026-11-03'}],
    communications: [{id: 'call1', entityType: 'client', entityId: '1', title: 'Созвон', createdAt: '2026-11-01'}],
    messages: [{id: 'team1', projectId: 'p', text: 'Макет готов', at: '2026-11-04', from: 'pm', to: ''}],
  };
  const client = {id: '1', email: 'anna@example.test', notes: ['2026-11-05 итог звонка']};
  const feed = Feed.clientFeed(state, client);
  assert.ok(feed.some(item => item.kind === 'note' && item.text.includes('итог')));
  assert.ok(feed.some(item => item.kind === 'mail' && item.text === 'Счёт'));
  assert.ok(feed.some(item => item.kind === 'telegram' && item.text.includes('Telegram')));
  assert.ok(feed.some(item => item.kind === 'call' && item.text === 'Созвон'));
  assert.equal(feed.some(item => item.text === 'Макет готов'), false);
  assert.equal(Feed.projectFeed(state, 'p')[0].text, 'Макет готов');
  assert.equal(state.externalMessages.length, 1);
  assert.equal(client.notes.length, 1);
});

test('a sales task without a project is remembered and notified; a support note becomes a project task', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-feed-'));
  const app = await start({host: '127.0.0.1', port: 0, databasePath: path.join(dir, 'crm.sqlite'), seedDemo: true, seedPassword: 'demo-pass-1', adminLogin: 'admin', adminPassword: 'admin-pass-1', adminName: 'Ксения', sessionDays: 2, cookieSecure: false, telegramPoll: false, sipuniSync: false});
  try {
    const login = await request(app.port, 'POST', '/api/auth/login', {body: {login: 'elena', password: 'demo-pass-1'}});
    const elena = login.cookie[0].split(';')[0];
    const saved = await request(app.port, 'POST', '/api/records', {cookie: elena, body: {items: [{kind: 'task', id: 'sale-1', rev: 0, data: {clientId: '1', projectId: '', title: 'Перезвонить Анне', due: '2026-11-27', kind: 'todo'}}]}});
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    const task = saved.json.state.tasks.find(item => item.id === 'sale-1');
    assert.ok(task, (saved.json.state.tasks || []).map(item => item.id + ':' + item.title).join(','));
    assert.equal(task.projectId, '');
    assert.equal(task.clientId, '1');
    const notes = await request(app.port, 'GET', '/api/notifications', {cookie: elena});
    assert.ok(notes.json.items.some(item => item.title === 'Новое дело' && item.body === 'Перезвонить Анне'));
    const queue = Guide.contactQueue([{id: '1', name: 'Анна', next: task.title, when: task.due, kind: 'open', owned: true, inLeadBase: false}], '2026-11-27');
    assert.equal(queue[0].label, 'Сегодня');
    const support = await request(app.port, 'POST', '/api/records', {cookie: elena, body: {items: [{kind: 'task', id: 'sup-1', rev: 0, data: {support: true, clientId: '1', text: 'Не открывается форма', due: '2026-11-27', sourceId: 'tg1'}}]}});
    assert.equal(support.status, 200, JSON.stringify(support.json));
    const made = support.json.state.tasks.find(item => item.id === 'sup-1');
    assert.equal(made.projectId, '1');
    assert.match(made.title, /Не открывается форма/);
    assert.equal(made.support, true);
    const bare = await request(app.port, 'POST', '/api/records', {cookie: elena, body: {items: [{kind: 'task', id: 'sup-2', rev: 0, data: {support: true, clientId: '4', text: 'Помогите', due: '2026-11-27'}}]}});
    assert.equal(bare.status, 400);
    const again = await request(app.port, 'GET', '/api/workspace', {cookie: elena});
    assert.ok(again.json.state.tasks.some(item => item.id === 'sale-1'));
    assert.ok(again.json.state.clients.find(item => item.id === '1'));
  } finally {
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
