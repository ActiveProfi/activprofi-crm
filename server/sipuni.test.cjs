const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {openDatabase, migrate} = require('./db.cjs');
const {createAdmin} = require('./bootstrap.cjs');
const store = require('./store.cjs');
const {hashPassword} = require('./passwords.cjs');
const {start} = require('./app.cjs');
const {sign, STATS_ORDER, OFF} = require('./sipuni.cjs');

const browser = {'X-Requested-With': 'ActivProfi'};

function baseDb(extension = '201') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-sipuni-'));
  const databasePath = path.join(dir, 'crm.sqlite');
  const db = openDatabase(databasePath);
  migrate(db);
  createAdmin(db, {adminLogin: 'admin', adminPassword: 'admin-pass-1', adminName: 'Админ'});
  const state = store.load(db);
  state.users.push({id: 'sales', name: 'Елена', role: 'sales', active: true, login: 'elena', sipuniExtension: extension});
  state.users.push({id: 'sales2', name: 'Олег', role: 'sales', active: true, login: 'oleg', sipuniExtension: '202'});
  state.clients.push({id: 'anna', name: 'Анна', company: 'Альфа', phone: '+7 999 000-00-01', email: 'anna@example.test', ownerId: 'sales', project: '', pipelineId: state.pipelines[0].id, stageId: state.pipelines[0].stages[0].id, amount: 1000, notes: ['Старая заметка'], inLeadBase: false});
  state.clients.push({id: 'olga', name: 'Ольга', company: 'Вектор', phone: '+7 999 000-00-02', email: 'olga@example.test', ownerId: 'sales2', project: '', pipelineId: state.pipelines[0].id, stageId: state.pipelines[0].stages[0].id, amount: 1000, notes: [], inLeadBase: false});
  store.save(db, state, {passwords: {sales: hashPassword('elena-pass-1'), sales2: hashPassword('oleg-pass-1')}});
  db.close();
  return databasePath;
}

function request(port, method, pathname, {body, cookie, headers, raw} = {}) {
  return new Promise((resolve, reject) => {
    const data = raw !== undefined ? Buffer.from(raw) : (body === undefined ? null : Buffer.from(JSON.stringify(body)));
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname, method,
      headers: {
        ...(raw !== undefined ? {'Content-Type': 'application/x-www-form-urlencoded'} : {'Content-Type': 'application/json'}),
        ...(headers || {}),
        ...(cookie ? {Cookie: cookie} : {}),
        ...(data ? {'Content-Length': data.length} : {}),
      },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json; try { json = JSON.parse(text); } catch { json = {raw: text}; }
        const setCookie = res.headers['set-cookie'];
        resolve({status: res.statusCode, json, cookie: Array.isArray(setCookie) ? setCookie[0] : setCookie || ''});
      });
    });
    req.on('error', reject);
    req.end(data || undefined);
  });
}

async function login(port, loginName, password) {
  const response = await request(port, 'POST', '/api/auth/login', {headers: browser, body: {login: loginName, password}});
  assert.equal(response.status, 200, JSON.stringify(response.json));
  return response.cookie.split(';')[0];
}

