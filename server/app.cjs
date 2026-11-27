const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {config} = require('./config.cjs');
const {openDatabase, migrate} = require('./db.cjs');
const store = require('./store.cjs');
const {hashPassword, verifyPassword} = require('./passwords.cjs');
const {HttpError, domainError} = require('./errors.cjs');
const {workspacePayload, mergeWorkspace} = require('./guard.cjs');
const {M} = require('./models.cjs');
const service = require('./service.cjs');
const {ensureBoot} = require('./bootstrap.cjs');
const {createTelegram} = require('./telegram.cjs');
const {mailSettings, createSmtp} = require('./mail.cjs');
const outbound = require('./outbound.cjs');
const {createSipuni} = require('./sipuni.cjs');
const kp = require('./kp.cjs');
const pitch = require('./pitch.cjs');
const {assertExposure, clientIp, cookieIsSecure} = require('./exposure.cjs');
const {createLoginGuard, LOCK_MESSAGE} = require('./login-guard.cjs');

const telegramByDb = new WeakMap();
const sipuniByDb = new WeakMap();

function currentMailer(cfg) {
  const smtp = cfg.smtp || {};
  return createSmtp({settings: mailSettings({
    SMTP_HOST: smtp.host || '',
    SMTP_PORT: smtp.port || '',
    SMTP_SECURE: smtp.secure || '',
    SMTP_USER: smtp.user || '',
    SMTP_PASS: smtp.pass || '',
    SMTP_FROM: smtp.from || '',
    SMTP_FROM_NAME: smtp.fromName || '',
  })});
}

const root = path.join(__dirname, '..', 'variant-b');
const types = {'.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon'};
const loginGuard = createLoginGuard();
let dummyHash = '';

