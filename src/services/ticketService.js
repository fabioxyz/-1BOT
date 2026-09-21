const { ChannelType, EmbedBuilder } = require('discord.js');
const ticketRepository = require('../repositories/ticketRepository');
const settingsRepository = require('../repositories/settingsRepository');
const ticketMemberRepository = require('../repositories/ticketMemberRepository');
const permissionService = require('./permissionService');
const { formatTicketChannelName } = require('../utils/ticketChannelName');
const { getTicketInitialActionRow } = require('../components/tickets/buttons');
const { buildTicketPanelPayload, buildTicketDetailsEmbed } = require('../components/tickets/ticketPanel');
const { resolveColor } = require('../components/tickets/selectMenus');
const logger = require('../utils/logger');

class TicketService {
  constructor(
    ticketRepo = ticketRepository,
    settingsRepo = settingsRepository,
    permService = permissionService,
    ticketMemberRepo = ticketMemberRepository
  ) {
    this.ticketRepo = ticketRepo;
    this.settingsRepo = settingsRepo;
    this.permissionService = permService;
    this.ticketMemberRepo = ticketMemberRepo;
    // Bloqueio de concorrência em memória por utilizador no mesmo servidor
    this.inFlightLocks = new Set();
    // Cooldown em memória: chave "guildId:userId" -> timestamp em ms
    this.cooldowns = new Map();
    this.cooldownSeconds = 5;
  }

