const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Escapa rigorosamente caracteres HTML em strings para prevenir XSS e injeção de tags/atributos.
 * @param {any} str
 * @returns {string}
 */
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Valida e sanitiza uma URL para uso seguro em atributos HTML.
 * Apenas os esquemas http e https são autorizados.
 * Qualquer outro esquema (javascript:, data:, file:, vbscript:, etc.) retorna null.
 * @param {string} url
 * @returns {string|null}
 */
function sanitizeUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.href;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Calcula o hash determinístico SHA-256 em formato hexadecimal de uma string ou Buffer.
 * @param {string|Buffer} content
 * @returns {string}
 */
function hashTranscript(content) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content || ''), 'utf8');
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Gera o nome de ficheiro padronizado e seguro para a transcrição.
 * Exemplo: TKT-00042-transcript.html
 * @param {number|string} ticketNumber
 * @returns {string}
 */
function generateTranscriptFileName(ticketNumber) {
  const num = parseInt(ticketNumber, 10);
  const formattedNum = Number.isNaN(num)
    ? String(ticketNumber).padStart(5, '0')
    : String(num).padStart(5, '0');
  return `TKT-${formattedNum}-transcript.html`;
}

/**
 * Formata tamanho de ficheiro em formato legível (B, KB, MB).
 * @param {number} bytes
 * @returns {string}
 */
