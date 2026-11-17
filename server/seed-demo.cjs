const {config} = require('./config.cjs');
const {openDatabase, migrate} = require('./db.cjs');
const {seedDemo} = require('./bootstrap.cjs');

const cfg = {...config(), seedDemo: true};
if (!cfg.seedPassword) {
  console.error('Задайте SEED_PASSWORD — пароль синтетических сотрудников, не короче 8 символов.');
  process.exit(1);
}
const db = openDatabase(cfg.databasePath);
try {
  migrate(db);
  seedDemo(db, cfg);
} catch (error) {
  console.error(error.message || error);
  process.exitCode = 1;
} finally {
  db.close();
}
