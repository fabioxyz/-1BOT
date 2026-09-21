const { SlashCommandBuilder } = require('discord.js');
const ticketRepository = require('../repositories/ticketRepository');
const ticketService = require('../services/ticketService');
const ticketMemberService = require('../services/ticketMemberService');
const ticketOrderingService = require('../services/ticketOrderingService');
const { parsePositiveSafeInteger } = require('../utils/ticketCustomIds');
const logger = require('../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('Comandos contextuais para gestão do ticket atual')
    .setDMPermission(false)
    // 1. /ticket transferir departamento:<autocomplete>
    .addSubcommand((subcommand) =>
      subcommand
        .setName('transferir')
        .setDescription('Transfere o ticket para outro departamento')
        .addStringOption((opt) =>
          opt
            .setName('departamento')
            .setDescription('Departamento de destino')
            .setRequired(true)
            .setAutocomplete(true)
        )
    )
    // 2. /ticket participante-adicionar utilizador:<user>
    .addSubcommand((subcommand) =>
      subcommand
        .setName('participante-adicionar')
        .setDescription('Adiciona um participante ao ticket')
        .addUserOption((opt) =>
          opt
            .setName('utilizador')
            .setDescription('Utilizador a adicionar ao ticket')
            .setRequired(true)
        )
    )
    // 3. /ticket participante-remover utilizador:<user>
    .addSubcommand((subcommand) =>
      subcommand
        .setName('participante-remover')
        .setDescription('Remove um participante do ticket')
        .addUserOption((opt) =>
          opt
            .setName('utilizador')
            .setDescription('Utilizador a remover do ticket')
            .setRequired(true)
        )
    )
    // 4. /ticket detalhes
    .addSubcommand((subcommand) =>
      subcommand
        .setName('detalhes')
        .setDescription('Exibe os detalhes completos e histórico do ticket')
    )
    // 5. /ticket atualizar
    .addSubcommand((subcommand) =>
      subcommand
        .setName('atualizar')
        .setDescription('Atualiza manualmente o painel de controlo do ticket')
    ),

  /**
   * Fornece autocomplete dos departamentos ativos da guild para o comando transferir,
   * excluindo o departamento atual do ticket quando invocado no canal do ticket.
   * @param {import('discord.js').AutocompleteInteraction} interaction
   */
  async autocomplete(interaction) {
    try {
      const focusedOption = interaction.options.getFocused(true);
      if (focusedOption.name !== 'departamento') return;

      const focusedValue = (focusedOption.value || '').trim().toLowerCase();
      const guildId = interaction.guildId;
      if (!guildId) {
        await interaction.respond([]);
        return;
      }

      // Departamentos ativos na guild
      let departments = ticketRepository.getDepartmentsByGuild(guildId, true);

      // Tentar identificar o ticket atual pelo canal da interação
      const currentTicket = ticketRepository.getTicketByChannelId(interaction.channelId, guildId);
      if (currentTicket && currentTicket.department_id) {
        departments = departments.filter((d) => d.id !== currentTicket.department_id);
      }

      // Filtrar com base no que o utilizador digitou
      const filtered = departments
        .filter((d) => d.name.toLowerCase().includes(focusedValue))
        .slice(0, 25);

      await interaction.respond(
        filtered.map((d) => ({
          name: `${d.emoji ? d.emoji + ' ' : ''}${d.name}`.slice(0, 100),
          value: String(d.id),
        }))
      );
    } catch (err) {
      logger.error(`Erro no autocomplete de /ticket transferir: ${err.message}`);
      try {
        await interaction.respond([]);
      } catch (_) {}
    }
  },

  /**
   * Executa os subcomandos de /ticket garantindo que ocorrem num canal de ticket ativo.
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   */
  async execute(interaction) {
    if (!interaction.guildId || !interaction.guild) {
      await interaction.reply({
        content: '❌ Este comando só pode ser utilizado dentro de um servidor.',
        ephemeral: true,
      });
      return;
    }

    const subcommand = interaction.options.getSubcommand();

    try {
      if (subcommand === 'transferir') {
        await handleTransfer(interaction);
      } else if (subcommand === 'participante-adicionar') {
        await handleAddParticipant(interaction);
      } else if (subcommand === 'participante-remover') {
        await handleRemoveParticipant(interaction);
      } else if (subcommand === 'detalhes') {
        await handleDetails(interaction);
      } else if (subcommand === 'atualizar') {
        await handleRefresh(interaction);
      } else {
        await interaction.reply({
          content: '❌ Subcomando desconhecido.',
          ephemeral: true,
        });
      }
    } catch (error) {
      logger.error(`Erro ao executar /ticket ${subcommand}: ${error.message}`);
      await respondSafelyWithError(interaction, error);
    }
  },
};