  /**
   * Valida e inicia o processo seguro de criação de um ticket.
   * @param {object} params
   * @returns {Promise<{ ticket: object, channel: import('discord.js').TextChannel, formattedNumber: string }>}
   */
  async createTicket({
    guild,
    user,
    departmentId,
    subject,
    description,
    reference = null,
  }) {
    const lockKey = `${guild.id}:${user.id}`;

    // 1. Proteção de concorrência no processo
    if (this.inFlightLocks.has(lockKey)) {
      const err = new Error('Já tens um pedido de abertura de ticket em processamento. Aguarda alguns segundos.');
      err.code = 'CONCURRENT_REQUEST';
      throw err;
    }

    // 2. Cooldown
    const now = Date.now();
    const lastRequest = this.cooldowns.get(lockKey);
    if (lastRequest && (now - lastRequest) < (this.cooldownSeconds * 1000)) {
      const remaining = Math.ceil(((this.cooldownSeconds * 1000) - (now - lastRequest)) / 1000);
      const err = new Error(`Por favor aguarda ${remaining}s antes de tentar abrir outro ticket.`);
      err.code = 'COOLDOWN';
      throw err;
    }

    this.inFlightLocks.add(lockKey);
    this.cooldowns.set(lockKey, now);

    try {
      // 3. Validação dos campos no serviço
      const cleanSubject = (subject || '').trim();
      const cleanDescription = (description || '').trim();
      const cleanReference = reference ? reference.trim() : null;

      if (cleanSubject.length < 3 || cleanSubject.length > 100) {
        const err = new Error('O assunto deve conter entre 3 e 100 caracteres.');
        err.code = 'VALIDATION_ERROR';
        throw err;
      }

      if (cleanDescription.length < 10 || cleanDescription.length > 1000) {
        const err = new Error('A descrição deve conter entre 10 e 1000 caracteres.');
        err.code = 'VALIDATION_ERROR';
        throw err;
      }

      if (cleanReference && cleanReference.length > 100) {
        const err = new Error('A referência não pode exceder 100 caracteres.');
        err.code = 'VALIDATION_ERROR';
        throw err;
      }

      // 4. Verificar se utilizador já tem ticket ativo na base de dados
      const existingTicket = this.ticketRepo.getActiveTicketByUser(guild.id, user.id);
      if (existingTicket) {
        const err = new Error('Já tens um ticket ativo neste servidor. Aguarda que seja concluído.');
        err.code = 'ACTIVE_TICKET_EXISTS';
        err.ticket = existingTicket;
        throw err;
      }

      // 5. Validar departamento
      const department = this.ticketRepo.getDepartmentById(departmentId, guild.id);
      if (!department || department.active !== 1) {
        const err = new Error('O departamento selecionado não está disponível ou foi desativado.');
        err.code = 'DEPARTMENT_NOT_AVAILABLE';
        throw err;
      }

      // 6. Obter configurações do servidor
      const settings = this.settingsRepo.getGuildSettings(guild.id) || {};

      // 7. Resolução do cargo da equipa (obrigatório e bloqueante)
      const resolvedStaffRoleId = department.staff_role_id || settings.default_staff_role_id || null;

      if (!resolvedStaffRoleId) {
        const err = new Error('O cargo da equipa de suporte não está configurado. Contacta um administrador.');
        err.code = 'STAFF_ROLE_NOT_CONFIGURED';
        throw err;
      }

      if (resolvedStaffRoleId === guild.id || (guild.roles && guild.roles.everyone && resolvedStaffRoleId === guild.roles.everyone.id)) {
        const err = new Error('O cargo @everyone não pode ser utilizado como cargo da equipa de suporte por motivos de privacidade.');
        err.code = 'STAFF_ROLE_INVALID';
        throw err;
      }

      if (!guild.roles || !guild.roles.cache || !guild.roles.cache.has(resolvedStaffRoleId)) {
        const err = new Error('O cargo da equipa de suporte configurado foi eliminado do servidor. Contacta um administrador.');
        err.code = 'STAFF_ROLE_NOT_FOUND';
        throw err;
      }

      const validStaffRoleId = resolvedStaffRoleId;

      // Resolução com fallback da categoria e validação de permissões
      const resolvedCategoryId = department.category_id || settings.ticket_category_id || null;
      let validCategoryId = null;
      if (resolvedCategoryId) {
        const cat = guild.channels && guild.channels.cache && guild.channels.cache.get(resolvedCategoryId);
        if (cat && cat.type === ChannelType.GuildCategory) {
          validCategoryId = resolvedCategoryId;
          // Validar permissões efetivas na categoria antes de reservar o ticket
          const catPerms = this.permissionService.checkCategoryPermissions(cat, guild.members && guild.members.me);
          if (!catPerms.hasPermissions) {
            const err = new Error(`O bot não possui as permissões necessárias na categoria de tickets (${catPerms.missing.join(', ')}). Contacta um administrador.`);
            err.code = 'INSUFFICIENT_CATEGORY_PERMISSIONS';
            throw err;
          }
        } else {
          logger.warn(`Categoria ${resolvedCategoryId} não encontrada na guild ${guild.id}; criando ticket na raiz.`);
        }
      }

      // 8. Validar permissões do bot no servidor
      const botPerms = this.permissionService.checkBotPermissions(guild);
      if (!botPerms.hasPermissions) {
        const err = new Error(`O bot não possui as permissões necessárias: ${botPerms.missing.join(', ')}`);
        err.code = 'INSUFFICIENT_BOT_PERMISSIONS';
        throw err;
      }

      // 9. Reserva atómica na base de dados
      let ticket;
      try {
        ticket = this.ticketRepo.createTicketReservation({
          guildId: guild.id,
          creatorId: user.id,
          departmentId: department.id,
          subject: cleanSubject,
          description: cleanDescription,
          reference: cleanReference,
          priority: 'normal',
        });
      } catch (reserveErr) {
        if (reserveErr.code === 'ACTIVE_TICKET_EXISTS') {
          throw reserveErr;
        }
        logger.error(`Erro na reserva atómica do ticket: ${reserveErr.message}`);
        throw new Error('Falha ao reservar o ticket na base de dados.');
      }

      const formattedNumber = `TKT-${String(ticket.ticket_number).padStart(5, '0')}`;
      const channelName = formatTicketChannelName(ticket.ticket_number, user.username);
      const permissionOverwrites = this.permissionService.getTicketChannelOverwrites({
        guild,
        creatorId: user.id,
        staffRoleId: validStaffRoleId,
      });

      // 10. Criação segura do canal no Discord
      let channel;
      try {
        channel = await guild.channels.create({
          name: channelName,
          type: ChannelType.GuildText,
          parent: validCategoryId || undefined,
          permissionOverwrites,
          reason: `Ticket ${formattedNumber} criado para ${user.tag} (${user.id})`,
        });
      } catch (createErr) {
        // Rollback: não deixar ticket ativo órfão na base de dados
        this.ticketRepo.deleteTicket(ticket.id);
        logger.error(`Falha ao criar canal no Discord: ${createErr.message}`);
        const err = new Error('Não foi possível criar o canal do ticket. Verifica as permissões de criação de canais do bot.');
        err.code = 'CHANNEL_CREATION_FAILED';
        throw err;
      }

      // 11. Gravação do channel_id na base de dados
      try {
        this.ticketRepo.setTicketChannelId(ticket.id, channel.id);
      } catch (dbErr) {
        logger.error(`Falha ao associar channel_id ao ticket ${ticket.id}: ${dbErr.message}`);
        await this.compensateTicketCreation(ticket.id, channel, 'Falha ao registar o ticket na base de dados');
        const err = new Error('Falha crítica ao associar o canal ao registo do ticket.');
        err.code = 'DATABASE_ERROR';
        throw err;
      }

      // 12. Mensagem de controlo inicial no canal (usando buildTicketPanelPayload)
      let controlMessage;
      try {
        const panelPayload = buildTicketPanelPayload({
          ticket,
          department,
          settings,
        });

        controlMessage = await channel.send({
          content: `<@${user.id}>`,
          embeds: panelPayload.embeds,
          components: panelPayload.components,
        });
      } catch (sendErr) {
        logger.error(`Falha ao enviar mensagem inicial no canal ${channel.id}: ${sendErr.message}`);
        await this.compensateTicketCreation(ticket.id, channel, 'Falha ao enviar mensagem inicial do ticket');
        const err = new Error('Não foi possível inicializar a conversa do ticket. O canal foi revertido.');
        err.code = 'TICKET_INITIALIZATION_FAILED';
        throw err;
      }

      // 13. Gravar control_message_id com ticketId + guildId
      const controlMessageId = (controlMessage && controlMessage.id) ? String(controlMessage.id) : null;
      let setControlSuccess = false;
      if (controlMessageId) {
        try {
          setControlSuccess = Boolean(this.ticketRepo.setControlMessageId(ticket.id, controlMessageId, guild.id));
        } catch (dbErr) {
          logger.error(`Exceção ao gravar control_message_id para o ticket ${ticket.id}: ${dbErr.message}`);
          setControlSuccess = false;
        }
      }

      if (!setControlSuccess) {
        logger.error(`Falha ao gravar control_message_id para o ticket ${ticket.id}`);
        await this.compensateTicketCreation(ticket.id, channel, 'Falha ao associar mensagem de controlo');
        const err = new Error('Não foi possível inicializar o controlo do ticket. O canal foi revertido.');
        err.code = 'TICKET_INITIALIZATION_FAILED';
        throw err;
      }

      const updatedTicket = this.ticketRepo.getTicketById(ticket.id, guild.id) || {
        ...ticket,
        control_message_id: controlMessageId,
      };

      // 14. SÓ DEPOIS do sucesso de gravação: Registar evento de auditoria ticket_created
      this.ticketRepo.createEvent({
        ticketId: ticket.id,
        guildId: guild.id,
        eventType: 'ticket_created',
        actorId: user.id,
        metadata: {
          ticketNumber: ticket.ticket_number,
          channelId: channel.id,
          departmentId: department.id,
          departmentName: department.name,
          controlMessageId,
        },
      });

      // 15. SÓ DEPOIS do envio bem-sucedido: Enviar log de auditoria para o canal de logs (se configurado)
      if (settings.log_channel_id) {
        try {
          let logChannel = guild.channels.cache.get(settings.log_channel_id);
          if (!logChannel && guild.channels.fetch) {
            logChannel = await guild.channels.fetch(settings.log_channel_id).catch(() => null);
          }

          if (logChannel && logChannel.isTextBased()) {
            const logEmbed = new EmbedBuilder()
              .setTitle(`📋 Ticket Criado: ${formattedNumber}`)
              .setColor(0x57F287)
              .addFields(
                { name: 'Canal', value: `<#${channel.id}>`, inline: true },
                { name: 'Autor', value: `<@${user.id}> (\`${user.tag}\`)`, inline: true },
                { name: 'Departamento', value: department.name, inline: true },
                { name: 'Assunto', value: cleanSubject, inline: false }
              )
              .setFooter({ text: '+1BOT • Auditoria' })
              .setTimestamp();

            await logChannel.send({ embeds: [logEmbed] });
          }
        } catch (logErr) {
          // Uma falha no canal de logs não invalida o ticket criado
          logger.warn(`Falha não bloqueante ao enviar para o canal de logs: ${logErr.message}`);
        }
      }

      return {
        ticket: updatedTicket,
        channel,
        formattedNumber,
      };
    } finally {
      this.inFlightLocks.delete(lockKey);
    }
  }

