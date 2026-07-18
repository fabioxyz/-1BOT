# CommunityOps Discord Bot

Bot modular para gestão e automação de comunidades no Discord, construído com Node.js e discord.js.

## Funcionalidades atuais

- Comandos `/ping`, `/server` e `/info`
- Carregamento modular de comandos e eventos
- Registo de comandos por servidor ou globalmente
- Configuração segura através de variáveis de ambiente

## Requisitos

- Node.js 18 ou superior
- Uma aplicação criada no Discord Developer Portal

## Instalação

```bash
npm install
```

Cria um ficheiro `.env`:

```env
DISCORD_TOKEN=coloca_o_token_aqui
CLIENT_ID=coloca_o_client_id_aqui
GUILD_ID=coloca_o_id_do_servidor_aqui
```

Regista os comandos e inicia o bot:

```bash
npm run deploy-commands
npm start
```

Nunca publiques o ficheiro `.env` nem o token do bot.
