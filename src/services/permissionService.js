const { PermissionFlagsBits } = require('discord.js');

/**
 * Serviço responsável pela validação e construção de permissões no Discord.
 */
class PermissionService {
  /**
   * Verifica se um membro possui permissões de Administrador.
   * @param {import('discord.js').GuildMember} member
   * @returns {boolean}
   */
  isAdmin(member) {
    if (!member || !member.permissions) return false;
    return member.permissions.has(PermissionFlagsBits.Administrator);
  }

  /**
   * Verifica se o bot possui as permissões mínimas necessárias no servidor para gerir tickets.
   * @param {import('discord.js').Guild} guild
   * @returns {{ hasPermissions: boolean, missing: string[] }}
   */
  checkBotPermissions(guild) {
    const me = guild.members.me;
    if (!me) {
      return { hasPermissions: false, missing: ['Bot Member não encontrado na cache'] };
    }

    const required = [
      { flag: PermissionFlagsBits.ManageChannels, name: 'Gerir Canais (ManageChannels)' },
      { flag: PermissionFlagsBits.ViewChannel, name: 'Ver Canal (ViewChannel)' },
      { flag: PermissionFlagsBits.SendMessages, name: 'Enviar Mensagens (SendMessages)' },
      { flag: PermissionFlagsBits.EmbedLinks, name: 'Inserir Links (EmbedLinks)' },
      { flag: PermissionFlagsBits.ReadMessageHistory, name: 'Ver Histórico de Mensagens (ReadMessageHistory)' },
    ];

    const missing = [];
    for (const req of required) {
      if (!me.permissions.has(req.flag)) {
        missing.push(req.name);
      }
    }

    return {
      hasPermissions: missing.length === 0,
      missing,
    };
  }

  /**
   * Verifica se o bot possui as permissões necessárias numa categoria para criar canais de tickets.
   * Não faz chamada remota; calcula permissões efetivas em memória através de permissionsFor.
   * @param {import('discord.js').CategoryChannel} category
   * @param {import('discord.js').GuildMember} me
   * @returns {{ hasPermissions: boolean, missing: string[] }}
   */
  checkCategoryPermissions(category, me) {
    if (!category || typeof category.permissionsFor !== 'function') {
      return { hasPermissions: true, missing: [] };
    }

    if (!me) {
      return { hasPermissions: false, missing: ['Bot Member não encontrado na cache'] };
    }

    const perms = category.permissionsFor(me);
    if (!perms) {
      return { hasPermissions: false, missing: ['Permissões não calculáveis na categoria'] };
    }

    const required = [
      { flag: PermissionFlagsBits.ViewChannel, name: 'Ver Canal (ViewChannel)' },
      { flag: PermissionFlagsBits.ManageChannels, name: 'Gerir Canais (ManageChannels)' },
    ];

    const missing = [];
    for (const req of required) {
      if (!perms.has(req.flag)) {
        missing.push(req.name);
      }
    }

    return {
      hasPermissions: missing.length === 0,
      missing,
    };
  }

