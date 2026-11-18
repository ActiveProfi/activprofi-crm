const fs = require('node:fs');
const path = require('node:path');

// Подхватывает .env, но не затирает переменные, которые уже заданы в системе.
function loadEnv(file = path.resolve(process.cwd(), '.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index < 1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function config() {
  loadEnv();
  return {
    host: process.env.HOST || '127.0.0.1',
    port: Number(process.env.PORT || 3212),
    databasePath: process.env.DATABASE_PATH || path.resolve(process.cwd(), 'data', 'crm.sqlite'),
    sessionDays: Math.min(90, Math.max(1, Number(process.env.SESSION_DAYS || 14))),
    cookieSecure: process.env.COOKIE_SECURE === '1',
    adminLogin: process.env.ADMIN_LOGIN || '',
    adminPassword: process.env.ADMIN_PASSWORD || '',
    adminName: process.env.ADMIN_NAME || 'Администратор',
    seedDemo: process.env.SEED_DEMO === '1',
    seedPassword: process.env.SEED_PASSWORD || '',
    integrationPipelineId: process.env.INTEGRATION_PIPELINE_ID || '',
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramMock: process.env.TELEGRAM_MOCK === '1',
    telegramMockSeed: process.env.TELEGRAM_MOCK_SEED === '1',
  };
}

module.exports = {loadEnv, config};