  /**
   * Executa compensação eliminando o canal criado no Discord e removendo o ticket da base de dados.
   * @param {number} ticketId
   * @param {object} channel
   * @param {string} reason
   */
  async compensateTicketCreation(ticketId, channel, reason = 'Compensação do ticket') {
    if (channel && typeof channel.delete === 'function') {
      try {
        await channel.delete(reason);
      } catch (delErr) {
        logger.error(`Não foi possível apagar canal ${channel.id || 'desconhecido'} na compensação: ${delErr.message}`);
      }
    }
    if (ticketId && this.ticketRepo && typeof this.ticketRepo.deleteTicket === 'function') {
      try {
        this.ticketRepo.deleteTicket(ticketId);
      } catch (repoErr) {
        logger.error(`Não foi possível remover ticket ${ticketId} na base de dados: ${repoErr.message}`);
      }
    }
  }

  /**
   * Obtém o contexto completo do ticket a partir do canal e da guild.
   * Rejeita interações fora de canais de ticket válidos e ativos.
   * @param {string|object} channelIdOrParams
   * @param {string} [guildId]
   * @returns {{ ticket: object, department: object, settings: object }}
   */
  resolveContext(channelIdOrParams, guildId = null) {
    let resolvedChannelId;
    let resolvedGuildId = guildId;

    if (typeof channelIdOrParams === 'object' && channelIdOrParams !== null) {
      resolvedChannelId = channelIdOrParams.channelId || channelIdOrParams.channel?.id;
      resolvedGuildId = channelIdOrParams.guildId || channelIdOrParams.guild?.id || resolvedGuildId;
    } else {
      resolvedChannelId = channelIdOrParams;
    }

    if (!resolvedChannelId || !resolvedGuildId) {
      const err = new Error('Canal ou servidor não especificado.');
      err.code = 'INVALID_INTERACTION_CONTEXT';
      throw err;
    }

    const ticket = this.ticketRepo.getTicketByChannelId(resolvedChannelId, resolvedGuildId);
    if (!ticket) {
      const err = new Error('Este canal não corresponde a um ticket ativo.');
      err.code = 'TICKET_NOT_FOUND';
      throw err;
    }

    if (ticket.status === 'closed') {
      const err = new Error('Este ticket já se encontra fechado.');
      err.code = 'TICKET_NOT_ACTIVE';
      throw err;
    }

    const department = this.ticketRepo.getDepartmentById(ticket.department_id, resolvedGuildId);
    const settings = this.settingsRepo.getGuildSettings(resolvedGuildId) || {};

    return {
      ticket,
      department,
      settings,
    };
  }

