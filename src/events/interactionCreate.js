const logger = require('../utils/logger');
let defaultTicketRepository = require('../repositories/ticketRepository');
let defaultTicketService = require('../services/ticketService');
let defaultTicketCloseService = require('../services/ticketCloseService');
let defaultPermissionService = require('../services/permissionService');
const { getTicketCreateModal, getTicketCloseModal } = require('../components/tickets/modals');
const {
  SELECT_DEPARTMENT,
  INPUT_SUBJECT,
  INPUT_DESCRIPTION,
  INPUT_REFERENCE,
  BUTTON_WAITING,
  BUTTON_CLAIM,
  BUTTON_RELEASE,
  BUTTON_CLOSE,
  MODAL_CLOSE,
  INPUT_CLOSE_REASON,
  INPUT_CLOSE_CONFIRM,
  SELECT_STATUS,
  SELECT_PRIORITY,
  parseModalCustomId,
  parsePositiveSafeInteger,
} = require('../utils/ticketCustomIds');
const {
  STATUS_LABELS,
  PRIORITY_LABELS,
} = require('../utils/ticketState');

module.exports = {
  name: 'interactionCreate',
  once: false,
  setDependencies({ ticketRepo, ticketSvc, ticketCloseSvc, permSvc }) {
    if (ticketRepo) defaultTicketRepository = ticketRepo;
    if (ticketSvc) defaultTicketService = ticketSvc;
    if (ticketCloseSvc) defaultTicketCloseService = ticketCloseSvc;
    if (permSvc) defaultPermissionService = permSvc;
  },
  resetDependencies() {
    defaultTicketRepository = require('../repositories/ticketRepository');
    defaultTicketService = require('../services/ticketService');
    defaultTicketCloseService = require('../services/ticketCloseService');
    defaultPermissionService = require('../services/permissionService');
  },

  async execute(interaction, client) {
    try {
      // 1. Comandos Slash
      if (interaction.isChatInputCommand()) {
        await handleSlashCommand(interaction, client);
        return;
      }

      // 2. Autocomplete
      if (interaction.isAutocomplete()) {
        await handleAutocomplete(interaction, client);
        return;
      }

      // 3. Menus de Seleção (Select Menus)
      if (interaction.isStringSelectMenu()) {
        await handleSelectMenu(interaction);
        return;
      }

      // 4. Submissão de Formulários (Modals)
      if (interaction.isModalSubmit()) {
        await handleModalSubmit(interaction);
        return;
      }

      // 5. Botões
      if (interaction.isButton()) {
        await handleButton(interaction);
        return;
      }
    } catch (unexpectedError) {
      logger.error(`Erro não tratado na interação: ${unexpectedError.stack || unexpectedError.message}`);
      await respondWithError(interaction, 'Ocorreu um erro inesperado ao processar o teu pedido.');
    }
  },
};

// ============================================
// TRATADORES ESPECÍFICOS
// ============================================

async function handleSlashCommand(interaction, client) {
  const command = client.commands.get(interaction.commandName);
  if (!command) {
    logger.warn(`Comando não encontrado: /${interaction.commandName}`);
    return;
  }

  try {
    logger.info(`Comando recebido: /${interaction.commandName} por ${interaction.user.tag}`);
    await command.execute(interaction);
  } catch (error) {
    logger.error(`Erro ao executar /${interaction.commandName}: ${error.message}`);
    await respondWithError(interaction, 'Ocorreu um erro ao executar este comando. Tenta novamente mais tarde.');
  }
}

async function handleAutocomplete(interaction, client) {
  const command = client.commands.get(interaction.commandName);
  if (command && typeof command.autocomplete === 'function') {
    try {
      await command.autocomplete(interaction);
    } catch (error) {
      logger.error(`Erro no autocomplete de /${interaction.commandName}: ${error.message}`);
    }
  }
}

async function handleSelectMenu(interaction) {
  if (interaction.customId === SELECT_DEPARTMENT) {
    const rawDeptId = interaction.values?.[0];
    const departmentId = parsePositiveSafeInteger(rawDeptId);

    if (departmentId === null) {
      return respondWithError(interaction, 'Departamento inválido selecionado.');
    }

    // Validar existência e estado na base de dados (SQLite é a fonte de verdade)
    const department = defaultTicketRepository.getDepartmentById(departmentId, interaction.guildId);
    if (!department || department.active !== 1) {
      return respondWithError(interaction, 'O departamento selecionado já não se encontra disponível.');
    }

    // Apresentar o modal de abertura de ticket
    const modal = getTicketCreateModal(department);
    await interaction.showModal(modal);
    return;
  }

  if (interaction.customId === SELECT_STATUS || interaction.customId === SELECT_PRIORITY) {
    await handleTicketSelect(interaction);
    return;
  }
}

