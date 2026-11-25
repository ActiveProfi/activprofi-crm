const {start} = require('./app.cjs');

start().then(({url, exposure}) => {
  console.log('АктивПрофи CRM: ' + url);
  if (exposure?.publicBind) console.log('CRM слушает не только этот компьютер. Открывайте её через HTTPS-прокси. Порт программы в интернет напрямую не открывайте.');
  else console.log('Сервер слушает только этот компьютер. Удалённому менеджеру нужен сервер с HTTPS.');
}).catch(error => {
  console.error(error.message || error);
  process.exit(1);
});