function cookie(token, cfg, clear = false, secure = false) {
  const parts = [`ap_session=${clear ? '' : encodeURIComponent(token)}`, 'HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${clear ? 0 : cfg.sessionDays * 86400}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return '';
}

function integrationKey(db, req, scope) {
  const header = req.headers['x-api-key'] || '';
  const bearer = String(req.headers.authorization || '').startsWith('Bearer ') ? String(req.headers.authorization).slice(7).trim() : '';
  const key = service.findIntegrationKey(db, header || bearer);
  if (!key) throw new HttpError(401, 'Неверный ключ интеграции');
  if (key.scope !== scope) throw new HttpError(403, scope === 'export:read' ? 'Этим ключом нельзя забирать выборки' : 'Этим ключом нельзя принимать лиды');
  return key;
}

function sendExport(res, exported) {
  if (exported.kind === 'json') return send(res, 200, exported.body);
  const body = Buffer.from(exported.body, 'utf8');
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Length': body.length,
    'Content-Disposition': `attachment; filename="${exported.filename || 'export.csv'}"`,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function send(res, status, body, extra = {}) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Content-Length': payload.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra});
  res.end(payload);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'Слишком большой запрос'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readSipuniEvent(req, url) {
  const fields = Object.fromEntries(url.searchParams);
  if ((req.method || 'GET') === 'GET') return fields;
  const raw = await readBody(req, 64 * 1024);
  if (!raw.length) return fields;
  const type = String(req.headers['content-type'] || '');
  let body = {};
  if (type.includes('application/json')) {
    try { body = JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400, 'Некорректный JSON'); }
  } else body = Object.fromEntries(new URLSearchParams(raw.toString('utf8')));
  return {...fields, ...body};
}

async function readJson(req, limit = 32 * 1024 * 1024) {
  const raw = await readBody(req, limit);
  if (!raw.length) return {};
  try { return JSON.parse(raw.toString('utf8')); }
  catch { throw new HttpError(400, 'Некорректный JSON'); }
}

function assertBrowser(req) {
  if (req.headers['x-requested-with'] !== 'ActivProfi') throw new HttpError(403, 'Запрос отклонён');
  const origin = req.headers.origin;
  if (!origin) return;
  let host = '';
  try { host = new URL(origin).host; } catch { throw new HttpError(403, 'Запрос отклонён'); }
  if (host !== req.headers.host) throw new HttpError(403, 'Запрос отклонён');
}

function auth(db, req) {
  const session = store.readSession(db, readCookie(req, 'ap_session'));
  if (!session) return null;
  session.user.sessionHash = session.tokenHash;
  return session;
}

function requireUser(db, req) {
  const session = auth(db, req);
  if (!session) throw new HttpError(401, 'Нужно войти');
  return session;
}

async function editWorkspace(db, session, mutate) {
  const current = workspacePayload(db, session.user);
  const draft = structuredClone(current.state);
  const result = mutate(draft) || {};
  const saved = mergeWorkspace(db, session.user, current.revision, draft);
  return {...saved, ...result};
}

function visible(db, user) {
  return workspacePayload(db, user).state;
}

function staticPath(urlPath) {
  let pathname = '/';
  try { pathname = decodeURIComponent(new URL(urlPath, 'http://localhost').pathname); }
  catch { return null; }
  const file = path.resolve(root, '.' + pathname);
  const target = file === root ? path.join(root, 'index.html') : file;
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return null;
  if (!types[path.extname(target)]) return null;
  return target;
}

async function route(req, res, db, cfg) {
  const url = new URL(req.url, 'http://localhost');
  const method = req.method || 'GET';
  const pathname = url.pathname;

  if (pathname === '/api/health' && method === 'GET') return send(res, 200, {ok: true});

  if (pathname === '/api/integrations/leads' && method === 'POST') {
    const header = req.headers['x-api-key'] || '';
    const bearer = String(req.headers.authorization || '').startsWith('Bearer ') ? String(req.headers.authorization).slice(7).trim() : '';
    integrationKey(db, req, 'leads:write');
    const body = await readJson(req);
    const key = service.findIntegrationKey(db, header || bearer);
    return send(res, 200, service.ingestLeads(db, key, body, cfg));
  }

  const selectionExport = pathname.match(/^\/api\/integrations\/selections\/([^/]+)(?:\/(ack))?$/);
  if (pathname === '/api/integrations/selections' && method === 'GET') {
    integrationKey(db, req, 'export:read');
    return send(res, 200, {selections: service.istok.listNewSelections(db, url.searchParams.get('status') || 'new')});
  }
  if (pathname === '/api/integrations/export' && method === 'GET') {
    integrationKey(db, req, 'export:read');
    return sendExport(res, service.istok.filteredExport(db, Object.fromEntries(url.searchParams)));
  }
  if (selectionExport && !selectionExport[2] && method === 'GET') {
    integrationKey(db, req, 'export:read');
    return sendExport(res, service.istok.selectionExport(db, decodeURIComponent(selectionExport[1]), url.searchParams.get('format') || 'csv'));
  }
  if (selectionExport && selectionExport[2] === 'ack' && method === 'POST') {
    integrationKey(db, req, 'export:read');
    return send(res, 200, service.istok.ackSelection(db, decodeURIComponent(selectionExport[1])));
  }

  if (pathname === '/api/sipuni/event' && (method === 'GET' || method === 'POST')) {
    const sipuni = sipuniByDb.get(db);
    const fields = await readSipuniEvent(req, url);
    const result = sipuni.ingest(fields);
    return send(res, result.status || 200, {success: result.success === true});
  }

  if (pathname.startsWith('/api/') && method !== 'GET' && method !== 'HEAD') assertBrowser(req);

  if (pathname === '/api/auth/login' && method === 'POST') {
    const body = await readJson(req, 32 * 1024);
    const login = String(body.login || '').trim().toLowerCase();
    const ip = clientIp(req, cfg);
    if (loginGuard.status(ip, login).locked) throw new HttpError(429, LOCK_MESSAGE);
    const found = store.findUserByLogin(db, login);
    const hash = found?.password_hash || (dummyHash ||= hashPassword('not-a-real-password'));
    const ok = verifyPassword(body.password || '', hash) && !!found;
    if (!ok) {
      loginGuard.fail(ip, login);
      throw new HttpError(401, 'Неверный логин или пароль');
    }
    loginGuard.success(login);
    db.run('DELETE FROM sessions WHERE expires_at <= ?', new Date().toISOString());
    const token = store.createSession(db, found.id, cfg.sessionDays);
    return send(res, 200, {user: store.publicUser(found.user)}, {'Set-Cookie': cookie(token, cfg, false, cookieIsSecure(req, cfg))});
  }

  if (pathname === '/api/auth/logout' && method === 'POST') {
    store.deleteSession(db, readCookie(req, 'ap_session'));
    return send(res, 200, {ok: true}, {'Set-Cookie': cookie('', cfg, true, cookieIsSecure(req, cfg))});
  }

  if (pathname === '/api/auth/password' && method === 'POST') {
    const session = requireUser(db, req);
    const body = await readJson(req, 32 * 1024);
    const next = String(body.password || '');
    const current = String(body.currentPassword || '');
    if (next.length < 8) throw new HttpError(400, 'Новый пароль — не короче 8 символов');
    if (next === current) throw new HttpError(400, 'Новый пароль должен отличаться от текущего');
    const saved = db.transaction(() => {
      const state = store.load(db);
      const actor = state.users.find(item => item.id === session.user.id);
      if (!actor) throw new HttpError(401, 'Нужно войти');
      const row = store.findUserByLogin(db, actor.login);
      if (!row || !verifyPassword(current, row.password_hash)) throw new HttpError(400, 'Текущий пароль не подошёл');
      actor.mustChangePassword = false;
      store.save(db, state, {passwords: {[actor.id]: hashPassword(next)}, dropSessionsFor: [actor.id], keepSession: session.user.sessionHash, keepUserId: actor.id});
      store.bump(db);
      return store.publicUser(actor);
    });
    return send(res, 200, {user: saved});
  }

  if (pathname === '/api/auth/me' && method === 'GET') {
    const session = requireUser(db, req);
    return send(res, 200, {user: store.publicUser(session.user)});
  }

  if (pathname === '/api/workspace' && method === 'GET') {
    const session = requireUser(db, req);
    return send(res, 200, workspacePayload(db, session.user));
  }

  if (pathname === '/api/workspace' && method === 'PUT') {
    const session = requireUser(db, req);
    const body = await readJson(req);
    if (!body.state || typeof body.state !== 'object') throw new HttpError(400, 'Нет данных для сохранения');
    return send(res, 200, mergeWorkspace(db, session.user, body.revision, body.state));
  }

  if (pathname === '/api/users' && method === 'GET') {
    const session = requireUser(db, req);
    return send(res, 200, {users: visible(db, session.user).users});
  }

  if (pathname === '/api/users' && method === 'POST') {
    const session = requireUser(db, req);
    const body = await readJson(req, 64 * 1024);
    const saved = await editWorkspace(db, session, draft => {
      draft.users.push({id: crypto.randomUUID(), name: body.name, login: body.login, password: body.password, role: body.role || 'sales', active: body.active !== false, permissionOverrides: body.permissionOverrides || {}, permissionsUntil: body.permissionsUntil || '', assignmentCategory: body.assignmentCategory || ''});
    });
    return send(res, 201, saved);
  }

  if (pathname === '/api/clients' && method === 'GET') {
    const session = requireUser(db, req);
    return send(res, 200, {clients: visible(db, session.user).clients});
  }

  const clientMatch = pathname.match(/^\/api\/clients\/([^/]+)$/);
  if (clientMatch && method === 'GET') {
    const session = requireUser(db, req);
    const client = visible(db, session.user).clients.find(item => item.id === decodeURIComponent(clientMatch[1]));
    if (!client) throw new HttpError(404, 'Клиент не найден');
    return send(res, 200, {client});
  }
  if (clientMatch && method === 'PATCH') {
    const session = requireUser(db, req);
    const body = await readJson(req);
    const id = decodeURIComponent(clientMatch[1]);
    const saved = await editWorkspace(db, session, draft => {
      const client = draft.clients.find(item => item.id === id);
      if (!client) throw new HttpError(404, 'Клиент не найден');
      Object.assign(client, body, {id});
      return {client};
    });
    return send(res, 200, saved);
  }
  if (pathname === '/api/clients' && method === 'POST') {
    const session = requireUser(db, req);
    const body = await readJson(req);
    const id = crypto.randomUUID();
    const saved = await editWorkspace(db, session, draft => {
      const pipeline = draft.pipelines.find(item => item.id === (body.pipelineId || draft.pipelines[0]?.id)) || draft.pipelines[0];
      draft.clients.push({notes: [], stageHistory: [], ...body, id, pipelineId: body.pipelineId || pipeline?.id, stageId: body.stageId || pipeline?.stages?.[0]?.id, ownerId: body.ownerId || ''});
      return {id};
    });
    return send(res, 201, saved);
  }

  if (pathname === '/api/lead-batches' && method === 'GET') {
    const session = requireUser(db, req);
    return send(res, 200, {leadBatches: visible(db, session.user).leadBatches});
  }
  if (pathname === '/api/lead-batches/import' && method === 'POST') {
    const session = requireUser(db, req);
    return send(res, 201, service.importLeads(db, session.user, await readJson(req)));
  }
  const batchAction = pathname.match(/^\/api\/lead-batches\/([^/]+)\/(distribute|promote|group|archive|restore)$/);
  if (batchAction && method === 'POST') {
    const session = requireUser(db, req);
    const id = decodeURIComponent(batchAction[1]);
    const body = await readJson(req);
    const action = batchAction[2];
    const result = action === 'distribute' ? service.distributeBatch(db, session.user, id, body) : action === 'promote' ? service.promoteBatch(db, session.user, id, body) : action === 'archive' ? service.archiveBatch(db, session.user, id) : action === 'restore' ? service.restoreBatch(db, session.user, id) : service.groupBatch(db, session.user, id, body);
    return send(res, 200, result);
  }

  if (pathname === '/api/pipelines' && method === 'GET') {
    const session = requireUser(db, req);
    return send(res, 200, {pipelines: visible(db, session.user).pipelines});
  }
  if (pathname === '/api/pipelines' && method === 'POST') {
    const session = requireUser(db, req);
    const body = await readJson(req, 64 * 1024);
    const saved = await editWorkspace(db, session, draft => {
      draft.pipelines.push({id: crypto.randomUUID(), name: body.name, stages: [{id: crypto.randomUUID(), name: 'Новый', kind: 'open'}]});
    });
    return send(res, 201, saved);
  }

  if (pathname === '/api/projects' && method === 'GET') {
    const session = requireUser(db, req);
    return send(res, 200, {projects: visible(db, session.user).projects});
  }
  const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (projectMatch && method === 'GET') {
    const session = requireUser(db, req);
    const project = visible(db, session.user).projects.find(item => item.id === decodeURIComponent(projectMatch[1]));
    if (!project) throw new HttpError(404, 'Проект не найден');
    return send(res, 200, {project});
  }
  if (pathname === '/api/projects' && method === 'POST') {
    const session = requireUser(db, req);
    const body = await readJson(req);
    const saved = await editWorkspace(db, session, draft => {
      draft.projects.push({recipients: [], board: {notes: [], links: [], comments: []}, mockup: {name: '', data: ''}, members: [], status: 'Проектирование', type: 'crm', ...body, id: crypto.randomUUID()});
    });
    return send(res, 201, saved);
  }
  if (projectMatch && method === 'PATCH') {
    const session = requireUser(db, req);
    const body = await readJson(req);
    const id = decodeURIComponent(projectMatch[1]);
    const saved = await editWorkspace(db, session, draft => {
      const project = draft.projects.find(item => item.id === id);
      if (!project) throw new HttpError(404, 'Проект не найден');
      Object.assign(project, body, {id});
    });
    return send(res, 200, saved);
  }

  if (pathname === '/api/tasks' && method === 'GET') {
    const session = requireUser(db, req);
    return send(res, 200, {tasks: visible(db, session.user).tasks});
  }
  const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (taskMatch && method === 'GET') {
    const session = requireUser(db, req);
    const task = visible(db, session.user).tasks.find(item => item.id === decodeURIComponent(taskMatch[1]));
    if (!task) throw new HttpError(404, 'Задача не найдена');
    return send(res, 200, {task});
  }
  if (pathname === '/api/tasks' && method === 'POST') {
    const session = requireUser(db, req);
    const body = await readJson(req);
    const saved = await editWorkspace(db, session, draft => {
      draft.tasks.push({type: 'work', estimate: 1, remaining: 1, assigneeId: '', ...body, id: crypto.randomUUID()});
    });
    return send(res, 201, saved);
  }
  if (taskMatch && method === 'PATCH') {
    const session = requireUser(db, req);
    const body = await readJson(req);
    const id = decodeURIComponent(taskMatch[1]);
    const saved = await editWorkspace(db, session, draft => {
      const task = draft.tasks.find(item => item.id === id);
      if (!task) throw new HttpError(404, 'Задача не найдена');
      Object.assign(task, body, {id});
    });
    return send(res, 200, saved);
  }

  if (pathname === '/api/materials' && method === 'GET') {
    const session = requireUser(db, req);
    const projectId = url.searchParams.get('projectId');
    let materials = visible(db, session.user).materials;
    if (projectId) materials = materials.filter(item => item.projectId === projectId);
    return send(res, 200, {materials});
  }
  if (pathname === '/api/materials' && method === 'POST') {
    const session = requireUser(db, req);
    const body = await readJson(req);
    const saved = await editWorkspace(db, session, draft => {
      draft.materials.push({...body, id: crypto.randomUUID(), createdBy: session.user.id, createdAt: M.today()});
    });
    return send(res, 201, saved);
  }

  if (pathname === '/api/messages' && method === 'GET') {
    const session = requireUser(db, req);
    const projectId = url.searchParams.get('projectId');
    let messages = visible(db, session.user).messages;
    if (projectId) messages = messages.filter(item => item.projectId === projectId);
    return send(res, 200, {messages});
  }
  if (pathname === '/api/messages' && method === 'POST') {
    const session = requireUser(db, req);
    const body = await readJson(req);
    const saved = await editWorkspace(db, session, draft => {
      draft.messages.push({...body, id: crypto.randomUUID(), from: session.user.id, at: new Date().toISOString()});
    });
    return send(res, 201, saved);
  }

  const fileMatch = pathname.match(/^\/api\/files\/([^/]+)$/);
  if (fileMatch && method === 'PUT') {
    const session = requireUser(db, req);
    const id = decodeURIComponent(fileMatch[1]);
    if (!/^[A-Za-z0-9._-]{8,80}$/.test(id)) throw new HttpError(400, 'Некорректный идентификатор файла');
    const projectId = String(req.headers['x-project-id'] || '');
    if (!projectId) throw new HttpError(400, 'Не указан проект');
    const state = store.load(db);
    const actor = state.users.find(item => item.id === session.user.id);
    if (!M.canProject(state, actor, projectId)) throw new HttpError(403, 'Нет доступа к файлу проекта');
    const bytes = await readBody(req, 20 * 1024 * 1024);
    if (!bytes.length) throw new HttpError(400, 'Пустой файл');
    let name = 'file';
    try { name = decodeURIComponent(String(req.headers['x-file-name'] || 'file')); } catch { name = 'file'; }
    name = path.basename(name).slice(0, 180) || 'file';
    store.putFile(db, {id, projectId, name, mime: String(req.headers['content-type'] || 'application/octet-stream').slice(0, 120), bytes, createdBy: actor.id, createdAt: new Date().toISOString()});
    return send(res, 201, {id, name});
  }
  if (fileMatch && method === 'GET') {
    const session = requireUser(db, req);
    const file = store.getFile(db, decodeURIComponent(fileMatch[1]));
    if (!file) throw new HttpError(404, 'Файл не найден');
    const state = store.load(db);
    const actor = state.users.find(item => item.id === session.user.id);
    if (!M.canProject(state, actor, file.project_id)) throw new HttpError(403, 'Нет доступа к файлу проекта');
    res.writeHead(200, {'Content-Type': file.mime || 'application/octet-stream', 'Content-Length': file.bytes.length, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff'});
    return res.end(file.bytes);
  }

  if (pathname === '/api/integration-keys' && method === 'GET') {
    const session = requireUser(db, req);
    return send(res, 200, {keys: service.listIntegrationKeys(db, session.user)});
  }
  if (pathname === '/api/integration-keys' && method === 'POST') {
    const session = requireUser(db, req);
    const body = await readJson(req, 32 * 1024);
    return send(res, 201, service.createIntegrationKey(db, session.user, body.name, body.scope));
  }
  const keyMatch = pathname.match(/^\/api\/integration-keys\/([^/]+)$/);
  if (keyMatch && method === 'DELETE') {
    const session = requireUser(db, req);
    return send(res, 200, service.revokeIntegrationKey(db, session.user, decodeURIComponent(keyMatch[1])));
  }

  if (pathname === '/api/mailing-selections' && method === 'GET') {
    const session = requireUser(db, req);
    return send(res, 200, {selections: service.istok.listSelections(db, session.user)});
  }
  if (pathname === '/api/mailing-selections' && method === 'POST') {
    const session = requireUser(db, req);
    const body = await readJson(req, 64 * 1024);
    return send(res, 201, service.istok.createSelection(db, session.user, body));
  }

  if (pathname === '/api/migration/export' && method === 'GET') {
    const session = requireUser(db, req);
    return send(res, 200, service.exportDump(db, session.user));
  }
  if (pathname === '/api/migration/import' && method === 'POST') {
    const session = requireUser(db, req);
    return send(res, 200, service.importDump(db, session.user, await readJson(req, 48 * 1024 * 1024)));
  }

  if (pathname.startsWith('/api/telegram')) {
    const session = requireUser(db, req);
    const bot = telegramByDb.get(db);
    if (!bot) throw new HttpError(500, 'Telegram не запущен');
    if (pathname === '/api/telegram/files' || pathname.startsWith('/api/telegram/files/')) {
      const id = decodeURIComponent(pathname.slice('/api/telegram/files/'.length));
      const file = await bot.file(session.user, id);
      const name = String(file.name || 'file').replace(/[\r\n"]/g, '_');
      res.writeHead(200, {'Content-Type': file.mime || 'application/octet-stream', 'Content-Length': file.bytes.length, 'Content-Disposition': 'attachment; filename="' + name + '"', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'});
      res.end(file.bytes);
      return;
    }
    if (pathname === '/api/telegram/badge' && method === 'GET') {
      const status = bot.status(session.user);
      return send(res, 200, {unread: status.unread, byProject: status.byProject || {}, linkedProjects: status.linkedProjects || []});
    }
    if (pathname === '/api/telegram' && method === 'GET') return send(res, 200, bot.overview(session.user));
    if (pathname === '/api/telegram/token' && method === 'POST') {
      const body = await readJson(req, 16 * 1024);
      return send(res, 200, bot.setToken(session.user, body.token));
    }
    if (pathname === '/api/telegram/token' && method === 'DELETE') return send(res, 200, bot.setToken(session.user, ''));
    if (pathname === '/api/telegram/link' && method === 'POST') {
      const body = await readJson(req, 16 * 1024);
      return send(res, 200, {chats: bot.linkChat(session.user, body.chatId, body.scope, body.projectId)});
    }
    if (pathname === '/api/telegram/unlink' && method === 'POST') {
      const body = await readJson(req, 16 * 1024);
      return send(res, 200, {chats: bot.unlinkChat(session.user, body.chatId)});
    }
    if (pathname === '/api/telegram/ask' && method === 'POST') {
      const body = await readJson(req, 8 * 1024);
      return send(res, 200, bot.askLink(session.user, body.scope, body.projectId));
    }
    if (pathname === '/api/telegram/project-send' && method === 'POST') {
      const body = await readJson(req, 16 * 1024);
      return send(res, 200, await bot.sendProject(session.user, body.projectId, body.text, body.confirmTo));
    }
    if (pathname === '/api/telegram/client-send' && method === 'POST') {
      const body = await readJson(req, 32 * 1024);
      try {
        return send(res, 200, await outbound.sendTelegram(db, session.user, bot, body));
      } catch (error) {
        if (error.payload) return send(res, error.status || 400, {error: error.message, ...error.payload});
        throw error;
      }
    }
    if (pathname === '/api/telegram/messages' && method === 'GET') return send(res, 200, {messages: bot.messages(session.user, url.searchParams.get('chatId'))});
    if (pathname === '/api/telegram/messages' && method === 'POST') {
      const body = await readJson(req, 32 * 1024);
      return send(res, 200, {messages: await bot.send(session.user, body.chatId, body.text)});
    }
    if (pathname === '/api/telegram/read' && method === 'POST') {
      const body = await readJson(req, 8 * 1024);
      return send(res, 200, bot.markRead(session.user, body.chatId));
    }
    if (pathname === '/api/telegram/mock' && method === 'POST') {
      if (!bot.memory) throw new HttpError(404, 'Не найдено');
      if (session.user.role !== 'admin') throw new HttpError(403, 'Только администратор');
      const body = await readJson(req, 64 * 1024);
      bot.applyUpdate(body.update || body);
      return send(res, 200, {ok: true});
    }
    if (pathname === '/api/telegram/mock-sent' && method === 'GET') {
      if (!bot.memory) throw new HttpError(404, 'Не найдено');
      if (session.user.role !== 'admin') throw new HttpError(403, 'Только администратор');
      return send(res, 200, {sent: bot.memory.sent});
    }
  }

  if (pathname === '/api/kp' && method === 'GET') {
    requireUser(db, req);
    return send(res, 200, {template: kp.templateOf(db), catalogue: kp.catalogueOf(db)});
  }
  if (pathname === '/api/kp/template' && method === 'PUT') {
    const session = requireUser(db, req);
    return send(res, 200, kp.saveTemplate(db, session.user, await readJson(req, 64 * 1024)));
  }
  if (pathname === '/api/kp/catalogue' && method === 'PUT') {
    const session = requireUser(db, req);
    return send(res, 200, kp.saveCatalogue(db, session.user, await readJson(req, 128 * 1024)));
  }
  if (pathname === '/api/kp/preview' && method === 'POST') {
    const session = requireUser(db, req);
    return send(res, 200, kp.preview(db, session.user, await readJson(req, 128 * 1024)));
  }
  if (pathname === '/api/kp/documents' && method === 'POST') {
    const session = requireUser(db, req);
    return send(res, 200, kp.saveDocument(db, session.user, await readJson(req, 128 * 1024)));
  }
  if (pathname === '/api/kp/send' && method === 'POST') {
    const session = requireUser(db, req);
    return send(res, 200, await kp.sendProposal(db, session.user, currentMailer(cfg), await readJson(req, 64 * 1024)));
  }
  if (pathname === '/api/kp/suggest' && method === 'POST') {
    requireUser(db, req);
    return send(res, 200, kp.suggestProposal());
  }
  const kpFile = pathname.match(/^\/api\/kp\/files\/([^/]+)$/);
  if (kpFile && method === 'GET') {
    const session = requireUser(db, req);
    const file = kp.fileFor(db, session.user, decodeURIComponent(kpFile[1]));
    res.writeHead(200, {'Content-Type': 'application/pdf', 'Content-Length': file.bytes.length, 'Content-Disposition': 'inline; filename="' + file.name + '"', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff'});
    return res.end(file.bytes);
  }

  if (pathname === '/api/pitch' && method === 'GET') {
    requireUser(db, req);
    return send(res, 200, {template: pitch.templateOf(db)});
  }
  if (pathname === '/api/pitch/template' && method === 'PUT') {
    const session = requireUser(db, req);
    return send(res, 200, pitch.saveTemplate(db, session.user, await readJson(req, 32 * 1024)));
  }
  if (pathname === '/api/pitch/preview' && method === 'POST') {
    const session = requireUser(db, req);
    return send(res, 200, pitch.previewDeck(db, session.user, await readJson(req, 64 * 1024)));
  }
  if (pathname === '/api/pitch/documents' && method === 'POST') {
    const session = requireUser(db, req);
    return send(res, 200, pitch.saveDeck(db, session.user, await readJson(req, 64 * 1024)));
  }
  if (pathname === '/api/pitch/send' && method === 'POST') {
    const session = requireUser(db, req);
    return send(res, 200, await pitch.sendDeck(db, session.user, currentMailer(cfg), await readJson(req, 32 * 1024)));
  }
  if (pathname === '/api/pitch/suggest' && method === 'POST') {
    requireUser(db, req);
    return send(res, 200, pitch.suggestDeck());
  }
  const pitchFile = pathname.match(/^\/api\/pitch\/files\/([^/]+)$/);
  if (pitchFile && method === 'GET') {
    const session = requireUser(db, req);
    const file = pitch.fileFor(db, session.user, decodeURIComponent(pitchFile[1]));
    res.writeHead(200, {'Content-Type': 'application/pdf', 'Content-Length': file.bytes.length, 'Content-Disposition': 'inline; filename="' + file.name + '"', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff'});
    return res.end(file.bytes);
  }
  if (pathname === '/api/payments/invoice' && method === 'POST') {
    const session = requireUser(db, req);
    return send(res, 200, pitch.addInvoice(db, session.user, await readJson(req, 16 * 1024)));
  }
  if (pathname === '/api/payments' && method === 'POST') {
    const session = requireUser(db, req);
    return send(res, 200, pitch.addPayment(db, session.user, await readJson(req, 16 * 1024)));
  }

  if (pathname === '/api/mail' && method === 'GET') {
    requireUser(db, req);
    const settings = currentMailer(cfg).settings;
    return send(res, 200, {configured: settings.configured, from: settings.configured ? settings.from : '', fromName: settings.fromName});
  }
  if (pathname === '/api/mail/test' && method === 'POST') {
    const session = requireUser(db, req);
    const body = await readJson(req, 8 * 1024);
    return send(res, 200, await outbound.testMail(session.user, currentMailer(cfg), body));
  }
  if (pathname === '/api/sipuni' && method === 'GET') {
    const session = requireUser(db, req);
    return send(res, 200, sipuniByDb.get(db).feed(session.user));
  }
  if (pathname === '/api/sipuni/call' && method === 'POST') {
    const session = requireUser(db, req);
    const body = await readJson(req, 16 * 1024);
    return send(res, 200, await sipuniByDb.get(db).callClient(session.user, body));
  }
  if (pathname === '/api/sipuni/test' && method === 'POST') {
    const session = requireUser(db, req);
    return send(res, 200, await sipuniByDb.get(db).test(session.user));
  }
  if (pathname === '/api/sipuni/seen' && method === 'POST') {
    const session = requireUser(db, req);
    const body = await readJson(req, 8 * 1024);
    return send(res, 200, sipuniByDb.get(db).seen(session.user, body.clientId));
  }
  if (pathname === '/api/sipuni/lead' && method === 'POST') {
    const session = requireUser(db, req);
    const body = await readJson(req, 16 * 1024);
    return send(res, 200, sipuniByDb.get(db).createLead(session.user, body));
  }
  if (pathname === '/api/sipuni/record' && method === 'GET') {
    const session = requireUser(db, req);
    const file = await sipuniByDb.get(db).recordFor(session.user, url.searchParams.get('id'));
    res.writeHead(200, {'Content-Type': file.mime, 'Content-Length': file.bytes.length, 'Cache-Control': 'private, no-store', 'Content-Disposition': 'inline; filename="call.mp3"', 'X-Content-Type-Options': 'nosniff'});
    res.end(file.bytes);
    return;
  }

  if (pathname === '/api/mail/send' && method === 'POST') {
    const session = requireUser(db, req);
    const body = await readJson(req, 64 * 1024);
    try {
      return send(res, 200, await outbound.sendEmail(db, session.user, currentMailer(cfg), body));
    } catch (error) {
      if (error.payload) return send(res, error.status || 400, {error: error.message, ...error.payload});
      throw error;
    }
  }

  if (method === 'GET' || method === 'HEAD') {
    const file = staticPath(pathname);
    if (!file) {
      res.writeHead(404, {'Content-Type': 'text/plain; charset=utf-8'});
      return res.end('Не найдено');
    }
    const data = fs.readFileSync(file);
    res.writeHead(method === 'HEAD' ? 200 : 200, {'Content-Type': types[path.extname(file)], 'Content-Length': data.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'});
    return res.end(method === 'HEAD' ? undefined : data);
  }

  throw new HttpError(404, 'Не найдено');
}

function handler(db, cfg, req, res) {
  route(req, res, db, cfg).catch(error => {
    const wrapped = error instanceof HttpError ? error : domainError(error);
    const status = wrapped.status || 500;
    if (status >= 500) console.error(error);
    if (!res.headersSent) send(res, status, {error: status >= 500 ? 'Внутренняя ошибка сервера' : wrapped.message});
  });
}

function start(overrides = {}) {
  const cfg = {...config(), ...overrides};
  const exposure = assertExposure(cfg);
  cfg.host = exposure.host;
  cfg.port = exposure.port;
  const db = openDatabase(cfg.databasePath);
  migrate(db);
  ensureBoot(db, cfg);
  const telegram = createTelegram({db, M, store, fetchImpl: globalThis.fetch, envToken: cfg.telegramBotToken || '', mock: cfg.telegramMock === true || cfg.telegramMock === '1'});
  telegramByDb.set(db, telegram);
  const sipuni = createSipuni({
    db, M,
    user: cfg.sipuniUser || '',
    secret: cfg.sipuniSecret || '',
    webhookToken: cfg.sipuniWebhookToken || '',
    mock: cfg.sipuniMock === true || cfg.sipuniMock === '1',
    fetchImpl: cfg.sipuniFetch,
    sync: cfg.sipuniSync !== false,
  });
  sipuniByDb.set(db, sipuni);
  sipuni.start();
  if (cfg.telegramMockSeed === true || cfg.telegramMockSeed === '1') telegram.seedDemo();
  if (cfg.telegramPoll !== false) telegram.start();
  const server = http.createServer((req, res) => handler(db, cfg, req, res));
  server.requestTimeout = 0;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, cfg.host, () => {
      const port = server.address().port;
      resolve({
        server, db, cfg: {...cfg, port}, port, telegram, sipuni, exposure,
        url: `http://${cfg.host}:${port}`,
        close() {
          telegram.stop();
          sipuni.stop();
          return new Promise((done, fail) => server.close(error => error ? fail(error) : done())).finally(() => db.close());
        },
      });
    });
  });
}

module.exports = {start, handler};
