let telegramUnread = 0;
let telegramChatId = '';

async function telegramApi(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || 'GET',
    credentials: 'same-origin',
    headers: {'Content-Type': 'application/json', 'X-Requested-With': 'ActivProfi'},
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(data.error || 'Не удалось обратиться к Telegram');
  return data;
}

function telegramBadge(count) {
  telegramUnread = Number(count) || 0;
  const button = document.querySelector('[data-go="telegram"]');
  if (!button) return;
  let badge = button.querySelector('.inbox-count');
  if (!telegramUnread) {
    badge?.remove();
    return;
  }
  if (!badge) {
    badge = document.createElement('b');
    badge.className = 'inbox-count';
    button.appendChild(badge);
  }
  badge.textContent = String(telegramUnread);
}

function telegramHelp() {
  return `<section class="panel tg-help"><h2>Как подключить Telegram</h2><ol><li>Бот уже создан: <b>@CRM_ActivProfi_Bot</b>.</li><li>Его токен уже должен лежать в файле .env в корне CRM, в строке <b>TELEGRAM_BOT_TOKEN</b> — там же, где ADMIN_PASSWORD. Сервер читает его сам при запуске. Вставлять токен в эту страницу не нужно, и целиком он здесь не показывается.</li><li>Добавьте @CRM_ActivProfi_Bot в группу команды и в группы проектов. Чтобы он видел все сообщения, сделайте его администратором группы или в @BotFather отключите Privacy mode: /setprivacy → Disable.</li><li>Перезапустите CRM и напишите в группе любое сообщение. Группа появится в списке, её можно привязать к командному чату или к проекту.</li></ol><p class="hint">Бот читает только группы. Личные переписки сотрудников с клиентами сюда не попадают.</p></section>`;
}

