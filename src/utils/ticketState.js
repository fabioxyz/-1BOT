/**
 * Definições e constantes de estado, prioridade e transições para o sistema de tickets.
 */

const TICKET_STATUS = {
  NEW: 'new',
  ASSIGNED: 'assigned',
  IN_PROGRESS: 'in_progress',
  WAITING_CUSTOMER: 'waiting_customer',
  RESOLVED: 'resolved',
  CLOSING: 'closing',
  CLOSED: 'closed',
};

const TICKET_PRIORITY = {
  LOW: 'low',
  NORMAL: 'normal',
  HIGH: 'high',
  URGENT: 'urgent',
};

const ALLOWED_STATUSES = [
  TICKET_STATUS.NEW,
  TICKET_STATUS.ASSIGNED,
  TICKET_STATUS.IN_PROGRESS,
  TICKET_STATUS.WAITING_CUSTOMER,
  TICKET_STATUS.RESOLVED,
];

const ALLOWED_PRIORITIES = [
  TICKET_PRIORITY.LOW,
  TICKET_PRIORITY.NORMAL,
  TICKET_PRIORITY.HIGH,
  TICKET_PRIORITY.URGENT,
];

/**
 * Matriz estrita de transições manuais permitidas:
 * - new -> assigned ocorre exclusivamente ao assumir (claim).
 * - assigned -> in_progress ou waiting_customer ou resolved.
 * - in_progress -> waiting_customer ou resolved.
 * - waiting_customer -> in_progress ou resolved.
 * - resolved -> in_progress (reabrir antes de fecho futuro).
 * - Transições arbitrárias fora desta matriz são expressamente proibidas.
 */
const ALLOWED_STATUS_TRANSITIONS = {
  [TICKET_STATUS.NEW]: [TICKET_STATUS.ASSIGNED],
  [TICKET_STATUS.ASSIGNED]: [
    TICKET_STATUS.IN_PROGRESS,
    TICKET_STATUS.WAITING_CUSTOMER,
    TICKET_STATUS.RESOLVED,
  ],
  [TICKET_STATUS.IN_PROGRESS]: [
    TICKET_STATUS.WAITING_CUSTOMER,
    TICKET_STATUS.RESOLVED,
  ],
  [TICKET_STATUS.WAITING_CUSTOMER]: [
    TICKET_STATUS.IN_PROGRESS,
    TICKET_STATUS.RESOLVED,
  ],
  [TICKET_STATUS.RESOLVED]: [
    TICKET_STATUS.IN_PROGRESS,
  ],
};

const STATUS_LABELS = {
  [TICKET_STATUS.NEW]: 'Novo',
  [TICKET_STATUS.ASSIGNED]: 'Atribuído',
  [TICKET_STATUS.IN_PROGRESS]: 'Em Atendimento',
  [TICKET_STATUS.WAITING_CUSTOMER]: 'Aguardando Cliente',
  [TICKET_STATUS.RESOLVED]: 'Resolvido',
  [TICKET_STATUS.CLOSING]: 'A Fechar',
  [TICKET_STATUS.CLOSED]: 'Fechado',
};

const PRIORITY_LABELS = {
  [TICKET_PRIORITY.LOW]: 'Baixa',
  [TICKET_PRIORITY.NORMAL]: 'Normal',
  [TICKET_PRIORITY.HIGH]: 'Alta',
  [TICKET_PRIORITY.URGENT]: 'Urgente',
};

/**
 * Verifica se uma transição de estado é permitida pela matriz.
 * @param {string} fromStatus
 * @param {string} toStatus
 * @returns {boolean}
 */
function isValidStatusTransition(fromStatus, toStatus) {
  if (!fromStatus || !toStatus) return false;
  if (fromStatus === toStatus) return true; // Idempotente
  const allowed = ALLOWED_STATUS_TRANSITIONS[fromStatus];
  return Array.isArray(allowed) && allowed.includes(toStatus);
}

/**
 * Verifica se um valor de prioridade é estritamente válido.
 * @param {string} priority
 * @returns {boolean}
 */
function isValidPriority(priority) {
  return typeof priority === 'string' && ALLOWED_PRIORITIES.includes(priority);
}

module.exports = {
  TICKET_STATUS,
  TICKET_PRIORITY,
  ALLOWED_STATUSES,
  ALLOWED_PRIORITIES,
  ALLOWED_STATUS_TRANSITIONS,
  STATUS_LABELS,
  PRIORITY_LABELS,
  isValidStatusTransition,
  isValidPriority,
};
