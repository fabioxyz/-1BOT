const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('info')
    .setDescription('Informações sobre o CommunityOps Bot'),

  async execute(interaction) {
    const embed = new EmbedBuilder()
      .setColor(0x5865F2) // Cor do Discord
      .setTitle('🤖 CommunityOps Bot')
      .setDescription('Bot inteligente para gestão e automação de comunidades no Discord.')
      .addFields(
        { name: '📊 Versão', value: '`1.0.0`', inline: true },
        { name: '⚡ Node.js', value: '`v18+`', inline: true },
        { name: '📦 discord.js', value: '`v14.16`', inline: true },
        { name: '✨ Funcionalidades futuras', value: 
          '• 🧠 IA com RAG (respostas baseadas em documentos)\n' +
          '• 🎫 Sistema de tickets automático\n' +
          '• 📊 Analytics de comunidade\n' +
          '• 🔧 Integrações (Notion, Jira, Google Calendar)', 
          inline: false 
        },
        { name: '💡 Próximo passo', value: 'Subscreve para veres a evolução deste bot!', inline: false }
      )
      .setFooter({ 
        text: `Pedido por ${interaction.user.tag}`, 
        iconURL: interaction.user.displayAvatarURL() 
      })
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  },
};
