const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  EmbedBuilder,
} = require('discord.js');
const {
  BUTTON_CLAIM,
  BUTTON_RELEASE,
  BUTTON_CLOSE,
  SELECT_STATUS,
  SELECT_PRIORITY,
} = require('../../utils/ticketCustomIds');
const {
  TICKET_STATUS,
  TICKET_PRIORITY,
  ALLOWED_STATUS_TRANSITIONS,
  STATUS_LABELS,
  PRIORITY_LABELS,
} = require('../../utils/ticketState');
const { resolveColor } = require('./selectMenus');

/**
 * Formata o número sequencial do ticket com prefixo e padding de 5 dígitos (ex.: TKT-00001).
 * @param {number|string} num
 * @returns {string}
 */
function formatTicketNumber(num) {
  return `TKT-${String(num).padStart(5, '0')}`;
}

/**
 * Constrói o Embed profissional do ticket refletindo o seu estado atual em tempo real.
 * @param {object} params
 * @param {object} params.ticket
 * @param {object} [params.department]
 * @param {object} [params.settings]
 * @returns {EmbedBuilder}
 */
function buildTicketEmbed({ ticket, department = null, settings = null }) {
  const formattedNumber = formatTicketNumber(ticket.ticket_number);
  const statusTranslated = STATUS_LABELS[ticket.status] || ticket.status || 'Novo';
  const priorityTranslated = PRIORITY_LABELS[ticket.priority] || ticket.priority || 'Normal';

  const deptDisplay = department
    ? `${department.emoji ? department.emoji + ' ' : ''}${department.name}`
    : 'Departamento Desconhecido';

  const claimedDisplay = ticket.claimed_by ? `<@${ticket.claimed_by}>` : 'Não atribuído';

  // Formatar data de criação segura em formato Discord timestamp
  let createdAtDisplay = '';
  if (ticket.created_at) {
    const timestamp = Math.floor(new Date(ticket.created_at).getTime() / 1000);
    if (!Number.isNaN(timestamp) && timestamp > 0) {
      createdAtDisplay = `<t:${timestamp}:f>`;
    } else {
      createdAtDisplay = `<t:${Math.floor(Date.now() / 1000)}:f>`;
    }
  } else {
    createdAtDisplay = `<t:${Math.floor(Date.now() / 1000)}:f>`;
  }

  const embed = new EmbedBuilder()
    .setTitle(`🎫 Ticket #${formattedNumber} — ${ticket.subject}`)
    .setDescription(
      ticket.description || 'Sem descrição fornecida.'
    )
    .setColor(resolveColor(settings ? settings.panel_color : null))
    .addFields(
      { name: '🏷️ Número', value: `\`${formattedNumber}\``, inline: true },
      { name: '📊 Estado', value: `\`${statusTranslated}\``, inline: true },
      { name: '⚡ Prioridade', value: `\`${priorityTranslated}\``, inline: true },
      { name: '📁 Departamento', value: deptDisplay, inline: true },
      { name: '👤 Autor', value: `<@${ticket.creator_id}>`, inline: true },
      { name: '🛠️ Responsável', value: claimedDisplay, inline: true },
      { name: '📅 Criado em', value: createdAtDisplay, inline: true },
      { name: '📝 Assunto', value: ticket.subject, inline: false },
      { name: '💬 Descrição', value: ticket.description, inline: false }
    );

  if (ticket.reference) {
    embed.addFields({ name: '🔗 Referência', value: ticket.reference, inline: false });
  }

  if (ticket.status === TICKET_STATUS.CLOSED) {
    embed.addFields(
      { name: '🔒 Fechado por', value: ticket.closed_by ? `<@${ticket.closed_by}>` : 'Sistema', inline: true },
      { name: '📝 Motivo de Fecho', value: ticket.close_reason || 'Nenhum motivo especificado', inline: true }
    );
    embed.setDescription(
      `${ticket.description || 'Sem descrição fornecida.'}\n\n**O ticket encontra-se fechado. O canal foi arquivado e encontra-se em modo de leitura.**`
    );
  }

  embed.setFooter({ text: '+1BOT • Sistema de Tickets' }).setTimestamp();
  return embed;
}

/**
 * Constrói as ActionRows com os controlos persistentes do ticket.
 * Regras Discord: no máximo 1 select menu por ActionRow.
 * @param {object} params
 * @param {object} params.ticket
 * @returns {Array<ActionRowBuilder>}
 */
