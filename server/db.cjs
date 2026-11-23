const fs = require('node:fs');
const path = require('node:path');
const {DatabaseSync} = require('node:sqlite');

// Схема на обычном SQL: TEXT/INTEGER/BLOB.
// При переходе на PostgreSQL BLOB станет BYTEA, а плейсхолдеры "?" — "$1".
// Вся работа с базой идёт через этот файл, поэтому остальной код менять почти не придётся.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  login TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS role_permissions (
  role TEXT PRIMARY KEY,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS permission_audit (
  seq INTEGER PRIMARY KEY,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pipelines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  position INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  leader_id TEXT NOT NULL DEFAULT '',
  dev_stage TEXT NOT NULL DEFAULT '',
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS project_members (
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (project_id, user_id)
);
CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL DEFAULT '',
  pipeline_id TEXT NOT NULL DEFAULT '',
  stage_id TEXT NOT NULL DEFAULT '',
  project_id TEXT NOT NULL DEFAULT '',
  batch_id TEXT NOT NULL DEFAULT '',
  in_lead_base INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_clients_owner ON clients(owner_id);
CREATE INDEX IF NOT EXISTS idx_clients_batch ON clients(batch_id);
CREATE TABLE IF NOT EXISTS contact_keys (
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  client_id TEXT NOT NULL,
  PRIMARY KEY (kind, value)
);
CREATE INDEX IF NOT EXISTS idx_contact_client ON contact_keys(client_id);
CREATE TABLE IF NOT EXISTS lead_batches (
  id TEXT PRIMARY KEY,
  pipeline_id TEXT NOT NULL DEFAULT '',
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  assignee_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id);
CREATE TABLE IF NOT EXISTS materials (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS communications (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS voice_campaigns (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL DEFAULT '',
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messenger_channels (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL DEFAULT '',
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS external_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes BLOB NOT NULL,
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS integration_api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS integration_imports (
  id TEXT PRIMARY KEY,
  key_id TEXT,
  source TEXT NOT NULL,
  received INTEGER NOT NULL,
  created_count INTEGER NOT NULL,
  duplicate_count INTEGER NOT NULL,
  error_count INTEGER NOT NULL,
  batch_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
-- Задел под рассылки. Отправка писем и сообщений намеренно не реализована.
CREATE TABLE IF NOT EXISTS mailings (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  channel TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  body TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  CHECK (status = 'draft')
);
`;

function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), {recursive: true});
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  return wrap(db);
}

function wrap(raw) {
  return {
    raw,
    exec(sql) { raw.exec(sql); },
    get(sql, ...params) {
      const row = raw.prepare(sql).get(...params);
      return row ? Object.assign({}, row) : undefined;
    },
    all(sql, ...params) {
      return raw.prepare(sql).all(...params).map(row => Object.assign({}, row));
    },
    run(sql, ...params) {
      return raw.prepare(sql).run(...params);
    },
    transaction(fn) {
      raw.exec('BEGIN IMMEDIATE');
      try {
        const result = fn();
        raw.exec('COMMIT');
        return result;
      } catch (error) {
        try { raw.exec('ROLLBACK'); } catch { /* уже откатили */ }
        throw error;
      }
    },
    close() { raw.close(); },
  };
}

function migrate(db) {
  db.exec(SCHEMA);
  const done = db.get('SELECT id FROM schema_migrations WHERE id = ?', '001-initial');
  if (!done) db.run('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)', '001-initial', new Date().toISOString());
  // Старые базы созданы без колонки этапа разработки. Новые получают её сразу в SCHEMA.
  const projectColumns = db.all('PRAGMA table_info(projects)').map(column => column.name);
  if (!projectColumns.includes('dev_stage')) db.exec("ALTER TABLE projects ADD COLUMN dev_stage TEXT NOT NULL DEFAULT ''");
  db.exec('CREATE INDEX IF NOT EXISTS idx_projects_dev_stage ON projects(dev_stage)');
  const delivery = db.get('SELECT id FROM schema_migrations WHERE id = ?', '002-delivery-board');
  if (!delivery) db.run('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)', '002-delivery-board', new Date().toISOString());
  // Сам этап хранится в JSON воронки и добавляется в upgrade. Здесь только отметка, что миграция известна базе.
  const proposal = db.get('SELECT id FROM schema_migrations WHERE id = ?', '003-proposal-stage');
  if (!proposal) db.run('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)', '003-proposal-stage', new Date().toISOString());
  db.exec(`
    CREATE TABLE IF NOT EXISTS telegram_chats (
      chat_id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      username TEXT NOT NULL DEFAULT '',
      chat_type TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS telegram_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      tg_user_id TEXT NOT NULL DEFAULT '',
      tg_username TEXT NOT NULL DEFAULT '',
      tg_name TEXT NOT NULL DEFAULT '',
      crm_user_id TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'text',
      file_id TEXT NOT NULL DEFAULT '',
      file_name TEXT NOT NULL DEFAULT '',
      reply_to TEXT NOT NULL DEFAULT '',
      edited INTEGER NOT NULL DEFAULT 0,
      sent_at TEXT NOT NULL,
      UNIQUE (chat_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_tg_messages_chat ON telegram_messages (chat_id, id);
    CREATE TABLE IF NOT EXISTS telegram_reads (
      user_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      last_id INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, chat_id)
    );
    CREATE TABLE IF NOT EXISTS telegram_links (
      scope TEXT NOT NULL,
      project_id TEXT NOT NULL DEFAULT '',
      chat_id TEXT NOT NULL,
      PRIMARY KEY (scope, project_id)
    );
  `);
  const telegram = db.get('SELECT id FROM schema_migrations WHERE id = ?', '004-telegram');
  if (!telegram) db.run('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)', '004-telegram', new Date().toISOString());
  db.exec(`
    CREATE TABLE IF NOT EXISTS sipuni_calls (
      call_id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL DEFAULT '',
      owner_id TEXT NOT NULL DEFAULT '',
      direction TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '',
      duration INTEGER NOT NULL DEFAULT 0,
      record_id TEXT NOT NULL DEFAULT '',
      record_url TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      extension TEXT NOT NULL DEFAULT '',
      missed INTEGER NOT NULL DEFAULT 0,
      seen INTEGER NOT NULL DEFAULT 0,
      at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS sipuni_unknown (
      phone TEXT PRIMARY KEY,
      call_id TEXT NOT NULL DEFAULT '',
      at TEXT NOT NULL DEFAULT '',
      client_id TEXT NOT NULL DEFAULT ''
    );
  `);
  const sipuni = db.get('SELECT id FROM schema_migrations WHERE id = ?', '005-sipuni');
  if (!sipuni) db.run('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)', '005-sipuni', new Date().toISOString());
}

module.exports = {openDatabase, migrate, SCHEMA};
