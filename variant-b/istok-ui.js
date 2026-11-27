let mailingStage = '';
let mailingBatch = '';
let mailingSource = '';
let mailingOwner = '';
let mailingLoss = '';
let mailingSelections = [];
let mailingShowList = false;

function mailingChoices() {
  const mine = vc();
  const stages = [];
  for (const pipe of state.pipelines || []) for (const stage of pipe.stages || []) stages.push(stage);
  const batches = (state.leadBatches || []).filter(batch => !batch.groupedInto && mine.some(client => client.batchId === batch.id));
  const sources = [...new Set(mine.map(client => client.source).filter(Boolean))];
  const wide = u().role === 'admin' || M.has(state, u(), 'clients.all');
  const owners = wide ? (state.users || []).filter(person => person.role === 'sales' || person.role === 'sales_intern' || person.role === 'admin') : [u()];
  if (!wide) mailingOwner = u().id;
  return {mine, stages, batches, sources, owners, wide};
}

function mailingToolbar() {
  const {stages, batches, sources, owners, wide} = mailingChoices();
  return `<div class="toolbar mailing-toolbar"><select id="mailing-stage" aria-label="Этап выборки">${option('', 'Все этапы', mailingStage)}${option('base', 'Общая база', mailingStage)}${stages.map(stage => option(stage.id, stage.name, mailingStage)).join('')}</select><select id="mailing-batch" aria-label="База выборки">${option('', 'Все базы', mailingBatch)}${batches.map(batch => option(batch.id, batch.name, mailingBatch)).join('')}</select><select id="mailing-source" aria-label="Источник выборки">${option('', 'Все источники', mailingSource)}${sources.map(source => option(source, source, mailingSource)).join('')}</select>${wide ? `<select id="mailing-owner" aria-label="Чьи клиенты">${option('', 'Все менеджеры', mailingOwner)}${owners.map(person => option(person.id, person.name, mailingOwner)).join('')}</select>` : ''}<select id="mailing-loss" aria-label="Причина отказа">${option('', 'Все причины отказа', mailingLoss)}${[['price','Цена'],['timing','Сроки'],['other-vendor','Выбрал другого'],['no-need','Нет потребности'],['no-answer','Не отвечает'],['other','Другое']].map(([key,label]) => option(key, label, mailingLoss)).join('')}</select>${action('Отправить в рассылку', 'mailing-send', '', true)}${action('Выборки', 'mailing-list')}</div>${mailingShowList ? mailingListHtml() : ''}`;
}

function mailingListHtml() {
  const rows = mailingSelections.map(item => `<tr><td>${esc(item.name)}</td><td>${item.status === 'taken' ? 'Забрана' : 'Новая'}</td><td>${item.count}</td><td>${esc(item.createdAt ? new Date(item.createdAt).toLocaleString('ru-RU') : '')}</td><td>${esc(name(item.createdBy))}</td></tr>`).join('');
  return `<section class="panel" id="mailing-list"><div class="panel-head"><h2>Выборки для рассылки</h2></div>${rows ? `<div class="table-wrap"><table class="compact-clients"><thead><tr><th>Название</th><th>Статус</th><th>Контактов</th><th>Когда</th><th>Кто собрал</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="hint">Выборок пока нет. Отфильтруйте клиентов и нажмите «Отправить в рассылку».</p>'}</section>`;
}

async function loadSelections() {
  const response = await fetch('/api/mailing-selections', {headers: {'X-Requested-With': 'ActivProfi'}});
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(data.error || 'Не удалось открыть выборки');
  mailingSelections = data.selections || [];
  return mailingSelections;
}

async function mailingList() {
  await loadSelections();
  mailingShowList = true;
  render();
}

function mailingBody(includeWon) {
  return {stageId: mailingStage, batchId: mailingBatch, source: mailingSource, ownerId: mailingOwner, lossReason: mailingLoss, includeWon: !!includeWon};
}

