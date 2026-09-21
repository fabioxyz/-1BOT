const ticketMemberRepository = require('../repositories/ticketMemberRepository');
const ticketRepository = require('../repositories/ticketRepository');
const permissionService = require('./permissionService');
const logger = require('../utils/logger');

class TicketMemberService {
  constructor(
    ticketMemberRepo = ticketMemberRepository,
    ticketRepo = ticketRepository,
    permService = permissionService
  ) {
    this.ticketMemberRepo = ticketMemberRepo;
    this.ticketRepo = ticketRepo;
    this.permissionService = permService;
  }

  /**
   * Valida autorização de staff/admin para gestão de participantes.
   * @param {object} params
   * @returns {object}
   */
  authorizeStaff({ member, guild, department = null, defaultStaffRoleId = null, ticket = null }) {
    const auth = this.permissionService.resolveTicketStaffPermission({
      member,
      guild,
      department,
      defaultStaffRoleId,
      ticket,
    });

    if (!auth.allowed) {
      const err = new Error(auth.error || 'Apenas membros da equipa de suporte ou administradores podem gerir participantes.');
      err.code = auth.code || 'FORBIDDEN_STAFF_ONLY';
      throw err;
    }

    return auth;
  }

  /**
   * Adiciona um participante ao canal do ticket e à base de dados com compensação atómica.
   * @param {object} params
   * @param {import('discord.js').Guild} params.guild
   * @param {import('discord.js').TextChannel} params.channel
   * @param {object} params.ticket
   * @param {import('discord.js').User|object} params.user
   * @param {import('discord.js').GuildMember} params.actorMember
   * @param {object} [params.department]
   * @param {object} [params.settings]
   * @returns {Promise<{ success: boolean, alreadyMember: boolean, user: object, event?: object }>}
   */
  async addParticipant({ guild, channel, ticket, user, actorMember, department = null, settings = null }) {
    if (!user || !user.id) {
      const err = new Error('Utilizador inválido especificado.');
      err.code = 'INVALID_USER';
      throw err;
    }

    // 1. Autorização: staff efetivo do departamento ou Administrador
    this.authorizeStaff({
      member: actorMember,
      guild,
      department,
      defaultStaffRoleId: settings?.default_staff_role_id,
      ticket,
    });

    // 2. Não adicionar o bot
    const botId = guild.client?.user?.id;
    if (user.bot || (botId && user.id === botId)) {
      const err = new Error('Não é possível adicionar bots como participantes do ticket.');
      err.code = 'CANNOT_ADD_BOT';
      throw err;
    }

    // 3. Não adicionar o autor
    if (user.id === ticket.creator_id) {
      const err = new Error('O autor do ticket já possui acesso permanente e não pode ser adicionado como participante.');
      err.code = 'CANNOT_ADD_CREATOR';
      throw err;
    }

    // 4. Não adicionar @everyone ou cargos
    if (user.id === guild.id || (guild.roles?.everyone && user.id === guild.roles.everyone.id)) {
      const err = new Error('Não é possível adicionar @everyone como participante.');
      err.code = 'INVALID_PARTICIPANT';
      throw err;
    }

    // 5. Idempotência amigável: se já for participante, responder sem duplicar na BD nem criar evento
    const isAlready = this.ticketMemberRepo.isMember(ticket.id, user.id, guild.id);
    if (isAlready) {
      return {
        success: true,
        alreadyMember: true,
        user,
      };
    }

    // 6. Limite máximo de 10 participantes adicionais por ticket
    const memberCount = this.ticketMemberRepo.getMemberCount(ticket.id);
    if (memberCount >= 10) {
      const err = new Error('O limite máximo de 10 participantes adicionais por ticket foi atingido.');
      err.code = 'MAX_PARTICIPANTS_REACHED';
      throw err;
    }

    // 7. Coordenação Discord + SQLite com compensação
    let overwriteCreated = false;
    if (channel && channel.permissionOverwrites && typeof channel.permissionOverwrites.edit === 'function') {
      try {
        await channel.permissionOverwrites.edit(user.id, {
          ViewChannel: true,
          SendMessages: true,
          ReadMessageHistory: true,
          AttachFiles: true,
          EmbedLinks: true,
        });
        overwriteCreated = true;
      } catch (discordErr) {
        logger.error(`Falha ao conceder permissões no Discord para ${user.id}: ${discordErr.message}`);
        const err = new Error('Não foi possível conceder permissões ao participante no canal.');
        err.code = 'DISCORD_PERMISSION_ERROR';
        throw err;
      }
    }

    let dbAdded = false;
    try {
      this.ticketMemberRepo.addMember({
        ticketId: ticket.id,
        userId: user.id,
        addedBy: actorMember.id,
        guildId: guild.id,
      });
      dbAdded = true;

      // 8. Registar evento de auditoria persistente somente após consistência total
      const event = this.ticketRepo.createEvent({
        ticketId: ticket.id,
        guildId: guild.id,
        eventType: 'ticket_participant_added',
        actorId: actorMember.id,
        metadata: {
          userId: user.id,
          addedBy: actorMember.id,
          ticketNumber: ticket.ticket_number,
        },
      });

      return {
        success: true,
        alreadyMember: false,
        user,
        event,
      };
    } catch (err) {
      // Compensação: reverter BD se inserido
      if (dbAdded) {
        try {
          this.ticketMemberRepo.removeMember({
            ticketId: ticket.id,
            userId: user.id,
            guildId: guild.id,
          });
        } catch (_) {}
      }
      // Compensação: reverter overwrite do Discord
      if (overwriteCreated && channel?.permissionOverwrites?.delete) {
        try {
          await channel.permissionOverwrites.delete(user.id);
        } catch (revErr) {
          logger.error(`Falha ao reverter permissões no Discord para ${user.id}: ${revErr.message}`);
        }
      }
      logger.error(`Falha ao registar participante/evento para ticket ${ticket.id}: ${err.message}`);
      throw err;
    }
  }

