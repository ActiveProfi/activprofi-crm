const crypto = require('node:crypto');
const {M, Leads} = require('./models.cjs');
const store = require('./store.cjs');
const {present, upgradeInPlace} = require('./guard.cjs');
const {HttpError, domainError} = require('./errors.cjs');
const {hashApiKey, newApiKey} = require('./passwords.cjs');
const {normalizeDump, fallbackLogin} = require('./bootstrap.cjs');

function command(db, user, fn) {
  let extra = {};
  const payload = db.transaction(() => {
    const state = store.load(db);
    upgradeInPlace(state);
    const actor = state.users.find(item => item.id === user.id);
    if (!actor) throw new HttpError(401, 'Пользователь не найден');
    extra = domainWrap(() => fn(state, actor)) || {};
    store.save(db, state);
    const revision = store.bump(db);
    const view = present(state, actor);
    view.revision = revision;
    return {revision, user: store.publicUser(actor), state: view};
  });
  return {...payload, ...extra};
}

function domainWrap(fn) {
  try { return fn(); }
  catch (error) { throw domainError(error); }
}

function importLeads(db, user, body) {
  const headers = body?.headers;
  const rows = body?.rows;
  const map = body?.map;
  const opts = body?.opts || {};
  if (!Array.isArray(headers) || !Array.isArray(rows) || !Array.isArray(map)) throw new HttpError(400, 'Некорректные данные импорта');
  if (rows.length > 5000) throw new HttpError(400, 'За один импорт — до 5000 строк');
  return command(db, user, (state, actor) => {
    if (body.groups && !body.existingBatch) {
      const groups = Leads.groupedCommit(state, actor, headers, rows, map, opts, body.groups);
      return {groups};
    }
    const batch = Leads.commit(state, actor, headers, rows, map, opts);
    return {batch};
  });
}

function groupBatch(db, user, id, body) {
  return command(db, user, (state, actor) => ({groups: Leads.groupExisting(state, actor, id, body?.choices || {}, body?.fileDate)}));
}

function distributeBatch(db, user, id, body) {
  return command(db, user, (state, actor) => ({plan: Leads.distribute(state, actor, id, body?.category)}));
}

function promoteBatch(db, user, id, body) {
  return command(db, user, (state, actor) => {
    const loaded = Leads.promoteBatch(state, actor, id, body?.pipelineId, body?.stageId);
    return {loaded: loaded.length};
  });
}

function clip(value, max) {
  const text = String(value ?? '').trim();
  return text.length > max ? text.slice(0, max) : text;
}

function fromIstok(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, 'Каждый лид должен быть объектом');
  const comment = clip(raw.comment ?? raw.text ?? raw['комментарий'], 5000);
  const post = clip(raw.postUrl ?? raw.post ?? raw['ссылка на пост'], 500);
  const date = clip(raw.date ?? raw['дата'], 40);
  const notes = [comment, post ? 'Пост: ' + post : '', date ? 'Дата источника: ' + date : ''].filter(Boolean).join('\n');
  return {
    name: clip(raw.name ?? raw['имя'], 300),
    phone: clip(raw.phone ?? raw['телефон'], 40),
    email: clip(raw.email, 200),
    vk: clip(raw.vk ?? raw.vkUrl, 500),
    telegram: clip(raw.telegram ?? raw.telegramUrl ?? raw.tg, 500),
    source: clip(raw.source, 120) || 'Исток',
    notes,
  };
}

function ingestLeads(db, keyRow, body, cfg) {
  const list = Array.isArray(body) ? body : body?.leads;
  if (!Array.isArray(list)) throw new HttpError(400, 'Ожидается массив лидов или объект {"leads": [...]}');
  if (!list.length) throw new HttpError(400, 'Список лидов пуст');
  if (list.length > 1000) throw new HttpError(400, 'За один запрос — не больше 1000 лидов');
  const records = list.map(fromIstok);
  let summary = {received: records.length, created: 0, duplicates: 0, errors: 0, batchId: ''};
  db.transaction(() => {
    const state = store.load(db);
    upgradeInPlace(state);
    const admin = state.users.find(item => item.role === 'admin');
    if (!admin) throw new HttpError(500, 'В системе нет администратора для приёма лидов');
    const pipelineId = clip(body?.pipelineId, 80) || cfg.integrationPipelineId || state.pipelines.find(item => item.id === 'outbound')?.id || state.pipelines[0]?.id;
    if (!pipelineId) throw new HttpError(400, 'Не задана воронка для интеграции');
    const headers = [...new Set(records.flatMap(record => Object.keys(record)))];
    const rows = records.map(record => headers.map(header => record[header] ?? ''));
    const map = headers.map(header => Leads.fields[header] ? header : '');
    const opts = {
      name: clip(body?.batchName, 180) || ('Исток · ' + M.today()),
      pipelineId,
      destination: 'base',
      kind: 'cold',
      source: 'Исток',
      file: 'Исток',
      fileDate: M.today(),
    };
    const preview = domainWrap(() => Leads.preview(state, headers, rows, map, opts));
    summary = {
      received: records.length,
      created: preview.filter(row => row.status === 'ready').length,
      duplicates: preview.filter(row => row.status === 'duplicate').length,
      errors: preview.filter(row => row.status === 'error').length,
      batchId: '',
    };
    if (summary.created) {
      const batch = domainWrap(() => Leads.commit(state, admin, headers, rows, map, opts));
      batch.fileDate = opts.fileDate;
      batch.integrationKeyId = keyRow.id;
      summary.batchId = batch.id;
      store.save(db, state);
      store.bump(db);
    }
    store.addIntegrationImport(db, {
      id: crypto.randomUUID(),
      keyId: keyRow.id,
      source: 'istok',
      ...summary,
      createdAt: new Date().toISOString(),
    });
  });
  return summary;
}