test('callback rings the manager first, and only for her own client', async () => {
  const databasePath = baseDb();
  const app = await start({host: '127.0.0.1', port: 0, databasePath, seedDemo: false, adminLogin: 'admin', adminPassword: 'admin-pass-1', adminName: 'Админ', sessionDays: 2, cookieSecure: false, telegramMock: true, telegramPoll: false, telegramBotToken: '', sipuniUser: '012345', sipuniSecret: 'test-secret', sipuniMock: true, sipuniSync: false});
  try {
    const elena = await login(app.port, 'elena', 'elena-pass-1');
    const oleg = await login(app.port, 'oleg', 'oleg-pass-1');
    const denied = await request(app.port, 'POST', '/api/sipuni/call', {cookie: elena, headers: browser, body: {clientId: 'olga', confirmName: 'Ольга', confirmPhone: '+7 999 000-00-02'}});
    assert.equal(denied.status, 403);
    const called = await request(app.port, 'POST', '/api/sipuni/call', {cookie: elena, headers: browser, body: {clientId: 'anna', confirmName: 'Анна', confirmPhone: '+7 999 000-00-01'}});
    assert.equal(called.status, 200, JSON.stringify(called.json));
    assert.equal(called.json.message, 'Звоним: Анна, +7 999 000-00-01');
    const params = new URLSearchParams(app.sipuni.memory.requests.at(-1).body);
    assert.equal(app.sipuni.memory.requests.at(-1).url, 'https://sipuni.com/api/callback/call_number');
    assert.equal(params.get('phone'), '79990000001');
    assert.equal(params.get('sipnumber'), '201');
    assert.equal(params.get('reverse'), '0');
    assert.equal(params.get('antiaon'), '0');
    assert.equal(params.get('hash'), sign(['0', '79990000001', '0', '201', '012345', 'test-secret']));
    assert.equal(params.get('secret'), null);
    const note = called.json.state.clients.find(item => item.id === 'anna').notes[0];
    assert.match(note, /Звонок · исходящий · заказан/);
    assert.match(called.json.state.clients.find(item => item.id === 'anna').notes[1], /Старая заметка/);
    const hidden = await request(app.port, 'GET', '/api/workspace', {cookie: oleg, headers: browser});
    assert.equal(hidden.json.state.clients.some(item => item.id === 'anna'), false);
  } finally {
    await app.close();
  }
});

test('missing telephony says so, and the admin check does not dial', async () => {
  const databasePath = baseDb('');
  const bare = await start({host: '127.0.0.1', port: 0, databasePath, seedDemo: false, adminLogin: 'admin', adminPassword: 'admin-pass-1', adminName: 'Админ', sessionDays: 2, cookieSecure: false, telegramMock: true, telegramPoll: false, telegramBotToken: '', sipuniSync: false});
  try {
    const elena = await login(bare.port, 'elena', 'elena-pass-1');
    const off = await request(bare.port, 'POST', '/api/sipuni/call', {cookie: elena, headers: browser, body: {clientId: 'anna', confirmName: 'Анна', confirmPhone: '+7 999 000-00-01'}});
    assert.equal(off.status, 400);
    assert.equal(off.json.error, OFF);
    const status = await request(bare.port, 'GET', '/api/sipuni', {cookie: elena, headers: browser});
    assert.equal(status.json.message, OFF);
    const admin = await login(bare.port, 'admin', 'admin-pass-1');
    const probe = await request(bare.port, 'POST', '/api/sipuni/test', {cookie: admin, headers: browser, body: {}});
    assert.equal(probe.status, 400);
    assert.equal(probe.json.error, OFF);
  } finally {
    await bare.close();
  }
  const live = await start({host: '127.0.0.1', port: 0, databasePath, seedDemo: false, adminLogin: 'admin', adminPassword: 'admin-pass-1', adminName: 'Админ', sessionDays: 2, cookieSecure: false, telegramMock: true, telegramPoll: false, telegramBotToken: '', sipuniUser: '012345', sipuniSecret: 'test-secret', sipuniMock: true, sipuniSync: false});
  try {
    const admin = await login(live.port, 'admin', 'admin-pass-1');
    const elena = await login(live.port, 'elena', 'elena-pass-1');
    const probe = await request(live.port, 'POST', '/api/sipuni/test', {cookie: admin, headers: browser, body: {}});
    assert.equal(probe.status, 200, JSON.stringify(probe.json));
    assert.match(probe.json.message, /Телефония отвечает/);
    assert.match(probe.json.message, /звонок клиенту не совершался/);
    assert.equal(live.sipuni.memory.requests.some(item => item.url.includes('callback')), false);
    const forbidden = await request(live.port, 'POST', '/api/sipuni/test', {cookie: elena, headers: browser, body: {}});
    assert.equal(forbidden.status, 403);
    const noLine = await request(live.port, 'POST', '/api/sipuni/call', {cookie: elena, headers: browser, body: {clientId: 'anna', confirmName: 'Анна', confirmPhone: '+7 999 000-00-01'}});
    assert.equal(noLine.status, 400);
    assert.match(noLine.json.error, /внутренний номер Sipuni/);
  } finally {
    await live.close();
  }
});

