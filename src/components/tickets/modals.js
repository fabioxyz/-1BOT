const {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} = require('discord.js');
const {
  createModalCustomId,
  INPUT_SUBJECT,
  INPUT_DESCRIPTION,
  INPUT_REFERENCE,
  MODAL_CLOSE,
  INPUT_CLOSE_REASON,
  INPUT_CLOSE_CONFIRM,
} = require('../../utils/ticketCustomIds');

/**
 * Constrói o modal de abertura de ticket para um departamento.
 * @param {object} department
 * @returns {ModalBuilder}
 */
function getTicketCreateModal(department) {
  // Limite do Discord para o título do modal é 45 caracteres
  const modalTitle = `Abrir Ticket: ${department.name}`.slice(0, 45);
  const customId = createModalCustomId(department.id);

  const modal = new ModalBuilder()
    .setCustomId(customId)
    .setTitle(modalTitle);

  const subjectInput = new TextInputBuilder()
    .setCustomId(INPUT_SUBJECT)
    .setLabel('Assunto')
    .setPlaceholder('Resumo curto do teu pedido')
    .setStyle(TextInputStyle.Short)
    .setMinLength(3)
    .setMaxLength(100)
    .setRequired(true);

  const descriptionInput = new TextInputBuilder()
    .setCustomId(INPUT_DESCRIPTION)
    .setLabel('Descrição detalhada')
    .setPlaceholder('Explica detalhadamente a situação ou dúvida...')
    .setStyle(TextInputStyle.Paragraph)
    .setMinLength(10)
    .setMaxLength(1000)
    .setRequired(true);

  const referenceInput = new TextInputBuilder()
    .setCustomId(INPUT_REFERENCE)
    .setLabel('Referência (opcional)')
    .setPlaceholder('Ex.: número de encomenda, ID, link, etc.')
    .setStyle(TextInputStyle.Short)
    .setMaxLength(100)
    .setRequired(false);

  const firstActionRow = new ActionRowBuilder().addComponents(subjectInput);
  const secondActionRow = new ActionRowBuilder().addComponents(descriptionInput);
  const thirdActionRow = new ActionRowBuilder().addComponents(referenceInput);

  modal.addComponents(firstActionRow, secondActionRow, thirdActionRow);

  return modal;
}

/**
 * Constrói o modal de confirmação para fechar um ticket.
 * @returns {ModalBuilder}
 */
function getTicketCloseModal() {
  const modal = new ModalBuilder()
    .setCustomId(MODAL_CLOSE)
    .setTitle('Fechar Ticket');

  const reasonInput = new TextInputBuilder()
    .setCustomId(INPUT_CLOSE_REASON)
    .setLabel('Motivo do Fecho')
    .setPlaceholder('Explica resumidamente o motivo...')
    .setStyle(TextInputStyle.Paragraph)
    .setMinLength(5)
    .setMaxLength(500)
    .setRequired(true);

  const confirmInput = new TextInputBuilder()
    .setCustomId(INPUT_CLOSE_CONFIRM)
    .setLabel('Confirmação (digita FECHAR)')
    .setPlaceholder('FECHAR')
    .setStyle(TextInputStyle.Short)
    .setMinLength(6)
    .setMaxLength(6)
    .setRequired(true);

  const firstActionRow = new ActionRowBuilder().addComponents(reasonInput);
  const secondActionRow = new ActionRowBuilder().addComponents(confirmInput);

  modal.addComponents(firstActionRow, secondActionRow);

  return modal;
}

module.exports = {
  getTicketCreateModal,
  getTicketCloseModal,
};