function telegramWhen(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('ru-RU', {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'});
}

function telegramMessagesHtml(messages) {
  if (!messages?.length) return '<p class="muted">Сообщений пока нет.</p>';
  const byId = new Map(messages.map(item => [String(item.messageId), item]));
  return messages.map(item => {
    const reply = item.replyTo ? byId.get(String(item.replyTo)) : null;
    const file = item.hasFile ? `<div><a href="/api/telegram/files/${item.id}">Скачать ${esc(item.fileName || 'файл')}</a></div>` : '';
    return `<article class="tg-msg ${item.fromCrm ? 'mine' : ''}"><small>${esc(item.author)}${item.username ? ' · @' + esc(item.username) : ''} · ${esc(telegramWhen(item.sentAt))}${item.edited ? ' · изменено' : ''}</small>${reply ? `<p class="tg-reply">Ответ на: ${esc(reply.text)}</p>` : ''}<p>${esc(item.text)}</p>${file}</article>`;
  }).join('');
}

function telegramComposer(chatId) {
  if (!chatId) return '';
  return `<form class="tg-compose" data-chat="${esc(chatId)}"><textarea name="text" maxlength="3500" required placeholder="Написать в Telegram…"></textarea><button class="btn primary" type="submit">Отправить</button></form>`;
}

function telegramView() {
  loadTelegramPage().catch(error => { const root = $('#telegram-root'); if (root) root.innerHTML = `<p class="form-error">${esc(error.message)}</p>`; });
  return '<div id="telegram-root"><p class="muted">Загрузка чата…</p></div>';
}
async function loadTelegramPage() {
  const data = await telegramApi('/api/telegram');
  const root = $('#telegram-root');
  if (!root) return;
  telegramBadge(data.unread);
  if (!telegramChatId || !data.chats.some(chat => chat.chatId === telegramChatId && chat.visible)) telegramChatId = data.teamChatId || data.chats.find(chat => chat.visible)?.chatId || '';
  const messages = telegramChatId ? (await telegramApi('/api/telegram/messages?chatId=' + encodeURIComponent(telegramChatId))).messages : [];
  if (telegramChatId) telegramApi('/api/telegram/read', {method: 'POST', body: {chatId: telegramChatId}}).then(result => telegramBadge(result.unread)).catch(() => {});
  const list = data.chats.map(chat => `<button type="button" class="tg-chat-link ${chat.chatId === telegramChatId ? 'active' : ''}" data-tg="open" data-id="${esc(chat.chatId)}"><strong>${esc(chat.title)}</strong><small>${chat.link?.scope === 'team' ? 'Командный чат' : chat.link?.projectTitle ? 'Проект: ' + esc(chat.link.projectTitle) : 'Не привязана'}${chat.unread ? ' · новых ' + chat.unread : ''}</small></button>`).join('') || '<p class="muted">Групп пока нет. Напишите что-нибудь в группе, где есть бот.</p>';
  const admin = u().role === 'admin';
  const botLabel = data.botUsername ? '@' + esc(data.botUsername) : '@CRM_ActivProfi_Bot';
  const tokenForm = data.mock ? '<p class="hint">Учебный режим: это не настоящий Telegram. Бот читает только группы, личные переписки с клиентами не попадают в CRM.</p>' : data.fromEnv ? `<p class="hint">Токен прочитан из файла .env, строка TELEGRAM_BOT_TOKEN (рядом с ADMIN_PASSWORD). Бот ${botLabel}. Токен целиком не показывается. После перезапуска сервера ничего больше вводить не нужно.</p>` : admin ? `<form id="tg-token" class="tg-token"><p class="hint">Если токен уже есть в .env, перезапустите сервер — форма не нужна. Иначе вставьте токен бота ${botLabel}.</p><label class="field">Токен бота<input name="token" type="password" autocomplete="off" placeholder="${data.masked || 'Из .env или от BotFather'}"></label><button class="btn primary" type="submit">${data.connected ? 'Заменить токен' : 'Сохранить токен'}</button>${data.connected ? '<button class="btn" type="button" data-tg="forget-token">Удалить токен</button>' : ''}</form>` : '<p class="hint">Токен берётся из .env. Его подключает администратор.</p>';
  const linkTools = data.chats.filter(chat => !chat.link).map(chat => `<div class="tg-link-row"><span>${esc(chat.title)}</span>${admin ? `<button type="button" class="btn" data-tg="team" data-id="${esc(chat.chatId)}">Командный чат</button>` : ''}${data.projects.length ? `<select data-project-for="${esc(chat.chatId)}">${data.projects.map(project => `<option value="${esc(project.id)}">${esc(project.title)}</option>`).join('')}</select><button type="button" class="btn" data-tg="project" data-id="${esc(chat.chatId)}">К проекту</button>` : ''}</div>`).join('');
  const subtitle = data.mock ? 'Учебный режим: настоящий Telegram не вызывается.' : data.connected ? 'Бот ' + botLabel + ' подключён' + (data.fromEnv ? '. Токен прочитан из .env' : (data.masked ? ' · ' + esc(data.masked) : '')) : 'Бот ' + botLabel + ' ещё не подключён';
  root.innerHTML = `<div class="page-head"><div><h1>Чат команды</h1><p>${subtitle}</p></div></div>${data.connected && !data.mock ? '<p class="hint">Бот читает только группы. Личные переписки с клиентами сюда не попадают. Чтобы видеть все сообщения, сделайте @CRM_ActivProfi_Bot администратором группы или выключите Privacy mode в @BotFather.</p>' : ''}${data.connected ? '' : telegramHelp()}<div class="tg-layout"><aside class="panel tg-list">${list}${linkTools ? '<h3>Привязать группу</h3>' + linkTools : ''}${tokenForm}</aside><section class="tg-chat"><div class="tg-messages">${telegramMessagesHtml(messages)}</div>${telegramComposer(telegramChatId)}</section></div>`;
}

function projectTelegram() {
  return `<section class="panel"><div class="panel-head"><h2>Группа проекта в Telegram</h2></div><div id="project-telegram"><p class="muted">Загрузка…</p></div></section>`;
}

async function fillProjectTelegram() {
  const host = $('#project-telegram');
  if (!host) return;
  const data = await telegramApi('/api/telegram');
  const linked = data.chats.find(chat => chat.link?.scope === 'project' && chat.link.projectId === projectId && chat.visible);
  if (!linked) {
    const choices = data.chats.filter(chat => !chat.link);
    host.innerHTML = choices.length && data.projects.some(project => project.id === projectId) ? `<p class="hint">Выберите группу, которую бот уже видел.</p>${choices.map(chat => `<button type="button" class="btn" data-tg="project" data-id="${esc(chat.chatId)}" data-project="${esc(projectId)}">${esc(chat.title)}</button>`).join(' ')}` : '<p class="hint">Группа проекта ещё не привязана. Админ или руководитель проекта выбирает её в «Чат команды», когда бот уже видел сообщения группы.</p>';
    return;
  }
  const messages = (await telegramApi('/api/telegram/messages?chatId=' + encodeURIComponent(linked.chatId))).messages;
  telegramApi('/api/telegram/read', {method: 'POST', body: {chatId: linked.chatId}}).then(result => telegramBadge(result.unread)).catch(() => {});
  host.innerHTML = `<p><strong>${esc(linked.title)}</strong></p><div class="tg-messages">${telegramMessagesHtml(messages)}</div>${telegramComposer(linked.chatId)}`;
}

async function telegramAction(button) {
  const kind = button.dataset.tg;
  const id = button.dataset.id || '';
  if (kind === 'open') {
    telegramChatId = id;
    render();
    return;
  }
  if (kind === 'team') {
    await telegramApi('/api/telegram/link', {method: 'POST', body: {chatId: id, scope: 'team'}});
    toast('Группа стала командным чатом');
    render();
    return;
  }
  if (kind === 'project') {
    const project = button.dataset.project || button.parentElement?.querySelector('select')?.value;
    if (!project) throw Error('Выберите проект');
    await telegramApi('/api/telegram/link', {method: 'POST', body: {chatId: id, scope: 'project', projectId: project}});
    toast('Группа привязана к проекту');
    render();
    return;
  }
  if (kind === 'forget-token') {
    await telegramApi('/api/telegram/token', {method: 'DELETE'});
    toast('Токен удалён');
    render();
  }
}

async function telegramTick() {
  if (!state) return;
  const data = await telegramApi('/api/telegram/badge');
  const changed = Number(data.unread) !== telegramUnread;
  telegramBadge(data.unread);
  if (!changed || $('#modal')?.open) return;
  if (page === 'telegram') render();
  if (page === 'project' && projectTab === 'telegram') fillProjectTelegram().catch(error => toast(error.message));
}

document.addEventListener('click', event => {
  const button = event.target.closest('[data-tg]');
  if (!button) return;
  telegramAction(button).catch(error => toast(error.message));
});
document.addEventListener('submit', event => {
  if (event.target.id === 'tg-token') {
    event.preventDefault();
    telegramApi('/api/telegram/token', {method: 'POST', body: {token: new FormData(event.target).get('token')}}).then(() => { toast('Токен сохранён на сервере'); render(); }).catch(error => toast(error.message));
    return;
  }
  if (event.target.classList?.contains('tg-compose')) {
    event.preventDefault();
    const chatId = event.target.dataset.chat;
    const text = new FormData(event.target).get('text');
    telegramApi('/api/telegram/messages', {method: 'POST', body: {chatId, text}}).then(() => { event.target.reset(); if (page === 'telegram') render(); else fillProjectTelegram(); }).catch(error => toast(error.message));
  }
});
setInterval(() => { telegramTick().catch(() => {}); }, 4000);
