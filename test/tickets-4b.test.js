const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { ChannelType } = require('discord.js');
const Database = require('better-sqlite3');
const { createConnection } = require('../src/database/connection');
const { runMigrations } = require('../src/database/migrations');
const { TicketRepository } = require('../src/repositories/ticketRepository');
const { SettingsRepository } = require('../src/repositories/settingsRepository');
const { TicketService } = require('../src/services/ticketService');
const { TicketOrderingService } = require('../src/services/ticketOrderingService');
const { TicketMemberRepository } = require('../src/repositories/ticketMemberRepository');
const permissionService = require('../src/services/permissionService');
const interactionCreate = require('../src/events/interactionCreate');
const commandsTicket = require('../src/commands/ticket');
const { SELECT_PRIORITY } = require('../src/utils/ticketCustomIds');

describe('Sistema de Tickets - Bloco 4B (Ordenação de Prioridade)', () => {
  afterEach(() => {
    interactionCreate.resetDependencies();
  });

  function setupMockGuild(categoryId = 'cat-123') {
    const channelsData = [];
    return {
      id: 'guild-1',
      roles: { cache: new Map(), everyone: { id: 'everyone-role' } },
      members: { me: { id: 'bot' } },
      channels: {
        cache: {
          get(id) { return channelsData.find(c => c.id === id); },
          filter(fn) {
            return {
              values: () => channelsData.filter(fn),
              map: (mFn) => channelsData.filter(fn).map(mFn)
            };
          }
        },
        async setPositions(updates) {
          updates.forEach(upd => {
            const ch = channelsData.find(c => c.id === upd.channel);
            if (ch) ch.position = upd.position;
          });
          return channelsData;
        },
        _addChannel(ch) { channelsData.push(ch); }
      }
    };
  }

  test('59. Ordenação urgent > high > normal > low', async () => {
    const db = createConnection(':memory:');
    runMigrations(db);
    const ticketRepo = new TicketRepository(db);
    const orderingSvc = new TicketOrderingService(ticketRepo, permissionService);

    const guild = setupMockGuild('cat-1');
    guild.channels._addChannel({ id: 'cat-1', type: ChannelType.GuildCategory, parentId: null, position: 0 });

    const dep = ticketRepo.createDepartment({ guildId: 'guild-1', name: 'Dep', description: 'Desc', categoryId: 'cat-1' });

    // Crio tickets com prioridades invertidas e as suas posições (1, 2, 3, 4)
    const ticketsData = [
      { prior: 'low', pos: 1 },
      { prior: 'normal', pos: 2 },
      { prior: 'high', pos: 3 },
      { prior: 'urgent', pos: 4 }
    ];

    for (let i = 0; i < ticketsData.length; i++) {
      const td = ticketsData[i];
      const t = ticketRepo.createTicketReservation({
        guildId: 'guild-1', creatorId: 'u' + i, departmentId: dep.id,
        subject: 'Sub', description: 'Desc', priority: td.prior
      });
      ticketRepo.setTicketChannelId(t.id, 'ch-' + i);
      guild.channels._addChannel({ id: 'ch-' + i, parentId: 'cat-1', position: td.pos, type: ChannelType.GuildText });

      ticketRepo.db.prepare("UPDATE tickets SET status = 'assigned' WHERE id = ?").run(t.id);
    }

    const res = await orderingSvc.orderCategoryTickets(guild, 'cat-1');
    assert.equal(res.success, true);
    assert.equal(res.changes, 4);

    // Urgent = ch-3 -> pos 1
    // High = ch-2 -> pos 2
    // Normal = ch-1 -> pos 3
    // Low = ch-0 -> pos 4
    assert.equal(guild.channels.cache.get('ch-3').position, 1);
    assert.equal(guild.channels.cache.get('ch-2').position, 2);
    assert.equal(guild.channels.cache.get('ch-1').position, 3);
    assert.equal(guild.channels.cache.get('ch-0').position, 4);
  });

  test('60. Empate por ticket_number', async () => {
    const db = createConnection(':memory:');
    runMigrations(db);
    const ticketRepo = new TicketRepository(db);
    const orderingSvc = new TicketOrderingService(ticketRepo, permissionService);

    const guild = setupMockGuild('cat-1');
    guild.channels._addChannel({ id: 'cat-1', type: ChannelType.GuildCategory, position: 0 });
    const dep = ticketRepo.createDepartment({ guildId: 'guild-1', name: 'Dep', description: 'Desc', categoryId: 'cat-1' });

    // Dois urgentes
    const t1 = ticketRepo.createTicketReservation({ guildId: 'guild-1', creatorId: 'u1', departmentId: dep.id, subject: 'Sub', description: 'Desc', priority: 'urgent' });
    const t2 = ticketRepo.createTicketReservation({ guildId: 'guild-1', creatorId: 'u2', departmentId: dep.id, subject: 'Sub', description: 'Desc', priority: 'urgent' });

    ticketRepo.setTicketChannelId(t1.id, 'ch-1');
    ticketRepo.setTicketChannelId(t2.id, 'ch-2');
    ticketRepo.db.prepare("UPDATE tickets SET status = 'assigned'").run();

    // Ordem visual atual é invertida
    guild.channels._addChannel({ id: 'ch-2', parentId: 'cat-1', position: 10, type: ChannelType.GuildText });
    guild.channels._addChannel({ id: 'ch-1', parentId: 'cat-1', position: 20, type: ChannelType.GuildText });

    await orderingSvc.orderCategoryTickets(guild, 'cat-1');

    // T1 é o ticket mais antigo (menor número). Logo T1 fica com a melhor posição disponivel (10) e T2 fica com (20)
    assert.equal(guild.channels.cache.get('ch-1').position, 10);
    assert.equal(guild.channels.cache.get('ch-2').position, 20);
  });

  test('61. Apenas slots de tickets elegíveis mudam; canais não-ticket preservados', async () => {
    const db = createConnection(':memory:');
    runMigrations(db);
    const ticketRepo = new TicketRepository(db);
    const orderingSvc = new TicketOrderingService(ticketRepo, permissionService);

    const guild = setupMockGuild('cat-1');
    guild.channels._addChannel({ id: 'cat-1', type: ChannelType.GuildCategory });
    const dep = ticketRepo.createDepartment({ guildId: 'guild-1', name: 'Dep', description: 'Desc', categoryId: 'cat-1' });

    // ch-0 (nao-ticket) = pos 1
    // ch-1 (ticket low) = pos 2
    // ch-2 (nao-ticket) = pos 3
    // ch-3 (ticket urgent) = pos 4

    guild.channels._addChannel({ id: 'ch-0', parentId: 'cat-1', position: 1, type: ChannelType.GuildText });

    const t1 = ticketRepo.createTicketReservation({ guildId: 'guild-1', creatorId: 'u1', departmentId: dep.id, subject: 'Sub', description: 'Desc', priority: 'low' });
    ticketRepo.setTicketChannelId(t1.id, 'ch-1');
    guild.channels._addChannel({ id: 'ch-1', parentId: 'cat-1', position: 2, type: ChannelType.GuildText });

    guild.channels._addChannel({ id: 'ch-2', parentId: 'cat-1', position: 3, type: ChannelType.GuildText });

    const t2 = ticketRepo.createTicketReservation({ guildId: 'guild-1', creatorId: 'u2', departmentId: dep.id, subject: 'Sub', description: 'Desc', priority: 'urgent' });
    ticketRepo.setTicketChannelId(t2.id, 'ch-3');
    guild.channels._addChannel({ id: 'ch-3', parentId: 'cat-1', position: 4, type: ChannelType.GuildText });

    ticketRepo.db.prepare("UPDATE tickets SET status = 'assigned'").run();

    await orderingSvc.orderCategoryTickets(guild, 'cat-1');

    assert.equal(guild.channels.cache.get('ch-0').position, 1);
    assert.equal(guild.channels.cache.get('ch-1').position, 4); // low vai para a posicao 4
    assert.equal(guild.channels.cache.get('ch-2').position, 3);
    assert.equal(guild.channels.cache.get('ch-3').position, 2); // urgent vai para a posicao 2
  });

  test('62. Ignorar closed/closing, outra guild, channel nulo e canal inexistente', async () => {
    const db = createConnection(':memory:');
    runMigrations(db);
    const ticketRepo = new TicketRepository(db);
    const orderingSvc = new TicketOrderingService(ticketRepo, permissionService);

    // Testa apenas que o método ignora esses casos sem crashar ou os inclui
    const guild = setupMockGuild('cat-1');
    guild.channels._addChannel({ id: 'cat-1', type: ChannelType.GuildCategory });
    const dep = ticketRepo.createDepartment({ guildId: 'guild-1', name: 'Dep', description: 'Desc', categoryId: 'cat-1' });

    const t1 = ticketRepo.createTicketReservation({ guildId: 'guild-1', creatorId: 'u', departmentId: dep.id, subject: 'S', description: 'D' });
    ticketRepo.setTicketChannelId(t1.id, 'ch-1');
    ticketRepo.db.prepare("UPDATE tickets SET status = 'closed'").run();

    const t2 = ticketRepo.createTicketReservation({ guildId: 'guild-2', creatorId: 'u', departmentId: dep.id, subject: 'S', description: 'D' });
    ticketRepo.setTicketChannelId(t2.id, 'ch-2');
    ticketRepo.db.prepare("UPDATE tickets SET status = 'assigned' WHERE id = 2").run();

    guild.channels._addChannel({ id: 'ch-1', parentId: 'cat-1', position: 1 });
    guild.channels._addChannel({ id: 'ch-2', parentId: 'cat-1', position: 2 });

    const res = await orderingSvc.orderCategoryTickets(guild, 'cat-1');
    assert.equal(res.success, true);
    assert.equal(res.changes, 0); // Nenhum ticket válido na guild-1 e cat-1 (o t1 ta fechado)
  });

  test('63. Falha Discord retorna success=false na reordenação e não duplica evento, mas altera BD e visual', async () => {
    const db = createConnection(':memory:');
    runMigrations(db);
    const ticketRepo = new TicketRepository(db);
    const settingsRepo = new SettingsRepository(db);
    const ticketMemberRepo = new TicketMemberRepository(db);
    const ticketSvc = new TicketService(ticketRepo, settingsRepo, permissionService, ticketMemberRepo);
    const orderingSvc = new TicketOrderingService(ticketRepo, permissionService);

    interactionCreate.setDependencies({
      ticketRepo, ticketSvc, permSvc: permissionService, ticketOrderingSvc: orderingSvc
    });

    const guild = setupMockGuild('cat-1');
    guild.channels.setPositions = async () => { throw new Error('Simulate Discord Error'); };
    guild.channels._addChannel({ id: 'cat-1', type: ChannelType.GuildCategory });
    guild.roles.cache.set('staff', { id: 'staff' });

    const dep = ticketRepo.createDepartment({ guildId: 'guild-1', name: 'Dep', description: 'Desc', categoryId: 'cat-1', staffRoleId: 'staff' });
    const t1 = ticketRepo.createTicketReservation({ guildId: 'guild-1', creatorId: 'u1', departmentId: dep.id, subject: 'S', description: 'D', priority: 'normal' });
    ticketRepo.setTicketChannelId(t1.id, 'ch-1');
    ticketRepo.db.prepare("UPDATE tickets SET status = 'assigned', claimed_by = 'staff1'").run();
    guild.channels._addChannel({ id: 'ch-1', parentId: 'cat-1', position: 2, type: ChannelType.GuildText });

    const t2 = ticketRepo.createTicketReservation({ guildId: 'guild-1', creatorId: 'u2', departmentId: dep.id, subject: 'S', description: 'D', priority: 'high' });
    ticketRepo.setTicketChannelId(t2.id, 'ch-2');
    ticketRepo.db.prepare("UPDATE tickets SET status = 'assigned', claimed_by = 'staff1'").run();
    guild.channels._addChannel({ id: 'ch-2', parentId: 'cat-1', position: 1, type: ChannelType.GuildText });

    // Mock interaction
    let replyContent = null;
    let visualUpdated = false;
    const interaction = {
      isChatInputCommand: () => false,
      isAutocomplete: () => false,
      isStringSelectMenu: () => true,
      isModalSubmit: () => false,
      isButton: () => false,
      customId: SELECT_PRIORITY,
      channelId: 'ch-1',
      guildId: 'guild-1',
      values: ['urgent'],
      member: { id: 'staff1', roles: { cache: new Map([['staff', {}]]) } },
      guild,
      channel: { id: 'ch-1', parentId: 'cat-1' },
      deferUpdate: async () => {},
      reply: async (p) => { replyContent = p.content; },
      followUp: async (p) => { replyContent = p.content; },
      editReply: async (p) => { replyContent = p.content; },
      message: { edit: async () => { visualUpdated = true; } },
      deferred: false,
      replied: false,
    };

    permissionService.resolveTicketStaffPermission = () => ({ allowed: true });

    await interactionCreate.execute(interaction, {});

    const tkUpdated = ticketRepo.getTicketById(t1.id);
    assert.equal(tkUpdated.priority, 'urgent');
    assert.equal(visualUpdated, true);
    assert.match(replyContent || '', /prioridade foi guardada.*não foi possível reorganizar/);

    const events = ticketRepo.getEventsByTicket(t1.id);
    assert.equal(events.length, 1);
  });

  test('64. Idempotência na falha ou repetição não duplica eventos ou quebra', async () => {
    const db = createConnection(':memory:');
    runMigrations(db);
    const ticketRepo = new TicketRepository(db);
    const settingsRepo = new SettingsRepository(db);
    const ticketMemberRepo = new TicketMemberRepository(db);
    const ticketSvc = new TicketService(ticketRepo, settingsRepo, permissionService, ticketMemberRepo);
    const orderingSvc = new TicketOrderingService(ticketRepo, permissionService);

    interactionCreate.setDependencies({
      ticketRepo, ticketSvc, permSvc: permissionService, ticketOrderingSvc: orderingSvc
    });

    const guild = setupMockGuild('cat-1');
    guild.channels.setPositions = async () => { throw new Error('Simulate Discord Error'); };
    guild.channels._addChannel({ id: 'cat-1', type: ChannelType.GuildCategory });
    guild.roles.cache.set('staff', { id: 'staff' });

    const dep = ticketRepo.createDepartment({ guildId: 'guild-1', name: 'Dep', description: 'Desc', categoryId: 'cat-1', staffRoleId: 'staff' });
    const t1 = ticketRepo.createTicketReservation({ guildId: 'guild-1', creatorId: 'u1', departmentId: dep.id, subject: 'S', description: 'D', priority: 'normal' });
    ticketRepo.setTicketChannelId(t1.id, 'ch-1');
    ticketRepo.db.prepare("UPDATE tickets SET status = 'assigned', claimed_by = 'staff1'").run();
    guild.channels._addChannel({ id: 'ch-1', parentId: 'cat-1', position: 2, type: ChannelType.GuildText });

    const t2 = ticketRepo.createTicketReservation({ guildId: 'guild-1', creatorId: 'u2', departmentId: dep.id, subject: 'S', description: 'D', priority: 'high' });
    ticketRepo.setTicketChannelId(t2.id, 'ch-2');
    ticketRepo.db.prepare("UPDATE tickets SET status = 'assigned', claimed_by = 'staff1'").run();
    guild.channels._addChannel({ id: 'ch-2', parentId: 'cat-1', position: 1, type: ChannelType.GuildText });

    // 1ª chamada
    const interaction1 = {
      isChatInputCommand: () => false,
      isAutocomplete: () => false,
      isStringSelectMenu: () => true,
      isModalSubmit: () => false,
      isButton: () => false,
      customId: SELECT_PRIORITY,
      channelId: 'ch-1',
      guildId: 'guild-1',
      values: ['urgent'],
      member: { id: 'staff1', roles: { cache: new Map([['staff', {}]]) } },
      guild,
      channel: { id: 'ch-1', parentId: 'cat-1' },
      deferUpdate: async () => {},
      reply: async () => {},
      followUp: async () => {},
      editReply: async () => {},
      message: { edit: async () => {} },
      deferred: false,
      replied: false,
    };

    permissionService.resolveTicketStaffPermission = () => ({ allowed: true });
    await interactionCreate.execute(interaction1, {});

    // 2ª chamada: unchanged (já é urgent)
    const interaction2 = { ...interaction1, values: ['urgent'] };
    await interactionCreate.execute(interaction2, {});

    const events2 = ticketRepo.getEventsByTicket(t1.id);
    assert.equal(events2.length, 1);
  });

  test('65. /ticket atualizar reconcilia ordem e painel', async () => {
    const db = createConnection(':memory:');
    runMigrations(db);
    const ticketRepo = new TicketRepository(db);
    const settingsRepo = new SettingsRepository(db);
    const ticketSvc = new TicketService(ticketRepo, settingsRepo, permissionService, null);
    const orderingSvc = new TicketOrderingService(ticketRepo, permissionService);

    const guild = setupMockGuild('cat-1');
    guild.channels._addChannel({ id: 'cat-1', type: ChannelType.GuildCategory });

    const dep = ticketRepo.createDepartment({ guildId: 'guild-1', name: 'Dep', description: 'Desc', categoryId: 'cat-1' });
    const t1 = ticketRepo.createTicketReservation({ guildId: 'guild-1', creatorId: 'u1', departmentId: dep.id, subject: 'S', description: 'D' });
    ticketRepo.setTicketChannelId(t1.id, 'ch-1');
    ticketRepo.setControlMessageId(t1.id, 'msg-1');
    ticketRepo.db.prepare("UPDATE tickets SET status = 'assigned', claimed_by = 'staff1'").run();

    let edited = false;
    guild.channels._addChannel({
      id: 'ch-1', parentId: 'cat-1', position: 1, type: ChannelType.GuildText,
      messages: { fetch: async () => ({ edit: async () => { edited = true; } }) }
    });

    permissionService.resolveTicketStaffPermission = () => ({ allowed: true });

    let reply = '';
    const interaction = {
      isChatInputCommand: () => true,
      commandName: 'ticket',
      options: {
        getSubcommand: () => 'atualizar',
        getFocused: () => null
      },
      channelId: 'ch-1',
      guildId: 'guild-1',
      member: { id: 'staff1' },
      guild,
      channel: guild.channels.cache.get('ch-1'),
      deferReply: async () => {},
      editReply: async (p) => { reply = p.content; }
    };

    // Mock de dependências para execução do comando

    const origGetTicket = require('../src/repositories/ticketRepository').getTicketByChannelId;
    require('../src/repositories/ticketRepository').getTicketByChannelId = () => ticketRepo.getTicketByChannelId('ch-1', 'guild-1');

    const origRefresh = require('../src/services/ticketService').refreshTicketPanel;
    require('../src/services/ticketService').refreshTicketPanel = async () => ({
      ticket: t1, department: dep, settings: {}
    });

    const origOrder = require('../src/services/ticketOrderingService').orderCategoryTickets;
    require('../src/services/ticketOrderingService').orderCategoryTickets = async () => ({ success: true, changes: 1 });

    try {
      await commandsTicket.execute(interaction);
      assert.equal(reply.includes('Painel do ticket atualizado com sucesso a partir da base de dados'), true);
      assert.equal(reply.includes('A fila de tickets na categoria foi reorganizada'), true);
    } finally {
      require('../src/repositories/ticketRepository').getTicketByChannelId = origGetTicket;
      require('../src/services/ticketService').refreshTicketPanel = origRefresh;
      require('../src/services/ticketOrderingService').orderCategoryTickets = origOrder;
    }
  });

  test('66. Fila de concorrência mutex não executa ordenações sobrepostas para a mesma categoria', async () => {
    const db = createConnection(':memory:');
    runMigrations(db);
    const ticketRepo = new TicketRepository(db);
    const orderingSvc = new TicketOrderingService(ticketRepo, permissionService);

    const guild = setupMockGuild('cat-1');
    guild.channels._addChannel({ id: 'cat-1', type: ChannelType.GuildCategory });
    const dep = ticketRepo.createDepartment({ guildId: 'guild-1', name: 'Dep', description: 'Desc', categoryId: 'cat-1' });

    let activeOperations = 0;
    let maxOperations = 0;

    // Override _executeOrdering directly to simulate async work
    const origExecute = orderingSvc._executeOrdering.bind(orderingSvc);
    orderingSvc._executeOrdering = async (g, cId) => {
      activeOperations++;
      if (activeOperations > maxOperations) maxOperations = activeOperations;
      await new Promise(r => setTimeout(r, 10)); // fake async delay
      const res = await origExecute(g, cId);
      activeOperations--;
      return res;
    };

    // Dispatch multiple requests concurrently
    const p1 = orderingSvc.orderCategoryTickets(guild, 'cat-1');
    const p2 = orderingSvc.orderCategoryTickets(guild, 'cat-1');
    const p3 = orderingSvc.orderCategoryTickets(guild, 'cat-1');

    await Promise.all([p1, p2, p3]);

    // If queue is working properly, maxOperations should be 1 because they are chained sequentially
    assert.equal(maxOperations, 1);
  });

  test('67. Fallback global na ordenação se o departamento não tiver category_id', async () => {
    const db = createConnection(':memory:');
    runMigrations(db);
    const ticketRepo = new TicketRepository(db);
    const settingsRepo = new SettingsRepository(db);
    const ticketMemberRepo = new TicketMemberRepository(db);
    const ticketSvc = new TicketService(ticketRepo, settingsRepo, permissionService, ticketMemberRepo);
    const orderingSvc = new TicketOrderingService(ticketRepo, permissionService);

    interactionCreate.setDependencies({
      ticketRepo, ticketSvc, permSvc: permissionService, ticketOrderingSvc: orderingSvc
    });

    const guild = setupMockGuild('global-cat');
    guild.channels._addChannel({ id: 'global-cat', type: ChannelType.GuildCategory });
    settingsRepo.upsertGuildSettings('guild-1', { ticket_category_id: 'global-cat' });

    // Departamento sem categoryId
    const dep = ticketRepo.createDepartment({ guildId: 'guild-1', name: 'Dep', description: 'Desc', categoryId: null });
    const t1 = ticketRepo.createTicketReservation({ guildId: 'guild-1', creatorId: 'u1', departmentId: dep.id, subject: 'S', description: 'D', priority: 'normal' });
    ticketRepo.setTicketChannelId(t1.id, 'ch-1');
    ticketRepo.db.prepare("UPDATE tickets SET status = 'assigned'").run();
    guild.channels._addChannel({ id: 'ch-1', parentId: 'global-cat', position: 2, type: ChannelType.GuildText });

    const t2 = ticketRepo.createTicketReservation({ guildId: 'guild-1', creatorId: 'u2', departmentId: dep.id, subject: 'S', description: 'D', priority: 'urgent' });
    ticketRepo.setTicketChannelId(t2.id, 'ch-2');
    ticketRepo.db.prepare("UPDATE tickets SET status = 'assigned'").run();
    guild.channels._addChannel({ id: 'ch-2', parentId: 'global-cat', position: 1, type: ChannelType.GuildText });

    let orderCalledWithGlobal = false;
    orderingSvc.orderCategoryTickets = async (g, catId) => {
      if (catId === 'global-cat') orderCalledWithGlobal = true;
      return { success: true, changes: 1 };
    };

    const interaction = {
      isChatInputCommand: () => false,
      isAutocomplete: () => false,
      isStringSelectMenu: () => true,
      isModalSubmit: () => false,
      isButton: () => false,
      customId: SELECT_PRIORITY,
      channelId: 'ch-1',
      guildId: 'guild-1',
      values: ['low'],
      member: { id: 'staff1', roles: { cache: new Map() } },
      guild,
      channel: { id: 'ch-1', parentId: null }, // Channel is independent or mock misses parentId
      deferUpdate: async () => {},
      reply: async () => {},
      followUp: async () => {},
      editReply: async () => {},
      message: { edit: async () => {} },
      deferred: false,
      replied: false,
    };

    permissionService.resolveTicketStaffPermission = () => ({ allowed: true });

    await interactionCreate.execute(interaction, {});

    assert.equal(orderCalledWithGlobal, true);
  });
});