function buildTicketComponents({ ticket }) {
  const isClaimed = Boolean(ticket.claimed_by);
  const isResolved = ticket.status === TICKET_STATUS.RESOLVED;

  if (ticket.status === TICKET_STATUS.CLOSED || ticket.status === TICKET_STATUS.CLOSING) {
    return [];
  }

  // 1. Linha de Botões (Assumir e Libertar e Fechar)
  const claimButton = new ButtonBuilder()
    .setCustomId(BUTTON_CLAIM)
    .setLabel('Assumir')
    .setEmoji('✋')
    .setStyle(ButtonStyle.Success)
    .setDisabled(isClaimed);

  const releaseButton = new ButtonBuilder()
    .setCustomId(BUTTON_RELEASE)
    .setLabel('Libertar')
    .setEmoji('🔓')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(!isClaimed || isResolved);

  const closeButton = new ButtonBuilder()
    .setCustomId(BUTTON_CLOSE)
    .setLabel('Fechar Ticket')
    .setEmoji('🔒')
    .setStyle(ButtonStyle.Danger);

  const buttonsRow = new ActionRowBuilder().addComponents(claimButton, releaseButton, closeButton);

  // 2. Linha do Menu de Estado (Select Menu)
  const currentStatusLabel = STATUS_LABELS[ticket.status] || ticket.status;
  const statusSelect = new StringSelectMenuBuilder()
    .setCustomId(SELECT_STATUS)
    .setPlaceholder(`Alterar estado... (Atual: ${currentStatusLabel})`)
    .setDisabled(!isClaimed);

  // Opções de transição de estado permitidas
  const allowedTransitions = ALLOWED_STATUS_TRANSITIONS[ticket.status] || [];
  const candidateStatusOptions = [
    {
      label: 'Atribuído',
      value: TICKET_STATUS.ASSIGNED,
      description: 'Ticket atribuído a um atendente',
      emoji: '📌',
    },
    {
      label: 'Em Atendimento',
      value: TICKET_STATUS.IN_PROGRESS,
      description: 'Atendimento em curso pela equipa',
      emoji: '🔄',
    },
    {
      label: 'Aguardando Cliente',
      value: TICKET_STATUS.WAITING_CUSTOMER,
      description: 'Aguardando resposta do utilizador',
      emoji: '⏳',
    },
    {
      label: 'Resolvido',
      value: TICKET_STATUS.RESOLVED,
      description: 'Problema solucionado com sucesso',
      emoji: '✅',
    },
  ];

  const filteredStatusOptions = candidateStatusOptions.filter((opt) => allowedTransitions.includes(opt.value));
  const statusOptions = filteredStatusOptions.length > 0 ? filteredStatusOptions : candidateStatusOptions;

  statusSelect.addOptions(
    statusOptions.map((opt) =>
      new StringSelectMenuOptionBuilder()
        .setLabel(opt.label)
        .setValue(opt.value)
        .setDescription(opt.description)
        .setEmoji(opt.emoji)
        .setDefault(opt.value === ticket.status)
    )
  );

  const statusRow = new ActionRowBuilder().addComponents(statusSelect);

  // 3. Linha do Menu de Prioridade (Select Menu)
  const currentPriorityLabel = PRIORITY_LABELS[ticket.priority] || ticket.priority;
  const prioritySelect = new StringSelectMenuBuilder()
    .setCustomId(SELECT_PRIORITY)
    .setPlaceholder(`Alterar prioridade... (Atual: ${currentPriorityLabel})`);

  const priorityOptions = [
    {
      label: 'Baixa',
      value: TICKET_PRIORITY.LOW,
      description: 'Atendimento não urgente',
      emoji: '🟢',
      default: ticket.priority === TICKET_PRIORITY.LOW,
    },
    {
      label: 'Normal',
      value: TICKET_PRIORITY.NORMAL,
      description: 'Prioridade padrão de atendimento',
      emoji: '🔵',
      default: ticket.priority === TICKET_PRIORITY.NORMAL,
    },
    {
      label: 'Alta',
      value: TICKET_PRIORITY.HIGH,
      description: 'Atendimento prioritário',
      emoji: '🟠',
      default: ticket.priority === TICKET_PRIORITY.HIGH,
    },
    {
      label: 'Urgente',
      value: TICKET_PRIORITY.URGENT,
      description: 'Resolução urgente imediata',
      emoji: '🔴',
      default: ticket.priority === TICKET_PRIORITY.URGENT,
    },
  ];

  prioritySelect.addOptions(
    priorityOptions.map((opt) =>
      new StringSelectMenuOptionBuilder()
        .setLabel(opt.label)
        .setValue(opt.value)
        .setDescription(opt.description)
        .setEmoji(opt.emoji)
        .setDefault(opt.default)
    )
  );

  const priorityRow = new ActionRowBuilder().addComponents(prioritySelect);

  return [buttonsRow, statusRow, priorityRow];
}

/**
 * Constrói o payload completo para atualização ou envio do painel do ticket.
 * @param {object} params
 * @returns {{ embeds: EmbedBuilder[], components: ActionRowBuilder[] }}
 */
