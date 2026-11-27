const crypto = require('node:crypto');
const {Leads} = require('./models.cjs');
const store = require('./store.cjs');
const {upgradeInPlace, workspacePayload} = require('./guard.cjs');
const {HttpError} = require('./errors.cjs');

// Тексты, которые видит сотрудник. Секретный ключ сюда не попадает.
const OFF = 'Телефония не подключена — обратитесь к администратору';
const NO_EXTENSION = 'В вашей карточке не указан внутренний номер Sipuni. Попросите администратора вписать его в «Команда и роли».';

// Порядок полей подписи — из документации Sipuni.
// Статистика: https://doc.sipuni.com/articles/636-642--poluchenie-statistiki/
const STATS_ORDER = ['anonymous', 'crmLinks', 'dtmfUserAnswer', 'firstTime', 'from', 'fromNumber', 'hangupinitor', 'ignoreSpecChar', 'names', 'numbersInvolved', 'numbersRinged', 'outgoingLine', 'rating', 'showTreeId', 'state', 'timeFrom', 'timeTo', 'to', 'toAnswer', 'toNumber', 'tree', 'type', 'user'];

const HANGUP = {ANSWER: 'отвечен', BUSY: 'занято', NOANSWER: 'не отвечен', CANCEL: 'отменён', CONGESTION: 'недоступен', CHANUNAVAIL: 'недоступен'};

function sign(parts) {
  return crypto.createHash('md5').update(parts.map(value => String(value ?? '')).join('+')).digest('hex');
}

function normalizePhone(value) {
  return Leads.phone(value);
}

function showPhone(digits) {
  const value = normalizePhone(digits);
  if (value.length === 11 && value[0] === '7') return `+7 ${value.slice(1, 4)} ${value.slice(4, 7)}-${value.slice(7, 9)}-${value.slice(9)}`;
  return value ? '+' + value : '';
}

function durationText(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (total < 60) return total + ' сек';
  return Math.floor(total / 60) + ' мин ' + (total % 60) + ' сек';
}

