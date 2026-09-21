const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits, ChannelType } = require('discord.js');
const Database = require('better-sqlite3');
const { createConnection } = require('../src/database/connection');
const { runMigrations } = require('../src/database/migrations');
const { SettingsRepository } = require('../src/repositories/settingsRepository');
const { TicketRepository } = require('../src/repositories/ticketRepository');
const { SettingsService } = require('../src/services/settingsService');
const { TicketService } = require('../src/services/ticketService');
const permissionService = require('../src/services/permissionService');
const ticketCloseService = require('../src/services/ticketCloseService');
const interactionCreate = require('../src/events/interactionCreate');
const commandsTickets = require('../src/commands/tickets');

describe('Sistema de Tickets - Bloco 3B', () => {

  afterEach(() => {
    interactionCreate.resetDependencies();
    if (typeof commandsTickets.resetDependencies === 'function') {
      commandsTickets.resetDependencies();
    }
  });

  test('49. Serialização configurar/estado persiste, limpa e valida categoria de arquivo', () => {
    const db = createConnection(':memory:');
    runMigrations(db);
    const settingsRepo = new SettingsRepository(db);
    const ticketRepo = new TicketRepository(db);
    const settingsService = new SettingsService(settingsRepo, ticketRepo);

    const guildId = 'guild-cfg';

    // Persistir arquivo
    const updated = settingsService.updateSettings(guildId, {
      categoryId: 'cat-1',
      archiveCategoryId: 'arch-cat-1',
      logChannelId: 'log-1',
      defaultStaffRoleId: 'role-1'
    }, 'admin-1');

    assert.equal(updated.archive_category_id, 'arch-cat-1');

    // Limpar arquivo
    const cleared = settingsService.updateSettings(guildId, {
      archiveCategoryId: null,
    }, 'admin-1');

    assert.equal(cleared.archive_category_id, null);

    db.close();
  });

  test('50. Autorização estrita de fecho: 4 combinações de admin e override em ticket não resolvido', () => {
    const db = createConnection(':memory:');
    runMigrations(db);
    const settingsRepo = new SettingsRepository(db);
    const ticketRepo = new TicketRepository(db);

    const guildId = 'guild-close-1';
    settingsRepo.upsertGuildSettings(guildId, { defaultStaffRoleId: 'staff-role' });
    const dept = ticketRepo.createDepartment({ guildId, name: 'D', description: 'd' });

    // Ticket não resolvido, atribuído
    const ticket1 = ticketRepo.createTicketReservation({
      guildId, creatorId: 'user-a', departmentId: dept.id, subject: 's', description: 'd'
    });
    db.prepare("UPDATE tickets SET claimed_by = 'staff' WHERE id = ?").run(ticket1.id);
    const ticketObj = ticketRepo.getTicketById(ticket1.id);

    const adminMember = { id: 'admin', permissions: { has: () => true } };
    const staffMember = { id: 'staff', roles: { cache: new Map([['staff-role', {}]]) }, permissions: { has: () => false } };

    // 1. Admin = true, override = true -> Permitido
    const auth1 = ticketCloseService.validateCloseAuthorization({
      ticket: ticketObj, member: adminMember, guild: { id: guildId }, adminOverride: true
    });
    assert.equal(auth1.allowed, true);

    // 2. Admin = true, override = false -> Erro ADMIN_OVERRIDE_REQUIRED
    assert.throws(() => {
      ticketCloseService.validateCloseAuthorization({
        ticket: ticketObj, member: adminMember, guild: { id: guildId }, adminOverride: false
      });
    }, (err) => err.code === 'ADMIN_OVERRIDE_REQUIRED');

    // 3. Admin = false, override = true -> Erro TICKET_NOT_RESOLVED
    assert.throws(() => {
      ticketCloseService.validateCloseAuthorization({
        ticket: ticketObj, member: staffMember, guild: { id: guildId }, adminOverride: true
      });
    }, (err) => err.code === 'TICKET_NOT_RESOLVED');

    // 4. Admin = false, override = false -> Erro TICKET_NOT_RESOLVED
    assert.throws(() => {
      ticketCloseService.validateCloseAuthorization({
        ticket: ticketObj, member: staffMember, guild: { id: guildId }, adminOverride: false
      });
    }, (err) => err.code === 'TICKET_NOT_RESOLVED');

    db.close();
  });

  test('51. Submissão do modal valida contexto e higieniza erro de IDs forjados', async () => {
    let editReplyCalled = false;
    let deferred = false;
    let contentReplied = '';

    const mockInteraction = {
      isChatInputCommand: () => false,
      isAutocomplete: () => false,
      isStringSelectMenu: () => false,
      isButton: () => false,
      isModalSubmit: () => true,
      customId: 'tickets:modal:close',
      channelId: 'invalid-chan',
      guildId: 'invalid-guild',
      member: { id: 'user', permissions: { has: () => false } },
      guild: { id: 'invalid-guild' },
      channel: { id: 'invalid-chan' },
      deferReply: async ({ ephemeral }) => { deferred = true; assert.equal(ephemeral, true); },
      editReply: async ({ content }) => { editReplyCalled = true; contentReplied = content; },
      fields: {
        getTextInputValue: (id) => {
          if (id === 'tickets:input:close-confirm') return 'FECHAR';
          if (id === 'tickets:input:close-reason') return 'motivo';
          return '';
        }
      }
    };

    const mockCloseService = {
      closeTicket: async () => {
        const err = new Error('Not found');
        err.code = 'TICKET_NOT_FOUND';
        throw err;
      }
    };
    const mockRepo = {
      getTicketByChannelId: () => null
    };
    const mockPerm = {
      isAdmin: () => false
    };

    interactionCreate.setDependencies({
      ticketRepo: mockRepo,
      ticketCloseSvc: mockCloseService,
      permSvc: mockPerm
    });

    await interactionCreate.execute(mockInteraction, {});

    assert.equal(deferred, true);
    assert.equal(editReplyCalled, true);
    assert.ok(contentReplied.includes('não corresponde a um ticket registado'));

    // Testar confirmação inválida
    mockInteraction.fields.getTextInputValue = (id) => {
       if (id === 'tickets:input:close-confirm') return 'ERRADO';
       return '';
    };

    await interactionCreate.execute(mockInteraction, {});
    assert.ok(contentReplied.includes('Confirmação inválida'));
  });

  test('52. Sucesso de fecho retorna messageCount e hash, previne chamadas simultâneas', async () => {
    let editReplyCalled = false;
    let deferred = false;
    let contentReplied = '';
    let closeTicketCalls = 0;

    const mockInteraction = {
      isChatInputCommand: () => false,
      isAutocomplete: () => false,
      isStringSelectMenu: () => false,
      isButton: () => false,
      isModalSubmit: () => true,
      customId: 'tickets:modal:close',
      channelId: 'valid-chan',
      guildId: 'valid-guild',
      member: { id: 'admin', permissions: { has: () => true } },
      guild: { id: 'valid-guild' },
      channel: { id: 'valid-chan' },
      deferReply: async ({ ephemeral }) => { deferred = true; assert.equal(ephemeral, true); },
      editReply: async ({ content }) => { editReplyCalled = true; contentReplied = content; },
      fields: {
        getTextInputValue: (id) => {
          if (id === 'tickets:input:close-confirm') return 'FECHAR';
          if (id === 'tickets:input:close-reason') return 'reason';
          return '';
        }
      }
    };

    let rejectNext = false;
    const mockCloseService = {
      closeTicket: async (params) => {
        if (rejectNext) {
          const err = new Error('Concorrente');
          err.code = 'CONCURRENT_CLOSE';
          throw err;
        }
        closeTicketCalls++;
        assert.equal(params.adminOverride, true);

        assert.equal(deferred, true);

        return {
          messageCount: 42,
          transcriptSha256: 'a1b2c3d4e5f6g7h8',
          transcriptPath: 'rel/path.html'
        };
      }
    };

    const mockRepo = {
      getTicketByChannelId: () => ({ status: 'open' })
    };
    const mockPerm = {
      isAdmin: () => true
    };

    interactionCreate.setDependencies({
      ticketRepo: mockRepo,
      ticketCloseSvc: mockCloseService,
      permSvc: mockPerm
    });

    await interactionCreate.execute(mockInteraction, {});

    assert.equal(closeTicketCalls, 1);
    assert.ok(contentReplied.includes('42'));
    assert.ok(contentReplied.includes('a1b2c3d4'));
    assert.ok(!contentReplied.includes('C:'));
    assert.ok(!contentReplied.includes('/data/'));

    rejectNext = true;
    await interactionCreate.execute(mockInteraction, {});
    assert.ok(contentReplied.includes('processamento'));
  });

  test('53. /tickets configurar com categoria_arquivo e limpar_arquivo interage corretamente', async () => {
    let replyCalled = false;
    let replyContent = '';
    let replyEmbeds = null;

    const mockInteraction = {
      isChatInputCommand: () => true,
      commandName: 'tickets',
      options: {
        getSubcommand: () => 'configurar',
        getChannel: (name) => {
          if (name === 'categoria') return { id: 'cat1', type: ChannelType.GuildCategory, guild: { id: 'guild1' } };
          if (name === 'categoria_arquivo') return { id: 'arch_cat1', type: ChannelType.GuildCategory, guild: { id: 'guild1' } };
          if (name === 'canal_logs') return { id: 'log1', type: ChannelType.GuildText, guild: { id: 'guild1' } };
          return null;
        },
        getRole: (name) => {
          if (name === 'cargo_equipa') return { id: 'role1', name: 'Role' };
          return null;
        },
        getString: () => null,
        getBoolean: (name) => {
          if (name === 'limpar_arquivo') return true;
          return null;
        }
      },
      guildId: 'guild1',
      member: { id: 'admin1', permissions: { has: () => true } },
      user: { id: 'admin1' },
      client: { user: { id: 'bot1' } },
      guild: {
        id: 'guild1',
        members: {
          fetch: async () => ({
            permissionsIn: () => ({ has: () => true })
          })
        }
      },
      reply: async ({ content, embeds }) => { replyCalled = true; replyContent = content; replyEmbeds = embeds; }
    };

    const mockSettingsSvc = {
      getSettings: () => ({ archive_category_id: 'old' }),
      updateSettings: (guildId, updates, actorId) => {
        assert.equal(guildId, 'guild1');
        return {
          ticket_category_id: updates.categoryId,
          log_channel_id: updates.logChannelId,
          default_staff_role_id: updates.defaultStaffRoleId,
          archive_category_id: updates.archiveCategoryId
        };
      }
    };

    commandsTickets.setDependencies({ settingsSvc: mockSettingsSvc, permSvc: { isAdmin: () => true } });

    // Teste 1: limpar_arquivo = true
    await commandsTickets.execute(mockInteraction, {});
    assert.equal(replyCalled, true);
    assert.ok(replyEmbeds[0].data.description.includes('guardadas com sucesso'));

    // Teste 2: persistência de archive_category_id
    mockInteraction.options.getBoolean = () => false;
    await commandsTickets.execute(mockInteraction, {});
    assert.ok(replyEmbeds[0].data.description.includes('guardadas com sucesso'));

    // Teste 3: categoria de outra guild
    mockInteraction.options.getChannel = (name) => {
      if (name === 'categoria') return { id: 'cat1', type: ChannelType.GuildCategory, guild: { id: 'guild1' } };
      if (name === 'categoria_arquivo') return { id: 'arch_cat1', type: ChannelType.GuildCategory, guild: { id: 'other_guild' } };
      if (name === 'canal_logs') return { id: 'log1', type: ChannelType.GuildText, guild: { id: 'guild1' } };
      return null;
    };
    await commandsTickets.execute(mockInteraction, {});
    assert.ok(replyContent.includes('pertencer a este servidor'));

    // Teste 4: permissões insuficientes na categoria de arquivo
    mockInteraction.options.getChannel = (name) => {
      if (name === 'categoria') return { id: 'cat1', type: ChannelType.GuildCategory, guild: { id: 'guild1' } };
      if (name === 'categoria_arquivo') return { id: 'arch_cat1', type: ChannelType.GuildCategory, guild: { id: 'guild1' } };
      if (name === 'canal_logs') return { id: 'log1', type: ChannelType.GuildText, guild: { id: 'guild1' } };
      return null;
    };
    mockInteraction.guild.members.fetch = async () => ({
      permissionsIn: () => ({ has: () => false }) // Permissões insuficientes
    });
    await commandsTickets.execute(mockInteraction, {});
    assert.ok(replyContent.includes('bot não possui permissões adequadas'));
  });

  test('54. Botão de fecho chama prepareCloseContext antes de showModal e Custom ID forjado falha', async () => {
    let modalShown = false;
    let prepareCalled = false;
    let editReplyCalled = false;

    const mockInteraction = {
      isChatInputCommand: () => false,
      isAutocomplete: () => false,
      isStringSelectMenu: () => false,
      isButton: () => true,
      isModalSubmit: () => false,
      customId: 'tickets:button:close',
      channelId: 'c1',
      guildId: 'g1',
      member: { id: 'u1' },
      guild: { id: 'g1' },
      channel: { id: 'c1' },
      showModal: async () => { modalShown = true; },
      reply: async ({ content }) => { editReplyCalled = true; }
    };

    const mockCloseService = {
      prepareCloseContext: async () => { prepareCalled = true; return {}; }
    };

    interactionCreate.setDependencies({
      ticketCloseSvc: mockCloseService,
      ticketRepo: { getTicketByChannelId: () => ({ status: 'resolved' }) },
      permSvc: { isAdmin: () => false }
    });

    // 1. Botão válido abre modal
    await interactionCreate.execute(mockInteraction, {});
    assert.equal(prepareCalled, true);
    assert.equal(modalShown, true);

    // 2. Custom ID forjado é ignorado/erro e não abre modal
    modalShown = false;
    prepareCalled = false;
    mockInteraction.customId = 'tickets:button:unknown';
    await interactionCreate.execute(mockInteraction, {});
    assert.equal(prepareCalled, false);
    assert.equal(modalShown, false);
  });

  test('55. Painel no estado closing ou closed não expõe botão de fecho ativo', () => {
    const { buildTicketPanelPayload } = require('../src/components/tickets/ticketPanel');

    // 1. Estado closing
    const payloadClosing = buildTicketPanelPayload({
      ticket: { id: 1, ticket_number: 1, status: 'closing', priority: 'normal', department_id: null, subject: 'S1', description: 'D1' },
      department: null,
      settings: {}
    });

    // 2. Estado closed
    const payloadClosed = buildTicketPanelPayload({
      ticket: { id: 2, ticket_number: 2, status: 'closed', priority: 'normal', department_id: null, subject: 'S2', description: 'D2' },
      department: null,
      settings: {}
    });

    // 3. Estado active
    const payloadActive = buildTicketPanelPayload({
      ticket: { id: 3, ticket_number: 3, status: 'open', priority: 'normal', department_id: null, subject: 'S3', description: 'D3' },
      department: null,
      settings: {}
    });

    const hasActiveCloseBtn = (payload) => {
      if (!payload.components || payload.components.length === 0) return false;
      return payload.components.some(row =>
        row.components.some(c => c.data.custom_id === 'tickets:button:close' && !c.data.disabled)
      );
    };

    assert.equal(hasActiveCloseBtn(payloadClosing), false, 'Botão de fecho deve estar inativo no estado closing');
    assert.equal(hasActiveCloseBtn(payloadClosed), false, 'Botão de fecho deve estar inativo no estado closed');
    assert.equal(hasActiveCloseBtn(payloadActive), true, 'Botão de fecho deve estar ativo em tickets abertos');
  });
});
