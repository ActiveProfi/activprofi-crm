const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const {M, Leads, Communications, Inbox} = require('./models.cjs');
const store = require('./store.cjs');
const {hashPassword} = require('./passwords.cjs');
const {HttpError} = require('./errors.cjs');
const {upgradeInPlace} = require('./guard.cjs');

const DEMO_LOGINS = {
  admin: 'admin',
  lead: 'maria',
  sales: 'elena',
  pm: 'dmitry',
  anna: 'anna',
  dev2: 'alexey',
  sales2: 'oleg',
  lead2: 'svetlana',
  rop: 'irina',
  intern: 'nikita',
};

function prototypeSeed() {
  const box = {window: {}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'variant-b', 'seed.js'), 'utf8'), box);
  return M.migrate(structuredClone(box.window.BASE_SEED));
}

function emptyState() {
  return {
    schema: 2, users: [], pipelines: [], projects: [], clients: [], tasks: [], materials: [],
    messages: [], outbox: [], leadBatches: [], communications: [], voiceCampaigns: [],
    messengerChannels: [], conversations: [], externalMessages: [], rolePermissions: {}, permissionAudit: [],
    googleClientId: '',
  };
}

// Каркас пустой CRM: воронка и служебные списки.
// Демонстрационных сотрудников здесь нет — их добавляет только seedDemo через модели прототипа.
function ensureMinimal(state) {
  state.schema = 2;
  state.projects ||= [];
  state.clients ||= [];
  state.tasks ||= [];
  state.leadBatches ||= [];
  state.materials ||= [];
  state.messages ||= [];
  state.outbox ||= [];
  state.communications ||= [];
  state.voiceCampaigns ||= [];
  state.conversations ||= [];
  state.externalMessages ||= [];
  state.rolePermissions ||= {};
  state.permissionAudit ||= [];
  state.googleClientId ||= '';
  if (!state.messengerChannels?.length) {
    state.messengerChannels = [{id: 'telegram', provider: 'telegram', name: 'Telegram студии', mode: 'business', status: 'disconnected'}];
  }
  if (!state.pipelines?.length) {
    state.pipelines = [{
      id: 'inbound',
      name: 'Входящие заявки',
      stages: [
        {id: 'stage-new', name: 'Новый', kind: 'open'},
        {id: 'stage-won', name: 'В проекте', kind: 'won'},
        {id: 'stage-lost', name: 'Отказ', kind: 'lost'},
      ],
    }];
  }
  if (!state.leadsVersion) state.leadsVersion = 1;
  if (!state.manualFunnelVersion) state.manualFunnelVersion = 1;
  if (!state.coldStageVersion) state.coldStageVersion = 2;
  return state;
}

function assertPassword(password, label) {
  if (!password || String(password).length < 8) throw new Error(label + ' должен быть не короче 8 символов');
}

function createAdmin(db, cfg) {
  const login = String(cfg.adminLogin || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(login)) throw new Error('ADMIN_LOGIN: 3–32 символа, латиница, цифры, точка, _ или -');
  assertPassword(cfg.adminPassword, 'ADMIN_PASSWORD');
  const hash = hashPassword(cfg.adminPassword);
  db.transaction(() => {
    const state = store.userCount(db) ? store.load(db) : emptyState();
    ensureMinimal(state);
    let user = state.users.find(item => String(item.login || '').toLowerCase() === login) || state.users.find(item => item.id === 'admin');
    if (!user) {
      user = {id: 'admin', name: cfg.adminName || 'Администратор', role: 'admin', active: true, login};
      state.users.push(user);
    }
    user.login = login;
    user.role = 'admin';
    user.active = true;
    if (cfg.adminName) user.name = cfg.adminName;
    const passwords = {[user.id]: hash};
    store.save(db, state, {passwords});
    if (!store.revision(db)) store.setRevision(db, 1);
    else store.bump(db);
  });
  console.log('Администратор готов. Логин: ' + login + '. Пароль в базу не выводится.');
}

function seedDemo(db, cfg) {
  assertPassword(cfg.seedPassword, 'SEED_PASSWORD');
  if (store.userCount(db)) throw new Error('В базе уже есть пользователи. Демо-данные не записаны, чтобы не затереть работу команды.');
  const state = prototypeSeed();
  upgradeInPlace(state);
  ensureMinimal(state);
  const adminLogin = String(cfg.adminLogin || 'admin').trim().toLowerCase();
  const passwords = {};
  for (const user of state.users) {
    const login = user.id === 'admin' ? adminLogin : DEMO_LOGINS[user.id];
    if (!login) throw new Error('Нет демо-логина для пользователя ' + user.id);
    user.login = login;
    const password = user.id === 'admin' && cfg.adminPassword ? cfg.adminPassword : cfg.seedPassword;
    assertPassword(password, 'Пароль ' + login);
    passwords[user.id] = hashPassword(password);
  }
  db.transaction(() => {
    store.save(db, state, {passwords});
    store.setRevision(db, 1);
  });
  console.log('Синтетические демо-данные записаны. Логины: ' + state.users.map(user => user.login + ' (' + user.role + ')').join(', ') + '.');
  console.log('Пароль сотрудников берётся из SEED_PASSWORD, пароль администратора — из ADMIN_PASSWORD, если он задан.');
}

function ensureBoot(db, cfg) {
  if (store.userCount(db)) return;
  if (cfg.seedDemo) {
    seedDemo(db, cfg);
    return;
  }
  if (cfg.adminLogin && cfg.adminPassword) createAdmin(db, cfg);
  else console.warn('В базе нет пользователей. Задайте ADMIN_LOGIN и ADMIN_PASSWORD или выполните: node server/create-admin.cjs');
}

function normalizeDump(body) {
  const incoming = body?.state?.clients || body?.state?.projects ? body.state : body;
  if (!incoming || typeof incoming !== 'object') throw new HttpError(400, 'В файле нет данных CRM');
  let state = incoming;
  if (state.schema !== 2) state = M.migrate(state.clients ? state : {clients: [], projects: [], tasks: []});
  upgradeInPlace(state);
  ensureMinimal(state);
  if (!Array.isArray(state.users) || !Array.isArray(state.clients) || !Array.isArray(state.projects)) {
    throw new HttpError(400, 'Файл не похож на выгрузку CRM');
  }
  return state;
}

function fallbackLogin(id, used) {
  const clean = String(id || '').toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 24);
  let login = clean.length >= 3 ? clean : ('user' + clean).slice(0, 32);
  if (login.length < 3) login = 'user';
  let candidate = login;
  let n = 2;
  while (used.has(candidate)) {
    candidate = (login.slice(0, 28) + n).slice(0, 32);
    n += 1;
  }
  used.add(candidate);
  return candidate;
}

module.exports = {createAdmin, seedDemo, ensureBoot, ensureMinimal, emptyState, normalizeDump, fallbackLogin, DEMO_LOGINS, crypto};
