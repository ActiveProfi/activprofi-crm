const {start} = require('./app.cjs');

start().then(({url}) => {
  console.log('АктивПрофи CRM: ' + url);
  console.log('Сервер слушает только указанный адрес (по умолчанию 127.0.0.1).');
}).catch(error => {
  console.error(error.message || error);
  process.exit(1);
});
