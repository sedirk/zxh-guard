'use strict';

/**
 * 模块 5：校外 HTML / 乱码入路屏蔽。
 * 清理规则移植自 dsh-zhixiaohang-guard（MIT）的 clean_zxh 纯 JS 版：
 * 上游返回校园统一认证整页 HTML（含巨型 base64）时，一个字节都不透传给模型上下文，
 * 只换成一两句短提示。
 */

const RE = {
  base64: /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{24,}={0,2}(?![A-Za-z0-9+/=])/g,
  dataUri: /data:[\w.+-]+\/[\w.+-]+;base64,[A-Za-z0-9+/=\s]*/gi,
  script: /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
  comment: /<!--[\s\S]*?-->/g,
  tag: /<[^<>]{0,20000}?>/g,
  inlineTag: /<\/?(?:a|abbr|b|bdi|bdo|big|cite|code|del|em|font|i|ins|kbd|label|mark|q|s|samp|small|span|strong|sub|sup|time|tt|u|var|wbr)\b[^<>]{0,2000}?>/gi,
  danglingTag: /<[/!?A-Za-z][^<>\n]*$/,
  trailingJunk: /["'/>=`\\]+$/,
  cjk: /[\u3400-\u9fff\uf900-\ufaff]/,
  pureSymbols: /^[\W_]+$/,
  tokenOnly: /^[A-Za-z0-9+/=]{24,}$/,
  htmlTag: /<[a-zA-Z][^>]*>|<\/?[a-zA-Z][^<>]*/,
  pngMagic: 'iVBORw0KGgo',
};

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  copy: '©', reg: '®', trade: '™', deg: '°', plusmn: '±', times: '×', divide: '÷', frac12: '½',
  hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  larr: '←', rarr: '→', ne: '≠', le: '≤', ge: '≥', infin: '∞', minus: '−', middot: '·', bull: '•',
  sect: '§', para: '¶', euro: '€', pound: '£', yen: '¥', cent: '¢', shy: '', zwj: '', zwnj: '',
};

function decodeEntities(text) {
  if (typeof text !== 'string' || text.indexOf('&') < 0) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (match, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      try { return String.fromCodePoint(code); } catch { return match; }
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : match;
  });
}

/** base64 块能还原成 HTML 或含中文的文字时返回它，否则 null。 */
function tryBase64Text(blob) {
  try {
    if (typeof blob !== 'string' || blob.length === 0) return null;
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(blob)) return null;
    if (blob.length % 4 === 1) return null;
    const buf = Buffer.from(blob, 'base64');
    if (buf.length === 0) return null;
    for (const encoding of ['utf-8', 'gb18030']) {
      let text;
      try { text = new TextDecoder(encoding, { fatal: true }).decode(buf); } catch { continue; }
      if (!text) continue;
      if (text.includes('<') && text.includes('>')) return text;
      if (RE.cjk.test(text)) return text;
      return null;
    }
    return null;
  } catch {
    return null;
  }
}

/** 整段是 JSON 时把里面的字符串抽出来（有些网关把 HTML 塞进 {"msg": ...}）。 */
function maybeJsonText(text) {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return text;
  let data;
  try { data = JSON.parse(trimmed); } catch { return text; }
  const parts = [];
  const walk = (node) => {
    if (typeof node === 'string') parts.push(node);
    else if (Array.isArray(node)) for (const item of node) walk(item);
    else if (node && typeof node === 'object') for (const value of Object.values(node)) walk(value);
  };
  walk(data);
  return parts.length > 0 ? parts.join('\n') : text;
}

function looksLikeGarbage(line) {
  if (RE.cjk.test(line)) return false;
  const core = line.replace(/\s+/g, '');
  if (core.length >= 200) return true;
  if (core.length >= 24 && RE.tokenOnly.test(core)) return true;
  return RE.pureSymbols.test(core);
}

function stripOnce(text, keepTokens) {
  let value = text;
  let base64 = 0;
  let tags = 0;
  value = value.replace(RE.dataUri, () => { base64 += 1; return ' '; });
  value = value.replace(RE.comment, ' ');
  value = value.replace(RE.script, ' ');
  if (!keepTokens) {
    value = value.replace(RE.base64, (match) => {
      base64 += 1;
      const decoded = tryBase64Text(match);
      return decoded ? ` ${decoded} ` : ' ';
    });
  }
  value = value.replace(RE.inlineTag, () => { tags += 1; return ''; });
  value = value.replace(RE.tag, () => { tags += 1; return '\n'; });
  return { text: value, base64, tags };
}

