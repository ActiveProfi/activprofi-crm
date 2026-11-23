const {HttpError} = require('./errors.cjs');

const GROUP_TYPES = new Set(['group', 'supergroup']);

function maskToken(token) {
  const value = String(token || '');
  if (!value) return '';
  if (value.length <= 6) return '••••';
  return '••••••••' + value.slice(-4);
}

function cleanTelegramLogin(value) {
  const raw = String(value || '').trim().replace(/^@/, '');
  if (!raw) return '';
  if (!/^([A-Za-z][A-Za-z0-9_]{4,31}|\d{3,20})$/.test(raw)) {
    throw new HttpError(400, 'Telegram: username от 5 символов или числовой id');
  }
  return raw;
}

function setting(db, key) {
  return db.get('SELECT value FROM app_settings WHERE key = ?', key)?.value || '';
}

function putSetting(db, key, value) {
  db.run('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value == null ? '' : String(value));
}

function displayName(from) {
  if (!from) return 'Telegram';
  return [from.first_name, from.last_name].filter(Boolean).join(' ').trim() || from.username || 'Telegram';
}

function describeMessage(message) {
  if (message.text) return {kind: 'text', text: String(message.text).slice(0, 4000), fileId: '', fileName: ''};
  if (Array.isArray(message.photo) && message.photo.length) {
    const photo = message.photo[message.photo.length - 1];
    return {kind: 'photo', text: String(message.caption || 'Фото').slice(0, 1000), fileId: photo.file_id || '', fileName: 'photo.jpg'};
  }
  if (message.document) {
    return {kind: 'file', text: String(message.caption || message.document.file_name || 'Файл').slice(0, 1000), fileId: message.document.file_id || '', fileName: message.document.file_name || 'file'};
  }
  if (message.caption) return {kind: 'text', text: String(message.caption).slice(0, 4000), fileId: '', fileName: ''};
  return {kind: 'text', text: 'Сообщение без текста', fileId: '', fileName: ''};
}

function createMemoryMock() {
  const queue = [];
  const sent = [];
  let nextId = 1;
  return {
    queue,
    sent,
    push(update) { queue.push(update); },
    async call(method, body) {
      if (method === 'getMe') return {ok: true, result: {id: 100, is_bot: true, username: 'activprofi_demo_bot', first_name: 'АктивПрофи'}};
      if (method === 'getUpdates') {
        const offset = Number(body?.offset || 0);
        const batch = queue.filter(item => item.update_id >= offset);
        for (const item of batch) {
          const index = queue.indexOf(item);
          if (index >= 0) queue.splice(index, 1);
        }
        return {ok: true, result: batch};
      }
      if (method === 'sendMessage') {
        const message = {
          message_id: nextId++,
          date: Math.floor(Date.now() / 1000),
          chat: {id: body.chat_id, type: 'supergroup'},
          text: body.text,
          from: {id: 100, is_bot: true, first_name: 'АктивПрофи'},
        };
        sent.push({chat_id: String(body.chat_id), text: body.text});
        return {ok: true, result: message};
      }
      if (method === 'getFile') return {ok: true, result: {file_id: body.file_id, file_path: 'docs/note.txt'}};
      return {ok: false, description: 'Метод не поддержан в учебном режиме'};
    },
  };
}

function createTelegram({db, M, store, fetchImpl, envToken = '', mock = false}) {
  const memory = mock ? createMemoryMock() : null;
  let stopped = false;
  let timer = null;
  let polling = false;
  let botUsername = memory ? 'CRM_ActivProfi_Bot' : '';

  function token() {
    const fromEnv = String(envToken || '').trim();
    if (fromEnv) return fromEnv;
    return String(setting(db, 'telegram_bot_token') || '').trim();
  }

  function connected() {
    return Boolean(memory || token());
  }

  async function call(method, body) {
    if (memory) return memory.call(method, body);
    const current = token();
    if (!current) throw new HttpError(400, 'Бот Telegram не подключён');
    let response;
    try {
      response = await fetchImpl('https://api.telegram.org/bot' + current + '/' + method, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body || {}),
      });
    } catch {
      throw new HttpError(502, 'Нет связи с Telegram');
    }
    let data = {};
    try { data = await response.json(); } catch { data = {}; }
    if (!data.ok) throw new HttpError(502, 'Telegram не принял запрос');
    return data;
  }

  function upsertChat(chat) {
    if (!chat || !GROUP_TYPES.has(chat.type)) return;
    const id = String(chat.id);
    const existing = db.get('SELECT title, username FROM telegram_chats WHERE chat_id = ?', id);
    const incomingTitle = String(chat.title || '').trim();
    const title = (incomingTitle || existing?.title || chat.username || 'Группа').slice(0, 200);
    const username = String(chat.username || existing?.username || '');
    db.run(
      'INSERT INTO telegram_chats (chat_id, title, username, chat_type, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET title = excluded.title, username = excluded.username, chat_type = excluded.chat_type, updated_at = excluded.updated_at',
      id, title, username, chat.type, new Date().toISOString(),
    );
  }

  function saveIncoming(message, edited) {
    if (!message?.chat || !GROUP_TYPES.has(message.chat.type)) return null;
    upsertChat(message.chat);
    const body = describeMessage(message);
    const from = message.from || {};
    const sentAt = new Date((message.edit_date || message.date || Math.floor(Date.now() / 1000)) * 1000).toISOString();
    const chatId = String(message.chat.id);
    const messageId = String(message.message_id);
    const replyTo = message.reply_to_message ? String(message.reply_to_message.message_id) : '';
    if (edited) {
      db.run(
        'UPDATE telegram_messages SET text = ?, kind = ?, file_id = ?, file_name = ?, edited = 1, sent_at = ? WHERE chat_id = ? AND message_id = ?',
        body.text, body.kind, body.fileId, body.fileName, sentAt, chatId, messageId,
      );
    }
    db.run(
      'INSERT INTO telegram_messages (chat_id, message_id, tg_user_id, tg_username, tg_name, crm_user_id, text, kind, file_id, file_name, reply_to, edited, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(chat_id, message_id) DO UPDATE SET text = excluded.text, edited = excluded.edited, sent_at = excluded.sent_at, kind = excluded.kind, file_id = excluded.file_id, file_name = excluded.file_name',
      chatId, messageId, from.id ? String(from.id) : '', String(from.username || ''), displayName(from), '', body.text, body.kind, body.fileId, body.fileName, replyTo, edited ? 1 : 0, sentAt,
    );
    return db.get('SELECT * FROM telegram_messages WHERE chat_id = ? AND message_id = ?', chatId, messageId);
  }

  function applyUpdate(update) {
    if (update.my_chat_member?.chat) upsertChat(update.my_chat_member.chat);
    if (update.edited_message) return saveIncoming(update.edited_message, true);
    if (update.message) return saveIncoming(update.message, false);
    return null;
  }

  async function refreshIdentity() {
    if (memory) {
      botUsername = 'CRM_ActivProfi_Bot';
      return botUsername;
    }
    if (!token()) return '';
    try {
      const data = await call('getMe', {});
      botUsername = String(data.result?.username || '');
    } catch {
      botUsername = botUsername || '';
    }
    return botUsername;
  }

  async function pollOnce() {
    if (!connected()) return {skipped: true};
    if (!botUsername) await refreshIdentity();
    const offset = Number(setting(db, 'telegram_update_offset') || 0);
    const data = await call('getUpdates', {offset, timeout: 0, allowed_updates: ['message', 'edited_message', 'my_chat_member']});
    const updates = Array.isArray(data.result) ? data.result : [];
    let next = offset;
    for (const update of updates) {
      applyUpdate(update);
      if (Number(update.update_id) + 1 > next) next = Number(update.update_id) + 1;
    }
    if (next !== offset) putSetting(db, 'telegram_update_offset', next);
    return {received: updates.length};
  }

  function state() {
    return store.load(db);
  }

  function linkRow(scope, projectId = '') {
    return db.get('SELECT scope, project_id, chat_id FROM telegram_links WHERE scope = ? AND project_id = ?', scope, projectId || '');
  }

  function chatById(chatId) {
    return db.get('SELECT chat_id, title, username, chat_type FROM telegram_chats WHERE chat_id = ?', String(chatId));
  }

  function projectIdForChat(chatId) {
    return db.get('SELECT project_id FROM telegram_links WHERE scope = ? AND chat_id = ?', 'project', String(chatId))?.project_id || '';
  }

  function canSeeChat(user, chatId) {
    const id = String(chatId || '');
    const team = linkRow('team');
    if (team && team.chat_id === id) return true;
    const projectId = projectIdForChat(id);
    if (!projectId) return false;
    return M.canProject(state(), user, projectId);
  }

  function assertSee(user, chatId) {
    if (!canSeeChat(user, chatId)) throw new HttpError(403, 'Этот чат вам недоступен');
  }

  function canLink(user, scope, projectId) {
    if (user.role === 'admin') return true;
    if (scope === 'project') return M.canManage(state(), user, projectId);
    return false;
  }

  function publicMessage(row, users) {
    const crm = row.crm_user_id ? users.find(item => item.id === row.crm_user_id) : null;
    const linked = users.find(item => {
      const key = String(item.telegram || '').replace(/^@/, '').toLowerCase();
      if (!key) return false;
      return key === String(row.tg_username || '').toLowerCase() || key === String(row.tg_user_id || '');
    });
    return {
      id: row.id,
      chatId: row.chat_id,
      messageId: row.message_id,
      author: crm?.name || linked?.name || row.tg_name || 'Telegram',
      username: row.tg_username || '',
      crmUserId: row.crm_user_id || linked?.id || '',
      text: row.text,
      kind: row.kind,
      fileName: row.file_name || '',
      hasFile: Boolean(row.file_id),
      replyTo: row.reply_to || '',
      edited: row.edited === 1,
      sentAt: row.sent_at,
      fromCrm: Boolean(row.crm_user_id),
    };
  }

  function unreadFor(userId, chatId) {
    const last = Number(db.get('SELECT last_id FROM telegram_reads WHERE user_id = ? AND chat_id = ?', userId, String(chatId))?.last_id || 0);
    return Number(db.get('SELECT COUNT(*) AS n FROM telegram_messages WHERE chat_id = ? AND id > ? AND crm_user_id != ?', String(chatId), last, userId)?.n || 0);
  }

  function canDiscover(user) {
    if (user.role === 'admin') return true;
    const snapshot = state();
    return (snapshot.projects || []).some(project => M.canManage(snapshot, user, project.id));
  }

  function visibleChats(user) {
    const snapshot = state();
    const discover = canDiscover(user);
    const chats = db.all('SELECT chat_id, title, username, chat_type, updated_at FROM telegram_chats ORDER BY updated_at DESC');
    const links = db.all('SELECT scope, project_id, chat_id FROM telegram_links');
    const projects = snapshot.projects || [];
    return chats.map(chat => {
      const link = links.find(item => item.chat_id === chat.chat_id) || null;
      const project = link?.scope === 'project' ? projects.find(item => item.id === link.project_id) : null;
      const visible = link?.scope === 'team' || (project ? M.canProject(snapshot, user, project.id) : false);
      if (!visible && !discover) return null;
      return {
        chatId: chat.chat_id,
        title: chat.title,
        username: chat.username || '',
        chatType: chat.chat_type,
        updatedAt: chat.updated_at,
        link: link ? {scope: link.scope, projectId: link.project_id, projectTitle: project?.title || ''} : null,
        unread: visible ? unreadFor(user.id, chat.chat_id) : 0,
        visible,
      };
    }).filter(Boolean);
  }

  function status(user) {
    const current = token();
    const team = linkRow('team');
    const chats = user ? visibleChats(user).filter(chat => chat.visible) : [];
    return {
      connected: connected(),
      mock: Boolean(memory),
      fromEnv: Boolean(String(envToken || '').trim()),
      botUsername: botUsername || (memory ? 'CRM_ActivProfi_Bot' : ''),
      masked: maskToken(current),
      teamChatId: team?.chat_id || '',
      unread: chats.reduce((sum, chat) => sum + chat.unread, 0),
      byProject: chats.reduce((bag, chat) => {
        if (chat.link?.scope === 'project' && chat.link.projectId) bag[chat.link.projectId] = (bag[chat.link.projectId] || 0) + chat.unread;
        return bag;
      }, {}),
    };
  }

  function linkRequests() {
    try {
      const parsed = JSON.parse(setting(db, 'telegram_link_requests') || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function askLink(user, scope, projectId = '') {
    if (scope !== 'team' && scope !== 'project') throw new HttpError(400, 'Укажите командный чат или проект');
    if (scope === 'project' && !M.canProject(state(), user, projectId)) throw new HttpError(403, 'Проект недоступен');
    const fresh = linkRequests().filter(item => Date.now() - Date.parse(item.at || 0) < 14 * 24 * 60 * 60 * 1000);
    const key = user.id + '|' + scope + '|' + (scope === 'team' ? '' : projectId);
    if (!fresh.some(item => item.userId + '|' + item.scope + '|' + (item.projectId || '') === key)) {
      const project = scope === 'project' ? M.project(state(), projectId) : null;
      fresh.push({userId: user.id, userName: user.name, scope, projectId: scope === 'team' ? '' : projectId, projectTitle: project?.title || '', at: new Date().toISOString()});
    }
    putSetting(db, 'telegram_link_requests', JSON.stringify(fresh.slice(-40)));
    return {ok: true};
  }

  function overview(user) {
    const snapshot = state();
    const projects = (snapshot.projects || []).filter(project => user.role === 'admin' || M.canManage(snapshot, user, project.id)).map(project => ({id: project.id, title: project.title}));
    return {...status(user), chats: visibleChats(user), projects, requests: user.role === 'admin' ? linkRequests() : []};
  }

  function setToken(user, value) {
    if (user.role !== 'admin') throw new HttpError(403, 'Токен сохраняет администратор');
    if (String(envToken || '').trim()) throw new HttpError(400, 'Токен задан в файле .env. Уберите его там, если хотите ввести здесь.');
    const next = String(value || '').trim();
    if (next && !/^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(next)) throw new HttpError(400, 'Похоже, это не токен бота');
    putSetting(db, 'telegram_bot_token', next);
    return status(user);
  }

  function linkChat(user, chatId, scope, projectId = '') {
    const id = String(chatId || '');
    const chat = chatById(id);
    if (!chat) throw new HttpError(404, 'Группа ещё не видна боту');
    if (scope !== 'team' && scope !== 'project') throw new HttpError(400, 'Выберите командный чат или проект');
    if (scope === 'project' && !projectId) throw new HttpError(400, 'Выберите проект');
    if (!canLink(user, scope, projectId)) throw new HttpError(403, 'Привязать группу может админ или руководитель этого проекта');
    if (scope === 'project' && !M.project(state(), projectId)) throw new HttpError(404, 'Проект не найден');
    db.run('DELETE FROM telegram_links WHERE chat_id = ?', id);
    db.run('INSERT INTO telegram_links (scope, project_id, chat_id) VALUES (?, ?, ?) ON CONFLICT(scope, project_id) DO UPDATE SET chat_id = excluded.chat_id', scope, scope === 'team' ? '' : projectId, id);
    return visibleChats(user);
  }

  function unlinkChat(user, chatId) {
    const id = String(chatId || '');
    const link = db.get('SELECT scope, project_id FROM telegram_links WHERE chat_id = ?', id);
    if (!link) return visibleChats(user);
    if (!canLink(user, link.scope, link.project_id)) throw new HttpError(403, 'Отвязать группу может админ или руководитель этого проекта');
    db.run('DELETE FROM telegram_links WHERE chat_id = ?', id);
    return visibleChats(user);
  }

  function messages(user, chatId) {
    assertSee(user, chatId);
    const users = state().users || [];
    const rows = db.all('SELECT * FROM telegram_messages WHERE chat_id = ? ORDER BY id DESC LIMIT 200', String(chatId)).reverse();
    return rows.map(row => publicMessage(row, users));
  }

  function markRead(user, chatId) {
    assertSee(user, chatId);
    const last = Number(db.get('SELECT MAX(id) AS id FROM telegram_messages WHERE chat_id = ?', String(chatId))?.id || 0);
    db.run('INSERT INTO telegram_reads (user_id, chat_id, last_id) VALUES (?, ?, ?) ON CONFLICT(user_id, chat_id) DO UPDATE SET last_id = excluded.last_id', user.id, String(chatId), last);
    const current = status(user);
    return {unread: current.unread, byProject: current.byProject};
  }

  async function send(user, chatId, text, options = {}) {
    if (!options.known) assertSee(user, chatId);
    else if (!chatById(String(chatId))) throw new HttpError(404, 'Бот ещё не видел этот чат');
    const body = String(text || '').trim();
    if (!body) throw new HttpError(400, 'Введите сообщение');
    if (body.length > 3500) throw new HttpError(400, 'Сообщение длиннее 3500 символов');
    const signed = user.name + ':\n' + body;
    const data = await call('sendMessage', {chat_id: chatId, text: signed});
    const message = data.result;
    upsertChat(message.chat || {id: chatId, type: 'supergroup', title: chatById(chatId)?.title || 'Группа'});
    const sentAt = new Date((message.date || Math.floor(Date.now() / 1000)) * 1000).toISOString();
    db.run(
      'INSERT INTO telegram_messages (chat_id, message_id, tg_user_id, tg_username, tg_name, crm_user_id, text, kind, file_id, file_name, reply_to, edited, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)',
      String(chatId), String(message.message_id), '', '', user.name, user.id, signed, 'text', '', '', '', sentAt,
    );
    markRead(user, chatId);
    return messages(user, chatId);
  }

  async function file(user, messageRowId) {
    const row = db.get('SELECT * FROM telegram_messages WHERE id = ?', Number(messageRowId));
    if (!row || !row.file_id) throw new HttpError(404, 'Файл не найден');
    assertSee(user, row.chat_id);
    if (memory) return {name: row.file_name || 'file.txt', mime: 'text/plain', bytes: Buffer.from('Учебный файл Telegram')};
    const info = await call('getFile', {file_id: row.file_id});
    const path = info.result?.file_path;
    if (!path) throw new HttpError(404, 'Файл не найден');
    const current = token();
    const response = await fetchImpl('https://api.telegram.org/file/bot' + current + '/' + path);
    if (!response.ok) throw new HttpError(502, 'Не удалось скачать файл');
    const bytes = Buffer.from(await response.arrayBuffer());
    return {name: row.file_name || 'file', mime: 'application/octet-stream', bytes};
  }

  function seedDemo() {
    if (!memory) return;
    const team = {id: -1001, type: 'supergroup', title: 'Команда АктивПрофи'};
    const project = {id: -1002, type: 'supergroup', title: 'Проект: Студия массажа'};
    applyUpdate({update_id: 1, message: {message_id: 10, date: Math.floor(Date.now() / 1000) - 120, chat: team, from: {id: 501, username: 'maria_studio', first_name: 'Мария'}, text: 'Макет на проверке, жду комментарии'}});
    applyUpdate({update_id: 2, message: {message_id: 11, date: Math.floor(Date.now() / 1000) - 60, chat: project, from: {id: 777, username: 'client_side', first_name: 'Заказчик'}, text: 'Нужна правка кнопки на главной'}});
    putSetting(db, 'telegram_update_offset', 3);
  }

  function start() {
    stopped = false;
    const tick = async () => {
      if (stopped) return;
      if (!polling) {
        polling = true;
        try { await pollOnce(); } catch { /* без токена и без сети раздел просто показывает инструкцию */ }
        polling = false;
      }
      if (!stopped) timer = setTimeout(tick, memory ? 800 : 2000);
    };
    tick();
  }

  function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
  }

  return {token, connected, mask: () => maskToken(token()), call, pollOnce, applyUpdate, status, overview, setToken, visibleChats, linkChat, unlinkChat, askLink, messages, markRead, send, sendKnownChat: (user, chatId, text) => send(user, chatId, text, {known: true}), file, seedDemo, start, stop, memory, canSeeChat};
}

module.exports = {createTelegram, createMemoryMock, maskToken, cleanTelegramLogin, GROUP_TYPES};
