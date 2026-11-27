let pitchTemplate = null;

async function pitchApi(path, body, method) {
  const response = await fetch(path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: {'Content-Type': 'application/json', 'X-Requested-With': 'ActivProfi'},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (data.state) adoptWorkspace(data);
  if (!response.ok) throw Error(data.error || 'Не удалось сохранить');
  return data;
}

async function loadPitch() {
  const response = await fetch('/api/pitch', {headers: {'X-Requested-With': 'ActivProfi'}});
  const data = await response.json().catch(() => ({}));
  if (response.ok) pitchTemplate = data.template || null;
}

function payTotals(client) {
  const rows = client.payments || [];
  const invoiced = rows.filter(item => item.kind === 'invoice').reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  const paid = rows.filter(item => item.kind === 'payment').reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  return {invoiced, paid, left: Math.max(0, invoiced - paid), balance: (Number(client?.amount) || 0) - paid};
}

function pitchSection(client) {
  if (!client || !M.canClient(state, u(), client)) return '';
  const decks = client.decks || [];
  const rows = decks.map(item => `<p><b>v${item.version}</b> · ${esc(item.title)} · ${esc((item.createdAt || '').slice(0, 10))} <a href="/api/pitch/files/${esc(item.fileId)}" target="_blank" rel="noopener">PDF</a></p>`).join('');
  return `<section class="kp-card"><h3>Презентация</h3>${rows || '<p>Презентаций пока нет.</p>'}<div class="actions">${action('Собрать презентацию', 'pitch-build', client.id, true)}${decks.length ? action('Отправить презентацию', 'pitch-send', client.id) : ''}</div></section>`;
}

function paySection(client) {
  if (!client || !M.canClient(state, u(), client)) return '';
  const totals = payTotals(client);
  const rows = (client.payments || []).map(item => `<p>${item.kind === 'invoice' ? 'Счёт' : 'Оплата'} · ${esc(money(item.amount))} · ${esc((item.at || '').slice(0, 10))} · ${esc(item.note || '')}${item.fileId ? ` <a href="/api/pitch/files/${esc(item.fileId)}" target="_blank" rel="noopener">PDF</a>` : ''}</p>`).join('');
  return `<section class="kp-card" id="deal-balance"><h3>Оплаты</h3><p>Сумма сделки ${esc(money(client.amount || 0))}. Выставлено ${esc(money(totals.invoiced))}. Оплачено ${esc(money(totals.paid))}. Остаток по сделке ${esc(money(totals.balance))}.</p><p class="hint">Остаток — это сумма сделки минус уже оплаченное. Кнопки только записывают счёт и оплату в CRM. Деньги идут через банк.</p>${rows || '<p>Счетов и оплат пока нет.</p>'}<div class="actions">${action('Выставить счёт', 'pay-invoice', client.id)}${action('Отметить оплату', 'pay-mark', client.id)}</div></section>`;
}

function pitchRead() {
  const root = document.querySelector('#pitch-editor');
  return {
    title: root.querySelector('[name=title]').value.trim(),
    slides: [...root.querySelectorAll('[data-slide]')].map(slide => ({
      title: slide.querySelector('.pitch-title').value.trim(),
      body: slide.querySelector('.pitch-body').value.trim(),
    })).filter(slide => slide.title && slide.body),
  };
}

function pitchSlideHtml(slide = {title: '', body: ''}) {
  return `<div class="kp-variant" data-slide><label>Заголовок слайда<input class="pitch-title" value="${esc(slide.title)}"></label><label>Текст<textarea class="pitch-body">${esc(slide.body)}</textarea></label><button type="button" data-pitch-remove>Убрать слайд</button></div>`;
}

function pitchBuild(id) {
  const client = state.clients.find(item => item.id === id);
  if (!client || !M.canClient(state, u(), client)) throw Error('Это не ваша сделка');
  const proposal = (client.proposals || []).at(-1);
  const slides = [
    {title: 'Задача', body: client.clientTask || client.description || 'Описать задачу клиента'},
    {title: 'Решение', body: proposal?.solution || 'Показать, что сделает студия'},
    {title: 'Варианты', body: client.kpVariants || 'Коротко: базовый, оптимальный и максимальный'},
    {title: 'Следующий шаг', body: client.next || 'Согласовать вариант и счёт'},
  ];
  modal('Собрать презентацию', `<div id="pitch-editor"><p class="hint">Короткие слайды для клиента. Нейросеть их пока не пишет.</p>${field('Название', 'title', 'Презентация · ' + (client.company || client.name), 'text', true)}<div class="kp-variants">${slides.map(pitchSlideHtml).join('')}</div><button type="button" class="btn" data-pitch-add>Добавить слайд</button><div class="actions"><button type="button" class="btn" id="pitch-preview-btn">Предпросмотр</button></div><iframe class="kp-preview" id="pitch-preview-frame" hidden title="Предпросмотр презентации"></iframe></div>`, 'Сохранить презентацию', async () => {
    const deck = pitchRead();
    if (!deck.slides.length) throw Error('Добавьте хотя бы один слайд');
    await pitchApi('/api/pitch/documents', {clientId: client.id, deck});
    toast('Презентация сохранена');
    return 'saved';
  });
  document.querySelector('#pitch-preview-btn').onclick = async () => {
    try {
      const data = await pitchApi('/api/pitch/preview', {clientId: client.id, deck: pitchRead()});
      const frame = document.querySelector('#pitch-preview-frame');
      frame.hidden = false;
      frame.srcdoc = data.html;
    } catch (error) { toast(error.message); }
  };
}

function pitchSend(id) {
  const client = state.clients.find(item => item.id === id);
  if (!client || !M.canClient(state, u(), client)) throw Error('Это не ваша сделка');
  const deck = (client.decks || []).at(-1);
  if (!deck) throw Error('Сначала сохраните презентацию');
  if (!client.email) throw Error('У клиента нет почты');
  modal('Отправить презентацию', `<p class="mail-confirm"><strong>Кому:</strong> ${esc(client.email)}, <strong>канал:</strong> почта. Вложение: ${esc(deck.fileName)}, версия v${deck.version}.</p>${field('Тема', 'subject', 'Презентация', 'text', true)}${area('Текст', 'text', 'Здравствуйте!\n\nНаправляем презентацию.')}`, 'Отправить', async fd => {
    if (!window.confirm('Кому: ' + client.email + ', канал: почта?')) return false;
    await pitchApi('/api/pitch/send', {clientId: client.id, deckId: deck.id, to: client.email, confirmTo: client.email, subject: fd.get('subject'), text: fd.get('text')});
    toast('Презентация отправлена');
    return 'saved';
  });
}

async function pitchSuggest(id) {
  const client = state.clients.find(item => item.id === id);
  if (!client || !M.canClient(state, u(), client)) throw Error('Это не ваша сделка');
  const data = await pitchApi('/api/pitch/suggest', {clientId: client.id});
  toast(data.message || 'Черновик презентации нейросетью пока не подключен');
}

async function pitchTemplateForm() {
  if (u().role !== 'admin') throw Error('Шаблон презентации меняет администратор');
  if (!pitchTemplate) await loadPitch();
  const template = pitchTemplate || {};
  modal('Шаблон презентации', field('Заголовок вида', 'title', template.title || 'Презентация', 'text', true) + area('Вступление в шапке', 'intro', template.intro || '') + field('Подвал', 'footer', template.footer || 'АктивПрофи · студия автоматизации', 'text', true) + '<p class="hint">Логотип АктивПрофи виден в предпросмотре. В PDF в шапке написано «АктивПрофи».</p>', 'Сохранить шаблон', async fd => {
    const data = await pitchApi('/api/pitch/template', {title: fd.get('title'), intro: fd.get('intro'), footer: fd.get('footer')}, 'PUT');
    pitchTemplate = data.template || pitchTemplate;
    toast('Шаблон презентации сохранён');
    return 'saved';
  });
}

function payInvoice(id) {
  const client = state.clients.find(item => item.id === id);
  if (!client || !M.canClient(state, u(), client)) throw Error('Это не ваша сделка');
  modal('Выставить счёт', `<p class="hint">Счёт сохранится в карточке и в PDF. Деньги через CRM не проходят.</p>${field('Сумма', 'amount', client.amount || 0, 'number', true)}${area('Основание', 'note', client.kpChoice ? 'Вариант ' + client.kpChoice : 'Оплата по сделке')}`, 'Сохранить счёт', async fd => {
    const body = {clientId: client.id, amount: fd.get('amount'), note: fd.get('note')};
    try { await pitchApi('/api/payments/invoice', body); }
    catch (error) {
      if (!/больше суммы сделки/.test(error.message) || !window.confirm(error.message)) throw error;
      await pitchApi('/api/payments/invoice', {...body, confirmOver: true});
    }
    toast('Счёт записан');
    return 'saved';
  });
}

function payMark(id) {
  const client = state.clients.find(item => item.id === id);
  if (!client || !M.canClient(state, u(), client)) throw Error('Это не ваша сделка');
  const left = payTotals(client).left || client.amount || 0;
  modal('Отметить оплату', `<p class="hint">Отметьте сумму, которая пришла на счёт студии. Это запись в CRM, не платёж из банка.</p>${field('Сумма', 'amount', left, 'number', true)}${area('Комментарий', 'note', 'Оплата получена')}`, 'Записать оплату', async fd => {
    await pitchApi('/api/payments', {clientId: client.id, amount: fd.get('amount'), note: fd.get('note')});
    toast('Оплата записана');
    return 'saved';
  });
}

document.addEventListener('click', event => {
  const add = event.target.closest('[data-pitch-add]');
  if (add) {
    event.preventDefault();
    document.querySelector('#pitch-editor .kp-variants').insertAdjacentHTML('beforeend', pitchSlideHtml({title: 'Новый слайд', body: ''}));
  }
  const remove = event.target.closest('[data-pitch-remove]');
  if (remove) {
    event.preventDefault();
    remove.closest('[data-slide]')?.remove();
  }
});
