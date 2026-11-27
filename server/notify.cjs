const crypto = require('node:crypto');

const senders = new WeakMap();

function setSender(db, fn) {
  if (fn) senders.set(db, fn);
  else senders.delete(db);
}

function people(state, role) {
  return (state.users || []).filter(user => user.role === role && user.active !== false).map(user => user.id);
}

function push(events, event, actorId) {
  if (!event?.userId) return;
  if (actorId && event.userId === actorId && event.kind !== 'missed-call') return;
  if (events.some(item => item.userId === event.userId && item.kind === event.kind && item.refId === event.refId)) return;
  events.push(event);
}

function plan(before, after, actorId) {
  const events = [];
  const oldTasks = new Map((before.tasks || []).map(task => [task.id, task]));
  const projects = new Map((after.projects || []).map(project => [project.id, project]));
  for (const task of after.tasks || []) {
    const prev = oldTasks.get(task.id);
    const project = projects.get(task.projectId);
    if (!prev) {
      push(events, {userId: task.assigneeId, kind: 'task-new', title: 'Новая задача', body: task.title || 'Задача', refKind: 'task', refId: task.id}, actorId);
      continue;
    }
    if ((task.assigneeId || '') && task.assigneeId !== (prev.assigneeId || '')) {
      push(events, {userId: task.assigneeId, kind: 'task-new', title: 'Вам назначена задача', body: task.title || 'Задача', refKind: 'task', refId: task.id}, actorId);
    }
    if (task.status === 'На проверке' && prev.status !== 'На проверке') {
      const reviewer = task.reviewerId || project?.leaderId || project?.pmId || '';
      push(events, {userId: reviewer, kind: 'task-review', title: 'Задача на проверке', body: task.title || 'Задача', refKind: 'task', refId: task.id}, actorId);
    }
    if (prev.status === 'На проверке' && (task.status === 'В работе' || task.status === 'В очереди')) {
      push(events, {userId: task.assigneeId, kind: 'task-rework', title: 'Задачу вернули на доработку', body: task.title || 'Задача', refKind: 'task', refId: task.id}, actorId);
    }
  }
  const oldProjects = new Map((before.projects || []).map(project => [project.id, project]));
  for (const project of after.projects || []) {
    const prev = oldProjects.get(project.id);
    const bare = !project.leaderId || !project.pmId;
    const wasBare = prev ? (!prev.leaderId || !prev.pmId) : false;
    if (!bare || wasBare) continue;
    const targets = new Set();
    if (!project.leaderId) {
      const chosen = after.desk?.defaultLeaderId;
      for (const id of (chosen ? [chosen] : people(after, 'leader'))) targets.add(id);
    }
    if (!project.pmId) {
      const chosen = after.desk?.defaultPmId;
      for (const id of (chosen ? [chosen] : people(after, 'pm'))) targets.add(id);
    }
    for (const userId of targets) {
      push(events, {userId, kind: 'project-bare', title: 'Новый проект без команды', body: project.title || 'Проект', refKind: 'project', refId: project.id}, actorId);
    }
  }
  const oldClients = new Map((before.clients || []).map(client => [client.id, client]));
  for (const client of after.clients || []) {
    const prev = oldClients.get(client.id);
    const owner = client.ownerId || '';
    if (owner && owner !== (prev?.ownerId || '')) {
      push(events, {userId: owner, kind: 'lead-assigned', title: 'Вам назначен лид', body: client.name || 'Лид', refKind: 'client', refId: client.id}, actorId);
    }
    if (client.upsellAt && client.upsellAt !== prev?.upsellAt && owner) {
      push(events, {userId: owner, kind: 'upsell', title: 'Пора предложить допродажу', body: client.name || 'Клиент', refKind: 'client', refId: client.id}, actorId);
    }
  }
  return events;
}

function missedCall({ownerId, dutyUserId, name, phone, clientId}) {
  const userId = ownerId || dutyUserId || '';
  if (!userId) return null;
  const who = name || 'Неизвестный номер';
  return {userId, kind: 'missed-call', title: 'Пропущенный звонок', body: who + (phone ? ' · ' + phone : ''), refKind: clientId ? 'client' : 'call', refId: clientId || phone || ''};
}

function insert(db, events) {
  const at = new Date().toISOString();
  for (const event of events || []) {
    if (!event?.userId) continue;
    db.run(
      'INSERT INTO notifications (id, user_id, kind, title, body, ref_kind, ref_id, created_at, read_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      crypto.randomUUID(), event.userId, event.kind, event.title, event.body || '', event.refKind || '', event.refId || '', at, '',
    );
  }
}

function deliver(db, events) {
  const sender = senders.get(db);
  if (!sender) return;
  for (const event of events || []) {
    const chat = db.get('SELECT chat_id FROM telegram_personal WHERE user_id = ?', event.userId)?.chat_id;
    if (!chat) continue;
    try {
      const result = sender(chat, event.title + (event.body ? '\n' + event.body : ''));
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch { /* без бота остаётся колокольчик */ }
  }
}

function publish(db, before, after, actorId) {
  const events = plan(before, after, actorId);
  insert(db, events);
  return events;
}

function list(db, userId) {
  const rows = db.all('SELECT id, kind, title, body, ref_kind, ref_id, created_at, read_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', userId);
  return {
    unread: rows.filter(row => !row.read_at).length,
    items: rows.map(row => ({id: row.id, kind: row.kind, title: row.title, body: row.body, refKind: row.ref_kind, refId: row.ref_id, createdAt: row.created_at, readAt: row.read_at || ''})),
  };
}

function markRead(db, userId, body) {
  if (body?.all) db.run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at = ?', new Date().toISOString(), userId, '');
  else if (body?.id) db.run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND id = ? AND read_at = ?', new Date().toISOString(), userId, String(body.id), '');
  return list(db, userId);
}

function linkStatus(db, userId, botUsername) {
  const row = db.get('SELECT chat_id, code FROM telegram_personal WHERE user_id = ?', userId);
  const code = row?.code || '';
  const username = String(botUsername || '').replace(/^@/, '');
  return {
    linked: Boolean(row?.chat_id),
    code,
    bot: username,
    url: username && code ? 'https://t.me/' + username + '?start=' + code : '',
    bellOnly: !username,
  };
}

function issueCode(db, userId) {
  const code = crypto.randomBytes(4).toString('hex');
  const existing = db.get('SELECT chat_id, linked_at FROM telegram_personal WHERE user_id = ?', userId);
  db.run(
    'INSERT INTO telegram_personal (user_id, chat_id, code, linked_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET code = excluded.code',
    userId, existing?.chat_id || '', code, existing?.linked_at || '',
  );
  return code;
}

function linkByCode(db, code, chatId) {
  const value = String(code || '').trim();
  const row = value ? db.get('SELECT user_id FROM telegram_personal WHERE code = ?', value) : undefined;
  if (!row) return false;
  db.run('UPDATE telegram_personal SET chat_id = ?, linked_at = ? WHERE user_id = ?', String(chatId), new Date().toISOString(), row.user_id);
  return true;
}

module.exports = {setSender, plan, missedCall, insert, deliver, publish, list, markRead, linkStatus, issueCode, linkByCode};