test('webhook and statistics log the call, show a missed client, and offer an unknown number', async () => {
  const databasePath = baseDb();
  const app = await start({host: '127.0.0.1', port: 0, databasePath, seedDemo: false, adminLogin: 'admin', adminPassword: 'admin-pass-1', adminName: 'Админ', sessionDays: 2, cookieSecure: false, telegramMock: true, telegramPoll: false, telegramBotToken: '', sipuniUser: '012345', sipuniSecret: 'test-secret', sipuniWebhookToken: 'hook-test-key', sipuniMock: true, sipuniSync: false});
  try {
    const locked = await request(app.port, 'POST', '/api/sipuni/event', {raw: 'event=2&call_id=evt-locked&src_num=79990000001&src_type=1&dst_num=012345201&dst_type=2&status=NOANSWER'});
    assert.equal(locked.status, 403);
    const missed = await request(app.port, 'POST', '/api/sipuni/event', {raw: 'event=2&call_id=evt-1&src_num=79990000001&src_type=1&dst_num=012345201&dst_type=2&short_dst_num=201&status=NOANSWER&timestamp=1763892000&token=hook-test-key&call_record_link=' + encodeURIComponent('https://sipuni.com/record/evt-1')});
    assert.equal(missed.status, 200);
    assert.equal(missed.json.success, true);
    const elena = await login(app.port, 'elena', 'elena-pass-1');
    const oleg = await login(app.port, 'oleg', 'oleg-pass-1');
    const feed = await request(app.port, 'GET', '/api/sipuni', {cookie: elena, headers: browser});
    assert.equal(feed.json.missed.length, 1);
    assert.equal(feed.json.missed[0].name, 'Анна');
    assert.equal(feed.json.extension, '201');
    const other = await request(app.port, 'GET', '/api/sipuni', {cookie: oleg, headers: browser});
    assert.equal(other.json.missed.length, 0);
    const card = await request(app.port, 'GET', '/api/workspace', {cookie: elena, headers: browser});
    const note = card.json.state.clients.find(item => item.id === 'anna').notes[0];
    assert.match(note, /Звонок · входящий · не отвечен/);
    assert.match(note, /https:\/\/sipuni\.com\/record\/evt-1/);
    const csv = [
      'Тип;Статус;Время;Откуда;Куда;Длительность разговора, сек;ID записи;Запись существует;ID заказа звонка',
      'Входящий;Не отвечен;23.11.2026 10:00:00;79990000001;201;0;rec.1;1;ord-1',
      'Входящий;Не отвечен;23.11.2026 10:05:00;79001112233;201;15;;0;ord-2',
      'Исходящий;Отвечен;23.11.2026 11:00:00;201;79990000001;80;rec.2;1;ord-3',
    ].join('\n');
    assert.equal(app.sipuni.importCsv(csv).imported, 3);
    const again = await request(app.port, 'GET', '/api/sipuni', {cookie: elena, headers: browser});
    assert.equal(again.json.unknown.length, 1);
    assert.equal(again.json.unknown[0].digits, '79001112233');
    const history = await request(app.port, 'GET', '/api/workspace', {cookie: elena, headers: browser});
    const notes = history.json.state.clients.find(item => item.id === 'anna').notes.join('\n');
    assert.match(notes, /1 мин 20 сек/);
    assert.match(notes, /\/api\/sipuni\/record\?id=rec\.2/);
    const audio = await request(app.port, 'GET', '/api/sipuni/record?id=rec.2', {cookie: elena, headers: browser});
    assert.equal(audio.status, 200);
    assert.match(audio.json.raw || '', /ID3mock/);
    const blocked = await request(app.port, 'GET', '/api/sipuni/record?id=rec.2', {cookie: oleg, headers: browser});
    assert.equal(blocked.status, 403);
    const lead = await request(app.port, 'POST', '/api/sipuni/lead', {cookie: elena, headers: browser, body: {phone: '79001112233', name: 'Новый звонок', confirmPhone: '+7 900 111-22-33'}});
    assert.equal(lead.status, 200, JSON.stringify(lead.json));
    assert.equal(lead.json.state.clients.find(item => item.id === lead.json.clientId).ownerId, 'sales');
    const gone = await request(app.port, 'GET', '/api/sipuni', {cookie: elena, headers: browser});
    assert.equal(gone.json.unknown.length, 0);
    const seen = await request(app.port, 'POST', '/api/sipuni/seen', {cookie: elena, headers: browser, body: {clientId: 'anna'}});
    assert.equal(seen.status, 200);
    const quiet = await request(app.port, 'GET', '/api/sipuni', {cookie: elena, headers: browser});
    assert.equal(quiet.json.missed.filter(item => item.clientId === 'anna').length, 0);
  } finally {
    await app.close();
  }
});

