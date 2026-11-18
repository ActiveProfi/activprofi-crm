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
const {M} = require('./models.cjs');
const {createTelegram, maskToken} = require('./telegram.cjs');
const {loadEnv} = require('./config.cjs');
const {start} = require('./app.cjs');

function baseDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-tg-'));
  const databasePath = path.join(dir, 'crm.sqlite');
  const db = openDatabase(databasePath);
  migrate(db);
  createAdmin(db, {adminLogin: 'admin', adminPassword: 'admin-pass-1', adminName: 'Админ'});
  const state = store.load(db);
  state.users.push({id: 'outsider', name: 'Сторонний', role: 'developer', active: true, login: 'outsider', telegram: 'hidden_dev'});
  state.users.push({id: 'member', name: 'Участник', role: 'developer', active: true, login: 'member', telegram: 'maria_studio'});
  state.projects.push({
    id: 'studio', title: 'Студия массажа', client: 'Заказчик', description: '', type: 'crm', status: 'Проектирование',
    leaderId: 'admin', pmId: '', members: ['admin', 'member'], start: '2026-11-01', due: '2026-12-01', budget: 0,
    next: '', recipients: [], board: {notes: [], links: [], comments: []}, mockup: {name: '', data: ''}, devStage: 'dev-start',
  });
  store.save(db, state, {passwords: {outsider: hashPassword('outsider-pass'), member: hashPassword('member-pass-1')}});
  db.close();
  return {dir, databasePath};
}

function group(id, title, messageId, text, from, extra = {}) {
  return {update_id: messageId, message: {message_id: messageId, date: 1700000000, chat: {id, type: 'supergroup', title}, text, from, ...extra}};
}

