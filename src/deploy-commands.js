const { REST, Routes } = require('discord.js');
require('dotenv').config();

const fs = require('fs');
const path = require('path');

const commands = [];
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

// Carregar todos os comandos
for (const file of commandFiles) {
  const command = require(path.join(commandsPath, file));
  if ('data' in command && 'execute' in command) {
    commands.push(command.data.toJSON());
    console.log(`📦 Comando preparado: /${command.data.name}`);
  }
}

// REST API do Discord
const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log(`🔄 A registar ${commands.length} comandos...`);

    // Para desenvolvimento: registar num servidor específico (instantâneo)
    // Para produção: usar Routes.applicationCommands(process.env.CLIENT_ID)

    const guildId = process.env.GUILD_ID;
    const clientId = process.env.CLIENT_ID;

    if (!guildId) {
      console.log('⚠️  GUILD_ID não definido. A registar globalmente (pode demorar até 1 hora)...');

      await rest.put(
        Routes.applicationCommands(clientId),
        { body: commands },
      );
    } else {
      console.log(`📍 A registar no servidor: ${guildId}`);

      await rest.put(
        Routes.applicationGuildCommands(clientId, guildId),
        { body: commands },
      );
    }

    console.log('✅ Comandos registados com sucesso!');
    console.log('   Pode demorar até 1 hora para aparecer globalmente.');

  } catch (error) {
    console.error('❌ ERRO ao registar comandos:', error);
  }
})();
