const {Leads} = require('./models.cjs');
const {HttpError} = require('./errors.cjs');

// Ключи дедупликации: телефон, email и нормализованная ссылка на профиль.
function contactKeys(client) {
  const keys = [];
  const phones = [...new Set([client?.phone, ...(client?.phones || [])].map(value => Leads.phone(value)).filter(value => value && value.length >= 10 && value.length <= 15))];
  for (const value of phones) keys.push({kind: 'phone', value});
  const emails = [...new Set([client?.email, ...(client?.emails || [])].map(value => String(value || '').trim().toLowerCase()).filter(value => value.includes('@')))];
  for (const value of emails) keys.push({kind: 'email', value});
  try {
    for (const value of Leads.socialLinks(client || {})) keys.push({kind: 'social', value});
  } catch {
    // Некорректная ссылка не становится ключом. Проверка поля отдельно отклонит сохранение.
  }
  return keys;
}

function assertContactShape(client) {
  const phones = [client?.phone, ...(client?.phones || [])].map(value => String(value || '').trim()).filter(Boolean);
  for (const value of phones) {
    if (/[a-zа-яё]/i.test(value) || Leads.phone(value).length < 10 || Leads.phone(value).length > 15) throw new HttpError(400, 'Некорректный телефон');
  }
  const emails = [client?.email, ...(client?.emails || [])].map(value => String(value || '').trim()).filter(Boolean);
  for (const value of emails) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new HttpError(400, 'Некорректный email');
  }
  if (String(client?.socials || '').trim() || ['vk', 'telegram', 'instagram', 'whatsapp', 'ok'].some(key => String(client?.[key] || '').trim())) {
    Leads.socialLinks(client);
  }
  if (!contactKeys(client).length) throw new HttpError(400, 'Укажите телефон, email или профиль соцсети');
}

module.exports = {contactKeys, assertContactShape};
