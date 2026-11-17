const {config} = require('./config.cjs');
const {openDatabase, migrate} = require('./db.cjs');
const {createAdmin} = require('./bootstrap.cjs');

const cfg = config();
if (!cfg.adminLogin || !cfg.adminPassword) {
  console.error('Задайте ADMIN_LOGIN и ADMIN_PASSWORD в файле .env или в окружении.');
  process.exit(1);
}
const db = openDatabase(cfg.databasePath);
try {
  migrate(db);
  createAdmin(db, cfg);
} catch (error) {
  console.error(error.message || error);
  process.exitCode = 1;
} finally {
  db.close();
}
