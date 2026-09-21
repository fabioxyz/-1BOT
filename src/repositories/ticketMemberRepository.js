const { getDatabase } = require('../database/connection');

class TicketMemberRepository {
  constructor(db = null) {
    this._db = db;
  }

  get db() {
    return this._db || getDatabase();
  }

  /**
   * Adiciona um participante ao ticket com validação de limite e isolamento por servidor.
   * @param {object} params
   * @param {number} params.ticketId
   * @param {string} params.userId
   * @param {string} params.addedBy
   * @param {string} [params.guildId]
   * @returns {{ member: object, alreadyMember: boolean }}
   */
  addMember({ ticketId, userId, addedBy, guildId = null }) {
    const runAdd = this.db.transaction(() => {
      // 1. Validar ticket e isolamento de guild se guildId for fornecido
      if (guildId) {
        const ticket = this.db.prepare('SELECT id, guild_id, creator_id FROM tickets WHERE id = ? AND guild_id = ?').get(ticketId, guildId);
        if (!ticket) {
          const err = new Error('Ticket não encontrado.');
          err.code = 'TICKET_NOT_FOUND';
          throw err;
        }
      }

      // 2. Idempotência amigável: se já for participante, retornar sem erro e sem duplicação
      const existing = this.db.prepare('SELECT * FROM ticket_members WHERE ticket_id = ? AND user_id = ?').get(ticketId, userId);
      if (existing) {
        return {
          member: existing,
          alreadyMember: true,
        };
      }

      // 3. Validação do limite estrito de 10 participantes adicionais por ticket
      const countRow = this.db.prepare('SELECT COUNT(*) AS count FROM ticket_members WHERE ticket_id = ?').get(ticketId);
      const currentCount = countRow ? countRow.count : 0;
      if (currentCount >= 10) {
        const err = new Error('O limite máximo de 10 participantes adicionais por ticket foi atingido.');
        err.code = 'MAX_PARTICIPANTS_REACHED';
        throw err;
      }

      // 4. Inserir participante
      const insertStmt = this.db.prepare(`
        INSERT INTO ticket_members (ticket_id, user_id, added_by, created_at)
        VALUES (?, ?, ?, datetime('now'))
      `);
      insertStmt.run(ticketId, userId, addedBy);

      const inserted = this.db.prepare('SELECT * FROM ticket_members WHERE ticket_id = ? AND user_id = ?').get(ticketId, userId);
      return {
        member: inserted,
        alreadyMember: false,
      };
    });

    return runAdd();
  }

  /**
   * Remove um participante do ticket.
   * Idempotente: se o participante não existir, devolve removed: false sem erro.
   * @param {object} params
   * @param {number} params.ticketId
   * @param {string} params.userId
   * @param {string} [params.guildId]
   * @returns {{ removed: boolean, member: object|null }}
   */
  removeMember({ ticketId, userId, guildId = null }) {
    const runRemove = this.db.transaction(() => {
      if (guildId) {
        const ticket = this.db.prepare('SELECT id, guild_id FROM tickets WHERE id = ? AND guild_id = ?').get(ticketId, guildId);
        if (!ticket) {
          const err = new Error('Ticket não encontrado.');
          err.code = 'TICKET_NOT_FOUND';
          throw err;
        }
      }

      const existing = this.db.prepare('SELECT * FROM ticket_members WHERE ticket_id = ? AND user_id = ?').get(ticketId, userId);
      if (!existing) {
        return {
          removed: false,
          member: null,
        };
      }

      this.db.prepare('DELETE FROM ticket_members WHERE ticket_id = ? AND user_id = ?').run(ticketId, userId);
      return {
        removed: true,
        member: existing,
      };
    });

    return runRemove();
  }

  /**
   * Obtém a lista de participantes de um ticket.
   * @param {number} ticketId
   * @param {string} [guildId]
   * @returns {Array<object>}
   */
  getMembers(ticketId, guildId = null) {
    if (guildId) {
      const stmt = this.db.prepare(`
        SELECT tm.*
        FROM ticket_members tm
        JOIN tickets t ON tm.ticket_id = t.id
        WHERE tm.ticket_id = ? AND t.guild_id = ?
        ORDER BY tm.created_at ASC
      `);
      return stmt.all(ticketId, guildId);
    }
    const stmt = this.db.prepare('SELECT * FROM ticket_members WHERE ticket_id = ? ORDER BY created_at ASC');
    return stmt.all(ticketId);
  }

  /**
   * Verifica se um utilizador é participante de um ticket.
   * @param {number} ticketId
   * @param {string} userId
   * @param {string} [guildId]
   * @returns {boolean}
   */
  isMember(ticketId, userId, guildId = null) {
    if (guildId) {
      const stmt = this.db.prepare(`
        SELECT 1
        FROM ticket_members tm
        JOIN tickets t ON tm.ticket_id = t.id
        WHERE tm.ticket_id = ? AND tm.user_id = ? AND t.guild_id = ?
      `);
      return Boolean(stmt.get(ticketId, userId, guildId));
    }
    const stmt = this.db.prepare('SELECT 1 FROM ticket_members WHERE ticket_id = ? AND user_id = ?');
    return Boolean(stmt.get(ticketId, userId));
  }

  /**
   * Retorna a contagem de participantes de um ticket.
   * @param {number} ticketId
   * @returns {number}
   */
  getMemberCount(ticketId) {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM ticket_members WHERE ticket_id = ?').get(ticketId);
    return row ? row.count : 0;
  }
}

module.exports = new TicketMemberRepository();
module.exports.TicketMemberRepository = TicketMemberRepository;
