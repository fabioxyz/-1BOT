const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('info')
    .setDescription('Informações sobre o +1Bot'),

  async execute(interaction) {
    const embed = new EmbedBuilder()
      .setColor(0x5865F2) // Cor do Discord
      .setTitle('🤖 +1Bot')
      .setDescription('Bot inteligente para gestão e automação de comunidades no Discord.')
      .addFields(
        { name: '📊 Versão', value: '`1.0.0`', inline: true },
        { name: '⚡ Node.js', value: '`v18+`', inline: true },
        { name: '📦 discord.js', value: '`v14.16`', inline: true },
        { name: '🚀 Funcionalidades ativas', value: '• 🎫 Sistema profissional de tickets (departamentos, canais privados, assunção/libertação, controlo de estados/prioridades, comando `/ticket` com transferência, participantes, auditoria)\n• 🔒 Fecho formal de tickets (arquivamento de canais e painel estático)', inline: false },
        { name: '✨ Funcionalidades futuras', value:
          '• ⏱️ Gestão de SLA e métricas de satisfação\n' +
          '• 🧠 IA com RAG (respostas baseadas em documentos)\n' +
          '• 📊 Analytics avançado de comunidade\n' +
          '• 🔧 Integrações externas (Notion, Jira, Google Calendar)',
          inline: false
        },
        { name: 'ℹ️ Sobre', value: 'Este bot é um projeto didático e de demonstração, não se encontrando atualmente em ambiente de produção real.', inline: false }
      )
      .setFooter({
        text: `Pedido por ${interaction.user.tag}`,
        iconURL: interaction.user.displayAvatarURL()
      })
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  },
};
