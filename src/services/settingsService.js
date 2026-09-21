const settingsRepository = require('../repositories/settingsRepository');
const ticketRepository = require('../repositories/ticketRepository');
const { isValidEmoji } = require('../utils/emojiValidator');

class SettingsService {
  constructor(settingsRepo = settingsRepository, ticketRepo = ticketRepository) {
    this.settingsRepo = settingsRepo;
    this.ticketRepo = ticketRepo;
  }

  /**
   * Obtém as configurações de uma guild.
   * @param {string} guildId
   * @returns {object|null}
   */
  getSettings(guildId) {
    return this.settingsRepo.getGuildSettings(guildId);
  }

  /**
   * Valida e atualiza as configurações da guild.
   * @param {string} guildId
   * @param {object} params
   * @param {string} actorId
   * @returns {object}
   */
  updateSettings(guildId, params, actorId) {
    let panelColor = params.panelColor;
    if (panelColor !== undefined && panelColor !== null && panelColor !== '') {
      const clean = panelColor.trim().replace(/^#/, '');
      if (!/^[0-9A-Fa-f]{6}$/.test(clean)) {
        throw new Error('Formato de cor inválido. Usa o formato hexadecimal, por exemplo: #5865F2');
      }
      panelColor = `#${clean.toUpperCase()}`;
    } else if (panelColor === '') {
      panelColor = null;
    }

    if (params.defaultStaffRoleId) {
      const staffRole = String(params.defaultStaffRoleId).trim();
      if (staffRole === guildId || staffRole.toLowerCase() === '@everyone') {
        const err = new Error('O cargo @everyone não pode ser configurado como cargo da equipa por motivos de privacidade e segurança.');
        err.code = 'INVALID_STAFF_ROLE';
        throw err;
      }
    }

    const updated = this.settingsRepo.upsertGuildSettings(guildId, {
      ticket_category_id: params.categoryId,
      archive_category_id: params.archiveCategoryId,
      log_channel_id: params.logChannelId,
      default_staff_role_id: params.defaultStaffRoleId,
      panel_title: params.panelTitle,
      panel_description: params.panelDescription,
      panel_color: panelColor,
    });

    this.ticketRepo.createEvent({
      guildId,
      eventType: 'settings_updated',
      actorId,
      metadata: {
        ticketCategoryId: updated.ticket_category_id,
        logChannelId: updated.log_channel_id,
        defaultStaffRoleId: updated.default_staff_role_id,
      },
    });

    return updated;
  }

  /**
   * Adiciona um novo departamento a uma guild.
   * @param {string} guildId
   * @param {object} params
   * @param {string} actorId
   * @returns {object}
   */
  addDepartment(guildId, { name, description, emoji = null, staffRoleId = null, categoryId = null }, actorId) {
    const trimmedName = (name || '').trim();
    const trimmedDesc = (description || '').trim();

    if (trimmedName.length < 2 || trimmedName.length > 50) {
      throw new Error('O nome do departamento deve ter entre 2 e 50 caracteres.');
    }

    if (trimmedDesc.length < 3 || trimmedDesc.length > 100) {
      throw new Error('A descrição do departamento deve ter entre 3 e 100 caracteres.');
    }

    // Limite Discord de opções num Select Menu é 25
    const activeCount = this.ticketRepo.countActiveDepartments(guildId);
    if (activeCount >= 25) {
      throw new Error('O servidor atingiu o limite máximo de 25 departamentos ativos.');
    }

    // Nomes únicos por guild (ativo)
    const existing = this.ticketRepo.getDepartmentByName(guildId, trimmedName, true);
    if (existing) {
      throw new Error(`Já existe um departamento ativo com o nome "${trimmedName}".`);
    }

    if (staffRoleId) {
      const roleId = String(staffRoleId).trim();
      if (roleId === guildId || roleId.toLowerCase() === '@everyone') {
        const err = new Error('O cargo @everyone não pode ser configurado como cargo de equipa de departamento por motivos de privacidade e segurança.');
        err.code = 'INVALID_STAFF_ROLE';
        throw err;
      }
    }

    let cleanedEmoji = null;
    if (emoji !== undefined && emoji !== null && String(emoji).trim().length > 0) {
      const trimmedEmoji = String(emoji).trim();
      if (!isValidEmoji(trimmedEmoji)) {
        const err = new Error('Emoji inválido. Fornece um único emoji Unicode válido ou um emoji customizado do Discord (<:nome:id> ou <a:nome:id>).');
        err.code = 'INVALID_EMOJI';
        throw err;
      }
      cleanedEmoji = trimmedEmoji;
    }

    const dept = this.ticketRepo.createDepartment({
      guildId,
      name: trimmedName,
      description: trimmedDesc,
      emoji: cleanedEmoji,
      staffRoleId: staffRoleId || null,
      categoryId: categoryId || null,
    });

    this.ticketRepo.createEvent({
      guildId,
      eventType: 'department_created',
      actorId,
      metadata: {
        departmentId: dept.id,
        name: dept.name,
      },
    });

    return dept;
  }

  /**
   * Lista os departamentos de uma guild com a sua configuração efetiva resolvida.
   * @param {string} guildId
   * @param {boolean} [onlyActive=false]
   * @returns {Array<object>}
   */
  listDepartments(guildId, onlyActive = false) {
    const settings = this.getSettings(guildId) || {};
    const departments = this.ticketRepo.getDepartmentsByGuild(guildId, onlyActive);

    return departments.map((dept) => {
      const effectiveCategoryId = dept.category_id || settings.ticket_category_id || null;
      const effectiveStaffRoleId = dept.staff_role_id || settings.default_staff_role_id || null;
      const inheritsCategory = !dept.category_id && !!settings.ticket_category_id;
      const inheritsStaffRole = !dept.staff_role_id && !!settings.default_staff_role_id;

      return {
        ...dept,
        effectiveCategoryId,
        effectiveStaffRoleId,
        inheritsCategory,
        inheritsStaffRole,
      };
    });
  }

  /**
   * Remove/desativa um departamento.
   * @param {string} guildId
   * @param {number} departmentId
   * @param {string} actorId
   * @returns {boolean}
   */
  removeDepartment(guildId, departmentId, actorId) {
    const dept = this.ticketRepo.getDepartmentById(departmentId, guildId);
    if (!dept) {
      throw new Error('Departamento não encontrado neste servidor.');
    }

    if (dept.active === 0) {
      throw new Error('Este departamento já se encontra desativado.');
    }

    const success = this.ticketRepo.deactivateDepartment(departmentId, guildId);
    if (success) {
      this.ticketRepo.createEvent({
        guildId,
        eventType: 'department_deactivated',
        actorId,
        metadata: {
          departmentId: dept.id,
          name: dept.name,
        },
      });
    }

    return success;
  }

  /**
   * Regista o evento de publicação do painel.
   * @param {string} guildId
   * @param {string} actorId
   * @param {string} channelId
   */
  recordPanelPublished(guildId, actorId, channelId) {
    this.ticketRepo.createEvent({
      guildId,
      eventType: 'panel_published',
      actorId,
      metadata: { channelId },
    });
  }
}

module.exports = new SettingsService();
module.exports.SettingsService = SettingsService;