// ============================================
// HANDLERS DOS SUBCOMANDOS
// ============================================

async function handleTransfer(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const rawDept = interaction.options.getString('departamento', true);
  let deptId = parsePositiveSafeInteger(rawDept);

  // Fallback: se o utilizador escreveu o nome do departamento
  if (deptId === null) {
    const found = ticketRepository.getDepartmentByName(interaction.guildId, rawDept, true);
    if (found) {
      deptId = found.id;
    }
  }

  if (deptId === null) {
    await interaction.editReply({
      content: '❌ Departamento de destino inválido. Por favor seleciona uma das opções da lista.',
      allowedMentions: { parse: [] },
    });
    return;
  }

  const result = await ticketService.transferTicket({
    channelId: interaction.channelId,
    guildId: interaction.guildId,
    member: interaction.member,
    guild: interaction.guild,
    channel: interaction.channel,
    newDepartmentId: deptId,
  });

  await interaction.editReply({
    content: `✅ Ticket transferido com sucesso para o departamento **${result.newDepartment.name}**!`,
    allowedMentions: { parse: [] },
  });
}

async function handleAddParticipant(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const targetUser = interaction.options.getUser('utilizador', true);
  const context = ticketService.resolveContext({
    channelId: interaction.channelId,
    guildId: interaction.guildId,
  });

  const result = await ticketMemberService.addParticipant({
    guild: interaction.guild,
    channel: interaction.channel,
    ticket: context.ticket,
    user: targetUser,
    actorMember: interaction.member,
    department: context.department,
    settings: context.settings,
  });

  if (result.alreadyMember) {
    await interaction.editReply({
      content: `ℹ️ O utilizador <@${targetUser.id}> já é participante deste ticket.`,
      allowedMentions: { parse: [] },
    });
    return;
  }

  await interaction.editReply({
    content: `✅ Participante <@${targetUser.id}> adicionado com sucesso ao ticket!`,
    allowedMentions: { parse: [] },
  });
}

async function handleRemoveParticipant(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const targetUser = interaction.options.getUser('utilizador', true);
  const context = ticketService.resolveContext({
    channelId: interaction.channelId,
    guildId: interaction.guildId,
  });

  const result = await ticketMemberService.removeParticipant({
    guild: interaction.guild,
    channel: interaction.channel,
    ticket: context.ticket,
    user: targetUser,
    actorMember: interaction.member,
    department: context.department,
    settings: context.settings,
  });

  if (result.notMember) {
    await interaction.editReply({
      content: `ℹ️ O utilizador <@${targetUser.id}> não é participante deste ticket.`,
      allowedMentions: { parse: [] },
    });
    return;
  }

  await interaction.editReply({
    content: `✅ Participante <@${targetUser.id}> removido com sucesso do ticket!`,
    allowedMentions: { parse: [] },
  });
}

async function handleDetails(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const result = await ticketService.getTicketDetails({
    channelId: interaction.channelId,
    guildId: interaction.guildId,
    member: interaction.member,
    guild: interaction.guild,
  });

  await interaction.editReply({
    embeds: [result.embed],
    allowedMentions: { parse: [] },
  });
}

