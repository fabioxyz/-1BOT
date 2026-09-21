const { getDatabase } = require('../database/connection');
const {
  ALLOWED_STATUS_TRANSITIONS,
  ALLOWED_PRIORITIES,
  TICKET_STATUS,
} = require('../utils/ticketState');

class TicketRepository {
  constructor(db) {
    this._db = db;
  }

  get db() {
    return this._db || getDatabase();
  }

  // ============================================
  // DEPARTAMENTOS
  // ============================================

  /**
   * Cria um novo departamento para a guild.
   * @param {object} params
   * @returns {object}
   */
  createDepartment({ guildId, name, description, emoji = null, staffRoleId = null, categoryId = null }) {
    const stmt = this.db.prepare(`
      INSERT INTO ticket_departments (
        guild_id, name, description, emoji, staff_role_id, category_id, active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))
    `);

    const result = stmt.run(guildId, name, description, emoji, staffRoleId, categoryId);
    return this.getDepartmentById(result.lastInsertRowid);
  }

  /**
   * Obtém um departamento pelo seu ID.
   * @param {number} id
   * @param {string} [guildId]
   * @returns {object|null}
   */
  getDepartmentById(id, guildId = null) {
    if (guildId) {
      const stmt = this.db.prepare('SELECT * FROM ticket_departments WHERE id = ? AND guild_id = ?');
      return stmt.get(id, guildId) || null;
    }
    const stmt = this.db.prepare('SELECT * FROM ticket_departments WHERE id = ?');
    return stmt.get(id) || null;
  }

  /**
   * Lista departamentos de uma guild.
   * @param {string} guildId
   * @param {boolean} [onlyActive=true]
   * @returns {Array<object>}
   */
  getDepartmentsByGuild(guildId, onlyActive = true) {
    if (onlyActive) {
      const stmt = this.db.prepare('SELECT * FROM ticket_departments WHERE guild_id = ? AND active = 1 ORDER BY id ASC');
      return stmt.all(guildId);
    }
    const stmt = this.db.prepare('SELECT * FROM ticket_departments WHERE guild_id = ? ORDER BY id ASC');
    return stmt.all(guildId);
  }

  /**
   * Procura departamento por nome na guild (insensível a maiúsculas).
   * @param {string} guildId
   * @param {string} name
   * @param {boolean} [onlyActive=true]
   * @returns {object|null}
   */
  getDepartmentByName(guildId, name, onlyActive = true) {
    if (onlyActive) {
      const stmt = this.db.prepare('SELECT * FROM ticket_departments WHERE guild_id = ? AND name = ? COLLATE NOCASE AND active = 1');
      return stmt.get(guildId, name) || null;
    }
    const stmt = this.db.prepare('SELECT * FROM ticket_departments WHERE guild_id = ? AND name = ? COLLATE NOCASE');
    return stmt.get(guildId, name) || null;
  }

  /**
   * Conta departamentos ativos de uma guild.
   * @param {string} guildId
   * @returns {number}
   */
  countActiveDepartments(guildId) {
    const stmt = this.db.prepare('SELECT COUNT(*) AS count FROM ticket_departments WHERE guild_id = ? AND active = 1');
    const row = stmt.get(guildId);
    return row ? row.count : 0;
  }

  /**
   * Desativa um departamento (soft-delete).
   * @param {number} id
   * @param {string} guildId
   * @returns {boolean}
   */
  deactivateDepartment(id, guildId) {
    const stmt = this.db.prepare(`
      UPDATE ticket_departments
      SET active = 0, updated_at = datetime('now')
      WHERE id = ? AND guild_id = ? AND active = 1
    `);
    const result = stmt.run(id, guildId);
    return result.changes > 0;
  }

  // ============================================
  // TICKETS
  // ============================================

  /**
   * Obtém ticket ativo de um utilizador na guild.
   * @param {string} guildId
   * @param {string} creatorId
   * @returns {object|null}
   */
  getActiveTicketByUser(guildId, creatorId) {
    const stmt = this.db.prepare(`
      SELECT * FROM tickets
      WHERE guild_id = ? AND creator_id = ? AND status != 'closed'
      LIMIT 1
    `);
    return stmt.get(guildId, creatorId) || null;
  }

