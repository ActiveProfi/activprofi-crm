let sipuniStatus = {loaded: false, configured: false, extension: '', message: '', missed: [], unknown: [], revision: 0};

async function sipuniApi(path, body) {
  const response = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: {'Content-Type': 'application/json', 'X-Requested-With': 'ActivProfi'},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(data.error || 'Не удалось выполнить запрос');
  return data;
}

async function loadSipuni() {
  if (!state) return false;
  const response = await fetch('/api/sipuni', {headers: {'X-Requested-With': 'ActivProfi'}});
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return false;
  const previous = JSON.stringify(sipuniStatus);
  sipuniStatus = {
    loaded: true,
    configured: !!data.configured,
    extension: data.extension || '',
    message: data.message || '',
    missed: data.missed || [],
    unknown: data.unknown || [],
    revision: data.revision || 0,
  };
  if (data.revision && state && data.revision !== state.revision && !document.querySelector('#modal')?.open) {
    const workspace = await fetch('/api/workspace');
    const fresh = await workspace.json().catch(() => ({}));
    if (workspace.ok && fresh.state) adoptWorkspace(fresh);
  }
  return previous !== JSON.stringify(sipuniStatus);
}

function sipuniBanner() {
  if (!sipuniStatus.loaded) return '';
  const parts = [];
  if (!sipuniStatus.configured) parts.push('<div class="inbox-banner"><strong>Телефония не подключена — обратитесь к администратору.</strong></div>');
  for (const item of sipuniStatus.missed) {
    parts.push(`<div class="inbox-banner"><strong>Пропущенный звонок: ${esc(item.name)}, ${esc(item.phone)}</strong> <button type="button" class="btn" data-action="sipuni-open" data-id="${esc(item.clientId)}">Открыть карточку</button></div>`);
  }
  for (const item of sipuniStatus.unknown) {
    parts.push(`<div class="inbox-banner"><strong>Неизвестный номер ${esc(item.phone)}.</strong> Можно завести новый лид. <button type="button" class="btn" data-action="sipuni-lead" data-id="${esc(item.digits)}">Создать лид</button></div>`);
  }
  return parts.join('');
}

function sipuniCallButton(client) {
  if (!client?.phone || !M.canClient(state, u(), client)) return '';
  const hint = sipuniStatus.loaded && sipuniStatus.configured && !sipuniStatus.extension ? '<p class="hint">Ваш внутренний номер Sipuni не указан. Его вписывает администратор в карточке сотрудника.</p>' : '';
  return `<div class="actions sipuni-call">${action('Позвонить', 'sipuni-call', client.id, true)}</div>${hint}`;
}

async function sipuniCall(id) {
  const client = vc().find(item => item.id === id);
  if (!client) throw Error('Это не ваш клиент');
  if (!client.phone) throw Error('У клиента нет телефона');
  if (!sipuniStatus.loaded) await loadSipuni();
  if (!sipuniStatus.configured) throw Error('Телефония не подключена — обратитесь к администратору');
  if (!sipuniStatus.extension) throw Error('В вашей карточке не указан внутренний номер Sipuni. Попросите администратора вписать его в «Команда и роли».');
  const text = 'Звоним: ' + client.name + ', ' + client.phone;
  if (!window.confirm(text)) return;
  const data = await sipuniApi('/api/sipuni/call', {clientId: client.id, confirmName: client.name, confirmPhone: client.phone});
  if (data.state) adoptWorkspace(data);
  toast(data.message || text);
  render();
}

async function sipuniOpen(id) {
  if (!vc().some(item => item.id === id)) throw Error('Клиент недоступен');
  selected = id;
  page = 'clients';
  await sipuniApi('/api/sipuni/seen', {clientId: id}).catch(() => {});
  await loadSipuni();
  render();
}

function sipuniLead(digits) {
  if (!M.has(state, u(), 'clients.edit')) throw Error('Создавать лиды может сотрудник с правом редактировать клиентов');
  const offer = sipuniStatus.unknown.find(item => item.digits === digits);
  const phone = offer?.phone || digits;
  modal('Новый лид из звонка', `<p class="hint">Этого номера нет в базе. Лид будет вашим, другие менеджеры его не увидят.</p>` + field('Имя', 'name', '', 'text', true) + field('Телефон', 'phone', phone, 'tel', true), 'Создать лид', async fd => {
    const data = await sipuniApi('/api/sipuni/lead', {phone: digits, name: fd.get('name'), confirmPhone: fd.get('phone')});
    if (data.state) adoptWorkspace(data);
    selected = data.clientId;
    page = 'clients';
    await loadSipuni();
    toast(data.message || 'Лид создан');
    return 'saved';
  });
}

async function sipuniTest() {
  if (u().role !== 'admin') throw Error('Проверить телефонию может администратор');
  const data = await sipuniApi('/api/sipuni/test', {});
  toast(data.message);
}

setInterval(() => {
  if (!state || document.querySelector('#modal')?.open) return;
  loadSipuni().then(changed => { if (changed && state) render(); }).catch(() => {});
}, 60000);
