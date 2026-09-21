const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('server')
    .setDescription('Informações sobre este servidor'),

  async execute(interaction) {
    const guild = interaction.guild;
    const owner = await guild.fetchOwner();

    const embed = new EmbedBuilder()
      .setColor(0x57F287) // Verde
      .setTitle(`📋 ${guild.name}`)
      .setThumbnail(guild.iconURL({ dynamic: true, size: 256 }))
      .addFields(
        { name: '👑 Dono', value: `${owner.user.tag}`, inline: true },
        { name: '🆔 ID', value: `\`${guild.id}\``, inline: true },
        { name: '📅 Criado em', value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:D>`, inline: true },
        { name: '👥 Membros', value: `\`${guild.memberCount}\``, inline: true },
        { name: '💬 Canais', value: `\`${guild.channels.cache.size}\``, inline: true },
        { name: '🏷️ Roles', value: `\`${guild.roles.cache.size}\``, inline: true },
        { name: '🚀 Boosts', value: `Nível ${guild.premiumTier} (\`${guild.premiumSubscriptionCount}\`)`, inline: true },
      )
      .setFooter({ text: `+1BOT • v1.0.0` })
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  },
};
