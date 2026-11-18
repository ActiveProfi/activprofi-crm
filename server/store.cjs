const {contactKeys} = require('./contacts.cjs');
const {HttpError} = require('./errors.cjs');

const SETTING_KEYS = {
  schema: 'schema',
  leadsVersion: 'leads_version',
  manualFunnelVersion: 'manual_funnel_version',
  coldStageVersion: 'cold_stage_version',
  googleClientId: 'google_client_id',
};

function setting(db, key) {
  return db.get('SELECT value FROM app_settings WHERE key = ?', key)?.value;
}

function putSetting(db, key, value) {
  db.run('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value == null ? '' : String(value));
}

function revision(db) {
  return Number(setting(db, 'revision') || 0);
}

function setRevision(db, value) {
  putSetting(db, 'revision', value);
}

function bump(db) {
  const next = revision(db) + 1;
  setRevision(db, next);
  return next;
}

function parseRows(rows) {
  return rows.map(row => JSON.parse(row.data));
}

function load(db) {
  const state = {
    schema: Number(setting(db, 'schema') || 2),
    users: parseRows(db.all('SELECT data FROM users ORDER BY rowid')),
    pipelines: parseRows(db.all('SELECT data FROM pipelines ORDER BY position, rowid')),
    projects: parseRows(db.all('SELECT data FROM projects ORDER BY rowid')),
    clients: parseRows(db.all('SELECT data FROM clients ORDER BY rowid')),
    leadBatches: parseRows(db.all('SELECT data FROM lead_batches ORDER BY rowid')),
    tasks: parseRows(db.all('SELECT data FROM tasks ORDER BY rowid')),
    materials: parseRows(db.all('SELECT data FROM materials ORDER BY rowid')),
    messages: parseRows(db.all('SELECT data FROM messages ORDER BY rowid')),
    outbox: parseRows(db.all('SELECT data FROM outbox ORDER BY rowid')),
    communications: parseRows(db.all('SELECT data FROM communications ORDER BY rowid')),
    voiceCampaigns: parseRows(db.all('SELECT data FROM voice_campaigns ORDER BY rowid')),
    messengerChannels: parseRows(db.all('SELECT data FROM messenger_channels ORDER BY rowid')),
    conversations: parseRows(db.all('SELECT data FROM conversations ORDER BY rowid')),
    externalMessages: parseRows(db.all('SELECT data FROM external_messages ORDER BY rowid')),
    rolePermissions: Object.fromEntries(db.all('SELECT role, data FROM role_permissions').map(row => [row.role, JSON.parse(row.data)])),
    permissionAudit: parseRows(db.all('SELECT data FROM permission_audit ORDER BY seq')),
    googleClientId: setting(db, 'google_client_id') || '',
  };
  const leadsVersion = setting(db, 'leads_version');
  const manual = setting(db, 'manual_funnel_version');
  const cold = setting(db, 'cold_stage_version');
  if (leadsVersion) state.leadsVersion = Number(leadsVersion);
  if (manual) state.manualFunnelVersion = Number(manual);
  if (cold) state.coldStageVersion = Number(cold);
  for (const user of state.users) delete user.password;
  return state;
}

function userCount(db) {
  return db.get('SELECT COUNT(*) AS n FROM users').n;
}

function clearDomain(db) {
  for (const table of [
    'external_messages', 'conversations', 'messenger_channels', 'voice_campaigns', 'communications',
    'outbox', 'messages', 'materials', 'tasks', 'project_members', 'clients', 'contact_keys',
    'lead_batches', 'projects', 'pipelines', 'permission_audit', 'role_permissions', 'users',
  ]) db.exec(`DELETE FROM ${table}`);
}

function save(db, state, options = {}) {
  const passwords = options.passwords || {};
  const previous = new Map(db.all('SELECT id, login, password_hash FROM users').map(row => [row.id, row]));
  clearDomain(db);
  for (const user of state.users || []) {
    const prior = previous.get(user.id);
    const login = String(user.login || prior?.login || '').trim().toLowerCase();
    const passwordHash = passwords[user.id] || prior?.password_hash;
    if (!login || !passwordHash) throw new HttpError(400, 'У сотрудника должны быть логин и пароль');
    const data = {...user, login};
    delete data.password;
    delete data.password_hash;
    try {
      db.run(
        'INSERT INTO users (id, login, password_hash, role, active, data) VALUES (?, ?, ?, ?, ?, ?)',
        user.id, login, passwordHash, user.role || 'sales', user.active === false ? 0 : 1, JSON.stringify(data),
      );
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) throw new HttpError(409, 'Такой логин уже занят');
      throw error;
    }
  }
  (state.pipelines || []).forEach((item, index) => {
    db.run('INSERT INTO pipelines (id, name, position, data) VALUES (?, ?, ?, ?)', item.id, item.name || '', index, JSON.stringify(item));
  });
  for (const item of state.projects || []) {
    db.run('INSERT INTO projects (id, leader_id, dev_stage, data) VALUES (?, ?, ?, ?)', item.id, item.leaderId || '', item.devStage || '', JSON.stringify(item));
    for (const member of item.members || []) db.run('INSERT OR IGNORE INTO project_members (project_id, user_id) VALUES (?, ?)', item.id, member);
  }
  const seen = new Map();
  for (const item of state.clients || []) {
    for (const key of contactKeys(item)) {
      const token = key.kind + '\0' + key.value;
      if (seen.has(token)) throw new HttpError(409, 'Такой контакт уже есть в базе (телефон, email или профиль)');
      seen.set(token, item.id);
    }
    db.run(
      'INSERT INTO clients (id, owner_id, pipeline_id, stage_id, project_id, batch_id, in_lead_base, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      item.id, item.ownerId || '', item.pipelineId || '', item.stageId || '', item.project || '', item.batchId || '', item.inLeadBase ? 1 : 0, JSON.stringify(item),
    );
  }
  for (const [token, clientId] of seen) {
    const [kind, value] = token.split('\0');
    db.run('INSERT INTO contact_keys (kind, value, client_id) VALUES (?, ?, ?)', kind, value, clientId);
  }
  for (const item of state.leadBatches || []) db.run('INSERT INTO lead_batches (id, pipeline_id, data) VALUES (?, ?, ?)', item.id, item.pipelineId || '', JSON.stringify(item));
  for (const item of state.tasks || []) db.run('INSERT INTO tasks (id, project_id, assignee_id, status, data) VALUES (?, ?, ?, ?, ?)', item.id, item.projectId || '', item.assigneeId || '', item.status || '', JSON.stringify(item));
  for (const item of state.materials || []) db.run('INSERT INTO materials (id, project_id, data) VALUES (?, ?, ?)', item.id, item.projectId || '', JSON.stringify(item));
  for (const item of state.messages || []) db.run('INSERT INTO messages (id, project_id, data) VALUES (?, ?, ?)', item.id, item.projectId || '', JSON.stringify(item));
  for (const item of state.outbox || []) db.run('INSERT INTO outbox (id, project_id, data) VALUES (?, ?, ?)', item.id, item.projectId || '', JSON.stringify(item));
  for (const item of state.communications || []) db.run('INSERT INTO communications (id, data) VALUES (?, ?)', item.id, JSON.stringify(item));
  for (const item of state.voiceCampaigns || []) db.run('INSERT INTO voice_campaigns (id, owner_id, data) VALUES (?, ?, ?)', item.id, item.ownerId || '', JSON.stringify(item));
  for (const item of state.messengerChannels || []) db.run('INSERT INTO messenger_channels (id, data) VALUES (?, ?)', item.id, JSON.stringify(item));
  for (const item of state.conversations || []) db.run('INSERT INTO conversations (id, client_id, data) VALUES (?, ?, ?)', item.id, item.clientId || '', JSON.stringify(item));
  for (const item of state.externalMessages || []) db.run('INSERT INTO external_messages (id, conversation_id, data) VALUES (?, ?, ?)', item.id, item.conversationId || '', JSON.stringify(item));
  for (const [role, data] of Object.entries(state.rolePermissions || {})) db.run('INSERT INTO role_permissions (role, data) VALUES (?, ?)', role, JSON.stringify(data));
  (state.permissionAudit || []).forEach((item, index) => db.run('INSERT INTO permission_audit (seq, data) VALUES (?, ?)', index + 1, JSON.stringify(item)));
  putSetting(db, 'schema', state.schema || 2);
  if (state.leadsVersion) putSetting(db, 'leads_version', state.leadsVersion);
  if (state.manualFunnelVersion) putSetting(db, 'manual_funnel_version', state.manualFunnelVersion);
  if (state.coldStageVersion) putSetting(db, 'cold_stage_version', state.coldStageVersion);
  putSetting(db, 'google_client_id', state.googleClientId || '');
  for (const userId of options.dropSessionsFor || []) {
    if (options.keepSession && userId === options.keepUserId) {
      db.run('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?', userId, options.keepSession);
    } else db.run('DELETE FROM sessions WHERE user_id = ?', userId);
  }
}

