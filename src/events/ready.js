const { ActivityType } = require('discord.js');

module.exports = {
  name: 'clientReady',
  once: true,
  execute(client) {
    console.log(`🚀 Bot online! Logado como ${client.user.tag}`);
    console.log(`   Servidores: ${client.guilds.cache.size}`);
    console.log(`   Comandos: ${client.commands.size}`);

    // Status do bot
    client.user.setActivity('comunidades crescerem', { type: ActivityType.Watching });

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('   +1BOT - Pronto para servir!');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  },
};