  /**
   * Reserva atomicamente um número sequencial e regista o ticket na base de dados.
   * @param {object} params
   * @returns {object}
   */
  createTicketReservation({
    guildId,
    creatorId,
    departmentId,
    subject,
    description,
    reference = null,
    priority = 'normal',
  }) {
    const execute = this.db.transaction(() => {
      // 1. Verificar se já existe ticket ativo para o utilizador
      const activeExisting = this.getActiveTicketByUser(guildId, creatorId);
      if (activeExisting) {
        const err = new Error('O utilizador já possui um ticket ativo neste servidor.');
        err.code = 'ACTIVE_TICKET_EXISTS';
        err.ticketId = activeExisting.id;
        throw err;
      }

      // 2. Calcular próximo número sequencial para esta guild
      const nextNumStmt = this.db.prepare(`
        SELECT COALESCE(MAX(ticket_number), 0) + 1 AS next_number
        FROM tickets
        WHERE guild_id = ?
      `);
      const { next_number } = nextNumStmt.get(guildId);

      // 3. Inserir ticket no estado 'new' com channel_id pendente
      const insertStmt = this.db.prepare(`
        INSERT INTO tickets (
          guild_id,
          ticket_number,
          creator_id,
          department_id,
          subject,
          description,
          reference,
          priority,
          status,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', datetime('now'), datetime('now'))
      `);

      const result = insertStmt.run(
        guildId,
        next_number,
        creatorId,
        departmentId,
        subject,
        description,
        reference,
        priority
      );

      return this.getTicketById(result.lastInsertRowid);
    });

    return execute();
  }

  /**
   * Associa o channel_id ao ticket após a criação do canal no Discord.
   * @param {number} ticketId
   * @param {string} channelId
   * @returns {boolean}
   */
  setTicketChannelId(ticketId, channelId) {
    const stmt = this.db.prepare(`
      UPDATE tickets
      SET channel_id = ?, updated_at = datetime('now')
      WHERE id = ?
    `);
    const result = stmt.run(channelId, ticketId);
    return result.changes > 0;
  }

  /**
   * Remove o ticket da base de dados (rollback se a criação do canal falhar).
   * @param {number} ticketId
   * @returns {boolean}
   */
  deleteTicket(ticketId) {
    const stmt = this.db.prepare('DELETE FROM tickets WHERE id = ?');
    const result = stmt.run(ticketId);
    return result.changes > 0;
  }

  /**
   * Obtém ticket por ID, com verificação opcional de servidor para isolamento.
   * @param {number} ticketId
   * @param {string} [guildId]
   * @returns {object|null}
   */
  getTicketById(ticketId, guildId = null) {
    if (guildId) {
      const stmt = this.db.prepare('SELECT * FROM tickets WHERE id = ? AND guild_id = ?');
      return stmt.get(ticketId, guildId) || null;
    }
    const stmt = this.db.prepare('SELECT * FROM tickets WHERE id = ?');
    return stmt.get(ticketId) || null;
  }

  /**
   * Obtém ticket por Channel ID, com verificação opcional de servidor para isolamento.
   * @param {string} channelId
   * @param {string} [guildId]
   * @returns {object|null}
   */
  getTicketByChannelId(channelId, guildId = null) {
    if (guildId) {
      const stmt = this.db.prepare('SELECT * FROM tickets WHERE channel_id = ? AND guild_id = ?');
      return stmt.get(channelId, guildId) || null;
    }
    const stmt = this.db.prepare('SELECT * FROM tickets WHERE channel_id = ?');
    return stmt.get(channelId) || null;
  }

  /**
   * Associa o ID da mensagem de controlo ao ticket.
   * @param {number} ticketId
   * @param {string} controlMessageId
   * @param {string} [guildId]
   * @returns {boolean}
   */
  setControlMessageId(ticketId, controlMessageId, guildId = null) {
    if (guildId) {
      const stmt = this.db.prepare(`
        UPDATE tickets
        SET control_message_id = ?, updated_at = datetime('now')
        WHERE id = ? AND guild_id = ?
      `);
      const result = stmt.run(controlMessageId, ticketId, guildId);
      return result.changes > 0;
    }
    const stmt = this.db.prepare(`
      UPDATE tickets
      SET control_message_id = ?, updated_at = datetime('now')
      WHERE id = ?
    `);
    const result = stmt.run(controlMessageId, ticketId);
    return result.changes > 0;
  }