function publicUser(user) {
  if (!user) return null;
  return {id: user.id, name: user.name, role: user.role, login: user.login || '', active: user.active !== false};
}

function createSession(db, userId, days) {
  const {newToken, hashToken} = require('./passwords.cjs');
  const token = newToken();
  const expires = new Date(Date.now() + days * 86400000).toISOString();
  db.run('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)', hashToken(token), userId, expires, new Date().toISOString());
  return token;
}

function readSession(db, token) {
  if (!token) return undefined;
  const {hashToken} = require('./passwords.cjs');
  const row = db.get('SELECT token_hash, user_id, expires_at FROM sessions WHERE token_hash = ?', hashToken(token));
  if (!row) return undefined;
  if (row.expires_at <= new Date().toISOString()) {
    db.run('DELETE FROM sessions WHERE token_hash = ?', row.token_hash);
    return undefined;
  }
  const user = db.get('SELECT data FROM users WHERE id = ?', row.user_id);
  if (!user) return undefined;
  return {tokenHash: row.token_hash, user: JSON.parse(user.data)};
}

function deleteSession(db, token) {
  if (!token) return;
  const {hashToken} = require('./passwords.cjs');
  db.run('DELETE FROM sessions WHERE token_hash = ?', hashToken(token));
}

function findUserByLogin(db, login) {
  const row = db.get('SELECT id, login, password_hash, data FROM users WHERE login = ?', String(login || '').trim().toLowerCase());
  if (!row) return undefined;
  return {...row, user: JSON.parse(row.data)};
}

function putFile(db, file) {
  db.run(
    'INSERT INTO files (id, project_id, name, mime, bytes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, name = excluded.name, mime = excluded.mime, bytes = excluded.bytes, created_by = excluded.created_by, created_at = excluded.created_at',
    file.id, file.projectId, file.name, file.mime, file.bytes, file.createdBy, file.createdAt,
  );
}

function getFile(db, id) {
  return db.get('SELECT id, project_id, name, mime, bytes, created_by, created_at FROM files WHERE id = ?', id);
}

function addIntegrationImport(db, row) {
  db.run(
    'INSERT INTO integration_imports (id, key_id, source, received, created_count, duplicate_count, error_count, batch_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    row.id, row.keyId || '', row.source || 'istok', row.received, row.created, row.duplicates, row.errors, row.batchId || '', row.createdAt,
  );
}

module.exports = {
  SETTING_KEYS, load, save, revision, setRevision, bump, userCount, publicUser,
  createSession, readSession, deleteSession, findUserByLogin, putFile, getFile, addIntegrationImport,
};