test('statistics request signs fields in the documented order', async () => {
  const databasePath = baseDb();
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push({url: String(url), body: String(options.body || '')});
    return {ok: true, status: 200, headers: {get: () => 'text/csv'}, text: async () => 'Тип;Статус\n', arrayBuffer: async () => Buffer.from('')};
  };
  const app = await start({host: '127.0.0.1', port: 0, databasePath, seedDemo: false, adminLogin: 'admin', adminPassword: 'admin-pass-1', adminName: 'Админ', sessionDays: 2, cookieSecure: false, telegramMock: true, telegramPoll: false, telegramBotToken: '', sipuniUser: '012345', sipuniSecret: 'test-secret', sipuniSync: false, sipuniFetch: fetchImpl});
  try {
    await app.sipuni.pull();
    const params = new URLSearchParams(seen.at(-1).body);
    assert.equal(seen.at(-1).url, 'https://sipuni.com/api/statistic/export');
    assert.equal(params.get('hash'), sign([...STATS_ORDER.map(name => params.get(name)), 'test-secret']));
    assert.equal(params.get('user'), '012345');
    assert.equal(params.get('type'), '0');
  } finally {
    await app.close();
  }
});

test('admin saves the employee Sipuni extension', async () => {
  const databasePath = baseDb('');
  const app = await start({host: '127.0.0.1', port: 0, databasePath, seedDemo: false, adminLogin: 'admin', adminPassword: 'admin-pass-1', adminName: 'Админ', sessionDays: 2, cookieSecure: false, telegramMock: true, telegramPoll: false, telegramBotToken: '', sipuniUser: '012345', sipuniSecret: 'test-secret', sipuniMock: true, sipuniSync: false});
  try {
    const admin = await login(app.port, 'admin', 'admin-pass-1');
    const ws = await request(app.port, 'GET', '/api/workspace', {cookie: admin, headers: browser});
    const draft = structuredClone(ws.json.state);
    draft.users.find(user => user.id === 'sales').sipuniExtension = '214';
    const saved = await request(app.port, 'PUT', '/api/workspace', {cookie: admin, headers: browser, body: {revision: ws.json.revision, state: draft}});
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    assert.equal(saved.json.state.users.find(user => user.id === 'sales').sipuniExtension, '214');
    const elena = await login(app.port, 'elena', 'elena-pass-1');
    const called = await request(app.port, 'POST', '/api/sipuni/call', {cookie: elena, headers: browser, body: {clientId: 'anna', confirmName: 'Анна', confirmPhone: '+7 999 000-00-01'}});
    assert.equal(called.status, 200, JSON.stringify(called.json));
    assert.equal(new URLSearchParams(app.sipuni.memory.requests.at(-1).body).get('sipnumber'), '214');
  } finally {
    await app.close();
  }
});
