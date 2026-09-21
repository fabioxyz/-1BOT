# 🤖 +1BOT — Bot Inteligente para Gestão e Automação de Comunidades

O **+1BOT** é um bot de Discord moderno e robusto desenvolvido em **Node.js 18+**, **discord.js v14** e **SQLite** (via `better-sqlite3`), focado em produtividade, suporte profissional e automação avançada de comunidades.

---

## 🚀 Funcionalidades

### 🎫 Sistema Profissional de Tickets (Entrega 1 + Entrega 2)
- **Configuração Completa por Servidor**: Cada servidor configura a sua categoria padrão, canal de auditoria (logs), cargo da equipa e personalização visual (título, descrição e cor do painel) através do comando `/tickets configurar`.
- **Departamentos Flexíveis**: Criação de múltiplos departamentos de atendimento (`/tickets departamento-adicionar`) com nomes únicos por servidor, emojis personalizados e suporte a overrides de categoria e cargo de equipa com fallback automático para as definições globais.
- **Painel Interativo Persistente**: Publicação de um painel de suporte elegante (`/tickets painel`) com Select Menu nativo do Discord, resistente a reinícios do bot e sem necessidade de collectors em memória.
- **Formulários Modais Nativos**: Ao selecionar um departamento, o membro preenche um formulário modal nativo (assunto, descrição detalhada e referência opcional) com validação dupla (cliente Discord e serviço).
- **Criação Segura de Canais Privados**: Canais criados automaticamente com formato padronizado `ticket-00042-utilizador`, com permissões restritas (@everyone sem visualização; autor e equipa com permissões estritas de leitura/escrita; bot com permissões mínimas necessárias; sem privilégios desnecessários de Administrador).
- **Numeração Sequencial Isolada**: Cada servidor possui a sua contagem sequencial independente (`TKT-00001`, `TKT-00002`, etc.).
- **Prevenção de Duplicação e Concorrência**:
  - Índice parcial único no SQLite (`idx_tickets_active_user`) impedindo múltiplos tickets ativos para o mesmo utilizador no mesmo servidor.
  - Bloqueio de concorrência em processo (mutex) e cooldown entre pedidos para impedir cliques duplos.
- **Consistência Transacional & Rollback**: Se a criação do canal no Discord falhar, a reserva na base de dados é revertida; se a gravação do ID falhar, o canal é eliminado, evitando tickets órfãos.
- **Assunção e Libertação (Claim & Release)**: Botões interativos no painel do canal do ticket para membros da equipa assumirem o atendimento com exclusividade (`Assumir`) ou libertarem o ticket (`Libertar`), com permissão para Administradores reatribuírem.
- **Ciclo de Vida e Controlo de Estados**: Menu suspenso com matriz rigorosa de transições (`Novo` -> `Atribuído` -> `Em Atendimento`, `Aguardando Cliente`, `Resolvido`; reabertura a partir de `Resolvido`), impedindo saltos arbitrários e exigindo responsável atribuído.
- **Gestão Dinâmica de Prioridades**: Menu suspenso com 4 níveis (`Baixa`, `Normal`, `Alta`, `Urgente`), atualizando o painel visual em tempo real e registando auditoria imediata.
- **Transferência entre Departamentos**: Comando `/ticket transferir` com autocomplete dinâmico (excluindo o departamento atual), transferindo o canal para a nova categoria e ajustando cargos de suporte com integridade atómica Discord + SQLite.
- **Gestão de Participantes Adicionais**: Comandos `/ticket participante-adicionar` e `/ticket participante-remover` para convidar até 10 membros adicionais ao ticket, com concessão/revogação imediata de permissões no canal e rastreio na tabela `ticket_members`.
- **Painel de Controlo e Consulta de Detalhes**: Comando `/ticket detalhes` para visualização de embed completo com autor, responsável, datas, participantes e histórico recente de eventos; e `/ticket atualizar` para sincronizar e reparar a interface do painel no canal se necessário.
- **Auditoria e Histórico de Eventos em Tempo Real**: Registo detalhado de eventos na tabela `ticket_events` (criação, assunção, libertação, transições de estado, alterações de prioridade, transferências e gestão de participantes) e envio de alertas visuais para o canal de logs configurado.

