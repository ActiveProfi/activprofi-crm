const crypto = require('node:crypto');
const {M, Leads} = require('./models.cjs');
const store = require('./store.cjs');
const {contactKeys} = require('./contacts.cjs');
const {HttpError} = require('./errors.cjs');

const SCOPES = ['leads:write', 'export:read'];
const CSV_COLUMNS = ['Название', 'Контакт', 'Телефон', 'Email', 'VK', 'Telegram', 'Сайт', 'Город', 'Комментарий', 'CRM-ID'];

function clip(value, max) {
  const text = String(value ?? '').trim();
  return text.length > max ? text.slice(0, max) : text;
}

function tagsOf(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(/[,;]/);
  return [...new Set(list.map(item => clip(item, 80)).filter(Boolean))].slice(0, 20);
}

function sitesOf(record) {
  const raw = [record.site, record.website, record.url].flatMap(value => String(value || '').split(/[\n,;]/));
  return [...new Set(raw.map(value => value.trim()).filter(value => value && !/(^|\.)((vk|ok)\.ru|vk\.com|t\.me|telegram\.me|wa\.me|instagram\.com)(\/|$)/i.test(value.replace(/^https?:\/\//i, ''))))].slice(0, 10);
}

function bundleOf(record) {
  return [record.site, record.website, record.other, record.contactBundle].map(value => clip(value, 2000)).filter(Boolean).join('\n');
}

function keyToken(key) {
  return key.kind + '\0' + key.value;
}

function matchClient(state, data) {
  const wanted = new Set(contactKeys({
    phone: data.phone,
    phones: data.phones,
    email: data.email,
    emails: data.emails,
    socials: data.socials,
  }).map(keyToken));
  if (!wanted.size) return null;
  return state.clients.find(client => contactKeys(client).some(key => wanted.has(keyToken(key)))) || null;
}

function addFresh(current, incoming, same) {
  const list = [...current];
  let added = false;
  for (const value of incoming) {
    const text = String(value || '').trim();
    if (!text || list.some(item => same(item, text))) continue;
    list.push(text);
    added = true;
  }
  return {list, added};
}

function mergeLead(client, data, record) {
  const phones = addFresh([client.phone, ...(client.phones || [])], data.phones || [], (left, right) => Leads.phone(left) === Leads.phone(right));
  client.phones = phones.list.filter(Boolean);
  if (!client.phone && client.phones[0]) client.phone = client.phones[0];
  const emails = addFresh([client.email, ...(client.emails || [])], data.emails || [], (left, right) => String(left).trim().toLowerCase() === String(right).trim().toLowerCase());
  client.emails = emails.list.filter(Boolean);
  if (!client.email && client.emails[0]) client.email = client.emails[0];
  const socials = addFresh(String(client.socials || '').split('\n'), String(data.socials || '').split('\n'), (left, right) => left === right);
  client.socials = socials.list.filter(Boolean).join('\n');
  const sites = addFresh(String(client.site || '').split('\n'), sitesOf(record), (left, right) => left === right);
  client.site = sites.list.filter(Boolean).join('\n');
  if (!client.company && (data.company || record.company)) client.company = data.company || record.company;
  if (!client.city && record.city) client.city = record.city;
  const tags = tagsOf([...(client.tags || []), ...tagsOf(record.segment), ...tagsOf(record.tags)]);
  if (tags.length) client.tags = tags;
  if (record.istokId && !client.istokId) client.istokId = record.istokId;
  client.notes = Array.isArray(client.notes) ? client.notes : [];
  const extra = record.comment ? ': ' + record.comment : '';
  client.notes.unshift('обновлено из Истока' + extra);
  client.recordRev = (Number(client.recordRev) || 1) + 1;
}

function createLead(state, data, record, pipelineId, batchId) {
  const client = {
    ...data,
    id: crypto.randomUUID(),
    company: data.company || record.company || '',
    city: record.city || '',
    tags: tagsOf(record.segment || record.tags),
    istokId: record.istokId || '',
    site: sitesOf(record).join('\n'),
    inLeadBase: true,
    ownerId: '',
    pipelineId,
    stageId: '',
    stage: '',
    stageHistory: [],
    batchId,
    project: '',
    source: record.source || 'Исток',
    createdAt: M.today(),
    doNotContact: false,
    next: data.phone || data.email ? 'Первый звонок / письмо' : 'Написать в соцсети',
    when: '',
  };
  state.clients.push(client);
  return client;
}

function ingestBase(state, records, {pipelineId, batchName, keyId}) {
  const pipeline = state.pipelines.find(item => item.id === pipelineId);
  if (!pipeline) throw new HttpError(400, 'Не задана воронка для интеграции');
  const items = [];
  let batchId = '';
  const ensureBatch = () => {
    if (batchId) return batchId;
    batchId = crypto.randomUUID();
    state.leadBatches.push({
      id: batchId,
      name: batchName || ('Исток · ' + M.today()),
      pipelineId,
      ingress: 'istok',
      kind: 'cold',
      source: 'Исток',
      file: 'Исток',
      fileDate: M.today(),
      at: M.today(),
      createdBy: 'istok',
      integrationKeyId: keyId || '',
      baseOnly: true,
      skipped: 0,
    });
    return batchId;
  };
  for (const record of records) {
    const bundle = bundleOf(record);
    const headers = ['name', 'company', 'phone', 'email', 'vk', 'telegram', 'source', 'notes', 'contactBundle'];
    const row = [record.name, record.company, record.phone, record.email, record.vk, record.telegram, record.source, record.notes, bundle];
    let preview;
    try {
      preview = Leads.preview(state, headers, [row], headers, {
        name: batchName || 'Исток',
        pipelineId,
        destination: 'base',
        kind: 'cold',
        source: record.source || 'Исток',
        file: 'Исток',
        fileDate: M.today(),
        headerRow: 0,
      })[0];
    } catch (error) {
      items.push({id: '', name: record.name || '', status: 'skipped', reason: error.message || 'Не удалось разобрать лид'});
      continue;
    }
    if (!preview || preview.status === 'error') {
      items.push({id: '', name: record.name || '', status: 'skipped', reason: preview?.reason || 'Лид пропущен'});
      continue;
    }
    const existing = matchClient(state, preview.data);
    if (existing) {
      const stageId = existing.stageId;
      const ownerId = existing.ownerId;
      const ownPipeline = existing.pipelineId;
      const inLeadBase = existing.inLeadBase;
      mergeLead(existing, preview.data, record);
      existing.stageId = stageId;
      existing.ownerId = ownerId;
      existing.pipelineId = ownPipeline;
      existing.inLeadBase = inLeadBase;
      items.push({id: existing.id, name: existing.name, status: 'updated'});
      continue;
    }
    const client = createLead(state, preview.data, record, pipelineId, ensureBatch());
    items.push({id: client.id, name: client.name, status: 'created'});
  }
  if (batchId) {
    const batch = state.leadBatches.find(item => item.id === batchId);
    if (batch) batch.skipped = items.filter(item => item.status === 'skipped').length;
  }
  const created = items.filter(item => item.status === 'created').length;
  const updated = items.filter(item => item.status === 'updated').length;
  const skipped = items.filter(item => item.status === 'skipped').length;
  return {
    received: records.length,
    created,
    updated,
    skipped,
    duplicates: updated,
    errors: skipped,
    batchId,
    ids: items.filter(item => item.id).map(item => item.id),
    id: items.filter(item => item.id).length === 1 ? items.find(item => item.id).id : undefined,
    deals: items.filter(item => item.id).map(item => ({id: item.id, name: item.name, status: item.status})),
    items,
  };
}

function optedOut(client) {
  return client?.doNotContact === true || client?.doNotCall === true || client?.optedOut === true;
}

function selectionPool(state, actor, filter) {
  const ownOnly = M.onProbation(actor) || (actor.role !== 'admin' && !M.has(state, actor, 'clients.all'));
  const ownerId = ownOnly ? actor.id : clip(filter.ownerId, 80);
  if (!ownOnly && ownerId && ownerId !== actor.id && actor.role !== 'admin' && !M.has(state, actor, 'clients.all')) {
    throw new HttpError(403, 'Чужие клиенты в выборку не попадают');
  }
  let pool = M.visibleClients(state, actor);
  if (ownerId) pool = pool.filter(client => client.ownerId === ownerId);
  if (filter.stageId === 'base') pool = pool.filter(client => client.inLeadBase);
  else if (filter.stageId) pool = pool.filter(client => client.stageId === filter.stageId);
  if (filter.batchId) pool = pool.filter(client => client.batchId === filter.batchId);
  if (filter.source) pool = pool.filter(client => client.source === filter.source);
  if (filter.lossReason) pool = pool.filter(client => client.lossReason === filter.lossReason);
  if (!filter.includeWon) pool = pool.filter(client => M.stage(state, client)?.kind !== 'won');
  return pool.filter(client => !optedOut(client));
}

function previewSelection(db, user, body) {
  const filter = {
    stageId: clip(body?.stageId, 80),
    batchId: clip(body?.batchId, 80),
    source: clip(body?.source, 120),
    ownerId: clip(body?.ownerId, 80),
    lossReason: clip(body?.lossReason, 40),
    includeWon: body?.includeWon === true || body?.includeWon === 1 || body?.includeWon === '1',
  };
  const state = store.load(db);
  const actor = state.users.find(item => item.id === user.id);
  if (!actor) throw new HttpError(401, 'Нужно войти');
  if (M.onProbation(actor)) throw new HttpError(403, 'Новичок не собирает рассылки и выборки');
  const clients = selectionPool(state, actor, filter);
  return {
    count: clients.length,
    people: clients.slice(0, 30).map(client => ({id: client.id, name: client.name, phone: client.phone || '', email: client.email || '', stage: client.stage || ''})),
  };
}

function createSelection(db, user, body) {
  const name = clip(body?.name, 180);
  if (!name) throw new HttpError(400, 'Укажите название выборки');
  const filter = {
    stageId: clip(body?.stageId, 80),
    batchId: clip(body?.batchId, 80),
    source: clip(body?.source, 120),
    ownerId: clip(body?.ownerId, 80),
    lossReason: clip(body?.lossReason, 40),
    includeWon: body?.includeWon === true || body?.includeWon === 1 || body?.includeWon === '1',
  };
  return db.transaction(() => {
    const state = store.load(db);
    const actor = state.users.find(item => item.id === user.id);
    if (!actor) throw new HttpError(401, 'Нужно войти');
    if (!M.has(state, actor, 'clients.own') && !M.has(state, actor, 'clients.all') && actor.role !== 'admin') {
      throw new HttpError(403, 'Выборку собирает менеджер или администратор');
    }
    if (M.onProbation(actor)) throw new HttpError(403, 'Новичок не собирает рассылки и выборки');
    const clients = selectionPool(state, actor, filter);
    if (!clients.length) throw new HttpError(400, 'В выборке никого нет. Проверьте фильтр и отметку «не писать и не звонить».');
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const clientIds = clients.map(client => client.id);
    db.run(
      'INSERT INTO mailing_selections (id, name, created_by, created_at, status, taken_at, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id, name, actor.id, createdAt, 'new', '', JSON.stringify({filter, clientIds}),
    );
    return {id, name, status: 'new', createdAt, createdBy: actor.id, count: clientIds.length, filter};
  });
}

function readSelection(row) {
  let data = {};
  try { data = JSON.parse(row.data || '{}'); } catch { data = {}; }
  return {
    id: row.id,
    name: row.name,
    status: row.status === 'taken' ? 'taken' : 'new',
    createdAt: row.created_at,
    createdBy: row.created_by,
    takenAt: row.taken_at || '',
    filter: data.filter || {},
    clientIds: Array.isArray(data.clientIds) ? data.clientIds : [],
  };
}

function listSelections(db, user) {
  const state = store.load(db);
  const actor = state.users.find(item => item.id === user.id);
  if (!actor) throw new HttpError(401, 'Нужно войти');
  const rows = db.all('SELECT id, name, created_by, created_at, status, taken_at, data FROM mailing_selections ORDER BY created_at DESC');
  return rows.map(readSelection).filter(item => actor.role === 'admin' || item.createdBy === actor.id).map(item => ({
    id: item.id,
    name: item.name,
    status: item.status,
    createdAt: item.createdAt,
    createdBy: item.createdBy,
    takenAt: item.takenAt,
    count: item.clientIds.length,
    filter: item.filter,
  }));
}

function socialParts(client) {
  const links = String(client.socials || '').split('\n').map(item => item.trim()).filter(Boolean);
  const vk = links.filter(link => /vk\.com|vk\.ru/i.test(link));
  const telegram = links.filter(link => /t\.me|telegram\.me/i.test(link));
  const rest = links.filter(link => !vk.includes(link) && !telegram.includes(link));
  const site = [...new Set([...String(client.site || '').split('\n').map(item => item.trim()).filter(Boolean), ...rest])];
  return {vk: vk.join(', '), telegram: telegram.join(', '), site: site.join(', ')};
}

function commentOf(state, client) {
  const stage = client.inLeadBase ? 'Общая база' : (M.stage(state, client)?.name || client.stage || '');
  const notes = Array.isArray(client.notes) ? client.notes : [];
  return [stage, notes[0] || '', client.statusNote || ''].filter(Boolean).join(' · ');
}

function exportRow(state, client) {
  const social = socialParts(client);
  const phones = [...new Set([client.phone, ...(client.phones || [])].map(value => String(value || '').trim()).filter(Boolean))];
  const emails = [...new Set([client.email, ...(client.emails || [])].map(value => String(value || '').trim()).filter(Boolean))];
  return {
    'Название': client.company || '',
    'Контакт': client.name || '',
    'Телефон': phones.join(', '),
    'Email': emails.join(', '),
    'VK': social.vk,
    'Telegram': social.telegram,
    'Сайт': social.site,
    'Город': client.city || '',
    'Комментарий': commentOf(state, client),
    'CRM-ID': client.id,
  };
}

function csvOf(rows) {
  const cell = value => {
    const text = String(value ?? '');
    return /[",\n\r]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  };
  const lines = [CSV_COLUMNS.join(',')];
  for (const row of rows) lines.push(CSV_COLUMNS.map(column => cell(row[column])).join(','));
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

function rowsForIds(state, ids) {
  return ids.map(id => state.clients.find(client => client.id === id)).filter(Boolean).map(client => exportRow(state, client));
}

function selectionExport(db, id, format) {
  const row = db.get('SELECT id, name, created_by, created_at, status, taken_at, data FROM mailing_selections WHERE id = ?', id);
  if (!row) throw new HttpError(404, 'Выборка не найдена');
  const selection = readSelection(row);
  const state = store.load(db);
  const rows = rowsForIds(state, selection.clientIds);
  if (format === 'json') return {kind: 'json', body: {id: selection.id, name: selection.name, status: selection.status, rows}};
  return {kind: 'csv', filename: 'selection-' + selection.id.slice(0, 8) + '.csv', body: csvOf(rows)};
}

function ackSelection(db, id) {
  const row = db.get('SELECT id, status FROM mailing_selections WHERE id = ?', id);
  if (!row) throw new HttpError(404, 'Выборка не найдена');
  const takenAt = row.status === 'taken' ? db.get('SELECT taken_at FROM mailing_selections WHERE id = ?', id).taken_at : new Date().toISOString();
  if (row.status !== 'taken') db.run("UPDATE mailing_selections SET status = 'taken', taken_at = ? WHERE id = ?", takenAt, id);
  return {id, status: 'taken', takenAt};
}

function listNewSelections(db, status = 'new') {
  const wanted = status === 'taken' ? 'taken' : 'new';
  return db.all('SELECT id, name, created_by, created_at, status, taken_at, data FROM mailing_selections WHERE status = ? ORDER BY created_at', wanted).map(row => {
    const item = readSelection(row);
    return {id: item.id, name: item.name, status: item.status, createdAt: item.createdAt, count: item.clientIds.length};
  });
}

function filteredExport(db, query) {
  const state = store.load(db);
  const since = clip(query.since, 40).slice(0, 10);
  let clients = state.clients.filter(client => !optedOut(client));
  if (query.stage) {
    const token = clip(query.stage, 120);
    clients = clients.filter(client => client.stageId === token || client.stage === token || (M.stage(state, client)?.name === token));
  }
  if (query.batch) clients = clients.filter(client => client.batchId === clip(query.batch, 80));
  if (query.source) clients = clients.filter(client => client.source === clip(query.source, 120));
  if (since) clients = clients.filter(client => String(client.createdAt || '') >= since);
  const rows = clients.map(client => exportRow(state, client));
  if (String(query.format || 'json') === 'csv') return {kind: 'csv', filename: 'crm-export.csv', body: csvOf(rows)};
  return {kind: 'json', body: {count: rows.length, rows}};
}

module.exports = {
  SCOPES, CSV_COLUMNS, ingestBase, previewSelection, createSelection, listSelections, selectionExport, ackSelection,
  listNewSelections, filteredExport, optedOut, csvOf,
};
