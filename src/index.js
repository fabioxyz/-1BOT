const { Client, GatewayIntentBits, Collection } = require('discord.js');
require('dotenv').config();

const fs = require('fs');
const path = require('path');

// Criar cliente do Discord com intents necessários
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,                    // Servidores
    GatewayIntentBits.GuildMessages,             // Mensagens em servidores
    GatewayIntentBits.MessageContent,            // Conteúdo das mensagens (essencial!)
    GatewayIntentBits.GuildMembers,              // Membros do servidor
    GatewayIntentBits.DirectMessages,            // DMs
  ],
});

// Coleção para armazenar comandos
client.commands = new Collection();

// ============================================
// CARREGAR COMANDOS
// ============================================
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
  const filePath = path.join(commandsPath, file);
  const command = require(filePath);

  if ('data' in command && 'execute' in command) {
    client.commands.set(command.data.name, command);
    console.log(`✅ Comando carregado: /${command.data.name}`);
  } else {
    console.log(`⚠️  Comando em ${file} está incompleto (falta 'data' ou 'execute')`);
  }
}

// ============================================
// CARREGAR EVENTOS
// ============================================
const eventsPath = path.join(__dirname, 'events');
const eventFiles = fs.readdirSync(eventsPath).filter(file => file.endsWith('.js'));

for (const file of eventFiles) {
  const filePath = path.join(eventsPath, file);
  const event = require(filePath);

  if (event.once) {
    client.once(event.name, (...args) => event.execute(...args, client));
  } else {
    client.on(event.name, (...args) => event.execute(...args, client));
  }
  console.log(`✅ Evento carregado: ${event.name}`);
}

// ============================================
// LOGIN
// ============================================
const token = process.env.DISCORD_TOKEN;

if (!token) {
  console.error('❌ ERRO: DISCORD_TOKEN não encontrado no .env');
  console.error('   Cria um ficheiro .env com o teu token do Discord Developer Portal');
  process.exit(1);
}

client.login(token)
  .then(() => {
    console.log('🔐 Login realizado com sucesso!');
  })
  .catch(err => {
    console.error('❌ ERRO ao fazer login:', err.message);
    console.error('   Verifica se o token está correto no ficheiro .env');
    process.exit(1);
  });
