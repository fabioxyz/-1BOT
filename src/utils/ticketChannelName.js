/**
 * Utilitário para formatação e sanitização de nomes de canais de ticket.
 */

/**
 * Sanitiza um nome de utilizador para cumprir as restrições de nomes de canais do Discord.
 * @param {string} username
 * @returns {string}
 */
function sanitizeUsername(username) {
  if (!username || typeof username !== 'string') {
    return 'user';
  }

  const cleaned = username
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Remove acentos
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-') // Substitui caracteres especiais por hífen
    .replace(/-+/g, '-') // Remove hífens duplicados
    .replace(/^-+|-+$/g, ''); // Remove hífens no início e fim

  return cleaned.length > 0 ? cleaned : 'user';
}

/**
 * Formata o nome do canal do ticket no formato aproximado `ticket-00042-utilizador`.
 * O nome é estritamente limitado a 100 caracteres (limite do Discord).
 * @param {number|string} ticketNumber
 * @param {string} username
 * @returns {string}
 */
function formatTicketChannelName(ticketNumber, username) {
  const num = parseInt(ticketNumber, 10);
  const formattedNum = Number.isNaN(num)
    ? String(ticketNumber).padStart(5, '0')
    : String(num).padStart(5, '0');

  const cleanUser = sanitizeUsername(username);
  const prefix = `ticket-${formattedNum}-`;

  // Limite total do Discord é 100 caracteres
  const maxUserLength = 100 - prefix.length;
  const truncatedUser = cleanUser.slice(0, Math.max(1, maxUserLength)).replace(/-+$/, '');

  return `${prefix}${truncatedUser}`;
}

/**
 * Formata o nome do canal arquivado no formato `closed-00042-utilizador`.
 * O nome é estritamente limitado a 100 caracteres (limite do Discord).
 * @param {number|string} ticketNumber
 * @param {string} username
 * @returns {string}
 */
function formatClosedTicketChannelName(ticketNumber, username) {
  const num = parseInt(ticketNumber, 10);
  const formattedNum = Number.isNaN(num)
    ? String(ticketNumber).padStart(5, '0')
    : String(num).padStart(5, '0');

  const cleanUser = sanitizeUsername(username);
  const prefix = `closed-${formattedNum}-`;

  const maxUserLength = 100 - prefix.length;
  const truncatedUser = cleanUser.slice(0, Math.max(1, maxUserLength)).replace(/-+$/, '');

  return `${prefix}${truncatedUser}`;
}

module.exports = {
  sanitizeUsername,
  formatTicketChannelName,
  formatClosedTicketChannelName,
};
