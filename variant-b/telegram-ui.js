let telegramUnread = 0;
let telegramByProject = {};
let telegramChatId = '';
let telegramRelinkId = '';

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

function telegramProjectCount(id) {
  return Number(telegramByProject[id] || 0);
}

function telegramBadge(count) {
  telegramUnread = Number(count) || 0;
  const button = document.querySelector('[data-go="telegram"]');
  if (!button) return;
  let badge = button.querySelector('.tg-count');
  if (!telegramUnread) {
    badge?.remove();
    return;
  }
  if (!badge) {
    badge = document.createElement('b');
    badge.className = 'tg-count';
    button.appendChild(badge);
  }
  badge.textContent = String(telegramUnread);
}

function telegramWords(value) {
  return String(value || '').toLowerCase().replace(/[^a-zа-яё0-9]+/gi, ' ').split(' ').filter(word => word.length > 2);
}

function telegramSuggest(title, projects) {
  const words = telegramWords(title);
  let best = '';
  let score = 0;
  for (const project of projects || []) {
    const other = telegramWords(project.title);
    const hit = words.filter(word => other.some(item => item.includes(word) || word.includes(item))).length;
    if (hit > score) {
      score = hit;
      best = project.id;
    }
  }
  return best;
}

function telegramWhen(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('ru-RU', {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'});
}

function telegramBody(item) {
  const text = String(item.text || '');
  if (!item.fromCrm) return text;
  const prefix = item.author + ':\n';
  return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}

function telegramMessagesHtml(messages) {
  if (!messages?.length) return '<p class="muted tg-empty">Сообщений пока нет. Напишите первое — оно уйдёт в группу Telegram.</p>';
  const byId = new Map(messages.map(item => [String(item.messageId), item]));
  const me = u().id;
  return messages.map(item => {
    const mine = item.crmUserId === me;
    const staff = !mine && (item.fromCrm || item.crmUserId);
    const kind = mine ? 'mine' : staff ? 'staff' : 'guest';
    const reply = item.replyTo ? byId.get(String(item.replyTo)) : null;
    const file = item.hasFile ? `<div><a href="/api/telegram/files/${item.id}">Скачать ${esc(item.fileName || 'файл')}</a></div>` : '';
    const role = mine ? 'вы' : staff ? 'сотрудник' : 'не из CRM';
    return `<article class="tg-msg ${kind}"><small>${esc(item.author)}${item.username ? ' · @' + esc(item.username) : ''} · ${role} · ${esc(telegramWhen(item.sentAt))}${item.edited ? ' · изменено' : ''}</small>${reply ? `<p class="tg-reply">Ответ на: ${esc(telegramBody(reply))}</p>` : ''}<p>${esc(telegramBody(item))}</p>${file}</article>`;
  }).join('');
}

function telegramAudience(chat) {
  if (chat?.link?.scope === 'team') return 'Видят все, кто вошёл в CRM.';
  if (chat?.link?.scope === 'project') return 'Видят участники проекта, администратор, проджект и руководитель разработки.';
  return '';
}

function telegramDestination(chat) {
  if (!chat) return '';
  if (chat.link?.scope === 'project') return `Уйдёт в группу «${chat.title}» проекта «${chat.link.projectTitle || 'проект'}», от вашего имени.`;
  if (chat.link?.scope === 'team') return `Уйдёт в командную группу «${chat.title}», от вашего имени.`;
  return `Уйдёт в группу «${chat.title}», от вашего имени.`;
}

function telegramComposer(chat) {
  if (!chat?.visible) return '';
  return `<form class="tg-compose" data-chat="${esc(chat.chatId)}"><p class="tg-destination">${esc(telegramDestination(chat))}</p><div class="tg-compose-row"><textarea name="text" maxlength="3500" required placeholder="Напишите сообщение"></textarea><button class="btn primary" type="submit">Отправить</button></div></form>`;
}

function telegramCanAssign(data, projectId) {
  if (u().role === 'admin') return true;
  return (data.projects || []).some(project => project.id === projectId);
}

function telegramHow(data) {
  const bot = data?.botUsername ? '@' + data.botUsername : '@CRM_ActivProfi_Bot';
  const token = data?.mock ? '<p>Сейчас включён учебный режим: настоящий Telegram не вызывается.</p>' : data?.fromEnv ? `<p>Бот ${esc(bot)} уже подключён. Токен прочитан из .env, строка TELEGRAM_BOT_TOKEN, и здесь не показывается.</p>` : data?.connected ? `<p>Бот ${esc(bot)} подключён.</p>` : `<p>Токен бота ${esc(bot)} лежит в .env, строка TELEGRAM_BOT_TOKEN, рядом с ADMIN_PASSWORD. После перезапуска сервера вводить его здесь не нужно.</p>`;
  const form = !data?.connected && !data?.mock && u().role === 'admin' ? `<form id="tg-token" class="tg-token"><label class="field">Токен, если его нет в .env<input name="token" type="password" autocomplete="off"></label><button class="btn" type="submit">Сохранить токен</button></form>` : '';
  return `<details class="tg-how"><summary>Как это работает</summary><p>Сообщения из группы Telegram проекта собираются во вкладке «Переписка» этого проекта. Командный чат виден всем сотрудникам. Бот читает только группы, личные переписки с клиентами сюда не попадают.</p><ol><li>Добавьте ${esc(bot)} в группу и сделайте его администратором.</li><li>Напишите в группе любое сообщение.</li><li>Откройте проект и нажмите «Подключить» у этой группы.</li></ol>${token}${form}</details>`;
}

function telegramMenu(chat, data) {
  const manageable = chat.link?.scope === 'team' ? u().role === 'admin' : telegramCanAssign(data, chat.link?.projectId);
  if (!manageable) return '';
  const relink = telegramRelinkId === chat.chatId ? `<form class="tg-relink"><label>Перепривязать<select name="target">${u().role === 'admin' ? '<option value="team">Командный чат</option>' : ''}${(data.projects || []).map(project => `<option value="${esc(project.id)}"${project.id === chat.link?.projectId ? ' selected' : ''}>${esc(project.title)}</option>`).join('')}</select></label><button class="btn primary" type="submit" data-tg="assign" data-id="${esc(chat.chatId)}">Сохранить</button></form>` : '';
  return `<details class="tg-more"><summary aria-label="Действия с группой">…</summary><div class="tg-menu"><button type="button" data-tg="show-relink" data-id="${esc(chat.chatId)}">Перепривязать</button><button type="button" data-tg="unlink" data-id="${esc(chat.chatId)}">Отвязать группу</button></div></details>${relink}`;
}

function telegramThread(chat, messages, data) {
  if (!chat) return '<section class="tg-chat"><p class="muted tg-empty">Выберите переписку слева.</p></section>';
  const heading = chat.link?.scope === 'project' ? (chat.link.projectTitle || 'Проект') : 'Командный чат';
  return `<section class="tg-chat"><div class="tg-head"><div><h2>${esc(heading)}</h2><p>Группа Telegram: ${esc(chat.title)}</p><p class="tg-who">${esc(telegramAudience(chat))}</p></div>${telegramMenu(chat, data)}</div><div class="tg-messages">${telegramMessagesHtml(messages)}</div>${telegramComposer(chat)}</section>`;
}

function telegramAssignOptions(data, title) {
  const suggested = telegramSuggest(title, data.projects);
  const team = u().role === 'admin' ? `<option value="team"${suggested ? '' : ' selected'}>Командный чат</option>` : '';
  const projects = (data.projects || []).map(project => `<option value="${esc(project.id)}"${project.id === suggested ? ' selected' : ''}>${esc(project.title)}${project.id === suggested ? ' — похоже по названию' : ''}</option>`).join('');
  return team + projects;
}

function telegramNewGroups(data) {
  const fresh = (data.chats || []).filter(chat => !chat.link);
  if (!fresh.length || (u().role !== 'admin' && !(data.projects || []).length)) return '';
  const rows = fresh.map(chat => `<div class="tg-new-row"><strong>${esc(chat.title)}</strong><label>Куда отнести<select data-assign="${esc(chat.chatId)}">${telegramAssignOptions(data, chat.title)}</select></label><button type="button" class="btn primary" data-tg="assign" data-id="${esc(chat.chatId)}">Отнести</button></div>`).join('');
  return `<section class="tg-new"><h2>Новые группы — к какому проекту отнести?</h2><p>Бот уже видит эти группы. Выберите проект и нажмите одну кнопку.</p>${rows}</section>`;
}

function telegramDialogs(data) {
  const dialogs = (data.chats || []).filter(chat => chat.visible && chat.link).sort((a, b) => {
    if (b.unread !== a.unread) return b.unread - a.unread;
    if (a.link.scope === 'team') return -1;
    if (b.link.scope === 'team') return 1;
    return String(a.link.projectTitle || a.title).localeCompare(String(b.link.projectTitle || b.title), 'ru');
  });
  if (!dialogs.length) return '<p class="muted">Привязанных переписок пока нет.</p>';
  return dialogs.map(chat => {
    const title = chat.link.scope === 'project' ? (chat.link.projectTitle || chat.title) : 'Командный чат';
    return `<button type="button" class="tg-dialog ${chat.chatId === telegramChatId ? 'active' : ''}" data-tg="open" data-id="${esc(chat.chatId)}"><span><strong>${esc(title)}</strong><small>${esc(chat.title)}</small></span>${chat.unread ? `<b class="tg-count">${chat.unread}</b>` : ''}</button>`;
  }).join('');
}

function telegramView() {
  loadTelegramPage().catch(error => { const root = $('#telegram-root'); if (root) root.innerHTML = `<p class="form-error">${esc(error.message)}</p>`; });
  return '<div id="telegram-root"><p class="muted">Загрузка переписок…</p></div>';
}

async function loadTelegramPage() {
  const data = await telegramApi('/api/telegram');
  const root = $('#telegram-root');
  if (!root) return;
  telegramByProject = data.byProject || {};
  telegramBadge(data.unread);
  const dialogs = (data.chats || []).filter(chat => chat.visible && chat.link);
  if (!telegramChatId || !dialogs.some(chat => chat.chatId === telegramChatId)) telegramChatId = dialogs.slice().sort((a, b) => b.unread - a.unread)[0]?.chatId || '';
  const current = dialogs.find(chat => chat.chatId === telegramChatId) || null;
  const messages = current ? (await telegramApi('/api/telegram/messages?chatId=' + encodeURIComponent(current.chatId))).messages : [];
  if (current) telegramApi('/api/telegram/read', {method: 'POST', body: {chatId: current.chatId}}).then(result => { telegramByProject = result.byProject || telegramByProject; telegramBadge(result.unread); }).catch(() => {});
  root.innerHTML = `<div class="page-head"><div><h1>Чат команды</h1><p>Командная группа и переписки проектов в одном списке.</p></div></div>${telegramHow(data)}${telegramNewGroups(data)}<div class="tg-layout"><div class="tg-list">${telegramDialogs(data)}</div>${telegramThread(current, messages, data)}</div>`;
  const box = root.querySelector('.tg-messages');
  if (box) box.scrollTop = box.scrollHeight;
}

function projectTelegram() {
  return '<section class="tg-project" id="project-telegram"><p class="muted">Загрузка переписки…</p></section>';
}

async function fillProjectTelegram() {
  const host = $('#project-telegram');
  if (!host) return;
  const data = await telegramApi('/api/telegram');
  telegramByProject = data.byProject || {};
  telegramBadge(data.unread);
  const tab = document.querySelector('[data-action="project-tab"][data-id="telegram"]');
  if (tab) {
    tab.querySelector('.tg-count')?.remove();
    const count = telegramProjectCount(projectId);
    if (count) tab.insertAdjacentHTML('beforeend', `<b class="tg-count">${count}</b>`);
  }
  const project = (state.projects || []).find(item => item.id === projectId);
  const linked = (data.chats || []).find(chat => chat.link?.scope === 'project' && chat.link.projectId === projectId && chat.visible);
  if (!linked) {
    const fresh = (data.chats || []).filter(chat => !chat.link);
    const can = telegramCanAssign(data, projectId);
    const steps = `<ol><li>Добавьте @CRM_ActivProfi_Bot в группу проекта и сделайте его администратором.</li><li>Напишите в группе любое сообщение.</li><li>Группа появится здесь. Нажмите «Подключить» — это и будет переписка проекта.</li></ol>`;
    if (!can) {
      host.innerHTML = `<section class="tg-connect"><h2>Подключить группу Telegram</h2><p>Группу подключает администратор или руководитель проекта «${esc(project?.title || '')}».</p>${steps}</section>`;
      return;
    }
    const suggested = fresh.find(chat => telegramSuggest(chat.title, [{id: projectId, title: project?.title || ''}]) === projectId);
    const buttons = fresh.map(chat => `<button type="button" class="btn tg-pick ${chat === suggested ? 'primary' : ''}" data-tg="project" data-id="${esc(chat.chatId)}" data-project="${esc(projectId)}">Подключить «${esc(chat.title)}»${chat === suggested ? ' — похоже на этот проект' : ''}</button>`).join('');
    host.innerHTML = `<section class="tg-connect"><h2>Подключить группу Telegram</h2><p>Переписка будет внутри проекта «${esc(project?.title || '')}». Одна группа — один проект.</p>${steps}${buttons || '<p class="muted">Новых групп пока нет. После сообщения в группе обновите страницу.</p>'}</section>`;
    return;
  }
  const messages = (await telegramApi('/api/telegram/messages?chatId=' + encodeURIComponent(linked.chatId))).messages;
  telegramApi('/api/telegram/read', {method: 'POST', body: {chatId: linked.chatId}}).then(result => { telegramByProject = result.byProject || telegramByProject; telegramBadge(result.unread); }).catch(() => {});
  host.innerHTML = telegramThread(linked, messages, data);
  const box = host.querySelector('.tg-messages');
  if (box) box.scrollTop = box.scrollHeight;
}

async function telegramAssign(chatId, target) {
  if (!target) throw Error('Выберите, куда отнести группу');
  if (target === 'team') await telegramApi('/api/telegram/link', {method: 'POST', body: {chatId, scope: 'team'}});
  else await telegramApi('/api/telegram/link', {method: 'POST', body: {chatId, scope: 'project', projectId: target}});
  telegramRelinkId = '';
  toast(target === 'team' ? 'Группа стала командным чатом' : 'Группа привязана к проекту');
  render();
}

async function telegramAction(button) {
  const kind = button.dataset.tg;
  const id = button.dataset.id || '';
  if (kind === 'open') {
    telegramChatId = id;
    telegramRelinkId = '';
    render();
    return;
  }
  if (kind === 'project') {
    await telegramApi('/api/telegram/link', {method: 'POST', body: {chatId: id, scope: 'project', projectId: button.dataset.project}});
    toast('Группа подключена к проекту');
    render();
    return;
  }
  if (kind === 'assign') {
    const select = button.closest('.tg-new-row, .tg-relink')?.querySelector('select');
    await telegramAssign(id, button.dataset.project || select?.value || '');
    return;
  }
  if (kind === 'show-relink') {
    telegramRelinkId = telegramRelinkId === id ? '' : id;
    render();
    return;
  }
  if (kind === 'unlink') {
    await telegramApi('/api/telegram/unlink', {method: 'POST', body: {chatId: id}});
    if (telegramChatId === id) telegramChatId = '';
    telegramRelinkId = '';
    toast('Группа отвязана');
    render();
  }
}

async function telegramTick() {
  if (!state) return;
  const data = await telegramApi('/api/telegram/badge');
  const next = Number(data.unread) || 0;
  const by = data.byProject || {};
  const changed = next !== telegramUnread || JSON.stringify(by) !== JSON.stringify(telegramByProject);
  telegramByProject = by;
  telegramBadge(next);
  if (!changed || $('#modal')?.open || document.activeElement?.closest('.tg-compose, .tg-new, .tg-relink')) return;
  if (page === 'telegram' || page === 'projects' || page === 'overview' || (page === 'project' && projectTab === 'telegram')) render();
}

document.addEventListener('click', event => {
  const button = event.target.closest('[data-tg]');
  if (!button) return;
  event.preventDefault();
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
  if (event.target.classList?.contains('tg-relink')) event.preventDefault();
});
setInterval(() => { telegramTick().catch(() => {}); }, 4000);