function createIntegrationKey(db, user, name) {
  if (user.role !== 'admin') throw new HttpError(403, 'Ключи интеграций создаёт администратор');
  const title = clip(name, 120);
  if (!title) throw new HttpError(400, 'Укажите название ключа');
  const key = newApiKey();
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  db.run(
    'INSERT INTO integration_api_keys (id, name, prefix, key_hash, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    id, title, key.slice(0, 12), hashApiKey(key), user.id, createdAt,
  );
  return {id, name: title, prefix: key.slice(0, 12), key, createdAt};
}

function listIntegrationKeys(db, user) {
  if (user.role !== 'admin') throw new HttpError(403, 'Список ключей доступен администратору');
  return db.all('SELECT id, name, prefix, created_by, created_at, revoked_at FROM integration_api_keys ORDER BY created_at DESC');
}

function revokeIntegrationKey(db, user, id) {
  if (user.role !== 'admin') throw new HttpError(403, 'Ключ отзывает администратор');
  const row = db.get('SELECT id, revoked_at FROM integration_api_keys WHERE id = ?', id);
  if (!row) throw new HttpError(404, 'Ключ не найден');
  if (!row.revoked_at) db.run('UPDATE integration_api_keys SET revoked_at = ? WHERE id = ?', new Date().toISOString(), id);
  return {id, revoked: true};
}

function findIntegrationKey(db, raw) {
  const key = String(raw || '').trim();
  if (!key.startsWith('apk_') || key.length > 200) return undefined;
  const row = db.get('SELECT id, name, prefix, created_by, revoked_at FROM integration_api_keys WHERE key_hash = ?', hashApiKey(key));
  if (!row || row.revoked_at) return undefined;
  return row;
}

function exportDump(db, user) {
  if (user.role !== 'admin') throw new HttpError(403, 'Выгрузку делает администратор');
  const state = store.load(db);
  upgradeInPlace(state);
  for (const item of state.users) {
    delete item.password;
    delete item.password_hash;
  }
  return {exportedAt: new Date().toISOString(), schema: 2, state};
}

function importDump(db, user, body) {
  if (user.role !== 'admin') throw new HttpError(403, 'Загрузку выгрузки делает администратор');
  const state = normalizeDump(body);
  let temporaryPasswords = [];
  const payload = db.transaction(() => {
    const hashes = new Map(db.all('SELECT id, password_hash, login FROM users').map(row => [row.id, row]));
    const used = new Set();
    const passwords = {};
    temporaryPasswords = [];
    for (const item of state.users) {
      delete item.password;
      delete item.password_hash;
      if (!M.roles[item.role]) item.role = 'sales';
      const prior = hashes.get(item.id);
      if (prior) {
        item.login = prior.login;
        used.add(prior.login);
      } else {
        item.login = fallbackLogin(item.login || item.id, used);
        const password = 'Tmp-' + crypto.randomBytes(9).toString('base64url');
        passwords[item.id] = hashPassword(password);
        temporaryPasswords.push({id: item.id, name: item.name, login: item.login, password});
      }
    }
    if (!state.users.some(item => item.role === 'admin')) throw new HttpError(400, 'В выгрузке должен остаться хотя бы один администратор');
    store.save(db, state, {passwords});
    const revision = store.bump(db);
    const actor = state.users.find(item => item.id === user.id) || state.users.find(item => item.role === 'admin');
    const view = present(state, actor);
    view.revision = revision;
    return {revision, user: store.publicUser(actor), state: view};
  });
  return {...payload, temporaryPasswords};
}

module.exports = {
  command, importLeads, groupBatch, distributeBatch, promoteBatch, ingestLeads,
  createIntegrationKey, listIntegrationKeys, revokeIntegrationKey, findIntegrationKey,
  exportDump, importDump,
};
