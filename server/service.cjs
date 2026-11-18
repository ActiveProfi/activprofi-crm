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

function archiveBatch(db, user, id) {
  return command(db, user, (state, actor) => ({batch: Leads.archiveBatch(state, actor, id)}));
}

function restoreBatch(db, user, id) {
  return command(db, user, (state, actor) => ({batch: Leads.restoreBatch(state, actor, id)}));
}

function clip(value, max) {
  const text = String(value ?? '').trim();
  return text.length > max ? text.slice(0, max) : text;
}

function stageToken(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return '';
  return clip(source.stageId || source.stage || source.stageName, 120);
}

function fromIstok(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, 'Каждый лид должен быть объектом');
  const comment = clip(raw.comment ?? raw.text ?? raw['комментарий'], 5000);
  const post = clip(raw.postUrl ?? raw.post ?? raw['ссылка на пост'], 500);
  const date = clip(raw.date ?? raw.dealDate ?? raw['дата'], 40);
  const notes = [comment, post ? 'Пост: ' + post : '', date ? 'Дата источника: ' + date : ''].filter(Boolean).join('\n');
  return {
    name: clip(raw.name ?? raw['имя'], 300),
    company: clip(raw.company ?? raw['компания'], 300),
    phone: clip(raw.phone ?? raw['телефон'], 40),
    email: clip(raw.email, 200),
    vk: clip(raw.vk ?? raw.vkUrl, 500),
    telegram: clip(raw.telegram ?? raw.telegramUrl ?? raw.tg, 500),
    source: clip(raw.source ?? raw['источник'], 120) || 'Исток',
    notes,
    comment,
    description: clip(raw.description ?? raw['описание'], 2000),
    clientTask: clip(raw.clientTask ?? raw.task ?? raw['задача'], 2000),
    kpVariants: clip(raw.kpVariants ?? raw.kp ?? raw.proposal ?? raw['кп'], 4000),
    kpLink: clip(raw.kpLink ?? raw.kpUrl ?? raw.proposalUrl ?? raw['ссылка на кп'], 500),
    callAt: clip(raw.callAt ?? raw.callDate ?? raw['созвон'], 40),
    statusNote: clip(raw.statusNote ?? raw['статус'], 500),
    date,
    stage: clip(raw.stage, 120),
    stageId: clip(raw.stageId, 80),
    stageName: clip(raw.stageName, 120),
  };
}

function ingestLeads(db, keyRow, body, cfg) {
  const list = Array.isArray(body) ? body : body?.leads;
  if (!Array.isArray(list)) throw new HttpError(400, 'Ожидается массив лидов или объект {"leads": [...]}');
  if (!list.length) throw new HttpError(400, 'Список лидов пуст');
  if (list.length > 1000) throw new HttpError(400, 'За один запрос — не больше 1000 лидов');
  const records = list.map(fromIstok);
  const defaults = Array.isArray(body) ? {} : (body || {});
  const intoStage = Boolean(stageToken(defaults) || records.some(record => stageToken(record)));
  let summary = {received: records.length, created: 0, duplicates: 0, errors: 0, batchId: '', ids: [], deals: []};
  db.transaction(() => {
    const state = store.load(db);
    upgradeInPlace(state);
    const admin = state.users.find(item => item.role === 'admin');
    if (!admin) throw new HttpError(500, 'В системе нет администратора для приёма лидов');
    const pipelineId = clip(defaults.pipelineId, 80) || cfg.integrationPipelineId || state.pipelines.find(item => item.id === 'outbound')?.id || state.pipelines[0]?.id;
    if (!pipelineId) throw new HttpError(400, 'Не задана воронка для интеграции');
    if (intoStage) {
      const deals = domainWrap(() => Leads.acceptIntegrationDeals(state, records, {
        pipelineId,
        stage: stageToken(defaults),
        stageId: clip(defaults.stageId, 80),
        stageName: clip(defaults.stage || defaults.stageName, 120),
        name: clip(defaults.batchName, 180) || ('Сделка · ' + M.today()),
        source: clip(defaults.source, 120) || 'Интеграция',
      }));
      summary = {
        received: records.length,
        created: deals.filter(deal => deal.status === 'created').length,
        duplicates: deals.filter(deal => deal.status === 'duplicate').length,
        errors: deals.filter(deal => deal.status === 'error').length,
        batchId: '',
        ids: deals.filter(deal => deal.status === 'created').map(deal => deal.id),
        deals,
      };
      if (summary.ids.length === 1) summary.id = summary.ids[0];
      if (summary.created) {
        store.save(db, state);
        store.bump(db);
      }
      store.addIntegrationImport(db, {
        id: crypto.randomUUID(),
        keyId: keyRow.id,
        source: 'deal',
        ...summary,
        createdAt: new Date().toISOString(),
      });
      return;
    }
    const legacy = records.map(record => ({
      name: record.name, phone: record.phone, email: record.email, vk: record.vk, telegram: record.telegram, source: record.source, notes: record.notes,
    }));
    const headers = [...new Set(legacy.flatMap(record => Object.keys(record)))];
    const rows = legacy.map(record => headers.map(header => record[header] ?? ''));
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
      const fresh = state.clients.filter(client => client.batchId === batch.id);
      summary.ids = fresh.map(client => client.id);
      summary.deals = fresh.map(client => ({id: client.id, name: client.name, status: 'created'}));
      if (summary.ids.length === 1) summary.id = summary.ids[0];
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
  command, importLeads, groupBatch, distributeBatch, promoteBatch, archiveBatch, restoreBatch, ingestLeads,
  createIntegrationKey, listIntegrationKeys, revokeIntegrationKey, findIntegrationKey,
  exportDump, importDump,
};
