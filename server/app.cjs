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

const root = path.join(__dirname, '..', 'variant-b');
const types = {'.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon'};
const fails = new Map();
let dummyHash = '';

function cookie(token, cfg, clear = false) {
  const parts = [`ap_session=${clear ? '' : encodeURIComponent(token)}`, 'HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${clear ? 0 : cfg.sessionDays * 86400}`];
  if (cfg.cookieSecure) parts.push('Secure');
  return parts.join('; ');
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return '';
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

function tooMany(key) {
  const now = Date.now();
  const row = fails.get(key) || {n: 0, at: now};
  if (now - row.at > 15 * 60 * 1000) { row.n = 0; row.at = now; }
  fails.set(key, row);
  return row.n >= 20;
}

function markFail(key) {
  const row = fails.get(key) || {n: 0, at: Date.now()};
  row.n += 1;
  fails.set(key, row);
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
    const key = service.findIntegrationKey(db, header || bearer);
    if (!key) throw new HttpError(401, 'Неверный ключ интеграции');
    const body = await readJson(req);
    return send(res, 200, service.ingestLeads(db, key, body, cfg));
  }

  if (pathname.startsWith('/api/') && method !== 'GET' && method !== 'HEAD') assertBrowser(req);

  if (pathname === '/api/auth/login' && method === 'POST') {
    const body = await readJson(req, 32 * 1024);
    const login = String(body.login || '').trim().toLowerCase();
    const ip = req.socket.remoteAddress || '';
    if (tooMany(ip + ':' + login)) throw new HttpError(429, 'Слишком много попыток. Подождите и попробуйте снова.');
    const found = store.findUserByLogin(db, login);
    const hash = found?.password_hash || (dummyHash ||= hashPassword('not-a-real-password'));
    const ok = verifyPassword(body.password || '', hash) && !!found;
    if (!ok) {
      markFail(ip + ':' + login);
      throw new HttpError(401, 'Неверный логин или пароль');
    }
    fails.delete(ip + ':' + login);
    db.run('DELETE FROM sessions WHERE expires_at <= ?', new Date().toISOString());
    const token = store.createSession(db, found.id, cfg.sessionDays);
    return send(res, 200, {user: store.publicUser(found.user)}, {'Set-Cookie': cookie(token, cfg)});
  }

  if (pathname === '/api/auth/logout' && method === 'POST') {
    store.deleteSession(db, readCookie(req, 'ap_session'));
    return send(res, 200, {ok: true}, {'Set-Cookie': cookie('', cfg, true)});
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
  const batchAction = pathname.match(/^\/api\/lead-batches\/([^/]+)\/(distribute|promote|group)$/);
  if (batchAction && method === 'POST') {
    const session = requireUser(db, req);
    const id = decodeURIComponent(batchAction[1]);
    const body = await readJson(req);
    const action = batchAction[2];
    const result = action === 'distribute' ? service.distributeBatch(db, session.user, id, body) : action === 'promote' ? service.promoteBatch(db, session.user, id, body) : service.groupBatch(db, session.user, id, body);
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
    return send(res, 201, service.createIntegrationKey(db, session.user, body.name));
  }
  const keyMatch = pathname.match(/^\/api\/integration-keys\/([^/]+)$/);
  if (keyMatch && method === 'DELETE') {
    const session = requireUser(db, req);
    return send(res, 200, service.revokeIntegrationKey(db, session.user, decodeURIComponent(keyMatch[1])));
  }

  if (pathname === '/api/migration/export' && method === 'GET') {
    const session = requireUser(db, req);
    return send(res, 200, service.exportDump(db, session.user));
  }
  if (pathname === '/api/migration/import' && method === 'POST') {
    const session = requireUser(db, req);
    return send(res, 200, service.importDump(db, session.user, await readJson(req, 48 * 1024 * 1024)));
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
  if (!Number.isFinite(cfg.port)) cfg.port = 3212;
  const db = openDatabase(cfg.databasePath);
  migrate(db);
  ensureBoot(db, cfg);
  const server = http.createServer((req, res) => handler(db, cfg, req, res));
  server.requestTimeout = 0;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, cfg.host, () => {
      const port = server.address().port;
      resolve({
        server, db, cfg: {...cfg, port}, port,
        url: `http://${cfg.host}:${port}`,
        close() {
          return new Promise((done, fail) => server.close(error => error ? fail(error) : done())).finally(() => db.close());
        },
      });
    });
  });
}

module.exports = {start, handler};
