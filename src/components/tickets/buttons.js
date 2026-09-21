const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const {
  BUTTON_WAITING,
  BUTTON_CLAIM,
  BUTTON_RELEASE,
  BUTTON_CLOSE,
} = require('../../utils/ticketCustomIds');

/**
 * Cria o botão informativo/desativado "A aguardar atendimento" para a Entrega 1.
 * @returns {ButtonBuilder}
 */
function getWaitingButton() {
  return new ButtonBuilder()
    .setCustomId(BUTTON_WAITING)
    .setLabel('A aguardar atendimento')
    .setEmoji('⏳')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(true);
}

/**
 * Cria o botão "Assumir" do ticket.
 * @param {boolean} [disabled=false]
 * @returns {ButtonBuilder}
 */
function getClaimButton(disabled = false) {
  return new ButtonBuilder()
    .setCustomId(BUTTON_CLAIM)
    .setLabel('Assumir')
    .setEmoji('✋')
    .setStyle(ButtonStyle.Success)
    .setDisabled(disabled);
}

/**
 * Cria o botão "Libertar" do ticket.
 * @param {boolean} [disabled=false]
 * @returns {ButtonBuilder}
 */
function getReleaseButton(disabled = false) {
  return new ButtonBuilder()
    .setCustomId(BUTTON_RELEASE)
    .setLabel('Libertar')
    .setEmoji('🔓')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(disabled);
}

/**
 * Cria o botão "Fechar Ticket".
 * @param {boolean} [disabled=false]
 * @returns {ButtonBuilder}
 */
function getCloseButton(disabled = false) {
  return new ButtonBuilder()
    .setCustomId(BUTTON_CLOSE)
    .setLabel('Fechar Ticket')
    .setEmoji('🔒')
    .setStyle(ButtonStyle.Danger)
    .setDisabled(disabled);
}

/**
 * Cria a ActionRow com o indicador informativo de atendimento.
 * @returns {ActionRowBuilder<ButtonBuilder>}
 */
function getTicketInitialActionRow() {
  return new ActionRowBuilder().addComponents(getWaitingButton());
}

module.exports = {
  getWaitingButton,
  getClaimButton,
  getReleaseButton,
  getCloseButton,
  getTicketInitialActionRow,
};