function cleanGarbled(text, options = {}) {
  const keepTokens = options.keepTokens === true;
  let value = typeof text === 'string' ? text : '';
  value = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  value = maybeJsonText(value);

  let base64 = 0;
  let tags = 0;
  for (let round = 0; round < 3; round += 1) {
    const next = stripOnce(value, keepTokens);
    base64 += next.base64;
    tags += next.tags;
    const changed = next.text !== value;
    value = next.text;
    if (!changed) break;
  }

  value = decodeEntities(value);
  value = value.replace(/\xa0/g, ' ').replace(/\u200b/g, '').replace(/\ufeff/g, '').replace(/\u3000/g, ' ');

  const lines = [];
  for (const rawLine of value.split('\n')) {
    let line = rawLine.replace(/[ \t]+/g, ' ').trim();
    if (!line) continue;
    if (RE.danglingTag.test(line)) {
      tags += 1;
      line = line.replace(RE.danglingTag, '').trim().replace(RE.trailingJunk, '').trim();
    }
    if (!line) continue;
    if (!keepTokens && looksLikeGarbage(line)) continue;
    lines.push(line);
  }
  return { text: lines.join('\n'), base64, tags };
}

function pickReminder(cleaned, sanitizeConfig) {
  const keys = [...(sanitizeConfig.reminderKeys || []), ...(sanitizeConfig.weakReminderKeys || [])];
  if (typeof cleaned !== 'string' || cleaned.length === 0 || keys.length === 0) return '';
  return cleaned.split('\n').filter((line) => keys.some((key) => line.includes(key))).join('\n');
}

/** 页面特征：data URI / PNG 魔数 / HTML 标签 / base64 块组合。 */
function hasPageShape(text) {
  if (typeof text !== 'string' || text.length < 8) return false;
  if (/data:image\/[\w.+-]+\/[\w.+-]+;base64,/i.test(text)) return true;
  if (text.includes(RE.pngMagic)) return true;
  const html = RE.htmlTag.test(text);
  RE.base64.lastIndex = 0;
  const b64 = RE.base64.test(text);
  RE.base64.lastIndex = 0;
  return html && b64;
}

/** 判定这段文本是不是“校外乱码/登录拦截页”。 */
function looksOffCampus(text, sanitizeConfig) {
  if (typeof text !== 'string' || text.length === 0) return false;
  if (/data:image\/[\w.+-]+\/[\w.+-]+;base64,/i.test(text)) return true;
  if (text.includes(RE.pngMagic)) return true;
  if ((sanitizeConfig.reminderKeys || []).some((key) => text.includes(key))) return true;
  const weak = (sanitizeConfig.weakReminderKeys || []).some((key) => text.includes(key));
  if (weak && sanitizeConfig.weakKeysRequireCorroboration === false) return true;
  const page = hasPageShape(text);
  if (weak && page) return true;
  return page;
}

/** 组装对外短提示：默认文案 + 能提取到的“仅限校内访问”整句，并截到上限。 */
function composeNotice(rawText, sanitizeConfig) {
  const cleaned = cleanGarbled(rawText, { keepTokens: false }).text;
  const sentence = pickReminder(cleaned, sanitizeConfig);
  let notice = sanitizeConfig.notice;
  if (sentence && !notice.includes(sentence)) notice = `${notice}\n${sentence}`;
  const limit = Number(sanitizeConfig.maxNoticeChars) || 200;
  if (notice.length > limit) notice = notice.slice(0, limit);
  return notice;
}

const HTML_HEAD = /^\s*(?:<!doctype\s+html|<html|<head|<body|<script|<\?xml|<meta)/i;

function looksLikeHtml(text) {
  if (typeof text !== 'string') return false;
  const head = text.slice(0, 512);
  if (HTML_HEAD.test(head)) return true;
  return /<\/html>\s*$/i.test(text.slice(-512)) && /<[a-z][^>]*>/i.test(head);
}

function isHtmlContentType(contentType) {
  return typeof contentType === 'string' && /text\/html|application\/xhtml/i.test(contentType);
}

/** 空白流签名（网关 200 + HTML 时，客户端只会报“流被截断”）。 */
function looksEmptyStream(message) {
  if (typeof message !== 'string' || message.length === 0) return false;
  return /stream ended (?:before|without)\b/i.test(message)
    || /ended pending/i.test(message)
    || /^pi-ai stream error$/i.test(message);
}

module.exports = {
  RE,
  decodeEntities,
  tryBase64Text,
  maybeJsonText,
  looksLikeGarbage,
  cleanGarbled,
  pickReminder,
  hasPageShape,
  looksOffCampus,
  composeNotice,
  looksLikeHtml,
  isHtmlContentType,
  looksEmptyStream,
};