### 📋 Comandos Informativos e de Utilidade
- `/ticket`: Comandos contextuais para gestão do ticket atual (`transferir`, `participante-adicionar`, `participante-remover`, `detalhes`, `atualizar`).
- `/tickets`: Comandos administrativos para configuração do sistema de suporte (`configurar`, `departamento-adicionar`, `departamento-listar`, `departamento-remover`, `painel`).
- `/info`: Visão geral do bot, tecnologias e estado das funcionalidades ativas e futuras.
- `/ping`: Medição em tempo real da latência do bot e do WebSocket do Discord.
- `/server`: Estatísticas do servidor, contagem de membros, canais, cargos e nível de boost.

---

## 🛠️ Requisitos

- **Node.js**: `v18.0.0` ou superior (testado e compatível com Node.js 18+, 20+ e 24+).
- **Discord.js**: `v14.16.0`.
- **SQLite**: `better-sqlite3` `11.8.1` (compatível com Node.js >=18).
- **Sistema Operativo**: Windows, Linux ou macOS.

---

## 📦 Instalação

1. Clona o repositório ou navega até à pasta do projeto:
   ```bash
   cd "caminho/para/o/projeto"
   ```

2. Instala as dependências:
   ```bash
   npm install
   ```

3. Cria o ficheiro de configuração local:
   - Duplica o ficheiro `.env.example` e renomeia-o para `.env`:
     ```bash
     cp .env.example .env
     ```
   - Preenche os valores correspondentes no `.env`:
     ```env
     DISCORD_TOKEN=o_teu_token_do_bot
     CLIENT_ID=o_id_da_tua_aplicacao
     GUILD_ID=o_id_do_teu_servidor_de_testes
     DATABASE_PATH=./data/plus1bot.sqlite
     ```

> [!CAUTION]
> **Segurança do `.env`**: Nunca partilhes, publiques ou faças commit do ficheiro `.env` nem do token do teu bot. O ficheiro `.env` está explicitamente protegido no `.gitignore`.

---

## 🔐 Permissões do Bot no Discord