  /**
   * Alias de conveniência para obter contexto a partir de uma interação Discord.
   * @param {object} interaction
   * @returns {{ ticket: object, department: object, settings: object }}
   */
  resolveContextFromInteraction(interaction) {
    return this.resolveContext(interaction);
  }

  /**
   * Valida autorização de staff/admin através de permissionService.
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
      const err = new Error(auth.error || 'Não possuis permissão para efetuar esta ação no ticket.');
      err.code = auth.code || 'FORBIDDEN_STAFF_ONLY';
      throw err;
    }

    return auth;
  }

  /**
   * Extrai channelId, guildId, member, guild de parâmetros ou interação.
   * @private
   */
  _extractContextParams(params) {
    if (!params || typeof params !== 'object') {
      const err = new Error('Parâmetros de contexto inválidos.');
      err.code = 'INVALID_INTERACTION_CONTEXT';
      throw err;
    }
    const channelId = params.channelId || params.channel?.id;
    const guildId = params.guildId || params.guild?.id;
    const member = params.member;
    const guild = params.guild;
    return { channelId, guildId, member, guild };
  }

  /**
   * Assume o atendimento de um ticket (claim).
   * @param {object} params
   * @returns {{ ticket: object, department: object, settings: object, alreadyClaimedBySelf: boolean, event: object|null }}
   */
  claimTicket(params) {
    const { channelId, guildId, member, guild } = this._extractContextParams(params);
    const context = this.resolveContext({ channelId, guildId });
    this.authorizeStaff({
      member,
      guild,
      department: context.department,
      defaultStaffRoleId: context.settings.default_staff_role_id,
      ticket: context.ticket,
    });

    const result = this.ticketRepo.claimTicket({
      ticketId: context.ticket.id,
      staffUserId: member.id,
      guildId,
    });

    return {
      ticket: result.ticket,
      department: context.department,
      settings: context.settings,
      alreadyClaimedBySelf: result.alreadyClaimedBySelf,
      event: result.event,
    };
  }