test('TELEGRAM_BOT_TOKEN is read from .env the same way as ADMIN_PASSWORD', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-env-'));
  const file = path.join(dir, 'env');
  const sample = '123456789:AAHdummyTokenValue1234567890';
  fs.writeFileSync(file, 'ADMIN_PASSWORD=secret-admin\nTELEGRAM_BOT_TOKEN=' + sample + '\n');
  const savedAdmin = process.env.ADMIN_PASSWORD;
  const savedToken = process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.ADMIN_PASSWORD;
  delete process.env.TELEGRAM_BOT_TOKEN;
  try {
    loadEnv(file);
    assert.equal(process.env.ADMIN_PASSWORD, 'secret-admin');
    assert.equal(process.env.TELEGRAM_BOT_TOKEN, sample);
    assert.notEqual(maskToken(process.env.TELEGRAM_BOT_TOKEN), sample);
  } finally {
    if (savedAdmin === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = savedAdmin;
    if (savedToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = savedToken;
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('group messages are stored, private chats are ignored, and project chat stays hidden', async () => {
  const {dir, databasePath} = baseDb();
  const db = openDatabase(databasePath);
  const bot = createTelegram({db, M, store, fetchImpl: async () => { throw new Error('network'); }, mock: true});
  const admin = {id: 'admin', name: 'Админ', role: 'admin'};
  const outsider = {id: 'outsider', name: 'Сторонний', role: 'developer'};
  const member = {id: 'member', name: 'Участник', role: 'developer'};
  try {
    assert.equal(maskToken('123456:ABCDEFGHIJKLMNOPQRSTUV'), '••••••••STUV');
    assert.notEqual(maskToken('123456:ABCDEFGHIJKLMNOPQRSTUV'), '123456:ABCDEFGHIJKLMNOPQRSTUV');
    bot.applyUpdate({update_id: 1, message: {message_id: 1, date: 1700000000, chat: {id: 50, type: 'private', first_name: 'Клиент'}, text: 'личный секрет', from: {id: 50, first_name: 'Клиент'}}});
    assert.equal(db.get('SELECT COUNT(*) AS n FROM telegram_messages').n, 0);
    bot.applyUpdate(group(-1001, 'Команда АктивПрофи', 2, 'Макет на проверке', {id: 9, username: 'maria_studio', first_name: 'Мария'}));
    bot.applyUpdate(group(-1002, 'Проект: Студия массажа', 3, 'Нужна правка кнопки', {id: 777, username: 'client_side', first_name: 'Заказчик'}));
    bot.applyUpdate({update_id: 4, edited_message: {message_id: 2, date: 1700000000, edit_date: 1700000200, chat: {id: -1001, type: 'supergroup', title: 'Команда АктивПрофи'}, text: 'Макет готов', from: {id: 9, username: 'maria_studio', first_name: 'Мария'}}});
    bot.applyUpdate({update_id: 5, message: {message_id: 8, date: 1700000300, chat: {id: -1001, type: 'supergroup', title: 'Команда АктивПрофи'}, photo: [{file_id: 'small'}, {file_id: 'big'}], caption: 'Скрин', from: {id: 9, first_name: 'Мария'}}});
    const edited = db.get('SELECT text, edited, kind FROM telegram_messages WHERE message_id = ?', '2');
    assert.equal(edited.text, 'Макет готов');
    assert.equal(edited.edited, 1);
    const photo = db.get('SELECT kind, text, file_id FROM telegram_messages WHERE message_id = ?', '8');
    assert.equal(photo.kind, 'photo');
    assert.equal(photo.text, 'Скрин');
    assert.equal(photo.file_id, 'big');

    assert.throws(() => bot.messages(outsider, '-1001'), /недоступен/);
    bot.linkChat(admin, '-1001', 'team');
    bot.linkChat(admin, '-1002', 'project', 'studio');
    assert.throws(() => bot.linkChat(outsider, '-1002', 'project', 'studio'), /Привязать/);
    const outsiderChats = bot.visibleChats(outsider).filter(chat => chat.visible).map(chat => chat.chatId);
    assert.deepEqual(outsiderChats, ['-1001']);
    assert.throws(() => bot.messages(outsider, '-1002'), /недоступен/);
    const memberChats = bot.visibleChats(member).filter(chat => chat.visible).map(chat => chat.chatId).sort();
    assert.deepEqual(memberChats, ['-1001', '-1002']);
    const seen = bot.messages(member, '-1001');
    assert.equal(seen.find(item => item.messageId === '2').author, 'Участник');
    assert.equal(bot.status(admin).unread > 0, true);
    bot.markRead(admin, '-1001');
    bot.markRead(admin, '-1002');
    assert.equal(bot.status(admin).unread, 0);

    const thread = await bot.send(admin, '-1001', 'Ответ из CRM');
    assert.equal(bot.visibleChats(admin).find(chat => chat.chatId === '-1001').title, 'Команда АктивПрофи');
    assert.equal(bot.memory.sent[0].text, 'Админ:\nОтвет из CRM');
    assert.equal(bot.memory.sent[0].chat_id, '-1001');
    assert.equal(thread.at(-1).fromCrm, true);
    assert.match(thread.at(-1).text, /Админ:/);
    const skipped = createTelegram({db, M, store, fetchImpl: async () => { throw new Error('не должен вызываться'); }, envToken: ''});
    assert.deepEqual(await skipped.pollOnce(), {skipped: true});
    const fromEnv = createTelegram({
      db, M, store, envToken: '123456789:AAHdummyTokenValue1234567890', mock: false,
      fetchImpl: async (url) => ({
        ok: true,
        json: async () => String(url).includes('/getMe')
          ? {ok: true, result: {username: 'CRM_ActivProfi_Bot'}}
          : {ok: true, result: []},
      }),
    });
    assert.equal(fromEnv.status(admin).fromEnv, true);
    assert.equal(fromEnv.status(admin).botUsername, '');
    await fromEnv.pollOnce();
    assert.equal(fromEnv.status(admin).botUsername, 'CRM_ActivProfi_Bot');
    assert.throws(() => fromEnv.setToken(admin, '999999:AAHanotherTokenValue1234567890'), /задан в файле \.env/);
  } finally {
    db.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

function request(port, method, pathname, {body, cookie} = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname, method,
      headers: {'Content-Type': 'application/json', 'X-Requested-With': 'ActivProfi', ...(cookie ? {Cookie: cookie} : {}), ...(data ? {'Content-Length': data.length} : {})},
    }, res => {
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

test('HTTP mock: team reply is signed and a stranger cannot read the project group', async () => {
  const {dir, databasePath} = baseDb();
  const app = await start({
    host: '127.0.0.1', port: 0, databasePath, seedDemo: false,
    adminLogin: 'admin', adminPassword: 'admin-pass-1', adminName: 'Админ',
    sessionDays: 2, cookieSecure: false, telegramMock: true, telegramPoll: false, telegramBotToken: '',
  });
  try {
    app.telegram.seedDemo();
    const login = await request(app.port, 'POST', '/api/auth/login', {body: {login: 'admin', password: 'admin-pass-1'}});
    const admin = login.cookie[0].split(';')[0];
    const overview = await request(app.port, 'GET', '/api/telegram', {cookie: admin});
    assert.equal(overview.status, 200);
    assert.equal(overview.json.mock, true);
    assert.equal(overview.json.masked, '');
    const team = overview.json.chats.find(chat => chat.title === 'Команда АктивПрофи');
    const project = overview.json.chats.find(chat => chat.title === 'Проект: Студия массажа');
    assert.equal(team.chatId, '-1001');
    assert.equal((await request(app.port, 'POST', '/api/telegram/link', {cookie: admin, body: {chatId: team.chatId, scope: 'team'}})).status, 200);
    assert.equal((await request(app.port, 'POST', '/api/telegram/link', {cookie: admin, body: {chatId: project.chatId, scope: 'project', projectId: 'studio'}})).status, 200);
    const messages = await request(app.port, 'GET', '/api/telegram/messages?chatId=' + encodeURIComponent(team.chatId), {cookie: admin});
    assert.match(messages.json.messages[0].text, /Макет на проверке/);
    const sent = await request(app.port, 'POST', '/api/telegram/messages', {cookie: admin, body: {chatId: team.chatId, text: 'Принято'}});
    assert.equal(sent.status, 200);
    assert.equal(app.telegram.memory.sent.at(-1).text, 'Админ:\nПринято');
    const outsiderLogin = await request(app.port, 'POST', '/api/auth/login', {body: {login: 'outsider', password: 'outsider-pass'}});
    const outsider = outsiderLogin.cookie[0].split(';')[0];
    const hidden = await request(app.port, 'GET', '/api/telegram/messages?chatId=' + encodeURIComponent(project.chatId), {cookie: outsider});
    assert.equal(hidden.status, 403);
    const list = await request(app.port, 'GET', '/api/telegram', {cookie: outsider});
    assert.equal(list.json.chats.some(chat => chat.chatId === project.chatId && chat.visible), false);
    assert.equal(list.json.chats.some(chat => chat.chatId === team.chatId && chat.visible), true);
    const badge = await request(app.port, 'GET', '/api/telegram/badge', {cookie: outsider});
    assert.equal(typeof badge.json.unread, 'number');
    assert.equal(badge.json.byProject.studio || 0, 0);
    const memberLogin = await request(app.port, 'POST', '/api/auth/login', {body: {login: 'member', password: 'member-pass-1'}});
    const member = memberLogin.cookie[0].split(';')[0];
    const memberBadge = await request(app.port, 'GET', '/api/telegram/badge', {cookie: member});
    assert.equal(memberBadge.json.byProject.studio > 0, true);
  } finally {
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