function buildTicketPanelPayload({ ticket, department = null, settings = null }) {
  const embed = buildTicketEmbed({ ticket, department, settings });
  const components = buildTicketComponents({ ticket });
  return {
    embeds: [embed],
    components,
  };
}

/**
 * Constrói o Embed com os detalhes completos do ticket e histórico recente de eventos.
 * @param {object} params
 * @param {object} params.ticket
 * @param {object} [params.department]
 * @param {object} [params.settings]
 * @param {Array<object>} [params.members]
 * @param {Array<object>} [params.recentEvents]
 * @returns {EmbedBuilder}
 */
function buildTicketDetailsEmbed({ ticket, department = null, settings = null, members = [], recentEvents = [] }) {
  const formattedNumber = formatTicketNumber(ticket.ticket_number);
  const statusTranslated = STATUS_LABELS[ticket.status] || ticket.status || 'Novo';
  const priorityTranslated = PRIORITY_LABELS[ticket.priority] || ticket.priority || 'Normal';

  const deptDisplay = department
    ? `${department.emoji ? department.emoji + ' ' : ''}${department.name}`
    : 'Departamento Desconhecido';

  const claimedDisplay = ticket.claimed_by ? `<@${ticket.claimed_by}>` : 'Não atribuído';

  const formatTimestamp = (dateStr) => {
    if (!dateStr) return null;
    const ts = Math.floor(new Date(dateStr).getTime() / 1000);
    return !Number.isNaN(ts) && ts > 0 ? ts : null;
  };

  const createdTs = formatTimestamp(ticket.created_at) || Math.floor(Date.now() / 1000);
  const updatedTs = formatTimestamp(ticket.updated_at) || createdTs;

  const datesDisplay = `**Criado:** <t:${createdTs}:f> (<t:${createdTs}:R>)\n**Atualizado:** <t:${updatedTs}:f> (<t:${updatedTs}:R>)`;

  const participantsDisplay = (members && members.length > 0)
    ? members.map((m) => `<@${m.user_id}>`).join(', ')
    : 'Nenhum participante adicional';

  let eventsDisplay = 'Sem histórico de eventos.';
  if (recentEvents && recentEvents.length > 0) {
    const formattedEvents = recentEvents.slice(0, 5).map((evt) => {
      const evtTs = formatTimestamp(evt.created_at) || Math.floor(Date.now() / 1000);
      let eventDesc = evt.event_type;
      switch (evt.event_type) {
        case 'ticket_created':
          eventDesc = 'Criado';
          break;
        case 'ticket_claimed':
          eventDesc = 'Assumido';
          break;
        case 'ticket_released':
          eventDesc = 'Libertado';
          break;
        case 'ticket_status_changed':
          eventDesc = 'Estado alterado';
          break;
        case 'ticket_priority_changed':
          eventDesc = 'Prioridade alterada';
          break;
        case 'ticket_transferred':
          eventDesc = 'Transferido';
          break;
        case 'ticket_participant_added':
          eventDesc = 'Participante adicionado';
          break;
        case 'ticket_participant_removed':
          eventDesc = 'Participante removido';
          break;
        default:
          eventDesc = evt.event_type;
      }
      return `• <t:${evtTs}:R> — **${eventDesc}** por <@${evt.actor_id}>`;
    });
    eventsDisplay = formattedEvents.join('\n');
  }

  const embed = new EmbedBuilder()
    .setTitle(`📋 Detalhes do Ticket #${formattedNumber}`.slice(0, 256))
    .setColor(resolveColor(settings ? settings.panel_color : null))
    .addFields(
      { name: '🏷️ Número', value: `\`${formattedNumber}\``, inline: true },
      { name: '📊 Estado', value: `\`${statusTranslated}\``, inline: true },
      { name: '⚡ Prioridade', value: `\`${priorityTranslated}\``, inline: true },
      { name: '📁 Departamento', value: deptDisplay.slice(0, 1024), inline: true },
      { name: '👤 Autor', value: `<@${ticket.creator_id}>`.slice(0, 1024), inline: true },
      { name: '🛠️ Responsável', value: claimedDisplay.slice(0, 1024), inline: true },
      { name: '👥 Participantes', value: participantsDisplay.slice(0, 1024), inline: false },
      { name: '📅 Datas', value: datesDisplay.slice(0, 1024), inline: false },
      { name: '📜 Últimos Eventos', value: eventsDisplay.slice(0, 1024), inline: false }
    )
    .setFooter({ text: '+1BOT • Detalhes do Ticket' })
    .setTimestamp();

  return embed;
}

module.exports = {
  formatTicketNumber,
  buildTicketEmbed,
  buildTicketComponents,
  buildTicketPanelPayload,
  buildTicketDetailsEmbed,
};