  /**
   * Liberta um ticket (release), voltando ao estado 'new' e removendo o responsável.
   * @param {object} params
   * @returns {{ ticket: object, department: object, settings: object, event: object }}
   */
  releaseTicket(params) {
    const { channelId, guildId, member, guild } = this._extractContextParams(params);
    const context = this.resolveContext({ channelId, guildId });
    const auth = this.authorizeStaff({
      member,
      guild,
      department: context.department,
      defaultStaffRoleId: context.settings.default_staff_role_id,
      ticket: context.ticket,
    });

    const result = this.ticketRepo.releaseTicket({
      ticketId: context.ticket.id,
      actorId: member.id,
      isAdmin: auth.isAdmin,
      guildId,
    });

    return {
      ticket: result.ticket,
      department: context.department,
      settings: context.settings,
      event: result.event,
    };
  }

  /**
   * Altera o estado do ticket validando a matriz estrita de transições.
   * @param {object} params
   * @param {string} [params.newStatus]
   * @returns {{ ticket: object, department: object, settings: object, unchanged: boolean, event: object|null }}
   */
  changeStatus(params) {
    const { channelId, guildId, member, guild } = this._extractContextParams(params);
    const newStatus = params.newStatus;
    const context = this.resolveContext({ channelId, guildId });
    const auth = this.authorizeStaff({
      member,
      guild,
      department: context.department,
      defaultStaffRoleId: context.settings.default_staff_role_id,
      ticket: context.ticket,
    });

    const result = this.ticketRepo.updateTicketStatus({
      ticketId: context.ticket.id,
      newStatus,
      actorId: member.id,
      isAdmin: auth.isAdmin,
      guildId,
    });

    return {
      ticket: result.ticket,
      department: context.department,
      settings: context.settings,
      unchanged: result.unchanged,
      event: result.event,
    };
  }

  /**
   * Altera a prioridade do ticket validando autorização de staff/admin.
   * @param {object} params
   * @param {string} [params.newPriority]
   * @returns {{ ticket: object, department: object, settings: object, unchanged: boolean, event: object|null }}
   */
  changePriority(params) {
    const { channelId, guildId, member, guild } = this._extractContextParams(params);
    const newPriority = params.newPriority;
    const context = this.resolveContext({ channelId, guildId });
    const auth = this.authorizeStaff({
      member,
      guild,
      department: context.department,
      defaultStaffRoleId: context.settings.default_staff_role_id,
      ticket: context.ticket,
    });

    const result = this.ticketRepo.updateTicketPriority({
      ticketId: context.ticket.id,
      newPriority,
      actorId: member.id,
      isStaffOrAdmin: auth.allowed,
      guildId,
    });

    return {
      ticket: result.ticket,
      department: context.department,
      settings: context.settings,
      unchanged: result.unchanged,
      event: result.event,
    };
  }

  /**
   * Constrói o payload atualizado do painel e edita a mensagem de controlo/interação.
   * Falha visual pós-persistência não reverte a base de dados, mas devolve indicação de falha.
   * @param {object} interaction
   * @param {object} context
   * @param {object} context.ticket
   * @param {object} [context.department]
   * @param {object} [context.settings]
   * @returns {Promise<{ visualSuccess: boolean, error?: Error }>}
   */
  async updateTicketMessage(interaction, { ticket, department = null, settings = null }) {
    try {
      const payload = buildTicketPanelPayload({ ticket, department, settings });
      if (interaction && interaction.message && typeof interaction.message.edit === 'function') {
        await interaction.message.edit(payload);
        return { visualSuccess: true };
      }
      if (interaction && typeof interaction.editReply === 'function' && interaction.deferred) {
        await interaction.editReply(payload);
        return { visualSuccess: true };
      }
      return { visualSuccess: false, error: new Error('Não foi possível aceder à mensagem para edição.') };
    } catch (visualErr) {
      logger.error(`Falha não bloqueante ao atualizar visualmente o painel do ticket ${ticket?.id}: ${visualErr.message}`);
      return { visualSuccess: false, error: visualErr };
    }
  }

