let notifyItems = [];
let notifyUnread = 0;

function notifyButton() {
  const mark = notifyUnread ? ' (' + notifyUnread + ')' : '';
  return '<button class="btn" type="button" data-action="notify-open" aria-label="Уведомления">Уведомления' + mark + '</button>';
}

async function loadNotes() {
  if (!state) return false;
  const response = await fetch('/api/notifications', {headers: {'X-Requested-With': 'ActivProfi'}});
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return false;
  const previous = notifyUnread;
  notifyItems = data.items || [];
  notifyUnread = data.unread || 0;
  return previous !== notifyUnread;
}

function notifyOpen() {
  const rows = notifyItems.map(item => `<button type="button" class="client-row" data-action="notify-read" data-id="${esc(item.id)}"><div><strong>${esc(item.title)}</strong><p>${esc(item.body || '')}</p></div><small>${item.readAt ? 'прочитано' : 'новое'}</small></button>`).join('');
  modal('Уведомления', `<div id="notify-list">${rows || '<p class="hint">Пока пусто. Новая задача, лид, проверка и пропущенный звонок появятся здесь.</p>'}</div><div class="actions"><button type="button" class="btn" data-action="notify-read-all">Отметить прочитанными</button><button type="button" class="btn" data-action="notify-telegram">Привязать Telegram</button></div><p class="hint">Если бот не подключён, сообщения остаются только в этом списке.</p>`, '', () => 'saved');
}

async function notifyRead(id) {
  const item = notifyItems.find(entry => entry.id === id);
  const response = await fetch('/api/notifications/read', {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-Requested-With': 'ActivProfi'},
    body: JSON.stringify(id ? {id} : {all: true}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(data.error || 'Не удалось отметить уведомление');
  notifyItems = data.items || [];
  notifyUnread = data.unread || 0;
  if (item?.refKind === 'client' && item.refId) { selected = item.refId; page = 'clients'; }
  if (item?.refKind === 'project' && item.refId) { projectId = item.refId; page = 'project'; }
  if (item?.refKind === 'task' && item.refId) page = 'tasks';
  const dialog = document.querySelector('#modal');
  if (dialog?.open) dialog.close();
  render();
}

async function notifyTelegram() {
  const response = await fetch('/api/notifications/telegram', {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-Requested-With': 'ActivProfi'},
    body: '{}',
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(data.error || 'Не удалось подготовить код');
  const link = data.url ? `<p><a href="${esc(data.url)}" target="_blank" rel="noopener">Открыть бота</a></p>` : '';
  const bot = data.bellOnly
    ? '<p>Бот не подключён. Уведомления приходят только в колокольчик. Администратор может задать TELEGRAM_BOT_TOKEN в настройках сервера. Сам ключ в программу не вставляйте.</p>'
    : `<p>Откройте бота @${esc(data.bot)} и отправьте код. Либо нажмите ссылку: бот получит код сам.</p>${link}<p><b>${esc(data.code)}</b></p>`;
  modal('Telegram для уведомлений', (data.linked ? '<p>Telegram уже привязан. Новый код заменит чат, когда вы отправите его боту.</p>' : '') + bot, '', () => 'saved');
}
