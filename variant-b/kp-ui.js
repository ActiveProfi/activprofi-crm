let kpCatalogue = [];
let kpTemplate = null;

async function kpApi(path, body, method) {
  const response = await fetch(path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: {'Content-Type': 'application/json', 'X-Requested-With': 'ActivProfi'},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (data.state) adoptWorkspace(data);
  if (!response.ok) throw Error(data.error || 'Не удалось сохранить КП');
  return data;
}

async function loadKp() {
  const response = await fetch('/api/kp', {headers: {'X-Requested-With': 'ActivProfi'}});
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return;
  kpCatalogue = data.catalogue || [];
  kpTemplate = data.template || null;
}

function kpLineTotal(line) {
  return (Number(line.qty) || 0) * (Number(line.price) || 0);
}

function kpVariantTotal(variant) {
  const subtotal = (variant.lines || []).reduce((sum, line) => sum + kpLineTotal(line), 0);
  const discount = Math.min(100, Math.max(0, Number(variant.discount) || 0));
  return Math.round(subtotal * (1 - discount / 100));
}

function kpSection(client) {
  if (!client || !M.canClient(state, u(), client)) return '';
  const versions = client.proposals || [];
  const rows = versions.map(item => `<p><b>v${item.version}</b> · ${esc((item.createdAt || '').slice(0, 10))} · ${esc(item.choice || '')} <a href="/api/kp/files/${esc(item.fileId)}" target="_blank" rel="noopener">PDF</a></p>`).join('');
  const link = String(client.kpLink || '').trim();
  const linkHtml = link ? `<p>Интерактивное КП: ${/^https?:\/\//i.test(link) ? `<a href="${esc(link)}" target="_blank" rel="noopener noreferrer">${esc(link)}</a>` : esc(link)}</p>` : '<p>Ссылка на интерактивное КП не указана. Её можно добавить при сборке.</p>';
  return `<section class="kp-card"><h3>КП</h3>${rows || '<p>Версий пока нет. Соберите первую.</p>'}${linkHtml}<div class="actions">${action('Собрать КП', 'kp-build', client.id, true)}${versions.length ? action('Отправить КП', 'kp-send', client.id) : ''}${action('Черновик от нейросети', 'kp-suggest', client.id)}</div></section>`;
}

function kpServiceOptions(selected) {
  const custom = `<option value="">Своя строка</option>`;
  return custom + kpCatalogue.map(item => `<option value="${esc(item.id)}"${item.id === selected ? ' selected' : ''}>${esc(item.name)} · ${esc(money(item.price))}</option>`).join('');
}

function kpLineHtml(line = {}) {
  return `<div class="kp-line"><select class="kp-service" aria-label="Услуга из прайса">${kpServiceOptions(line.serviceId)}</select><input class="kp-name" aria-label="Название строки" value="${esc(line.name || '')}" placeholder="Название"><input class="kp-qty" aria-label="Количество" type="number" min="0" step="1" value="${esc(line.qty || 1)}"><input class="kp-price" aria-label="Цена" type="number" min="0" step="1" value="${esc(line.price || 0)}"><button type="button" data-kp-remove>Убрать</button></div>`;
}

function kpReadLine(row) {
  const service = kpCatalogue.find(item => item.id === row.querySelector('.kp-service').value);
  return {
    serviceId: service?.id || '',
    name: row.querySelector('.kp-name').value.trim() || service?.name || '',
    description: service?.description || '',
    unit: service?.unit || 'шт.',
    qty: Number(row.querySelector('.kp-qty').value) || 0,
    price: Number(row.querySelector('.kp-price').value) || 0,
  };
}

function kpReadForm() {
  const root = document.querySelector('#kp-editor');
  if (!root) throw Error('Форма КП закрыта');
  const variants = [...root.querySelectorAll('[data-variant]')].map(box => ({
    name: box.querySelector('.kp-vname').value.trim(),
    duration: box.querySelector('.kp-vduration').value.trim(),
    discount: Number(box.querySelector('.kp-vdiscount').value) || 0,
    fromPrice: box.querySelector('.kp-vfrom').checked,
    lines: [...box.querySelectorAll('.kp-line')].map(kpReadLine).filter(line => line.name && line.qty > 0),
  })).filter(variant => variant.name && variant.lines.length);
  return {
    task: root.querySelector('[name=task]').value.trim(),
    solution: root.querySelector('[name=solution]').value.trim(),
    stages: root.querySelector('[name=stages]').value.trim(),
    timeline: root.querySelector('[name=timeline]').value.trim(),
    kpLink: root.querySelector('[name=kpLink]').value.trim(),
    choice: root.querySelector('[name=choice]').value,
    variants,
  };
}

function kpRefreshTotals() {
  const root = document.querySelector('#kp-editor');
  if (!root) return;
  for (const box of root.querySelectorAll('[data-variant]')) {
    const variant = {
      discount: Number(box.querySelector('.kp-vdiscount').value) || 0,
      fromPrice: box.querySelector('.kp-vfrom').checked,
      lines: [...box.querySelectorAll('.kp-line')].map(kpReadLine),
    };
    const total = kpVariantTotal(variant);
    box.querySelector('.kp-total').textContent = (variant.fromPrice ? 'от ' : '') + money(total);
  }
  const choice = root.querySelector('[name=choice]');
  const names = [...root.querySelectorAll('.kp-vname')].map(input => input.value.trim()).filter(Boolean);
  const current = choice.value;
  choice.innerHTML = names.map(name => `<option${name === current ? ' selected' : ''}>${esc(name)}</option>`).join('');
}

function kpBuild(id) {
  const client = state.clients.find(item => item.id === id);
  if (!client || !M.canClient(state, u(), client)) throw Error('Это не ваша сделка');
  const names = ['Базовый', 'Оптимальный', 'Максимум'];
  const durations = ['2 недели', '1–1,5 месяца', '2,5–3 месяца'];
  const columns = names.map((name, index) => `<section class="kp-variant" data-variant><label>Название<input class="kp-vname" value="${name}"></label><label>Срок<input class="kp-vduration" value="${durations[index]}"></label><label>Скидка, %<input class="kp-vdiscount" type="number" min="0" max="100" value="0"></label><label class="member-choice"><input class="kp-vfrom" type="checkbox" ${index ? 'checked' : ''}> показывать сумму как «от»</label><div class="kp-lines">${kpLineHtml()}</div><button type="button" data-kp-add>Добавить строку</button><p class="kp-total">0 ₽</p></section>`).join('');
  modal('Собрать КП', `<div id="kp-editor"><p class="hint">До трёх вариантов рядом. Строки берутся из прайса или пишутся вручную. Нейросеть пока не заполняет текст — кнопка ниже только показывает, куда её подключат.</p>${area('Задача клиента', 'task', client.clientTask || client.description || '')}${area('Решение', 'solution', '')}${area('Этапы', 'stages', '1. Обследование\n2. Настройка\n3. Запуск')}${field('Общий срок', 'timeline', '', 'text')}${field('Ссылка на интерактивное КП', 'kpLink', client.kpLink || '', 'text')}<label class="field">Какой вариант выбран для передачи в проект<select name="choice">${names.map(name => `<option>${name}</option>`).join('')}</select></label><div class="kp-variants">${columns}</div><div class="actions"><button type="button" class="btn" id="kp-preview-btn">Предпросмотр</button></div><iframe class="kp-preview" id="kp-preview-frame" hidden title="Предпросмотр КП"></iframe></div>`, 'Сохранить версию', async () => {
    const documentKp = kpReadForm();
    if (!documentKp.variants.length) throw Error('Добавьте хотя бы один вариант с услугой');
    let data;
    try { data = await kpApi('/api/kp/documents', {clientId: client.id, document: documentKp}); }
    catch (error) {
      if (!/изменит сумму сделки/.test(error.message) || !window.confirm(error.message)) throw error;
      data = await kpApi('/api/kp/documents', {clientId: client.id, document: documentKp, confirmAmount: true});
    }
    toast('Сохранена версия КП v' + ((data.state?.clients || []).find(item => item.id === client.id)?.proposals || []).at(-1)?.version);
    return 'saved';
  });
  document.querySelector('#kp-preview-btn').onclick = async () => {
    try {
      const data = await kpApi('/api/kp/preview', {clientId: client.id, document: kpReadForm()});
      const frame = document.querySelector('#kp-preview-frame');
      frame.hidden = false;
      frame.srcdoc = data.html;
    } catch (error) { toast(error.message); }
  };
  kpRefreshTotals();
}

function kpSend(id) {
  const client = state.clients.find(item => item.id === id);
  if (!client || !M.canClient(state, u(), client)) throw Error('Это не ваша сделка');
  const proposal = (client.proposals || []).at(-1);
  if (!proposal) throw Error('Сначала сохраните версию КП');
  if (!client.email) throw Error('У клиента нет почты');
  const off = typeof mailStatus !== 'undefined' && mailStatus.loaded && !mailStatus.configured;
  modal('Отправить КП', `<p class="mail-confirm"><strong>Кому:</strong> ${esc(client.email)}, <strong>канал:</strong> почта. Вложение: ${esc(proposal.fileName || 'PDF')}, версия v${proposal.version}.</p>` + (off ? '<p class="hint">Почта не подключена — обратитесь к администратору.</p>' : '') + field('Тема', 'subject', 'Коммерческое предложение', 'text', true) + area('Текст', 'text', 'Здравствуйте!\n\nНаправляем коммерческое предложение.'), off ? '' : 'Отправить', async fd => {
    if (!window.confirm('Кому: ' + client.email + ', канал: почта?')) return false;
    const data = await kpApi('/api/kp/send', {clientId: client.id, proposalId: proposal.id, to: client.email, confirmTo: client.email, subject: fd.get('subject'), text: fd.get('text')});
    toast('КП отправлено. Сделка на этапе «' + (data.stage || 'Отправлено КП') + '».');
    return 'saved';
  });
}

async function kpSuggest(id) {
  const client = state.clients.find(item => item.id === id);
  if (!client || !M.canClient(state, u(), client)) throw Error('Это не ваша сделка');
  const data = await kpApi('/api/kp/suggest', {clientId: client.id});
  toast(data.message || 'Автозаполнение нейросетью пока не подключено');
}

async function kpTemplateForm() {
  if (u().role !== 'admin') throw Error('Шаблон КП меняет администратор');
  if (!kpTemplate) await loadKp();
  const template = kpTemplate || {};
  modal('Шаблон КП', field('Заголовок', 'title', template.title || 'Коммерческое предложение', 'text', true) + area('Вступление', 'intro', template.intro || '') + area('Условия', 'terms', template.terms || '') + field('Подвал', 'footer', template.footer || 'АктивПрофи · студия автоматизации', 'text', true) + '<p class="hint">Логотип АктивПрофи подставляется в предпросмотр сам. В PDF в шапке написано «АктивПрофи».</p>', 'Сохранить шаблон', async fd => {
    const data = await kpApi('/api/kp/template', {title: fd.get('title'), intro: fd.get('intro'), terms: fd.get('terms'), footer: fd.get('footer')}, 'PUT');
    kpTemplate = data.template || kpTemplate;
    toast('Шаблон КП сохранён');
    return 'saved';
  });
}

async function kpCatalogueForm() {
  if (u().role !== 'admin') throw Error('Прайс меняет администратор');
  if (!kpCatalogue.length) await loadKp();
  const rows = (kpCatalogue.length ? kpCatalogue : [{name: '', description: '', unit: 'проект', price: 0, days: 0}]).map((item, index) => `<div class="kp-service-row"><input name="name" aria-label="Услуга ${index + 1}" value="${esc(item.name || '')}" placeholder="Услуга"><input name="description" aria-label="Описание ${index + 1}" value="${esc(item.description || '')}" placeholder="Описание"><input name="unit" aria-label="Единица ${index + 1}" value="${esc(item.unit || 'проект')}" placeholder="Единица"><input name="price" aria-label="Цена ${index + 1}" type="number" min="0" value="${esc(item.price || 0)}"><input name="days" aria-label="Срок в днях ${index + 1}" type="number" min="0" value="${esc(item.days || 0)}"></div>`).join('');
  modal('Прайс услуг', `<p class="hint">Колонки: услуга, описание, единица, цена, обычный срок в днях. Пустые строки не сохраняются.</p><div id="kp-catalogue">${rows}</div><button type="button" class="btn" id="kp-add-service">Добавить услугу</button>`, 'Сохранить прайс', async () => {
    const services = [...document.querySelectorAll('#kp-catalogue .kp-service-row')].map(row => ({
      name: row.querySelector('[name=name]').value,
      description: row.querySelector('[name=description]').value,
      unit: row.querySelector('[name=unit]').value,
      price: Number(row.querySelector('[name=price]').value) || 0,
      days: Number(row.querySelector('[name=days]').value) || 0,
    })).filter(item => item.name.trim());
    const data = await kpApi('/api/kp/catalogue', {services}, 'PUT');
    kpCatalogue = data.catalogue || kpCatalogue;
    toast('Прайс сохранён');
    return 'saved';
  });
  document.querySelector('#kp-add-service').onclick = () => {
    const box = document.querySelector('#kp-catalogue');
    box.insertAdjacentHTML('beforeend', '<div class="kp-service-row"><input name="name" placeholder="Услуга"><input name="description" placeholder="Описание"><input name="unit" value="проект"><input name="price" type="number" min="0" value="0"><input name="days" type="number" min="0" value="0"></div>');
  };
}

document.addEventListener('click', event => {
  const add = event.target.closest('[data-kp-add]');
  if (add) {
    event.preventDefault();
    add.parentElement.querySelector('.kp-lines').insertAdjacentHTML('beforeend', kpLineHtml());
    kpRefreshTotals();
  }
  const remove = event.target.closest('[data-kp-remove]');
  if (remove) {
    event.preventDefault();
    remove.closest('.kp-line')?.remove();
    kpRefreshTotals();
  }
});
document.addEventListener('change', event => {
  if (!event.target.closest('#kp-editor')) return;
  if (event.target.classList.contains('kp-service')) {
    const service = kpCatalogue.find(item => item.id === event.target.value);
    const row = event.target.closest('.kp-line');
    if (service && row) {
      row.querySelector('.kp-name').value = service.name;
      row.querySelector('.kp-price').value = service.price;
    }
  }
  kpRefreshTotals();
});
document.addEventListener('input', event => {
  if (event.target.closest('#kp-editor')) kpRefreshTotals();
});