async function handleModalSubmit(interaction) {
  const { isTicketModal, departmentId } = parseModalCustomId(interaction.customId);

  if (isTicketModal && departmentId) {
    // Adiar resposta para permitir tempo de criação de canais e transações
    await interaction.deferReply({ ephemeral: true });

    try {
      const subject = interaction.fields.getTextInputValue(INPUT_SUBJECT);
      const description = interaction.fields.getTextInputValue(INPUT_DESCRIPTION);

      let reference = null;
      try {
        reference = interaction.fields.getTextInputValue(INPUT_REFERENCE);
      } catch (_) {
        reference = null;
      }

      const result = await defaultTicketService.createTicket({
        guild: interaction.guild,
        user: interaction.user,
        departmentId,
        subject,
        description,
        reference,
      });

      await interaction.editReply({
        content: `✅ O teu ticket foi aberto com sucesso em <#${result.channel.id}>! (\`${result.formattedNumber}\`)`,
      });
    } catch (error) {
      logger.error(`Erro ao processar criação de ticket: ${error.stack || error.message}`);

      const publicErrorMap = {
        ACTIVE_TICKET_EXISTS: 'Já tens um ticket aberto neste servidor. Aguarda que seja atendido antes de criar outro.',
        COOLDOWN: error.message || 'Por favor aguarda alguns segundos antes de tentar abrir outro ticket.',
        CONCURRENT_REQUEST: 'Já tens um pedido de abertura de ticket em processamento. Aguarda alguns segundos.',
        STAFF_ROLE_NOT_CONFIGURED: 'O cargo da equipa de suporte não está configurado. Contacta um administrador.',
        STAFF_ROLE_NOT_FOUND: 'O cargo da equipa de suporte configurado foi eliminado do servidor. Contacta um administrador.',
        INSUFFICIENT_CATEGORY_PERMISSIONS: 'O bot não possui as permissões necessárias na categoria de tickets. Contacta um administrador.',
        TICKET_INITIALIZATION_FAILED: 'Não foi possível inicializar a conversa do ticket. O canal foi revertido. Tenta novamente mais tarde.',
      };

      const userFriendlyMessage = (error.code && publicErrorMap[error.code])
        ? publicErrorMap[error.code]
        : 'Ocorreu um erro interno ao processar o teu ticket. Por favor tenta novamente mais tarde ou contacta um administrador.';

      await interaction.editReply({
        content: `❌ **Aviso:** ${userFriendlyMessage}`,
      });
    }
  }
  if (interaction.customId === MODAL_CLOSE) {
    await interaction.deferReply({ ephemeral: true });

    try {
      const reason = interaction.fields.getTextInputValue(INPUT_CLOSE_REASON);
      const confirmText = interaction.fields.getTextInputValue(INPUT_CLOSE_CONFIRM);

      if (confirmText.trim() !== 'FECHAR') {
        await interaction.editReply({
          content: '❌ **Aviso:** Confirmação inválida. Precisas digitar exatamente `FECHAR`.',
        });
        return;
      }

      const ticket = defaultTicketRepository.getTicketByChannelId(interaction.channelId, interaction.guildId);
      const isAdmin = defaultPermissionService.isAdmin(interaction.member);

      const result = await defaultTicketCloseService.closeTicket({
        channelId: interaction.channelId,
        guildId: interaction.guildId,
        member: interaction.member,
        guild: interaction.guild,
        channel: interaction.channel,
        reason,
        adminOverride: isAdmin && ticket?.status !== 'resolved',
      });

      const msgCount = result.messageCount || 0;
      const hashShort = result.transcriptSha256 ? result.transcriptSha256.substring(0, 8) : 'N/A';

      await interaction.editReply({
        content: `✅ O ticket foi fechado e o canal arquivado em modo de leitura.\n📄 Mensagens arquivadas: \`${msgCount}\` (Hash: \`${hashShort}\`)`,
      });
    } catch (error) {
      logger.error(`Erro ao processar fecho de ticket (modal): ${error.stack || error.message}`);

      const publicErrorMap = {
        CONCURRENT_CLOSE: 'O fecho deste ticket já se encontra em processamento.',
        INVALID_TICKET_STATE: 'O ticket não se encontra no estado apropriado (Resolvido) ou já está fechado.',
        NOT_AUTHORIZED: 'Não tens autorização para fechar este ticket. Apenas o responsável, o autor (se aplicável) ou um administrador podem fazê-lo.',
        ARCHIVE_CATEGORY_NOT_FOUND: 'A categoria de arquivo configurada não existe.',
        INSUFFICIENT_ARCHIVE_PERMISSIONS: 'O bot não tem permissões para mover o canal para a categoria de arquivo.',
        ADMIN_OVERRIDE_REQUIRED: 'Apenas um administrador pode forçar o fecho de um ticket que não se encontre no estado Resolvido.',
        TICKET_NOT_RESOLVED: 'O ticket deve estar no estado Resolvido para ser fechado normalmente.',
        FORBIDDEN_NOT_CLAIMANT: 'Apenas o responsável pelo atendimento ou um administrador pode fechar o ticket.',
        TICKET_NOT_ACTIVE: 'Este ticket já se encontra fechado.',
        TICKET_NOT_FOUND: 'Este canal não corresponde a um ticket registado.'
      };

      const userFriendlyMessage = (error.code && publicErrorMap[error.code])
        ? publicErrorMap[error.code]
        : 'Ocorreu um erro interno ao fechar o ticket. Detalhes guardados no registo do sistema.';

      await interaction.editReply({
        content: `❌ **Aviso:** ${userFriendlyMessage}`,
      });
    }
    return;
  }
}

