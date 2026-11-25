function createLoginGuard(options = {}) {
  const windowMs = options.windowMs ?? 15 * 60 * 1000;
  const accountLimit = options.accountLimit ?? 8;
  const ipLimit = options.ipLimit ?? 40;
  const now = options.now || (() => Date.now());
  const accounts = new Map();
  const ips = new Map();

  function keyOf(login) {
    return String(login || '').trim().toLowerCase();
  }

  function fresh(row, time) {
    return row && time - row.start < windowMs ? row : null;
  }

  function status(ip, login) {
    const time = now();
    const account = fresh(accounts.get(keyOf(login)), time);
    const place = fresh(ips.get(ip || 'unknown'), time);
    const accountLocked = !!account && account.n >= accountLimit;
    const ipLocked = !!place && place.n >= ipLimit;
    if (!accountLocked && !ipLocked) return {locked: false};
    const until = Math.max(accountLocked ? account.start + windowMs : 0, ipLocked ? place.start + windowMs : 0);
    return {locked: true, retryMs: Math.max(0, until - time)};
  }

  function bump(map, key) {
    const time = now();
    const current = fresh(map.get(key), time) || {start: time, n: 0};
    current.n += 1;
    map.set(key, current);
  }

  function fail(ip, login) {
    bump(accounts, keyOf(login));
    bump(ips, ip || 'unknown');
    return status(ip, login);
  }

  function success(login) {
    accounts.delete(keyOf(login));
  }

  return {status, fail, success};
}

const LOCK_MESSAGE = 'Слишком много неверных попыток. Подождите 15 минут и попробуйте снова.';

module.exports = {createLoginGuard, LOCK_MESSAGE};
