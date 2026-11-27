const crypto = require('node:crypto');
const fs = require('node:fs');
const {M, Leads} = require('./models.cjs');
const store = require('./store.cjs');
const {command} = require('./service.cjs');
const {HttpError} = require('./errors.cjs');
const {MAIL_OFF} = require('./outbound.cjs');

// Сюда позже можно подключить нейросеть: функция получает клиента и прайс и возвращает черновик КП.
function suggestProposal() {
  return {ready: false, message: 'Автозаполнение нейросетью пока не подключено'};
}

const DEFAULT_TEMPLATE = {
  title: 'Коммерческое предложение',
  intro: 'Студия АктивПрофи автоматизирует процессы: от заявки и обучения до отчётов. Ниже — задача, решение и варианты по сроку и бюджету.',
  terms: 'Срок и стоимость указаны для выбранного варианта. Старт после предоплаты 50%. Состав работ можно уточнить до договора.',
  footer: 'АктивПрофи · студия автоматизации',
};

const DEFAULT_CATALOGUE = [
  {id: 'survey', name: 'Обследование и программа запуска', description: 'Интервью, карта процесса и план на две недели', unit: 'проект', price: 126000, days: 14},
  {id: 'portal', name: 'Учебный портал', description: 'Курсы, группы и базовая отчётность', unit: 'проект', price: 99000, days: 14},
  {id: 'launch', name: 'Запуск и сопровождение', description: 'Настройка, обучение администраторов и первый поток', unit: 'проект', price: 214000, days: 45},
  {id: 'cabinets', name: 'Кабинеты, отчёты и интеграции', description: 'Личные кабинеты, расширенные отчёты и обмен данными', unit: 'проект', price: 625000, days: 90},
];

const FONT_CANDIDATES = [
  process.env.KP_FONT,
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
  '/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf',
].filter(Boolean);

function clip(value, max) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function rub(value) {
  return new Intl.NumberFormat('ru-RU').format(Math.round(Number(value) || 0)) + ' ₽';
}

function variantMath(variant) {
  const subtotal = (variant.lines || []).reduce((sum, line) => sum + (Number(line.qty) || 0) * (Number(line.price) || 0), 0);
  const discount = Math.min(100, Math.max(0, Number(variant.discount) || 0));
  const total = Math.round(subtotal * (1 - discount / 100));
  return {subtotal, discount, total};
}