async function handleRefresh(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const result = await ticketService.refreshTicketPanel({
    channelId: interaction.channelId,
    guildId: interaction.guildId,
    member: interaction.member,
    guild: interaction.guild,
    channel: interaction.channel,
  });

  let orderMessage = '';
  const categoryId = interaction.channel?.parentId || result.department?.category_id || result.settings?.ticket_category_id;

  if (categoryId) {
    const orderRes = await ticketOrderingService.orderCategoryTickets(interaction.guild, categoryId);
    if (!orderRes.success) {
      orderMessage = '\n⚠️ O painel foi atualizado, mas não foi possível reorganizar os canais visualmente.';
    } else if (orderRes.changes > 0) {
      orderMessage = '\n🔄 A fila de tickets na categoria foi reorganizada.';
    } else {
      orderMessage = '\nℹ️ A ordem dos tickets já se encontra correta.';
    }
  }

  await interaction.editReply({
    content: `✅ Painel do ticket atualizado com sucesso a partir da base de dados!${orderMessage}`,
    allowedMentions: { parse: [] },
  });
}

/**
 * Responde com mensagem amigável e segura, sem vazar stack trace nem comandos SQL.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {Error} error
 */
async function respondSafelyWithError(interaction, error) {
  const errorMap = {
    TICKET_NOT_FOUND: 'Este canal não corresponde a um ticket ativo.',
    TICKET_NOT_ACTIVE: 'Este ticket já se encontra fechado.',
    FORBIDDEN: 'Não possuis permissão para consultar os detalhes deste ticket.',
    FORBIDDEN_STAFF_ONLY: 'Apenas membros da equipa de suporte ou administradores podem executar esta ação.',
    SAME_DEPARTMENT: 'O ticket já pertence ao departamento selecionado.',
    DEPARTMENT_NOT_AVAILABLE: 'O departamento selecionado não existe ou não se encontra disponível.',
    STAFF_ROLE_NOT_CONFIGURED: 'O cargo da equipa de suporte não está configurado. Contacta um administrador.',
    STAFF_ROLE_NOT_FOUND: 'O cargo da equipa de suporte foi eliminado do servidor. Contacta um administrador.',
    STAFF_ROLE_INVALID: 'O cargo da equipa de suporte é inválido.',
    CATEGORY_NOT_FOUND: 'A categoria de destino configurada não foi encontrada no servidor.',
    INSUFFICIENT_CATEGORY_PERMISSIONS: error.message,
    CANNOT_ADD_BOT: 'Não é possível adicionar bots como participantes do ticket.',
    CANNOT_ADD_CREATOR: 'O autor do ticket já possui acesso permanente e não pode ser adicionado como participante.',
    CANNOT_REMOVE_CREATOR: 'O autor do ticket possui acesso permanente e não pode ser removido.',
    INVALID_PARTICIPANT: 'Utilizador inválido para adicionar ao ticket.',
    MAX_PARTICIPANTS_REACHED: 'O limite máximo de 10 participantes adicionais por ticket foi atingido.',
    CONTROL_MESSAGE_NOT_FOUND: 'A mensagem de controlo original do painel já não existe ou está inacessível.',
    CHANNEL_NOT_ACCESSIBLE: 'Canal inacessível para atualização do painel.',
    DISCORD_MUTATION_FAILED: 'Não foi possível atualizar as permissões do canal no Discord.',
    CONCURRENT_MODIFICATION: 'Operação cancelada devido a concorrência. Tenta novamente.',
  };

  const safeMessage = errorMap[error.code] || 'Ocorreu um erro ao processar a operação no ticket.';

  const payload = {
    content: `❌ ${safeMessage}`,
    ephemeral: true,
    allowedMentions: { parse: [] },
  };

  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(payload);
    } else {
      await interaction.reply(payload);
    }
  } catch (replyErr) {
    logger.error(`Falha ao responder com erro à interação: ${replyErr.message}`);
  }
}