  /**
   * Assume um ticket atomicamente (claim).
   * Suporta chamada por objeto ou posicional: claimTicket(ticketId, staffUserId, guildId).
   * @param {object|number} paramsOrTicketId
   * @param {string} [staffUserId]
   * @param {string} [guildId]
   * @returns {{ ticket: object, alreadyClaimedBySelf: boolean, event?: object }}
   */
  claimTicket(paramsOrTicketId, staffUserId, guildId) {
    let ticketId = paramsOrTicketId;
    let sUserId = staffUserId;
    let gId = guildId;

    if (typeof paramsOrTicketId === 'object' && paramsOrTicketId !== null) {
      ticketId = paramsOrTicketId.ticketId;
      sUserId = paramsOrTicketId.staffUserId;
      gId = paramsOrTicketId.guildId;
    }

    const runClaim = this.db.transaction(() => {
      const ticket = gId
        ? this.db.prepare('SELECT * FROM tickets WHERE id = ? AND guild_id = ?').get(ticketId, gId)
        : this.db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);

      if (!ticket) {
        const err = new Error('Ticket não encontrado.');
        err.code = 'TICKET_NOT_FOUND';
        throw err;
      }

      if (ticket.status === 'closed') {
        const err = new Error('Este ticket já se encontra fechado.');
        err.code = 'TICKET_NOT_ACTIVE';
        throw err;
      }

      // Idempotência amigável: já assumido pelo próprio
      if (ticket.claimed_by === sUserId) {
        return {
          ticket,
          alreadyClaimedBySelf: true,
          event: null,
        };
      }

      // Conflito: já assumido por outro membro
      if (ticket.claimed_by !== null) {
        const err = new Error('Este ticket já se encontra atribuído a outro membro da equipa.');
        err.code = 'ALREADY_CLAIMED_BY_OTHER';
        err.claimedBy = ticket.claimed_by;
        throw err;
      }

      // Mutação atómica condicional (claimed_by IS NULL)
      const updateStmt = gId
        ? this.db.prepare(`
            UPDATE tickets
            SET claimed_by = ?, status = 'assigned', updated_at = datetime('now')
            WHERE id = ? AND guild_id = ? AND claimed_by IS NULL AND status != 'closed'
          `)
        : this.db.prepare(`
            UPDATE tickets
            SET claimed_by = ?, status = 'assigned', updated_at = datetime('now')
            WHERE id = ? AND claimed_by IS NULL AND status != 'closed'
          `);

      const res = gId
        ? updateStmt.run(sUserId, ticketId, gId)
        : updateStmt.run(sUserId, ticketId);

      if (res.changes === 0) {
        // Concorrência detetada
        const current = gId
          ? this.db.prepare('SELECT * FROM tickets WHERE id = ? AND guild_id = ?').get(ticketId, gId)
          : this.db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);

        if (current && current.claimed_by === sUserId) {
          return { ticket: current, alreadyClaimedBySelf: true, event: null };
        }
        const err = new Error('Conflito concorrente: o ticket foi assumido por outro membro.');
        err.code = 'ALREADY_CLAIMED_BY_OTHER';
        err.claimedBy = current ? current.claimed_by : null;
        throw err;
      }

      // Registar evento somente após o sucesso da mutação
      const event = this.createEvent({
        ticketId: ticket.id,
        guildId: ticket.guild_id,
        eventType: 'ticket_claimed',
        actorId: sUserId,
        metadata: {
          claimedBy: sUserId,
          previousStatus: ticket.status,
          newStatus: 'assigned',
        },
      });

      const updatedTicket = this.getTicketById(ticket.id, ticket.guild_id);
      return {
        ticket: updatedTicket,
        alreadyClaimedBySelf: false,
        event,
      };
    });

    return runClaim();
  }

  /**
   * Liberta um ticket (release), removendo claimed_by e voltando ao estado 'new'.
   * Suporta chamada por objeto ou posicional: releaseTicket(ticketId, actorId, isAdmin, guildId).
   * @param {object|number} paramsOrTicketId
   * @param {string} [actorId]
   * @param {boolean} [isAdmin=false]
   * @param {string} [guildId]
   * @returns {{ ticket: object, event: object }}
   */
  releaseTicket(paramsOrTicketId, actorId, isAdmin = false, guildId = null) {
    let ticketId = paramsOrTicketId;
    let actId = actorId;
    let admin = isAdmin;
    let gId = guildId;

    if (typeof paramsOrTicketId === 'object' && paramsOrTicketId !== null) {
      ticketId = paramsOrTicketId.ticketId;
      actId = paramsOrTicketId.actorId;
      admin = Boolean(paramsOrTicketId.isAdmin);
      gId = paramsOrTicketId.guildId;
    }

    const runRelease = this.db.transaction(() => {
      const ticket = gId
        ? this.db.prepare('SELECT * FROM tickets WHERE id = ? AND guild_id = ?').get(ticketId, gId)
        : this.db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);

      if (!ticket) {
        const err = new Error('Ticket não encontrado.');
        err.code = 'TICKET_NOT_FOUND';
        throw err;
      }

      if (ticket.status === 'closed') {
        const err = new Error('Este ticket já se encontra fechado.');
        err.code = 'TICKET_NOT_ACTIVE';
        throw err;
      }

      if (!ticket.claimed_by) {
        const err = new Error('O ticket não está atribuído a nenhum membro da equipa.');
        err.code = 'TICKET_NOT_CLAIMED';
        throw err;
      }

      if (ticket.status === 'resolved') {
        const err = new Error('Um ticket no estado Resolvido não pode ser libertado sem ser reaberto previamente.');
        err.code = 'CANNOT_RELEASE_RESOLVED';
        throw err;
      }

      if (ticket.claimed_by !== actId && !admin) {
        const err = new Error('Apenas o responsável atual ou um administrador pode libertar o ticket.');
        err.code = 'FORBIDDEN_NOT_CLAIMANT';
        throw err;
      }

      const updateStmt = gId
        ? this.db.prepare(`
            UPDATE tickets
            SET claimed_by = NULL, status = 'new', updated_at = datetime('now')
            WHERE id = ? AND guild_id = ? AND status != 'closed'
          `)
        : this.db.prepare(`
            UPDATE tickets
            SET claimed_by = NULL, status = 'new', updated_at = datetime('now')
            WHERE id = ? AND status != 'closed'
          `);

      const res = gId
        ? updateStmt.run(ticketId, gId)
        : updateStmt.run(ticketId);

      if (res.changes === 0) {
        const err = new Error('Não foi possível libertar o ticket devido a conflito concorrente.');
        err.code = 'CONCURRENT_MODIFICATION';
        throw err;
      }

      const event = this.createEvent({
        ticketId: ticket.id,
        guildId: ticket.guild_id,
        eventType: 'ticket_released',
        actorId: actId,
        metadata: {
          releasedBy: actId,
          previousClaimedBy: ticket.claimed_by,
          previousStatus: ticket.status,
          newStatus: 'new',
        },
      });

      const updatedTicket = this.getTicketById(ticket.id, ticket.guild_id);
      return {
        ticket: updatedTicket,
        event,
      };
    });

    return runRelease();
  }

  /**
   * Altera o estado do ticket validando a matriz de transições.
   * Suporta chamada por objeto ou posicional: updateTicketStatus(ticketId, newStatus, actorId, isAdmin, guildId).
   * @param {object|number} paramsOrTicketId
   * @param {string} [newStatus]
   * @param {string} [actorId]
   * @param {boolean} [isAdmin=false]
   * @param {string} [guildId]
   * @returns {{ ticket: object, unchanged: boolean, event?: object }}
   */
  updateTicketStatus(paramsOrTicketId, newStatus, actorId, isAdmin = false, guildId = null) {
    let ticketId = paramsOrTicketId;
    let nStatus = newStatus;
    let actId = actorId;
    let admin = isAdmin;
    let gId = guildId;

    if (typeof paramsOrTicketId === 'object' && paramsOrTicketId !== null) {
      ticketId = paramsOrTicketId.ticketId;
      nStatus = paramsOrTicketId.newStatus;
      actId = paramsOrTicketId.actorId;
      admin = Boolean(paramsOrTicketId.isAdmin);
      gId = paramsOrTicketId.guildId;
    }

    const runStatusUpdate = this.db.transaction(() => {
      const ticket = gId
        ? this.db.prepare('SELECT * FROM tickets WHERE id = ? AND guild_id = ?').get(ticketId, gId)
        : this.db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);

      if (!ticket) {
        const err = new Error('Ticket não encontrado.');
        err.code = 'TICKET_NOT_FOUND';
        throw err;
      }

      if (ticket.status === 'closed') {
        const err = new Error('Este ticket já se encontra fechado.');
        err.code = 'TICKET_NOT_ACTIVE';
        throw err;
      }

      // Idempotência
      if (ticket.status === nStatus) {
        return {
          ticket,
          unchanged: true,
          event: null,
        };
      }

      // Validação estrita da matriz de transições
      const allowed = ALLOWED_STATUS_TRANSITIONS[ticket.status] || [];
      if (!allowed.includes(nStatus)) {
        const err = new Error(`Transição de estado inválida de '${ticket.status}' para '${nStatus}'.`);
        err.code = 'INVALID_STATUS_TRANSITION';
        throw err;
      }

      // Exige ticket atribuído
      if (!ticket.claimed_by) {
        const err = new Error('O ticket precisa de estar atribuído antes de alterar o seu estado.');
        err.code = 'TICKET_NOT_CLAIMED';
        throw err;
      }

      // Responsável atual ou admin
      if (ticket.claimed_by !== actId && !admin) {
        const err = new Error('Apenas o responsável atual ou um administrador pode alterar o estado do ticket.');
        err.code = 'FORBIDDEN_NOT_CLAIMANT';
        throw err;
      }

      const updateStmt = gId
        ? this.db.prepare(`
            UPDATE tickets
            SET status = ?, updated_at = datetime('now')
            WHERE id = ? AND guild_id = ? AND status = ? AND status != 'closed'
          `)
        : this.db.prepare(`
            UPDATE tickets
            SET status = ?, updated_at = datetime('now')
            WHERE id = ? AND status = ? AND status != 'closed'
          `);

      const res = gId
        ? updateStmt.run(nStatus, ticketId, gId, ticket.status)
        : updateStmt.run(nStatus, ticketId, ticket.status);

      if (res.changes === 0) {
        const err = new Error('Conflito concorrente ao alterar estado do ticket.');
        err.code = 'CONCURRENT_MODIFICATION';
        throw err;
      }

      const event = this.createEvent({
        ticketId: ticket.id,
        guildId: ticket.guild_id,
        eventType: 'ticket_status_changed',
        actorId: actId,
        metadata: {
          previousStatus: ticket.status,
          newStatus: nStatus,
        },
      });

      const updatedTicket = this.getTicketById(ticket.id, ticket.guild_id);
      return {
        ticket: updatedTicket,
        unchanged: false,
        event,
      };
    });

    return runStatusUpdate();
  }

  /**
   * Altera a prioridade do ticket.
   * Suporta chamada por objeto ou posicional: updateTicketPriority(ticketId, newPriority, actorId, isStaffOrAdmin, guildId).
   * @param {object|number} paramsOrTicketId
   * @param {string} [newPriority]
   * @param {string} [actorId]
   * @param {boolean} [isStaffOrAdmin=true]
   * @param {string} [guildId]
   * @returns {{ ticket: object, unchanged: boolean, event?: object }}
   */
  updateTicketPriority(paramsOrTicketId, newPriority, actorId, isStaffOrAdmin = true, guildId = null) {
    let ticketId = paramsOrTicketId;
    let nPriority = newPriority;
    let actId = actorId;
    let staffOrAdmin = isStaffOrAdmin;
    let gId = guildId;

    if (typeof paramsOrTicketId === 'object' && paramsOrTicketId !== null) {
      ticketId = paramsOrTicketId.ticketId;
      nPriority = paramsOrTicketId.newPriority;
      actId = paramsOrTicketId.actorId;
      staffOrAdmin = paramsOrTicketId.isStaffOrAdmin ?? true;
      gId = paramsOrTicketId.guildId;
    }

    const runPriorityUpdate = this.db.transaction(() => {
      const ticket = gId
        ? this.db.prepare('SELECT * FROM tickets WHERE id = ? AND guild_id = ?').get(ticketId, gId)
        : this.db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);

      if (!ticket) {
        const err = new Error('Ticket não encontrado.');
        err.code = 'TICKET_NOT_FOUND';
        throw err;
      }

      if (ticket.status === 'closed') {
        const err = new Error('Este ticket já se encontra fechado.');
        err.code = 'TICKET_NOT_ACTIVE';
        throw err;
      }

      if (!staffOrAdmin) {
        const err = new Error('Apenas membros da equipa de suporte ou administradores podem alterar a prioridade.');
        err.code = 'FORBIDDEN_STAFF_ONLY';
        throw err;
      }

      if (!ALLOWED_PRIORITIES.includes(nPriority)) {
        const err = new Error(`Prioridade '${nPriority}' inválida.`);
        err.code = 'INVALID_PRIORITY';
        throw err;
      }

      // Idempotência: responde sem criar evento duplicado
      if (ticket.priority === nPriority) {
        return {
          ticket,
          unchanged: true,
          event: null,
        };
      }

      const updateStmt = gId
        ? this.db.prepare(`
            UPDATE tickets
            SET priority = ?, updated_at = datetime('now')
            WHERE id = ? AND guild_id = ? AND priority = ? AND status != 'closed'
          `)
        : this.db.prepare(`
            UPDATE tickets
            SET priority = ?, updated_at = datetime('now')
            WHERE id = ? AND priority = ? AND status != 'closed'
          `);

      const res = gId
        ? updateStmt.run(nPriority, ticketId, gId, ticket.priority)
        : updateStmt.run(nPriority, ticketId, ticket.priority);

      if (res.changes === 0) {
        const err = new Error('Conflito concorrente ao alterar prioridade do ticket.');
        err.code = 'CONCURRENT_MODIFICATION';
        throw err;
      }

      const event = this.createEvent({
        ticketId: ticket.id,
        guildId: ticket.guild_id,
        eventType: 'ticket_priority_changed',
        actorId: actId,
        metadata: {
          previousPriority: ticket.priority,
          newPriority: nPriority,
        },
      });

      const updatedTicket = this.getTicketById(ticket.id, ticket.guild_id);
      return {
        ticket: updatedTicket,
        unchanged: false,
        event,
      };
    });

    return runPriorityUpdate();
  }

  /**
   * Obtém todos os tickets ativos e válidos de uma guild para uma determinada categoria,
   * resolvendo o fallback de departmento -> configurações gerais.
   * Não retorna tickets closed ou closing.
   * @param {string} guildId
   * @param {string} categoryId
   * @returns {Array<object>}
   */
  getActiveTicketsByGuildAndCategory(guildId, categoryId) {
    const stmt = this.db.prepare(`
      SELECT
        t.id, t.ticket_number, t.channel_id, t.priority, t.created_at, t.guild_id
      FROM tickets t
      JOIN ticket_departments td ON t.department_id = td.id
      LEFT JOIN guild_settings gs ON t.guild_id = gs.guild_id
      WHERE t.guild_id = ?
        AND t.status NOT IN ('closed', 'closing')
        AND t.channel_id IS NOT NULL
        AND COALESCE(td.category_id, gs.ticket_category_id) = ?
    `);
    return stmt.all(guildId, categoryId);
  }

  // ============================================
  // AUDITORIA / EVENTOS
  // ============================================

  /**
   * Regista um evento de auditoria.
   * @param {object} params
   * @returns {object}
   */
  createEvent({ ticketId = null, guildId = null, eventType, actorId, metadata = null }) {
    const metadataJson = metadata ? JSON.stringify(metadata) : null;
    const stmt = this.db.prepare(`
      INSERT INTO ticket_events (
        ticket_id, guild_id, event_type, actor_id, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, datetime('now'))
    `);
    const result = stmt.run(ticketId, guildId, eventType, actorId, metadataJson);
    return {
      id: result.lastInsertRowid,
      ticket_id: ticketId,
      guild_id: guildId,
      event_type: eventType,
      actor_id: actorId,
      metadata_json: metadataJson,
    };
  }

  /**
   * Obtém eventos de um ticket.
   * @param {number} ticketId
   * @returns {Array<object>}
   */
  getEventsByTicket(ticketId) {
    const stmt = this.db.prepare('SELECT * FROM ticket_events WHERE ticket_id = ? ORDER BY id ASC');
    return stmt.all(ticketId);
  }

  /**
   * Obtém os eventos mais recentes de um ticket (limitado).
   * @param {number} ticketId
   * @param {number} [limit=5]
   * @param {string} [guildId]
   * @returns {Array<object>}
   */
  getRecentEventsByTicket(ticketId, limit = 5, guildId = null) {
    if (guildId) {
      const stmt = this.db.prepare('SELECT * FROM ticket_events WHERE ticket_id = ? AND guild_id = ? ORDER BY id DESC LIMIT ?');
      return stmt.all(ticketId, guildId, limit);
    }
    const stmt = this.db.prepare('SELECT * FROM ticket_events WHERE ticket_id = ? ORDER BY id DESC LIMIT ?');
    return stmt.all(ticketId, limit);
  }

  /**
   * Transfere o ticket para um novo departamento na base de dados com isolamento por servidor e concorrência.
   * @param {object} params
   * @param {number} params.ticketId
   * @param {number} params.newDepartmentId
   * @param {string} [params.guildId]
   * @param {number} [params.oldDepartmentId]
   * @returns {object}
   */
  transferDepartment({ ticketId, newDepartmentId, guildId = null, oldDepartmentId = null }) {
    const runTransfer = this.db.transaction(() => {
      const ticket = guildId
        ? this.db.prepare('SELECT * FROM tickets WHERE id = ? AND guild_id = ?').get(ticketId, guildId)
        : this.db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);

      if (!ticket) {
        const err = new Error('Ticket não encontrado.');
        err.code = 'TICKET_NOT_FOUND';
        throw err;
      }

      if (ticket.status === 'closed') {
        const err = new Error('Este ticket já se encontra fechado.');
        err.code = 'TICKET_NOT_ACTIVE';
        throw err;
      }

      if (oldDepartmentId !== null && Number(ticket.department_id) !== Number(oldDepartmentId)) {
        const err = new Error('Conflito concorrente: o departamento do ticket foi alterado.');
        err.code = 'CONCURRENT_MODIFICATION';
        throw err;
      }

      const updateStmt = guildId
        ? this.db.prepare(`
            UPDATE tickets
            SET department_id = ?, updated_at = datetime('now')
            WHERE id = ? AND guild_id = ? AND status != 'closed'
          `)
        : this.db.prepare(`
            UPDATE tickets
            SET department_id = ?, updated_at = datetime('now')
            WHERE id = ? AND status != 'closed'
          `);

      const res = guildId
        ? updateStmt.run(newDepartmentId, ticketId, guildId)
        : updateStmt.run(newDepartmentId, ticketId);

      if (res.changes === 0) {
        const err = new Error('Não foi possível transferir o ticket devido a conflito concorrente.');
        err.code = 'CONCURRENT_MODIFICATION';
        throw err;
      }

      return this.getTicketById(ticket.id, guildId || ticket.guild_id);
    });

    return runTransfer();
  }

  /**
   * Obtém eventos administrativos por guild.
   * @param {string} guildId
   * @returns {Array<object>}
   */
  getEventsByGuild(guildId) {
    const stmt = this.db.prepare('SELECT * FROM ticket_events WHERE guild_id = ? ORDER BY id ASC');
    return stmt.all(guildId);
  }

  /**
   * Inicia o processo de fecho do ticket de forma atómica e concorrente.
   * Valida se o ticket existe, pertence à guild e está ativo.
   * Regista closing_started_at para evitar fechos simultâneos.
   * @param {object} params
   * @param {number} params.ticketId
   * @param {string} [params.guildId]
   * @param {string} [params.actorId]
   * @param {boolean} [params.force=false]
   * @returns {{ ticket: object }}
   */
  beginClose({ ticketId, guildId = null, actorId = null, force = false }) {
    const runBegin = this.db.transaction(() => {
      const ticket = guildId
        ? this.db.prepare('SELECT * FROM tickets WHERE id = ? AND guild_id = ?').get(ticketId, guildId)
        : this.db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);

      if (!ticket) {
        const err = new Error('Ticket não encontrado.');
        err.code = 'TICKET_NOT_FOUND';
        throw err;
      }

      if (ticket.status === 'closed') {
        const err = new Error('Este ticket já se encontra fechado.');
        err.code = 'TICKET_NOT_ACTIVE';
        throw err;
      }

      // Concorrência: se já existir closing_started_at recente (< 60s) e não for forçado
      if (!force && ticket.closing_started_at) {
        const rawDate = ticket.closing_started_at;
        const isoString = rawDate.includes('T') ? rawDate : rawDate.replace(' ', 'T') + 'Z';
        const startedTime = new Date(isoString).getTime();
        const now = Date.now();
        if (!Number.isNaN(startedTime) && (now - startedTime) < 60000) {
          const err = new Error('O fecho deste ticket já se encontra em processamento.');
          err.code = 'CONCURRENT_CLOSE';
          throw err;
        }
      }

      const nowIso = new Date().toISOString();
      const updateStmt = guildId
        ? this.db.prepare(`
            UPDATE tickets
            SET closing_started_at = ?, updated_at = datetime('now')
            WHERE id = ? AND guild_id = ? AND status != 'closed'
          `)
        : this.db.prepare(`
            UPDATE tickets
            SET closing_started_at = ?, updated_at = datetime('now')
            WHERE id = ? AND status != 'closed'
          `);

      const res = guildId
        ? updateStmt.run(nowIso, ticketId, guildId)
        : updateStmt.run(nowIso, ticketId);

      if (res.changes === 0) {
        const err = new Error('Não foi possível iniciar o fecho devido a concorrência.');
        err.code = 'CONCURRENT_MODIFICATION';
        throw err;
      }

      const updated = this.getTicketById(ticket.id, guildId || ticket.guild_id);
      return { ticket: updated };
    });

    return runBegin();
  }

  /**
   * Finaliza o fecho do ticket gravando closed, closed_by, reason, transcript_path, transcript_sha256, transcript_message_count.
   * Liberta o índice parcial idx_tickets_active_user.
   * @param {object} params
   * @returns {object} ticket atualizado
   */
  finalizeClose({
    ticketId,
    guildId = null,
    closedBy,
    reason = null,
    transcriptPath = null,
    transcriptSha256 = null,
    transcriptMessageCount = 0,
  }) {
    const runFinalize = this.db.transaction(() => {
      const ticket = guildId
        ? this.db.prepare('SELECT * FROM tickets WHERE id = ? AND guild_id = ?').get(ticketId, guildId)
        : this.db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);

      if (!ticket) {
        const err = new Error('Ticket não encontrado.');
        err.code = 'TICKET_NOT_FOUND';
        throw err;
      }

      if (ticket.status === 'closed') {
        const err = new Error('Este ticket já se encontra fechado.');
        err.code = 'TICKET_NOT_ACTIVE';
        throw err;
      }

      const updateStmt = guildId
        ? this.db.prepare(`
            UPDATE tickets
            SET status = 'closed',
                closed_by = ?,
                close_reason = ?,
                transcript_path = ?,
                transcript_sha256 = ?,
                transcript_message_count = ?,
                closing_started_at = NULL,
                closed_at = datetime('now'),
                updated_at = datetime('now')
            WHERE id = ? AND guild_id = ? AND status != 'closed'
          `)
        : this.db.prepare(`
            UPDATE tickets
            SET status = 'closed',
                closed_by = ?,
                close_reason = ?,
                transcript_path = ?,
                transcript_sha256 = ?,
                transcript_message_count = ?,
                closing_started_at = NULL,
                closed_at = datetime('now'),
                updated_at = datetime('now')
            WHERE id = ? AND status != 'closed'
          `);

      const res = guildId
        ? updateStmt.run(closedBy, reason, transcriptPath, transcriptSha256, transcriptMessageCount, ticketId, guildId)
        : updateStmt.run(closedBy, reason, transcriptPath, transcriptSha256, transcriptMessageCount, ticketId);

      if (res.changes === 0) {
        const err = new Error('Falha ao finalizar o fecho do ticket devido a concorrência.');
        err.code = 'CONCURRENT_MODIFICATION';
        throw err;
      }

      return this.getTicketById(ticket.id, guildId || ticket.guild_id);
    });

    return runFinalize();
  }

  /**
   * Cancela/aborta o fecho de um ticket, limpando closing_started_at se o ticket ainda estiver ativo.
   * @param {number} ticketId
   * @param {string} [guildId]
   * @returns {boolean}
   */
  abortClose(ticketId, guildId = null) {
    const updateStmt = guildId
      ? this.db.prepare(`
          UPDATE tickets
          SET closing_started_at = NULL, updated_at = datetime('now')
          WHERE id = ? AND guild_id = ? AND status != 'closed'
        `)
      : this.db.prepare(`
          UPDATE tickets
          SET closing_started_at = NULL, updated_at = datetime('now')
          WHERE id = ? AND status != 'closed'
        `);

    const res = guildId ? updateStmt.run(ticketId, guildId) : updateStmt.run(ticketId);
    return res.changes > 0;
  }

  /**
   * Obtém metadados de fecho de um ticket.
   * @param {number} ticketId
   * @param {string} [guildId]
   * @returns {object|null}
   */
  getClosureMetadata(ticketId, guildId = null) {
    const stmt = guildId
      ? this.db.prepare(`
          SELECT id, guild_id, ticket_number, creator_id, status,
                 closed_by, close_reason, closed_at,
                 transcript_path, transcript_sha256, transcript_message_count
          FROM tickets
          WHERE id = ? AND guild_id = ?
        `)
      : this.db.prepare(`
          SELECT id, guild_id, ticket_number, creator_id, status,
                 closed_by, close_reason, closed_at,
                 transcript_path, transcript_sha256, transcript_message_count
          FROM tickets
          WHERE id = ?
        `);

    return (guildId ? stmt.get(ticketId, guildId) : stmt.get(ticketId)) || null;
  }
}

module.exports = new TicketRepository();
module.exports.TicketRepository = TicketRepository;
