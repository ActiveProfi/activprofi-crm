const crypto = require('node:crypto');
const {M} = require('./models.cjs');
const store = require('./store.cjs');
const {command} = require('./service.cjs');
const {HttpError} = require('./errors.cjs');
const {MAIL_OFF} = require('./outbound.cjs');
const {renderBlocksPdf, rub} = require('./kp.cjs');

// Позже сюда можно отдать слайды нейросети. Сейчас черновик не генерируется.
function suggestDeck() {
  return {ready: false, message: 'Черновик презентации нейросетью пока не подключен'};
}

const DEFAULT_TEMPLATE = {
  title: 'Презентация',
  intro: 'АктивПрофи показывает, как автоматизация снимет ручную работу и уложится в срок.',
  footer: 'АктивПрофи · студия автоматизации',
};

function clip(value, max) {
  return String(value || '').replace(/\r/g, '').trim().slice(0, max);
}

function readSetting(db, key) {
  try {
    const raw = db.get('SELECT value FROM app_settings WHERE key = ?', key)?.value;
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeSetting(db, key, value) {
  db.run('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
}

function templateOf(db) {
  const stored = readSetting(db, 'deck_template');
  if (!stored || typeof stored !== 'object') return {...DEFAULT_TEMPLATE};
  return {
    title: clip(stored.title, 120) || DEFAULT_TEMPLATE.title,
    intro: clip(stored.intro, 500) || DEFAULT_TEMPLATE.intro,
    footer: clip(stored.footer, 200) || DEFAULT_TEMPLATE.footer,
  };
}

function assertAdmin(actor) {
  if (actor.role !== 'admin') throw new HttpError(403, 'Шаблон презентации меняет администратор');
}

function ownClient(state, actor, clientId) {
  const client = state.clients.find(item => item.id === clientId);
  if (!client || !M.canClient(state, actor, client)) throw new HttpError(403, 'Это не ваша сделка');
  return client;
}

function saveTemplate(db, user, body) {
  return command(db, user, (state, actor) => {
    assertAdmin(actor);
    const next = {
      title: clip(body.title, 120) || DEFAULT_TEMPLATE.title,
      intro: clip(body.intro, 500),
      footer: clip(body.footer, 200) || DEFAULT_TEMPLATE.footer,
    };
    if (!next.intro) throw new HttpError(400, 'Напишите короткое вступление');
    writeSetting(db, 'deck_template', JSON.stringify(next));
    return {template: next};
  });
}

function cleanDeck(input) {
  const slides = (Array.isArray(input?.slides) ? input.slides : []).slice(0, 8).map(slide => ({
    title: clip(slide?.title, 120),
    body: clip(slide?.body, 1200),
  })).filter(slide => slide.title && slide.body);
  if (!slides.length) throw new HttpError(400, 'Добавьте хотя бы один слайд с заголовком и текстом');
  return {title: clip(input?.title, 160) || 'Презентация', slides};
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
}

function renderHtml(template, client, deck) {
  const slides = deck.slides.map((slide, index) => `<section class="slide"><small>Слайд ${index + 1}</small><h2>${esc(slide.title)}</h2><p>${esc(slide.body)}</p></section>`).join('');
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${esc(deck.title)}</title><style>
body{font-family:Arial,sans-serif;background:#eef3f6;margin:0;color:#163244}
header{display:flex;gap:16px;align-items:center;background:#092a3c;color:#fff;padding:20px 28px}
img{width:56px;height:56px;border-radius:8px;object-fit:cover}
.slide{background:#fff;margin:16px;padding:28px;border-radius:12px;min-height:180px;box-shadow:0 1px 4px #12374c14}
h1,h2{margin:8px 0}
footer{padding:16px 28px;color:#5d7380}
</style></head><body><header><img src="/assets/studio-logo.png" alt="АктивПрофи"><div><strong>АктивПрофи</strong><h1>${esc(deck.title)}</h1><p>${esc(template.intro)}</p><p>${esc(client.name || '')}${client.company ? ' · ' + esc(client.company) : ''}</p></div></header>${slides}<footer>${esc(template.footer)}</footer></body></html>`;
}

function deckBlocks(template, client, deck) {
  const blocks = [
    {text: 'АктивПрофи', size: 18, gap: 4},
    {text: deck.title, size: 16, gap: 4},
    {text: template.intro, size: 11, gap: 4},
    {text: 'Клиент: ' + (client.name || '') + (client.company ? ' · ' + client.company : ''), size: 12, gap: 10},
  ];
  deck.slides.forEach((slide, index) => {
    blocks.push({text: 'Слайд ' + (index + 1) + '. ' + slide.title, size: 14, gap: 3});
    blocks.push({text: slide.body, size: 12, gap: 10});
  });
  blocks.push({text: template.footer, size: 10, gap: 4});
  return blocks;
}

function putFile(db, clientId, kind, name, bytes) {
  const id = 'ptf-' + crypto.randomBytes(6).toString('hex');
  db.run('INSERT INTO pitch_files (id, client_id, kind, name, mime, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, clientId, kind, name, 'application/pdf', bytes, new Date().toISOString());
  return {id, name};
}

function saveDeck(db, user, body) {
  const deck = cleanDeck(body.deck || body);
  const template = templateOf(db);
  let savedDeck = null;
  const saved = command(db, user, (state, actor) => {
    const client = ownClient(state, actor, body.clientId);
    client.decks = Array.isArray(client.decks) ? client.decks : [];
    const version = client.decks.reduce((max, item) => Math.max(max, Number(item.version) || 0), 0) + 1;
    const pdf = renderBlocksPdf(deckBlocks(template, client, deck));
    const file = putFile(db, client.id, 'deck', 'Deck-v' + version + '.pdf', pdf);
    savedDeck = {id: 'deck-' + crypto.randomBytes(3).toString('hex'), version, title: deck.title, slides: deck.slides, fileId: file.id, fileName: file.name, createdAt: new Date().toISOString()};
    client.decks.push(savedDeck);
    return {deckId: savedDeck.id};
  });
  const client = (saved.state.clients || []).find(item => item.id === body.clientId) || {};
  return {...saved, html: renderHtml(template, client, deck)};
}

function previewDeck(db, user, body) {
  const state = store.load(db);
  const actor = state.users.find(item => item.id === user.id);
  const client = ownClient(state, actor, body.clientId);
  return {html: renderHtml(templateOf(db), client, cleanDeck(body.deck || body))};
}

function fileFor(db, user, id) {
  const row = db.get('SELECT id, client_id, name, mime, bytes FROM pitch_files WHERE id = ?', id);
  if (!row) throw new HttpError(404, 'Файл не найден');
  const state = store.load(db);
  const actor = state.users.find(item => item.id === user.id);
  ownClient(state, actor, row.client_id);
  return row;
}

async function sendDeck(db, user, mailer, body) {
  const state = store.load(db);
  const actor = state.users.find(item => item.id === user.id);
  const client = ownClient(state, actor, body.clientId);
  const deck = (client.decks || []).find(item => item.id === body.deckId) || (client.decks || []).at(-1);
  if (!deck) throw new HttpError(400, 'Сначала сохраните презентацию');
  const file = db.get('SELECT name, bytes FROM pitch_files WHERE id = ? AND client_id = ?', deck.fileId, client.id);
  if (!file) throw new HttpError(404, 'Файл презентации не найден');
  const to = String(body.to || client.email || '').trim();
  if (!client.email || to.toLowerCase() !== String(client.email).trim().toLowerCase()) throw new HttpError(400, 'Можно отправить только на почту этого клиента');
  if (String(body.confirmTo || '').trim().toLowerCase() !== to.toLowerCase()) throw new HttpError(400, 'Подтвердите получателя');
  if (!mailer.settings.configured) throw new HttpError(400, MAIL_OFF);
  const text = clip(body.text, 4000) || ('Здравствуйте!\n\nНаправляем презентацию, версия v' + deck.version + '.');
  await mailer.send({to, subject: clip(body.subject, 180) || 'Презентация АктивПрофи', text, attachments: [{name: file.name, mime: 'application/pdf', bytes: Buffer.from(file.bytes)}]});
  return command(db, user, (next, person) => {
    const current = ownClient(next, person, client.id);
    current.notes = Array.isArray(current.notes) ? current.notes : [];
    current.notes.unshift(person.name + ' · ' + new Date().toISOString().slice(0, 10) + ': Отправлена презентация v' + deck.version + ' на ' + to);
    return {sent: true, version: deck.version};
  });
}

function moneyList(client) {
  const rows = Array.isArray(client.payments) ? client.payments : [];
  const invoiced = rows.filter(item => item.kind === 'invoice').reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  const paid = rows.filter(item => item.kind === 'payment').reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  return {invoiced, paid, left: Math.max(0, invoiced - paid)};
}

function addInvoice(db, user, body) {
  const amount = Math.round(Number(body.amount) || 0);
  if (amount <= 0) throw new HttpError(400, 'Укажите сумму счёта');
  const note = clip(body.note, 300) || 'Оплата по сделке';
  return command(db, user, (state, actor) => {
    const client = ownClient(state, actor, body.clientId);
    const deal = Math.round(Number(client.amount) || 0);
    if (deal > 0 && amount > deal && body.confirmOver !== true && body.confirmOver !== '1') {
      throw new HttpError(409, 'Счёт ' + amount + ' ₽ больше суммы сделки ' + deal + ' ₽. Подтвердите, если сумму всё равно нужно выставить.');
    }
    client.payments = Array.isArray(client.payments) ? client.payments : [];
    const number = client.payments.filter(item => item.kind === 'invoice').length + 1;
    const pdf = renderBlocksPdf([
      {text: 'АктивПрофи', size: 18, gap: 6},
      {text: 'Счёт ' + number, size: 16, gap: 8},
      {text: 'Клиент: ' + (client.name || '') + (client.company ? ' · ' + client.company : ''), size: 12, gap: 6},
      {text: 'Основание: ' + note, size: 12, gap: 6},
      {text: 'К оплате: ' + rub(amount), size: 16, gap: 8},
      {text: 'Это учёт в CRM. Деньги проходят через банк, не через эту кнопку.', size: 11, gap: 4},
      {text: 'АктивПрофи · студия автоматизации', size: 10, gap: 4},
    ]);
    const file = putFile(db, client.id, 'invoice', 'Invoice-' + number + '.pdf', pdf);
    client.payments.push({id: 'pay-' + crypto.randomBytes(3).toString('hex'), kind: 'invoice', amount, note, at: new Date().toISOString(), by: actor.id, fileId: file.id, fileName: file.name});
    client.notes = Array.isArray(client.notes) ? client.notes : [];
    client.notes.unshift(actor.name + ' · ' + new Date().toISOString().slice(0, 10) + ': Выставлен счёт на ' + rub(amount));
    return {totals: moneyList(client)};
  });
}

function addPayment(db, user, body) {
  const amount = Math.round(Number(body.amount) || 0);
  if (amount <= 0) throw new HttpError(400, 'Укажите сумму оплаты');
  const note = clip(body.note, 300) || 'Оплата получена';
  return command(db, user, (state, actor) => {
    const client = ownClient(state, actor, body.clientId);
    client.payments = Array.isArray(client.payments) ? client.payments : [];
    client.payments.push({id: 'pay-' + crypto.randomBytes(3).toString('hex'), kind: 'payment', amount, note, at: new Date().toISOString(), by: actor.id});
    client.notes = Array.isArray(client.notes) ? client.notes : [];
    client.notes.unshift(actor.name + ' · ' + new Date().toISOString().slice(0, 10) + ': Оплата ' + rub(amount) + '. ' + note);
    return {totals: moneyList(client)};
  });
}

module.exports = {
  suggestDeck, templateOf, saveTemplate, cleanDeck, saveDeck, previewDeck, fileFor, sendDeck,
  addInvoice, addPayment, moneyList, renderHtml,
};