function readJsonSetting(db, key, fallback) {
  try {
    const raw = db.get('SELECT value FROM app_settings WHERE key = ?', key)?.value;
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function writeSetting(db, key, value) {
  db.run('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
}

function templateOf(db) {
  const stored = readJsonSetting(db, 'kp_template', null);
  if (!stored || typeof stored !== 'object') return {...DEFAULT_TEMPLATE};
  return {
    title: clip(stored.title, 120) || DEFAULT_TEMPLATE.title,
    intro: clip(stored.intro, 2000) || DEFAULT_TEMPLATE.intro,
    terms: clip(stored.terms, 2000) || DEFAULT_TEMPLATE.terms,
    footer: clip(stored.footer, 300) || DEFAULT_TEMPLATE.footer,
  };
}

function catalogueOf(db) {
  const stored = readJsonSetting(db, 'kp_catalogue', null);
  if (!Array.isArray(stored) || !stored.length) return DEFAULT_CATALOGUE.map(item => ({...item}));
  return stored.map(cleanService).filter(item => item.name);
}

function cleanService(item, index = 0) {
  const price = Math.max(0, Number(item?.price) || 0);
  const days = Math.max(0, Math.round(Number(item?.days) || 0));
  return {
    id: clip(item?.id, 40) || 'svc-' + (index + 1),
    name: clip(item?.name, 160),
    description: clip(item?.description, 400),
    unit: clip(item?.unit, 40) || 'шт.',
    price,
    days,
  };
}

function assertAdmin(actor) {
  if (actor.role !== 'admin') throw new HttpError(403, 'Шаблон и прайс меняет администратор');
}

function saveTemplate(db, user, body) {
  return command(db, user, (state, actor) => {
    assertAdmin(actor);
    const next = {
      title: clip(body.title, 120) || DEFAULT_TEMPLATE.title,
      intro: clip(body.intro, 2000),
      terms: clip(body.terms, 2000),
      footer: clip(body.footer, 300) || DEFAULT_TEMPLATE.footer,
    };
    if (!next.intro || !next.terms) throw new HttpError(400, 'Заполните вступление и условия');
    writeSetting(db, 'kp_template', JSON.stringify(next));
    return {template: next};
  });
}

function saveCatalogue(db, user, body) {
  return command(db, user, (state, actor) => {
    assertAdmin(actor);
    const rows = Array.isArray(body.services) ? body.services.map(cleanService).filter(item => item.name).slice(0, 80) : [];
    if (!rows.length) throw new HttpError(400, 'В прайсе нужна хотя бы одна услуга');
    const ids = new Set();
    for (const row of rows) {
      if (ids.has(row.id)) row.id = row.id + '-' + ids.size;
      ids.add(row.id);
    }
    writeSetting(db, 'kp_catalogue', JSON.stringify(rows));
    return {catalogue: rows};
  });
}

function cleanDocument(input) {
  const variants = (Array.isArray(input?.variants) ? input.variants : []).slice(0, 3).map(variant => {
    const lines = (Array.isArray(variant?.lines) ? variant.lines : []).slice(0, 30).map(line => ({
      name: clip(line?.name, 160),
      description: clip(line?.description, 400),
      unit: clip(line?.unit, 40) || 'шт.',
      qty: Math.max(0, Number(line?.qty) || 0),
      price: Math.max(0, Number(line?.price) || 0),
    })).filter(line => line.name && line.qty > 0);
    return {
      name: clip(variant?.name, 80),
      duration: clip(variant?.duration, 80),
      discount: Math.min(100, Math.max(0, Number(variant?.discount) || 0)),
      fromPrice: variant?.fromPrice === true,
      lines,
    };
  }).filter(variant => variant.name && variant.lines.length);
  if (!variants.length) throw new HttpError(400, 'Добавьте хотя бы один вариант с услугой');
  const choice = clip(input?.choice, 80);
  return {
    task: clip(input?.task, 2000),
    solution: clip(input?.solution, 2000),
    stages: clip(input?.stages, 2000),
    timeline: clip(input?.timeline, 500),
    kpLink: /^https?:\/\//i.test(String(input?.kpLink || '')) ? clip(input.kpLink, 500) : '',
    choice: variants.some(variant => variant.name === choice) ? choice : variants[0].name,
    variants,
  };
}

function variantSummary(document) {
  return document.variants.map(variant => {
    const math = variantMath(variant);
    const prefix = variant.fromPrice ? 'от ' : '';
    return variant.name + ': ' + prefix + rub(math.total) + (variant.duration ? ' / ' + variant.duration : '');
  }).join('; ');
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
}

function renderHtml(template, client, document) {
  const variants = document.variants.map(variant => {
    const math = variantMath(variant);
    const rows = variant.lines.map(line => `<tr><td>${esc(line.name)}${line.description ? `<small>${esc(line.description)}</small>` : ''}</td><td>${esc(line.qty)} ${esc(line.unit)}</td><td>${esc(rub(line.price))}</td><td>${esc(rub(line.qty * line.price))}</td></tr>`).join('');
    const prefix = variant.fromPrice ? 'от ' : '';
    return `<section class="variant"><h2>${esc(variant.name)}</h2><p>${esc(variant.duration || '')}</p><table><thead><tr><th>Услуга</th><th>Количество</th><th>Цена</th><th>Сумма</th></tr></thead><tbody>${rows}</tbody></table><p>Скидка: ${esc(String(math.discount))}%</p><p class="total">${prefix}${esc(rub(math.total))}</p></section>`;
  }).join('');
  const link = document.kpLink ? `<p>Интерактивное КП: <a href="${esc(document.kpLink)}">${esc(document.kpLink)}</a></p>` : '';
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${esc(template.title)}</title><style>
body{font-family:Arial,sans-serif;color:#163244;margin:32px;background:#fff}
header{display:flex;gap:16px;align-items:center;border-bottom:3px solid #00858e;padding-bottom:12px}
img{width:64px;height:64px;object-fit:cover;border-radius:8px}
h1{margin:8px 0 0;font-size:28px}
.muted{color:#5d7380}
.variants{display:flex;gap:12px;align-items:stretch}
.variant{flex:1;border:1px solid #d5e3ea;border-radius:10px;padding:12px}
table{width:100%;border-collapse:collapse;font-size:13px}
td,th{border-bottom:1px solid #e5eef2;text-align:left;padding:6px 4px;vertical-align:top}
.total{font-size:20px;font-weight:700;color:#085e66}
small{display:block;color:#5d7380}
footer{margin-top:24px;border-top:1px solid #d5e3ea;padding-top:12px;color:#5d7380}
@media print {.variants{display:block}.variant{margin-bottom:12px}}
</style></head><body><header><img src="/assets/studio-logo.png" alt="АктивПрофи"><div><strong>АктивПрофи</strong><h1>${esc(template.title)}</h1></div></header>
<p>${esc(template.intro)}</p>
<p><b>Клиент.</b> ${esc(client.name || '')}${client.company ? ' · ' + esc(client.company) : ''}</p>
${document.task ? `<h2>Задача</h2><p>${esc(document.task)}</p>` : ''}
${document.solution ? `<h2>Решение</h2><p>${esc(document.solution)}</p>` : ''}
${document.stages ? `<h2>Этапы</h2><p>${esc(document.stages)}</p>` : ''}
${document.timeline ? `<p><b>Срок.</b> ${esc(document.timeline)}</p>` : ''}
<div class="variants">${variants}</div>
<h2>Условия</h2><p>${esc(template.terms)}</p>${link}
<footer>${esc(template.footer)}</footer></body></html>`;
}

let fontCache = null;
function loadFont() {
  if (fontCache) return fontCache;
  const path = FONT_CANDIDATES.find(item => fs.existsSync(item));
  if (!path) throw new HttpError(500, 'Не найден шрифт для PDF. Установите DejaVu Sans или укажите KP_FONT.');
  const buf = fs.readFileSync(path);
  const tables = {};
  const numTables = buf.readUInt16BE(4);
  for (let index = 0; index < numTables; index++) {
    const offset = 12 + index * 16;
    tables[buf.toString('latin1', offset, offset + 4)] = {offset: buf.readUInt32BE(offset + 8), length: buf.readUInt32BE(offset + 12)};
  }
  const unicodeToGlyph = new Map();
  const cmapOff = tables.cmap.offset;
  const records = buf.readUInt16BE(cmapOff + 2);
  let chosen = null;
  for (let index = 0; index < records; index++) {
    const rec = cmapOff + 4 + index * 8;
    const platform = buf.readUInt16BE(rec);
    const offset = cmapOff + buf.readUInt32BE(rec + 4);
    const format = buf.readUInt16BE(offset);
    if (format === 4 && (platform === 3 || platform === 0)) chosen = {offset, format};
  }
  if (!chosen) throw new HttpError(500, 'В шрифте нет таблицы символов');
  if (chosen.format === 4) {
    const offset = chosen.offset;
    const segCount = buf.readUInt16BE(offset + 6) / 2;
    const endOff = offset + 14;
    const startOff = endOff + segCount * 2 + 2;
    const deltaOff = startOff + segCount * 2;
    const rangeOff = deltaOff + segCount * 2;
    for (let index = 0; index < segCount; index++) {
      const end = buf.readUInt16BE(endOff + index * 2);
      const start = buf.readUInt16BE(startOff + index * 2);
      const delta = buf.readInt16BE(deltaOff + index * 2);
      const range = buf.readUInt16BE(rangeOff + index * 2);
      if (start === 0xFFFF) continue;
      for (let code = start; code <= end; code++) {
        let glyph = 0;
        if (range === 0) glyph = (code + delta) & 0xFFFF;
        else {
          const glyphOff = rangeOff + index * 2 + range + (code - start) * 2;
          glyph = buf.readUInt16BE(glyphOff);
          if (glyph) glyph = (glyph + delta) & 0xFFFF;
        }
        if (glyph) unicodeToGlyph.set(code, glyph);
      }
    }
  }
  const units = buf.readUInt16BE(tables.head.offset + 18) || 1000;
  const numHMetrics = buf.readUInt16BE(tables.hhea.offset + 34);
  const hmtx = tables.hmtx.offset;
  function width(gid) {
    const index = Math.min(gid, Math.max(0, numHMetrics - 1));
    return Math.round(buf.readUInt16BE(hmtx + index * 4) * 1000 / units);
  }
  if (unicodeToGlyph.size < 50) throw new HttpError(500, 'Шрифт прочитан не полностью');
  fontCache = {buf, unicodeToGlyph, width};
  return fontCache;
}

function glyphsOf(font, text) {
  const glyphs = [];
  for (const char of String(text || '')) {
    const code = char.codePointAt(0);
    const gid = font.unicodeToGlyph.get(code) || 0;
    if (gid) glyphs.push({gid, code, width: font.width(gid)});
  }
  return glyphs;
}

function wrapGlyphs(font, text, size, maxWidth) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let current = [];
  let width = 0;
  const space = glyphsOf(font, ' ');
  const spaceWidth = space.reduce((sum, item) => sum + item.width, 0) * size / 1000;
  for (const word of words) {
    const glyphs = glyphsOf(font, word);
    const wordWidth = glyphs.reduce((sum, item) => sum + item.width, 0) * size / 1000;
    if (current.length && width + spaceWidth + wordWidth > maxWidth) {
      lines.push(current);
      current = glyphs;
      width = wordWidth;
    } else {
      if (current.length) {
        current = current.concat(space, glyphs);
        width += spaceWidth + wordWidth;
      } else {
        current = glyphs;
        width = wordWidth;
      }
    }
  }
  if (current.length) lines.push(current);
  return lines.length ? lines : [[]];
}

function hexGlyphs(glyphs) {
  return glyphs.map(item => item.gid.toString(16).padStart(4, '0')).join('');
}

function renderPdf(template, client, document) {
  const font = loadFont();
  const pages = [];
  let commands = [];
  let y = 800;
  const used = new Map();
  function remember(glyphs) {
    for (const item of glyphs) used.set(item.gid, item.code);
  }
  function ensure(need) {
    if (y < need) {
      pages.push(commands.join('\n'));
      commands = [];
      y = 800;
    }
  }
  function write(text, size, boldGap) {
    const lines = wrapGlyphs(font, text, size, 515);
    for (const glyphs of lines) {
      ensure(size + 8);
      remember(glyphs);
      if (glyphs.length) commands.push(`BT /F1 ${size} Tf 1 0 0 1 40 ${y.toFixed(1)} Tm <${hexGlyphs(glyphs)}> Tj ET`);
      y -= size + (boldGap || 4);
    }
  }
  write('АктивПрофи', 18, 6);
  write(template.title, 16, 8);
  write(template.intro, 11, 4);
  write('Клиент: ' + (client.name || '') + (client.company ? ' · ' + client.company : ''), 12, 8);
  if (document.task) { write('Задача', 13, 3); write(document.task, 11, 6); }
  if (document.solution) { write('Решение', 13, 3); write(document.solution, 11, 6); }
  if (document.stages) { write('Этапы', 13, 3); write(document.stages, 11, 6); }
  if (document.timeline) write('Срок: ' + document.timeline, 11, 8);
  for (const variant of document.variants) {
    const math = variantMath(variant);
    write(variant.name + (variant.duration ? ' · ' + variant.duration : ''), 14, 4);
    for (const line of variant.lines) {
      write(line.name + ' — ' + line.qty + ' ' + line.unit + ' × ' + rub(line.price) + ' = ' + rub(line.qty * line.price), 11, 2);
      if (line.description) write(line.description, 9, 2);
    }
    if (math.discount) write('Скидка ' + math.discount + '%', 11, 2);
    write((variant.fromPrice ? 'от ' : 'Итого ') + rub(math.total), 13, 8);
  }
  write('Условия', 13, 3);
  write(template.terms, 11, 6);
  if (document.kpLink) write('Интерактивное КП: ' + document.kpLink, 10, 6);
  write(template.footer, 10, 4);
  pages.push(commands.join('\n'));
  return packPdf(font, pages, used);
}

function renderBlocksPdf(blocks) {
  const font = loadFont();
  const pages = [];
  let commands = [];
  let y = 800;
  const used = new Map();
  function remember(glyphs) {
    for (const item of glyphs) used.set(item.gid, item.code);
  }
  function ensure(need) {
    if (y < need) {
      pages.push(commands.join('\n'));
      commands = [];
      y = 800;
    }
  }
  function write(text, size, boldGap) {
    const lines = wrapGlyphs(font, text, size, 515);
    for (const glyphs of lines) {
      ensure(size + 8);
      remember(glyphs);
      if (glyphs.length) commands.push(`BT /F1 ${size} Tf 1 0 0 1 40 ${y.toFixed(1)} Tm <${hexGlyphs(glyphs)}> Tj ET`);
      y -= size + (boldGap || 4);
    }
  }
  for (const block of blocks || []) {
    if (!String(block.text || '').trim()) continue;
    write(block.text, block.size || 12, block.gap || 4);
  }
  pages.push(commands.join('\n'));
  return packPdf(font, pages, used);
}

function packPdf(font, pages, used) {
  const widths = [];
  const bfchar = [];
  for (const [gid, code] of used) {
    widths.push(`${gid} [${font.width(gid)}]`);
    bfchar.push(`<${gid.toString(16).padStart(4, '0')}> <${code.toString(16).padStart(4, '0')}>`);
  }
  const toUnicode = `<< /Length ${0} >>`;
  const cmap = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
    bfchar.length + ' beginbfchar',
    ...bfchar,
    'endbfchar',
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
  ].join('\n');
  const objects = [null];
  const pageIds = [];
  const contentIds = [];
  objects.push(Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'));
  objects.push(null);
  for (const content of pages) {
    const stream = Buffer.from(content);
    contentIds.push(objects.length);
    objects.push(Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`), stream, Buffer.from('\nendstream')]));
    pageIds.push(objects.length);
    objects.push(null);
  }
  const fontId = objects.length;
  objects.push(Buffer.from(`<< /Type /Font /Subtype /Type0 /BaseFont /DejaVuSans /Encoding /Identity-H /DescendantFonts [${fontId + 1} 0 R] /ToUnicode ${fontId + 2} 0 R >>`));
  objects.push(Buffer.from(`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /DejaVuSans /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${fontId + 3} 0 R /DW 500 /W [${widths.join(' ')}] /CIDToGIDMap /Identity >>`));
  const cmapBuf = Buffer.from(cmap);
  objects.push(Buffer.concat([Buffer.from(`<< /Length ${cmapBuf.length} >>\nstream\n`), cmapBuf, Buffer.from('\nendstream')]));
  const fileId = fontId + 4;
  objects.push(Buffer.from(`<< /Type /FontDescriptor /FontName /DejaVuSans /Flags 32 /FontBBox [-1000 -400 2000 1100] /ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 700 /StemV 80 /FontFile2 ${fileId} 0 R >>`));
  objects.push(Buffer.concat([Buffer.from(`<< /Length ${font.buf.length} /Length1 ${font.buf.length} >>\nstream\n`), font.buf, Buffer.from('\nendstream')]));
  objects[2] = Buffer.from(`<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map(id => id + ' 0 R').join(' ')}] >>`);
  pageIds.forEach((id, index) => {
    objects[id] = Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${contentIds[index]} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`);
  });
  void toUnicode;
  let body = Buffer.from('%PDF-1.4\n');
  const offsets = [0];
  for (let index = 1; index < objects.length; index++) {
    offsets.push(body.length);
    body = Buffer.concat([body, Buffer.from(`${index} 0 obj\n`), objects[index], Buffer.from('\nendobj\n')]);
  }
  const xref = body.length;
  let table = `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let index = 1; index < objects.length; index++) table += String(offsets[index]).padStart(10, '0') + ' 00000 n \n';
  return Buffer.concat([body, Buffer.from(table + `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`)]);
}

function ownClient(state, actor, clientId) {
  const client = state.clients.find(item => item.id === clientId);
  if (!client || !M.canClient(state, actor, client)) throw new HttpError(403, 'Это не ваша сделка');
  return client;
}

function rememberProposal(client, document, file) {
  client.proposals = Array.isArray(client.proposals) ? client.proposals : [];
  const version = client.proposals.reduce((max, item) => Math.max(max, Number(item.version) || 0), 0) + 1;
  const proposal = {
    id: 'kp-' + crypto.randomBytes(4).toString('hex'),
    version,
    createdAt: new Date().toISOString(),
    task: document.task,
    solution: document.solution,
    stages: document.stages,
    timeline: document.timeline,
    kpLink: document.kpLink,
    choice: document.choice,
    variants: document.variants,
    fileId: file.id,
    fileName: file.name,
  };
  client.proposals.push(proposal);
  client.kpVariants = 'Варианты: ' + variantSummary(document);
  client.kpLink = document.kpLink || client.kpLink || '';
  return proposal;
}

function saveDocument(db, user, body) {
  const document = cleanDocument(body.document || body);
  const template = templateOf(db);
  let proposal = null;
  const saved = command(db, user, (state, actor) => {
    const client = ownClient(state, actor, body.clientId);
    const pdf = renderPdf(template, client, document);
    const id = 'kpf-' + crypto.randomBytes(6).toString('hex');
    const name = 'KP-v' + ((client.proposals || []).reduce((max, item) => Math.max(max, Number(item.version) || 0), 0) + 1) + '.pdf';
    db.run('INSERT INTO kp_files (id, client_id, name, mime, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, client.id, name, 'application/pdf', pdf, new Date().toISOString());
    proposal = rememberProposal(client, document, {id, name});
    return {proposalId: proposal.id};
  });
  return {...saved, proposalId: proposal.id, html: renderHtml(template, saved.state.clients.find(item => item.id === body.clientId) || {}, document)};
}

function preview(db, user, body) {
  const state = store.load(db);
  const actor = state.users.find(item => item.id === user.id);
  const client = ownClient(state, actor, body.clientId);
  const document = cleanDocument(body.document || body);
  return {html: renderHtml(templateOf(db), client, document)};
}

function fileFor(db, user, id) {
  const row = db.get('SELECT id, client_id, name, mime, bytes FROM kp_files WHERE id = ?', id);
  if (!row) throw new HttpError(404, 'Файл КП не найден');
  const state = store.load(db);
  const actor = state.users.find(item => item.id === user.id);
  ownClient(state, actor, row.client_id);
  return row;
}

function proposalStage(state, client) {
  const pipeline = state.pipelines.find(item => item.id === client.pipelineId) || state.pipelines[0];
  if (!pipeline) throw new HttpError(400, 'У сделки нет воронки');
  Leads.ensureProposalStage(pipeline);
  return pipeline.stages.find(stage => stage.systemKey === 'proposal_sent' || String(stage.name || '').trim().toLowerCase() === 'отправлено кп');
}

async function sendProposal(db, user, mailer, body) {
  const state = store.load(db);
  const actor = state.users.find(item => item.id === user.id);
  const client = ownClient(state, actor, body.clientId);
  const proposal = (client.proposals || []).find(item => item.id === body.proposalId) || (client.proposals || []).at(-1);
  if (!proposal) throw new HttpError(400, 'Сначала сохраните версию КП');
  const file = db.get('SELECT name, mime, bytes FROM kp_files WHERE id = ? AND client_id = ?', proposal.fileId, client.id);
  if (!file) throw new HttpError(404, 'Файл КП не найден');
  const to = String(body.to || client.email || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to) || to.toLowerCase() !== String(client.email || '').trim().toLowerCase()) throw new HttpError(400, 'Можно отправить только на почту этого клиента');
  if (String(body.confirmTo || '').trim().toLowerCase() !== to.toLowerCase()) throw new HttpError(400, 'Подтвердите получателя');
  const subject = clip(body.subject, 180) || 'Коммерческое предложение АктивПрофи';
  const text = clip(body.text, 4000) || ('Здравствуйте!\n\nНаправляем коммерческое предложение, версия v' + proposal.version + '.');
  if (!mailer.settings.configured) throw new HttpError(400, MAIL_OFF);
  await mailer.send({to, subject, text, attachments: [{name: file.name, mime: 'application/pdf', bytes: Buffer.from(file.bytes)}]});
  return command(db, user, (next, person) => {
    const current = ownClient(next, person, client.id);
    const stage = proposalStage(next, current);
    current.inLeadBase = false;
    current.pipelineId = (next.pipelines.find(item => item.stages.some(row => row.id === stage.id)) || next.pipelines[0]).id;
    current.stageId = stage.id;
    current.stage = stage.name;
    current.stageHistory = Array.isArray(current.stageHistory) ? current.stageHistory : [];
    current.stageHistory.push({at: new Date().toISOString().slice(0, 10), stageId: stage.id, reason: 'Отправлено КП v' + proposal.version});
    current.notes = Array.isArray(current.notes) ? current.notes : [];
    current.notes.unshift(person.name + ' · ' + new Date().toISOString().slice(0, 10) + ': Отправлено КП v' + proposal.version + ' на ' + to);
    return {sent: true, version: proposal.version, stage: stage.name};
  });
}

module.exports = {
  suggestProposal, templateOf, catalogueOf, saveTemplate, saveCatalogue, cleanDocument, variantMath, variantSummary,
  renderHtml, renderPdf, renderBlocksPdf, saveDocument, preview, fileFor, sendProposal, rub, DEFAULT_CATALOGUE,
};