function formatFileSize(bytes) {
  const b = Number(bytes);
  if (Number.isNaN(b) || b <= 0) return '0 B';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Renderiza o conteúdo textual de uma mensagem, convertendo links http/https em hiperligações seguras.
 * @param {string} content
 * @returns {string}
 */
function renderMessageContentHtml(content) {
  if (!content) return '';
  const escaped = escapeHtml(content);
  // Detetar URLs com esquema http ou https
  const urlRegex = /(https?:\/\/[^\s<>"']+)/gi;
  return escaped.replace(urlRegex, (match) => {
    const safe = sanitizeUrl(match);
    if (safe) {
      return `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer" class="chat-link">${escapeHtml(match)}</a>`;
    }
    return match;
  });
}

/**
 * Renderiza a transcrição completa do ticket num documento HTML autónomo e profissional.
 * @param {object} data
 * @returns {string} HTML autónomo
 */
function renderTranscriptHtml(data) {
  const ticket = data.ticket || {};
  const guild = data.guild || {};
  const channel = data.channel || {};
  const creator = data.creator || {};
  const department = data.department || null;
  const claimedBy = data.claimedBy || null;
  const closedBy = data.closedBy || null;
  const closeReason = data.closeReason || ticket.close_reason || 'Não especificado';
  const participants = Array.isArray(data.participants) ? data.participants : [];
  const messages = Array.isArray(data.messages) ? data.messages : [];
  const truncated = Boolean(data.truncated);
  const messageCount = typeof data.messageCount === 'number' ? data.messageCount : messages.length;
  const generatedAt = data.generatedAt || new Date().toISOString();

  const ticketNumberStr = `TKT-${String(ticket.ticket_number || 0).padStart(5, '0')}`;
  const guildName = escapeHtml(guild.name || 'Servidor Discord');
  const channelName = escapeHtml(channel.name || 'canal-fechado');
  const creatorTag = escapeHtml(creator.tag || creator.username || ticket.creator_id || 'Utilizador');
  const departmentName = escapeHtml(department ? department.name : 'Geral');
  const statusStr = escapeHtml(ticket.status || 'closed');
  const priorityStr = escapeHtml(ticket.priority || 'normal');
  const claimedByStr = claimedBy ? escapeHtml(claimedBy.tag || claimedBy.username || claimedBy.id) : 'Nenhum';
  const closedByStr = closedBy ? escapeHtml(closedBy.tag || closedBy.username || closedBy.id) : (ticket.closed_by ? escapeHtml(ticket.closed_by) : 'Sistema');
  const createdAtStr = ticket.created_at ? escapeHtml(ticket.created_at) : 'N/A';
  const closedAtStr = ticket.closed_at ? escapeHtml(ticket.closed_at) : escapeHtml(generatedAt);
  const subjectStr = escapeHtml(ticket.subject || 'Sem Assunto');
  const descriptionStr = escapeHtml(ticket.description || 'Sem Descrição');

  const participantsStr = participants.length > 0
    ? participants.map((p) => escapeHtml(p.tag || p.username || p.id || p.user_id)).join(', ')
    : 'Nenhum participante adicional';

  const truncationNotice = truncated
    ? `<div class="alert-box">
        <span class="alert-icon">⚠️</span>
        <div class="alert-content">
          <strong>Aviso de Truncagem:</strong> O número de mensagens excedeu o limite configurado (${messageCount} recolhidas). As mensagens mais antigas que excederam o limite não foram incluídas.
        </div>
      </div>`
    : '';

  const intentNotice = `<div class="alert-box alert-info">
        <span class="alert-icon">ℹ️</span>
        <div class="alert-content">
          <strong>Nota de Integridade:</strong> O conteúdo e anexos das mensagens só estão garantidos se o bot tiver o intent <em>Message Content</em> ativado e autorizado no Discord Developer Portal. Mensagens vazias podem dever-se a esta restrição.
        </div>
      </div>`;

  // Renderizar mensagens
  const messagesHtml = messages.map((msg, index) => {
    const author = msg.author || {};
    const authorName = escapeHtml(author.tag || author.username || 'Utilizador');
    const authorId = escapeHtml(author.id || '');
    const isBot = Boolean(author.bot);
    const botBadge = isBot ? '<span class="bot-tag">BOT</span>' : '';
    const safeAvatarUrl = sanitizeUrl(author.avatarUrl);
    const avatarHtml = safeAvatarUrl
      ? `<img src="${escapeHtml(safeAvatarUrl)}" alt="${authorName}" class="avatar-img" loading="lazy" /><div class="avatar-fallback" style="display:none;">${escapeHtml(authorName.charAt(0).toUpperCase())}</div>`
      : `<div class="avatar-fallback">${escapeHtml(authorName.charAt(0).toUpperCase())}</div>`;

    const timestamp = escapeHtml(msg.createdAt || '');
    const editedHtml = msg.editedAt ? `<span class="edited-flag" title="Editada em ${escapeHtml(msg.editedAt)}">(editada)</span>` : '';
    const bodyHtml = renderMessageContentHtml(msg.content);

    // Anexos
    let attachmentsHtml = '';
    if (Array.isArray(msg.attachments) && msg.attachments.length > 0) {
      const attItems = msg.attachments.map((att) => {
        const attName = escapeHtml(att.name || 'anexo');
        const attSize = formatFileSize(att.size);
        const safeAttUrl = sanitizeUrl(att.url);
        if (safeAttUrl) {
          return `<a href="${escapeHtml(safeAttUrl)}" target="_blank" rel="noopener noreferrer" class="attachment-chip">
            <span class="att-icon">📎</span>
            <span class="att-name">${attName}</span>
            <span class="att-size">(${attSize})</span>
          </a>`;
        }
        return `<span class="attachment-chip disabled">
          <span class="att-icon">📎</span>
          <span class="att-name">${attName}</span>
          <span class="att-size">(${attSize})</span>
        </span>`;
      }).join('');
      attachmentsHtml = `<div class="attachments-container">${attItems}</div>`;
    }

    // Embeds
    let embedsHtml = '';
    if (Array.isArray(msg.embeds) && msg.embeds.length > 0) {
      const embItems = msg.embeds.map((emb) => {
        const titleSafeUrl = sanitizeUrl(emb.url);
        const titleText = escapeHtml(emb.title || '');
        const titleHtml = titleText
          ? (titleSafeUrl ? `<a href="${escapeHtml(titleSafeUrl)}" target="_blank" rel="noopener noreferrer" class="embed-title-link">${titleText}</a>` : `<div class="embed-title">${titleText}</div>`)
          : '';
        const descHtml = emb.description ? `<div class="embed-desc">${renderMessageContentHtml(emb.description)}</div>` : '';

        let fieldsHtml = '';
        if (Array.isArray(emb.fields) && emb.fields.length > 0) {
          const fieldItems = emb.fields.map((f) => `
            <div class="embed-field ${f.inline ? 'inline' : ''}">
              <div class="field-name">${escapeHtml(f.name || '')}</div>
              <div class="field-value">${renderMessageContentHtml(f.value || '')}</div>
            </div>
          `).join('');
          fieldsHtml = `<div class="embed-fields">${fieldItems}</div>`;
        }

        const borderColor = emb.color ? `#${Number(emb.color).toString(16).padStart(6, '0')}` : '#3b82f6';
        return `
          <div class="embed-card" style="border-left-color: ${escapeHtml(borderColor)};">
            ${titleHtml}
            ${descHtml}
            ${fieldsHtml}
          </div>
        `;
      }).join('');
      embedsHtml = `<div class="embeds-container">${embItems}</div>`;
    }

    return `
      <div class="message-card" id="msg-${escapeHtml(msg.id || index)}">
        <div class="message-avatar">${avatarHtml}</div>
        <div class="message-body">
          <div class="message-header">
            <span class="author-name">${authorName}</span>
            ${botBadge}
            <span class="author-id">${authorId ? `ID: ${authorId}` : ''}</span>
            <span class="message-time">${timestamp}</span>
            ${editedHtml}
          </div>
          ${bodyHtml ? `<div class="message-text">${bodyHtml}</div>` : ''}
          ${attachmentsHtml}
          ${embedsHtml}
        </div>
      </div>
    `;
  }).join('');

  return `<!DOCTYPE html>
<html lang="pt">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Transcrição ${ticketNumberStr} - +1BOT</title>
  <style>
    :root {
      --bg-primary: #0f172a;
      --bg-secondary: #1e293b;
      --bg-tertiary: #334155;
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
      --accent: #3b82f6;
      --accent-hover: #2563eb;
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
      --border-color: #334155;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg-primary);
      color: var(--text-main);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      line-height: 1.5;
      padding: 24px 16px;
    }
    .container {
      max-width: 1000px;
      margin: 0 auto;
    }
    .header-card {
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: 12px;
      padding: 24px;
      margin-bottom: 24px;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.2);
    }
    .brand-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid var(--border-color);
      padding-bottom: 16px;
      margin-bottom: 20px;
    }
    .brand-title {
      font-size: 20px;
      font-weight: 700;
      color: var(--accent);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .badge {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 9999px;
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .badge-closed { background: rgba(239, 68, 68, 0.2); color: var(--danger); border: 1px solid rgba(239, 68, 68, 0.4); }
    .badge-priority { background: rgba(59, 130, 246, 0.2); color: var(--accent); border: 1px solid rgba(59, 130, 246, 0.4); }
    .ticket-meta-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 16px;
    }
    .meta-item { display: flex; flex-direction: column; gap: 4px; }
    .meta-label { font-size: 11px; text-transform: uppercase; color: var(--text-muted); font-weight: 600; }
    .meta-value { font-size: 14px; font-weight: 500; word-break: break-word; }
    .alert-box {
      background: rgba(245, 158, 11, 0.1);
      border: 1px solid var(--warning);
      border-radius: 8px;
      padding: 12px 16px;
      margin-bottom: 24px;
      display: flex;
      gap: 12px;
      align-items: center;
      color: #fef3c7;
      font-size: 14px;
    }
    .chat-container {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .message-card {
      display: flex;
      gap: 14px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: 10px;
      padding: 16px;
      transition: background 0.15s ease;
    }
    .message-avatar {
      flex-shrink: 0;
      width: 40px;
      height: 40px;
    }
    .avatar-img {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      object-fit: cover;
    }
    .avatar-fallback {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      background: var(--accent);
      color: #fff;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 16px;
    }
    .message-body { flex: 1; min-width: 0; }
    .message-header {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 6px;
    }
    .author-name { font-weight: 600; font-size: 15px; color: var(--text-main); }
    .bot-tag {
      background: #5865F2;
      color: #fff;
      font-size: 10px;
      font-weight: 700;
      padding: 2px 5px;
      border-radius: 4px;
      line-height: 1;
    }
    .author-id { font-size: 11px; color: var(--text-muted); }
    .message-time { font-size: 12px; color: var(--text-muted); margin-left: auto; }
    .edited-flag { font-size: 11px; color: var(--text-muted); font-style: italic; }
    .message-text {
      font-size: 14px;
      color: #cbd5e1;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .chat-link {
      color: var(--accent);
      text-decoration: underline;
    }
    .chat-link:hover { color: var(--accent-hover); }
    .attachments-container {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 10px;
    }
    .attachment-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: var(--bg-tertiary);
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 13px;
      color: var(--text-main);
      text-decoration: none;
      border: 1px solid var(--border-color);
    }
    .attachment-chip:hover:not(.disabled) {
      border-color: var(--accent);
      background: #3b4252;
    }
    .att-size { color: var(--text-muted); font-size: 11px; }
    .embeds-container { margin-top: 10px; display: flex; flex-direction: column; gap: 8px; }
    .embed-card {
      background: #182234;
      border-left: 4px solid var(--accent);
      border-radius: 4px;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      font-size: 13px;
    }
    .embed-title { font-weight: 600; color: #fff; }
    .embed-title-link { font-weight: 600; color: var(--accent); text-decoration: none; }
    .embed-desc { color: #94a3b8; white-space: pre-wrap; }
    .embed-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px; }
    .embed-field .field-name { font-weight: 600; font-size: 12px; color: #cbd5e1; }
    .embed-field .field-value { font-size: 12px; color: #94a3b8; }
    .footer {
      margin-top: 40px;
      text-align: center;
      font-size: 12px;
      color: var(--text-muted);
      border-top: 1px solid var(--border-color);
      padding-top: 20px;
    }
  </style>
</head>
<body>
  <div class="container">
    <header class="header-card">
      <div class="brand-bar">
        <div class="brand-title">
          <span>+1BOT</span>
          <span style="color: var(--text-muted); font-weight: 400; font-size: 16px;">• Transcrição Oficial</span>
        </div>
        <div>
          <span class="badge badge-closed">${statusStr}</span>
          <span class="badge badge-priority">Prioridade: ${priorityStr}</span>
        </div>
      </div>

      <div class="ticket-meta-grid">
        <div class="meta-item">
          <span class="meta-label">Ticket</span>
          <span class="meta-value">${ticketNumberStr}</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">Servidor</span>
          <span class="meta-value">${guildName}</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">Canal</span>
          <span class="meta-value">#${channelName}</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">Autor</span>
          <span class="meta-value">${creatorTag}</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">Assunto</span>
          <span class="meta-value">${subjectStr}</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">Descrição</span>
          <span class="meta-value">${descriptionStr}</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">Departamento</span>
          <span class="meta-value">${departmentName}</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">Responsável</span>
          <span class="meta-value">${claimedByStr}</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">Fechado por</span>
          <span class="meta-value">${closedByStr}</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">Motivo do Fecho</span>
          <span class="meta-value">${escapeHtml(closeReason)}</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">Aberto em</span>
          <span class="meta-value">${createdAtStr}</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">Fechado em</span>
          <span class="meta-value">${closedAtStr}</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">Total de Mensagens</span>
          <span class="meta-value">${messageCount}</span>
        </div>
        <div class="meta-item" style="grid-column: 1 / -1;">
          <span class="meta-label">Participantes</span>
          <span class="meta-value">${participantsStr}</span>
        </div>
      </div>
    </header>

    ${truncationNotice}
    ${intentNotice}

    <main class="chat-container">
      ${messagesHtml}
    </main>

    <footer class="footer">
      <p>Gerado automaticamente pelo <strong>+1BOT</strong> em ${escapeHtml(generatedAt)}.</p>
      <p>Este documento é um registo estático e seguro de suporte ao cliente.</p>
    </footer>
  </div>
</body>
</html>`;
}

/**
 * Recolhe mensagens paginadas de um canal Discord de forma segura, em ordem cronológica.
 * @param {object} channel
 * @param {object} [options]
 * @param {number} [options.limit=1000]
 * @param {number} [options.batchSize=100]
 * @returns {Promise<{ messages: Array<object>, truncated: boolean, messageCount: number }>}
 */
async function fetchChannelMessages(channel, { limit = 1000, batchSize = 100 } = {}) {
  if (!channel || !channel.messages || typeof channel.messages.fetch !== 'function') {
    return { messages: [], truncated: false, messageCount: 0 };
  }

  const allMessages = [];
  let lastId = null;
  let truncated = false;

  while (allMessages.length < limit) {
    const fetchLimit = Math.min(batchSize, limit - allMessages.length);
    const fetchOpts = { limit: fetchLimit };
    if (lastId) {
      fetchOpts.before = lastId;
    }

    const batch = await channel.messages.fetch(fetchOpts);
    if (!batch) break;

    const batchValues = batch.values ? Array.from(batch.values()) : (Array.isArray(batch) ? batch : []);
    if (batchValues.length === 0) break;

    allMessages.push(...batchValues);
    lastId = batchValues[batchValues.length - 1].id;

    if (batchValues.length < fetchLimit) {
      break;
    }
  }

  if (allMessages.length >= limit) {
    truncated = true;
  }

  // Ordenar cronologicamente (do mais antigo para o mais recente)
  allMessages.sort((a, b) => {
    const timeA = a.createdTimestamp || (a.createdAt ? new Date(a.createdAt).getTime() : 0);
    const timeB = b.createdTimestamp || (b.createdAt ? new Date(b.createdAt).getTime() : 0);
    if (timeA !== timeB) return timeA - timeB;
    return String(a.id).localeCompare(String(b.id));
  });

  // Mapear mensagens para formato serializável seguro
  const serializableMessages = allMessages.map((msg) => {
    const author = msg.author || {};
    const attachments = [];
    if (msg.attachments) {
      const attValues = msg.attachments.values ? Array.from(msg.attachments.values()) : (Array.isArray(msg.attachments) ? msg.attachments : []);
      for (const att of attValues) {
        attachments.push({
          id: att.id,
          name: att.name || 'ficheiro-anexo',
          url: att.url || null,
          size: att.size || 0,
          contentType: att.contentType || null,
        });
      }
    }

    const embeds = [];
    if (Array.isArray(msg.embeds)) {
      for (const emb of msg.embeds) {
        const fields = [];
        if (Array.isArray(emb.fields)) {
          for (const f of emb.fields) {
            fields.push({
              name: f.name || '',
              value: f.value || '',
              inline: Boolean(f.inline),
            });
          }
        }
        embeds.push({
          title: emb.title || null,
          description: emb.description || null,
          url: emb.url || null,
          color: emb.color || null,
          fields,
        });
      }
    }

    return {
      id: String(msg.id),
      content: msg.content || '',
      createdAt: msg.createdAt ? new Date(msg.createdAt).toISOString() : (msg.createdTimestamp ? new Date(msg.createdTimestamp).toISOString() : new Date().toISOString()),
      editedAt: msg.editedAt ? new Date(msg.editedAt).toISOString() : (msg.editedTimestamp ? new Date(msg.editedTimestamp).toISOString() : null),
      author: {
        id: String(author.id || 'desconhecido'),
        username: author.username || 'Utilizador',
        tag: author.tag || author.username || 'Utilizador',
        bot: Boolean(author.bot),
        avatarUrl: typeof author.displayAvatarURL === 'function' ? author.displayAvatarURL() : (author.avatarURL || null),
      },
      attachments,
      embeds,
    };
  });

  return {
    messages: serializableMessages,
    truncated,
    messageCount: serializableMessages.length,
  };
}

/**
 * Gera e persiste a transcrição HTML atomicamente em disco.
 * O caminho relativo na BD é retornado no formato `<guildId>/<fileName>`.
 * @param {object} params
 * @returns {Promise<{ html: string, buffer: Buffer, sha256: string, fileName: string, relativePath: string, absolutePath: string, messageCount: number, truncated: boolean }>}
 */
async function generateAndSaveTranscript({
  ticket,
  guild,
  channel,
  creator,
  department = null,
  claimedBy = null,
  closedBy = null,
  closeReason = null,
  participants = [],
  messages = [],
  truncated = false,
  baseDir = process.env.TRANSCRIPT_DIR || './data/transcripts',
}) {
  const ticketNumber = ticket.ticket_number;
  const fileName = generateTranscriptFileName(ticketNumber);
  const guildId = String(guild.id);
  const targetDir = path.resolve(baseDir, guildId);
  const targetFilePath = path.join(targetDir, fileName);
  const relativePath = path.join(guildId, fileName).replace(/\\/g, '/');

  const html = renderTranscriptHtml({
    ticket,
    guild,
    channel,
    creator,
    department,
    claimedBy,
    closedBy,
    closeReason,
    participants,
    messages,
    truncated,
    messageCount: messages.length,
    generatedAt: new Date().toISOString(),
  });

  const buffer = Buffer.from(html, 'utf8');
  const sha256 = hashTranscript(buffer);

  // Escrita atómica através de ficheiro temporário + rename
  await fs.promises.mkdir(targetDir, { recursive: true });
  const tmpFilePath = path.join(targetDir, `.${fileName}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`);

  try {
    await fs.promises.writeFile(tmpFilePath, buffer);
    await fs.promises.rename(tmpFilePath, targetFilePath);
  } catch (err) {
    await fs.promises.unlink(tmpFilePath).catch(() => {});
    throw err;
  }

  return {
    html,
    buffer,
    sha256,
    fileName,
    relativePath,
    absolutePath: targetFilePath,
    messageCount: messages.length,
    truncated,
  };
}

/**
 * Remove um ficheiro de transcrição (usado em compensação de erros).
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function deleteTranscriptFile(filePath) {
  if (!filePath) return false;
  try {
    await fs.promises.unlink(filePath);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  escapeHtml,
  sanitizeUrl,
  hashTranscript,
  generateTranscriptFileName,
  formatFileSize,
  renderMessageContentHtml,
  renderTranscriptHtml,
  fetchChannelMessages,
  generateAndSaveTranscript,
  deleteTranscriptFile,
};
