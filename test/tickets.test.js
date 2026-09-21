const { test, describe } = require('node:test');
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
const { isValidEmoji } = require('../src/utils/emojiValidator');
const { getDepartmentSelectRow } = require('../src/components/tickets/selectMenus');
const {
  formatTicketChannelName,
  sanitizeUsername,
} = require('../src/utils/ticketChannelName');
const {
  SELECT_DEPARTMENT,
  CREATE_MODAL_PREFIX,
  INPUT_SUBJECT,
  INPUT_DESCRIPTION,
  createModalCustomId,
  parseModalCustomId,
  parsePositiveSafeInteger,
  isTicketCustomId,
} = require('../src/utils/ticketCustomIds');

describe('Sistema de Tickets - Entrega 1', () => {

  // 1. Migrações executadas duas vezes (idempotência)
  test('1. Migrações podem ser executadas múltiplas vezes sem erro (idempotência)', () => {
    const db = createConnection(':memory:');

    // Executar novamente
    assert.doesNotThrow(() => {
      runMigrations(db);
    });

    // Executar terceira vez
    assert.doesNotThrow(() => {
      runMigrations(db);
    });

    // Verificar se todas as tabelas existem
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name);

    assert.ok(tables.includes('guild_settings'), 'guild_settings deve existir');
    assert.ok(tables.includes('ticket_departments'), 'ticket_departments deve existir');
    assert.ok(tables.includes('tickets'), 'tickets deve existir');
    assert.ok(tables.includes('ticket_events'), 'ticket_events deve existir');

    db.close();
  });

  // 2. CRUD de configuração por guild
  test('2. CRUD de configurações por servidor com persistência e atualização incremental', () => {
    const db = createConnection(':memory:');
    const settingsRepo = new SettingsRepository(db);

    const guildId = 'guild-test-100';

    // Início: sem configurações
    assert.equal(settingsRepo.getGuildSettings(guildId), null);

    // Inserção inicial
    const inserted = settingsRepo.upsertGuildSettings(guildId, {
      ticket_category_id: 'cat-111',
      log_channel_id: 'log-222',
      default_staff_role_id: 'role-333',
      panel_title: 'Central de Apoio',
      panel_description: 'Descrição de teste',
      panel_color: '#5865F2',
    });

    assert.equal(inserted.guild_id, guildId);
    assert.equal(inserted.ticket_category_id, 'cat-111');
    assert.equal(inserted.log_channel_id, 'log-222');
    assert.equal(inserted.default_staff_role_id, 'role-333');
    assert.equal(inserted.panel_title, 'Central de Apoio');
    assert.equal(inserted.panel_color, '#5865F2');

    // Atualização parcial (mantendo categoria e logs)
    const updated = settingsRepo.upsertGuildSettings(guildId, {
      panel_title: 'Novo Título do Painel',
      panel_color: '#57F287',
    });

    assert.equal(updated.ticket_category_id, 'cat-111');
    assert.equal(updated.log_channel_id, 'log-222');
    assert.equal(updated.panel_title, 'Novo Título do Painel');
    assert.equal(updated.panel_color, '#57F287');

    db.close();
  });

  // 3. Isolamento de departamentos por guild
  test('3. Isolamento de departamentos e unicidade de nome por guild', () => {
    const db = createConnection(':memory:');
    const ticketRepo = new TicketRepository(db);
    const settingsService = new SettingsService(new SettingsRepository(db), ticketRepo);

    const guildA = 'guild-aaa';
    const guildB = 'guild-bbb';

    // Criar departamento com o mesmo nome em servidores diferentes (deve ser permitido)
    const deptA = settingsService.addDepartment(
      guildA,
      { name: 'Suporte Técnico', description: 'Ajuda técnica para guild A' },
      'user-admin'
    );
    const deptB = settingsService.addDepartment(
      guildB,
      { name: 'Suporte Técnico', description: 'Ajuda técnica para guild B' },
      'user-admin'
    );

    assert.ok(deptA.id);
    assert.ok(deptB.id);
    assert.notEqual(deptA.guild_id, deptB.guild_id);

    // Tentativa de duplicar nome ativo no mesmo servidor deve falhar
    assert.throws(() => {
      settingsService.addDepartment(
        guildA,
        { name: 'suporte técnico', description: 'Tentativa duplicada' },
        'user-admin'
      );
    }, /Já existe um departamento ativo com o nome/);

    // Listagem isolada por guild
    const listA = settingsService.listDepartments(guildA, true);
    const listB = settingsService.listDepartments(guildB, true);
    assert.equal(listA.length, 1);
    assert.equal(listB.length, 1);
    assert.equal(listA[0].guild_id, guildA);
    assert.equal(listB[0].guild_id, guildB);

    // Desativação num servidor não afeta o outro
    settingsService.removeDepartment(guildA, deptA.id, 'user-admin');
    assert.equal(settingsService.listDepartments(guildA, true).length, 0);
    assert.equal(settingsService.listDepartments(guildB, true).length, 1);

    db.close();
  });

  // 4. Sanitização do nome do canal
  test('4. Sanitização correta e limite de 100 caracteres no nome do canal', () => {
    // Sanitização de nomes de utilizador
    assert.equal(sanitizeUsername('João_Silva'), 'joao-silva');
    assert.equal(sanitizeUsername('Pedro---Santos'), 'pedro-santos');
    assert.equal(sanitizeUsername('!@#$%^&*()'), 'user');
    assert.equal(sanitizeUsername(''), 'user');
    assert.equal(sanitizeUsername('Açores & Madeira'), 'acores-madeira');

    // Formatação com padding sequencial
    const standardName = formatTicketChannelName(42, 'João_Silva');
    assert.equal(standardName, 'ticket-00042-joao-silva');

    // Limite de 100 caracteres
    const veryLongName = 'a'.repeat(200);
    const formattedLong = formatTicketChannelName(1, veryLongName);
    assert.ok(formattedLong.length <= 100, `Tamanho deve ser <= 100, obtido: ${formattedLong.length}`);
    assert.ok(formattedLong.startsWith('ticket-00001-'));
  });

  // 5. Numeração sequencial por guild
  test('5. Numeração sequencial isolada e independente por guild', () => {
    const db = createConnection(':memory:');
    const ticketRepo = new TicketRepository(db);

    // Criar departamentos em guild 1 e guild 2
    const dept1 = ticketRepo.createDepartment({
      guildId: 'guild-1',
      name: 'Geral 1',
      description: 'Desc 1',
    });
    const dept2 = ticketRepo.createDepartment({
      guildId: 'guild-2',
      name: 'Geral 2',
      description: 'Desc 2',
    });

    // Guild 1: Ticket #1
    const t1Guild1 = ticketRepo.createTicketReservation({
      guildId: 'guild-1',
      creatorId: 'user-a',
      departmentId: dept1.id,
      subject: 'Problema A',
      description: 'Descrição problema A',
    });
    assert.equal(t1Guild1.ticket_number, 1);

    // Guild 2: Ticket #1 (deve iniciar em 1 independentemente da Guild 1)
    const t1Guild2 = ticketRepo.createTicketReservation({
      guildId: 'guild-2',
      creatorId: 'user-b',
      departmentId: dept2.id,
      subject: 'Problema B',
      description: 'Descrição problema B',
    });
    assert.equal(t1Guild2.ticket_number, 1);

    // Fechar ticket da Guild 1 para permitir novo ticket
    db.prepare("UPDATE tickets SET status = 'closed', closed_at = datetime('now') WHERE id = ?").run(t1Guild1.id);

    // Guild 1: Ticket #2
    const t2Guild1 = ticketRepo.createTicketReservation({
      guildId: 'guild-1',
      creatorId: 'user-a',
      departmentId: dept1.id,
      subject: 'Problema A2',
      description: 'Descrição problema A2',
    });
    assert.equal(t2Guild1.ticket_number, 2);

    // Guild 2 ainda deve ter ticket 1 ativo
    const activeGuild2 = ticketRepo.getActiveTicketByUser('guild-2', 'user-b');
    assert.equal(activeGuild2.ticket_number, 1);

    db.close();
  });

  // 6. Prevenção de ticket ativo duplicado
  test('6. Prevenção de múltiplos tickets ativos do mesmo utilizador no mesmo servidor', () => {
    const db = createConnection(':memory:');
    const ticketRepo = new TicketRepository(db);

    const dept = ticketRepo.createDepartment({
      guildId: 'guild-alpha',
      name: 'Dúvidas',
      description: 'Dúvidas',
    });

    // Criar primeiro ticket
    const ticket1 = ticketRepo.createTicketReservation({
      guildId: 'guild-alpha',
      creatorId: 'user-999',
      departmentId: dept.id,
      subject: 'Assunto 1',
      description: 'Descrição 1 com mais de 10 caracteres',
    });
    assert.ok(ticket1.id);

    // Tentativa de criar segundo ticket pelo mesmo utilizador na mesma guild deve falhar
    assert.throws(() => {
      ticketRepo.createTicketReservation({
        guildId: 'guild-alpha',
        creatorId: 'user-999',
        departmentId: dept.id,
        subject: 'Assunto 2',
        description: 'Segunda descrição detalhada',
      });
    }, (err) => err.code === 'ACTIVE_TICKET_EXISTS');

    // Tentativa direta no banco violando o índice parcial único deve gerar erro de integridade SQLite
    assert.throws(() => {
      db.prepare(`
        INSERT INTO tickets (
          guild_id, ticket_number, creator_id, department_id, subject, description, priority, status
        ) VALUES ('guild-alpha', 99, 'user-999', ?, 'Violacao', 'Descricao', 'normal', 'new')
      `).run(dept.id);
    }, /UNIQUE constraint failed/);

    // Mas noutro servidor, o mesmo utilizador pode ter ticket
    const deptBeta = ticketRepo.createDepartment({
      guildId: 'guild-beta',
      name: 'Dúvidas Beta',
      description: 'Dúvidas Beta',
    });
    const ticketBeta = ticketRepo.createTicketReservation({
      guildId: 'guild-beta',
      creatorId: 'user-999',
      departmentId: deptBeta.id,
      subject: 'Assunto Beta',
      description: 'Descrição no servidor Beta',
    });
    assert.ok(ticketBeta.id);

    // Se o ticket da guild-alpha for fechado, o utilizador pode abrir outro
    db.prepare("UPDATE tickets SET status = 'closed', closed_at = datetime('now') WHERE id = ?").run(ticket1.id);

    const ticketReopened = ticketRepo.createTicketReservation({
      guildId: 'guild-alpha',
      creatorId: 'user-999',
      departmentId: dept.id,
      subject: 'Novo Assunto',
      description: 'Nova descrição após fecho',
    });
    assert.ok(ticketReopened.id);
    assert.equal(ticketReopened.ticket_number, 2);

    db.close();
  });

  // 7. Consistência transacional
  test('7. Consistência transacional e eliminação segura em caso de rollback', () => {
    const db = createConnection(':memory:');
    const ticketRepo = new TicketRepository(db);

    const dept = ticketRepo.createDepartment({
      guildId: 'guild-trans',
      name: 'Suporte',
      description: 'Descrição',
    });

    // Criar reserva de ticket
    const ticket = ticketRepo.createTicketReservation({
      guildId: 'guild-trans',
      creatorId: 'user-fail',
      departmentId: dept.id,
      subject: 'Falha simulada',
      description: 'Tentativa de criar canal falhou',
    });

    assert.ok(ticket.id);
    assert.equal(ticketRepo.getActiveTicketByUser('guild-trans', 'user-fail').id, ticket.id);

    // Simular rollback ao eliminar a reserva órfã
    const deleted = ticketRepo.deleteTicket(ticket.id);
    assert.equal(deleted, true);

    // Não deve existir ticket ativo
    assert.equal(ticketRepo.getActiveTicketByUser('guild-trans', 'user-fail'), null);
    assert.equal(ticketRepo.getTicketById(ticket.id), null);

    db.close();
  });

  // 8. Custom IDs válidos e inválidos com validação estrita
  test('8. Validação e análise de Custom IDs do sistema de tickets (regras estritas)', () => {
    assert.equal(SELECT_DEPARTMENT, 'tickets:department-select');

    // Geração de customId para modal
    const modalId = createModalCustomId(42);
    assert.equal(modalId, 'tickets:create-modal:42');

    // Parse de modal válido (representação canónica de inteiro positivo seguro)
    assert.deepEqual(parseModalCustomId('tickets:create-modal:1'), { isTicketModal: true, departmentId: 1 });
    assert.deepEqual(parseModalCustomId('tickets:create-modal:42'), { isTicketModal: true, departmentId: 42 });
    assert.deepEqual(parseModalCustomId(`tickets:create-modal:${Number.MAX_SAFE_INTEGER}`), {
      isTicketModal: true,
      departmentId: Number.MAX_SAFE_INTEGER,
    });

    // Rejeições obrigatórias:
    // 1. Vazio
    assert.deepEqual(parseModalCustomId('tickets:create-modal:'), { isTicketModal: false, departmentId: null });
    // 2. Zero
    assert.deepEqual(parseModalCustomId('tickets:create-modal:0'), { isTicketModal: false, departmentId: null });
    // 3. Negativos
    assert.deepEqual(parseModalCustomId('tickets:create-modal:-1'), { isTicketModal: false, departmentId: null });
    assert.deepEqual(parseModalCustomId('tickets:create-modal:-5'), { isTicketModal: false, departmentId: null });
    // 4. Sinal positivo explícito (+1)
    assert.deepEqual(parseModalCustomId('tickets:create-modal:+1'), { isTicketModal: false, departmentId: null });
    // 5. Espaços
    assert.deepEqual(parseModalCustomId('tickets:create-modal: 42'), { isTicketModal: false, departmentId: null });
    assert.deepEqual(parseModalCustomId('tickets:create-modal:42 '), { isTicketModal: false, departmentId: null });
    assert.deepEqual(parseModalCustomId('tickets:create-modal: 42 '), { isTicketModal: false, departmentId: null });
    // 6. Zeros à esquerda (forma não-canónica: 01)
    assert.deepEqual(parseModalCustomId('tickets:create-modal:01'), { isTicketModal: false, departmentId: null });
    assert.deepEqual(parseModalCustomId('tickets:create-modal:007'), { isTicketModal: false, departmentId: null });
    // 7. Sufixos alfanuméricos (1abc)
    assert.deepEqual(parseModalCustomId('tickets:create-modal:1abc'), { isTicketModal: false, departmentId: null });
    assert.deepEqual(parseModalCustomId('tickets:create-modal:invalid'), { isTicketModal: false, departmentId: null });
    // 8. Decimais (1.0)
    assert.deepEqual(parseModalCustomId('tickets:create-modal:1.0'), { isTicketModal: false, departmentId: null });
    assert.deepEqual(parseModalCustomId('tickets:create-modal:3.14'), { isTicketModal: false, departmentId: null });
    // 9. Notação científica (1e2)
    assert.deepEqual(parseModalCustomId('tickets:create-modal:1e2'), { isTicketModal: false, departmentId: null });
    // 10. Valores acima de Number.MAX_SAFE_INTEGER
    assert.deepEqual(parseModalCustomId(`tickets:create-modal:${BigInt(Number.MAX_SAFE_INTEGER) + 1n}`), {
      isTicketModal: false,
      departmentId: null,
    });
    assert.deepEqual(parseModalCustomId('tickets:create-modal:999999999999999999999999999999'), {
      isTicketModal: false,
      departmentId: null,
    });

    // Outros tipos e prefixos diferentes
    assert.deepEqual(parseModalCustomId('admin:modal:123'), { isTicketModal: false, departmentId: null });
    assert.deepEqual(parseModalCustomId(null), { isTicketModal: false, departmentId: null });
    assert.deepEqual(parseModalCustomId(undefined), { isTicketModal: false, departmentId: null });
    assert.deepEqual(parseModalCustomId(123), { isTicketModal: false, departmentId: null });

    // Namespace check
    assert.equal(isTicketCustomId('tickets:department-select'), true);
    assert.equal(isTicketCustomId('tickets:create-modal:10'), true);
    assert.equal(isTicketCustomId('buttons:submit'), false);
    assert.equal(isTicketCustomId(null), false);

    // Validação direta do parser estrito de inteiros positivos seguros
    assert.equal(parsePositiveSafeInteger('1'), 1);
    assert.equal(parsePositiveSafeInteger('42'), 42);
    assert.equal(parsePositiveSafeInteger(String(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
    assert.equal(parsePositiveSafeInteger(42), 42);

    // Rejeições no parser estrito
    assert.equal(parsePositiveSafeInteger(''), null);
    assert.equal(parsePositiveSafeInteger('0'), null);
    assert.equal(parsePositiveSafeInteger('-1'), null);
    assert.equal(parsePositiveSafeInteger('-5'), null);
    assert.equal(parsePositiveSafeInteger('+1'), null);
    assert.equal(parsePositiveSafeInteger(' 42'), null);
    assert.equal(parsePositiveSafeInteger('42 '), null);
    assert.equal(parsePositiveSafeInteger(' 42 '), null);
    assert.equal(parsePositiveSafeInteger('01'), null);
    assert.equal(parsePositiveSafeInteger('007'), null);
    assert.equal(parsePositiveSafeInteger('1abc'), null);
    assert.equal(parsePositiveSafeInteger('invalid'), null);
    assert.equal(parsePositiveSafeInteger('1.0'), null);
    assert.equal(parsePositiveSafeInteger('3.14'), null);
    assert.equal(parsePositiveSafeInteger('1e2'), null);
    assert.equal(parsePositiveSafeInteger(String(BigInt(Number.MAX_SAFE_INTEGER) + 1n)), null);
    assert.equal(parsePositiveSafeInteger('999999999999999999999999999999'), null);
    assert.equal(parsePositiveSafeInteger(null), null);
    assert.equal(parsePositiveSafeInteger(undefined), null);
    assert.equal(parsePositiveSafeInteger({}), null);
    assert.equal(parsePositiveSafeInteger([]), null);
  });

  // 9. Configuração específica versus fallback global
  test('9. Configuração específica de departamento com fallback para configuração global', () => {
    const db = createConnection(':memory:');
    const settingsRepo = new SettingsRepository(db);
    const ticketRepo = new TicketRepository(db);
    const settingsService = new SettingsService(settingsRepo, ticketRepo);

    const guildId = 'guild-fallback-test';

    // Configuração global da guild
    settingsService.updateSettings(
      guildId,
      {
        categoryId: 'global-cat-999',
        logChannelId: 'global-log-888',
        defaultStaffRoleId: 'global-role-777',
        panelTitle: 'Painel Geral',
        panelColor: '#5865F2',
      },
      'admin-actor'
    );

    // Departamento 1: sem configurações específicas (deve herdar tudo da global)
    const dept1 = settingsService.addDepartment(
      guildId,
      { name: 'Geral', description: 'Geral sem overrides' },
      'admin-actor'
    );

    // Departamento 2: com overrides específicos de categoria e cargo
    const dept2 = settingsService.addDepartment(
      guildId,
      {
        name: 'Financeiro',
        description: 'Assuntos financeiros com override',
        categoryId: 'specific-cat-123',
        staffRoleId: 'specific-role-456',
      },
      'admin-actor'
    );

    const departments = settingsService.listDepartments(guildId, true);
    assert.equal(departments.length, 2);

    const d1 = departments.find((d) => d.id === dept1.id);
    const d2 = departments.find((d) => d.id === dept2.id);

    // Dept 1 herda global
    assert.equal(d1.effectiveCategoryId, 'global-cat-999');
    assert.equal(d1.effectiveStaffRoleId, 'global-role-777');
    assert.equal(d1.inheritsCategory, true);
    assert.equal(d1.inheritsStaffRole, true);

    // Dept 2 usa específicos
    assert.equal(d2.effectiveCategoryId, 'specific-cat-123');
    assert.equal(d2.effectiveStaffRoleId, 'specific-role-456');
    assert.equal(d2.inheritsCategory, false);
    assert.equal(d2.inheritsStaffRole, false);

    // Auditoria de eventos registada
    const events = ticketRepo.getEventsByGuild(guildId);
    assert.ok(events.length >= 3, 'Devem existir eventos registados para settings_updated e department_created');
    assert.ok(events.some((e) => e.event_type === 'settings_updated'));
    assert.ok(events.some((e) => e.event_type === 'department_created'));

    db.close();
  });

  // 10. Validação de emojis seguros (Unicode e Custom Discord)
  test('10. Validação estrita de emojis Unicode e custom Discord (válidos e inválidos)', () => {
    // Válidos: Unicode simples e compostos (ZWJ, flags, skin tones, keycaps)
    assert.equal(isValidEmoji('💬'), true);
    assert.equal(isValidEmoji('🛠️'), true);
    assert.equal(isValidEmoji('💰'), true);
    assert.equal(isValidEmoji('🇧🇷'), true);
    assert.equal(isValidEmoji('👨‍👩‍👧‍👦'), true);
    assert.equal(isValidEmoji('👍🏻'), true);
    assert.equal(isValidEmoji('1️⃣'), true);
    assert.equal(isValidEmoji('⭐'), true);
    assert.equal(isValidEmoji('🎫'), true);

    // Válidos: Custom Discord emojis completos com sintaxe real
    assert.equal(isValidEmoji('<:custom_emoji:123456789012345678>'), true);
    assert.equal(isValidEmoji('<a:animated_emoji:123456789012345678>'), true);
    assert.equal(isValidEmoji('<custom:123456789012345678>'), true);

    // Inválidos: texto comum, números puros, caracteres individuais
    assert.equal(isValidEmoji('texto'), false);
    assert.equal(isValidEmoji('123'), false);
    assert.equal(isValidEmoji('a'), false);
    assert.equal(isValidEmoji(''), false);
    assert.equal(isValidEmoji('   '), false);
    assert.equal(isValidEmoji(null), false);
    assert.equal(isValidEmoji(undefined), false);

    // Inválidos: múltiplos emojis ou emoji misturado com texto
    assert.equal(isValidEmoji('💬💬'), false);
    assert.equal(isValidEmoji('💬 🛠️'), false);
    assert.equal(isValidEmoji('hello 💬'), false);
    assert.equal(isValidEmoji('💬 world'), false);

    // Inválidos: custom emojis malformados
    assert.equal(isValidEmoji('<:invalid:>'), false);
    assert.equal(isValidEmoji('<custom>'), false);
    assert.equal(isValidEmoji('<:emoji:abc>'), false);
    assert.equal(isValidEmoji('<a:bad:123>'), false);
    assert.equal(isValidEmoji('<>'), false);
  });

  // 11. Construtor do painel ignora com segurança emojis legados inválidos
  test('11. O construtor do painel ignora com segurança emojis legados inválidos sem lançar exceção', () => {
    const departmentsWithInvalidEmoji = [
      { id: 1, name: 'Geral', description: 'Departamento 1', emoji: 'emoji_invalido_texto' },
      { id: 2, name: 'Vendas', description: 'Departamento 2', emoji: '💬💬' },
      { id: 3, name: 'Técnico', description: 'Departamento 3', emoji: '🛠️' },
    ];

    assert.doesNotThrow(() => {
      const row = getDepartmentSelectRow(departmentsWithInvalidEmoji);
      assert.ok(row);
      assert.equal(row.components.length, 1);
      const select = row.components[0];
      assert.equal(select.options.length, 3);
    });
  });

  // 12. Rejeição estrita de @everyone (Privacidade)
  test('12. Rejeição de @everyone como cargo global e como cargo específico de departamento', () => {
    const db = createConnection(':memory:');
    const settingsRepo = new SettingsRepository(db);
    const ticketRepo = new TicketRepository(db);
    const settingsService = new SettingsService(settingsRepo, ticketRepo);

    const guildId = '123456789012345678';

    // Rejeitar @everyone como cargo global (por ID da guild ou nome literal)
    assert.throws(() => {
      settingsService.updateSettings(guildId, { defaultStaffRoleId: guildId }, 'admin-actor');
    }, (err) => err.code === 'INVALID_STAFF_ROLE');

    assert.throws(() => {
      settingsService.updateSettings(guildId, { defaultStaffRoleId: '@everyone' }, 'admin-actor');
    }, (err) => err.code === 'INVALID_STAFF_ROLE');

    // Rejeitar @everyone como cargo de departamento
    assert.throws(() => {
      settingsService.addDepartment(
        guildId,
        { name: 'Dept Inválido', description: 'Desc', staffRoleId: guildId },
        'admin-actor'
      );
    }, (err) => err.code === 'INVALID_STAFF_ROLE');

    assert.throws(() => {
      settingsService.addDepartment(
        guildId,
        { name: 'Dept Inválido 2', description: 'Desc', staffRoleId: '@everyone' },
        'admin-actor'
      );
    }, (err) => err.code === 'INVALID_STAFF_ROLE');

    db.close();
  });

  // 13. Cargo de suporte obrigatório no ticketService
  test('13. Cargo de suporte obrigatório: bloqueio e erro antes da reserva se ausente ou apagado', async () => {
    const db = createConnection(':memory:');
    const ticketRepo = new TicketRepository(db);
    const settingsRepo = new SettingsRepository(db);
    const service = new TicketService(ticketRepo, settingsRepo, permissionService);

    const guildId = 'guild-role-test';
    const dept = ticketRepo.createDepartment({
      guildId,
      name: 'Suporte Geral',
      description: 'Atendimento geral',
    });

    // Cenário A: Nenhum cargo configurado
    const mockGuildWithoutRoles = {
      id: guildId,
      roles: { cache: new Map() },
      channels: { cache: new Map() },
      members: { me: { permissions: { has: () => true } } },
    };

    await assert.rejects(async () => {
      await service.createTicket({
        guild: mockGuildWithoutRoles,
        user: { id: 'user-a', username: 'alice', tag: 'alice#0001' },
        departmentId: dept.id,
        subject: 'Dúvida importante',
        description: 'Descrição detalhada com mais de 10 caracteres',
      });
    }, (err) => err.code === 'STAFF_ROLE_NOT_CONFIGURED');

    // Cenário B: Cargo configurado mas apagado do Discord
    settingsRepo.upsertGuildSettings(guildId, { defaultStaffRoleId: 'role-apagado-999' });

    await assert.rejects(async () => {
      await service.createTicket({
        guild: mockGuildWithoutRoles,
        user: { id: 'user-b', username: 'bob', tag: 'bob#0002' },
        departmentId: dept.id,
        subject: 'Dúvida importante',
        description: 'Descrição detalhada com mais de 10 caracteres',
      });
    }, (err) => err.code === 'STAFF_ROLE_NOT_FOUND');

    // Cenário C: Cargo configurado é @everyone
    settingsRepo.upsertGuildSettings(guildId, { defaultStaffRoleId: guildId });
    const mockGuildWithEveryone = {
      id: guildId,
      roles: {
        cache: new Map([[guildId, { id: guildId, name: '@everyone' }]]),
        everyone: { id: guildId },
      },
      channels: { cache: new Map() },
      members: { me: { permissions: { has: () => true } } },
    };

    await assert.rejects(async () => {
      await service.createTicket({
        guild: mockGuildWithEveryone,
        user: { id: 'user-c', username: 'charlie', tag: 'charlie#0003' },
        departmentId: dept.id,
        subject: 'Dúvida importante',
        description: 'Descrição detalhada com mais de 10 caracteres',
      });
    }, (err) => err.code === 'STAFF_ROLE_INVALID');

    // Garantir que NENHUMA reserva foi feita na base de dados
    assert.equal(ticketRepo.getActiveTicketByUser(guildId, 'user-a'), null);
    assert.equal(ticketRepo.getActiveTicketByUser(guildId, 'user-b'), null);
    assert.equal(ticketRepo.getActiveTicketByUser(guildId, 'user-c'), null);

    db.close();
  });

  // 14. Permissões efetivas na categoria
  test('14. Validação em memória de permissões efetivas na categoria (ViewChannel e ManageChannels)', () => {
    const mockMe = { id: 'bot-me' };

    // Categoria com todas as permissões
    const mockCategoryAllowed = {
      permissionsFor: (member) => ({
        has: (flag) => [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels].includes(flag),
      }),
    };
    const allowResult = permissionService.checkCategoryPermissions(mockCategoryAllowed, mockMe);
    assert.equal(allowResult.hasPermissions, true);
    assert.equal(allowResult.missing.length, 0);

    // Categoria sem ManageChannels
    const mockCategoryMissingManage = {
      permissionsFor: (member) => ({
        has: (flag) => flag === PermissionFlagsBits.ViewChannel,
      }),
    };
    const denyResult = permissionService.checkCategoryPermissions(mockCategoryMissingManage, mockMe);
    assert.equal(denyResult.hasPermissions, false);
    assert.ok(denyResult.missing.some((m) => m.includes('ManageChannels')));

    // Categoria sem ViewChannel
    const mockCategoryMissingView = {
      permissionsFor: (member) => ({
        has: (flag) => flag === PermissionFlagsBits.ManageChannels,
      }),
    };
    const denyViewResult = permissionService.checkCategoryPermissions(mockCategoryMissingView, mockMe);
    assert.equal(denyViewResult.hasPermissions, false);
    assert.ok(denyViewResult.missing.some((m) => m.includes('ViewChannel')));
  });

  // 15. Compensação caso o envio da mensagem inicial falhe
  test('15. Compensação transacional e eliminação de canal se a mensagem inicial falhar', async () => {
    const db = createConnection(':memory:');
    const ticketRepo = new TicketRepository(db);
    const settingsRepo = new SettingsRepository(db);
    const service = new TicketService(ticketRepo, settingsRepo, permissionService);

    const guildId = 'guild-comp-test';
    const staffRoleId = 'role-staff-valid';
    const logChannelId = 'log-channel-999';
    settingsRepo.upsertGuildSettings(guildId, {
      defaultStaffRoleId: staffRoleId,
      logChannelId,
    });

    const dept = ticketRepo.createDepartment({
      guildId,
      name: 'Suporte Técnico',
      description: 'Atendimento a incidentes',
    });

    let channelDeleted = false;
    let deleteReason = '';
    const mockCreatedChannel = {
      id: 'chan-created-999',
      send: async () => {
        throw new Error('DiscordAPIError: Missing Permissions to send messages');
      },
      delete: async (reason) => {
        channelDeleted = true;
        deleteReason = reason;
      },
    };

    let logMessageSent = false;
    const mockLogChannel = {
      id: logChannelId,
      isTextBased: () => true,
      send: async () => {
        logMessageSent = true;
      },
    };

    const mockGuild = {
      id: guildId,
      client: { user: { id: 'bot-123' } },
      roles: {
        cache: new Map([[staffRoleId, { id: staffRoleId, name: 'Equipa' }]]),
        everyone: { id: guildId },
      },
      channels: {
        cache: new Map([[logChannelId, mockLogChannel]]),
        create: async () => mockCreatedChannel,
      },
      members: {
        me: {
          permissions: { has: () => true },
        },
      },
    };

    await assert.rejects(async () => {
      await service.createTicket({
        guild: mockGuild,
        user: { id: 'user-fail-send', username: 'daniela', tag: 'daniela#0004' },
        departmentId: dept.id,
        subject: 'Falha simulada de mensagem',
        description: 'Tentativa onde channel.send falha após criação do canal',
      });
    }, (err) => err.code === 'TICKET_INITIALIZATION_FAILED');

    // 1. Canal do Discord deve ter sido apagado
    assert.equal(channelDeleted, true);
    assert.ok(deleteReason.includes('Falha'));

    // 2. Não deve haver ticket ativo para o utilizador na base de dados
    assert.equal(ticketRepo.getActiveTicketByUser(guildId, 'user-fail-send'), null);

    // 3. O registo na tabela tickets deve ter sido removido (rollback completo)
    const ticketCount = db.prepare('SELECT COUNT(*) AS total FROM tickets WHERE guild_id = ?').get(guildId).total;
    assert.equal(ticketCount, 0);

    // 4. Evento ticket_created NÃO deve ter sido emitido
    const events = ticketRepo.getEventsByGuild(guildId);
    const createdEvents = events.filter((e) => e.event_type === 'ticket_created');
    assert.equal(createdEvents.length, 0);

    // 5. Nenhum log externo deve ter sido enviado
    assert.equal(logMessageSent, false);

    db.close();
  });

  // 16. Mapeamento de erros públicos em interactionCreate
  test('16. Exposição de erros públicos em interactionCreate restrita aos códigos autorizados', async () => {
    const interactionCreate = require('../src/events/interactionCreate');
    const ticketServiceInstance = require('../src/services/ticketService');

    const testCases = [
      {
        errorCode: 'ACTIVE_TICKET_EXISTS',
        errorMessage: 'Já tens um ticket aberto',
        expectedFragment: 'Já tens um ticket aberto neste servidor',
      },
      {
        errorCode: 'COOLDOWN',
        errorMessage: 'Por favor aguarda 4s antes de tentar abrir outro ticket.',
        expectedFragment: 'Por favor aguarda 4s antes de tentar abrir outro ticket.',
      },
      {
        errorCode: 'CONCURRENT_REQUEST',
        errorMessage: 'Concorrência',
        expectedFragment: 'Já tens um pedido de abertura de ticket em processamento',
      },
      {
        errorCode: 'STAFF_ROLE_NOT_CONFIGURED',
        errorMessage: 'Sem cargo',
        expectedFragment: 'O cargo da equipa de suporte não está configurado',
      },
      {
        errorCode: 'STAFF_ROLE_NOT_FOUND',
        errorMessage: 'Cargo apagado',
        expectedFragment: 'O cargo da equipa de suporte configurado foi eliminado do servidor',
      },
      {
        errorCode: 'INSUFFICIENT_CATEGORY_PERMISSIONS',
        errorMessage: 'Faltam perms',
        expectedFragment: 'O bot não possui as permissões necessárias na categoria de tickets',
      },
      {
        errorCode: 'TICKET_INITIALIZATION_FAILED',
        errorMessage: 'Falha inicial',
        expectedFragment: 'Não foi possível inicializar a conversa do ticket',
      },
      // Erros NÃO autorizados devem receber mensagem genérica SEM vazar error.message
      {
        errorCode: 'VALIDATION_ERROR',
        errorMessage: 'Assunto inválido com segredos internos',
        expectedFragment: 'Ocorreu um erro interno ao processar o teu ticket',
        mustNotContain: 'Assunto inválido com segredos internos',
      },
      {
        errorCode: 'UNKNOWN_DB_CRASH',
        errorMessage: 'SQLITE_BUSY: database is locked',
        expectedFragment: 'Ocorreu um erro interno ao processar o teu ticket',
        mustNotContain: 'SQLITE_BUSY',
      },
    ];

    const originalCreateTicket = ticketServiceInstance.createTicket;

    for (const tc of testCases) {
      let replyContent = '';
      const mockInteraction = {
        isChatInputCommand: () => false,
        isAutocomplete: () => false,
        isStringSelectMenu: () => false,
        isModalSubmit: () => true,
        isButton: () => false,
        customId: createModalCustomId(1),
        fields: {
          getTextInputValue: (field) => {
            if (field === INPUT_SUBJECT) return 'Assunto';
            if (field === INPUT_DESCRIPTION) return 'Descrição com tamanho válido';
            return null;
          },
        },
        deferReply: async () => {},
        editReply: async (payload) => {
          replyContent = payload.content;
        },
      };

      ticketServiceInstance.createTicket = async () => {
        const err = new Error(tc.errorMessage);
        err.code = tc.errorCode;
        throw err;
      };

      await interactionCreate.execute(mockInteraction, null);

      assert.ok(
        replyContent.includes(tc.expectedFragment),
        `Esperava encontrar "${tc.expectedFragment}" no erro ${tc.errorCode}, obteve: "${replyContent}"`
      );

      if (tc.mustNotContain) {
        assert.ok(
          !replyContent.includes(tc.mustNotContain),
          `Não devia vazar "${tc.mustNotContain}" na mensagem pública, obteve: "${replyContent}"`
        );
      }
    }

    // Restaurar método original
    ticketServiceInstance.createTicket = originalCreateTicket;
  });

  // 17. Handler do select de departamentos em interactionCreate com validação estrita
  test('17. Validação estrita do handler do select de departamentos em interactionCreate', async () => {
    const interactionCreate = require('../src/events/interactionCreate');
    const ticketRepo = require('../src/repositories/ticketRepository');

    // 1. Valores parciais e inválidos (ex.: '1abc', '0', negativos, decimais, espaços)
    const invalidSelectValues = [
      '1abc',
      '0',
      '-1',
      '-5',
      '+1',
      ' 42',
      '42 ',
      '01',
      '007',
      '1.0',
      '3.14',
      '1e2',
      'invalid',
      '999999999999999999999999999999',
    ];

    for (const invalidVal of invalidSelectValues) {
      let repliedMessage = null;
      let isEphemeral = false;

      const mockInteraction = {
        isChatInputCommand: () => false,
        isAutocomplete: () => false,
        isStringSelectMenu: () => true,
        isModalSubmit: () => false,
        isButton: () => false,
        customId: SELECT_DEPARTMENT,
        values: [invalidVal],
        guildId: 'guild-select-test',
        reply: async (payload) => {
          repliedMessage = payload.content;
          isEphemeral = payload.ephemeral;
        },
      };

      await interactionCreate.execute(mockInteraction, null);

      assert.equal(
        repliedMessage,
        '❌ Departamento inválido selecionado.',
        `Esperava "❌ Departamento inválido selecionado." para o valor "${invalidVal}", obteve: "${repliedMessage}"`
      );
      assert.equal(isEphemeral, true);
    }

    // 2. ID válido mas departamento inexistente/inativo
    const originalGetDept = ticketRepo.getDepartmentById;
    try {
      ticketRepo.getDepartmentById = () => null;

      let notFoundMessage = null;
      const mockNotFoundInteraction = {
        isChatInputCommand: () => false,
        isAutocomplete: () => false,
        isStringSelectMenu: () => true,
        isModalSubmit: () => false,
        isButton: () => false,
        customId: SELECT_DEPARTMENT,
        values: ['9999'],
        guildId: 'guild-select-test',
        reply: async (payload) => {
          notFoundMessage = payload.content;
        },
      };

      await interactionCreate.execute(mockNotFoundInteraction, null);
      assert.equal(notFoundMessage, '❌ O departamento selecionado já não se encontra disponível.');

      // 3. ID válido e departamento ativo: deve apresentar o modal com customId correto
      let shownModal = null;
      ticketRepo.getDepartmentById = (id, guildId) => {
        if (id === 42 && guildId === 'guild-select-test') {
          return { id: 42, name: 'Dúvidas Gerais', description: 'Ajuda', active: 1 };
        }
        return null;
      };

      const mockValidInteraction = {
        isChatInputCommand: () => false,
        isAutocomplete: () => false,
        isStringSelectMenu: () => true,
        isModalSubmit: () => false,
        isButton: () => false,
        customId: SELECT_DEPARTMENT,
        values: ['42'],
        guildId: 'guild-select-test',
        showModal: async (modal) => {
          shownModal = modal;
        },
      };

      await interactionCreate.execute(mockValidInteraction, null);
      assert.ok(shownModal, 'Deveria ter chamado showModal');
      assert.equal(shownModal.data.custom_id, createModalCustomId(42));
    } finally {
      ticketRepo.getDepartmentById = originalGetDept;
    }
  });
});

describe('Sistema de Tickets - Bloco 2A', () => {
  const {
    BUTTON_CLAIM,
    BUTTON_RELEASE,
    SELECT_STATUS,
    SELECT_PRIORITY,
  } = require('../src/utils/ticketCustomIds');
  const { buildTicketPanelPayload } = require('../src/components/tickets/ticketPanel');
  const interactionCreate = require('../src/events/interactionCreate');
  const defaultTicketRepo = require('../src/repositories/ticketRepository');
  const defaultSettingsRepo = require('../src/repositories/settingsRepository');
  const defaultTicketService = require('../src/services/ticketService');
  const logger = require('../src/utils/logger');

  // 1. Migração de schema legado da Entrega 1 adiciona control_message_id sem perder dados e é idempotente
  test('18. Migração de schema legado da Entrega 1 adiciona control_message_id sem perder dados e é idempotente', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');

    // Criar tabelas com o schema legado da Entrega 1 (sem a coluna control_message_id)
    db.exec(`
      CREATE TABLE IF NOT EXISTS guild_settings (
        guild_id TEXT PRIMARY KEY,
        ticket_category_id TEXT,
        log_channel_id TEXT,
        default_staff_role_id TEXT,
        panel_title TEXT,
        panel_description TEXT,
        panel_color TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS ticket_departments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        emoji TEXT,
        staff_role_id TEXT,
        category_id TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        ticket_number INTEGER NOT NULL,
        creator_id TEXT NOT NULL,
        department_id INTEGER NOT NULL REFERENCES ticket_departments(id),
        channel_id TEXT,
        subject TEXT NOT NULL,
        description TEXT NOT NULL,
        reference TEXT,
        priority TEXT NOT NULL DEFAULT 'normal',
        status TEXT NOT NULL DEFAULT 'new',
        claimed_by TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        closed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS ticket_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
        guild_id TEXT,
        event_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        metadata_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    // Inserir registos pré-existentes na base de dados legada
    db.exec(`
      INSERT INTO ticket_departments (id, guild_id, name, description)
      VALUES (1, 'guild-legacy-1', 'Suporte Técnico', 'Apoio geral');

      INSERT INTO tickets (id, guild_id, ticket_number, creator_id, department_id, channel_id, subject, description, priority, status)
      VALUES (1, 'guild-legacy-1', 42, 'user-legacy-author', 1, 'chan-leg-42', 'Dúvida antiga', 'Descrição detalhada antes da migração', 'high', 'new');
    `);

    // Confirmar ausência da coluna control_message_id no schema inicial
    const colsBefore = db.prepare('PRAGMA table_info(tickets)').all().map((c) => c.name);
    assert.equal(colsBefore.includes('control_message_id'), false, 'Schema legado não deve possuir control_message_id');

    // 1ª execução das migrações
    assert.doesNotThrow(() => {
      runMigrations(db);
    });

    // Validar adição da coluna
    const colsAfterFirst = db.prepare('PRAGMA table_info(tickets)').all().map((c) => c.name);
    assert.equal(colsAfterFirst.includes('control_message_id'), true, 'Coluna control_message_id deve ter sido adicionada');

    // Validar integridade dos dados existentes
    const rowAfterFirst = db.prepare('SELECT * FROM tickets WHERE id = 1').get();
    assert.equal(rowAfterFirst.guild_id, 'guild-legacy-1');
    assert.equal(rowAfterFirst.ticket_number, 42);
    assert.equal(rowAfterFirst.creator_id, 'user-legacy-author');
    assert.equal(rowAfterFirst.subject, 'Dúvida antiga');
    assert.equal(rowAfterFirst.description, 'Descrição detalhada antes da migração');
    assert.equal(rowAfterFirst.priority, 'high');
    assert.equal(rowAfterFirst.status, 'new');
    assert.equal(rowAfterFirst.control_message_id, null);

    // 2ª execução das migrações (garantir idempotência sem erro)
    assert.doesNotThrow(() => {
      runMigrations(db);
    });

    const rowAfterSecond = db.prepare('SELECT * FROM tickets WHERE id = 1').get();
    assert.equal(rowAfterSecond.subject, 'Dúvida antiga');

    // Confirmar que a nova coluna aceita atualizações normalmente
    db.prepare('UPDATE tickets SET control_message_id = ? WHERE id = 1').run('msg-control-leg-999');
    const rowUpdated = db.prepare('SELECT control_message_id FROM tickets WHERE id = 1').get();
    assert.equal(rowUpdated.control_message_id, 'msg-control-leg-999');

    db.close();
  });

  // 2. setControlMessageId persiste e respeita guildId
  test('19. setControlMessageId persiste e respeita guildId', () => {
    const db = createConnection(':memory:');
    runMigrations(db);
    const ticketRepo = new TicketRepository(db);

    const guildA = 'guild-alpha';
    const guildB = 'guild-beta';

    const deptA = ticketRepo.createDepartment({ guildId: guildA, name: 'Dept A', description: 'Desc A' });
    const deptB = ticketRepo.createDepartment({ guildId: guildB, name: 'Dept B', description: 'Desc B' });

    const ticketA = ticketRepo.createTicketReservation({
      guildId: guildA,
      creatorId: 'user-a',
      departmentId: deptA.id,
      subject: 'Problema A',
      description: 'Desc A',
    });

    const ticketB = ticketRepo.createTicketReservation({
      guildId: guildB,
      creatorId: 'user-b',
      departmentId: deptB.id,
      subject: 'Problema B',
      description: 'Desc B',
    });

    // Atualização com guildId correspondente: sucesso
    const updateSuccess = ticketRepo.setControlMessageId(ticketA.id, 'ctrl-msg-alpha-100', guildA);
    assert.equal(updateSuccess, true);

    const fetchedA = ticketRepo.getTicketById(ticketA.id, guildA);
    assert.equal(fetchedA.control_message_id, 'ctrl-msg-alpha-100');

    // Atualização com guildId divergente: não afeta o registo e retorna false
    const updateWrongGuild = ticketRepo.setControlMessageId(ticketA.id, 'ctrl-msg-hacked', guildB);
    assert.equal(updateWrongGuild, false);

    const fetchedAAfter = ticketRepo.getTicketById(ticketA.id, guildA);
    assert.equal(fetchedAAfter.control_message_id, 'ctrl-msg-alpha-100', 'Valor original não deve ser adulterado');

    // Atualização para ticket inexistente
    const updateNonExistent = ticketRepo.setControlMessageId(99999, 'ctrl-msg-xyz', guildA);
    assert.equal(updateNonExistent, false);

    // Atualização sem parâmetro guildId (chamada de repositório geral)
    const updateWithoutGuild = ticketRepo.setControlMessageId(ticketB.id, 'ctrl-msg-beta-200');
    assert.equal(updateWithoutGuild, true);
    const fetchedB = ticketRepo.getTicketById(ticketB.id, guildB);
    assert.equal(fetchedB.control_message_id, 'ctrl-msg-beta-200');

    db.close();
  });

  // 3. claim: sucesso; mesmo atendente idempotente sem evento extra; outro atendente recebe conflito; guild errada não acede
  test('20. claim: sucesso; mesmo atendente idempotente sem evento extra; outro atendente recebe conflito; guild errada não acede', () => {
    const db = createConnection(':memory:');
    runMigrations(db);
    const ticketRepo = new TicketRepository(db);

    const guildId = 'guild-claim-test';
    const dept = ticketRepo.createDepartment({ guildId, name: 'Geral', description: 'Desc' });
    const ticket = ticketRepo.createTicketReservation({
      guildId,
      creatorId: 'user-client-1',
      departmentId: dept.id,
      subject: 'Ajuda',
      description: 'Preciso de ajuda urgente',
    });

    // 1. Sucesso na primeira atribuição
    const claimRes1 = ticketRepo.claimTicket({
      ticketId: ticket.id,
      staffUserId: 'staff-user-1',
      guildId,
    });

    assert.equal(claimRes1.ticket.status, 'assigned');
    assert.equal(claimRes1.ticket.claimed_by, 'staff-user-1');
    assert.equal(claimRes1.alreadyClaimedBySelf, false);
    assert.ok(claimRes1.event);
    assert.equal(claimRes1.event.event_type, 'ticket_claimed');
    assert.equal(claimRes1.event.actor_id, 'staff-user-1');

    const eventsAfterFirst = ticketRepo.getEventsByTicket(ticket.id);
    assert.equal(eventsAfterFirst.length, 1);

    // 2. Idempotência: mesmo atendente volta a assumir
    const claimRes2 = ticketRepo.claimTicket({
      ticketId: ticket.id,
      staffUserId: 'staff-user-1',
      guildId,
    });

    assert.equal(claimRes2.ticket.status, 'assigned');
    assert.equal(claimRes2.ticket.claimed_by, 'staff-user-1');
    assert.equal(claimRes2.alreadyClaimedBySelf, true);
    assert.equal(claimRes2.event, null);

    // Nenhum evento duplicado gerado
    const eventsAfterSecond = ticketRepo.getEventsByTicket(ticket.id);
    assert.equal(eventsAfterSecond.length, 1);

    // 3. Conflito: outro atendente tenta assumir
    assert.throws(
      () => {
        ticketRepo.claimTicket({
          ticketId: ticket.id,
          staffUserId: 'staff-user-2',
          guildId,
        });
      },
      (err) => {
        assert.equal(err.code, 'ALREADY_CLAIMED_BY_OTHER');
        assert.equal(err.claimedBy, 'staff-user-1');
        return true;
      }
    );

    const ticketAfterConflict = ticketRepo.getTicketById(ticket.id, guildId);
    assert.equal(ticketAfterConflict.claimed_by, 'staff-user-1');
    assert.equal(ticketRepo.getEventsByTicket(ticket.id).length, 1);

    // 4. Guild errada não tem acesso
    assert.throws(
      () => {
        ticketRepo.claimTicket({
          ticketId: ticket.id,
          staffUserId: 'staff-user-1',
          guildId: 'guild-other',
        });
      },
      (err) => {
        assert.equal(err.code, 'TICKET_NOT_FOUND');
        return true;
      }
    );

    db.close();
  });

  // 4. release: responsável; outro staff negado; admin permitido; resolved não pode ser libertado
  test('21. release: responsável; outro staff negado; admin permitido; resolved não pode ser libertado', () => {
    const db = createConnection(':memory:');
    runMigrations(db);
    const ticketRepo = new TicketRepository(db);

    const guildId = 'guild-release-test';
    const dept = ticketRepo.createDepartment({ guildId, name: 'Geral', description: 'Desc' });
    const ticket = ticketRepo.createTicketReservation({
      guildId,
      creatorId: 'user-client-1',
      departmentId: dept.id,
      subject: 'Problema',
      description: 'Descrição de teste',
    });

    ticketRepo.claimTicket({ ticketId: ticket.id, staffUserId: 'staff-claimant', guildId });

    // 1. Outro staff não admin tenta libertar: negado
    assert.throws(
      () => {
        ticketRepo.releaseTicket({
          ticketId: ticket.id,
          actorId: 'staff-intruder',
          isAdmin: false,
          guildId,
        });
      },
      (err) => {
        assert.equal(err.code, 'FORBIDDEN_NOT_CLAIMANT');
        return true;
      }
    );

    // 2. Responsável liberta o ticket com sucesso
    const releaseRes1 = ticketRepo.releaseTicket({
      ticketId: ticket.id,
      actorId: 'staff-claimant',
      isAdmin: false,
      guildId,
    });

    assert.equal(releaseRes1.ticket.status, 'new');
    assert.equal(releaseRes1.ticket.claimed_by, null);
    assert.equal(releaseRes1.event.event_type, 'ticket_released');
    assert.equal(releaseRes1.event.actor_id, 'staff-claimant');

    // 3. Ticket não atribuído não pode ser libertado
    assert.throws(
      () => {
        ticketRepo.releaseTicket({
          ticketId: ticket.id,
          actorId: 'staff-claimant',
          isAdmin: false,
          guildId,
        });
      },
      (err) => {
        assert.equal(err.code, 'TICKET_NOT_CLAIMED');
        return true;
      }
    );

    // 4. Admin permitido libertar ticket mesmo sem ser o responsável
    ticketRepo.claimTicket({ ticketId: ticket.id, staffUserId: 'staff-claimant', guildId });
    const releaseResAdmin = ticketRepo.releaseTicket({
      ticketId: ticket.id,
      actorId: 'admin-superuser',
      isAdmin: true,
      guildId,
    });
    assert.equal(releaseResAdmin.ticket.status, 'new');
    assert.equal(releaseResAdmin.ticket.claimed_by, null);
    assert.equal(releaseResAdmin.event.actor_id, 'admin-superuser');

    // 5. Ticket no estado resolved não pode ser libertado sem ser reaberto previamente
    ticketRepo.claimTicket({ ticketId: ticket.id, staffUserId: 'staff-claimant', guildId });
    ticketRepo.updateTicketStatus({
      ticketId: ticket.id,
      newStatus: 'resolved',
      actorId: 'staff-claimant',
      isAdmin: false,
      guildId,
    });

    assert.throws(
      () => {
        ticketRepo.releaseTicket({
          ticketId: ticket.id,
          actorId: 'staff-claimant',
          isAdmin: true,
          guildId,
        });
      },
      (err) => {
        assert.equal(err.code, 'CANNOT_RELEASE_RESOLVED');
        return true;
      }
    );

    db.close();
  });

  // 5. Estados: cobrir todas transições válidas e negar pelo menos new->resolved, in_progress->assigned, resolved->waiting_customer; exigir claimed_by; idempotência sem evento duplicado
  test('22. Estados: cobrir todas transições válidas e negar pelo menos new->resolved, in_progress->assigned, resolved->waiting_customer; exigir claimed_by; idempotência sem evento duplicado', () => {
    const db = createConnection(':memory:');
    runMigrations(db);
    const ticketRepo = new TicketRepository(db);

    const guildId = 'guild-states-matrix-test';
    const dept = ticketRepo.createDepartment({ guildId, name: 'Geral', description: 'Desc' });

    // 1. Exigir claimed_by para alteração de estado
    const ticketNew = ticketRepo.createTicketReservation({
      guildId,
      creatorId: 'user-1',
      departmentId: dept.id,
      subject: 'Assunto',
      description: 'Descricao',
    });

    assert.throws(
      () => {
        ticketRepo.updateTicketStatus({
          ticketId: ticketNew.id,
          newStatus: 'assigned',
          actorId: 'staff-1',
          isAdmin: false,
          guildId,
        });
      },
      (err) => {
        assert.equal(err.code, 'TICKET_NOT_CLAIMED');
        return true;
      }
    );

    // 2. Negar new -> resolved
    assert.throws(
      () => {
        ticketRepo.updateTicketStatus({
          ticketId: ticketNew.id,
          newStatus: 'resolved',
          actorId: 'staff-1',
          isAdmin: false,
          guildId,
        });
      },
      (err) => {
        assert.equal(err.code, 'INVALID_STATUS_TRANSITION');
        return true;
      }
    );

    // 3. Negar new -> in_progress
    assert.throws(
      () => {
        ticketRepo.updateTicketStatus({
          ticketId: ticketNew.id,
          newStatus: 'in_progress',
          actorId: 'staff-1',
          isAdmin: false,
          guildId,
        });
      },
      (err) => {
        assert.equal(err.code, 'INVALID_STATUS_TRANSITION');
        return true;
      }
    );

    // Cobertura completa das transições válidas da matriz:
    const ticketA = ticketRepo.createTicketReservation({
      guildId,
      creatorId: 'user-2',
      departmentId: dept.id,
      subject: 'Ticket Fluxo A',
      description: 'Descricao do ticket',
    });
    ticketRepo.claimTicket({ ticketId: ticketA.id, staffUserId: 'staff-1', guildId });
    assert.equal(ticketRepo.getTicketById(ticketA.id, guildId).status, 'assigned');

    // Transição: assigned -> in_progress (VÁLIDA)
    const tAssignedToInProg = ticketRepo.updateTicketStatus({
      ticketId: ticketA.id,
      newStatus: 'in_progress',
      actorId: 'staff-1',
      isAdmin: false,
      guildId,
    });
    assert.equal(tAssignedToInProg.ticket.status, 'in_progress');
    assert.equal(tAssignedToInProg.unchanged, false);

    // Idempotência em in_progress: sem evento duplicado
    const eventsBeforeIdempotent = ticketRepo.getEventsByTicket(ticketA.id).length;
    const tIdempotent = ticketRepo.updateTicketStatus({
      ticketId: ticketA.id,
      newStatus: 'in_progress',
      actorId: 'staff-1',
      isAdmin: false,
      guildId,
    });
    assert.equal(tIdempotent.unchanged, true);
    assert.equal(tIdempotent.event, null);
    assert.equal(ticketRepo.getEventsByTicket(ticketA.id).length, eventsBeforeIdempotent);

    // Negar in_progress -> assigned
    assert.throws(
      () => {
        ticketRepo.updateTicketStatus({
          ticketId: ticketA.id,
          newStatus: 'assigned',
          actorId: 'staff-1',
          isAdmin: false,
          guildId,
        });
      },
      (err) => {
        assert.equal(err.code, 'INVALID_STATUS_TRANSITION');
        return true;
      }
    );

    // Transição: in_progress -> waiting_customer (VÁLIDA)
    const tInProgToWait = ticketRepo.updateTicketStatus({
      ticketId: ticketA.id,
      newStatus: 'waiting_customer',
      actorId: 'staff-1',
      isAdmin: false,
      guildId,
    });
    assert.equal(tInProgToWait.ticket.status, 'waiting_customer');

    // Transição: waiting_customer -> in_progress (VÁLIDA)
    const tWaitToInProg = ticketRepo.updateTicketStatus({
      ticketId: ticketA.id,
      newStatus: 'in_progress',
      actorId: 'staff-1',
      isAdmin: false,
      guildId,
    });
    assert.equal(tWaitToInProg.ticket.status, 'in_progress');

    // Transição: in_progress -> resolved (VÁLIDA)
    const tInProgToResolved = ticketRepo.updateTicketStatus({
      ticketId: ticketA.id,
      newStatus: 'resolved',
      actorId: 'staff-1',
      isAdmin: false,
      guildId,
    });
    assert.equal(tInProgToResolved.ticket.status, 'resolved');

    // Negar resolved -> waiting_customer
    assert.throws(
      () => {
        ticketRepo.updateTicketStatus({
          ticketId: ticketA.id,
          newStatus: 'waiting_customer',
          actorId: 'staff-1',
          isAdmin: false,
          guildId,
        });
      },
      (err) => {
        assert.equal(err.code, 'INVALID_STATUS_TRANSITION');
        return true;
      }
    );

    // Negar resolved -> assigned
    assert.throws(
      () => {
        ticketRepo.updateTicketStatus({
          ticketId: ticketA.id,
          newStatus: 'assigned',
          actorId: 'staff-1',
          isAdmin: false,
          guildId,
        });
      },
      (err) => {
        assert.equal(err.code, 'INVALID_STATUS_TRANSITION');
        return true;
      }
    );

    // Transição: resolved -> in_progress (reabertura) (VÁLIDA)
    const tResolvedToInProg = ticketRepo.updateTicketStatus({
      ticketId: ticketA.id,
      newStatus: 'in_progress',
      actorId: 'staff-1',
      isAdmin: false,
      guildId,
    });
    assert.equal(tResolvedToInProg.ticket.status, 'in_progress');

    // Transição: in_progress -> waiting_customer -> resolved (VÁLIDA)
    ticketRepo.updateTicketStatus({ ticketId: ticketA.id, newStatus: 'waiting_customer', actorId: 'staff-1', isAdmin: false, guildId });
    const tWaitToResolved = ticketRepo.updateTicketStatus({
      ticketId: ticketA.id,
      newStatus: 'resolved',
      actorId: 'staff-1',
      isAdmin: false,
      guildId,
    });
    assert.equal(tWaitToResolved.ticket.status, 'resolved');

    // Transições diretas a partir de assigned:
    // assigned -> waiting_customer (VÁLIDA)
    const ticketB = ticketRepo.createTicketReservation({ guildId, creatorId: 'user-3', departmentId: dept.id, subject: 'B', description: 'Desc B' });
    ticketRepo.claimTicket({ ticketId: ticketB.id, staffUserId: 'staff-1', guildId });
    const tAssignedToWait = ticketRepo.updateTicketStatus({
      ticketId: ticketB.id,
      newStatus: 'waiting_customer',
      actorId: 'staff-1',
      isAdmin: false,
      guildId,
    });
    assert.equal(tAssignedToWait.ticket.status, 'waiting_customer');

    // assigned -> resolved (VÁLIDA)
    const ticketC = ticketRepo.createTicketReservation({ guildId, creatorId: 'user-4', departmentId: dept.id, subject: 'C', description: 'Desc C' });
    ticketRepo.claimTicket({ ticketId: ticketC.id, staffUserId: 'staff-1', guildId });
    const tAssignedToResolved = ticketRepo.updateTicketStatus({
      ticketId: ticketC.id,
      newStatus: 'resolved',
      actorId: 'staff-1',
      isAdmin: false,
      guildId,
    });
    assert.equal(tAssignedToResolved.ticket.status, 'resolved');

    db.close();
  });

  // 6. Prioridades low/normal/high/urgent; inválida; idempotente sem evento duplicado
  test('23. Prioridades low/normal/high/urgent; inválida; idempotente sem evento duplicado', () => {
    const db = createConnection(':memory:');
    runMigrations(db);
    const ticketRepo = new TicketRepository(db);

    const guildId = 'guild-prio-test';
    const dept = ticketRepo.createDepartment({ guildId, name: 'Geral', description: 'Desc' });
    const ticket = ticketRepo.createTicketReservation({
      guildId,
      creatorId: 'user-prio',
      departmentId: dept.id,
      subject: 'Problema',
      description: 'Desc',
      priority: 'normal',
    });

    assert.equal(ticket.priority, 'normal');

    // 1. Alterações válidas: normal -> low -> high -> urgent -> normal
    const pLow = ticketRepo.updateTicketPriority({ ticketId: ticket.id, newPriority: 'low', actorId: 'staff-1', isStaffOrAdmin: true, guildId });
    assert.equal(pLow.ticket.priority, 'low');
    assert.equal(pLow.unchanged, false);
    assert.equal(pLow.event.event_type, 'ticket_priority_changed');

    const pHigh = ticketRepo.updateTicketPriority({ ticketId: ticket.id, newPriority: 'high', actorId: 'staff-1', isStaffOrAdmin: true, guildId });
    assert.equal(pHigh.ticket.priority, 'high');

    const pUrgent = ticketRepo.updateTicketPriority({ ticketId: ticket.id, newPriority: 'urgent', actorId: 'staff-1', isStaffOrAdmin: true, guildId });
    assert.equal(pUrgent.ticket.priority, 'urgent');

    const pNormal = ticketRepo.updateTicketPriority({ ticketId: ticket.id, newPriority: 'normal', actorId: 'staff-1', isStaffOrAdmin: true, guildId });
    assert.equal(pNormal.ticket.priority, 'normal');

    // 2. Rejeição de prioridades inválidas
    const invalidList = ['critical', 'ultra', '', null, undefined, 'NORMAL', 99];
    for (const inv of invalidList) {
      assert.throws(
        () => {
          ticketRepo.updateTicketPriority({
            ticketId: ticket.id,
            newPriority: inv,
            actorId: 'staff-1',
            isStaffOrAdmin: true,
            guildId,
          });
        },
        (err) => {
          assert.equal(err.code, 'INVALID_PRIORITY');
          return true;
        }
      );
    }

    // 3. Idempotência: sem evento duplicado
    const eventsBefore = ticketRepo.getEventsByTicket(ticket.id).length;
    const pIdempotent = ticketRepo.updateTicketPriority({
      ticketId: ticket.id,
      newPriority: 'normal',
      actorId: 'staff-1',
      isStaffOrAdmin: true,
      guildId,
    });
    assert.equal(pIdempotent.unchanged, true);
    assert.equal(pIdempotent.event, null);
    assert.equal(ticketRepo.getEventsByTicket(ticket.id).length, eventsBefore);

    // 4. Bloqueio para não-staff
    assert.throws(
      () => {
        ticketRepo.updateTicketPriority({
          ticketId: ticket.id,
          newPriority: 'high',
          actorId: 'regular-user',
          isStaffOrAdmin: false,
          guildId,
        });
      },
      (err) => {
        assert.equal(err.code, 'FORBIDDEN_STAFF_ONLY');
        return true;
      }
    );

    db.close();
  });

  // 7. Autorização: staff correto, admin, autor sem cargo, staff de outro departamento, cargo apagado com recuperação admin
  test('24. Autorização: staff correto, admin, autor sem cargo, staff de outro departamento, cargo apagado com recuperação admin', () => {
    const mockGuild = {
      id: 'guild-auth-test',
      roles: {
        cache: new Map([
          ['role-dept-1', { id: 'role-dept-1', name: 'Suporte Técnico' }],
          ['role-dept-2', { id: 'role-dept-2', name: 'Financeiro' }],
          ['role-global', { id: 'role-global', name: 'Staff Global' }],
        ]),
      },
    };

    const dept1 = { id: 1, staff_role_id: 'role-dept-1' };
    const dept2 = { id: 2, staff_role_id: 'role-dept-2' };
    const ticketDept1 = { creator_id: 'user-creator', department_id: 1 };

    // 1. Staff correto (possui cargo do departamento)
    const staffDept1 = {
      id: 'staff-1',
      permissions: { has: () => false },
      roles: { cache: new Map([['role-dept-1', true]]) },
    };
    const authStaffCorrect = permissionService.resolveTicketStaffPermission({
      member: staffDept1,
      guild: mockGuild,
      department: dept1,
      ticket: ticketDept1,
    });
    assert.equal(authStaffCorrect.allowed, true);
    assert.equal(authStaffCorrect.isStaff, true);
    assert.equal(authStaffCorrect.isAdmin, false);

    // 2. Administrador (sem cargo de suporte específico)
    const adminUser = {
      id: 'admin-1',
      permissions: { has: (perm) => perm === PermissionFlagsBits.Administrator },
      roles: { cache: new Map() },
    };
    const authAdmin = permissionService.resolveTicketStaffPermission({
      member: adminUser,
      guild: mockGuild,
      department: dept1,
      ticket: ticketDept1,
    });
    assert.equal(authAdmin.allowed, true);
    assert.equal(authAdmin.isAdmin, true);
    assert.equal(authAdmin.isStaff, true);

    // 3. Autor do ticket sem cargo de suporte
    const authorUser = {
      id: 'user-creator',
      permissions: { has: () => false },
      roles: { cache: new Map() },
    };
    const authAuthor = permissionService.resolveTicketStaffPermission({
      member: authorUser,
      guild: mockGuild,
      department: dept1,
      ticket: ticketDept1,
    });
    assert.equal(authAuthor.allowed, false);
    assert.equal(authAuthor.code, 'FORBIDDEN_STAFF_ONLY');

    // 4. Staff de outro departamento
    const staffDept2 = {
      id: 'staff-2',
      permissions: { has: () => false },
      roles: { cache: new Map([['role-dept-2', true]]) },
    };
    const authOtherDept = permissionService.resolveTicketStaffPermission({
      member: staffDept2,
      guild: mockGuild,
      department: dept1,
      ticket: ticketDept1,
    });
    assert.equal(authOtherDept.allowed, false);
    assert.equal(authOtherDept.code, 'FORBIDDEN_STAFF_ONLY');

    // 5. Cargo apagado do servidor
    const deptWithDeletedRole = { id: 3, staff_role_id: 'role-deleted-999' };
    const memberWithDeletedRole = {
      id: 'staff-old',
      permissions: { has: () => false },
      roles: { cache: new Map([['role-deleted-999', true]]) },
    };

    // 5a. Staff comum é bloqueado
    const authDeletedNormal = permissionService.resolveTicketStaffPermission({
      member: memberWithDeletedRole,
      guild: mockGuild,
      department: deptWithDeletedRole,
      ticket: ticketDept1,
    });
    assert.equal(authDeletedNormal.allowed, false);
    assert.equal(authDeletedNormal.code, 'STAFF_ROLE_DELETED');

    // 5b. Administrador tem acesso recuperado com aviso
    const authDeletedAdmin = permissionService.resolveTicketStaffPermission({
      member: adminUser,
      guild: mockGuild,
      department: deptWithDeletedRole,
      ticket: ticketDept1,
    });
    assert.equal(authDeletedAdmin.allowed, true);
    assert.equal(authDeletedAdmin.isAdmin, true);
    assert.ok(authDeletedAdmin.warning && authDeletedAdmin.warning.includes('eliminado'));
  });

  // 8. buildTicketPanelPayload mostra estado, prioridade, responsável; componentes têm claim/release/status/priority e IDs corretos
  test('25. buildTicketPanelPayload mostra estado, prioridade, responsável; componentes têm claim/release/status/priority e IDs corretos', () => {
    // 1. Ticket atribuído com prioridade alta
    const ticketClaimed = {
      id: 10,
      ticket_number: 42,
      subject: 'Problema de Pagamento',
      description: 'Erro no gateway',
      creator_id: 'user-client-10',
      status: 'assigned',
      priority: 'high',
      claimed_by: 'staff-agent-20',
      created_at: new Date().toISOString(),
    };
    const dept = { name: 'Financeiro', emoji: '💳' };
    const settings = { panel_color: '#5865F2' };

    const payloadClaimed = buildTicketPanelPayload({
      ticket: ticketClaimed,
      department: dept,
      settings,
    });

    assert.equal(payloadClaimed.embeds.length, 1);
    const embed = payloadClaimed.embeds[0];
    assert.ok(embed.data.title.includes('TKT-00042'));
    assert.ok(embed.data.title.includes('Problema de Pagamento'));

    const fields = embed.data.fields;
    const statusField = fields.find((f) => f.name.includes('Estado'));
    assert.ok(statusField.value.includes('Atribuído'));

    const priorityField = fields.find((f) => f.name.includes('Prioridade'));
    assert.ok(priorityField.value.includes('Alta'));

    const claimedField = fields.find((f) => f.name.includes('Responsável'));
    assert.equal(claimedField.value, '<@staff-agent-20>');

    // Componentes
    assert.equal(payloadClaimed.components.length, 3);

    // Botões
    const buttonsRow = payloadClaimed.components[0];
    const claimBtn = buttonsRow.components.find((c) => c.data.custom_id === BUTTON_CLAIM);
    const releaseBtn = buttonsRow.components.find((c) => c.data.custom_id === BUTTON_RELEASE);
    assert.ok(claimBtn);
    assert.ok(releaseBtn);
    assert.equal(claimBtn.data.disabled, true, 'Claim deve estar desativado se já estiver atribuído');
    assert.equal(releaseBtn.data.disabled, false, 'Release deve estar ativo se atribuído');

    // Menu status
    const statusRow = payloadClaimed.components[1];
    const statusSelect = statusRow.components.find((c) => c.data.custom_id === SELECT_STATUS);
    assert.ok(statusSelect);
    assert.equal(statusSelect.data.disabled, false);

    // Menu prioridade
    const priorityRow = payloadClaimed.components[2];
    const prioritySelect = priorityRow.components.find((c) => c.data.custom_id === SELECT_PRIORITY);
    assert.ok(prioritySelect);
    const defaultPrioOpt = prioritySelect.options.find((o) => o.data.default === true);
    assert.equal(defaultPrioOpt.data.value, 'high');

    // 2. Ticket novo não atribuído
    const ticketNew = {
      ...ticketClaimed,
      status: 'new',
      claimed_by: null,
      priority: 'normal',
    };
    const payloadNew = buildTicketPanelPayload({ ticket: ticketNew, department: dept, settings });
    const claimedFieldNew = payloadNew.embeds[0].data.fields.find((f) => f.name.includes('Responsável'));
    assert.equal(claimedFieldNew.value, 'Não atribuído');

    const claimBtnNew = payloadNew.components[0].components.find((c) => c.data.custom_id === BUTTON_CLAIM);
    const releaseBtnNew = payloadNew.components[0].components.find((c) => c.data.custom_id === BUTTON_RELEASE);
    const statusSelectNew = payloadNew.components[1].components.find((c) => c.data.custom_id === SELECT_STATUS);

    assert.equal(claimBtnNew.data.disabled, false, 'Claim deve estar habilitado para ticket novo');
    assert.equal(releaseBtnNew.data.disabled, true, 'Release deve estar desabilitado para ticket novo');
    assert.equal(statusSelectNew.data.disabled, true, 'Menu de status desabilitado sem responsável');

    // 3. Ticket resolvido (release desativado)
    const ticketResolved = {
      ...ticketClaimed,
      status: 'resolved',
    };
    const payloadResolved = buildTicketPanelPayload({ ticket: ticketResolved, department: dept, settings });
    const releaseBtnResolved = payloadResolved.components[0].components.find((c) => c.data.custom_id === BUTTON_RELEASE);
    assert.equal(releaseBtnResolved.data.disabled, true, 'Release deve estar desativado para ticket resolvido');
  });

  // 9. createTicket grava control_message_id; se setControlMessageId retornar false ou lançar, elimina canal e reserva e não cria ticket_created
  test('26. createTicket grava control_message_id; se setControlMessageId retornar false ou lançar, elimina canal e reserva e não cria ticket_created', async () => {
    const db = createConnection(':memory:');
    runMigrations(db);
    const ticketRepo = new TicketRepository(db);
    const settingsRepo = new SettingsRepository(db);
    const ticketServiceInstance = new TicketService(ticketRepo, settingsRepo, permissionService);

    const guildId = 'guild-ctrl-msg-suite';
    settingsRepo.upsertGuildSettings(guildId, {
      ticket_category_id: null,
      log_channel_id: null,
      default_staff_role_id: 'role-staff-suite',
    });
    const dept = ticketRepo.createDepartment({
      guildId,
      name: 'Suporte',
      description: 'Geral',
      staffRoleId: 'role-staff-suite',
    });

    const mockGuild = {
      id: guildId,
      client: {
        user: { id: 'bot-ctrl-suite-user' },
      },
      roles: {
        cache: new Map([['role-staff-suite', { id: 'role-staff-suite', name: 'Suporte' }]]),
        everyone: { id: guildId },
      },
      members: {
        me: {
          permissions: { has: () => true },
        },
      },
      channels: { cache: new Map() },
    };

    // 1. Sucesso: grava control_message_id e cria ticket_created
    mockGuild.channels.create = async () => ({
      id: 'chan-created-s1',
      delete: async () => {},
      send: async () => ({ id: 'msg-ctrl-id-1001' }),
    });

    const resSuccess = await ticketServiceInstance.createTicket({
      guild: mockGuild,
      user: { id: 'user-creator-s1', username: 'cliente1', tag: 'cliente1#0001' },
      departmentId: dept.id,
      subject: 'Assunto do Ticket',
      description: 'Descrição longa do ticket de teste',
    });

    assert.equal(resSuccess.ticket.control_message_id, 'msg-ctrl-id-1001');
    const inDb = ticketRepo.getTicketById(resSuccess.ticket.id, guildId);
    assert.equal(inDb.control_message_id, 'msg-ctrl-id-1001');

    const events = ticketRepo.getEventsByTicket(resSuccess.ticket.id);
    const createdEvent = events.find((e) => e.event_type === 'ticket_created');
    assert.ok(createdEvent, 'Evento ticket_created deve ser registado');
    const metadata = JSON.parse(createdEvent.metadata_json);
    assert.equal(metadata.controlMessageId, 'msg-ctrl-id-1001');

    // 2. Falha: setControlMessageId retorna false -> compensação e sem evento
    let channel2Deleted = false;
    mockGuild.channels.create = async () => ({
      id: 'chan-created-s2',
      delete: async () => {
        channel2Deleted = true;
      },
      send: async () => ({ id: 'msg-ctrl-id-1002' }),
    });

    const originalSetCtrl = ticketRepo.setControlMessageId;
    ticketRepo.setControlMessageId = () => false;

    const origErr = logger.error;
    logger.error = () => {};

    try {
      await assert.rejects(
        async () => {
          await ticketServiceInstance.createTicket({
            guild: mockGuild,
            user: { id: 'user-creator-s2', username: 'cliente2', tag: 'cliente2#0002' },
            departmentId: dept.id,
            subject: 'Assunto Falha Falsa',
            description: 'Descrição longa do ticket de teste de falha',
          });
        },
        (err) => {
          assert.equal(err.code, 'TICKET_INITIALIZATION_FAILED');
          return true;
        }
      );
    } finally {
      ticketRepo.setControlMessageId = originalSetCtrl;
      logger.error = origErr;
    }

    assert.equal(channel2Deleted, true, 'Canal deve ser eliminado na compensação');
    const activeUser2 = ticketRepo.getActiveTicketByUser(guildId, 'user-creator-s2');
    assert.equal(activeUser2, null, 'Reserva deve ter sido eliminada da BD');

    const eventsAll = ticketRepo.getEventsByGuild(guildId);
    const phantomEvent2 = eventsAll.find((e) => e.actor_id === 'user-creator-s2');
    assert.equal(phantomEvent2, undefined, 'Não deve existir evento ticket_created em caso de compensação');

    // 3. Falha: setControlMessageId lança exceção -> compensação e sem evento
    let channel3Deleted = false;
    mockGuild.channels.create = async () => ({
      id: 'chan-created-s3',
      delete: async () => {
        channel3Deleted = true;
      },
      send: async () => ({ id: 'msg-ctrl-id-1003' }),
    });

    ticketRepo.setControlMessageId = () => {
      throw new Error('Falha de I/O na gravação do ID');
    };
    logger.error = () => {};

    try {
      await assert.rejects(
        async () => {
          await ticketServiceInstance.createTicket({
            guild: mockGuild,
            user: { id: 'user-creator-s3', username: 'cliente3', tag: 'cliente3#0003' },
            departmentId: dept.id,
            subject: 'Assunto Falha Excecao',
            description: 'Descrição longa do ticket de teste de falha 3',
          });
        },
        (err) => {
          assert.equal(err.code, 'TICKET_INITIALIZATION_FAILED');
          return true;
        }
      );
    } finally {
      ticketRepo.setControlMessageId = originalSetCtrl;
      logger.error = origErr;
    }

    assert.equal(channel3Deleted, true, 'Canal 3 deve ser eliminado na compensação');
    const activeUser3 = ticketRepo.getActiveTicketByUser(guildId, 'user-creator-s3');
    assert.equal(activeUser3, null, 'Reserva do utilizador 3 deve ter sido eliminada');

    db.close();
  });

  // 10. Handlers interactionCreate para claim/release/status/priority com mocks: usam channelId+guildId, fazem deferUpdate, atualizam mensagem e followUp; valores inválidos são rejeitados
  test('27. Handlers interactionCreate para claim/release/status/priority com mocks: usam channelId+guildId, fazem deferUpdate, atualizam mensagem e followUp; valores inválidos são rejeitados', async () => {
    const db = createConnection(':memory:');
    runMigrations(db);
    const ticketRepo = new TicketRepository(db);
    const settingsRepo = new SettingsRepository(db);

    const guildId = 'guild-handlers-test';
    const channelId = 'chan-handler-42';
    settingsRepo.upsertGuildSettings(guildId, {
      default_staff_role_id: 'role-support-team',
    });
    const dept = ticketRepo.createDepartment({
      guildId,
      name: 'Suporte',
      description: 'Geral',
      staffRoleId: 'role-support-team',
    });

    const ticket = ticketRepo.createTicketReservation({
      guildId,
      creatorId: 'user-author-99',
      departmentId: dept.id,
      subject: 'Ajuda Técnica',
      description: 'Descrição detalhada do problema',
      priority: 'normal',
    });
    ticketRepo.setTicketChannelId(ticket.id, channelId);

    const mockStaff = {
      id: 'staff-handler-10',
      permissions: { has: () => false },
      roles: { cache: new Map([['role-support-team', true]]) },
    };

    const mockGuild = {
      id: guildId,
      roles: { cache: new Map([['role-support-team', { id: 'role-support-team' }]]) },
    };

    defaultTicketRepo._db = db;
    defaultSettingsRepo._db = db;

    try {
      // 1. Botão CLAIM
      let claimDeferred = false;
      let claimEditedPayload = null;
      let claimFollowUp = null;

      const mockClaimInteraction = {
        isChatInputCommand: () => false,
        isAutocomplete: () => false,
        isStringSelectMenu: () => false,
        isModalSubmit: () => false,
        isButton: () => true,
        customId: BUTTON_CLAIM,
        channelId,
        guildId,
        member: mockStaff,
        guild: mockGuild,
        message: {
          edit: async (payload) => {
            claimEditedPayload = payload;
          },
        },
        deferred: false,
        deferUpdate: async function () {
          this.deferred = true;
          claimDeferred = true;
        },
        followUp: async (payload) => {
          claimFollowUp = payload;
        },
      };

      await interactionCreate.execute(mockClaimInteraction, null);

      assert.equal(claimDeferred, true, 'Deve adiar atualização com deferUpdate');
      assert.ok(claimEditedPayload, 'Deve editar mensagem do painel');
      assert.ok(claimFollowUp.content.includes('Assumiste o atendimento'), 'FollowUp com sucesso');
      assert.equal(claimFollowUp.ephemeral, true);

      const ticketClaimed = ticketRepo.getTicketById(ticket.id, guildId);
      assert.equal(ticketClaimed.claimed_by, 'staff-handler-10');
      assert.equal(ticketClaimed.status, 'assigned');

      // 2. Select Menu STATUS (valor válido: in_progress)
      let statusDeferred = false;
      let statusEditedPayload = null;
      let statusFollowUp = null;

      const mockStatusInteraction = {
        isChatInputCommand: () => false,
        isAutocomplete: () => false,
        isStringSelectMenu: () => true,
        isModalSubmit: () => false,
        isButton: () => false,
        customId: SELECT_STATUS,
        values: ['in_progress'],
        channelId,
        guildId,
        member: mockStaff,
        guild: mockGuild,
        message: {
          edit: async (payload) => {
            statusEditedPayload = payload;
          },
        },
        deferred: false,
        deferUpdate: async function () {
          this.deferred = true;
          statusDeferred = true;
        },
        followUp: async (payload) => {
          statusFollowUp = payload;
        },
      };

      await interactionCreate.execute(mockStatusInteraction, null);

      assert.equal(statusDeferred, true);
      assert.ok(statusEditedPayload);
      assert.ok(statusFollowUp.content.includes('Em Atendimento'));

      const ticketInProg = ticketRepo.getTicketById(ticket.id, guildId);
      assert.equal(ticketInProg.status, 'in_progress');

      // 3. Select Menu STATUS (valor inválido: rejeitado)
      let invalidStatusFollowUp = null;
      const mockInvalidStatusInteraction = {
        isChatInputCommand: () => false,
        isAutocomplete: () => false,
        isStringSelectMenu: () => true,
        isModalSubmit: () => false,
        isButton: () => false,
        customId: SELECT_STATUS,
        values: ['status_invalido_xyz'],
        channelId,
        guildId,
        member: mockStaff,
        guild: mockGuild,
        message: {
          edit: async () => {
            assert.fail('Não deve editar mensagem para status inválido');
          },
        },
        deferred: false,
        deferUpdate: async function () {
          this.deferred = true;
        },
        followUp: async (payload) => {
          invalidStatusFollowUp = payload;
        },
      };

      const origErr = logger.error;
      logger.error = () => {};
      try {
        await interactionCreate.execute(mockInvalidStatusInteraction, null);
      } finally {
        logger.error = origErr;
      }

      assert.ok(invalidStatusFollowUp.content.includes('não é permitida'), 'Deve avisar sobre transição inválida');
      assert.equal(ticketRepo.getTicketById(ticket.id, guildId).status, 'in_progress');

      // 4. Select Menu PRIORITY (valor válido: urgent)
      let prioDeferred = false;
      let prioEditedPayload = null;
      let prioFollowUp = null;

      const mockPrioInteraction = {
        isChatInputCommand: () => false,
        isAutocomplete: () => false,
        isStringSelectMenu: () => true,
        isModalSubmit: () => false,
        isButton: () => false,
        customId: SELECT_PRIORITY,
        values: ['urgent'],
        channelId,
        guildId,
        member: mockStaff,
        guild: mockGuild,
        message: {
          edit: async (payload) => {
            prioEditedPayload = payload;
          },
        },
        deferred: false,
        deferUpdate: async function () {
          this.deferred = true;
          prioDeferred = true;
        },
        followUp: async (payload) => {
          prioFollowUp = payload;
        },
      };

      await interactionCreate.execute(mockPrioInteraction, null);

      assert.equal(prioDeferred, true);
      assert.ok(prioEditedPayload);
      assert.ok(prioFollowUp.content.includes('Urgente'));
      assert.equal(ticketRepo.getTicketById(ticket.id, guildId).priority, 'urgent');

      // 5. Select Menu PRIORITY (valor inválido: rejeitado)
      let invalidPrioFollowUp = null;
      const mockInvalidPrioInteraction = {
        isChatInputCommand: () => false,
        isAutocomplete: () => false,
        isStringSelectMenu: () => true,
        isModalSubmit: () => false,
        isButton: () => false,
        customId: SELECT_PRIORITY,
        values: ['prioridade_impossivel'],
        channelId,
        guildId,
        member: mockStaff,
        guild: mockGuild,
        message: {
          edit: async () => {
            assert.fail('Não deve editar mensagem para prioridade inválida');
          },
        },
        deferred: false,
        deferUpdate: async function () {
          this.deferred = true;
        },
        followUp: async (payload) => {
          invalidPrioFollowUp = payload;
        },
      };

      logger.error = () => {};
      try {
        await interactionCreate.execute(mockInvalidPrioInteraction, null);
      } finally {
        logger.error = origErr;
      }

      assert.ok(invalidPrioFollowUp.content.includes('inválida'), 'Deve avisar sobre prioridade inválida');
      assert.equal(ticketRepo.getTicketById(ticket.id, guildId).priority, 'urgent');

      // 6. Botão RELEASE
      let releaseDeferred = false;
      let releaseEditedPayload = null;
      let releaseFollowUp = null;

      const mockReleaseInteraction = {
        isChatInputCommand: () => false,
        isAutocomplete: () => false,
        isStringSelectMenu: () => false,
        isModalSubmit: () => false,
        isButton: () => true,
        customId: BUTTON_RELEASE,
        channelId,
        guildId,
        member: mockStaff,
        guild: mockGuild,
        message: {
          edit: async (payload) => {
            releaseEditedPayload = payload;
          },
        },
        deferred: false,
        deferUpdate: async function () {
          this.deferred = true;
          releaseDeferred = true;
        },
        followUp: async (payload) => {
          releaseFollowUp = payload;
        },
      };

      await interactionCreate.execute(mockReleaseInteraction, null);

      assert.equal(releaseDeferred, true);
      assert.ok(releaseEditedPayload);
      assert.ok(releaseFollowUp.content.includes('libertado com sucesso'));

      const ticketReleased = ticketRepo.getTicketById(ticket.id, guildId);
      assert.equal(ticketReleased.claimed_by, null);
      assert.equal(ticketReleased.status, 'new');
    } finally {
      defaultTicketRepo._db = null;
      defaultSettingsRepo._db = null;
      db.close();
    }
  });

  // 11. Falha ao editar painel depois de mutação não reverte a DB e informa o utilizador de forma segura
  test('28. Falha ao editar painel depois de mutação não reverte a DB e informa o utilizador de forma segura', async () => {
    const db = createConnection(':memory:');
    runMigrations(db);
    const ticketRepo = new TicketRepository(db);
    const settingsRepo = new SettingsRepository(db);

    const guildId = 'guild-fail-visual-test';
    const channelId = 'chan-visual-fail-100';
    settingsRepo.upsertGuildSettings(guildId, {
      default_staff_role_id: 'role-support',
    });
    const dept = ticketRepo.createDepartment({
      guildId,
      name: 'Suporte',
      description: 'Geral',
      staffRoleId: 'role-support',
    });

    const ticket = ticketRepo.createTicketReservation({
      guildId,
      creatorId: 'user-buyer-1',
      departmentId: dept.id,
      subject: 'Ajuda',
      description: 'Descricao',
      priority: 'normal',
    });
    ticketRepo.setTicketChannelId(ticket.id, channelId);

    const mockStaff = {
      id: 'staff-visual-user',
      permissions: { has: () => false },
      roles: { cache: new Map([['role-support', true]]) },
    };

    const mockGuild = {
      id: guildId,
      roles: { cache: new Map([['role-support', { id: 'role-support' }]]) },
    };

    defaultTicketRepo._db = db;
    defaultSettingsRepo._db = db;

    const origErr = logger.error;
    logger.error = () => {};

    try {
      // 1. Falha visual no botão Claim
      let followUpClaim = null;
      const mockClaimInteraction = {
        isChatInputCommand: () => false,
        isAutocomplete: () => false,
        isStringSelectMenu: () => false,
        isModalSubmit: () => false,
        isButton: () => true,
        customId: BUTTON_CLAIM,
        channelId,
        guildId,
        member: mockStaff,
        guild: mockGuild,
        message: {
          edit: async () => {
            throw new Error('DiscordAPIError[10008]: Unknown Message');
          },
        },
        deferred: false,
        deferUpdate: async function () {
          this.deferred = true;
        },
        followUp: async (payload) => {
          followUpClaim = payload;
        },
      };

      await interactionCreate.execute(mockClaimInteraction, null);

      // A mutação na BD foi persistida e NÃO foi revertida
      const ticketInDbAfterClaim = ticketRepo.getTicketById(ticket.id, guildId);
      assert.equal(ticketInDbAfterClaim.claimed_by, 'staff-visual-user', 'Mutação na BD deve persistir');
      assert.equal(ticketInDbAfterClaim.status, 'assigned', 'Status na BD deve persistir');

      // O utilizador é informado de forma segura
      assert.ok(followUpClaim, 'FollowUp deve ser enviado');
      assert.ok(
        followUpClaim.content.includes('guardada na base de dados, mas não foi possível atualizar o painel visual'),
        `Esperava mensagem segura, obteve: "${followUpClaim.content}"`
      );
      assert.equal(followUpClaim.ephemeral, true);

      // 2. Falha visual na alteração de prioridade
      let followUpPriority = null;
      const mockPriorityInteraction = {
        isChatInputCommand: () => false,
        isAutocomplete: () => false,
        isStringSelectMenu: () => true,
        isModalSubmit: () => false,
        isButton: () => false,
        customId: SELECT_PRIORITY,
        values: ['high'],
        channelId,
        guildId,
        member: mockStaff,
        guild: mockGuild,
        message: {
          edit: async () => {
            throw new Error('DiscordAPIError[50001]: Missing Access');
          },
        },
        deferred: false,
        deferUpdate: async function () {
          this.deferred = true;
        },
        followUp: async (payload) => {
          followUpPriority = payload;
        },
      };

      await interactionCreate.execute(mockPriorityInteraction, null);

      // A prioridade na BD foi persistida e NÃO foi revertida
      const ticketInDbAfterPrio = ticketRepo.getTicketById(ticket.id, guildId);
      assert.equal(ticketInDbAfterPrio.priority, 'high', 'Prioridade na BD deve ter mudado para high');

      // Mensagem segura ao utilizador
      assert.ok(followUpPriority, 'FollowUp de prioridade deve ser enviado');
      assert.ok(
        followUpPriority.content.includes('guardada na base de dados, mas não foi possível atualizar o painel visual')
      );
    } finally {
      logger.error = origErr;
      defaultTicketRepo._db = null;
      defaultSettingsRepo._db = null;
      db.close();
    }
  });
});

describe('Sistema de Tickets - Bloco 2B', () => {
  const { TicketMemberRepository } = require('../src/repositories/ticketMemberRepository');
  const defaultTicketMemberRepo = require('../src/repositories/ticketMemberRepository');
  const { TicketMemberService } = require('../src/services/ticketMemberService');
  const defaultTicketMemberService = require('../src/services/ticketMemberService');
  const defaultTicketRepo = require('../src/repositories/ticketRepository');
  const defaultSettingsRepo = require('../src/repositories/settingsRepository');
  const defaultTicketService = require('../src/services/ticketService');
  const { buildTicketDetailsEmbed, buildTicketPanelPayload } = require('../src/components/tickets/ticketPanel');
  const ticketCommand = require('../src/commands/ticket');
  const ticketsCommand = require('../src/commands/tickets');
  const infoCommand = require('../src/commands/info');
  const pingCommand = require('../src/commands/ping');
  const serverCommand = require('../src/commands/server');
  const interactionCreate = require('../src/events/interactionCreate');
  const logger = require('../src/utils/logger');

  // 29. Migração ticket_members sobre DB existente, idempotente, com FK/CASCADE e unicidade ticket_id+user_id
  test('29. Migração ticket_members sobre DB existente, idempotente, com FK/CASCADE e unicidade ticket_id+user_id', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');

    // Schema sem a tabela ticket_members
    db.exec(`
      CREATE TABLE IF NOT EXISTS guild_settings (
        guild_id TEXT PRIMARY KEY
      );
      CREATE TABLE IF NOT EXISTS ticket_departments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        ticket_number INTEGER NOT NULL,
        creator_id TEXT NOT NULL,
        department_id INTEGER NOT NULL REFERENCES ticket_departments(id),
        channel_id TEXT,
        subject TEXT NOT NULL,
        description TEXT NOT NULL,
        priority TEXT NOT NULL DEFAULT 'normal',
        status TEXT NOT NULL DEFAULT 'new',
        control_message_id TEXT
      );
      CREATE TABLE IF NOT EXISTS ticket_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
        guild_id TEXT,
        event_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        metadata_json TEXT
      );
    `);

    let tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    assert.equal(tables.includes('ticket_members'), false, 'Tabela ticket_members não deve existir antes da migração');

    // 1ª execução das migrações
    runMigrations(db);
    tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    assert.equal(tables.includes('ticket_members'), true, 'Tabela ticket_members deve ter sido criada pela migração');

    // 2ª execução das migrações (idempotência estrita)
    assert.doesNotThrow(() => {
      runMigrations(db);
    });

    // Inserir departamento e ticket de teste
    db.prepare("INSERT INTO ticket_departments (id, guild_id, name, description) VALUES (1, 'g1', 'Dept', 'Desc')").run();
    db.prepare("INSERT INTO tickets (id, guild_id, ticket_number, creator_id, department_id, subject, description) VALUES (1, 'g1', 1, 'user-creator', 1, 'Sub', 'Desc')").run();

    // Inserir participante em ticket_members
    db.prepare("INSERT INTO ticket_members (ticket_id, user_id, added_by) VALUES (1, 'user-part-1', 'staff-1')").run();

    // Unicidade ticket_id + user_id: duplicação direta lança violação de PRIMARY KEY
    assert.throws(
      () => {
        db.prepare("INSERT INTO ticket_members (ticket_id, user_id, added_by) VALUES (1, 'user-part-1', 'staff-2')").run();
      },
      (err) => {
        assert.equal(err.code, 'SQLITE_CONSTRAINT_PRIMARYKEY');
        return true;
      }
    );

    // FK e CASCADE: eliminar o ticket deve remover automaticamente os participantes associados
    db.prepare('DELETE FROM tickets WHERE id = 1').run();
    const remaining = db.prepare('SELECT * FROM ticket_members WHERE ticket_id = 1').all();
    assert.equal(remaining.length, 0, 'Registos em ticket_members devem sofrer CASCADE na eliminação do ticket');

    db.close();
  });

  // 30. ticketMemberRepository: add/list/isMember/remove; idempotência; máximo 10; isolamento entre tickets/guilds; cascade quando ticket é removido
  test('30. ticketMemberRepository: add/list/isMember/remove; idempotência; máximo 10; isolamento entre tickets/guilds; cascade quando ticket é removido', () => {
    const db = createConnection(':memory:');
    const ticketRepo = new TicketRepository(db);
    const memberRepo = new TicketMemberRepository(db);

    const guildA = 'guild-repo-a';
    const guildB = 'guild-repo-b';

    const deptA = ticketRepo.createDepartment({ guildId: guildA, name: 'Dept A', description: 'Desc A' });
    const deptB = ticketRepo.createDepartment({ guildId: guildB, name: 'Dept B', description: 'Desc B' });

    const ticketA = ticketRepo.createTicketReservation({
      guildId: guildA,
      creatorId: 'user-a-author',
      departmentId: deptA.id,
      subject: 'Ticket A',
      description: 'Desc A',
    });
    const ticketB = ticketRepo.createTicketReservation({
      guildId: guildB,
      creatorId: 'user-b-author',
      departmentId: deptB.id,
      subject: 'Ticket B',
      description: 'Desc B',
    });

    // 1. addMember
    const add1 = memberRepo.addMember({
      ticketId: ticketA.id,
      userId: 'user-p1',
      addedBy: 'staff-a',
      guildId: guildA,
    });
    assert.equal(add1.alreadyMember, false);
    assert.equal(add1.member.user_id, 'user-p1');

    // 2. isMember & getMembers
    assert.equal(memberRepo.isMember(ticketA.id, 'user-p1', guildA), true);
    assert.equal(memberRepo.isMember(ticketA.id, 'user-unknown', guildA), false);
    const membersA = memberRepo.getMembers(ticketA.id, guildA);
    assert.equal(membersA.length, 1);
    assert.equal(membersA[0].user_id, 'user-p1');

    // 3. Idempotência do addMember
    const add1Again = memberRepo.addMember({
      ticketId: ticketA.id,
      userId: 'user-p1',
      addedBy: 'staff-a2',
      guildId: guildA,
    });
    assert.equal(add1Again.alreadyMember, true);
    assert.equal(memberRepo.getMembers(ticketA.id, guildA).length, 1);

    // 4. Máximo 10 participantes
    for (let i = 2; i <= 10; i++) {
      memberRepo.addMember({
        ticketId: ticketA.id,
        userId: `user-p${i}`,
        addedBy: 'staff-a',
        guildId: guildA,
      });
    }
    assert.equal(memberRepo.getMemberCount(ticketA.id), 10);

    assert.throws(
      () => {
        memberRepo.addMember({
          ticketId: ticketA.id,
          userId: 'user-p11',
          addedBy: 'staff-a',
          guildId: guildA,
        });
      },
      (err) => {
        assert.equal(err.code, 'MAX_PARTICIPANTS_REACHED');
        return true;
      }
    );

    // 5. removeMember
    const rem1 = memberRepo.removeMember({
      ticketId: ticketA.id,
      userId: 'user-p1',
      guildId: guildA,
    });
    assert.equal(rem1.removed, true);
    assert.equal(rem1.member.user_id, 'user-p1');
    assert.equal(memberRepo.isMember(ticketA.id, 'user-p1', guildA), false);

    // Idempotência do removeMember
    const rem1Again = memberRepo.removeMember({
      ticketId: ticketA.id,
      userId: 'user-p1',
      guildId: guildA,
    });
    assert.equal(rem1Again.removed, false);
    assert.equal(rem1Again.member, null);

    // 6. Isolamento entre tickets e guilds
    memberRepo.addMember({
      ticketId: ticketB.id,
      userId: 'user-p-b',
      addedBy: 'staff-b',
      guildId: guildB,
    });
    assert.equal(memberRepo.isMember(ticketA.id, 'user-p-b', guildA), false);
    assert.equal(memberRepo.isMember(ticketB.id, 'user-p-b', guildA), false);
    assert.equal(memberRepo.getMembers(ticketB.id, guildA).length, 0);

    assert.throws(
      () => {
        memberRepo.addMember({
          ticketId: ticketA.id,
          userId: 'user-x',
          addedBy: 'staff',
          guildId: guildB, // guild mismatch
        });
      },
      (err) => {
        assert.equal(err.code, 'TICKET_NOT_FOUND');
        return true;
      }
    );

    assert.throws(
      () => {
        memberRepo.removeMember({
          ticketId: ticketA.id,
          userId: 'user-p2',
          guildId: guildB, // guild mismatch
        });
      },
      (err) => {
        assert.equal(err.code, 'TICKET_NOT_FOUND');
        return true;
      }
    );

    // 7. Cascade quando ticket é removido
    ticketRepo.deleteTicket(ticketB.id);
    assert.equal(memberRepo.getMembers(ticketB.id).length, 0);

    db.close();
  });

  // 31. Autorização participantes: staff do departamento e admin permitidos; autor sem staff e staff de outro departamento negados
  test('31. Autorização participantes: staff do departamento e admin permitidos; autor sem staff e staff de outro departamento negados', () => {
    const service = new TicketMemberService();
    const guild = {
      id: 'guild-auth-test',
      roles: {
        cache: new Map([
          ['role-support-a', { id: 'role-support-a' }],
          ['role-support-b', { id: 'role-support-b' }],
        ]),
      },
    };
    const deptA = { id: 1, name: 'Dept A', staff_role_id: 'role-support-a' };
    const ticket = { id: 10, creator_id: 'user-creator-123', department_id: 1 };

    // 1. Staff do departamento permitido
    const staffMemberA = {
      id: 'staff-member-a',
      permissions: { has: () => false },
      roles: { cache: new Map([['role-support-a', true]]) },
    };
    const authStaff = service.authorizeStaff({
      member: staffMemberA,
      guild,
      department: deptA,
      ticket,
    });
    assert.equal(authStaff.allowed, true);

    // 2. Admin permitido
    const adminMember = {
      id: 'admin-member',
      permissions: { has: (perm) => perm === PermissionFlagsBits.Administrator },
      roles: { cache: new Map() },
    };
    const authAdmin = service.authorizeStaff({
      member: adminMember,
      guild,
      department: deptA,
      ticket,
    });
    assert.equal(authAdmin.allowed, true);
    assert.equal(authAdmin.isAdmin, true);

    // 3. Autor sem cargo de suporte negado
    const authorMember = {
      id: 'user-creator-123',
      permissions: { has: () => false },
      roles: { cache: new Map() },
    };
    assert.throws(
      () => {
        service.authorizeStaff({
          member: authorMember,
          guild,
          department: deptA,
          ticket,
        });
      },
      (err) => {
        assert.equal(err.code, 'FORBIDDEN_STAFF_ONLY');
        return true;
      }
    );

    // 4. Staff de outro departamento negado
    const staffMemberB = {
      id: 'staff-member-b',
      permissions: { has: () => false },
      roles: { cache: new Map([['role-support-b', true]]) },
    };
    assert.throws(
      () => {
        service.authorizeStaff({
          member: staffMemberB,
          guild,
          department: deptA,
          ticket,
        });
      },
      (err) => {
        assert.equal(err.code, 'FORBIDDEN_STAFF_ONLY');
        return true;
      }
    );
  });

  // 32. Rejeitar bot, autor e utilizador inválido; não remover autor
  test('32. Rejeitar bot, autor e utilizador inválido; não remover autor', async () => {
    const db = createConnection(':memory:');
    const ticketRepo = new TicketRepository(db);
    const memberRepo = new TicketMemberRepository(db);
    const service = new TicketMemberService(memberRepo, ticketRepo, permissionService);

    const guild = {
      id: 'guild-users-test',
      client: { user: { id: 'bot-self-id' } },
      roles: {
        everyone: { id: 'guild-users-test' },
        cache: new Map([['role-support', { id: 'role-support' }]]),
      },
    };
    const dept = ticketRepo.createDepartment({
      guildId: guild.id,
      name: 'Geral',
      description: 'Desc',
      staffRoleId: 'role-support',
    });
    const ticket = ticketRepo.createTicketReservation({
      guildId: guild.id,
      creatorId: 'user-author-orig',
      departmentId: dept.id,
      subject: 'Assunto',
      description: 'Descricao',
    });

    const actorMember = {
      id: 'staff-user-1',
      permissions: { has: () => false },
      roles: { cache: new Map([['role-support', true]]) },
    };

    // 1. addParticipant - utilizador inválido
    await assert.rejects(
      () => service.addParticipant({ guild, ticket, user: null, actorMember, department: dept }),
      (err) => {
        assert.equal(err.code, 'INVALID_USER');
        return true;
      }
    );

    // 2. addParticipant - bot
    await assert.rejects(
      () => service.addParticipant({ guild, ticket, user: { id: 'bot-1', bot: true }, actorMember, department: dept }),
      (err) => {
        assert.equal(err.code, 'CANNOT_ADD_BOT');
        return true;
      }
    );
    await assert.rejects(
      () => service.addParticipant({ guild, ticket, user: { id: 'bot-self-id' }, actorMember, department: dept }),
      (err) => {
        assert.equal(err.code, 'CANNOT_ADD_BOT');
        return true;
      }
    );

    // 3. addParticipant - autor
    await assert.rejects(
      () => service.addParticipant({ guild, ticket, user: { id: 'user-author-orig' }, actorMember, department: dept }),
      (err) => {
        assert.equal(err.code, 'CANNOT_ADD_CREATOR');
        return true;
      }
    );

    // 4. addParticipant - @everyone
    await assert.rejects(
      () => service.addParticipant({ guild, ticket, user: { id: guild.id }, actorMember, department: dept }),
      (err) => {
        assert.equal(err.code, 'INVALID_PARTICIPANT');
        return true;
      }
    );

    // 5. removeParticipant - utilizador inválido
    await assert.rejects(
      () => service.removeParticipant({ guild, ticket, user: null, actorMember, department: dept }),
      (err) => {
        assert.equal(err.code, 'INVALID_USER');
        return true;
      }
    );

    // 6. removeParticipant - autor
    await assert.rejects(
      () => service.removeParticipant({ guild, ticket, user: { id: 'user-author-orig' }, actorMember, department: dept }),
      (err) => {
        assert.equal(err.code, 'CANNOT_REMOVE_CREATOR');
        return true;
      }
    );

    db.close();
  });

  // 33. addParticipant: aplica overwrite individual correto; persiste e cria exatamente um ticket_participant_added; repetição não cria overwrite/evento duplicado; se DB/evento falhar depois do overwrite, restaura/remove overwrite
  test('33. addParticipant: aplica overwrite individual correto; persiste e cria exatamente um ticket_participant_added; repetição não cria overwrite/evento duplicado; se DB/evento falhar depois do overwrite, restaura/remove overwrite', async () => {
    const db = createConnection(':memory:');
    const ticketRepo = new TicketRepository(db);
    const memberRepo = new TicketMemberRepository(db);
    const service = new TicketMemberService(memberRepo, ticketRepo, permissionService);

    const guild = {
      id: 'guild-add-p',
      client: { user: { id: 'bot-id' } },
      roles: {
        everyone: { id: 'guild-add-p' },
        cache: new Map([['role-supp', { id: 'role-supp' }]]),
      },
    };
    const dept = ticketRepo.createDepartment({
      guildId: guild.id,
      name: 'Dept',
      description: 'Desc',
      staffRoleId: 'role-supp',
    });
    const ticket = ticketRepo.createTicketReservation({
      guildId: guild.id,
      creatorId: 'author-id',
      departmentId: dept.id,
      subject: 'Ajuda',
      description: 'Descricao',
    });

    const actorMember = {
      id: 'staff-id',
      permissions: { has: () => false },
      roles: { cache: new Map([['role-supp', true]]) },
    };

    const overwriteCalls = { edit: [], delete: [] };
    const mockChannel = {
      id: 'chan-123',
      permissionOverwrites: {
        edit: async (userId, perms) => {
          overwriteCalls.edit.push({ userId, perms });
        },
        delete: async (userId) => {
          overwriteCalls.delete.push(userId);
        },
      },
    };

    // 1. Sucesso na adição
    const user1 = { id: 'user-guest-1', bot: false };
    const res1 = await service.addParticipant({
      guild,
      channel: mockChannel,
      ticket,
      user: user1,
      actorMember,
      department: dept,
    });

    assert.equal(res1.success, true);
    assert.equal(res1.alreadyMember, false);
    assert.equal(overwriteCalls.edit.length, 1);
    assert.equal(overwriteCalls.edit[0].userId, 'user-guest-1');
    assert.deepEqual(overwriteCalls.edit[0].perms, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
      AttachFiles: true,
      EmbedLinks: true,
    });

    // DB persistido
    assert.equal(memberRepo.isMember(ticket.id, 'user-guest-1', guild.id), true);

    // Evento ticket_participant_added criado
    const events = ticketRepo.getEventsByTicket(ticket.id);
    assert.equal(events.length, 1);
    assert.equal(events[0].event_type, 'ticket_participant_added');
    assert.equal(events[0].actor_id, 'staff-id');

    // 2. Repetição (idempotência): não cria overwrite nem evento duplicado
    const resRepeat = await service.addParticipant({
      guild,
      channel: mockChannel,
      ticket,
      user: user1,
      actorMember,
      department: dept,
    });
    assert.equal(resRepeat.success, true);
    assert.equal(resRepeat.alreadyMember, true);
    assert.equal(overwriteCalls.edit.length, 1, 'Não deve chamar edit novamente');
    assert.equal(ticketRepo.getEventsByTicket(ticket.id).length, 1, 'Não deve criar evento duplicado');

    // 3. Falha na BD/evento após overwrite: compensação remove overwrite
    const userFail = { id: 'user-guest-fail', bot: false };
    const origCreateEvent = ticketRepo.createEvent;
    ticketRepo.createEvent = () => {
      throw new Error('Falha simulada no registo de auditoria');
    };

    const origErr = logger.error;
    logger.error = () => {};

    try {
      await assert.rejects(
        () =>
          service.addParticipant({
            guild,
            channel: mockChannel,
            ticket,
            user: userFail,
            actorMember,
            department: dept,
          }),
        /Falha simulada no registo de auditoria/
      );

      // Overwrite editado e depois revertido (delete chamado)
      assert.equal(overwriteCalls.edit.some((c) => c.userId === 'user-guest-fail'), true);
      assert.equal(overwriteCalls.delete.includes('user-guest-fail'), true);

      // Não deve permanecer na BD
      assert.equal(memberRepo.isMember(ticket.id, 'user-guest-fail', guild.id), false);
    } finally {
      logger.error = origErr;
      ticketRepo.createEvent = origCreateEvent;
      db.close();
    }
  });

  // 34. removeParticipant: remove overwrite; apaga DB e cria exatamente um ticket_participant_removed; repetição idempotente sem evento; se DB/evento falhar, restaura overwrite
  test('34. removeParticipant: remove overwrite; apaga DB e cria exatamente um ticket_participant_removed; repetição idempotente sem evento; se DB/evento falhar, restaura overwrite', async () => {
    const db = createConnection(':memory:');
    const ticketRepo = new TicketRepository(db);
    const memberRepo = new TicketMemberRepository(db);
    const service = new TicketMemberService(memberRepo, ticketRepo, permissionService);

    const guild = {
      id: 'guild-rem-p',
      client: { user: { id: 'bot-id' } },
      roles: {
        everyone: { id: 'guild-rem-p' },
        cache: new Map([['role-supp', { id: 'role-supp' }]]),
      },
    };
    const dept = ticketRepo.createDepartment({
      guildId: guild.id,
      name: 'Dept',
      description: 'Desc',
      staffRoleId: 'role-supp',
    });
    const ticket = ticketRepo.createTicketReservation({
      guildId: guild.id,
      creatorId: 'author-id',
      departmentId: dept.id,
      subject: 'Ajuda',
      description: 'Descricao',
    });

    const actorMember = {
      id: 'staff-id',
      permissions: { has: () => false },
      roles: { cache: new Map([['role-supp', true]]) },
    };

    const overwriteCalls = { edit: [], delete: [] };
    const mockChannel = {
      id: 'chan-123',
      permissionOverwrites: {
        edit: async (userId, perms) => {
          overwriteCalls.edit.push({ userId, perms });
        },
        delete: async (userId) => {
          overwriteCalls.delete.push(userId);
        },
      },
    };

    // Pré-adicionar user-1
    memberRepo.addMember({ ticketId: ticket.id, userId: 'user-guest-1', addedBy: 'staff-id', guildId: guild.id });

    // 1. Sucesso na remoção
    const resRem = await service.removeParticipant({
      guild,
      channel: mockChannel,
      ticket,
      user: { id: 'user-guest-1' },
      actorMember,
      department: dept,
    });

    assert.equal(resRem.success, true);
    assert.equal(resRem.notMember, false);
    assert.equal(overwriteCalls.delete.includes('user-guest-1'), true);
    assert.equal(memberRepo.isMember(ticket.id, 'user-guest-1', guild.id), false);

    const events = ticketRepo.getEventsByTicket(ticket.id);
    assert.equal(events.length, 1);
    assert.equal(events[0].event_type, 'ticket_participant_removed');
    assert.equal(events[0].actor_id, 'staff-id');

    // 2. Repetição: idempotência amigável sem novo evento nem delete
    const resRemRepeat = await service.removeParticipant({
      guild,
      channel: mockChannel,
      ticket,
      user: { id: 'user-guest-1' },
      actorMember,
      department: dept,
    });
    assert.equal(resRemRepeat.success, true);
    assert.equal(resRemRepeat.notMember, true);
    assert.equal(ticketRepo.getEventsByTicket(ticket.id).length, 1);

    // 3. Falha compensada: se evento/BD falhar, restaura overwrite
    memberRepo.addMember({ ticketId: ticket.id, userId: 'user-guest-err', addedBy: 'staff-id', guildId: guild.id });
    const origCreateEvent = ticketRepo.createEvent;
    ticketRepo.createEvent = () => {
      throw new Error('Falha simulada no registo de auditoria');
    };

    const origErr = logger.error;
    logger.error = () => {};

    try {
      await assert.rejects(
        () =>
          service.removeParticipant({
            guild,
            channel: mockChannel,
            ticket,
            user: { id: 'user-guest-err' },
            actorMember,
            department: dept,
          }),
        /Falha simulada no registo de auditoria/
      );

      // Overwrite foi deletado e depois restaurado via edit
      assert.equal(overwriteCalls.delete.includes('user-guest-err'), true);
      assert.equal(overwriteCalls.edit.some((c) => c.userId === 'user-guest-err'), true);

      // Participante restaurado na BD
      assert.equal(memberRepo.isMember(ticket.id, 'user-guest-err', guild.id), true);
    } finally {
      logger.error = origErr;
      ticketRepo.createEvent = origCreateEvent;
      db.close();
    }
  });

  // 35. Transferência DB: destino ativo/mesma guild/diferente; update condicional; isolamento; evento somente no sucesso
  test('35. Transferência DB: destino ativo/mesma guild/diferente; update condicional; isolamento; evento somente no sucesso', async () => {
    const db = createConnection(':memory:');
    const ticketRepo = new TicketRepository(db);
    const settingsRepo = new SettingsRepository(db);
    const service = new TicketService(ticketRepo, settingsRepo, permissionService, new TicketMemberRepository(db));

    const guild1 = 'guild-trans-1';
    const guild2 = 'guild-trans-2';
    settingsRepo.upsertGuildSettings(guild1, { default_staff_role_id: 'role-s1' });
    settingsRepo.upsertGuildSettings(guild2, { default_staff_role_id: 'role-s2' });

    const dept1A = ticketRepo.createDepartment({ guildId: guild1, name: 'Dept 1A', description: 'Desc' });
    const dept1B = ticketRepo.createDepartment({ guildId: guild1, name: 'Dept 1B', description: 'Desc' });
    const dept1Inactive = ticketRepo.createDepartment({ guildId: guild1, name: 'Dept 1 Inactive', description: 'Desc' });
    ticketRepo.deactivateDepartment(dept1Inactive.id, guild1);

    const dept2A = ticketRepo.createDepartment({ guildId: guild2, name: 'Dept 2A', description: 'Desc' });

    const ticket1 = ticketRepo.createTicketReservation({
      guildId: guild1,
      creatorId: 'user-u1',
      departmentId: dept1A.id,
      subject: 'Problema 1',
      description: 'Desc 1',
    });
    ticketRepo.setTicketChannelId(ticket1.id, 'chan-trans-1');

    const ticket2 = ticketRepo.createTicketReservation({
      guildId: guild2,
      creatorId: 'user-u2',
      departmentId: dept2A.id,
      subject: 'Problema 2',
      description: 'Desc 2',
    });
    ticketRepo.setTicketChannelId(ticket2.id, 'chan-trans-2');

    const mockGuild1 = {
      id: guild1,
      roles: { cache: new Map([['role-s1', { id: 'role-s1' }]]) },
      members: { me: { id: 'bot-id' } },
    };
    const mockStaff1 = {
      id: 'staff-u1',
      permissions: { has: () => false },
      roles: { cache: new Map([['role-s1', true]]) },
    };

    // 1. Destino inativo
    await assert.rejects(
      () =>
        service.transferTicket({
          channelId: 'chan-trans-1',
          guildId: guild1,
          member: mockStaff1,
          guild: mockGuild1,
          newDepartmentId: dept1Inactive.id,
        }),
      (err) => {
        assert.equal(err.code, 'DEPARTMENT_NOT_AVAILABLE');
        return true;
      }
    );

    // 2. Destino em outra guild
    await assert.rejects(
      () =>
        service.transferTicket({
          channelId: 'chan-trans-1',
          guildId: guild1,
          member: mockStaff1,
          guild: mockGuild1,
          newDepartmentId: dept2A.id,
        }),
      (err) => {
        assert.equal(err.code, 'DEPARTMENT_NOT_AVAILABLE');
        return true;
      }
    );

    // 3. Destino idêntico (mesmo departamento)
    await assert.rejects(
      () =>
        service.transferTicket({
          channelId: 'chan-trans-1',
          guildId: guild1,
          member: mockStaff1,
          guild: mockGuild1,
          newDepartmentId: dept1A.id,
        }),
      (err) => {
        assert.equal(err.code, 'SAME_DEPARTMENT');
        return true;
      }
    );

    // 4. Update condicional: ticket fechado
    db.prepare("UPDATE tickets SET status = 'closed' WHERE id = ?").run(ticket1.id);
    await assert.rejects(
      () =>
        service.transferTicket({
          channelId: 'chan-trans-1',
          guildId: guild1,
          member: mockStaff1,
          guild: mockGuild1,
          newDepartmentId: dept1B.id,
        }),
      (err) => {
        assert.equal(err.code, 'TICKET_NOT_ACTIVE');
        return true;
      }
    );
    db.prepare("UPDATE tickets SET status = 'new' WHERE id = ?").run(ticket1.id);

    // 5. Conflito concorrente em ticketRepo.transferDepartment
    assert.throws(
      () => {
        ticketRepo.transferDepartment({
          ticketId: ticket1.id,
          newDepartmentId: dept1B.id,
          guildId: guild1,
          oldDepartmentId: 99999, // mismatch
        });
      },
      (err) => {
        assert.equal(err.code, 'CONCURRENT_MODIFICATION');
        return true;
      }
    );

    // 6. Transferência com sucesso: isolamento e evento apenas no sucesso
    const transRes = await service.transferTicket({
      channelId: 'chan-trans-1',
      guildId: guild1,
      member: mockStaff1,
      guild: mockGuild1,
      newDepartmentId: dept1B.id,
    });
    assert.equal(transRes.ticket.department_id, dept1B.id);
    assert.equal(transRes.event.event_type, 'ticket_transferred');

    // Isolamento: ticket 2 em guild 2 permanece inalterado
    const t2After = ticketRepo.getTicketById(ticket2.id, guild2);
    assert.equal(t2After.department_id, dept2A.id);

    // Evento apenas para guild 1
    const eventsG1 = ticketRepo.getEventsByTicket(ticket1.id);
    assert.equal(eventsG1.filter((e) => e.event_type === 'ticket_transferred').length, 1);
    const eventsG2 = ticketRepo.getEventsByTicket(ticket2.id);
    assert.equal(eventsG2.filter((e) => e.event_type === 'ticket_transferred').length, 0);

    db.close();
  });

  // 36. Transferência Discord+DB com mocks: move categoria quando diferente; troca cargo antigo pelo novo; preserva autor, bot e participantes; atualiza painel; destino com cargo/categoria ausente ou permissões insuficientes falha antes de mutar; falha Discord não altera DB/evento; falha DB após Discord tenta restaurar parent e overwrites e não declara sucesso
  test('36. Transferência Discord+DB com mocks: move categoria quando diferente; troca cargo antigo pelo novo; preserva autor, bot e participantes; atualiza painel; destino com cargo/categoria ausente ou permissões insuficientes falha antes de mutar; falha Discord não altera DB/evento; falha DB após Discord tenta restaurar parent e overwrites e não declara sucesso', async () => {
    const db = createConnection(':memory:');
    const ticketRepo = new TicketRepository(db);
    const settingsRepo = new SettingsRepository(db);
    const memberRepo = new TicketMemberRepository(db);
    const service = new TicketService(ticketRepo, settingsRepo, permissionService, memberRepo);

    const guildId = 'guild-mock-trans';
    const channelId = 'chan-mock-trans';

    settingsRepo.upsertGuildSettings(guildId, {
      default_staff_role_id: 'role-global-staff',
      ticket_category_id: 'cat-old',
    });

    const deptOld = ticketRepo.createDepartment({
      guildId,
      name: 'Suporte Antigo',
      description: 'Desc',
      staffRoleId: 'role-old-staff',
      categoryId: 'cat-old',
    });

    const deptNew = ticketRepo.createDepartment({
      guildId,
      name: 'Suporte Novo',
      description: 'Desc',
      staffRoleId: 'role-new-staff',
      categoryId: 'cat-new',
    });

    const ticket = ticketRepo.createTicketReservation({
      guildId,
      creatorId: 'user-author-99',
      departmentId: deptOld.id,
      subject: 'Problema Inicial',
      description: 'Descricao',
    });
    ticketRepo.setTicketChannelId(ticket.id, channelId);
    ticketRepo.setControlMessageId(ticket.id, 'msg-ctrl-123', guildId);

    // Adicionar um participante
    memberRepo.addMember({ ticketId: ticket.id, userId: 'user-part-33', addedBy: 'staff', guildId });

    // Mock das categorias e cargos no servidor
    const mockCatOld = { id: 'cat-old', type: ChannelType.GuildCategory };
    const mockCatNew = {
      id: 'cat-new',
      type: ChannelType.GuildCategory,
      permissionsFor: () => ({
        has: (flag) => flag === PermissionFlagsBits.ViewChannel || flag === PermissionFlagsBits.ManageChannels,
      }),
    };

    const rolesMap = new Map([
      ['role-old-staff', { id: 'role-old-staff' }],
      ['role-new-staff', { id: 'role-new-staff' }],
    ]);

    const channelsMap = new Map([
      ['cat-old', mockCatOld],
      ['cat-new', mockCatNew],
    ]);

    const mockGuild = {
      id: guildId,
      roles: { cache: rolesMap },
      channels: { cache: channelsMap },
      members: {
        me: { id: 'bot-123', permissions: { has: () => true } },
      },
    };

    const mockStaff = {
      id: 'staff-actor',
      permissions: { has: () => false },
      roles: { cache: new Map([['role-old-staff', true]]) },
    };

    // 1. Sucesso na transferência: move categoria, troca cargo, preserva autor/bot/participantes, atualiza painel
    let parentSet = null;
    const deletedOverwrites = [];
    const editedOverwrites = [];
    let panelEditedPayload = null;

    const mockChannel = {
      id: channelId,
      parentId: 'cat-old',
      setParent: async (newParent, opts) => {
        parentSet = { newParent, opts };
        mockChannel.parentId = newParent;
      },
      permissionOverwrites: {
        delete: async (id) => {
          deletedOverwrites.push(id);
        },
        edit: async (id, perms) => {
          editedOverwrites.push({ id, perms });
        },
      },
      messages: {
        fetch: async (msgId) => {
          if (msgId === 'msg-ctrl-123') {
            return {
              id: msgId,
              edit: async (payload) => {
                panelEditedPayload = payload;
              },
            };
          }
          throw new Error('DiscordAPIError[10008]: Unknown Message');
        },
      },
    };

    channelsMap.set(channelId, mockChannel);

    const transRes = await service.transferTicket({
      channelId,
      guildId,
      member: mockStaff,
      guild: mockGuild,
      channel: mockChannel,
      newDepartmentId: deptNew.id,
    });

    assert.equal(transRes.ticket.department_id, deptNew.id);
    assert.equal(parentSet.newParent, 'cat-new');
    assert.equal(parentSet.opts.lockPermissions, false);
    assert.equal(deletedOverwrites.includes('role-old-staff'), true);
    assert.equal(editedOverwrites.some((o) => o.id === 'role-new-staff'), true);
    assert.equal(deletedOverwrites.includes('user-author-99'), false, 'Não deve remover autor');
    assert.equal(deletedOverwrites.includes('bot-123'), false, 'Não deve remover bot');
    assert.equal(deletedOverwrites.includes('user-part-33'), false, 'Não deve remover participante');
    assert.ok(panelEditedPayload, 'Painel deve ter sido atualizado');

    // 2. Destino com cargo ausente: falha antes de mutar
    rolesMap.delete('role-old-staff');
    await assert.rejects(
      () =>
        service.transferTicket({
          channelId,
          guildId,
          member: { ...mockStaff, roles: { cache: new Map([['role-new-staff', true]]) } },
          guild: mockGuild,
          channel: mockChannel,
          newDepartmentId: deptOld.id,
        }),
      (err) => {
        assert.equal(err.code, 'STAFF_ROLE_NOT_FOUND');
        return true;
      }
    );
    rolesMap.set('role-old-staff', { id: 'role-old-staff' });

    // 3. Destino com categoria ausente: falha antes de mutar
    channelsMap.delete('cat-old');
    await assert.rejects(
      () =>
        service.transferTicket({
          channelId,
          guildId,
          member: { ...mockStaff, roles: { cache: new Map([['role-new-staff', true]]) } },
          guild: mockGuild,
          channel: mockChannel,
          newDepartmentId: deptOld.id,
        }),
      (err) => {
        assert.equal(err.code, 'CATEGORY_NOT_FOUND');
        return true;
      }
    );
    channelsMap.set('cat-old', mockCatOld);

    // 4. Categoria com permissões insuficientes: falha antes de mutar
    mockCatOld.permissionsFor = () => ({
      has: () => false,
    });
    await assert.rejects(
      () =>
        service.transferTicket({
          channelId,
          guildId,
          member: { ...mockStaff, roles: { cache: new Map([['role-new-staff', true]]) } },
          guild: mockGuild,
          channel: mockChannel,
          newDepartmentId: deptOld.id,
        }),
      (err) => {
        assert.equal(err.code, 'INSUFFICIENT_CATEGORY_PERMISSIONS');
        return true;
      }
    );
    mockCatOld.permissionsFor = () => ({ has: () => true });

    // 5. Falha no Discord não altera BD/evento
    const origSetParent = mockChannel.setParent;
    mockChannel.setParent = async () => {
      throw new Error('DiscordAPIError[50013]: Missing Permissions');
    };

    const origErr = logger.error;
    logger.error = () => {};

    try {
      await assert.rejects(
        () =>
          service.transferTicket({
            channelId,
            guildId,
            member: { ...mockStaff, roles: { cache: new Map([['role-new-staff', true]]) } },
            guild: mockGuild,
            channel: mockChannel,
            newDepartmentId: deptOld.id,
          }),
        (err) => {
          assert.equal(err.code, 'DISCORD_MUTATION_FAILED');
          return true;
        }
      );

      // BD intacta
      const ticketInDb = ticketRepo.getTicketById(ticket.id, guildId);
      assert.equal(ticketInDb.department_id, deptNew.id, 'BD não deve ser alterada em caso de falha Discord');
    } finally {
      logger.error = origErr;
      mockChannel.setParent = origSetParent;
    }

    // 6. Falha BD após Discord tenta restaurar parent e overwrites e não declara sucesso
    const origTransferDept = ticketRepo.transferDepartment;
    ticketRepo.transferDepartment = () => {
      throw new Error('SQLITE_ERROR: database is locked');
    };

    let restoredParent = null;
    let revertedNewRole = false;
    let restoredOldRole = false;

    mockChannel.setParent = async (parent) => {
      restoredParent = parent;
      mockChannel.parentId = parent;
    };
    mockChannel.permissionOverwrites.delete = async (id) => {
      if (id === 'role-old-staff') revertedNewRole = true;
    };
    mockChannel.permissionOverwrites.edit = async (id) => {
      if (id === 'role-new-staff') restoredOldRole = true;
    };

    logger.error = () => {};
    try {
      await assert.rejects(
        () =>
          service.transferTicket({
            channelId,
            guildId,
            member: { ...mockStaff, roles: { cache: new Map([['role-new-staff', true]]) } },
            guild: mockGuild,
            channel: mockChannel,
            newDepartmentId: deptOld.id,
          }),
        /SQLITE_ERROR/
      );

      // Discord restaurado
      assert.equal(restoredParent, 'cat-new', 'Parent deve ser revertido para o original');
      assert.equal(revertedNewRole, true, 'Overwrite adicionado deve ser revertido');
      assert.equal(restoredOldRole, true, 'Overwrite removido deve ser restaurado');
    } finally {
      logger.error = origErr;
      ticketRepo.transferDepartment = origTransferDept;
      db.close();
    }
  });

  // 37. /ticket: serializa 5 subcomandos; autocomplete lista ativos, exclui atual e limita a 25; só funciona em ticket channel; detalhes autorizado para autor/participante/staff/admin e negado a terceiros; detalhes respeita limites de embed; atualizar busca control_message_id e edita a mensagem; mensagem ausente gera erro claro sem criar duplicado; mensagens com mentions usam allowedMentions vazio
  test('37. /ticket: serializa 5 subcomandos; autocomplete lista ativos, exclui atual e limita a 25; só funciona em ticket channel; detalhes autorizado para autor/participante/staff/admin e negado a terceiros; detalhes respeita limites de embed; atualizar busca control_message_id e edita a mensagem; mensagem ausente gera erro claro sem criar duplicado; mensagens com mentions usam allowedMentions vazio', async () => {
    // 1. Serializa 5 subcomandos
    const serialized = ticketCommand.data.toJSON();
    assert.equal(serialized.name, 'ticket');
    const subcommandNames = serialized.options.map((o) => o.name);
    assert.deepEqual(subcommandNames, [
      'transferir',
      'participante-adicionar',
      'participante-remover',
      'detalhes',
      'atualizar',
    ]);

    const db = createConnection(':memory:');
    defaultTicketRepo._db = db;
    defaultSettingsRepo._db = db;
    defaultTicketMemberRepo._db = db;

    const guildId = 'guild-ticket-cmd';
    const channelId = 'chan-ticket-cmd';
    defaultSettingsRepo.upsertGuildSettings(guildId, {
      default_staff_role_id: 'role-cmd-staff',
    });

    // Criar 30 departamentos ativos
    const depts = [];
    for (let i = 1; i <= 30; i++) {
      depts.push(
        defaultTicketRepo.createDepartment({
          guildId,
          name: `Departamento ${String(i).padStart(2, '0')}`,
          description: `Desc ${i}`,
          staffRoleId: 'role-cmd-staff',
        })
      );
    }

    const currentDept = depts[4]; // Dept 5
    const ticket = defaultTicketRepo.createTicketReservation({
      guildId,
      creatorId: 'user-author-cmd',
      departmentId: currentDept.id,
      subject: 'Problema /ticket',
      description: 'Descricao longa de teste',
      priority: 'normal',
    });
    defaultTicketRepo.setTicketChannelId(ticket.id, channelId);
    defaultTicketRepo.setControlMessageId(ticket.id, 'msg-ctrl-cmd', guildId);

    // Participante
    defaultTicketMemberRepo.addMember({
      ticketId: ticket.id,
      userId: 'user-part-cmd',
      addedBy: 'staff',
      guildId,
    });

    // 2. Autocomplete: lista ativos, exclui atual e limita a 25
    let autocompleteResponse = null;
    const mockAutocompleteInteraction = {
      guildId,
      channelId,
      options: {
        getFocused: () => ({ name: 'departamento', value: '' }),
      },
      respond: async (results) => {
        autocompleteResponse = results;
      },
    };

    await ticketCommand.autocomplete(mockAutocompleteInteraction);
    assert.ok(autocompleteResponse);
    assert.equal(autocompleteResponse.length, 25, 'Limite máximo de 25 no autocomplete');
    assert.equal(
      autocompleteResponse.some((item) => item.value === String(currentDept.id)),
      false,
      'Autocomplete deve excluir o departamento atual do ticket'
    );

    // 3. Só funciona em ticket channel
    let nonTicketReply = null;
    const mockNonTicketInteraction = {
      guildId,
      guild: { id: guildId },
      channelId: 'chan-outside-tickets',
      options: {
        getSubcommand: () => 'detalhes',
      },
      deferred: false,
      replied: false,
      deferReply: async function () {
        this.deferred = true;
      },
      editReply: async (payload) => {
        nonTicketReply = payload;
      },
      reply: async (payload) => {
        nonTicketReply = payload;
      },
    };

    const origErr = logger.error;
    logger.error = () => {};

    try {
      await ticketCommand.execute(mockNonTicketInteraction);
      assert.ok(nonTicketReply);
      assert.ok(
        nonTicketReply.content.includes('Este canal não corresponde a um ticket ativo'),
        `Esperava erro de canal, obteve: ${nonTicketReply.content}`
      );
      assert.deepEqual(nonTicketReply.allowedMentions, { parse: [] });
    } finally {
      logger.error = origErr;
    }

    // 4. Detalhes: autor, participante, staff e admin permitidos; terceiro negado
    const mockGuildObj = {
      id: guildId,
      roles: { cache: new Map([['role-cmd-staff', { id: 'role-cmd-staff' }]]) },
      members: { me: { id: 'bot-id' } },
    };

    const createDetailsInteraction = (member) => {
      let replyData = null;
      return {
        guildId,
        guild: mockGuildObj,
        channelId,
        member,
        options: {
          getSubcommand: () => 'detalhes',
        },
        deferred: false,
        replied: false,
        deferReply: async function () {
          this.deferred = true;
        },
        editReply: async (payload) => {
          replyData = payload;
        },
        reply: async (payload) => {
          replyData = payload;
        },
        getReply: () => replyData,
      };
    };

    // a) Autor permitido
    const authorInteraction = createDetailsInteraction({ id: 'user-author-cmd', permissions: { has: () => false }, roles: { cache: new Map() } });
    await ticketCommand.execute(authorInteraction);
    assert.ok(authorInteraction.getReply().embeds);
    assert.deepEqual(authorInteraction.getReply().allowedMentions, { parse: [] });

    // b) Participante permitido
    const partInteraction = createDetailsInteraction({ id: 'user-part-cmd', permissions: { has: () => false }, roles: { cache: new Map() } });
    await ticketCommand.execute(partInteraction);
    assert.ok(partInteraction.getReply().embeds);

    // c) Staff do departamento permitido
    const staffInteraction = createDetailsInteraction({ id: 'staff-user', permissions: { has: () => false }, roles: { cache: new Map([['role-cmd-staff', true]]) } });
    await ticketCommand.execute(staffInteraction);
    assert.ok(staffInteraction.getReply().embeds);

    // d) Admin permitido
    const adminInteraction = createDetailsInteraction({ id: 'admin-user', permissions: { has: () => true }, roles: { cache: new Map() } });
    await ticketCommand.execute(adminInteraction);
    assert.ok(adminInteraction.getReply().embeds);

    // e) Terceiro negado
    logger.error = () => {};
    const thirdPartyInteraction = createDetailsInteraction({ id: 'third-party-stranger', permissions: { has: () => false }, roles: { cache: new Map() } });
    await ticketCommand.execute(thirdPartyInteraction);
    assert.ok(thirdPartyInteraction.getReply().content.includes('Não possuis permissão para consultar os detalhes deste ticket'));
    assert.deepEqual(thirdPartyInteraction.getReply().allowedMentions, { parse: [] });
    logger.error = origErr;

    // 5. Detalhes respeita limites de embed
    const detailsResult = await defaultTicketService.getTicketDetails({
      channelId,
      guildId,
      member: { id: 'user-author-cmd', permissions: { has: () => false }, roles: { cache: new Map() } },
      guild: mockGuildObj,
    });
    const embedData = detailsResult.embed.data;
    assert.ok(embedData.title.length <= 256, 'Título do embed deve ter no máximo 256 caracteres');
    assert.ok(embedData.fields.length <= 25, 'Embed deve ter no máximo 25 campos');
    for (const field of embedData.fields) {
      assert.ok(field.name.length <= 256, `Nome do campo ${field.name} deve ter <= 256 chars`);
      assert.ok(field.value.length <= 1024, `Valor do campo ${field.name} deve ter <= 1024 chars`);
    }

    // 6. Atualizar busca control_message_id e edita a mensagem; mensagem ausente gera erro claro sem criar duplicado
    let editedControlMessage = false;
    let channelSendCalled = false;
    const mockControlMessage = {
      id: 'msg-ctrl-cmd',
      edit: async () => {
        editedControlMessage = true;
      },
    };
    const mockChannelWithCtrl = {
      id: channelId,
      send: async () => {
        channelSendCalled = true;
      },
      messages: {
        fetch: async (id) => {
          if (id === 'msg-ctrl-cmd') return mockControlMessage;
          throw new Error('Unknown Message');
        },
      },
    };

    let refreshReply = null;
    const mockRefreshInteraction = {
      guildId,
      guild: mockGuildObj,
      channelId,
      channel: mockChannelWithCtrl,
      member: { id: 'staff-user', permissions: { has: () => false }, roles: { cache: new Map([['role-cmd-staff', true]]) } },
      options: {
        getSubcommand: () => 'atualizar',
      },
      deferred: false,
      deferReply: async function () {
        this.deferred = true;
      },
      editReply: async (payload) => {
        refreshReply = payload;
      },
      reply: async (payload) => {
        refreshReply = payload;
      },
    };

    await ticketCommand.execute(mockRefreshInteraction);
    assert.equal(editedControlMessage, true, 'Deve ter editado a mensagem de controlo existente');
    assert.equal(channelSendCalled, false, 'Não deve chamar channel.send');
    assert.ok(refreshReply.content.includes('Painel do ticket atualizado com sucesso'));
    assert.deepEqual(refreshReply.allowedMentions, { parse: [] });

    // Mensagem de controlo ausente no Discord
    mockChannelWithCtrl.messages.fetch = async () => {
      const err = new Error('DiscordAPIError[10008]: Unknown Message');
      err.code = 10008;
      throw err;
    };

    let missingMsgReply = null;
    const mockRefreshMissingInteraction = {
      guildId,
      guild: mockGuildObj,
      channelId,
      channel: mockChannelWithCtrl,
      member: { id: 'staff-user', permissions: { has: () => false }, roles: { cache: new Map([['role-cmd-staff', true]]) } },
      options: {
        getSubcommand: () => 'atualizar',
      },
      deferred: false,
      deferReply: async function () {
        this.deferred = true;
      },
      editReply: async (payload) => {
        missingMsgReply = payload;
      },
      reply: async (payload) => {
        missingMsgReply = payload;
      },
    };

    logger.error = () => {};
    await ticketCommand.execute(mockRefreshMissingInteraction);
    logger.error = origErr;

    assert.equal(channelSendCalled, false, 'Não deve criar mensagem duplicada quando a mensagem original não existe');
    assert.ok(
      missingMsgReply.content.includes('A mensagem de controlo original do painel já não existe ou está inacessível'),
      `Esperava erro de mensagem inacessível, obteve: ${missingMsgReply.content}`
    );
    assert.deepEqual(missingMsgReply.allowedMentions, { parse: [] });

    // Limpeza
    defaultTicketRepo._db = null;
    defaultSettingsRepo._db = null;
    defaultTicketMemberRepo._db = null;
    db.close();
  });

  // 38. Importação e serialização de todos os comandos Slash (info, ping, server, tickets, ticket) sem REST
  test('38. Importação e serialização de todos os comandos Slash (info, ping, server, tickets, ticket) sem REST', () => {
    const commands = [
      { name: 'info', cmd: infoCommand },
      { name: 'ping', cmd: pingCommand },
      { name: 'server', cmd: serverCommand },
      { name: 'tickets', cmd: ticketsCommand },
      { name: 'ticket', cmd: ticketCommand },
    ];

    for (const { name, cmd } of commands) {
      assert.ok(cmd, `Comando ${name} deve ser importado com sucesso`);
      assert.ok(cmd.data, `Comando ${name} deve possuir propriedade data`);
      assert.equal(typeof cmd.execute, 'function', `Comando ${name} deve possuir função execute`);

      const json = cmd.data.toJSON();
      assert.equal(json.name, name, `Nome serializado de ${name} deve corresponder`);
      assert.ok(json.description, `Comando ${name} deve possuir descrição`);
    }
  });
});

describe('Sistema de Tickets - Bloco 3A', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');

  const getTestTmpDir = () => {
    return process.env.PLUS1BOT_TEST_TMPDIR || os.tmpdir();
  };

  const transcriptService = require('../src/services/transcriptService');
  const { TicketCloseService } = require('../src/services/ticketCloseService');
  const { formatClosedTicketChannelName } = require('../src/utils/ticketChannelName');
  const { TicketMemberRepository } = require('../src/repositories/ticketMemberRepository');
  const logger = require('../src/utils/logger');

  // 39. Migração em DB legado e idempotência
  test('39. Migração de schema legado com PRAGMA table_info adiciona archive_category_id e colunas de fecho de forma idempotente', () => {
    const db = new Database(':memory:');

    // Cria schema legado antigo (Entrega 1/2 sem as colunas do Bloco 3A)
    db.exec(`
      CREATE TABLE guild_settings (
        guild_id TEXT PRIMARY KEY,
        ticket_category_id TEXT,
        log_channel_id TEXT,
        default_staff_role_id TEXT,
        panel_title TEXT,
        panel_description TEXT,
        panel_color TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE ticket_departments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        emoji TEXT,
        staff_role_id TEXT,
        category_id TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        ticket_number INTEGER NOT NULL,
        creator_id TEXT NOT NULL,
        department_id INTEGER NOT NULL REFERENCES ticket_departments(id),
        channel_id TEXT,
        subject TEXT NOT NULL,
        description TEXT NOT NULL,
        reference TEXT,
        priority TEXT NOT NULL DEFAULT 'normal',
        status TEXT NOT NULL DEFAULT 'new',
        claimed_by TEXT,
        control_message_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        closed_at TEXT
      );

      CREATE TABLE ticket_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
        guild_id TEXT,
        event_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        metadata_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    // Verificar que as colunas novas ainda não existem
    const initialSettingsCols = db.prepare('PRAGMA table_info(guild_settings)').all().map((c) => c.name);
    assert.equal(initialSettingsCols.includes('archive_category_id'), false);

    const initialTicketCols = db.prepare('PRAGMA table_info(tickets)').all().map((c) => c.name);
    assert.equal(initialTicketCols.includes('closed_by'), false);
    assert.equal(initialTicketCols.includes('close_reason'), false);
    assert.equal(initialTicketCols.includes('transcript_path'), false);
    assert.equal(initialTicketCols.includes('transcript_sha256'), false);
    assert.equal(initialTicketCols.includes('transcript_message_count'), false);
    assert.equal(initialTicketCols.includes('closing_started_at'), false);

    // Executar migração
    assert.doesNotThrow(() => {
      runMigrations(db);
    });

    // Validar que foram adicionadas
    const updatedSettingsCols = db.prepare('PRAGMA table_info(guild_settings)').all().map((c) => c.name);
    assert.ok(updatedSettingsCols.includes('archive_category_id'));

    const updatedTicketCols = db.prepare('PRAGMA table_info(tickets)').all().map((c) => c.name);
    assert.ok(updatedTicketCols.includes('closed_by'));
    assert.ok(updatedTicketCols.includes('close_reason'));
    assert.ok(updatedTicketCols.includes('transcript_path'));
    assert.ok(updatedTicketCols.includes('transcript_sha256'));
    assert.ok(updatedTicketCols.includes('transcript_message_count'));
    assert.ok(updatedTicketCols.includes('closing_started_at'));

    // Executar segunda vez para validar idempotência
    assert.doesNotThrow(() => {
      runMigrations(db);
    });

    // Testar SettingsRepository com archive_category_id
    const settingsRepo = new SettingsRepository(db);
    settingsRepo.upsertGuildSettings('guild-mig-1', {
      ticket_category_id: 'cat-orig',
      archive_category_id: 'cat-archive-99',
    });

    const savedSettings = settingsRepo.getGuildSettings('guild-mig-1');
    assert.equal(savedSettings.archive_category_id, 'cat-archive-99');
    assert.equal(savedSettings.ticket_category_id, 'cat-orig');

    db.close();
  });

  // 40. Sanitização rigorosa: escapeHtml e sanitizeUrl
  test('40. Sanitização rigorosa: escapeHtml e sanitizeUrl contra XSS, injeção e esquemas perigosos', () => {
    const { escapeHtml, sanitizeUrl } = transcriptService;

    // Teste de escapeHtml
    assert.equal(escapeHtml('<script>alert("xss")</script>'), '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
    assert.equal(escapeHtml('"><img src=x onerror=alert(1)>'), '&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
    assert.equal(escapeHtml("Tom's & Jerry's"), 'Tom&#39;s &amp; Jerry&#39;s');
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
    assert.equal(escapeHtml(12345), '12345');

    // Teste de sanitizeUrl
    // Esquemas perigosos devem ser rejeitados e retornar null
    assert.equal(sanitizeUrl('javascript:alert(1)'), null);
    assert.equal(sanitizeUrl('JAVASCRIPT:alert(1)'), null);
    assert.equal(sanitizeUrl('javascript:void(0)'), null);
    assert.equal(sanitizeUrl('data:text/html;base64,PHNjcmlwdD4='), null);
    assert.equal(sanitizeUrl('file:///etc/passwd'), null);
    assert.equal(sanitizeUrl('file:///C:/Windows/system32/cmd.exe'), null);
    assert.equal(sanitizeUrl('vbscript:msgbox(1)'), null);
    assert.equal(sanitizeUrl('//attacker.com/evil'), null);
    assert.equal(sanitizeUrl('bad_url_without_protocol'), null);
    assert.equal(sanitizeUrl(''), null);
    assert.equal(sanitizeUrl(null), null);
    assert.equal(sanitizeUrl(undefined), null);

    // Esquemas válidos permitidos (apenas http e https)
    assert.equal(sanitizeUrl('http://example.com'), 'http://example.com/');
    assert.equal(sanitizeUrl('https://example.com/test?param=1&foo=bar'), 'https://example.com/test?param=1&foo=bar');
    assert.equal(sanitizeUrl('https://cdn.discordapp.com/attachments/123/456/sample.png'), 'https://cdn.discordapp.com/attachments/123/456/sample.png');
  });

  // 41. Renderização HTML cronológica e metadados seguros
  test('41. Renderização HTML autónoma, metadados completos e integridade contra injeções', () => {
    const { renderTranscriptHtml } = transcriptService;

    const testData = {
      ticket: {
        id: 42,
        ticket_number: 42,
        subject: 'Assunto com <script>alert("xss")</script>',
        description: 'Descrição com & e <tags>',
        priority: 'urgent',
        status: 'closed',
        creator_id: 'user-hacker-1',
        created_at: '2026-09-20 14:00:00',
        closed_at: '2026-09-20 15:30:00',
        close_reason: 'Concluído com sucesso <img onerror=evil()>',
        closed_by: 'staff-admin-9',
      },
      guild: { id: 'guild-77', name: 'Servidor <Alpha>' },
      channel: { id: 'chan-88', name: 'ticket-00042-user' },
      creator: { id: 'user-hacker-1', tag: 'Hacker#0001', username: '<Hacker>' },
      department: { id: 1, name: 'Suporte Técnico <VIP>' },
      claimedBy: { id: 'staff-claimant', tag: 'Atendente#1234', username: 'Atendente' },
      closedBy: { id: 'staff-admin-9', tag: 'Admin#9999', username: 'Admin' },
      participants: [{ id: 'part-1', tag: 'Amigo#5555', username: 'Amigo' }],
      messages: [
        {
          id: '1001',
          content: 'Primeira mensagem com link seguro https://plus1bot.com/docs e perigoso javascript:evil()',
          createdAt: '2026-09-20 14:05:00',
          author: { id: 'user-hacker-1', username: '<Hacker>', tag: 'Hacker#0001', bot: false },
          attachments: [
            { id: 'att-1', name: 'log<bad>.txt', url: 'https://cdn.example.com/log.txt', size: 2048 },
            { id: 'att-2', name: 'malicious.exe', url: 'javascript:alert(1)', size: 5000 },
          ],
        },
        {
          id: '1002',
          content: 'Segunda mensagem pelo suporte <b style="color:red">bold</b>',
          createdAt: '2026-09-20 14:10:00',
          editedAt: '2026-09-20 14:12:00',
          author: { id: 'staff-claimant', username: 'Atendente', tag: 'Atendente#1234', bot: false },
          embeds: [
            {
              title: 'Embed <Injetado>',
              description: 'Resumo com link http://safe.org',
              color: 0x3b82f6,
              fields: [{ name: 'Campo <1>', value: 'Valor <1>', inline: true }],
            },
          ],
        },
      ],
      truncated: false,
      messageCount: 2,
    };

    const html = renderTranscriptHtml(testData);

    // Validações estruturais e de integridade
    assert.ok(html.includes('<!DOCTYPE html>'));
    assert.ok(html.includes('TKT-00042'));
    assert.ok(html.includes('Servidor &lt;Alpha&gt;'));
    assert.ok(!html.includes('Servidor <Alpha>'));
    assert.ok(html.includes('Suporte Técnico &lt;VIP&gt;'));
    assert.ok(html.includes('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'));
    assert.ok(!html.includes('<script>alert("xss")</script>'));
    assert.ok(html.includes('Concluído com sucesso &lt;img onerror=evil()&gt;'));

    // Validação de links: link https permitido em tag <a>, link javascript proibido em tag <a>
    assert.ok(html.includes('<a href="https://plus1bot.com/docs" target="_blank" rel="noopener noreferrer" class="chat-link">https://plus1bot.com/docs</a>'));
    assert.ok(!html.includes('href="javascript:evil()"'));
    assert.ok(!html.includes('href="javascript:alert(1)"'));

    // Anexos: anexo com https gera link; anexo com javascript vira chip desativado sem <a>
    assert.ok(html.includes('<a href="https://cdn.example.com/log.txt" target="_blank" rel="noopener noreferrer" class="attachment-chip">'));
    assert.ok(html.includes('log&lt;bad&gt;.txt'));
    assert.ok(html.includes('<span class="attachment-chip disabled">'));

    // Embeds
    assert.ok(html.includes('Embed &lt;Injetado&gt;'));
    assert.ok(html.includes('Campo &lt;1&gt;'));
    assert.ok(html.includes('(editada)'));

    // Segurança: não vazar tokens, caminhos absolutos locais ou variáveis de ambiente
    assert.ok(!html.includes('process.env'));
    assert.ok(!html.includes('DISCORD_TOKEN'));
    assert.ok(!html.includes('C:\\Users'));

    // Segurança: Garantir ausência total de handlers JavaScript inline (on*)
    assert.ok(!/<[^>]+?\son[a-z]+\s*=/i.test(html), 'HTML não deve conter handlers JavaScript inline como onerror=, onload=, etc.');
  });

  // 42. Hash determinístico SHA-256 e escrita atómica com caminhos relativos
  test('42. Hash determinístico SHA-256, nome seguro e geração/escrita atómica em disco com caminho relativo', async () => {
    const {
      hashTranscript,
      generateTranscriptFileName,
      generateAndSaveTranscript,
      deleteTranscriptFile,
    } = transcriptService;

    // Hash determinístico
    const content = 'Hello, +1BOT World!';
    const hash1 = hashTranscript(content);
    const hash2 = hashTranscript(Buffer.from(content, 'utf8'));
    assert.equal(hash1, hash2);
    assert.equal(hash1.length, 64);
    assert.match(hash1, /^[a-f0-9]{64}$/);

    // Hash de conteúdos diferentes é diferente
    assert.notEqual(hashTranscript('A'), hashTranscript('B'));

    // Nome de ficheiro padronizado
    assert.equal(generateTranscriptFileName(42), 'TKT-00042-transcript.html');
    assert.equal(generateTranscriptFileName('105'), 'TKT-00105-transcript.html');

    // Nome do canal fechado
    assert.equal(formatClosedTicketChannelName(42, 'João_Silva!'), 'closed-00042-joao-silva');

    // Escrita atómica em diretório temporário
    const tmpTestDir = fs.mkdtempSync(path.join(getTestTmpDir(), 'plus1bot-transcript-test-'));
    try {
      const mockTicket = { id: 10, ticket_number: 10, status: 'closed' };
      const mockGuild = { id: 'guild-atomic-1', name: 'Guild Teste' };
      const mockChannel = { id: 'chan-10', name: 'ticket-00010-user' };
      const mockCreator = { id: 'usr-1', username: 'Tester' };

      const result = await generateAndSaveTranscript({
        ticket: mockTicket,
        guild: mockGuild,
        channel: mockChannel,
        creator: mockCreator,
        messages: [{ id: 'm1', content: 'Mensagem de teste', author: mockCreator, createdAt: new Date().toISOString() }],
        baseDir: tmpTestDir,
      });

      assert.equal(result.fileName, 'TKT-00010-transcript.html');
      assert.equal(result.relativePath, 'guild-atomic-1/TKT-00010-transcript.html');
      assert.ok(fs.existsSync(result.absolutePath), 'Ficheiro final deve existir no disco');

      const fileContent = fs.readFileSync(result.absolutePath, 'utf8');
      assert.ok(fileContent.includes('TKT-00010'));
      assert.equal(result.sha256, hashTranscript(fileContent));

      // Teste de deleteTranscriptFile
      const deleted = await deleteTranscriptFile(result.absolutePath);
      assert.equal(deleted, true);
      assert.equal(fs.existsSync(result.absolutePath), false);
    } finally {
      fs.rmSync(tmpTestDir, { recursive: true, force: true });
    }
  });

  // 43. Paginação de mensagens com mais de 100 mensagens e truncagem segura
  test('43. Paginação com mais de 100 mensagens, ordenação cronológica e indicação de truncagem', async () => {
    const { fetchChannelMessages } = transcriptService;

    // Criar 125 mensagens simuladas no canal (IDs de 1 a 125)
    // Discord fetch devolve do mais recente para o mais antigo ao paginar com `before`
    const generatedMsgs = [];
    const baseTime = new Date('2026-09-20T10:00:00Z').getTime();
    for (let i = 1; i <= 125; i++) {
      generatedMsgs.push({
        id: String(i).padStart(4, '0'),
        content: `Mensagem número ${i}`,
        createdTimestamp: baseTime + (i * 1000),
        author: { id: `user-${i % 3}`, username: `User${i % 3}`, bot: i % 5 === 0 },
        attachments: [],
        embeds: [],
      });
    }

    // Mock do canal Discord que devolve até 100 mensagens por chamada
    const mockDiscordChannel = {
      messages: {
        fetch: async ({ limit = 100, before = null }) => {
          let pool = [...generatedMsgs];
          if (before) {
            const beforeIndex = pool.findIndex((m) => m.id === before);
            if (beforeIndex !== -1) {
              pool = pool.slice(0, beforeIndex);
            }
          }
          // Mais recentes primeiro no lote retornado pelo Discord
          pool.reverse();
          const sliced = pool.slice(0, limit);
          return new Map(sliced.map((m) => [m.id, m]));
        },
      },
    };

    // 1. Recolha completa com limite de 1000 (deve fazer 2 páginas e trazer todas as 125)
    const resAll = await fetchChannelMessages(mockDiscordChannel, { limit: 1000, batchSize: 100 });
    assert.equal(resAll.messageCount, 125);
    assert.equal(resAll.truncated, false);
    assert.equal(resAll.messages.length, 125);
    // Garantir ordenação cronológica: primeira mensagem é a 0001, última é a 0125
    assert.equal(resAll.messages[0].id, '0001');
    assert.equal(resAll.messages[124].id, '0125');

    // 2. Recolha com truncagem: limite de 50 mensagens
    const resTrunc = await fetchChannelMessages(mockDiscordChannel, { limit: 50, batchSize: 100 });
    assert.equal(resTrunc.messageCount, 50);
    assert.equal(resTrunc.truncated, true);
  });

  // 44. Repositório: beginClose, finalizeClose, abortClose e libertação do índice único ativo
  test('44. finalizeClose grava metadados e liberta índice de ticket ativo para o utilizador abrir novo', () => {
    const db = createConnection(':memory:');
    const ticketRepo = new TicketRepository(db);

    const guildId = 'guild-close-repo';
    const creatorId = 'user-close-repo';

    // Criar departamento e ticket ativo
    const dept = ticketRepo.createDepartment({
      guildId,
      name: 'Geral',
      description: 'Geral',
    });

    const ticket1 = ticketRepo.createTicketReservation({
      guildId,
      creatorId,
      departmentId: dept.id,
      subject: 'Primeiro ticket ativo',
      description: 'Descricao com mais de dez chars',
    });

    // Tentativa de criar segundo ticket ativo para o mesmo utilizador deve falhar
    assert.throws(
      () => {
        ticketRepo.createTicketReservation({
          guildId,
          creatorId,
          departmentId: dept.id,
          subject: 'Segundo ticket',
          description: 'Descricao com mais de dez chars',
        });
      },
      { code: 'ACTIVE_TICKET_EXISTS' }
    );

    // Iniciar fecho (beginClose)
    const beginRes = ticketRepo.beginClose({
      ticketId: ticket1.id,
      guildId,
      actorId: 'staff-closer',
    });
    assert.ok(beginRes.ticket.closing_started_at);

    // Abortar fecho (abortClose)
    const aborted = ticketRepo.abortClose(ticket1.id, guildId);
    assert.equal(aborted, true);
    const unclosedTicket = ticketRepo.getTicketById(ticket1.id, guildId);
    assert.equal(unclosedTicket.closing_started_at, null);
    assert.equal(unclosedTicket.status, 'new');

    // Reiniciar e finalizar fecho
    ticketRepo.beginClose({ ticketId: ticket1.id, guildId, actorId: 'staff-closer' });
    const closedTicket = ticketRepo.finalizeClose({
      ticketId: ticket1.id,
      guildId,
      closedBy: 'staff-closer',
      reason: 'Atendimento concluído com o utilizador',
      transcriptPath: 'guild-close-repo/TKT-00001-transcript.html',
      transcriptSha256: 'a1b2c3d4e5f60000000000000000000000000000000000000000000000000000',
      transcriptMessageCount: 15,
    });

    assert.equal(closedTicket.status, 'closed');
    assert.equal(closedTicket.closed_by, 'staff-closer');
    assert.equal(closedTicket.close_reason, 'Atendimento concluído com o utilizador');
    assert.equal(closedTicket.transcript_path, 'guild-close-repo/TKT-00001-transcript.html');
    assert.equal(closedTicket.transcript_message_count, 15);
    assert.ok(closedTicket.closed_at);
    assert.equal(closedTicket.closing_started_at, null);

    // getClosureMetadata
    const closureMeta = ticketRepo.getClosureMetadata(ticket1.id, guildId);
    assert.equal(closureMeta.status, 'closed');
    assert.equal(closureMeta.closed_by, 'staff-closer');

    // Agora que o ticket1 está closed, o utilizador DEVE poder abrir um novo ticket imediatamente!
    const ticket2 = ticketRepo.createTicketReservation({
      guildId,
      creatorId,
      departmentId: dept.id,
      subject: 'Novo ticket após fecho',
      description: 'Descricao com mais de dez chars',
    });

    assert.ok(ticket2);
    assert.equal(ticket2.ticket_number, 2);
    assert.equal(ticket2.status, 'new');

    db.close();
  });

  // 45. Concorrência: apenas um fecho simultâneo
  test('45. Proteção de concorrência: apenas um fecho em processamento por ticket', async () => {
    const db = createConnection(':memory:');
    const ticketRepo = new TicketRepository(db);
    const settingsRepo = new SettingsRepository(db);
    const memberRepo = new TicketMemberRepository(db);

    const guildId = 'guild-concurrent-close';
    const dept = ticketRepo.createDepartment({ guildId, name: 'Geral', description: 'Geral' });
    const ticket = ticketRepo.createTicketReservation({
      guildId,
      creatorId: 'user-c',
      departmentId: dept.id,
      subject: 'Ticket para concorrência',
      description: 'Descricao com mais de dez chars',
    });

    // 1. Concorrência no repositório com beginClose
    ticketRepo.beginClose({ ticketId: ticket.id, guildId, actorId: 'staff-1' });

    assert.throws(
      () => {
        ticketRepo.beginClose({ ticketId: ticket.id, guildId, actorId: 'staff-2' });
      },
      { code: 'CONCURRENT_CLOSE' }
    );

    // 2. Concorrência no serviço
    ticketRepo.abortClose(ticket.id, guildId);
    const closeService = new TicketCloseService({
      ticketRepo,
      settingsRepo,
      ticketMemberRepo: memberRepo,
      permService: permissionService,
    });

    // Simular lock em voo
    const lockKey = `${guildId}:chan-conc`;
    closeService.closingLocks.add(lockKey);

    await assert.rejects(
      async () => {
        await closeService.closeTicket({
          channelId: 'chan-conc',
          guildId,
          member: { id: 'admin', permissions: { has: () => true } },
          guild: { id: guildId, channels: { cache: new Map() } },
        });
      },
      { code: 'CONCURRENT_CLOSE' }
    );

    closeService.closingLocks.delete(lockKey);
    db.close();
  });

  // 46. Autorização estrita para fechar ticket
  test('46. Autorização estrita de fecho: resolvido, responsável atual ou administrador com override', () => {
    const db = createConnection(':memory:');
    const ticketRepo = new TicketRepository(db);
    const settingsRepo = new SettingsRepository(db);
    const memberRepo = new TicketMemberRepository(db);
    const closeService = new TicketCloseService({ ticketRepo, settingsRepo, ticketMemberRepo: memberRepo, permService: permissionService });

    const guildId = 'guild-auth-close';
    const dept = ticketRepo.createDepartment({ guildId, name: 'Suporte', description: 'Suporte', staffRoleId: 'role-staff' });
    settingsRepo.upsertGuildSettings(guildId, { default_staff_role_id: 'role-staff' });

    const ticket = ticketRepo.createTicketReservation({
      guildId,
      creatorId: 'user-author',
      departmentId: dept.id,
      subject: 'Ticket de teste de auth',
      description: 'Descricao com mais de dez chars',
    });

    const mockGuild = { id: guildId, roles: { cache: new Map([['role-staff', { id: 'role-staff' }]]) } };
    const normalStaffMember = { id: 'staff-normal', permissions: { has: () => false }, roles: { cache: new Map([['role-staff', true]]) } };
    const claimantMember = { id: 'staff-claimant', permissions: { has: () => false }, roles: { cache: new Map([['role-staff', true]]) } };
    const adminMember = { id: 'admin-user', permissions: { has: () => true }, roles: { cache: new Map() } };

    // 1. Ticket não atribuído (claimed_by === null) e não resolvido ('new')
    // Staff normal não pode fechar
    assert.throws(
      () => {
        closeService.validateCloseAuthorization({
          ticket,
          member: normalStaffMember,
          guild: mockGuild,
          department: dept,
        });
      },
      { code: 'FORBIDDEN_NOT_CLAIMANT' }
    );

    // Admin pode fechar com adminOverride mesmo não estando resolvido
    const adminAuth = closeService.validateCloseAuthorization({
      ticket,
      member: adminMember,
      guild: mockGuild,
      department: dept,
      adminOverride: true,
    });
    assert.equal(adminAuth.allowed, true);
    assert.equal(adminAuth.isAdmin, true);

    // 2. Ticket assumido por staff-claimant, mas no estado 'assigned' ou 'in_progress'
    ticketRepo.claimTicket({ ticketId: ticket.id, staffUserId: claimantMember.id, guildId });
    const assignedTicket = ticketRepo.getTicketById(ticket.id, guildId);

    // Staff que não é o responsável é rejeitado
    assert.throws(
      () => {
        closeService.validateCloseAuthorization({
          ticket: assignedTicket,
          member: normalStaffMember,
          guild: mockGuild,
          department: dept,
        });
      },
      { code: 'FORBIDDEN_NOT_CLAIMANT' }
    );

    // O próprio responsável tenta fechar sem estar no estado 'resolved'
    assert.throws(
      () => {
        closeService.validateCloseAuthorization({
          ticket: assignedTicket,
          member: claimantMember,
          guild: mockGuild,
          department: dept,
        });
      },
      { code: 'TICKET_NOT_RESOLVED' }
    );

    // 3. Atualizar para 'in_progress' e depois 'resolved'
    ticketRepo.updateTicketStatus({ ticketId: ticket.id, newStatus: 'in_progress', actorId: claimantMember.id, guildId });
    ticketRepo.updateTicketStatus({ ticketId: ticket.id, newStatus: 'resolved', actorId: claimantMember.id, guildId });
    const resolvedTicket = ticketRepo.getTicketById(ticket.id, guildId);

    // Agora o responsável pode fechar!
    const claimantAuth = closeService.validateCloseAuthorization({
      ticket: resolvedTicket,
      member: claimantMember,
      guild: mockGuild,
      department: dept,
    });
    assert.equal(claimantAuth.allowed, true);
    assert.equal(claimantAuth.isClaimant, true);

    // Staff terceiro continua a não poder fechar
    assert.throws(
      () => {
        closeService.validateCloseAuthorization({
          ticket: resolvedTicket,
          member: normalStaffMember,
          guild: mockGuild,
          department: dept,
        });
      },
      { code: 'FORBIDDEN_NOT_CLAIMANT' }
    );

    db.close();
  });

  // 47. Falha antes de finalizeClose compensa e preserva ticket ativo e sem evento
  test('47. Falha antes de finalizeClose compensa mutações, apaga transcrição e não altera status nem emite evento', async () => {
    const db = createConnection(':memory:');
    const ticketRepo = new TicketRepository(db);
    const settingsRepo = new SettingsRepository(db);
    const memberRepo = new TicketMemberRepository(db);

    const tmpDir = fs.mkdtempSync(path.join(getTestTmpDir(), 'plus1bot-fail-close-'));

    const guildId = 'guild-fail-comp';
    const channelId = 'chan-fail-comp';
    const dept = ticketRepo.createDepartment({ guildId, name: 'Geral', description: 'Geral', staffRoleId: 'role-s' });

    const ticket = ticketRepo.createTicketReservation({
      guildId,
      creatorId: 'usr-creator',
      departmentId: dept.id,
      subject: 'Ticket para teste de falha',
      description: 'Descricao com mais de dez chars',
    });
    ticketRepo.setTicketChannelId(ticket.id, channelId);
    ticketRepo.claimTicket({ ticketId: ticket.id, staffUserId: 'staff-c', guildId });
    ticketRepo.updateTicketStatus({ ticketId: ticket.id, newStatus: 'in_progress', actorId: 'staff-c', guildId });
    ticketRepo.updateTicketStatus({ ticketId: ticket.id, newStatus: 'resolved', actorId: 'staff-c', guildId });

    // Mock do canal no Discord com falha forçada no rename ou permissões
    let restoredName = null;
    const mockChannel = {
      id: channelId,
      name: 'ticket-00001-creator',
      parentId: 'cat-orig',
      permissionOverwrites: {
        cache: new Map(),
        set: async () => {
          const err = new Error('DiscordAPIError[50013]: Missing Permissions');
          err.code = 50013;
          throw err;
        },
      },
      setName: async (n) => {
        restoredName = n;
      },
      messages: {
        fetch: async () => new Map(),
      },
    };

    const mockGuild = {
      id: guildId,
      name: 'Guild Falha',
      channels: { cache: new Map([[channelId, mockChannel]]) },
      roles: { cache: new Map([['role-s', { id: 'role-s' }]]) },
      members: { me: { id: 'bot-id', permissions: { has: () => true } } },
      client: { user: { id: 'bot-id' }, users: { fetch: async () => null } },
    };

    const closeService = new TicketCloseService({
      ticketRepo,
      settingsRepo,
      ticketMemberRepo: memberRepo,
      permService: permissionService,
    });

    const origWarn = logger.warn;
    const origErr = logger.error;
    logger.warn = () => {};
    logger.error = () => {};

    try {
      await assert.rejects(
        async () => {
          await closeService.closeTicket({
            channelId,
            guildId,
            member: { id: 'staff-c', permissions: { has: () => false }, roles: { cache: new Map([['role-s', true]]) } },
            guild: mockGuild,
            channel: mockChannel,
            reason: 'Teste de falha',
            baseDir: tmpDir,
          });
        },
        /Missing Permissions/
      );

      // 1. O ticket na base de dados DEVE continuar no estado ativo 'resolved'
      const checkTicket = ticketRepo.getTicketById(ticket.id, guildId);
      assert.equal(checkTicket.status, 'resolved', 'Status deve permanecer resolved');
      assert.equal(checkTicket.closing_started_at, null, 'closing_started_at deve ter sido resetado');

      // 2. Não deve existir evento ticket_closed
      const events = ticketRepo.getEventsByTicket(ticket.id);
      const closeEvents = events.filter((e) => e.event_type === 'ticket_closed');
      assert.equal(closeEvents.length, 0, 'Não deve criar evento ticket_closed em caso de erro');

      // 3. Lock em voo deve estar libertado
      assert.equal(closeService.closingLocks.size, 0);
    } finally {
      logger.warn = origWarn;
      logger.error = origErr;
      fs.rmSync(tmpDir, { recursive: true, force: true });
      db.close();
    }
  });

  // 48. Fluxo completo de fecho bem-sucedido com Discord mocks, canal de logs e DM best-effort
  test('48. Fluxo completo de fecho: permissões read-only, renomear canal, mover para arquivo, log e DM best-effort', async () => {
    const db = createConnection(':memory:');
    const ticketRepo = new TicketRepository(db);
    const settingsRepo = new SettingsRepository(db);
    const memberRepo = new TicketMemberRepository(db);

    const tmpDir = fs.mkdtempSync(path.join(getTestTmpDir(), 'plus1bot-full-close-'));
    process.env.TRANSCRIPT_DIR = tmpDir;

    const guildId = 'guild-success-close';
    const channelId = 'chan-success-close';
    const archiveCatId = 'cat-archive-1';
    const logChanId = 'chan-logs-1';
    const staffRoleId = 'role-support-close';

    settingsRepo.upsertGuildSettings(guildId, {
      default_staff_role_id: staffRoleId,
      archive_category_id: archiveCatId,
      log_channel_id: logChanId,
    });

    const dept = ticketRepo.createDepartment({
      guildId,
      name: 'Suporte VIP',
      description: 'Atendimento VIP',
      staffRoleId,
    });

    const ticket = ticketRepo.createTicketReservation({
      guildId,
      creatorId: 'user-customer',
      departmentId: dept.id,
      subject: 'Problema resolvido com sucesso',
      description: 'Descricao detalhada do atendimento com mais de dez chars',
    });
    ticketRepo.setTicketChannelId(ticket.id, channelId);

    memberRepo.addMember({ ticketId: ticket.id, userId: 'user-friend', addedBy: 'user-customer', guildId });

    // Atribuir e resolver
    ticketRepo.claimTicket({ ticketId: ticket.id, staffUserId: 'staff-attendant', guildId });
    ticketRepo.updateTicketStatus({ ticketId: ticket.id, newStatus: 'in_progress', actorId: 'staff-attendant', guildId });
    ticketRepo.updateTicketStatus({ ticketId: ticket.id, newStatus: 'resolved', actorId: 'staff-attendant', guildId });

    // Rastreio de mutações Discord
    let updatedOverwrites = null;
    let renamedName = null;
    let newParentId = null;
    let channelSentMessage = null;
    let logSentMessage = null;
    let dmSentMessage = null;

    const mockChannel = {
      id: channelId,
      name: 'ticket-00001-user-customer',
      parentId: 'cat-orig',
      permissionOverwrites: {
        cache: new Map(),
        set: async (overwrites) => {
          updatedOverwrites = overwrites;
        },
      },
      setName: async (newName) => {
        renamedName = newName;
      },
      setParent: async (catId) => {
        newParentId = catId;
      },
      send: async (payload) => {
        channelSentMessage = payload;
      },
      messages: {
        fetch: async () => {
          const m1 = {
            id: '2001',
            content: 'Olá suporte, preciso de ajuda com o meu plano!',
            createdAt: new Date('2026-09-20T10:00:00Z'),
            author: { id: 'user-customer', username: 'Customer', tag: 'Customer#1111', bot: false },
          };
          const m2 = {
            id: '2002',
            content: 'Problema solucionado!',
            createdAt: new Date('2026-09-20T10:05:00Z'),
            author: { id: 'staff-attendant', username: 'Attendant', tag: 'Attendant#2222', bot: false },
          };
          return new Map([[m1.id, m1], [m2.id, m2]]);
        },
      },
    };

    const mockArchiveCategory = {
      id: archiveCatId,
      type: ChannelType.GuildCategory,
      permissionsFor: () => ({
        has: () => true,
      }),
    };

    const mockLogChannel = {
      id: logChanId,
      isTextBased: () => true,
      send: async (payload) => {
        logSentMessage = payload;
      },
    };

    const mockGuild = {
      id: guildId,
      name: 'Guild Suporte',
      channels: {
        cache: new Map([
          [channelId, mockChannel],
          [archiveCatId, mockArchiveCategory],
          [logChanId, mockLogChannel],
        ]),
      },
      roles: {
        everyone: { id: 'role-everyone' },
        cache: new Map([
          ['role-everyone', { id: 'role-everyone' }],
          [staffRoleId, { id: staffRoleId }],
        ]),
      },
      members: {
        me: { id: 'bot-id', permissions: { has: () => true } },
      },
      client: {
        user: { id: 'bot-id' },
        users: {
          fetch: async (userId) => {
            if (userId === 'user-customer') {
              return {
                id: 'user-customer',
                tag: 'Customer#1111',
                username: 'Customer',
                send: async (payload) => {
                  dmSentMessage = payload;
                },
              };
            }
            return null;
          },
        },
      },
    };

    const closeService = new TicketCloseService({
      ticketRepo,
      settingsRepo,
      ticketMemberRepo: memberRepo,
      permService: permissionService,
    });

    const result = await closeService.closeTicket({
      channelId,
      guildId,
      member: {
        id: 'staff-attendant',
        user: { id: 'staff-attendant', username: 'Attendant', tag: 'Attendant#2222' },
        permissions: { has: () => false },
        roles: { cache: new Map([[staffRoleId, true]]) },
      },
      guild: mockGuild,
      channel: mockChannel,
      reason: 'Cliente atendido e problema verificado',
    });

    // 1. Verificação do ticket finalizado na base de dados
    assert.ok(result.ticket);
    assert.equal(result.ticket.status, 'closed');
    assert.equal(result.ticket.closed_by, 'staff-attendant');
    assert.equal(result.ticket.close_reason, 'Cliente atendido e problema verificado');
    assert.ok(result.ticket.closed_at);
    assert.ok(result.ticket.transcript_path);
    assert.ok(result.ticket.transcript_sha256);
    assert.equal(result.ticket.transcript_message_count, 2);

    // 2. Verificação de permissões do Discord (read-only)
    assert.ok(updatedOverwrites, 'Overwrites devem ter sido atualizados');
    const customerOw = updatedOverwrites.find((o) => o.id === 'user-customer');
    assert.ok(customerOw, 'Overwrite do autor deve existir');
    assert.ok(customerOw.allow.includes(PermissionFlagsBits.ViewChannel));
    assert.ok(customerOw.allow.includes(PermissionFlagsBits.ReadMessageHistory));
    assert.ok(customerOw.deny.includes(PermissionFlagsBits.SendMessages));
    assert.ok(customerOw.deny.includes(PermissionFlagsBits.AttachFiles));

    const friendOw = updatedOverwrites.find((o) => o.id === 'user-friend');
    assert.ok(friendOw, 'Overwrite do participante deve existir');
    assert.ok(friendOw.allow.includes(PermissionFlagsBits.ViewChannel));
    assert.ok(friendOw.deny.includes(PermissionFlagsBits.SendMessages));

    const staffOw = updatedOverwrites.find((o) => o.id === staffRoleId);
    assert.ok(staffOw, 'Overwrite da equipa deve existir');
    assert.ok(staffOw.allow.includes(PermissionFlagsBits.ViewChannel));
    assert.ok(staffOw.deny.includes(PermissionFlagsBits.SendMessages));

    // 3. Verificação do nome e categoria do canal
    assert.equal(renamedName, 'closed-00001-customer');
    assert.equal(newParentId, archiveCatId);

    // 4. Verificação do evento ticket_closed
    const events = ticketRepo.getEventsByTicket(ticket.id);
    const closeEvent = events.find((e) => e.event_type === 'ticket_closed');
    assert.ok(closeEvent, 'Deve registar evento ticket_closed');
    const meta = JSON.parse(closeEvent.metadata_json);
    assert.equal(meta.ticketNumber, 1);
    assert.equal(meta.closedBy, 'staff-attendant');
    assert.equal(meta.messageCount, 2);
    assert.ok(meta.transcriptSha256);
    // Não deve conter o conteúdo integral das mensagens!
    assert.equal(meta.messages, undefined);

    // 5. Verificação de envios pós-fecho
    assert.ok(channelSentMessage, 'Canal do ticket deve receber mensagem de fecho');
    assert.ok(logSentMessage, 'Canal de logs deve receber mensagem e anexo');
    assert.equal(logSentMessage.files.length, 1);
    assert.ok(dmSentMessage, 'Autor deve receber DM com anexo de transcrição');
    assert.equal(dmSentMessage.files.length, 1);

    // 6. Teste de DM com erro não bloqueante
    // Se o envio da DM falhar (ex: utilizador bloqueou DMs), o fecho não deve reabrir
    mockGuild.client.users.fetch = async () => ({
      id: 'user-customer',
      send: async () => {
        const dErr = new Error('Cannot send messages to this user');
        dErr.code = 50007;
        throw dErr;
      },
    });

    const origWarn = logger.warn;
    let warned = false;
    logger.warn = (msg) => {
      if (msg.includes('DM para autor') || msg.includes('DM ao autor')) warned = true;
    };

    // Criar outro ticket e fechar com DM a falhar
    const ticketDM = ticketRepo.createTicketReservation({
      guildId,
      creatorId: 'user-blocked-dm',
      departmentId: dept.id,
      subject: 'Ticket DM bloqueada',
      description: 'Descricao com mais de dez chars',
    });
    ticketRepo.setTicketChannelId(ticketDM.id, 'chan-dm-fail');
    ticketRepo.claimTicket({ ticketId: ticketDM.id, staffUserId: 'staff-attendant', guildId });
    ticketRepo.updateTicketStatus({ ticketId: ticketDM.id, newStatus: 'in_progress', actorId: 'staff-attendant', guildId });
    ticketRepo.updateTicketStatus({ ticketId: ticketDM.id, newStatus: 'resolved', actorId: 'staff-attendant', guildId });

    mockChannel.id = 'chan-dm-fail';
    mockGuild.channels.cache.set('chan-dm-fail', mockChannel);

    const dmFailResult = await closeService.closeTicket({
      channelId: 'chan-dm-fail',
      guildId,
      member: {
        id: 'staff-attendant',
        user: { id: 'staff-attendant', username: 'Attendant', tag: 'Attendant#2222' },
        permissions: { has: () => false },
        roles: { cache: new Map([[staffRoleId, true]]) },
      },
      guild: mockGuild,
      channel: mockChannel,
      reason: 'Fecho com DM bloqueada',
    });

    logger.warn = origWarn;
    assert.equal(dmFailResult.ticket.status, 'closed', 'Ticket deve fechar com sucesso mesmo se DM falhar');
    assert.equal(warned, true, 'Deve registar aviso quando DM falha');

    // Limpeza
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.TRANSCRIPT_DIR;
    db.close();
  });
});