  /**
   * Transfere um ticket para outro departamento com validações e compensação entre Discord e SQLite.
   * @param {object} params
   * @returns {Promise<{ ticket: object, oldDepartment: object, newDepartment: object, event: object }>}
   */
  async transferTicket(params) {
    const { channelId, guildId, member, guild } = this._extractContextParams(params);
    const channel = params.channel || (guild && guild.channels && guild.channels.cache && guild.channels.cache.get(channelId));
    const targetDeptId = Number(params.newDepartmentId);

    if (!targetDeptId || Number.isNaN(targetDeptId)) {
      const err = new Error('Departamento de destino inválido.');
      err.code = 'INVALID_DEPARTMENT';
      throw err;
    }

    const context = this.resolveContext({ channelId, guildId });
    const ticket = context.ticket;
    const oldDepartment = context.department;
    const settings = context.settings;

    // 1. Autorização: staff efetivo do departamento atual ou Administrator
    this.authorizeStaff({
      member,
      guild,
      department: oldDepartment,
      defaultStaffRoleId: settings.default_staff_role_id,
      ticket,
    });

    // 2. Destino deve existir, estar ativo, na mesma guild e ser diferente
    if (targetDeptId === ticket.department_id) {
      const err = new Error('O ticket já se encontra no departamento selecionado.');
      err.code = 'SAME_DEPARTMENT';
      throw err;
    }

    const newDepartment = this.ticketRepo.getDepartmentById(targetDeptId, guildId);
    if (!newDepartment || newDepartment.active !== 1) {
      const err = new Error('O departamento de destino não existe ou foi desativado.');
      err.code = 'DEPARTMENT_NOT_AVAILABLE';
      throw err;
    }

    // 3. Resolver cargos com fallback global
    const oldStaffRoleId = oldDepartment?.staff_role_id || settings.default_staff_role_id || null;
    const newStaffRoleId = newDepartment.staff_role_id || settings.default_staff_role_id || null;

    if (!newStaffRoleId) {
      const err = new Error('O departamento de destino não possui cargo de suporte configurado.');
      err.code = 'STAFF_ROLE_NOT_CONFIGURED';
      throw err;
    }

    if (newStaffRoleId === guild.id || (guild.roles?.everyone && newStaffRoleId === guild.roles.everyone.id)) {
      const err = new Error('O cargo @everyone não pode ser utilizado como cargo da equipa de suporte.');
      err.code = 'STAFF_ROLE_INVALID';
      throw err;
    }

    if (!guild.roles?.cache?.has(newStaffRoleId)) {
      const err = new Error('O cargo da equipa de suporte do departamento de destino foi eliminado do servidor.');
      err.code = 'STAFF_ROLE_NOT_FOUND';
      throw err;
    }

    const oldCategoryId = oldDepartment?.category_id || settings.ticket_category_id || null;
    const newCategoryId = newDepartment.category_id || settings.ticket_category_id || null;

    // 4. Validar permissões do bot na nova categoria antes de mutar
    if (newCategoryId) {
      const catChannel = guild.channels?.cache ? guild.channels.cache.get(newCategoryId) : null;
      if (!catChannel || catChannel.type !== ChannelType.GuildCategory) {
        const err = new Error('A categoria de destino configurada não foi encontrada no servidor.');
        err.code = 'CATEGORY_NOT_FOUND';
        throw err;
      }
      const catPerms = this.permissionService.checkCategoryPermissions(catChannel, guild.members?.me);
      if (!catPerms.hasPermissions) {
        const err = new Error(`O bot não possui as permissões necessárias na nova categoria (${catPerms.missing.join(', ')}).`);
        err.code = 'INSUFFICIENT_CATEGORY_PERMISSIONS';
        throw err;
      }
    }

    // 5. Mutações no Discord com rastreio de estado para compensação
    const origParentId = channel?.parentId || null;
    let parentMutated = false;
    let oldRoleRemoved = false;
    let newRoleAdded = false;

    try {
      // a) Atualizar channel parent se categoria mudar
      if (channel && typeof channel.setParent === 'function') {
        const needsParentUpdate = (newCategoryId && origParentId !== newCategoryId) || (!newCategoryId && origParentId !== null);
        if (needsParentUpdate) {
          await channel.setParent(newCategoryId || null, { lockPermissions: false });
          parentMutated = true;
        }
      }

      // b) Remover overwrite do cargo antigo somente se diferente e não for necessário por outra razão
      if (channel && channel.permissionOverwrites) {
        if (oldStaffRoleId && oldStaffRoleId !== newStaffRoleId && typeof channel.permissionOverwrites.delete === 'function') {
          await channel.permissionOverwrites.delete(oldStaffRoleId);
          oldRoleRemoved = true;
        }

        // c) Adicionar overwrite do novo staff role (preservando autor, bot e participantes)
        if (typeof channel.permissionOverwrites.edit === 'function') {
          await channel.permissionOverwrites.edit(newStaffRoleId, {
            ViewChannel: true,
            SendMessages: true,
            ReadMessageHistory: true,
            AttachFiles: true,
            EmbedLinks: true,
            ManageMessages: true,
          });
          newRoleAdded = true;
        }
      }
    } catch (discordErr) {
      logger.error(`Falha nas mutações do Discord durante a transferência: ${discordErr.message}`);
      if (parentMutated && channel && typeof channel.setParent === 'function') {
        await channel.setParent(origParentId, { lockPermissions: false }).catch(() => {});
      }
      if (newRoleAdded && channel?.permissionOverwrites?.delete) {
        await channel.permissionOverwrites.delete(newStaffRoleId).catch(() => {});
      }
      if (oldRoleRemoved && channel?.permissionOverwrites?.edit) {
        await channel.permissionOverwrites.edit(oldStaffRoleId, {
          ViewChannel: true,
          SendMessages: true,
          ReadMessageHistory: true,
          AttachFiles: true,
          EmbedLinks: true,
          ManageMessages: true,
        }).catch(() => {});
      }
      const err = new Error('Falha ao atualizar as permissões e categoria do canal no Discord.');
      err.code = 'DISCORD_MUTATION_FAILED';
      throw err;
    }

    // 6. Atualizar department_id no SQLite com proteção de concorrência/guild
    let updatedTicket;
    try {
      updatedTicket = this.ticketRepo.transferDepartment({
        ticketId: ticket.id,
        newDepartmentId: newDepartment.id,
        guildId,
        oldDepartmentId: ticket.department_id,
      });
    } catch (dbErr) {
      // Compensação: restaurar Discord ao estado anterior
      logger.error(`Falha ao persistir transferência na BD para ticket ${ticket.id}: ${dbErr.message}`);
      if (parentMutated && channel && typeof channel.setParent === 'function') {
        await channel.setParent(origParentId, { lockPermissions: false }).catch(() => {});
      }
      if (newRoleAdded && channel?.permissionOverwrites?.delete) {
        await channel.permissionOverwrites.delete(newStaffRoleId).catch(() => {});
      }
      if (oldRoleRemoved && channel?.permissionOverwrites?.edit) {
        await channel.permissionOverwrites.edit(oldStaffRoleId, {
          ViewChannel: true,
          SendMessages: true,
          ReadMessageHistory: true,
          AttachFiles: true,
          EmbedLinks: true,
          ManageMessages: true,
        }).catch(() => {});
      }
      throw dbErr;
    }

    // 7. Atualizar painel após sucesso
    if (channel) {
      try {
        const panelPayload = buildTicketPanelPayload({
          ticket: updatedTicket,
          department: newDepartment,
          settings,
        });
        let controlMessage = null;
        if (updatedTicket.control_message_id && channel.messages?.fetch) {
          controlMessage = await channel.messages.fetch(updatedTicket.control_message_id).catch(() => null);
        }
        if (controlMessage && typeof controlMessage.edit === 'function') {
          await controlMessage.edit(panelPayload);
        }
      } catch (panelErr) {
        logger.warn(`Falha não bloqueante ao atualizar painel visual após transferência: ${panelErr.message}`);
      }
    }

    // 8. Só registar ticket_transferred quando tudo ficar consistente
    const event = this.ticketRepo.createEvent({
      ticketId: ticket.id,
      guildId,
      eventType: 'ticket_transferred',
      actorId: member.id,
      metadata: {
        oldDepartmentId: oldDepartment.id,
        newDepartmentId: newDepartment.id,
        oldDepartmentName: oldDepartment.name,
        newDepartmentName: newDepartment.name,
        oldStaffRoleId,
        newStaffRoleId,
        oldCategoryId,
        newCategoryId,
      },
    });

    return {
      ticket: updatedTicket,
      oldDepartment,
      newDepartment,
      event,
    };
  }

