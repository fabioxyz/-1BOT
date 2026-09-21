const { Client, GatewayIntentBits, Collection } = require('discord.js');
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { getDatabase } = require('./database/connection');

let client;
let dbInstance;
let signalsRegistered = false;
let isShuttingDown = false;

const handleSigint = () => shutdown(0, true);
const handleSigterm = () => shutdown(0, true);

async function bootstrap(deps = {}) {
  const {
    env = process.env,
    ClientFactory = (options) => new Client(options),
    getDb = getDatabase
  } = deps;

  const token = env.DISCORD_TOKEN;
  if (!token) {
    throw new Error('DISCORD_TOKEN não configurado no ambiente.');
  }

  // Inicializar base de dados SQLite e executar migrações
  dbInstance = getDb();

  // Criar cliente do Discord
  client = ClientFactory({
    intents: [
      GatewayIntentBits.Guilds,                    // Servidores (interações de barra e componentes nativos)
      GatewayIntentBits.MessageContent,            // Necessário para ler o conteúdo das mensagens no transcript
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

  // Configurar graceful shutdown
  if (!signalsRegistered) {
    process.once('SIGINT', handleSigint);
    process.once('SIGTERM', handleSigterm);
    signalsRegistered = true;
  }

  return { client, dbInstance };
}

async function shutdown(code = 0, setProcessExitCode = (require.main === module)) {
  const normalizedExitCode = Number.isInteger(code) ? code : 0;
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log('\n[Process] A encerrar aplicação (Graceful Shutdown)...');

  try {
    if (client) {
      console.log('[Discord] A destruir o cliente...');
      await client.destroy();
      client = null;
    }
  } catch (err) {
    console.error('[Discord] Erro ao destruir o cliente:', err.message);
  }

  try {
    if (dbInstance && typeof dbInstance.close === 'function') {
      console.log('[SQLite] A fechar ligação à base de dados...');
      dbInstance.close();
      dbInstance = null;
    }
  } catch (err) {
    console.error('[SQLite] Erro ao fechar a base de dados:', err.message);
  }

  console.log('[Process] Encerramento concluído.');

  if (setProcessExitCode) {
    process.exitCode = normalizedExitCode;
  }
}

// Para testes
function resetState() {
  client = null;
  dbInstance = null;
  signalsRegistered = false;
  isShuttingDown = false;
  process.removeListener('SIGINT', handleSigint);
  process.removeListener('SIGTERM', handleSigterm);
}

async function startApplication(deps = {}) {
  const {
    loginToken = process.env.DISCORD_TOKEN,
    logger = console,
    setExitCode = (code) => { process.exitCode = code; },
    ClientFactory,
    getDb
  } = deps;

  try {
    const { client } = await bootstrap({
      env: { DISCORD_TOKEN: loginToken },
      ClientFactory,
      getDb
    });

    try {
      await client.login(loginToken);
      logger.log('🚀 Login realizado com sucesso!');
    } catch (err) {
      logger.error('❌ ERRO ao fazer login:', err.message);
      logger.error('   Verifica se o token está correto no ficheiro .env');
      await shutdown(1);
      setExitCode(1);
    }
  } catch (err) {
    logger.error('❌ ERRO na inicialização:', err.message);
    await shutdown(1);
    setExitCode(1);
  }
}

// Se o ficheiro for executado diretamente, faz login
if (require.main === module) {
  startApplication();
}

module.exports = { bootstrap, shutdown, resetState, startApplication };
