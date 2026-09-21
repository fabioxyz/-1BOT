const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Verifica a latência do bot e da API do Discord'),

  async execute(interaction) {
    const sent = await interaction.reply({
      content: '🏓 A calcular...',
      fetchReply: true
    });

    const latency = sent.createdTimestamp - interaction.createdTimestamp;
    const apiLatency = Math.round(interaction.client.ws.ping);

    await interaction.editReply({
      content: `🏓 **Pong!**\n\n` +
               `⏱️ Latência do bot: **${latency}ms**\n` +
               `🌐 Latência da API: **${apiLatency}ms**`,
    });
  },
};
