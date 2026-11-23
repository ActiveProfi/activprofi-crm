let mailStatus = {loaded: false, configured: false, from: '', fromName: ''};

async function loadMailStatus() {
  const response = await fetch('/api/mail', {headers: {'X-Requested-With': 'ActivProfi'}});
  const data = await response.json().catch(() => ({}));
  if (response.ok) mailStatus = {loaded: true, configured: !!data.configured, from: data.from || '', fromName: data.fromName || ''};
  return mailStatus;
}

function mailBanner() {
  if (!mailStatus.loaded) return '<div class="inbox-banner">Проверяем, подключена ли почта…</div>';
  if (!mailStatus.configured) return '<div class="inbox-banner"><strong>Почта не подключена — обратитесь к администратору.</strong> Черновик сохранится, клиент письмо не получит.</div>';
  return `<div class="inbox-banner">Почта подключена, письма уходят от ${esc(mailStatus.from)}. Перед отправкой видно, кому уходит сообщение.</div>`;
}

function clientMailAddress(client) {
  return String(client?.email || '').trim();
}

function clientTelegramLabel(client) {
  const conversation = (state.conversations || []).find(item => item.clientId === client?.id && item.channelId === 'telegram' && item.externalChatId && !item.demo);
  if (conversation) return 'чат ' + conversation.externalChatId;
  const project = client?.project && (state.projects || []).find(item => item.id === client.project);
  if (project) return 'группа проекта «' + project.title + '»';
  return '';
}

async function mailApi(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-Requested-With': 'ActivProfi'},
    body: JSON.stringify(body || {}),
  });
  const data = await response.json().catch(() => ({}));
  if (data.state) adoptWorkspace(data);
  if (!response.ok) throw Error(data.error || 'Не удалось отправить');
  if (data.delivery?.status === 'error') throw Error(data.delivery.error || 'Не удалось отправить');
  return data;
}

function mailClient(id) {
  const client = state.clients.find(item => item.id === id);
  if (!client || !M.canClient(state, u(), client)) throw Error('Это не ваш клиент');
  const to = clientMailAddress(client);
  if (!to) throw Error('У клиента нет почты');
  const materials = (state.materials || []).filter(item => item.projectId && item.projectId === client.project);
  const files = materials.length ? selectField('Файл проекта', 'materialId', option('', 'Без файла', '') + materials.map(item => option(item.id, item.name, '')).join('')) : '';
  const kp = client.kpLink ? '<label class="member-choice"><input type="checkbox" name="kp" checked> Приложить ссылку на КП</label>' : '';
  const hint = mailStatus.configured ? '' : '<p class="hint">Почта не подключена — обратитесь к администратору. Письмо останется черновиком.</p>';
  modal('Письмо клиенту', `<p class="mail-confirm"><strong>Кому:</strong> ${esc(to)}, <strong>канал:</strong> почта</p>` + hint + field('Тема', 'subject', 'Сообщение по сделке', 'text', true) + area('Текст', 'text', 'Здравствуйте!') + files + kp, mailStatus.configured ? 'Отправить' : 'Сохранить черновик', async fd => {
    if (!window.confirm('Кому: ' + to + ', канал: почта?')) return false;
    try {
      await mailApi('/api/mail/send', {clientId: client.id, to, confirmTo: to, subject: fd.get('subject'), text: fd.get('text'), materialId: fd.get('materialId') || '', includeKpLink: fd.get('kp') === 'on'});
      toast(mailStatus.configured ? 'Письмо отправлено' : 'Черновик сохранён');
    } catch (error) {
      toast(error.message);
      throw error;
    }
  });
}

function mailTest() {
  if (u().role !== 'admin') throw Error('Почту проверяет администратор');
  if (!mailStatus.configured) throw Error('Почта не подключена — обратитесь к администратору');
  modal('Проверить почту', `<p class="hint">На этот адрес уйдёт короткое письмо от ${esc(mailStatus.from || 'CRM')}.</p>` + field('Кому', 'to', mailStatus.from || '', 'email', true), 'Отправить проверку', async fd => {
    const to = String(fd.get('to') || '').trim();
    await mailApi('/api/mail/test', {to});
    toast('Проверочное письмо отправлено на ' + to);
  });
}

function inboxSendHint(client, conversation) {
  const email = clientMailAddress(client);
  const telegram = clientTelegramLabel(client);
  if (conversation?.channelId === 'telegram' && telegram && !conversation.demo) return {channel: 'Telegram', to: telegram, button: 'Отправить в Telegram'};
  if (mailStatus.configured && email) return {channel: 'почта', to: email, button: 'Отправить письмо'};
  if (telegram && !conversation?.demo) return {channel: 'Telegram', to: telegram, button: 'Отправить в Telegram'};
  if (email) return {channel: 'почта', to: email, button: 'Сохранить черновик', off: true};
  return {channel: '', to: '', button: 'Сохранить черновик', off: true, missing: true};
}
