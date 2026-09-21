const {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  EmbedBuilder,
} = require('discord.js');
const { SELECT_DEPARTMENT } = require('../../utils/ticketCustomIds');
const { isValidEmoji } = require('../../utils/emojiValidator');

/**
 * Converte uma cor em formato hex (#5865F2 ou 5865F2) para inteiro numérico.
 * @param {string|number|null} color
 * @param {number} [defaultColor=0x5865F2]
 * @returns {number}
 */
function resolveColor(color, defaultColor = 0x5865F2) {
  if (typeof color === 'number' && !Number.isNaN(color)) {
    return color;
  }
  if (typeof color === 'string') {
    const clean = color.replace(/^#/, '').trim();
    if (/^[0-9A-Fa-f]{6}$/.test(clean)) {
      return parseInt(clean, 16);
    }
  }
  return defaultColor;
}

/**
 * Constrói o Embed profissional do painel de tickets.
 * @param {object} settings
 * @returns {EmbedBuilder}
 */
function getPanelEmbed(settings = {}) {
  const title = (settings && settings.panel_title)
    ? settings.panel_title
    : '🎫 Central de Suporte & Atendimento';

  const description = (settings && settings.panel_description)
    ? settings.panel_description
    : 'Precisas de ajuda ou queres entrar em contacto com a nossa equipa?\n\n' +
      'Seleciona o departamento mais adequado no menu abaixo para abrir um ticket privado.';

  const color = resolveColor(settings ? settings.panel_color : null);

  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(color)
    .addFields(
      {
        name: '📌 Como funciona?',
        value: '1. Escolhe o departamento no menu abaixo.\n2. Preenche o formulário com o teu assunto.\n3. Um canal privado exclusivo será criado para o teu atendimento.',
        inline: false,
      }
    )
    .setFooter({ text: '+1BOT • Sistema de Tickets' })
    .setTimestamp();
}

/**
 * Constrói o menu de seleção com os departamentos ativos.
 * @param {Array<object>} departments
 * @returns {ActionRowBuilder<StringSelectMenuBuilder>}
 */
function getDepartmentSelectRow(departments) {
  const select = new StringSelectMenuBuilder()
    .setCustomId(SELECT_DEPARTMENT)
    .setPlaceholder('Seleciona um departamento para abrir ticket...')
    .setMinValues(1)
    .setMaxValues(1);

  const options = departments.slice(0, 25).map((dept) => {
    const opt = new StringSelectMenuOptionBuilder()
      .setLabel(dept.name.slice(0, 100))
      .setValue(String(dept.id))
      .setDescription(dept.description ? dept.description.slice(0, 100) : 'Suporte especializado');

    if (dept.emoji && typeof dept.emoji === 'string' && isValidEmoji(dept.emoji)) {
      try {
        opt.setEmoji(dept.emoji.trim());
      } catch {
        // Ignora com segurança qualquer emoji legado inválido em vez de lançar
      }
    }

    return opt;
  });

  select.addOptions(options);

  return new ActionRowBuilder().addComponents(select);
}

module.exports = {
  resolveColor,
  getPanelEmbed,
  getDepartmentSelectRow,
};