No [Discord Developer Portal](https://discord.com/developers/applications):

1. **Privileged Gateway Intents**:
   - **Message Content**: É **obrigatório** ativar o intent `MessageContent` para a funcionalidade de geração de transcrições de tickets, pois o bot necessita de ler o conteúdo das mensagens enviadas pelos utilizadores. Para bots em mais de 100 servidores, este intent requer verificação e aprovação pelo Discord. As opções `GuildMembers` e `Presence` podem permanecer desativadas. O intent base `GatewayIntentBits.Guilds` e `GatewayIntentBits.MessageContent` são necessários.

2. **Permissões do Bot no Servidor**:
   Ao convidar o bot com o escopo `bot` e `applications.commands`, assegura as seguintes permissões:
   - `Manage Channels` (Gerir Canais)
   - `View Channels` (Ver Canais)
   - `Send Messages` (Enviar Mensagens)
   - `Embed Links` (Inserir Links)
   - `Attach Files` (Anexar Ficheiros)
   - `Read Message History` (Ver Histórico de Mensagens)
   - `Manage Messages` (Gerir Mensagens — para limpeza de tickets)
   - `Use Slash Commands` (Usar Comandos de Barra)

> [!TIP]
> O cargo do **+1BOT** no Discord deve estar posicionado **acima** dos cargos que ele precisa de gerir nas permissões de canais.

---

## 🚀 Registo dos Comandos Slash

Para registar ou atualizar os comandos slash no Discord:

```bash
npm run deploy-commands
```
- Se `GUILD_ID` estiver definido no `.env`, os comandos são registados instantaneamente nesse servidor (ideal para desenvolvimento).
- Se `GUILD_ID` for omitido, os comandos serão registados globalmente na API do Discord.

---

## 📖 Tutorial de Uso dentro do Discord

O sistema foi desenhado para ser 100% configurável diretamente no Discord, sem necessidade de editar ficheiros de código ou reiniciar a aplicação.

### 1. Configuração Global do Servidor
Um Administrador deve executar o comando `/tickets configurar`:
- `categoria`: Categoria onde os canais de tickets serão organizados.
- `canal_logs`: Canal de texto onde a auditoria enviará relatórios de novos tickets.
- `cargo_equipa`: Cargo dos moderadores/suporte que terão acesso aos tickets.
- `titulo_painel` *(opcional)*: Título personalizado do embed (ex: `Central de Apoio da Comunidade`).
- `descricao_painel` *(opcional)*: Texto instrutivo para os membros.
- `cor_painel` *(opcional)*: Cor hexadecimal para a identidade visual (ex: `#5865F2`).

### 2. Adicionar Departamentos
Adiciona os departamentos necessários com `/tickets departamento-adicionar`:
```
/tickets departamento-adicionar nome:Dúvidas Gerais descricao:Perguntas frequentes e ajuda geral emoji:💬
/tickets departamento-adicionar nome:Suporte Técnico descricao:Problemas com bots e integrações emoji:🛠️
/tickets departamento-adicionar nome:Financeiro descricao:Faturas e parcerias emoji:💰 cargo_equipa:@EquipaFinanceira
```
*Nota: Se não especificares categoria ou cargo num departamento, o sistema recorrerá automaticamente às definições globais configuradas no passo 1.*

### 3. Inspecionar Departamentos
Para verificar a lista de departamentos ativos e a sua configuração efetiva resolvida:
```
/tickets departamento-listar
```

### 4. Publicar o Painel de Atendimento
No canal público onde pretendes disponibilizar o suporte (ex.: `#abrir-ticket`), executa:
```
/tickets painel
```
O bot verificará se todos os pré-requisitos estão cumpridos e publicará o embed profissional com o menu suspenso de seleção.

### 5. Desativar um Departamento
Caso precises de desativar uma área sem apagar tickets anteriores:
```
/tickets departamento-remover departamento:<seleciona no autocomplete>
```

### 6. Gestão do Atendimento no Canal do Ticket
Dentro do canal privado do ticket, a equipa de suporte e os utilizadores autorizados dispõem de controlos interativos e comandos contextuais:
- **Painel de Controlo Interativo**:
  - Botão **Assumir**: Atribui o ticket com exclusividade ao atendente.
  - Botão **Libertar**: Desatribui o ticket para reatribuição pela equipa ou administradores.
  - Select Menu de **Estado**: Transições de ciclo de vida guiadas (`Atribuído`, `Em Atendimento`, `Aguardando Cliente`, `Resolvido`).
  - Select Menu de **Prioridade**: Ajuste dinâmico (`Baixa`, `Normal`, `Alta`, `Urgente`).
- **Comandos Contextuais `/ticket`**:
  - `/ticket transferir departamento:<departamento>`: Transfere o ticket para outro departamento ativo (com autocomplete dinâmico), movendo a categoria e ajustando cargos de suporte.
  - `/ticket participante-adicionar utilizador:<@user>`: Concede acesso a um participante adicional (máximo de 10 por ticket).
  - `/ticket participante-remover utilizador:<@user>`: Remove o acesso de um participante adicional.
  - `/ticket detalhes`: Exibe um embed completo com autor, responsável, estado, prioridade, participantes e últimos eventos de auditoria.
  - `/ticket atualizar`: Atualiza e resincroniza o painel de controlo persistente no canal a partir do estado atual da base de dados.

---

## 🏗️ Estrutura do Projeto

```
.
├── .env.example                     # Exemplo limpo de variáveis de ambiente
├── .gitignore                       # Proteção de segredos e ficheiros SQLite
├── package.json                     # Scripts e dependências (better-sqlite3, discord.js)
├── README.md                        # Documentação oficial
├── src/
│   ├── index.js                     # Inicialização do bot, conexão DB e loaders
│   ├── deploy-commands.js           # Registo de comandos na API do Discord
│   ├── commands/                    # Comandos Slash
│   │   ├── info.js                  # Informações do bot e funcionalidades
│   │   ├── ping.js                  # Verificação de latência
│   │   ├── server.js                # Informações da guild (+1BOT footer)
│   │   ├── ticket.js                # Comando contextual /ticket (5 subcomandos)
│   │   └── tickets.js               # Comando administrativo /tickets (5 subcomandos)
│   ├── components/tickets/          # Construtores de componentes do Discord
│   │   ├── buttons.js               # Botões utilitários de suporte
│   │   ├── modals.js                # Modal de abertura de ticket
│   │   ├── selectMenus.js           # Select Menu de departamentos e Embed do painel
│   │   └── ticketPanel.js           # Painel de controlo do ticket: botões, estados e prioridades
│   ├── database/                    # Camada de persistência SQLite
│   │   ├── connection.js            # Gestor de conexão com WAL e foreign keys
│   │   └── migrations.js            # Migrações DDL idempotentes
│   ├── events/                      # Ouvintes de eventos do Discord
│   │   ├── ready.js                 # Evento de arranque (+1BOT status)
│   │   └── interactionCreate.js     # Router para comandos, modais, selects e botões
│   ├── repositories/                # Camada de acesso a dados (SQL queries)
│   │   ├── settingsRepository.js    # CRUD de configurações por servidor
│   │   ├── ticketMemberRepository.js# Gestão de participantes de tickets no SQLite
│   │   └── ticketRepository.js      # Operações de tickets, departamentos e auditoria
│   ├── services/                    # Lógica de negócio e orquestração
│   │   ├── permissionService.js     # Validações de permissões e overwrites de canais
│   │   ├── settingsService.js       # Gestão de configurações e departamentos
│   │   ├── ticketMemberService.js   # Regras de negócio e permissões de participantes
│   │   └── ticketService.js         # Criação atómica de tickets, locks e ciclo de vida
│   └── utils/                       # Funções utilitárias
│       ├── emojiValidator.js        # Validação estrita de emojis Unicode e custom Discord
│       ├── logger.js                # Logger com timestamps
│       ├── ticketChannelName.js     # Sanitização e limitação a 100 caracteres
│       ├── ticketCustomIds.js       # Definições padronizadas de custom IDs
│       └── ticketState.js           # Constantes e matriz de transições de estados e prioridades
└── test/
    └── tickets.test.js              # Suite de testes com o runner nativo node:test
```

---

## 🧪 Testes

O projeto utiliza o módulo nativo de testes do Node.js (`node:test` e `node:assert/strict`), sem dependências pesadas externas e executando sobre uma base de dados SQLite `:memory:` isolada:

```bash
npm test
```

A suite conta com **55 testes automatizados** e cobre rigorosamente:
1. **Idempotência de Migrações e Schema Evolution**: Execuções repetidas do runner de migrações (`control_message_id`, tabela `ticket_members` com foreign keys e constraints de unicidade).
2. **CRUD de Configurações**: Persistência e atualização incremental de guild settings.
3. **Isolamento de Departamentos**: Nomes únicos por servidor e independência total entre guilds.
4. **Sanitização de Nomes**: Remoção de acentos, caracteres especiais e limite estrito de 100 caracteres.
5. **Numeração Sequencial**: Numeração independente por servidor (`TKT-00001`, `TKT-00002`, etc.).
6. **Prevenção de Duplicação**: Bloqueio de múltiplos tickets ativos pelo mesmo utilizador na mesma guild via constraint SQLite e validação de serviço.
7. **Consistência Transacional & Compensação**: Reversão segura de reservas, mensagens e canais em caso de falha de criação ou envio inicial.
8. **Assunção e Libertação de Tickets (Claim/Release)**: Atribuição com exclusividade, idempotência sem eventos duplicados, controlo de permissões de staff/admin e bloqueio de libertação de tickets resolvidos.
9. **Matriz Estrita de Estados e Transições**: Validação das transições autorizadas, exigência de responsável atribuído e bloqueio de saltos arbitrários.
10. **Gestão de Prioridades**: Transições de prioridade (`low`, `normal`, `high`, `urgent`), rejeição de valores inválidos e idempotência.
11. **Gestão Atómica de Participantes**: Adição e remoção de até 10 participantes, aplicação/reversão de overwrites no Discord e compensação em falhas de BD.
12. **Transferência entre Departamentos**: Migração entre categorias, troca de cargos de suporte, preservação de participantes e rollback compensatório em falhas.
13. **Comando Contextual `/ticket` e Autocomplete**: Serialização dos 5 subcomandos, autocomplete dinâmico excluindo o departamento atual, validação de canal de ticket e controlo de permissões de consulta.
14. **Custom IDs Estritos e Proteção de Erros**: Validação sintática de custom IDs e sanitização de mensagens de erro para o utilizador sem vazar stack traces ou SQL.
15. **Validação de Emojis e Registo de Comandos**: Suporte a emojis Unicode e custom Discord e serialização de todos os comandos Slash (info, ping, server, tickets, ticket).
16. **Fecho Seguro de Tickets e Transcrições**: Transição para arquivo read-only, geração de hashes, fallback de mensagens em disco para logs de auditoria e autorizações granulares.

---

## 🔧 Resolução de Problemas (Troubleshooting)

- **O painel não publica e dá erro de "Configuração Incompleta"**:
  Certifica-te de que executaste `/tickets configurar` (categoria, canal de logs e cargo de equipa) e `/tickets departamento-adicionar` com pelo menos um departamento ativo.
- **O bot dá erro de cargo de suporte não configurado ou apagado**:
  Por motivos de privacidade e conformidade, a criação de tickets exige um cargo de equipa válido (não sendo aceite @everyone). Se o cargo for apagado, o bot impede a abertura de novos tickets até que um novo cargo seja configurado por um administrador.
- **O bot dá erro de permissões insuficientes na categoria**:
  Se uma categoria de tickets for configurada, o bot valida previamente se possui as permissões `ViewChannel` e `ManageChannels` nessa categoria antes de reservar o ticket.
- **O utilizador recebe aviso de "Já tens um ticket aberto"**:
  O sistema garante por desenho que cada membro só pode manter um ticket ativo em simultâneo por servidor.

---

## 🗺️ Roadmap Breve (Próximas Entregas)

- **SLA, Feedback e Analytics**: Métricas de tempo de primeira resposta e resolução (SLA), inquéritos de satisfação (CSAT) e painel analítico de desempenho da equipa.
- **Inteligência Artificial (+1BOT AI)**: Assistente inteligente com RAG (Retrieval-Augmented Generation) para triagem e resolução autónoma de dúvidas frequentes com base em documentação.

### 📝 Fecho Profissional de Tickets (Entrega 3B)
- **Painel de Fecho Integrado**: O painel do ticket inclui o botão 'Fechar Ticket' que invoca um formulário modal para confirmação explícita.
- **Workflow Seguro**:
  - Staff normal só pode fechar tickets no estado 'Resolvido' e apenas se for o responsável do ticket.
  - Administradores (com `ManageGuild`) possuem autoridade para forçar o fecho de qualquer ticket independentemente do estado e responsável, gerando registo de auditoria com override.
- **Formulário Modal de Confirmação**: Requer motivo obrigatório (5 a 500 caracteres) e que a palavra de segurança 'FECHAR' seja inserida, prevenindo fechos acidentais.
- **Transição e Arquivo sem Auto-Delete**: A abordagem adotada, alinhada com as melhores práticas de retenção, garante que o canal **não é apagado**. O canal é sincronizado com uma categoria de arquivo (se configurada através de `/tickets configurar categoria_arquivo`) e as permissões são reescritas para modo read-only (visualização preservada, envio de mensagens e adição de reações desativados).
- **Geração de Transcrição HTML e Hash Criptográfico**: Todo o conteúdo é guardado sob `data/transcripts` na máquina local, referenciado na base de dados com `transcript_path` e selado com `transcript_sha256`. Este hash verifica a integridade contra corrupção, mas **não torna o ficheiro inviolável**. O utilizador recebe feedback do número de mensagens e os primeiros caracteres do hash, garantindo opacidade perante caminhos absolutos locais do host.
- **Configuração de Arquivo (Opcional)**: Comando `/tickets configurar` estendido com `categoria_arquivo` e opção `limpar_arquivo` para repor a null, visível em `/tickets estado`.
- **Limitações e Políticas de Retenção (Aviso)**:
  - **Limite de Mensagens**: As transcrições estão limitadas às últimas 1000 mensagens do ticket.
  - **Anexos e Ficheiros**: Imagens e anexos são embebidos apenas através da sua URL no Discord. **URLs não são backup**: se a mensagem original for apagada no Discord, a imagem desaparecerá do ficheiro HTML.
  - **Privacidade e Backup**: A responsabilidade de manter backups dos ficheiros SQLite e das transcrições (`data/`), bem como a definição de uma política de retenção (ex: eliminação automática após X meses) de acordo com o RGPD/privacidade, é do administrador da instância.
  - **Estado em Produção**: Este é um projeto em desenvolvimento contínuo; o estado atual não deve ser considerado 100% validado para produção sem devidas auditorias e testes finais na infraestrutura alvo.