async function handleButton(interaction) {
  if (interaction.customId === BUTTON_WAITING) {
    await interaction.reply({
      content: '⏳ Este indicador é apenas informativo. A equipa de atendimento foi notificada.',
      ephemeral: true,
    });
    return;
  }

  if (interaction.customId === BUTTON_CLAIM || interaction.customId === BUTTON_RELEASE) {
    await handleTicketButton(interaction);
    return;
  }

  if (interaction.customId === BUTTON_CLOSE) {
    try {
      const channelId = interaction.channelId || interaction.channel?.id;
      const guildId = interaction.guildId || interaction.guild?.id;

      const ticket = defaultTicketRepository.getTicketByChannelId(channelId, guildId);
      const isAdmin = defaultPermissionService.isAdmin(interaction.member);

      // Valida contexto antes de abrir o modal
      await defaultTicketCloseService.prepareCloseContext({
        channelId,
        guildId,
        member: interaction.member,
        guild: interaction.guild,
        adminOverride: isAdmin && ticket?.status !== 'resolved',
      });

      const modal = getTicketCloseModal();
      await interaction.showModal(modal);
    } catch (error) {
      await handleComponentError(interaction, error);
    }
    return;
  }
}

async function handleTicketButton(interaction) {
  if (typeof interaction.deferUpdate === 'function') {
    try {
      await interaction.deferUpdate();
    } catch (deferErr) {
      logger.warn(`Falha ao adiar atualização no botão: ${deferErr.message}`);
    }
  }

  const channelId = interaction.channelId || interaction.channel?.id;
  const guildId = interaction.guildId || interaction.guild?.id;

  try {
    let result;
    let successMessage;

    if (interaction.customId === BUTTON_CLAIM) {
      result = defaultTicketService.claimTicket({
        channelId,
        guildId,
        member: interaction.member,
        guild: interaction.guild,
      });

      successMessage = result.alreadyClaimedBySelf
        ? 'ℹ️ Já és o responsável por este ticket.'
        : '✅ Assumiste o atendimento deste ticket com sucesso.';
    } else if (interaction.customId === BUTTON_RELEASE) {
      result = defaultTicketService.releaseTicket({
        channelId,
        guildId,
        member: interaction.member,
        guild: interaction.guild,
      });

      successMessage = '✅ O ticket foi libertado com sucesso e voltou à fila de espera.';
    }

    const visualRes = await defaultTicketService.updateTicketMessage(interaction, {
      ticket: result.ticket,
      department: result.department,
      settings: result.settings,
    });

    if (!visualRes.visualSuccess) {
      await sendComponentResponse(
        interaction,
        '⚠️ A operação foi guardada na base de dados, mas não foi possível atualizar o painel visual da mensagem.'
      );
      return;
    }

    await sendComponentResponse(interaction, successMessage);
  } catch (error) {
    await handleComponentError(interaction, error);
  }
}

