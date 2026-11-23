const crypto = require('node:crypto');
const {M, Inbox} = require('./models.cjs');
const store = require('./store.cjs');
const {upgradeInPlace} = require('./guard.cjs');
const {command} = require('./service.cjs');
const {HttpError} = require('./errors.cjs');

const MAIL_OFF = 'Почта не подключена — обратитесь к администратору';

function assertSender(state, actor, client) {
  if (!client || !M.canClient(state, actor, client)) throw new HttpError(403, 'Это не ваш клиент');
  if (!M.has(state, actor, 'inbox.reply') && !M.has(state, actor, 'clients.edit')) throw new HttpError(403, 'Отправка клиентам отключена в ваших правах');
}

function materialBytes(material) {
  const data = String(material?.data || '');
  const comma = data.indexOf(',');
  if (data.startsWith('data:') && comma >= 0) return Buffer.from(data.slice(comma + 1), 'base64');
  if (data) return Buffer.from(data, 'base64');
  return Buffer.from(String(material?.text || ''), 'utf8');
}

function remember(state, actor, client, item) {
  Inbox.upgrade(state);
  if (!state.messengerChannels.some(channel => channel.id === 'email')) {
    state.messengerChannels.push({id: 'email', provider: 'email', name: 'Почта', mode: 'smtp', status: 'ready'});
  }
  client.notes = Array.isArray(client.notes) ? client.notes : [];
  const day = new Date().toISOString().slice(0, 10);
  client.notes.unshift(item.status === 'sent'
    ? actor.name + ' · ' + day + ': Отправлено (' + item.channel + ') кому ' + item.toLabel + (item.subject ? '. Тема: ' + item.subject : '') + '. ' + item.text.slice(0, 160)
    : actor.name + ' · ' + day + ': Не отправлено (' + item.channel + ') кому ' + item.toLabel + '. ' + item.error);
  const channelId = item.channel === 'почта' ? 'email' : 'telegram';
  let conversation = state.conversations.find(entry => entry.clientId === client.id && entry.channelId === channelId && !entry.demo);
  if (!conversation) {
    conversation = {id: 'mail-' + client.id + '-' + channelId, clientId: client.id, channelId, demo: false, externalChatId: item.chatId || '', readBy: {}, createdAt: new Date().toISOString()};
    state.conversations.push(conversation);
  }
  const sequence = Math.max(0, ...state.externalMessages.filter(entry => entry.conversationId === conversation.id).map(entry => Number(entry.sequence) || 0)) + 1;
  state.externalMessages.push({
    id: 'out-' + crypto.randomBytes(6).toString('hex'),
    conversationId: conversation.id,
    authorId: actor.id,
    direction: 'outbound',
    text: item.text,
    subject: item.subject || '',
    status: item.status,
    error: item.error || '',
    at: new Date().toISOString(),
    sequence,
  });
  if (item.outbox) state.outbox.push(item.outbox);
}

function readClient(db, user, clientId) {
  return db.transaction(() => {
    const state = store.load(db);
    upgradeInPlace(state);
    const actor = state.users.find(item => item.id === user.id);
    const client = state.clients.find(item => item.id === clientId);
    assertSender(state, actor, client);
    return {state, actor, client};
  });
}

function allowedEmails(state, client) {
  const project = client.project ? M.project(state, client.project) : null;
  return [client.email, ...(project?.recipients || []).map(item => item.email)]
    .map(value => String(value || '').trim())
    .filter(value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value));
}

