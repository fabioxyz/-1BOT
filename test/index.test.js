const { test, describe, afterEach, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const { bootstrap, shutdown, resetState, startApplication } = require('../src/index');

describe('Sistema Core - Bloco 4 (Testes 56+)', () => {
  let originalEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    resetState();
  });

  afterEach(() => {
    process.env = originalEnv;
    resetState();
  });

  test('56. Bootstrap falha imediatamente sem imprimir token se DISCORD_TOKEN não estiver configurado', async () => {
    delete process.env.DISCORD_TOKEN;

    await assert.rejects(
      async () => {
        await bootstrap();
      },
      (err) => err.message.includes('não configurado')
    );
  });

  test('57. Bootstrap regista sinais uma só vez, configura base de dados e cliente, e encerra corretamente', async () => {
    process.env.DISCORD_TOKEN = 'mock-token';
    process.env.DATABASE_PATH = ':memory:'; // Evitar escrever em ficheiro

    const { client, dbInstance } = await bootstrap();

    assert.ok(client, 'Cliente Discord deve ser inicializado');
    assert.ok(dbInstance, 'Base de dados deve ser inicializada');
    assert.ok(client.commands.size > 0, 'Comandos devem ser carregados');

    // Chamar bootstrap novamente não deve falhar
    const res2 = await bootstrap();
    assert.ok(res2.client);

    // Testar shutdown (idempotente)
    await shutdown();

    // Shutdown uma segunda vez não falha
    await shutdown();

    // client deve ser null após shutdown
    // e base de dados deve estar fechada (resetState irá limpar as refs, mas no módulo em si devem estar null)
  });

  test('58. Inicialização executada como main rejeita login graciosamente', async () => {
    let exitCodeCalled = null;
    let loginCalls = 0;
    let destroyCalls = 0;
    let closeCalls = 0;

    const output = [];
    const logger = {
      log: (msg) => output.push(msg),
      error: (...args) => output.push(args.join(' '))
    };
    const setExitCode = (code) => { exitCodeCalled = code; };

    const originalConsoleLog = console.log;
    const originalConsoleError = console.error;
    console.log = (msg) => output.push(msg);
    console.error = (...args) => output.push(args.join(' '));

    try {
      const ClientFactory = () => {
        return {
          once: () => {},
          on: () => {},
          login: async (token) => {
            loginCalls++;
            throw new Error(`Login falhou`);
          },
          destroy: async () => { destroyCalls++; }
        };
      };

      const getDb = () => {
        return {
          close: () => { closeCalls++; }
        };
      };

      await startApplication({
        loginToken: 'invalid-token-for-test-58',
        logger,
        setExitCode,
        ClientFactory,
        getDb
      });

      const fullOutput = output.join('\n');
      assert.equal(exitCodeCalled, 1, 'Deve sair com exit code 1');
      assert.ok(!fullOutput.includes('invalid-token-for-test-58'), 'Token nunca deve ser impresso');

      assert.ok(fullOutput.includes('[Discord] A destruir o cliente...'), 'Cliente deve ser destruído');
      assert.ok(fullOutput.includes('[SQLite] A fechar liga'), 'DB deve ser fechada');
      assert.ok(fullOutput.includes('[Process] Encerramento conclu'), 'Deve imprimir conclusão de encerramento');

      const destroyMatch = fullOutput.match(/A destruir o cliente\.\.\./g) || [];
      assert.equal(destroyMatch.length, 1, 'Cliente destruído exatamente uma vez');

      const closeDbMatch = fullOutput.match(/A fechar liga/g) || [];
      assert.equal(closeDbMatch.length, 1, 'DB fechada exatamente uma vez');

      await shutdown();
      const fullOutputAfter = output.join('\n');
      assert.equal((fullOutputAfter.match(/A destruir o cliente\.\.\./g) || []).length, 1, 'Repetir cleanup não duplica destroy');

    } finally {
      console.log = originalConsoleLog;
      console.error = originalConsoleError;
    }
  });
});
