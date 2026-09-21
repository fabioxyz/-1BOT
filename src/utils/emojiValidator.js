/**
 * Utilitário de validação segura de emojis para Discord.
 * Suporta:
 * - Um único emoji Unicode apresentável (incluindo ZWJ, flags, tons de pele, keycaps)
 * - Custom emoji Discord completo no formato <:name:id>, <a:name:id> ou <name:id> com sintaxe real de dois pontos.
 */

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

// Custom Discord emoji regex (ex.: <:pepe:123456789012345678> ou <a:anim:123456789012345678> ou <pepe:123456789012345678>)
const CUSTOM_EMOJI_REGEX = /^<(?:a?:[a-zA-Z0-9_]{2,32}|[a-zA-Z0-9_]{2,32}):\d{17,20}>$/;

// Unicode keycap regex (ex.: 1️⃣, *️⃣, #️⃣)
const KEYCAP_REGEX = /^[0-9#*]\uFE0F?\u20E3$/u;

/**
 * Valida se a string é um único emoji Unicode apresentável ou custom emoji Discord válido.
 * @param {unknown} input
 * @returns {boolean}
 */
function isValidEmoji(input) {
  if (typeof input !== 'string') return false;
  const trimmed = input.trim();
  if (!trimmed) return false;

  // 1. Custom emoji do Discord
  if (CUSTOM_EMOJI_REGEX.test(trimmed)) {
    return true;
  }

  // 2. Emoji Unicode: deve ser exatamente 1 grapheme cluster
  const segments = Array.from(segmenter.segment(trimmed));
  if (segments.length !== 1) {
    return false;
  }

  // Keycap numérico/símbolo
  if (KEYCAP_REGEX.test(trimmed)) {
    return true;
  }

  // Pictográfico estendido ou bandeira (duas letras regionais)
  if (/\p{Extended_Pictographic}/u.test(trimmed) || /^\p{Regional_Indicator}{2}$/u.test(trimmed)) {
    if (!/^[a-zA-Z0-9]+$/.test(trimmed)) {
      return true;
    }
  }

  return false;
}

module.exports = {
  isValidEmoji,
  CUSTOM_EMOJI_REGEX,
};
