const { AttachmentBuilder, EmbedBuilder, ChannelType } = require('discord.js');
const ticketRepository = require('../repositories/ticketRepository');
const settingsRepository = require('../repositories/settingsRepository');
const ticketMemberRepository = require('../repositories/ticketMemberRepository');
const permissionService = require('./permissionService');
const transcriptService = require('./transcriptService');
const { formatClosedTicketChannelName } = require('../utils/ticketChannelName');
const logger = require('../utils/logger');

class TicketCloseService {
  constructor({
    ticketRepo = ticketRepository,
    settingsRepo = settingsRepository,
    ticketMemberRepo = ticketMemberRepository,
    permService = permissionService,
    transcriptSvc = transcriptService,
    log = logger,
  } = {}) {
    this.ticketRepo = ticketRepo;
    this.settingsRepo = settingsRepo;
    this.ticketMemberRepo = ticketMemberRepo;
    this.permissionService = permService;
    this.transcriptService = transcriptSvc;
    this.logger = log;
    this.closingLocks = new Set();
  }

  /**
   * Extrai parâmetros comuns de contexto.
   * @private
   */
  _extractParams(params) {
    if (!params || typeof params !== 'object') {
      const err = new Error('Parâmetros de fecho inválidos.');
      err.code = 'INVALID_CLOSE_CONTEXT';
      throw err;
    }
    const channelId = params.channelId || params.channel?.id;
    const guildId = params.guildId || params.guild?.id;
    const member = params.member;
    const guild = params.guild;
    const channel = params.channel;
    const reason = params.reason ? String(params.reason).trim() : null;
    const adminOverride = Boolean(params.adminOverride);
    const baseDir = params.baseDir || process.env.TRANSCRIPT_DIR || './data/transcripts';

    return { channelId, guildId, member, guild, channel, reason, adminOverride, baseDir };
  }

  /**
   * Valida autorização de fecho.
   * Regras:
   * 1. Ticket deve estar ativo.
   * 2. Se status não for 'resolved', exige Administrator ou adminOverride=true.
   * 3. Responsável atual ou Administrator; se não houver responsável, apenas Administrator.
   * @param {object} params
   * @returns {{ allowed: boolean, isAdmin: boolean, isClaimant: boolean }}
   */
  validateCloseAuthorization({ ticket, member, guild, department = null, defaultStaffRoleId = null, adminOverride = false }) {
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

    const isAdmin = this.permissionService.isAdmin(member);
    const isClaimant = Boolean(ticket.claimed_by && member && ticket.claimed_by === member.id);

    // Validação de responsável
    if (!isAdmin && !isClaimant) {
      if (!ticket.claimed_by) {
        const err = new Error('O ticket não possui responsável atribuído. Apenas um Administrador pode fechar diretamente.');
        err.code = 'FORBIDDEN_NOT_CLAIMANT';
        throw err;
      }
      const err = new Error('Apenas o responsável pelo atendimento ou um Administrador pode fechar o ticket.');
      err.code = 'FORBIDDEN_NOT_CLAIMANT';
      throw err;
    }

    // Validação de estado
    if (ticket.status !== 'resolved') {
      if (!isAdmin) {
        const err = new Error(`O ticket deve estar no estado Resolvido para ser fechado (estado atual: '${ticket.status}'). Apenas um Administrador pode fechar um ticket não resolvido com override.`);
        err.code = 'TICKET_NOT_RESOLVED';
        throw err;
      }

      if (!adminOverride) {
        const err = new Error(`Fecho administrativo forçado exigido para tickets não resolvidos (estado atual: '${ticket.status}').`);
        err.code = 'ADMIN_OVERRIDE_REQUIRED';
        throw err;
      }
    }

    return { allowed: true, isAdmin, isClaimant };
  }