async function mailingPreview(includeWon) {
  const response = await fetch('/api/mailing-selections/preview', {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-Requested-With': 'ActivProfi'},
    body: JSON.stringify(mailingBody(includeWon)),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(data.error || 'Не удалось собрать список');
  return data;
}

async function mailingSend(batchId) {
  if (batchId) mailingBatch = batchId;
  modal('Отправить в рассылку', '<p class="hint">Сначала список и число людей. Кто уже на этапе «В проекте», не попадает, пока не поставите галочку. Кто отмечен «не писать и не звонить», не попадает. Письма отсюда не уходят: список заберёт Исток.</p><label class="member-choice"><input type="checkbox" id="mailing-include-won"> Включить тех, кто уже «В проекте»</label><div id="mailing-preview"><p>Считаю список…</p></div>' + field('Название выборки', 'name', 'Рассылка · ' + M.today(), 'text', true), 'Создать выборку', async fd => {
    const includeWon = !!document.querySelector('#mailing-include-won')?.checked;
    const response = await fetch('/api/mailing-selections', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'X-Requested-With': 'ActivProfi'},
      body: JSON.stringify({name: fd.get('name'), ...mailingBody(includeWon)}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(data.error || 'Не удалось создать выборку');
    toast('Выборка «' + data.name + '»: ' + data.count + ' контактов');
    await loadSelections();
    mailingShowList = true;
  });
  const box = document.querySelector('#mailing-include-won');
  const paint = async () => {
    const preview = document.querySelector('#mailing-preview');
    if (!preview) return;
    const data = await mailingPreview(!!box?.checked);
    const lines = (data.people || []).map(person => `<p>${esc(person.name)} · ${esc(person.phone || person.email || person.stage || '')}</p>`).join('');
    const more = data.count > (data.people || []).length ? `<p>И ещё ${data.count - data.people.length}.</p>` : '';
    preview.innerHTML = `<p><b>${data.count}</b> контактов</p>${lines || '<p>По этому фильтру никого нет.</p>'}${more}`;
  };
  if (box) box.addEventListener('change', () => { paint().catch(error => toast(error.message)); });
  paint().catch(error => toast(error.message));
}

function toggleSilence(id) {
  const client = vc().find(item => item.id === id);
  if (!client) throw Error('Это не ваш клиент');
  client.doNotContact = !client.doNotContact;
  toast(client.doNotContact ? 'Этому клиенту больше не пишем и не звоним' : 'Снова можно писать и звонить');
}

function silenceButton(client) {
  if (!client || !M.canClient(state, u(), client)) return '';
  return action(client.doNotContact ? 'Снова можно писать' : 'Не писать и не звонить', 'toggle-silence', client.id);
}

async function istokKeys() {
  if (u().role !== 'admin') throw Error('Ключи создаёт администратор');
  const response = await fetch('/api/integration-keys', {headers: {'X-Requested-With': 'ActivProfi'}});
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(data.error || 'Не удалось открыть ключи');
  const rows = (data.keys || []).map(item => `<p><b>${esc(item.name)}</b> · ${esc(item.prefix)}… · ${item.scope === 'export:read' ? 'забирать выборки' : 'принимать лиды'}${item.revoked_at ? ' · отозван' : ''}</p>`).join('') || '<p>Ключей пока нет.</p>';
  modal('Ключи Истока', '<p class="hint">Ключ показывается один раз. «Принимать лиды» — Исток присылает контакты. «Забирать выборки» — Исток забирает список для рассылки. Один ключ делает только одно из этого.</p>' + rows + field('Название', 'name', 'Исток', 'text', true) + selectField('Что можно этому ключу', 'scope', option('leads:write', 'Принимать лиды', 'leads:write') + option('export:read', 'Забирать выборки', '')), 'Создать ключ', async fd => {
    const created = await fetch('/api/integration-keys', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'X-Requested-With': 'ActivProfi'},
      body: JSON.stringify({name: fd.get('name'), scope: fd.get('scope')}),
    });
    const payload = await created.json().catch(() => ({}));
    if (!created.ok) throw Error(payload.error || 'Не удалось создать ключ');
    modal('Ключ создан', `<p>Скопируйте его сейчас. Потом его не показать.</p><p><b>${esc(payload.key)}</b></p><p>${payload.scope === 'export:read' ? 'Этим ключом забирают выборки.' : 'Этим ключом присылают лиды.'}</p>`, '', () => 'saved');
    return false;
  });
}

document.addEventListener('change', event => {
  if (event.target.id === 'mailing-stage') mailingStage = event.target.value;
  if (event.target.id === 'mailing-batch') mailingBatch = event.target.value;
  if (event.target.id === 'mailing-source') mailingSource = event.target.value;
  if (event.target.id === 'mailing-owner') mailingOwner = event.target.value;
  if (event.target.id === 'mailing-loss') { mailingLoss = event.target.value; if (typeof render === 'function') render(); }
});