  /**
   * Remove um participante do canal do ticket e da base de dados com compensação atómica.
   * @param {object} params
   * @param {import('discord.js').Guild} params.guild
   * @param {import('discord.js').TextChannel} params.channel
   * @param {object} params.ticket
   * @param {import('discord.js').User|object} params.user
   * @param {import('discord.js').GuildMember} params.actorMember
   * @param {object} [params.department]
   * @param {object} [params.settings]
   * @returns {Promise<{ success: boolean, notMember: boolean, user: object, event?: object }>}
   */
  async removeParticipant({ guild, channel, ticket, user, actorMember, department = null, settings = null }) {
    if (!user || !user.id) {
      const err = new Error('Utilizador inválido especificado.');
      err.code = 'INVALID_USER';
      throw err;
    }

    // 1. Autorização: staff efetivo do departamento ou Administrador
    this.authorizeStaff({
      member: actorMember,
      guild,
      department,
      defaultStaffRoleId: settings?.default_staff_role_id,
      ticket,
    });

    // 2. Não permitir remover o autor
    if (user.id === ticket.creator_id) {
      const err = new Error('O autor do ticket possui acesso permanente e não pode ser removido.');
      err.code = 'CANNOT_REMOVE_CREATOR';
      throw err;
    }

    // 3. Idempotência amigável: se não for participante, responder sem erro nem evento
    const isMember = this.ticketMemberRepo.isMember(ticket.id, user.id, guild.id);
    if (!isMember) {
      return {
        success: true,
        notMember: true,
        user,
      };
    }

    // 4. Coordenação Discord + SQLite com compensação
    let overwriteDeleted = false;
    if (channel && channel.permissionOverwrites && typeof channel.permissionOverwrites.delete === 'function') {
      try {
        await channel.permissionOverwrites.delete(user.id);
        overwriteDeleted = true;
      } catch (discordErr) {
        logger.error(`Falha ao remover permissões no Discord para ${user.id}: ${discordErr.message}`);
        const err = new Error('Não foi possível remover as permissões do participante no canal.');
        err.code = 'DISCORD_PERMISSION_ERROR';
        throw err;
      }
    }

    let dbRemoved = false;
    let previousMember = null;
    try {
      const rmResult = this.ticketMemberRepo.removeMember({
        ticketId: ticket.id,
        userId: user.id,
        guildId: guild.id,
      });
      dbRemoved = rmResult.removed;
      previousMember = rmResult.member;

      // 5. Registar evento de auditoria persistente somente após consistência total
      const event = this.ticketRepo.createEvent({
        ticketId: ticket.id,
        guildId: guild.id,
        eventType: 'ticket_participant_removed',
        actorId: actorMember.id,
        metadata: {
          userId: user.id,
          removedBy: actorMember.id,
          ticketNumber: ticket.ticket_number,
        },
      });

      return {
        success: true,
        notMember: false,
        user,
        event,
      };
    } catch (err) {
      // Compensação: restaurar participante na BD se tinha sido removido
      if (dbRemoved) {
        try {
          this.ticketMemberRepo.addMember({
            ticketId: ticket.id,
            userId: user.id,
            addedBy: previousMember?.added_by || actorMember.id,
            guildId: guild.id,
          });
        } catch (_) {}
      }
      // Compensação: restaurar overwrite no Discord se a BD/evento falhar
      if (overwriteDeleted && channel?.permissionOverwrites?.edit) {
        try {
          await channel.permissionOverwrites.edit(user.id, {
            ViewChannel: true,
            SendMessages: true,
            ReadMessageHistory: true,
            AttachFiles: true,
            EmbedLinks: true,
          });
        } catch (revErr) {
          logger.error(`Falha ao restaurar permissões no Discord para ${user.id}: ${revErr.message}`);
        }
      }
      logger.error(`Falha ao remover participante/evento para ticket ${ticket.id}: ${err.message}`);
      throw err;
    }
  }

  /**
   * Obtém a lista de participantes de um ticket a partir da base de dados.
   * @param {number} ticketId
   * @param {string} [guildId]
   * @returns {Array<object>}
   */
  getMembers(ticketId, guildId = null) {
    return this.ticketMemberRepo.getMembers(ticketId, guildId);
  }

  /**
   * Verifica se um utilizador é participante de um ticket.
   * @param {number} ticketId
   * @param {string} userId
   * @param {string} [guildId]
   * @returns {boolean}
   */
  isMember(ticketId, userId, guildId = null) {
    return this.ticketMemberRepo.isMember(ticketId, userId, guildId);
  }
}

module.exports = new TicketMemberService();
module.exports.TicketMemberService = TicketMemberService;
