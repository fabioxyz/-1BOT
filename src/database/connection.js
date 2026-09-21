const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { runMigrations } = require('./migrations');

let instance = null;

/**
 * Obtém ou cria a instância de conexão com a base de dados SQLite.
 * @param {string} [customPath] - Caminho opcional (ex.: ':memory:' ou ficheiro de teste).
 * @returns {import('better-sqlite3').Database}
 */
function getDatabase(customPath) {
  if (customPath) {
    return createConnection(customPath);
  }

  if (!instance) {
    const dbPath = process.env.DATABASE_PATH || './data/plus1bot.sqlite';
    instance = createConnection(dbPath);
  }

  return instance;
}

/**
 * Cria uma nova conexão SQLite configurada com pragmas essenciais e executa migrações.
 * @param {string} dbPath
 * @returns {import('better-sqlite3').Database}
 */
function createConnection(dbPath) {
  const isMemory = dbPath === ':memory:';

  if (!isMemory) {
    const resolvedPath = path.isAbsolute(dbPath) ? dbPath : path.resolve(process.cwd(), dbPath);
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    dbPath = resolvedPath;
  }

  const db = new Database(dbPath);

  // Ativar verificação de chaves estrangeiras
  db.pragma('foreign_keys = ON');

  // Ativar WAL apenas para ficheiros em disco
  if (!isMemory) {
    db.pragma('journal_mode = WAL');
  }

  // Executar migrações idempotentes
  runMigrations(db);

  return db;
}

/**
 * Fecha a instância padrão da base de dados se estiver aberta.
 */
function closeDatabase() {
  if (instance) {
    try {
      instance.close();
    } finally {
      instance = null;
    }
  }
}

module.exports = {
  getDatabase,
  createConnection,
  closeDatabase,
};