  /**
   * Prepara o contexto de fecho, validando estado, existências e permissões.
   * @param {object} params
   * @returns {Promise<{ ticket: object, department: object, settings: object, members: Array<object>, auth: object }>}
   */
  async prepareCloseContext(params) {
    const { channelId, guildId, member, guild, adminOverride } = this._extractParams(params);

    if (!channelId || !guildId) {
      const err = new Error('Canal ou servidor não especificado.');
      err.code = 'INVALID_CLOSE_CONTEXT';
      throw err;
    }

    const ticket = this.ticketRepo.getTicketByChannelId(channelId, guildId);
    if (!ticket) {
      const err = new Error('Este canal não corresponde a um ticket registado.');
      err.code = 'TICKET_NOT_FOUND';
      throw err;
    }

    if (ticket.status === 'closed') {
      const err = new Error('Este ticket já se encontra fechado.');
      err.code = 'TICKET_NOT_ACTIVE';
      throw err;
    }

    const department = this.ticketRepo.getDepartmentById(ticket.department_id, guildId);
    const settings = this.settingsRepo.getGuildSettings(guildId) || {};
    const members = this.ticketMemberRepo.getMembers(ticket.id, guildId) || [];

    const auth = this.validateCloseAuthorization({
      ticket,
      member,
      guild,
      department,
      defaultStaffRoleId: settings.default_staff_role_id,
      adminOverride,
    });

    return {
      ticket,
      department,
      settings,
      members,
      auth,
    };
  }

  /**
   * Recolhe mensagens e gera a transcrição em memória / disco temporário.
   * @param {object} params
   * @returns {Promise<{ html: string, buffer: Buffer, sha256: string, fileName: string, relativePath: string, absolutePath: string, messageCount: number, truncated: boolean }>}
   */
  async generateAndPersistTranscript({
    ticket,
    guild,
    channel,
    creator,
    department,
    claimedBy,
    closedBy,
    closeReason,
    participants,
    messageLimit = 1000,
    baseDir = process.env.TRANSCRIPT_DIR || './data/transcripts',
  }) {
    const { messages, truncated, messageCount } = await this.transcriptService.fetchChannelMessages(channel, {
      limit: messageLimit,
    });

    const transcriptResult = await this.transcriptService.generateAndSaveTranscript({
      ticket,
      guild,
      channel,
      creator,
      department,
      claimedBy,
      closedBy,
      closeReason,
      participants,
      messages,
      truncated,
      baseDir,
    });

    return {
      ...transcriptResult,
      messageCount,
      truncated,
    };
  }

  /**
   * Executa compensação se o fecho falhar antes de finalizeClose.
   * @param {object} params
   */
  async compensateClose({
    ticketId,
    guildId,
    channel,
    origName = null,
    origParentId = null,
    parentMutated = false,
    nameMutated = false,
    origOverwrites = null,
    transcriptAbsolutePath = null,
  }) {
    this.logger.warn(`Executando compensação de fecho para o ticket ${ticketId}...`);

    // 1. Reverter nome do canal no Discord se alterado
    if (nameMutated && channel && origName && typeof channel.setName === 'function') {
      await channel.setName(origName, 'Compensação: reverter nome após falha no fecho').catch((err) => {
        this.logger.error(`Falha na compensação ao restaurar nome do canal: ${err.message}`);
      });
    }

    // 2. Reverter categoria do canal no Discord se movida
    if (parentMutated && channel && typeof channel.setParent === 'function') {
      await channel.setParent(origParentId, { lockPermissions: false }).catch((err) => {
        this.logger.error(`Falha na compensação ao restaurar categoria do canal: ${err.message}`);
      });
    }

    // 3. Reverter overwrites do canal no Discord se alterados
    if (origOverwrites && channel && channel.permissionOverwrites && typeof channel.permissionOverwrites.set === 'function') {
      await channel.permissionOverwrites.set(origOverwrites).catch((err) => {
        this.logger.error(`Falha na compensação ao restaurar permissões do canal: ${err.message}`);
      });
    }

    // 4. Remover ficheiro de transcrição temporário/persistido se criado
    if (transcriptAbsolutePath) {
      await this.transcriptService.deleteTranscriptFile(transcriptAbsolutePath).catch(() => {});
    }

    // 5. Abortar fecho no SQLite (limpa closing_started_at)
    if (ticketId && this.ticketRepo && typeof this.ticketRepo.abortClose === 'function') {
      try {
        this.ticketRepo.abortClose(ticketId, guildId);
      } catch (repoErr) {
        this.logger.error(`Falha ao abortar fecho do ticket ${ticketId} na BD: ${repoErr.message}`);
      }
    }
  }