  /**
   * Obtém os detalhes completos do ticket validando autorização (autor, participante, staff ou admin).
   * @param {object} params
   * @returns {Promise<{ ticket: object, department: object, settings: object, members: Array<object>, recentEvents: Array<object>, embed: import('discord.js').EmbedBuilder }>}
   */
  async getTicketDetails(params) {
    const { channelId, guildId, member, guild } = this._extractContextParams(params);
    const context = this.resolveContext({ channelId, guildId });
    const ticket = context.ticket;
    const department = context.department;
    const settings = context.settings;

    // Verificar autorização: autor, participante, staff do departamento atual ou admin
    const isAuthor = (member.id === ticket.creator_id);
    const isParticipant = this.ticketMemberRepo.isMember(ticket.id, member.id, guildId);
    const auth = this.permissionService.resolveTicketStaffPermission({
      member,
      guild,
      department,
      defaultStaffRoleId: settings.default_staff_role_id,
      ticket,
    });
    const isStaffOrAdmin = auth.allowed;

    if (!isAuthor && !isParticipant && !isStaffOrAdmin) {
      const err = new Error('Não possuis permissão para consultar os detalhes deste ticket.');
      err.code = 'FORBIDDEN';
      throw err;
    }

    const members = this.ticketMemberRepo.getMembers(ticket.id, guildId);
    const recentEvents = this.ticketRepo.getRecentEventsByTicket(ticket.id, 5, guildId);

    const embed = buildTicketDetailsEmbed({
      ticket,
      department,
      settings,
      members,
      recentEvents,
    });

    return {
      ticket,
      department,
      settings,
      members,
      recentEvents,
      embed,
    };
  }