  /**
   * Constrói os PermissionOverwrites para um canal de ticket privado.
   * Regras:
   * - @everyone: nega ViewChannel
   * - autor: ViewChannel, SendMessages, ReadMessageHistory, AttachFiles, EmbedLinks
   * - equipa: mesmas do autor + ManageMessages
   * - bot: permissões estritamente necessárias (sem Administrator)
   * @param {object} params
   * @returns {Array<object>}
   */
  getTicketChannelOverwrites({ guild, creatorId, staffRoleId = null }) {
    const botId = guild.client.user.id;

    const overwrites = [
      // 1. @everyone: ocultar totalmente o canal
      {
        id: guild.roles.everyone.id,
        deny: [PermissionFlagsBits.ViewChannel],
      },
      // 2. Autor do ticket: acesso ao canal para comunicar
      {
        id: creatorId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks,
        ],
      },
      // 3. Bot do +1BOT: gerir o canal e mensagens
      {
        id: botId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.ManageChannels,
        ],
      },
    ];

    // 4. Cargo da equipa de atendimento (se configurado e válido)
    if (staffRoleId && guild.roles.cache.has(staffRoleId)) {
      overwrites.push({
        id: staffRoleId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.ManageMessages,
        ],
      });
    }

    return overwrites;
  }

  /**
   * Resolve e valida permissões de atendimento para um membro sobre um ticket.
   * Regras de autorização:
   * 1. Administrator sempre tem permissão (mesmo se o cargo tiver sido apagado).
   * 2. Membro com o cargo efetivo do departamento (com fallback para cargo global).
   * 3. O autor do ticket não pode assumir, libertar ou alterar estado/prioridade apenas por ser autor.
   * 4. Se o cargo tiver sido apagado, apenas Administrator pode intervir, com aviso claro.
   * 5. Se o cargo não estiver configurado, apenas Administrator pode intervir.
   * @param {object} params
   * @param {import('discord.js').GuildMember} params.member
   * @param {import('discord.js').Guild} params.guild
   * @param {object} [params.department]
   * @param {string} [params.defaultStaffRoleId]
   * @param {object} [params.ticket]
   * @returns {{ allowed: boolean, isAdmin: boolean, isStaff: boolean, warning?: string, error?: string, code?: string, staffRoleId?: string }}
   */
  resolveTicketStaffPermission({ member, guild, department = null, defaultStaffRoleId = null, ticket = null }) {
    if (!member) {
      return {
        allowed: false,
        isAdmin: false,
        isStaff: false,
        code: 'UNAUTHORIZED',
        error: 'Membro não identificado.',
      };
    }

    const isAdmin = this.isAdmin(member);

    // Resolver cargo com fallback: departamento -> global
    const staffRoleId = (department && department.staff_role_id) || defaultStaffRoleId || null;

    if (!staffRoleId) {
      if (isAdmin) {
        return { allowed: true, isAdmin: true, isStaff: true };
      }
      return {
        allowed: false,
        isAdmin: false,
        isStaff: false,
        code: 'STAFF_ROLE_NOT_CONFIGURED',
        error: 'O cargo da equipa de suporte não está configurado. Contacta um administrador.',
      };
    }

    // Verificar se o cargo ainda existe no servidor
    const roleExists = Boolean(guild && guild.roles && guild.roles.cache && guild.roles.cache.has(staffRoleId));
    if (!roleExists) {
      if (isAdmin) {
        return {
          allowed: true,
          isAdmin: true,
          isStaff: true,
          warning: 'O cargo da equipa de suporte configurado foi eliminado do servidor. Acesso concedido como Administrador.',
        };
      }
      return {
        allowed: false,
        isAdmin: false,
        isStaff: false,
        code: 'STAFF_ROLE_DELETED',
        error: 'O cargo da equipa de suporte configurado foi eliminado do servidor. Apenas um administrador pode intervir.',
      };
    }

    // Verificar se o membro possui o cargo
    let hasRole = false;
    if (member.roles) {
      if (member.roles.cache && typeof member.roles.cache.has === 'function') {
        hasRole = member.roles.cache.has(staffRoleId);
      } else if (Array.isArray(member.roles)) {
        hasRole = member.roles.includes(staffRoleId);
      }
    }

    if (hasRole || isAdmin) {
      return {
        allowed: true,
        isAdmin,
        isStaff: true,
        staffRoleId,
      };
    }

    return {
      allowed: false,
      isAdmin: false,
      isStaff: false,
      code: 'FORBIDDEN_STAFF_ONLY',
      error: 'Não possuis o cargo de suporte necessário para gerir este ticket.',
    };
  }

  /**
   * Constrói os PermissionOverwrites para um canal de ticket fechado/arquivado.
   * Regras:
   * - @everyone: nega ViewChannel
   * - autor: ViewChannel, ReadMessageHistory; nega SendMessages, AttachFiles, AddReactions, Threads
   * - participantes: ViewChannel, ReadMessageHistory; nega SendMessages, AttachFiles, AddReactions, Threads
   * - equipa: ViewChannel, ReadMessageHistory; nega SendMessages, AttachFiles, AddReactions (admins fazem bypass)
   * - bot: mantém permissões de gestão
   * @param {object} params
   * @param {import('discord.js').Guild} params.guild
   * @param {string} params.creatorId
   * @param {string} [params.staffRoleId]
   * @param {Array<string>} [params.participantIds]
   * @returns {Array<object>}
   */
  getClosedTicketChannelOverwrites({ guild, creatorId, staffRoleId = null, participantIds = [] }) {
    const botId = guild.client?.user?.id || guild.members?.me?.id;
    const everyoneId = guild.roles?.everyone?.id || guild.id;

    const overwrites = [
      // 1. @everyone: ocultar totalmente o canal
      {
        id: everyoneId,
        deny: [PermissionFlagsBits.ViewChannel],
      },
      // 2. Autor do ticket: somente leitura
      {
        id: creatorId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.ReadMessageHistory,
        ],
        deny: [
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.AddReactions,
          PermissionFlagsBits.CreatePublicThreads,
          PermissionFlagsBits.CreatePrivateThreads,
          PermissionFlagsBits.SendMessagesInThreads,
        ],
      },
      // 3. Bot do +1BOT: manter gestão total
      {
        id: botId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.ManageChannels,
          PermissionFlagsBits.ManageMessages,
        ],
      },
    ];

    // 4. Cargo da equipa: somente leitura
    if (staffRoleId && guild.roles?.cache?.has(staffRoleId)) {
      overwrites.push({
        id: staffRoleId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.ReadMessageHistory,
        ],
        deny: [
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.AddReactions,
        ],
      });
    }

    // 5. Participantes adicionais: somente leitura
    if (Array.isArray(participantIds)) {
      for (const pId of participantIds) {
        if (pId && pId !== creatorId && pId !== botId && pId !== staffRoleId) {
          overwrites.push({
            id: pId,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.ReadMessageHistory,
            ],
            deny: [
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.AttachFiles,
              PermissionFlagsBits.AddReactions,
              PermissionFlagsBits.CreatePublicThreads,
              PermissionFlagsBits.CreatePrivateThreads,
              PermissionFlagsBits.SendMessagesInThreads,
            ],
          });
        }
      }
    }

    return overwrites;
  }
}

module.exports = new PermissionService();
module.exports.PermissionService = PermissionService;
