const { getDatabase } = require('../database/connection');

class SettingsRepository {
  constructor(db) {
    this._db = db;
  }

  get db() {
    return this._db || getDatabase();
  }

  /**
   * Obtém as configurações de tickets de uma guild.
   * @param {string} guildId
   * @returns {object|null}
   */
  getGuildSettings(guildId) {
    const stmt = this.db.prepare('SELECT * FROM guild_settings WHERE guild_id = ?');
    return stmt.get(guildId) || null;
  }

  /**
   * Cria ou atualiza as configurações da guild (upsert).
   * @param {string} guildId
   * @param {object} settings
   * @returns {object}
   */
  upsertGuildSettings(guildId, settings) {
    const current = this.getGuildSettings(guildId);

    const ticketCategoryId = settings.ticket_category_id !== undefined ? settings.ticket_category_id : (settings.ticketCategoryId !== undefined ? settings.ticketCategoryId : (current ? current.ticket_category_id : null));
    const archiveCategoryId = settings.archive_category_id !== undefined ? settings.archive_category_id : (settings.archiveCategoryId !== undefined ? settings.archiveCategoryId : (current ? current.archive_category_id : null));
    const logChannelId = settings.log_channel_id !== undefined ? settings.log_channel_id : (settings.logChannelId !== undefined ? settings.logChannelId : (current ? current.log_channel_id : null));
    const defaultStaffRoleId = settings.default_staff_role_id !== undefined ? settings.default_staff_role_id : (settings.defaultStaffRoleId !== undefined ? settings.defaultStaffRoleId : (current ? current.default_staff_role_id : null));
    const panelTitle = settings.panel_title !== undefined ? settings.panel_title : (settings.panelTitle !== undefined ? settings.panelTitle : (current ? current.panel_title : null));
    const panelDescription = settings.panel_description !== undefined ? settings.panel_description : (settings.panelDescription !== undefined ? settings.panelDescription : (current ? current.panel_description : null));
    const panelColor = settings.panel_color !== undefined ? settings.panel_color : (settings.panelColor !== undefined ? settings.panelColor : (current ? current.panel_color : null));

    const stmt = this.db.prepare(`
      INSERT INTO guild_settings (
        guild_id,
        ticket_category_id,
        archive_category_id,
        log_channel_id,
        default_staff_role_id,
        panel_title,
        panel_description,
        panel_color,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(guild_id) DO UPDATE SET
        ticket_category_id = excluded.ticket_category_id,
        archive_category_id = excluded.archive_category_id,
        log_channel_id = excluded.log_channel_id,
        default_staff_role_id = excluded.default_staff_role_id,
        panel_title = excluded.panel_title,
        panel_description = excluded.panel_description,
        panel_color = excluded.panel_color,
        updated_at = datetime('now');
    `);

    stmt.run(guildId, ticketCategoryId, archiveCategoryId, logChannelId, defaultStaffRoleId, panelTitle, panelDescription, panelColor);
    return this.getGuildSettings(guildId);
  }
}

module.exports = new SettingsRepository();
module.exports.SettingsRepository = SettingsRepository;