  /**
   * Reconstitui o painel a partir da base de dados e atualiza a mensagem de controlo no canal.
   * Não emite auditoria ruidosa para refresh visual.
   * @param {object} params
   * @returns {Promise<{ ticket: object, department: object, settings: object }>}
   */
  async refreshTicketPanel(params) {
    const { channelId, guildId, member, guild } = this._extractContextParams(params);
    const channel = params.channel || (guild && guild.channels && guild.channels.cache && guild.channels.cache.get(channelId));
    const context = this.resolveContext({ channelId, guildId });
    const ticket = context.ticket;
    const department = context.department;
    const settings = context.settings;

    // Autorização: staff efetivo ou Administrador
    this.authorizeStaff({
      member,
      guild,
      department,
      defaultStaffRoleId: settings.default_staff_role_id,
      ticket,
    });

    if (!ticket.control_message_id) {
      const err = new Error('Mensagem de controlo do painel não identificada na base de dados.');
      err.code = 'CONTROL_MESSAGE_NOT_FOUND';
      throw err;
    }

    if (!channel || !channel.messages || typeof channel.messages.fetch !== 'function') {
      const err = new Error('Canal inacessível para atualização do painel.');
      err.code = 'CHANNEL_NOT_ACCESSIBLE';
      throw err;
    }

    let controlMessage;
    try {
      controlMessage = await channel.messages.fetch(ticket.control_message_id);
    } catch (fetchErr) {
      logger.error(`Não foi possível encontrar a mensagem de controlo ${ticket.control_message_id}: ${fetchErr.message}`);
      const err = new Error('A mensagem de controlo original do painel já não existe ou está inacessível.');
      err.code = 'CONTROL_MESSAGE_NOT_FOUND';
      throw err;
    }

    if (!controlMessage || typeof controlMessage.edit !== 'function') {
      const err = new Error('A mensagem de controlo original do painel já não existe ou está inacessível.');
      err.code = 'CONTROL_MESSAGE_NOT_FOUND';
      throw err;
    }

    const payload = buildTicketPanelPayload({
      ticket,
      department,
      settings,
    });

    await controlMessage.edit(payload);

    return {
      ticket,
      department,
      settings,
    };
  }
}

module.exports = new TicketService();
module.exports.TicketService = TicketService;
