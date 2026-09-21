/**
 * Custom IDs e utilitários para componentes do sistema de tickets.
 */

const SELECT_DEPARTMENT = 'tickets:department-select';
const CREATE_MODAL_PREFIX = 'tickets:create-modal:';
const INPUT_SUBJECT = 'tickets:input:subject';
const INPUT_DESCRIPTION = 'tickets:input:description';
const INPUT_REFERENCE = 'tickets:input:reference';
const BUTTON_WAITING = 'tickets:button:waiting';
const BUTTON_CLAIM = 'tickets:button:claim';
const BUTTON_RELEASE = 'tickets:button:release';
const SELECT_STATUS = 'tickets:select:status';
const SELECT_PRIORITY = 'tickets:select:priority';
const BUTTON_CLOSE = 'tickets:button:close';
const MODAL_CLOSE = 'tickets:modal:close';
const INPUT_CLOSE_REASON = 'tickets:input:close-reason';
const INPUT_CLOSE_CONFIRM = 'tickets:input:close-confirm';

/**
 * Cria o customId para o modal de abertura de ticket associado a um departamento.
 * @param {number|string} departmentId
 * @returns {string}
 */
function createModalCustomId(departmentId) {
  return `${CREATE_MODAL_PREFIX}${departmentId}`;
}

/**
 * Analisa e valida estritamente um inteiro decimal positivo seguro (ex: IDs de departamento).
 * Aceita representações canónicas (string ou número inteiro seguro positivo).
 * Rejeita: vazio, tipos inválidos, 0, negativos, +1, espaços, zeros à esquerda (01),
 * sufixos alfanuméricos parciais (1abc), decimais (1.0), notação científica (1e2)
 * e valores superiores a Number.MAX_SAFE_INTEGER.
 * @param {unknown} value
 * @returns {number|null}
 */
function parsePositiveSafeInteger(value) {
  const str = typeof value === 'number' ? String(value) : value;
  if (typeof str !== 'string') {
    return null;
  }

  // Rejeitar: vazio, 0, negativos, +1, espaços, 01 (zeros à esquerda), 1abc, 1.0, 1e2
  if (!/^[1-9]\d*$/.test(str)) {
    return null;
  }

  // Rejeitar valores acima de Number.MAX_SAFE_INTEGER sem usar parseInt antecipado
  if (str.length > 16) {
    return null;
  }

  const parsed = Number(str);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || String(parsed) !== str) {
    return null;
  }

  return parsed;
}

/**
 * Analisa e extrai informações de um customId de modal de ticket.
 * @param {string} customId
 * @returns {{ isTicketModal: boolean, departmentId: number|null }}
 */
function parseModalCustomId(customId) {
  if (typeof customId !== 'string' || !customId.startsWith(CREATE_MODAL_PREFIX)) {
    return { isTicketModal: false, departmentId: null };
  }

  const rawId = customId.slice(CREATE_MODAL_PREFIX.length);
  const departmentId = parsePositiveSafeInteger(rawId);

  if (departmentId === null) {
    return { isTicketModal: false, departmentId: null };
  }

  return { isTicketModal: true, departmentId };
}

/**
 * Verifica se uma string de customId pertence ao namespace de tickets.
 * @param {string} customId
 * @returns {boolean}
 */
function isTicketCustomId(customId) {
  if (typeof customId !== 'string') return false;
  return customId.startsWith('tickets:');
}

module.exports = {
  SELECT_DEPARTMENT,
  CREATE_MODAL_PREFIX,
  INPUT_SUBJECT,
  INPUT_DESCRIPTION,
  INPUT_REFERENCE,
  BUTTON_WAITING,
  BUTTON_CLAIM,
  BUTTON_RELEASE,
  SELECT_STATUS,
  SELECT_PRIORITY,
  BUTTON_CLOSE,
  MODAL_CLOSE,
  INPUT_CLOSE_REASON,
  INPUT_CLOSE_CONFIRM,
  createModalCustomId,
  parseModalCustomId,
  parsePositiveSafeInteger,
  isTicketCustomId,
};
