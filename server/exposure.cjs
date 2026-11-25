const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1']);
const WEAK_PASSWORDS = new Set([
  'change-me-now', 'demo-change-me', 'password', 'password1', 'admin123', '12345678', 'qwertyui', 'qwerty123',
]);

function isLoopback(host) {
  const value = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return LOOPBACK.has(value) || value.endsWith('127.0.0.1');
}

function normalizePort(value) {
  const port = Number(value);
  if (port === 0) return 0;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT: укажите порт от 1 до 65535');
  return port;
}

function assertExposure(cfg) {
  const host = String(cfg.host || '127.0.0.1').trim();
  if (!host) throw new Error('HOST: укажите адрес. Для одного компьютера оставьте 127.0.0.1');
  const port = normalizePort(cfg.port);
  const publicBind = !isLoopback(host);
  if (publicBind && cfg.seedDemo) {
    throw new Error('SEED_DEMO нельзя включать, если CRM доступна не только с этого компьютера. Оставьте SEED_DEMO=0: тестовые сотрудники в интернет не попадают.');
  }
  if (publicBind && !cfg.cookieSecure) {
    throw new Error('CRM слушает не только этот компьютер. Поставьте COOKIE_SECURE=1 и открывайте её через HTTPS.');
  }
  if (publicBind && !cfg.trustProxy) {
    throw new Error('Перед CRM должен стоять прокси с HTTPS. Поставьте TRUST_PROXY=1 и не открывайте порт программы напрямую в интернет.');
  }
  if (publicBind && WEAK_PASSWORDS.has(String(cfg.adminPassword || ''))) {
    throw new Error('ADMIN_PASSWORD слишком простой или взят из примера. Придумайте свой пароль не короче 8 символов.');
  }
  return {host, port, publicBind};
}

function clientAddress(req) {
  return String(req?.socket?.remoteAddress || '').replace(/^::ffff:/, '');
}

function clientIp(req, cfg) {
  const direct = clientAddress(req);
  if (!cfg?.trustProxy) return direct || 'unknown';
  const forwarded = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim().replace(/^::ffff:/, '');
  return forwarded || direct || 'unknown';
}

function cookieIsSecure(req, cfg) {
  if (cfg?.cookieSecure) return true;
  if (!cfg?.trustProxy) return false;
  const proto = String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return proto === 'https';
}

module.exports = {assertExposure, clientIp, cookieIsSecure, isLoopback, WEAK_PASSWORDS};
