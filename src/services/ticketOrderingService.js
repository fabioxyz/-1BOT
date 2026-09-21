const { ChannelType } = require('discord.js');
const logger = require('../utils/logger');
const ticketRepository = require('../repositories/ticketRepository');
const permissionService = require('./permissionService');

const PRIORITY_ORDER = {
  urgent: 1,
  high: 2,
  normal: 3,
  low: 4,
};

class TicketOrderingService {
  constructor(ticketRepo = ticketRepository, permService = permissionService) {
    this.ticketRepo = ticketRepo;
    this.permissionService = permService;
    this.queue = new Map();
  }

  /**
   * Ordena os tickets de uma categoria com base na sua prioridade.
   * @param {object} guild
   * @param {string} categoryId
   * @returns {Promise<{ success: boolean, changes?: number, error?: Error }>}
   */
  async orderCategoryTickets(guild, categoryId) {
    if (!guild || !categoryId) return { success: false, error: new Error('Invalid parameters') };

    const key = `${guild.id}:${categoryId}`;

    if (!this.queue.has(key)) {
      this.queue.set(key, Promise.resolve());
    }

    const task = this.queue.get(key).then(() => this._executeOrdering(guild, categoryId))
      .catch((err) => {
        logger.error(`Error in ticket ordering queue for ${key}: ${err.message}`);
        return { success: false, error: err };
      });

    this.queue.set(key, task);

    task.finally(() => {
      if (this.queue.get(key) === task) {
        this.queue.delete(key);
      }
    });

    return task;
  }

  async _executeOrdering(guild, categoryId) {
    try {
      let category = guild.channels.cache.get(categoryId);
      if (!category && guild.channels.fetch) {
        category = await guild.channels.fetch(categoryId).catch(() => null);
      }

      if (!category || category.type !== ChannelType.GuildCategory) {
        return { success: false, error: new Error('Category not found or invalid type') };
      }

      const botPerms = this.permissionService.checkCategoryPermissions(category, guild.members?.me);
      if (!botPerms.hasPermissions && botPerms.missing.includes('ManageChannels')) {
        const err = new Error('Missing ManageChannels permission');
        err.code = 'MISSING_PERMISSIONS';
        return { success: false, error: err };
      }

      const dbTickets = this.ticketRepo.getActiveTicketsByGuildAndCategory(guild.id, categoryId);
      if (!dbTickets || dbTickets.length === 0) {
        return { success: true, changes: 0 };
      }

      const ticketChannels = [];
      for (const t of dbTickets) {
        const ch = guild.channels.cache.get(t.channel_id);
        if (ch && ch.parentId === categoryId) {
          ticketChannels.push({ ticket: t, channel: ch });
        }
      }

      if (ticketChannels.length === 0) {
        return { success: true, changes: 0 };
      }

      ticketChannels.sort((a, b) => {
        const pA = PRIORITY_ORDER[a.ticket.priority] || 99;
        const pB = PRIORITY_ORDER[b.ticket.priority] || 99;
        if (pA !== pB) return pA - pB;
        if (a.ticket.ticket_number !== b.ticket.ticket_number) {
          return a.ticket.ticket_number - b.ticket.ticket_number;
        }
        return a.ticket.id - b.ticket.id;
      });

      const currentPositions = ticketChannels.map(tc => tc.channel.position).sort((a, b) => a - b);

      const updates = [];
      let changedCount = 0;

      for (let i = 0; i < ticketChannels.length; i++) {
        const tc = ticketChannels[i];
        const newPosition = currentPositions[i];
        if (tc.channel.position !== newPosition) {
          updates.push({ channel: tc.channel.id, position: newPosition });
          changedCount++;
        }
      }

      if (changedCount === 0) {
        return { success: true, changes: 0 };
      }

      if (typeof guild.channels.setPositions === 'function') {
        await guild.channels.setPositions(updates, 'Ticket ordering by priority');
      } else {
        for (const update of updates) {
          const ch = guild.channels.cache.get(update.channel);
          if (ch && typeof ch.setPosition === 'function') {
            await ch.setPosition(update.position, { reason: 'Ticket ordering by priority' });
          }
        }
      }

      return { success: true, changes: changedCount };
    } catch (error) {
      logger.error(`Error ordering tickets in category ${categoryId}: ${error.stack}`);
      return { success: false, error };
    }
  }
}

module.exports = new TicketOrderingService();
module.exports.TicketOrderingService = TicketOrderingService;
