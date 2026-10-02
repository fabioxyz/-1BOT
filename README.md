# +1BOT

A Discord support bot with configurable departments, ticket ownership, priorities, audit logs and HTML transcripts.

**Node.js · discord.js v14 · SQLite · MIT**

[Getting started](#getting-started) · [Discord setup](#configure-your-server) · [Commands](#commands) · [Development](#development) · [Portuguese reference](docs/README.pt-PT.md)

## What it does

| Area | Capabilities |
| --- | --- |
| Support intake | Persistent department menu, request form and private ticket channels |
| Team workflow | Claim and release tickets, manage states, set priorities and transfer departments |
| Access | Per-server staff settings and up to 10 additional participants per ticket |
| History | SQLite event history and a configurable Discord audit channel |
| Closure | Confirmation form, read-only channel archive and HTML transcript with a SHA-256 hash |

Configuration is managed through Discord slash commands. Each server has its own settings, departments and ticket numbering.

## Getting started

Use **Node.js 22**, which is included in this repository's CI matrix, and npm. The package currently declares a minimum Node.js version of 18.

```sh
git clone https://github.com/fabioxyz/-1BOT.git
cd -- -1BOT
npm ci
```

Copy `.env.example` to `.env`, then fill in your local configuration:

```env
DISCORD_TOKEN=your_discord_bot_token
CLIENT_ID=your_discord_application_id
GUILD_ID=your_development_server_id
DATABASE_PATH=./data/plus1bot.sqlite
```

Keep `.env`, the bot token and local data out of commits. `GUILD_ID` is optional: when set, command registration targets that server; when omitted, registration is global.

Before starting the bot:

1. Create an application and bot in the [Discord Developer Portal](https://discord.com/developers/applications).
2. Enable the **Message Content** privileged intent for transcript content.
3. Invite the bot using the `bot` and `applications.commands` scopes.
4. Grant the channel permissions needed for viewing, sending and reading messages, embedding links, attaching files and managing ticket channels.

Register the commands, then start the bot:

```sh
npm run deploy-commands
npm start
```

These commands contact Discord using your configured token. The Discord command names and interface are currently in Portuguese.

## Configure your server

An administrator can complete setup directly in Discord:

1. Run `/tickets configurar` and set the ticket category (`categoria`), audit channel (`canal_logs`) and support role (`cargo_equipa`).
2. Optionally customize `titulo_painel`, `descricao_painel`, `cor_painel` and `categoria_arquivo`.
3. Add at least one department with `/tickets departamento-adicionar`.
4. Review the setup with `/tickets estado` and `/tickets departamento-listar`.
5. Publish the intake panel in the desired channel with `/tickets painel`.

A department can override the default category and support role. Removing a department disables it for new requests.

## Ticket workflow

**Open → assign → handle → resolve → close**

- A member selects a department and fills in the request form.
- The bot creates a private channel and a persistent control panel.
- Staff can claim or release the ticket, change its state and set a priority.
- Priority ordering is **urgent → high → normal → low**, with older tickets first within each priority.
- Staff can transfer the ticket or manage additional participants.
- Closing requires a reason and the confirmation word `FECHAR`.
- Normal staff can close resolved tickets they own; administrators with `ManageGuild` can override those restrictions.
- Closed channels become read-only and can move to a configured archive category.

## Commands

| Command | Purpose |
| --- | --- |
| `/tickets configurar` | Configure server settings, panel appearance and archive category |
| `/tickets departamento-adicionar` | Create a support department |
| `/tickets departamento-listar` | Review departments |
| `/tickets departamento-remover` | Disable a department |
| `/tickets painel` | Publish the support panel |
| `/tickets estado` | Inspect current configuration |
| `/ticket transferir` | Move the current ticket to another department |
| `/ticket participante-adicionar` | Grant an additional member access |
| `/ticket participante-remover` | Remove an additional member |
| `/ticket detalhes` | Show ticket details and recent events |
| `/ticket atualizar` | Refresh the ticket control panel |
| `/info`, `/ping`, `/server` | Bot information, latency and server details |

State, priority, claim, release and close controls are available on the ticket panel.

## Data and transcripts

- SQLite stores server settings, departments, tickets, participants and audit events.
- The default database is `data/plus1bot.sqlite`.
- HTML transcripts are stored under `data/transcripts`; `TRANSCRIPT_DIR` can override that directory.
- The default transcript limit is the **latest 1,000 messages**.
- Attachments are linked by URL; they are not downloaded into a self-contained backup.
- SHA-256 records help check file integrity, but do not make transcripts tamper-proof.

Back up the database and transcript directory together. Instance operators are responsible for access control, backups and retention.

## Development

```sh
npm run check
npm test
```

Or run both checks:

```sh
npm run ci
```

The suite uses Node's built-in test runner. The repository's GitHub Actions workflow is configured for Node.js 18, 20 and 22.

| Directory | Responsibility |
| --- | --- |
| `src/commands/` | Slash command definitions |
| `src/components/tickets/` | Panels, buttons, menus and modals |
| `src/events/` | Startup and interaction routing |
| `src/database/` | Connection and schema migrations |
| `src/repositories/` | Data access |
| `src/services/` | Ticket workflow, permissions, ordering, closure and transcripts |
| `src/utils/` | Shared validation, naming and state helpers |
| `test/` | Automated tests |

## Troubleshooting

| Symptom | Check |
| --- | --- |
| The support panel cannot be published | Configure the category, audit channel and support role; add an active department |
| A ticket cannot be created | Confirm the support role still exists and the bot can view and manage channels in the category |
| “Already have an open ticket” | Each member can have one active ticket per server |
| Commands are missing | Check `CLIENT_ID`, the invite scopes and the target `GUILD_ID`, then register commands again |
| Transcript content is missing | Check the Message Content intent and channel history access |

## Project status

Under active development. Validate the bot's workflow and permissions in your own server before relying on it for production support.

Planned work includes response-time metrics, feedback, analytics and an AI assistance layer. These are roadmap items, not current features.

## License

[MIT](LICENSE)