  /**
   * Executa o fecho completo do ticket.
   * Fluxo:
   * 1. Valida autorização e estado.
   * 2. Bloqueio de concorrência e beginClose.
   * 3. Recolhe mensagens e gera transcrição segura.
   * 4. Bloqueia escrita no Discord, renomeia canal e move para categoria de arquivo se configurada.
   * 5. Finaliza no SQLite (status closed, hash, caminho relativo, metadados).
   * 6. Regista evento ticket_closed.
   * 7. Envia ficheiro ao canal de logs e DM best-effort ao autor.
   * @param {object} params
   * @returns {Promise<{ ticket: object, transcript: object, event: object }>}
   */
  async closeTicket(params) {
    const { channelId, guildId, member, guild, reason, adminOverride, baseDir } = this._extractParams(params);
    const channel = params.channel || (guild && guild.channels?.cache?.get(channelId));
    const lockKey = `${guildId}:${channelId}`;

    if (this.closingLocks.has(lockKey)) {
      const err = new Error('O fecho deste ticket já se encontra em processamento.');
      err.code = 'CONCURRENT_CLOSE';
      throw err;
    }

    // 1. Validar autorização e preparar contexto ANTES de qualquer efeito colateral
    const context = await this.prepareCloseContext({
      channelId,
      guildId,
      member,
      guild,
      adminOverride,
    });

    const ticket = context.ticket;
    const department = context.department;
    const settings = context.settings;
    const members = context.members;

    this.closingLocks.add(lockKey);

    // 2. Bloqueio no repositório
    try {
      this.ticketRepo.beginClose({
        ticketId: ticket.id,
        guildId,
        actorId: member.id,
      });
    } catch (beginErr) {
      this.closingLocks.delete(lockKey);
      throw beginErr;
    }

    // Rastreio para compensação
    let transcriptResult = null;
    let origName = channel?.name || null;
    let origParentId = channel?.parentId || null;
    let origOverwrites = null;
    let nameMutated = false;
    let parentMutated = false;

    if (channel && channel.permissionOverwrites?.cache) {
      origOverwrites = Array.from(channel.permissionOverwrites.cache.values());
    }

    try {
      // 3. Recolher mensagens e gerar transcrição segura
      // Obter utilizador autor
      let creatorUser = null;
      if (guild.client?.users?.fetch) {
        creatorUser = await guild.client.users.fetch(ticket.creator_id).catch(() => null);
      }
      const creatorData = {
        id: ticket.creator_id,
        tag: creatorUser?.tag || creatorUser?.username || ticket.creator_id,
        username: creatorUser?.username || 'Utilizador',
        avatarUrl: creatorUser?.displayAvatarURL ? creatorUser.displayAvatarURL() : null,
      };

      // Obter utilizador responsável
      let claimantUser = null;
      if (ticket.claimed_by && guild.client?.users?.fetch) {
        claimantUser = await guild.client.users.fetch(ticket.claimed_by).catch(() => null);
      }

      // Obter dados de participantes
      const participantUsers = [];
      for (const m of members) {
        participantUsers.push({
          id: m.user_id,
          tag: m.user_id,
          username: m.user_id,
        });
      }

      transcriptResult = await this.generateAndPersistTranscript({
        ticket,
        guild,
        channel,
        creator: creatorData,
        department,
        claimedBy: claimantUser ? { id: claimantUser.id, tag: claimantUser.tag, username: claimantUser.username } : null,
        closedBy: { id: member.id, tag: member.user?.tag || member.user?.username || member.id, username: member.user?.username || member.id },
        closeReason: reason,
        participants: participantUsers,
        baseDir,
      });

      // 4. Mutações de permissões no Discord (read-only)
      const staffRoleId = department?.staff_role_id || settings.default_staff_role_id || null;
      const participantIds = members.map((m) => m.user_id);
      const newOverwrites = this.permissionService.getClosedTicketChannelOverwrites({
        guild,
        creatorId: ticket.creator_id,
        staffRoleId,
        participantIds,
      });

      if (channel && channel.permissionOverwrites && typeof channel.permissionOverwrites.set === 'function') {
        await channel.permissionOverwrites.set(newOverwrites, `Ticket ${ticket.ticket_number} fechado por ${member.id}`);
      }

      // 5. Renomear canal para closed-00042-...
      const newChannelName = formatClosedTicketChannelName(ticket.ticket_number, creatorData.username);
      if (channel && typeof channel.setName === 'function') {
        await channel.setName(newChannelName, `Ticket ${ticket.ticket_number} fechado`);
        nameMutated = true;
      }

      // 6. Mover para categoria de arquivo se configurada e válida
      const archiveCategoryId = settings.archive_category_id;
      if (archiveCategoryId && channel && typeof channel.setParent === 'function') {
        const archiveCategory = guild.channels?.cache?.get(archiveCategoryId);
        if (archiveCategory && archiveCategory.type === ChannelType.GuildCategory) {
          const me = guild.members?.me;
          const catPerms = this.permissionService.checkCategoryPermissions(archiveCategory, me);
          if (catPerms.hasPermissions) {
            await channel.setParent(archiveCategoryId, { lockPermissions: false });
            parentMutated = true;
          } else {
            this.logger.warn(`Permissões insuficientes na categoria de arquivo ${archiveCategoryId}; mantendo categoria atual.`);
          }
        } else {
          this.logger.warn(`Categoria de arquivo ${archiveCategoryId} não encontrada ou inválida; mantendo categoria atual.`);
        }
      }

      // 7. Finalização atómica na Base de Dados
      let updatedTicket;
      try {
        updatedTicket = this.ticketRepo.finalizeClose({
          ticketId: ticket.id,
          guildId,
          closedBy: member.id,
          reason,
          transcriptPath: transcriptResult.relativePath,
          transcriptSha256: transcriptResult.sha256,
          transcriptMessageCount: transcriptResult.messageCount,
        });
      } catch (finalizeErr) {
        this.logger.error(`Falha ao finalizar fecho do ticket ${ticket.id} na BD: ${finalizeErr.message}`);
        throw finalizeErr;
      }

      // 8. Registar evento ticket_closed (APENAS após sucesso total de persistência e canal)
      const event = this.ticketRepo.createEvent({
        ticketId: ticket.id,
        guildId,
        eventType: 'ticket_closed',
        actorId: member.id,
        metadata: {
          ticketNumber: ticket.ticket_number,
          closedBy: member.id,
          reason,
          adminOverride: Boolean(adminOverride),
          transcriptPath: transcriptResult.relativePath,
          transcriptSha256: transcriptResult.sha256,
          messageCount: transcriptResult.messageCount,
        },
      });

      // 9. Ações pós-fecho (best-effort, falhas não reabrem o ticket)
      await this._sendPostCloseArtifacts({
        ticket: updatedTicket,
        guild,
        channel,
        settings,
        member,
        reason,
        transcriptResult,
      });

      return {
        ticket: updatedTicket,
        transcript: transcriptResult,
        event,
      };
    } catch (err) {
      // Compensar Discord, ficheiro e SQLite
      await this.compensateClose({
        ticketId: ticket.id,
        guildId,
        channel,
        origName,
        origParentId,
        parentMutated,
        nameMutated,
        origOverwrites,
        transcriptAbsolutePath: transcriptResult?.absolutePath,
      });

      throw err;
    } finally {
      this.closingLocks.delete(lockKey);
    }
  }

