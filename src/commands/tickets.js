const {
  SlashCommandBuilder,
  ChannelType,
  PermissionFlagsBits,
  EmbedBuilder,
} = require('discord.js');
let settingsService = require('../services/settingsService');
let permissionService = require('../services/permissionService');
const { getPanelEmbed, getDepartmentSelectRow } = require('../components/tickets/selectMenus');
const { isValidEmoji } = require('../utils/emojiValidator');
const logger = require('../utils/logger');

function setDependencies({ settingsSvc, permSvc }) {
  if (settingsSvc) settingsService = settingsSvc;
  if (permSvc) permissionService = permSvc;
}

function resetDependencies() {
  settingsService = require('../services/settingsService');
  permissionService = require('../services/permissionService');
}

module.exports = {
  setDependencies,
  resetDependencies,
  data: new SlashCommandBuilder()
    .setName('tickets')
    .setDescription('Gestão e configuração do sistema profissional de tickets')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    // 1. Subcomando: configurar
    .addSubcommand((subcommand) =>
      subcommand
        .setName('configurar')
        .setDescription('Configura as definições globais do sistema de tickets no servidor')
        .addChannelOption((opt) =>
          opt
            .setName('categoria')
            .setDescription('Categoria onde os canais de tickets serão criados')
            .addChannelTypes(ChannelType.GuildCategory)
            .setRequired(true)
        )
        .addChannelOption((opt) =>
          opt
            .setName('canal_logs')
            .setDescription('Canal de texto onde serão enviados os registos de auditoria')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true)
        )
        .addRoleOption((opt) =>
          opt
            .setName('cargo_equipa')
            .setDescription('Cargo padrão da equipa responsável pelo atendimento')
            .setRequired(true)
        )
        .addStringOption((opt) =>
          opt
            .setName('titulo_painel')
            .setDescription('Título personalizado para o painel de tickets')
            .setMaxLength(100)
            .setRequired(false)
        )
        .addStringOption((opt) =>
          opt
            .setName('descricao_painel')
            .setDescription('Descrição personalizada para o painel de tickets')
            .setMaxLength(500)
            .setRequired(false)
        )
        .addStringOption((opt) =>
          opt
            .setName('cor_painel')
            .setDescription('Cor hexadecimal para os embeds (ex.: #5865F2)')
            .setMaxLength(7)
            .setRequired(false)
        )
        .addChannelOption((opt) =>
          opt
            .setName('categoria_arquivo')
            .setDescription('Categoria para onde os tickets fechados serão movidos')
            .addChannelTypes(ChannelType.GuildCategory)
            .setRequired(false)
        )
        .addBooleanOption((opt) =>
          opt
            .setName('limpar_arquivo')
            .setDescription('Remove a configuração da categoria de arquivo (Ignora categoria_arquivo se true)')
            .setRequired(false)
        )
    )
    // 2. Subcomando: departamento-adicionar
    .addSubcommand((subcommand) =>
      subcommand
        .setName('departamento-adicionar')
        .setDescription('Adiciona um novo departamento de suporte')
        .addStringOption((opt) =>
          opt
            .setName('nome')
            .setDescription('Nome do departamento (ex.: Dúvidas Gerais)')
            .setMinLength(2)
            .setMaxLength(50)
            .setRequired(true)
        )
        .addStringOption((opt) =>
          opt
            .setName('descricao')
            .setDescription('Descrição curta do departamento exibida no menu')
            .setMinLength(3)
            .setMaxLength(100)
            .setRequired(true)
        )
        .addStringOption((opt) =>
          opt
            .setName('emoji')
            .setDescription('Emoji representativo (ex.: 💬, 🛠️, 💰)')
            .setMaxLength(32)
            .setRequired(false)
        )
        .addRoleOption((opt) =>
          opt
            .setName('cargo_equipa')
            .setDescription('Cargo específico da equipa deste departamento (fallback para o global)')
            .setRequired(false)
        )
        .addChannelOption((opt) =>
          opt
            .setName('categoria')
            .setDescription('Categoria específica deste departamento (fallback para a global)')
            .addChannelTypes(ChannelType.GuildCategory)
            .setRequired(false)
        )
    )
    // 3. Subcomando: departamento-listar
    .addSubcommand((subcommand) =>
      subcommand
        .setName('departamento-listar')
        .setDescription('Lista todos os departamentos de tickets do servidor')
    )
    // 4. Subcomando: departamento-remover
    .addSubcommand((subcommand) =>
      subcommand
        .setName('departamento-remover')
        .setDescription('Desativa um departamento de tickets existente')
        .addIntegerOption((opt) =>
          opt
            .setName('departamento')
            .setDescription('Seleciona o departamento a desativar')
            .setAutocomplete(true)
            .setRequired(true)
        )
    )
    // 5. Subcomando: painel
    .addSubcommand((subcommand) =>
      subcommand
        .setName('painel')
        .setDescription('Publica o painel de tickets neste canal com menu de seleção')
    )
    // 6. Subcomando: estado
    .addSubcommand((subcommand) =>
      subcommand
        .setName('estado')
        .setDescription('Exibe o estado e configuração global do sistema de tickets')
    ),

  /**
   * Autocomplete para seleção dinâmica de departamentos.
   */
  async autocomplete(interaction) {
    const focusedOption = interaction.options.getFocused(true);
    if (focusedOption.name === 'departamento') {
      const departments = settingsService.listDepartments(interaction.guildId, true);
      const query = String(focusedOption.value || '').toLowerCase();

      const filtered = departments
        .filter((d) => d.name.toLowerCase().includes(query) || String(d.id).includes(query))
        .slice(0, 25);

      await interaction.respond(
        filtered.map((dept) => ({
          name: `${dept.emoji ? dept.emoji + ' ' : ''}${dept.name} (ID: ${dept.id})`,
          value: dept.id,
        }))
      );
    }
  },

  /**
   * Executa os subcomandos do /tickets.
   */
  async execute(interaction) {
    if (!permissionService.isAdmin(interaction.member)) {
      return interaction.reply({
        content: '❌ Apenas administradores do servidor podem utilizar os comandos de gestão de tickets.',
        ephemeral: true,
      });
    }

    const subcommand = interaction.options.getSubcommand();

    try {
      if (subcommand === 'configurar') {
        await handleConfigurar(interaction);
      } else if (subcommand === 'departamento-adicionar') {
        await handleDepartamentoAdicionar(interaction);
      } else if (subcommand === 'departamento-listar') {
        await handleDepartamentoListar(interaction);
      } else if (subcommand === 'departamento-remover') {
        await handleDepartamentoRemover(interaction);
      } else if (subcommand === 'painel') {
        await handlePainel(interaction);
      } else if (subcommand === 'estado') {
        await handleEstado(interaction);
      }
    } catch (error) {
      logger.error(`Erro no subcomando /tickets ${subcommand}: ${error.message}`);
      const replyPayload = {
        content: `❌ **Erro:** ${error.message}`,
        ephemeral: true,
      };

      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(replyPayload);
      } else {
        await interaction.reply(replyPayload);
      }
    }
  },
};

