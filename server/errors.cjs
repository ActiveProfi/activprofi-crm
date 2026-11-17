class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function domainError(error) {
  if (error instanceof HttpError) return error;
  const message = error?.message || 'Ошибка запроса';
  const status = /нет доступа|недостаточно|только админ|недоступ|могут только|отключен|изменяет только|доступен админ|доступно админ|можно изменить только/i.test(message) ? 403 : 400;
  return new HttpError(status, message);
}

module.exports = {HttpError, domainError};