  /**
   * Envia os artefactos de fecho (embed no canal, logs e DM) de forma best-effort.
   * @private
   */
  async _sendPostCloseArtifacts({ ticket, guild, channel, settings, member, reason, transcriptResult }) {
    const formattedNumber = `TKT-${String(ticket.ticket_number).padStart(5, '0')}`;

    // A. Embed de fecho no próprio canal do ticket
    if (channel && typeof channel.send === 'function') {
      try {
        const closeEmbed = new EmbedBuilder()
          .setTitle(`🔒 Ticket Fechado: ${formattedNumber}`)
          .setColor(0xED4245)
          .setDescription('Este ticket foi concluído e arquivado. O canal encontra-se agora em modo de apenas leitura.')
          .addFields(
            { name: 'Fechado por', value: `<@${member.id}>`, inline: true },
            { name: 'Motivo', value: reason || 'Não especificado', inline: true },
            { name: 'Mensagens Gravadas', value: String(transcriptResult.messageCount), inline: true }
          )
          .setFooter({ text: '+1BOT • Arquivo de Tickets' })
          .setTimestamp();

        await channel.send({ embeds: [closeEmbed] });
      } catch (chanErr) {
        this.logger.warn(`Falha não bloqueante ao enviar aviso de fecho no canal: ${chanErr.message}`);
      }
    }

    // B. Enviar ficheiro HTML e registo para o canal de logs (se configurado)
    if (settings.log_channel_id) {
      try {
        let logChannel = guild.channels?.cache?.get(settings.log_channel_id);
        if (!logChannel && guild.channels?.fetch) {
          logChannel = await guild.channels.fetch(settings.log_channel_id).catch(() => null);
        }

        if (logChannel && logChannel.isTextBased && logChannel.isTextBased()) {
          const logAttachment = new AttachmentBuilder(transcriptResult.buffer, {
            name: transcriptResult.fileName,
          });

          const logEmbed = new EmbedBuilder()
            .setTitle(`📁 Ticket Fechado & Arquivado: ${formattedNumber}`)
            .setColor(0xED4245)
            .addFields(
              { name: 'Ticket', value: formattedNumber, inline: true },
              { name: 'Autor', value: `<@${ticket.creator_id}>`, inline: true },
              { name: 'Fechado por', value: `<@${member.id}>`, inline: true },
              { name: 'Motivo', value: reason || 'Não especificado', inline: false },
              { name: 'Total de Mensagens', value: String(transcriptResult.messageCount), inline: true },
              { name: 'SHA-256', value: `\`${transcriptResult.sha256.substring(0, 16)}...\``, inline: true }
            )
            .setFooter({ text: '+1BOT • Auditoria de Arquivo' })
            .setTimestamp();

          await logChannel.send({
            embeds: [logEmbed],
            files: [logAttachment],
          });
        }
      } catch (logErr) {
        this.logger.warn(`Falha não bloqueante ao enviar arquivo para o canal de logs: ${logErr.message}`);
      }
    }

    // C. Tentativa de DM para o autor (best-effort)
    try {
      if (guild.client?.users?.fetch) {
        const creatorUser = await guild.client.users.fetch(ticket.creator_id).catch(() => null);
        if (creatorUser && typeof creatorUser.send === 'function') {
          const dmAttachment = new AttachmentBuilder(transcriptResult.buffer, {
            name: transcriptResult.fileName,
          });

          const dmEmbed = new EmbedBuilder()
            .setTitle(`📁 Transcrição de Atendimento: ${formattedNumber}`)
            .setColor(0x5865F2)
            .setDescription(`O teu ticket **${formattedNumber}** no servidor **${guild.name || 'Discord'}** foi concluído e fechado. Em anexo encontras a transcrição completa do atendimento.`)
            .addFields(
              { name: 'Fechado por', value: `<@${member.id}>`, inline: true },
              { name: 'Motivo', value: reason || 'Não especificado', inline: true }
            )
            .setFooter({ text: '+1BOT • Suporte ao Cliente' })
            .setTimestamp();

          await creatorUser.send({
            embeds: [dmEmbed],
            files: [dmAttachment],
          }).catch((dmErr) => {
            this.logger.warn(`Não foi possível enviar DM ao autor do ticket ${ticket.id} (${ticket.creator_id}): ${dmErr.message}`);
          });
        }
      }
    } catch (dmEx) {
      this.logger.warn(`Falha não bloqueante ao tentar DM para autor: ${dmEx.message}`);
    }
  }
}

module.exports = new TicketCloseService();
module.exports.TicketCloseService = TicketCloseService;