// ============================================
// HANDLERS DOS SUBCOMANDOS
// ============================================

async function handleConfigurar(interaction) {
  const category = interaction.options.getChannel('categoria', true);
  const logChannel = interaction.options.getChannel('canal_logs', true);
  const staffRole = interaction.options.getRole('cargo_equipa', true);
  const panelTitle = interaction.options.getString('titulo_painel');
  const panelDescription = interaction.options.getString('descricao_painel');
  const panelColor = interaction.options.getString('cor_painel');
  const archiveCategory = interaction.options.getChannel('categoria_arquivo');
  const clearArchive = interaction.options.getBoolean('limpar_arquivo');

  // Validar pertença à guild
  if (category.guild.id !== interaction.guildId || logChannel.guild.id !== interaction.guildId) {
    return interaction.reply({
      content: '❌ Os canais selecionados têm de pertencer a este servidor.',
      ephemeral: true,
    });
  }

  if (archiveCategory && archiveCategory.guild.id !== interaction.guildId) {
    return interaction.reply({
      content: '❌ A categoria de arquivo selecionada tem de pertencer a este servidor.',
      ephemeral: true,
    });
  }

  // Validar privacidade: rejeitar @everyone como cargo de equipa
  if (staffRole.id === interaction.guildId || staffRole.name === '@everyone') {
    return interaction.reply({
      content: '❌ O cargo @everyone não pode ser utilizado como cargo da equipa por motivos de privacidade.',
      ephemeral: true,
    });
  }

  // Verifica permissões de bot se fornecida a archiveCategory
  if (archiveCategory && !clearArchive) {
    const botMember = await interaction.guild.members.fetch(interaction.client.user.id);
    const hasPerms = botMember.permissionsIn(archiveCategory).has([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.ManageChannels
    ]);
    if (!hasPerms) {
      return interaction.reply({
        content: '❌ O bot não possui permissões adequadas (ManageChannels e ViewChannel) na categoria de arquivo fornecida.',
        ephemeral: true,
      });
    }
  }

  const currentSettings = settingsService.getSettings(interaction.guildId);
  let finalArchiveCategoryId = currentSettings ? currentSettings.archive_category_id : null;

  if (clearArchive) {
    finalArchiveCategoryId = null;
  } else if (archiveCategory) {
    finalArchiveCategoryId = archiveCategory.id;
  }

  const updated = settingsService.updateSettings(
    interaction.guildId,
    {
      categoryId: category.id,
      archiveCategoryId: finalArchiveCategoryId,
      logChannelId: logChannel.id,
      defaultStaffRoleId: staffRole.id,
      panelTitle,
      panelDescription,
      panelColor,
    },
    interaction.user.id
  );

  const embed = new EmbedBuilder()
    .setTitle('⚙️ Configuração de Tickets Atualizada')
    .setColor(0x57F287)
    .setDescription('As definições globais do sistema de tickets foram guardadas com sucesso.')
    .addFields(
      { name: '📁 Categoria Padrão', value: `<#${updated.ticket_category_id}>`, inline: true },
      { name: '📜 Canal de Auditoria', value: `<#${updated.log_channel_id}>`, inline: true },
      { name: '🛡️ Cargo da Equipa', value: `<@&${updated.default_staff_role_id}>`, inline: true },
      { name: '📝 Título do Painel', value: updated.panel_title || '*Padrão*', inline: true },
      { name: '🎨 Cor do Painel', value: updated.panel_color || '*#5865F2 (Padrão)*', inline: true }
    )
    .setFooter({ text: '+1BOT • Sistema de Tickets' })
    .setTimestamp();

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleDepartamentoAdicionar(interaction) {
  const name = interaction.options.getString('nome', true);
  const description = interaction.options.getString('descricao', true);
  const emoji = interaction.options.getString('emoji');
  const staffRole = interaction.options.getRole('cargo_equipa');
  const category = interaction.options.getChannel('categoria');

  // Validar privacidade: rejeitar @everyone como cargo de departamento
  if (staffRole && (staffRole.id === interaction.guildId || staffRole.name === '@everyone')) {
    return interaction.reply({
      content: '❌ O cargo @everyone não pode ser utilizado como cargo de equipa de departamento por motivos de privacidade.',
      ephemeral: true,
    });
  }

  // Validar emoji
  if (emoji && !isValidEmoji(emoji)) {
    return interaction.reply({
      content: '❌ O emoji fornecido é inválido. Usa um único emoji Unicode ou um emoji customizado do Discord (<:nome:id> ou <a:nome:id>).',
      ephemeral: true,
    });
  }

  const dept = settingsService.addDepartment(
    interaction.guildId,
    {
      name,
      description,
      emoji,
      staffRoleId: staffRole ? staffRole.id : null,
      categoryId: category ? category.id : null,
    },
    interaction.user.id
  );

  const embed = new EmbedBuilder()
    .setTitle('✅ Departamento Adicionado')
    .setColor(0x57F287)
    .setDescription(`O departamento **${dept.name}** foi registado com sucesso.`)
    .addFields(
      { name: '🆔 ID', value: `\`${dept.id}\``, inline: true },
      { name: '🏷️ Emoji', value: dept.emoji || '*Nenhum*', inline: true },
      { name: '📝 Descrição', value: dept.description, inline: false },
      {
        name: '📁 Categoria Efetiva',
        value: dept.category_id ? `<#${dept.category_id}> (Específica)` : '*Herda da configuração global*',
        inline: true,
      },
      {
        name: '🛡️ Cargo Efetivo',
        value: dept.staff_role_id ? `<@&${dept.staff_role_id}> (Específico)` : '*Herda da configuração global*',
        inline: true,
      }
    )
    .setFooter({ text: '+1BOT • Sistema de Tickets' })
    .setTimestamp();

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleDepartamentoListar(interaction) {
  const departments = settingsService.listDepartments(interaction.guildId, false);

  if (departments.length === 0) {
    return interaction.reply({
      content: 'ℹ️ Ainda não existem departamentos configurados neste servidor. Usa `/tickets departamento-adicionar` para criar um.',
      ephemeral: true,
    });
  }

  const embed = new EmbedBuilder()
    .setTitle('📋 Departamentos de Atendimento')
    .setColor(0x5865F2)
    .setDescription('Lista de todos os departamentos registados neste servidor:')
    .setFooter({ text: '+1BOT • Sistema de Tickets' })
    .setTimestamp();

  for (const dept of departments) {
    const status = dept.active === 1 ? '🟢 Ativo' : '🔴 Desativado';
    const categoryInfo = dept.category_id
      ? `<#${dept.category_id}>`
      : dept.effectiveCategoryId
      ? `<#${dept.effectiveCategoryId}> (Global)`
      : '*Nenhuma*';
    const staffInfo = dept.staff_role_id
      ? `<@&${dept.staff_role_id}>`
      : dept.effectiveStaffRoleId
      ? `<@&${dept.effectiveStaffRoleId}> (Global)`
      : '*Nenhum*';

    embed.addFields({
      name: `${dept.emoji ? dept.emoji + ' ' : ''}${dept.name} — [ID: ${dept.id}] [${status}]`,
      value: `• **Descrição:** ${dept.description}\n• **Categoria:** ${categoryInfo}\n• **Equipa:** ${staffInfo}`,
      inline: false,
    });
  }

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleDepartamentoRemover(interaction) {
  const departmentId = interaction.options.getInteger('departamento', true);

  settingsService.removeDepartment(interaction.guildId, departmentId, interaction.user.id);

  await interaction.reply({
    content: `✅ O departamento ID \`${departmentId}\` foi desativado com sucesso. Os tickets anteriores permanecem intactos.`,
    ephemeral: true,
  });
}

async function handlePainel(interaction) {
  const settings = settingsService.getSettings(interaction.guildId);
  const activeDepartments = settingsService.listDepartments(interaction.guildId, true);

  // Explicar configuração em falta de forma clara
  const missingConfigs = [];
  if (!settings || !settings.ticket_category_id) {
    missingConfigs.push('• Categoria padrão de tickets (`/tickets configurar`)');
  }
  if (!settings || !settings.log_channel_id) {
    missingConfigs.push('• Canal de logs e auditoria (`/tickets configurar`)');
  }
  if (!settings || !settings.default_staff_role_id) {
    missingConfigs.push('• Cargo padrão da equipa (`/tickets configurar`)');
  }
  if (activeDepartments.length === 0) {
    missingConfigs.push('• Pelo menos um departamento ativo (`/tickets departamento-adicionar`)');
  }

  if (missingConfigs.length > 0) {
    const warningEmbed = new EmbedBuilder()
      .setTitle('⚠️ Configuração Incompleta')
      .setColor(0xED4245)
      .setDescription(
        'Não é possível publicar o painel de tickets enquanto existirem configurações pendentes:\n\n' +
        missingConfigs.join('\n') +
        '\n\n*Por favor completa as configurações acima e tenta novamente.*'
      )
      .setFooter({ text: '+1BOT • Sistema de Tickets' });

    return interaction.reply({ embeds: [warningEmbed], ephemeral: true });
  }

  const panelEmbed = getPanelEmbed(settings);
  const selectRow = getDepartmentSelectRow(activeDepartments);

  // Enviar a mensagem do painel no canal onde o comando foi invocado
  await interaction.channel.send({
    embeds: [panelEmbed],
    components: [selectRow],
  });

  // Registar auditoria
  settingsService.recordPanelPublished(interaction.guildId, interaction.user.id, interaction.channelId);

  await interaction.reply({
    content: '✅ Painel de tickets publicado com sucesso neste canal!',
    ephemeral: true,
  });
}

async function handleEstado(interaction) {
  const settings = settingsService.getSettings(interaction.guildId);

  if (!settings) {
    return interaction.reply({
      content: 'ℹ️ O sistema de tickets ainda não foi configurado neste servidor. Usa /tickets configurar.',
      ephemeral: true,
    });
  }

  const archiveCategoryDisplay = settings.archive_category_id ? `<#${settings.archive_category_id}>` : 'não configurada';

  const embed = new EmbedBuilder()
    .setTitle('📊 Estado e Configuração de Tickets')
    .setColor(0x5865F2)
    .addFields(
      { name: '📂 Categoria Principal', value: `<#${settings.ticket_category_id}>`, inline: true },
      { name: '📁 Categoria de Arquivo', value: archiveCategoryDisplay, inline: true },
      { name: '📜 Canal de Logs', value: `<#${settings.log_channel_id}>`, inline: true },
      { name: '👥 Cargo Equipa (Default)', value: `<@&${settings.default_staff_role_id}>`, inline: true }
    );

  await interaction.reply({ embeds: [embed], ephemeral: true });
}
