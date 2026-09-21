/**
 * Migrações idempotentes para a base de dados do sistema de tickets.
 */

function runMigrations(db) {
  // Executar num bloco de transação para garantir atomicidade das migrações
  db.exec(`
    CREATE TABLE IF NOT EXISTS guild_settings (
      guild_id TEXT PRIMARY KEY,
      ticket_category_id TEXT,
      archive_category_id TEXT,
      log_channel_id TEXT,
      default_staff_role_id TEXT,
      panel_title TEXT,
      panel_description TEXT,
      panel_color TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ticket_departments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      emoji TEXT,
      staff_role_id TEXT,
      category_id TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      ticket_number INTEGER NOT NULL,
      creator_id TEXT NOT NULL,
      department_id INTEGER NOT NULL REFERENCES ticket_departments(id),
      channel_id TEXT,
      subject TEXT NOT NULL,
      description TEXT NOT NULL,
      reference TEXT,
      priority TEXT NOT NULL DEFAULT 'normal',
      status TEXT NOT NULL DEFAULT 'new',
      claimed_by TEXT,
      control_message_id TEXT,
      closed_by TEXT,
      close_reason TEXT,
      transcript_path TEXT,
      transcript_sha256 TEXT,
      transcript_message_count INTEGER,
      closing_started_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      closed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS ticket_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
      guild_id TEXT,
      event_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      metadata_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Índice único parcial para impedir que um utilizador tenha mais de um ticket ativo no mesmo servidor
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_active_user
      ON tickets(guild_id, creator_id)
      WHERE status != 'closed';

    -- Índice único para garantir unicidade sequencial do número de ticket por servidor
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_guild_number
      ON tickets(guild_id, ticket_number);

    -- Índices para consultas frequentes e isolamento por servidor
    CREATE INDEX IF NOT EXISTS idx_departments_guild_active
      ON ticket_departments(guild_id, active);

    CREATE INDEX IF NOT EXISTS idx_tickets_guild_status
      ON tickets(guild_id, status);

    CREATE INDEX IF NOT EXISTS idx_tickets_channel
      ON tickets(channel_id);

    CREATE INDEX IF NOT EXISTS idx_events_ticket
      ON ticket_events(ticket_id);

    CREATE INDEX IF NOT EXISTS idx_events_guild
      ON ticket_events(guild_id);

    CREATE TABLE IF NOT EXISTS ticket_members (
      ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      added_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (ticket_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_ticket_members_ticket
      ON ticket_members(ticket_id);

    CREATE INDEX IF NOT EXISTS idx_ticket_members_user
      ON ticket_members(user_id);
  `);

  // Migrações incrementais idempotentes para bases de dados legadas:
  // 1. guild_settings.archive_category_id
  const settingsColumns = db.prepare('PRAGMA table_info(guild_settings)').all();
  const hasArchiveCategoryId = settingsColumns.some((col) => col.name === 'archive_category_id');
  if (!hasArchiveCategoryId) {
    db.exec('ALTER TABLE guild_settings ADD COLUMN archive_category_id TEXT;');
  }

  // 2. tickets (control_message_id, closed_by, close_reason, transcript_path, transcript_sha256, transcript_message_count, closing_started_at)
  const ticketColumns = db.prepare('PRAGMA table_info(tickets)').all();
  const existingTicketColNames = new Set(ticketColumns.map((col) => col.name));

  const ticketColsToAdd = [
    { name: 'control_message_id', type: 'TEXT' },
    { name: 'closed_by', type: 'TEXT' },
    { name: 'close_reason', type: 'TEXT' },
    { name: 'transcript_path', type: 'TEXT' },
    { name: 'transcript_sha256', type: 'TEXT' },
    { name: 'transcript_message_count', type: 'INTEGER' },
    { name: 'closing_started_at', type: 'TEXT' },
  ];

  for (const col of ticketColsToAdd) {
    if (!existingTicketColNames.has(col.name)) {
      db.exec(`ALTER TABLE tickets ADD COLUMN ${col.name} ${col.type};`);
    }
  }
}

module.exports = {
  runMigrations,
};