async function sendEmail(db, user, mailer, body) {
  const snapshot = readClient(db, user, body.clientId);
  const allowed = allowedEmails(snapshot.state, snapshot.client);
  const to = String(body.to || snapshot.client.email || '').trim();
  if (!allowed.some(item => item.toLowerCase() === to.toLowerCase())) throw new HttpError(400, 'Можно отправить только на почту этого клиента или адресата его проекта');
  if (String(body.confirmTo || '').trim().toLowerCase() !== to.toLowerCase()) throw new HttpError(400, 'Подтвердите получателя');
  let text = String(body.text || '').trim();
  if (!text) throw new HttpError(400, 'Введите текст письма');
  if (text.length > 8000) throw new HttpError(400, 'Письмо длиннее 8000 символов');
  if (body.includeKpLink && snapshot.client.kpLink) text += '\n\nСсылка на КП: ' + snapshot.client.kpLink;
  const subject = String(body.subject || 'Сообщение от АктивПрофи').trim().slice(0, 180);
  const attachments = [];
  if (body.materialId) {
    const material = (snapshot.state.materials || []).find(item => item.id === body.materialId);
    if (!material || !M.canProject(snapshot.state, snapshot.actor, material.projectId)) throw new HttpError(403, 'Файл недоступен');
    attachments.push({name: material.name || 'file', mime: material.mime || 'application/octet-stream', bytes: materialBytes(material)});
  }
  const outbox = body.materialId ? {id: 'box-' + Date.now().toString(36), projectId: snapshot.client.project || '', documentId: body.materialId, documentName: attachments[0]?.name || '', to, subject, body: text, at: new Date().toISOString(), createdBy: user.id, status: 'Черновик'} : null;
  if (!mailer.settings.configured) {
    const saved = command(db, user, (state, actor) => {
      const client = state.clients.find(item => item.id === snapshot.client.id);
      if (outbox) outbox.status = 'Черновик · почта не подключена';
      remember(state, actor, client, {channel: 'почта', toLabel: to, text, subject, status: 'draft', error: MAIL_OFF, outbox});
    });
    const error = new HttpError(400, MAIL_OFF);
    error.payload = saved;
    throw error;
  }
  try {
    await mailer.send({to, subject, text, attachments});
    const saved = command(db, user, (state, actor) => {
      const client = state.clients.find(item => item.id === snapshot.client.id);
      if (outbox) outbox.status = 'Отправлено';
      remember(state, actor, client, {channel: 'почта', toLabel: to, text, subject, status: 'sent', outbox});
    });
    return {...saved, delivery: {status: 'sent', to, channel: 'почта'}};
  } catch (error) {
    const reason = error.message || 'Письмо не ушло';
    const saved = command(db, user, (state, actor) => {
      const client = state.clients.find(item => item.id === snapshot.client.id);
      if (outbox) outbox.status = 'Ошибка: ' + reason;
      remember(state, actor, client, {channel: 'почта', toLabel: to, text, subject, status: 'error', error: reason, outbox});
    });
    return {...saved, delivery: {status: 'error', error: reason, to, channel: 'почта'}};
  }
}

function telegramTarget(state, telegram, actor, client) {
  const conversation = (state.conversations || []).find(item => item.clientId === client.id && item.channelId === 'telegram' && item.externalChatId && !item.demo);
  if (conversation) return {chatId: String(conversation.externalChatId), label: 'чат ' + conversation.externalChatId};
  if (!client.project) return null;
  const linked = telegram.visibleChats(actor).find(item => item.visible && item.link?.scope === 'project' && item.link.projectId === client.project);
  if (!linked) return null;
  const project = M.project(state, client.project);
  return {chatId: linked.chatId, label: 'группа проекта «' + (project?.title || linked.title || 'проект') + '»'};
}

async function sendTelegram(db, user, telegram, body) {
  const snapshot = readClient(db, user, body.clientId);
  const target = telegramTarget(snapshot.state, telegram, snapshot.actor, snapshot.client);
  if (!target) throw new HttpError(400, 'У этого клиента нет чата Telegram, который видит бот. Подключите группу проекта или дождитесь, пока клиент напишет боту.');
  const text = String(body.text || '').trim();
  if (!text) throw new HttpError(400, 'Введите сообщение');
  if (String(body.confirmTo || '') !== target.label) throw new HttpError(400, 'Подтвердите получателя');
  try {
    await telegram.sendKnownChat(snapshot.actor, target.chatId, text);
    const saved = command(db, user, (state, actor) => {
      const client = state.clients.find(item => item.id === snapshot.client.id);
      remember(state, actor, client, {channel: 'Telegram', toLabel: target.label, text, status: 'sent', chatId: target.chatId});
    });
    return {...saved, delivery: {status: 'sent', to: target.label, channel: 'Telegram'}};
  } catch (error) {
    const reason = error.message || 'Telegram не принял сообщение';
    const saved = command(db, user, (state, actor) => {
      const client = state.clients.find(item => item.id === snapshot.client.id);
      remember(state, actor, client, {channel: 'Telegram', toLabel: target.label, text, status: 'error', error: reason, chatId: target.chatId});
    });
    return {...saved, delivery: {status: 'error', error: reason, to: target.label, channel: 'Telegram'}};
  }
}

async function testMail(user, mailer, body) {
  if (user.role !== 'admin') throw new HttpError(403, 'Почту проверяет администратор');
  if (!mailer.settings.configured) throw new HttpError(400, MAIL_OFF);
  const to = String(body.to || mailer.settings.from).trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new HttpError(400, 'Укажите почту для проверки');
  await mailer.send({to, subject: 'Проверка почты АктивПрофи', text: 'Это проверочное письмо из CRM. Если оно пришло, почта подключена.'});
  return {ok: true, to};
}

module.exports = {sendEmail, sendTelegram, testMail, MAIL_OFF, telegramTarget};