function dayStamp(date) {
  const pad = number => String(number).padStart(2, '0');
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`;
}

function parseDuration(value) {
  const text = String(value || '').trim();
  if (/^\d+$/.test(text)) return Number(text);
  const parts = text.split(':').map(Number);
  if (!parts.length || parts.some(number => !Number.isFinite(number))) return 0;
  return parts.reduce((sum, number) => sum * 60 + number, 0);
}

function parseStamp(value) {
  const match = String(value || '').match(/(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!match) return new Date().toISOString();
  // В кабинете время московское.
  return new Date(Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1]), Number(match[4] || 0) - 3, Number(match[5] || 0), Number(match[6] || 0))).toISOString();
}

function directionOf(type) {
  const text = String(type || '').toLowerCase();
  if (text.includes('вход') || text === 'in' || text === '1') return 'in';
  if (text.includes('исход') || text === 'out' || text === '2') return 'out';
  if (text.includes('внутр') || text === '3') return 'internal';
  return '';
}

function answered(status) {
  const text = String(status || '').toLowerCase();
  if (!text) return false;
  if (text.includes('не')) return false;
  return text.includes('ответ') || text.includes('приня') || text === 'answer';
}

function splitCsv(line, delimiter) {
  const cells = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quoted) {
      if (char === '"') {
        if (line[index + 1] === '"') { current += '"'; index += 1; }
        else quoted = false;
      } else current += char;
    } else if (char === '"') quoted = true;
    else if (char === delimiter) { cells.push(current); current = ''; }
    else current += char;
  }
  cells.push(current);
  return cells;
}

function parseCsv(text) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim());
  if (lines.length < 2) return [];
  const delimiter = (lines[0].match(/;/g) || []).length >= (lines[0].match(/,/g) || []).length ? ';' : ',';
  const header = splitCsv(lines[0], delimiter).map(cell => cell.trim().toLowerCase());
  return lines.slice(1).map(line => {
    const cells = splitCsv(line, delimiter);
    return Object.fromEntries(header.map((key, index) => [key, String(cells[index] || '').trim()]));
  });
}

function cell(row, pattern) {
  const key = Object.keys(row).find(name => pattern.test(name));
  return key ? row[key] : '';
}

function formatNote(call, displayPhone) {
  const way = call.direction === 'in' ? 'входящий' : call.direction === 'out' ? 'исходящий' : 'внутренний';
  let record = '';
  if (call.recordId) record = ` [[record:/api/sipuni/record?id=${encodeURIComponent(call.recordId)}]]`;
  else if (/^https:\/\//i.test(call.recordUrl || '')) record = ` [[record:${call.recordUrl}]]`;
  return `[[call:${call.callId}]] Звонок · ${way} · ${call.status} · ${durationText(call.duration)} · ${displayPhone}${record}`;
}

function createSipuni({db, M, user = '', secret = '', webhookToken = '', mock = false, fetchImpl, sync = true} = {}) {
  const account = String(user || '').trim();
  const key = String(secret || '').trim();
  const memory = {requests: [], csv: '', operators: 'Имя;Внутренний номер\nЕлена;201\n', audio: Buffer.from('ID3mock')};
  const transport = fetchImpl || (mock ? mockFetch : globalThis.fetch);
  let timer = null;
  let pulling = false;

  function configured() {
    return Boolean(mock || (account && key));
  }

  async function mockFetch(url, options = {}) {
    memory.requests.push({url: String(url), body: String(options.body || '')});
    if (String(url).includes('/callback/call_number')) return textResponse(JSON.stringify({success: true, id: 'mock-call-1'}));
    if (String(url).includes('/statistic/operators')) return textResponse(memory.operators);
    if (String(url).includes('/statistic/record')) return {ok: true, status: 200, headers: {get: () => 'audio/mpeg'}, text: async () => '', arrayBuffer: async () => memory.audio};
    if (String(url).includes('/statistic/export')) return textResponse(memory.csv || 'Тип;Статус;Время;Откуда;Куда\n');
    return textResponse(JSON.stringify({success: false, message: 'unknown'}));
  }

  function textResponse(body) {
    return {ok: true, status: 200, headers: {get: () => 'text/plain'}, text: async () => body, arrayBuffer: async () => Buffer.from(body)};
  }

  async function postForm(url, params) {
    const body = new URLSearchParams(params).toString();
    const response = await transport(url, {
      method: 'POST',
      headers: {'Content-Type': 'application/x-www-form-urlencoded'},
      body,
      signal: AbortSignal.timeout(12000),
    });
    const payload = await response.text();
    return {ok: response.ok, status: response.status, payload, contentType: response.headers?.get?.('content-type') || ''};
  }

  function matchClient(state, phone) {
    const needle = normalizePhone(phone);
    if (!needle || needle.length < 10) return null;
    return state.clients.find(client => [client.phone, ...(client.phones || [])].some(item => Leads.phone(item) === needle)) || null;
  }

  function applyCall(call) {
    return db.transaction(() => {
      const state = store.load(db);
      upgradeInPlace(state);
      const phone = normalizePhone(call.phone);
      if (call.direction === 'out' && call.status !== 'заказан') {
        const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
        const pending = db.get(`SELECT call_id FROM sipuni_calls WHERE phone = ? AND direction = 'out' AND status = 'заказан' AND at >= ? AND call_id != ? ORDER BY at DESC LIMIT 1`, phone, cutoff, call.callId);
        if (pending) call.replaces = pending.call_id;
      }
      const client = call.clientId ? state.clients.find(item => item.id === call.clientId) : matchClient(state, phone);
      const clientId = client?.id || '';
      const ownerId = client?.ownerId || call.ownerId || '';
      const missed = call.direction === 'in' && call.status !== 'отвечен' && call.status !== 'идёт' && call.status !== 'заказан' ? 1 : 0;
      if (call.replaces) db.run('DELETE FROM sipuni_calls WHERE call_id = ?', call.replaces);
      db.run(
        `INSERT INTO sipuni_calls (call_id, client_id, owner_id, direction, status, duration, record_id, record_url, phone, extension, missed, seen, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(call_id) DO UPDATE SET
           client_id = excluded.client_id,
           owner_id = excluded.owner_id,
           direction = excluded.direction,
           status = excluded.status,
           duration = CASE WHEN excluded.duration > 0 THEN excluded.duration ELSE sipuni_calls.duration END,
           record_id = CASE WHEN excluded.record_id != '' THEN excluded.record_id ELSE sipuni_calls.record_id END,
           record_url = CASE WHEN excluded.record_url != '' THEN excluded.record_url ELSE sipuni_calls.record_url END,
           phone = excluded.phone,
           extension = excluded.extension,
           missed = excluded.missed,
           seen = CASE WHEN excluded.missed = 0 THEN 1 WHEN sipuni_calls.seen = 1 THEN 1 ELSE 0 END,
           at = excluded.at`,
        call.callId, clientId, ownerId, call.direction, call.status, Number(call.duration) || 0, call.recordId || '', call.recordUrl || '', phone, call.extension || '', missed, missed ? 0 : 1, call.at || new Date().toISOString(),
      );
      let notes = false;
      if (client) {
        const saved = db.get('SELECT record_id, record_url, duration, status FROM sipuni_calls WHERE call_id = ?', call.callId);
        putNote(client, {...call, phone, recordId: saved?.record_id || '', recordUrl: saved?.record_url || '', duration: saved?.duration || 0, status: saved?.status || call.status}, client.phone || showPhone(phone));
        notes = true;
      } else if (call.direction === 'in' && phone.length >= 10) {
        const known = db.get('SELECT client_id FROM sipuni_unknown WHERE phone = ?', phone);
        if (!known?.client_id) {
          const assignee = unknownAssignee(state, call.extension);
          db.run('INSERT INTO sipuni_unknown (phone, call_id, at, client_id, assignee) VALUES (?, ?, ?, ?, ?) ON CONFLICT(phone) DO UPDATE SET call_id = excluded.call_id, at = excluded.at, assignee = CASE WHEN sipuni_unknown.client_id = \'\' THEN excluded.assignee ELSE sipuni_unknown.assignee END', phone, call.callId, call.at || new Date().toISOString(), '', assignee);
        }
      }
      if (notes) {
        store.save(db, state);
        store.bump(db);
      }
      return {clientId, missed: Boolean(missed)};
    });
  }

  function putNote(client, call, displayPhone) {
    client.notes = Array.isArray(client.notes) ? client.notes : [];
    const text = formatNote(call, displayPhone);
    const marker = `[[call:${call.callId}]]`;
    let index = client.notes.findIndex(note => String(note).includes(marker));
    if (index < 0 && call.replaces) index = client.notes.findIndex(note => String(note).includes(`[[call:${call.replaces}]]`));
    if (index >= 0) client.notes[index] = text;
    else client.notes.unshift(text);
    client.recordRev = (Number(client.recordRev) || 1) + 1;
  }

  function unknownAssignee(state, extension) {
    const byLine = (state.users || []).find(item => String(item.sipuniExtension || '') === String(extension || '') && item.active !== false && !M.onProbation(item));
    if (byLine) return byLine.id;
    const duty = (state.users || []).find(item => item.id === state.desk?.dutyUserId && item.active !== false && !M.onProbation(item));
    if (duty) return duty.id;
    const pool = (state.users || []).filter(item => item.active !== false && !M.onProbation(item) && ['sales', 'rop', 'admin'].includes(item.role));
    if (!pool.length) return '';
    const count = db.get('SELECT COUNT(*) AS n FROM sipuni_unknown').n || 0;
    return pool[count % pool.length].id;
  }

  function ingest(fields) {
    if (!webhookToken || String(fields.token || '') !== webhookToken) return {success: false, status: 403};
    const callId = String(fields.call_id || '').trim().slice(0, 80);
    if (!callId) return {success: true, status: 200};
    const srcExternal = String(fields.src_type) === '1';
    const dstExternal = String(fields.dst_type) === '1';
    let direction = 'out';
    if (srcExternal && !dstExternal) direction = 'in';
    else if (!srcExternal && !dstExternal) direction = 'internal';
    if (direction === 'internal') return {success: true, status: 200};
    const event = String(fields.event || '');
    let status = event === '1' ? 'идёт' : (HANGUP[String(fields.status || '').toUpperCase()] || 'завершён');
    let recordUrl = '';
    try { recordUrl = decodeURIComponent(String(fields.call_record_link || '')); } catch { recordUrl = ''; }
    if (!/^https:\/\//i.test(recordUrl)) recordUrl = '';
    const phone = direction === 'in' ? fields.src_num : fields.dst_num;
    const extension = direction === 'in' ? (fields.short_dst_num || fields.dst_num) : (fields.short_src_num || fields.src_num);
    const at = Number(fields.timestamp) ? new Date(Number(fields.timestamp) * 1000).toISOString() : new Date().toISOString();
    applyCall({
      callId,
      direction,
      status,
      duration: Number(fields.duration || fields.call_duration || fields.talk_duration || 0) || 0,
      phone,
      extension: String(extension || '').replace(/\D/g, '').slice(0, 8),
      at,
      recordId: '',
      recordUrl,
    });
    return {success: true, status: 200};
  }

  function importCsv(csv) {
    let count = 0;
    for (const row of parseCsv(csv)) {
      const from = normalizePhone(cell(row, /^откуда$/));
      const to = normalizePhone(cell(row, /^куда$/));
      let direction = directionOf(cell(row, /^тип$/));
      if (!direction) {
        if (from.length >= 10 && to.length < 10) direction = 'in';
        else if (to.length >= 10 && from.length < 10) direction = 'out';
        else continue;
      }
      if (direction === 'internal') continue;
      const phone = direction === 'in' ? from : to;
      if (phone.length < 10) continue;
      const extension = direction === 'in' ? to : from;
      const status = answered(cell(row, /^статус$/)) ? 'отвечен' : (direction === 'in' ? 'не отвечен' : 'не отвечен');
      const recordId = cell(row, /id записи/);
      const exists = cell(row, /запись существует/);
      const keepRecord = recordId && exists !== '0' && !/^нет$/i.test(exists);
      const orderId = cell(row, /id заказа/) || (keepRecord ? 'rec-' + recordId : `csv:${cell(row, /^время$/)}:${from}:${to}`);
      applyCall({
        callId: String(orderId).slice(0, 80),
        direction,
        status,
        duration: parseDuration(cell(row, /длительность разговора/) || cell(row, /длительность звонка/)),
        phone,
        extension: extension.slice(0, 8),
        at: parseStamp(cell(row, /^время$/)),
        recordId: keepRecord ? recordId.slice(0, 80) : '',
        recordUrl: '',
      });
      count += 1;
    }
    return {imported: count};
  }

  async function pull() {
    if (!configured() || !account || !key) return {skipped: true};
    const from = dayStamp(new Date(Date.now() - 2 * 86400000));
    const to = dayStamp(new Date());
    const params = {anonymous: '1', crmLinks: '0', dtmfUserAnswer: '0', firstTime: '0', from, fromNumber: '', hangupinitor: '0', ignoreSpecChar: '0', names: '1', numbersInvolved: '0', numbersRinged: '0', outgoingLine: '1', rating: '', showTreeId: '0', state: '0', timeFrom: '', timeTo: '', to, toAnswer: '', toNumber: '', tree: '', type: '0', user: account};
    const hash = sign([...STATS_ORDER.map(name => params[name]), key]);
    const response = await postForm('https://sipuni.com/api/statistic/export', {...params, hash});
    if (!response.ok || response.payload.trim().startsWith('{')) throw new Error('stats');
    return importCsv(response.payload);
  }

  async function callback(phone, sipnumber) {
    const antiaon = '0';
    const reverse = '0';
    const hash = sign([antiaon, phone, reverse, sipnumber, account, key]);
    const response = await postForm('https://sipuni.com/api/callback/call_number', {antiaon, phone, reverse, sipnumber, user: account, hash});
    let data = {};
    try { data = JSON.parse(response.payload); } catch { data = {}; }
    if (!response.ok || data.success === false || data.success === 'false') throw new HttpError(502, 'Sipuni не принял звонок. Проверьте номер аккаунта и ключ интеграции.');
    return data;
  }

  async function callClient(sessionUser, body) {
    if (!configured()) throw new HttpError(400, OFF);
    const snapshot = db.transaction(() => {
      const state = store.load(db);
      upgradeInPlace(state);
      const actor = state.users.find(item => item.id === sessionUser.id);
      const client = state.clients.find(item => item.id === body.clientId);
      if (!actor || !client || !M.canClient(state, actor, client)) throw new HttpError(403, 'Это не ваш клиент');
      return {name: client.name, phone: String(client.phone || ''), extension: String(actor.sipuniExtension || '').trim(), clientId: client.id, ownerId: client.ownerId || actor.id};
    });
    if (!snapshot.phone.trim()) throw new HttpError(400, 'У клиента нет телефона');
    if (String(body.confirmName || '') !== snapshot.name || String(body.confirmPhone || '') !== snapshot.phone) throw new HttpError(400, 'Подтвердите имя и номер');
    if (!/^\d{2,8}$/.test(snapshot.extension)) throw new HttpError(400, NO_EXTENSION);
    const digits = normalizePhone(snapshot.phone);
    if (digits.length < 10) throw new HttpError(400, 'Некорректный телефон');
    const data = await callback(digits, snapshot.extension);
    applyCall({
      callId: String(data.id || data.call_id || ('order-' + crypto.randomBytes(4).toString('hex'))).slice(0, 80),
      direction: 'out',
      status: 'заказан',
      duration: 0,
      phone: digits,
      extension: snapshot.extension,
      clientId: snapshot.clientId,
      ownerId: snapshot.ownerId,
      at: new Date().toISOString(),
      recordId: '',
      recordUrl: '',
    });
    return {message: 'Звоним: ' + snapshot.name + ', ' + snapshot.phone, ...workspacePayload(db, sessionUser)};
  }

  async function test(sessionUser) {
    const state = store.load(db);
    const actor = state.users.find(item => item.id === sessionUser.id) || sessionUser;
    if (actor.role !== 'admin') throw new HttpError(403, 'Проверить телефонию может администратор');
    if (!configured()) throw new HttpError(400, OFF);
    if (mock) return {ok: true, eventKeySet: Boolean(webhookToken), message: 'Телефония отвечает. Это учебная проверка, звонок клиенту не совершался.'};
    const hash = sign([account, key]);
    const response = await postForm('https://sipuni.com/api/statistic/operators', {user: account, hash});
    if (!response.ok || response.payload.trim().startsWith('{')) throw new HttpError(502, 'Sipuni не подтвердил ключ. Проверьте SIPUNI_USER и SIPUNI_SECRET.');
    const rows = response.payload.split(/\r?\n/).filter(line => line.trim()).length;
    return {ok: true, eventKeySet: Boolean(webhookToken), message: 'Телефония отвечает. Аккаунт ' + account + '. Строк в списке сотрудников: ' + Math.max(0, rows - 1) + '. Звонок не совершался.'};
  }

  function feed(sessionUser) {
    const state = store.load(db);
    upgradeInPlace(state);
    const actor = state.users.find(item => item.id === sessionUser.id) || sessionUser;
    const calls = db.all(`SELECT call_id, client_id, owner_id, phone, at FROM sipuni_calls WHERE missed = 1 AND seen = 0 ORDER BY at DESC LIMIT 30`);
    const missed = [];
    for (const row of calls) {
      const client = state.clients.find(item => item.id === row.client_id);
      if (!client) continue;
      const own = client.ownerId === actor.id;
      if (!own && !M.has(state, actor, 'clients.all')) continue;
      missed.push({clientId: client.id, name: client.name, phone: client.phone || showPhone(row.phone), at: row.at});
    }
    const unknownRows = db.all(`SELECT phone, at, assignee FROM sipuni_unknown WHERE client_id = '' ORDER BY at DESC LIMIT 20`);
    const unknown = M.onProbation(actor) ? [] : unknownRows.filter(row => actor.role === 'admin' || actor.role === 'rop' || row.assignee === actor.id).map(row => ({phone: showPhone(row.phone), digits: row.phone, at: row.at}));
    return {configured: configured(), extension: String(actor.sipuniExtension || ''), message: configured() ? '' : OFF, revision: store.revision(db), missed, unknown};
  }

  function seen(sessionUser, clientId) {
    const state = store.load(db);
    const actor = state.users.find(item => item.id === sessionUser.id) || sessionUser;
    const client = state.clients.find(item => item.id === clientId);
    if (!client || !M.canClient(state, actor, client)) throw new HttpError(403, 'Это не ваш клиент');
    db.run('UPDATE sipuni_calls SET seen = 1 WHERE client_id = ? AND missed = 1', client.id);
    return {ok: true};
  }

  function createLead(sessionUser, body) {
    const phone = normalizePhone(body.phone || body.digits);
    const name = String(body.name || '').trim().slice(0, 120);
    if (!name) throw new HttpError(400, 'Введите имя');
    if (!phone || phone.length < 10) throw new HttpError(400, 'Некорректный телефон');
    if (normalizePhone(body.confirmPhone || body.phone) !== phone) throw new HttpError(400, 'Подтвердите номер');
    const clientId = db.transaction(() => {
      const row = db.get('SELECT phone, client_id, assignee FROM sipuni_unknown WHERE phone = ?', phone);
      if (!row || row.client_id) throw new HttpError(404, 'Этот номер уже разобрали');
      const state = store.load(db);
      upgradeInPlace(state);
      const actor = state.users.find(item => item.id === sessionUser.id);
      if (!actor || !M.has(state, actor, 'clients.edit') || M.onProbation(actor)) throw new HttpError(403, 'Создавать лид из неизвестного номера может дежурный, руководитель отдела или администратор');
      if (actor.role !== 'admin' && actor.role !== 'rop' && row.assignee && row.assignee !== actor.id) throw new HttpError(403, 'Этот номер назначен другому сотруднику');
      const existing = matchClient(state, phone);
      if (existing) {
        db.run('UPDATE sipuni_unknown SET client_id = ? WHERE phone = ?', existing.id, phone);
        if (!M.canClient(state, actor, existing)) throw new HttpError(409, 'Такой телефон уже есть в базе');
        return existing.id;
      }
      const id = 'call-' + crypto.randomBytes(4).toString('hex');
      const pipe = state.pipelines[0];
      const stage = pipe?.stages?.find(item => item.kind === 'open') || pipe?.stages?.[0];
      const ownerId = row.assignee || actor.id;
      state.clients.push({
        id, name, company: '', phone: showPhone(phone), email: '', socials: '', ownerId, inLeadBase: false,
        pipelineId: pipe?.id || '', stageId: stage?.id || '', stage: stage?.name || '', amount: 0, source: 'Входящий звонок',
        notes: ['Лид из звонка ' + showPhone(phone)], next: 'Перезвонить', when: new Date().toISOString(), batchId: '', project: '',
        stageHistory: stage ? [{at: M.today(), stageId: stage.id}] : [], recordRev: 1,
      });
      store.save(db, state);
      store.bump(db);
      db.run('UPDATE sipuni_unknown SET client_id = ? WHERE phone = ?', id, phone);
      return id;
    });
    return {clientId, message: 'Лид создан', ...workspacePayload(db, sessionUser)};
  }

  async function recordFor(sessionUser, id) {
    const recordId = String(id || '');
    if (!/^[\w.:-]{1,80}$/.test(recordId)) throw new HttpError(404, 'Запись не найдена');
    const row = db.get('SELECT client_id, record_id FROM sipuni_calls WHERE record_id = ?', recordId);
    if (!row) throw new HttpError(404, 'Запись не найдена');
    const state = store.load(db);
    const actor = state.users.find(item => item.id === sessionUser.id) || sessionUser;
    const client = state.clients.find(item => item.id === row.client_id);
    if (!client || !M.canClient(state, actor, client)) throw new HttpError(403, 'Это не ваш клиент');
    if (mock && !fetchImpl) return {mime: 'audio/mpeg', bytes: memory.audio};
    const hash = sign([recordId, account, key]);
    const response = await transport('https://sipuni.com/api/statistic/record', {
      method: 'POST',
      headers: {'Content-Type': 'application/x-www-form-urlencoded'},
      body: new URLSearchParams({id: recordId, user: account, hash}).toString(),
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new HttpError(502, 'Не удалось получить запись');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes[0] === 123) throw new HttpError(502, 'Не удалось получить запись');
    return {mime: 'audio/mpeg', bytes};
  }

  function start() {
    if (!sync || !configured()) return;
    const tick = async () => {
      if (pulling) return;
      pulling = true;
      try { await pull(); } catch { /* следующая попытка через две минуты */ }
      pulling = false;
    };
    timer = setInterval(tick, 120000);
    if (timer.unref) timer.unref();
    tick();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {configured, ingest, importCsv, pull, callClient, test, feed, seen, createLead, recordFor, start, stop, memory, sign, OFF};
}

module.exports = {createSipuni, sign, parseCsv, OFF, normalizePhone, showPhone, STATS_ORDER};