async function handleTicketSelect(interaction) {
  if (typeof interaction.deferUpdate === 'function') {
    try {
      await interaction.deferUpdate();
    } catch (deferErr) {
      logger.warn(`Falha ao adiar atualização no select menu: ${deferErr.message}`);
    }
  }

  const channelId = interaction.channelId || interaction.channel?.id;
  const guildId = interaction.guildId || interaction.guild?.id;
  const selectedValue = interaction.values?.[0];

  try {
    let result;
    let successMessage;

    if (interaction.customId === SELECT_STATUS) {
      result = defaultTicketService.changeStatus({
        channelId,
        guildId,
        member: interaction.member,
        guild: interaction.guild,
        newStatus: selectedValue,
      });

      const statusLabel = STATUS_LABELS[selectedValue] || selectedValue;
      successMessage = result.unchanged
        ? `ℹ️ O ticket já se encontra no estado "${statusLabel}".`
        : `✅ Estado do ticket alterado para "${statusLabel}" com sucesso.`;
    } else if (interaction.customId === SELECT_PRIORITY) {
      result = defaultTicketService.changePriority({
        channelId,
        guildId,
        member: interaction.member,
        guild: interaction.guild,
        newPriority: selectedValue,
      });

      const priorityLabel = PRIORITY_LABELS[selectedValue] || selectedValue;
      successMessage = result.unchanged
        ? `ℹ️ O ticket já se encontra com a prioridade "${priorityLabel}".`
        : `✅ Prioridade do ticket alterada para "${priorityLabel}" com sucesso.`;
    }

    const visualRes = await defaultTicketService.updateTicketMessage(interaction, {
      ticket: result.ticket,
      department: result.department,
      settings: result.settings,
    });

    if (!visualRes.visualSuccess) {
      await sendComponentResponse(
        interaction,
        '⚠️ A operação foi guardada na base de dados, mas não foi possível atualizar o painel visual da mensagem.'
      );
      return;
    }

    await sendComponentResponse(interaction, successMessage);
  } catch (error) {
    await handleComponentError(interaction, error);
  }
}

const COMPONENT_ERROR_MAP = {
  TICKET_NOT_FOUND: 'Este canal não corresponde a um ticket ativo.',
  TICKET_NOT_ACTIVE: 'Este ticket já se encontra fechado.',
  ALREADY_CLAIMED_BY_OTHER: 'Este ticket já se encontra atribuído a outro membro da equipa.',
  FORBIDDEN_NOT_CLAIMANT: 'Apenas o responsável atual ou um administrador pode realizar esta ação.',
  FORBIDDEN_STAFF_ONLY: 'Não possuis o cargo de suporte necessário para gerir este ticket.',
  STAFF_ROLE_NOT_CONFIGURED: 'O cargo da equipa de suporte não está configurado. Contacta um administrador.',
  STAFF_ROLE_NOT_FOUND: 'O cargo da equipa de suporte configurado foi eliminado do servidor. Contacta um administrador.',
  STAFF_ROLE_DELETED: 'O cargo da equipa de suporte configurado foi eliminado do servidor. Apenas um administrador pode intervir.',
  TICKET_NOT_CLAIMED: 'O ticket precisa de estar atribuído antes de alterar o seu estado ou ser libertado.',
  CANNOT_RELEASE_RESOLVED: 'Um ticket no estado Resolvido não pode ser libertado sem ser reaberto previamente.',
  INVALID_STATUS_TRANSITION: 'Esta transição de estado não é permitida para o estado atual do ticket.',
  INVALID_PRIORITY: 'A prioridade selecionada é inválida.',
  CONCURRENT_MODIFICATION: 'Conflito de concorrência: o ticket foi modificado por outro membro. Tenta novamente.',
  INVALID_INTERACTION_CONTEXT: 'Esta ação só pode ser executada dentro de um canal de ticket válido.',
  UNAUTHORIZED: 'Não tens permissão para realizar esta operação.',
  ADMIN_OVERRIDE_REQUIRED: 'Apenas um administrador pode forçar o fecho de um ticket que não se encontre no estado Resolvido.',
  TICKET_NOT_RESOLVED: 'O ticket deve estar no estado Resolvido para ser fechado normalmente.',
};

async function handleComponentError(interaction, error) {
  logger.error(`Erro ao processar componente de ticket: ${error.stack || error.message}`);

  const userFriendlyMessage = (error.code && COMPONENT_ERROR_MAP[error.code])
    ? COMPONENT_ERROR_MAP[error.code]
    : 'Ocorreu um erro ao processar a operação no ticket. Tenta novamente mais tarde.';

  await sendComponentResponse(interaction, `❌ ${userFriendlyMessage}`);
}

async function sendComponentResponse(interaction, message) {
  const payload = {
    content: message,
    ephemeral: true,
  };

  try {
    if (interaction.deferred || interaction.replied) {
      if (typeof interaction.followUp === 'function') {
        await interaction.followUp(payload);
      } else if (typeof interaction.editReply === 'function') {
        await interaction.editReply(payload);
      }
    } else if (typeof interaction.reply === 'function') {
      await interaction.reply(payload);
    }
  } catch (err) {
    logger.error(`Não foi possível enviar resposta ao componente: ${err.message}`);
  }
}

async function respondWithError(interaction, message) {
  const payload = {
    content: `❌ ${message}`,
    ephemeral: true,
  };

  try {
    if (interaction.replied) {
      await interaction.followUp(payload);
    } else if (interaction.deferred) {
      await interaction.editReply(payload);
    } else {
      await interaction.reply(payload);
    }
  } catch (err) {
    logger.error(`Não foi possível enviar mensagem de erro à interação: ${err.message}`);
  }
}
