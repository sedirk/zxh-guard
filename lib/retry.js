'use strict';

/**
 * 模块 6：429 冷却耐心重试。
 * 等待逻辑移植自 dsh-cooldown-retry（MIT）：上游的 retry_after_seconds / Retry-After
 * 永远优先于本地退避；只有“没有任何提示”的容量失败才走指数退避（默认关闭）。
 */

const MS_HINT = /retry[_\s-]*after[_\s-]*(?:ms|msecs?|milliseconds?)\b["'\s:=]*(\d+)/i;
const SECONDS_HINT = /retry[_\s-]*after[_\s-]*(?:seconds?|secs?)\b["'\s:=]*(\d+(?:\.\d+)?)/i;
const PROSE_HINT = /(?:retry|try)(?:\s+again)?\s+(?:in|after)\s+(\d+(?:\.\d+)?)\s*(milliseconds?|msecs?|ms|seconds?|secs?|s)\b/i;
const BARE_HINT = /retry[_\s-]*after["'\s:=]*(\d+(?:\.\d+)?)/i;

const CAPACITY_WORDS = /capacity|cooldown|cooling down|overloaded|too many requests|rate.?limit|upstream_capacity|circuit\./i;

function toMs(amount, unit) {
  const value = Number.parseFloat(amount);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return /^m/i.test(unit) ? Math.round(value) : Math.round(value * 1000);
}

/** 从任意文本里解析服务端等待提示（毫秒）。 */
function extractDelayMsFromText(text) {
  if (typeof text !== 'string' || text.length === 0) return undefined;
  let match = MS_HINT.exec(text);
  if (match) {
    const ms = Number.parseInt(match[1], 10);
    if (Number.isFinite(ms) && ms > 0) return ms;
  }
  match = SECONDS_HINT.exec(text);
  if (match) {
    const ms = toMs(match[1], 'seconds');
    if (ms !== undefined) return ms;
  }
  match = PROSE_HINT.exec(text);
  if (match) {
    const ms = toMs(match[1], match[2]);
    if (ms !== undefined) return ms;
  }
  match = BARE_HINT.exec(text);
  if (match) {
    const ms = toMs(match[1], 'seconds');
    if (ms !== undefined) return ms;
  }
  return undefined;
}

/** Retry-After 头：可能是秒数，也可能是 HTTP 日期。 */
function extractDelayMsFromHeaders(headers) {
  if (!headers || typeof headers !== 'object') return undefined;
  const raw = headers['retry-after'] ?? headers['Retry-After'];
  if (raw === undefined || raw === null) return undefined;
  const text = String(raw).trim();
  if (!text) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const ms = Math.round(Number(text) * 1000);
    return ms > 0 ? ms : undefined;
  }
  const when = Date.parse(text);
  if (Number.isFinite(when)) {
    const ms = when - Date.now();
    return ms > 0 ? ms : undefined;
  }
  return undefined;
}

/** 组合：头 + 体，取两者中更长的提示。 */
function parseRetryAfterMs({ headers, bodyText } = {}) {
  const fromHeaders = extractDelayMsFromHeaders(headers);
  const fromBody = extractDelayMsFromText(bodyText);
  if (fromHeaders !== undefined && fromBody !== undefined) return Math.max(fromHeaders, fromBody);
  return fromHeaders !== undefined ? fromHeaders : fromBody;
}

function clampDelay(ms, options = {}) {
  const min = Number(options.minDelayMs) > 0 ? Number(options.minDelayMs) : 1000;
  const max = Number(options.maxDelayMs) > 0 ? Number(options.maxDelayMs) : 300000;
  return Math.min(Math.max(ms, min), max);
}

/** 单次等待时长：上游提示优先，其次（可选的）无提示指数退避。 */
function planDelay(attempt, hintMs, options = {}) {
  if (hintMs !== undefined && Number.isFinite(hintMs)) {
    return { delayMs: clampDelay(hintMs, options), source: 'hint' };
  }
  const base = Number(options.hintlessBaseDelayMs) > 0 ? Number(options.hintlessBaseDelayMs) : 5000;
  const raw = base * (2 ** Math.max(0, attempt - 1));
  return { delayMs: clampDelay(raw, options), source: 'backoff' };
}

/** 是不是“上游容量冷却”类失败（429，或消息里明说 capacity/cooldown）。 */
function isCapacityFailure({ status, bodyText } = {}) {
  if (status === 429) return true;
  if (status === 503 && typeof bodyText === 'string' && CAPACITY_WORDS.test(bodyText)) return true;
  if (typeof bodyText === 'string' && CAPACITY_WORDS.test(bodyText)) {
    return /"code"\s*:\s*"[^"]*(capacity|cooldown|circuit)/i.test(bodyText);
  }
  return false;
}

/** 可被 AbortSignal 打断的 sleep。 */
function cancellableDelay(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) { resolve(false); return; }
    let settled = false;
    const timer = setTimeout(() => finish(true), ms);
    function finish(ok) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(ok);
    }
    function onAbort() { finish(false); }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

module.exports = {
  extractDelayMsFromText,
  extractDelayMsFromHeaders,
  parseRetryAfterMs,
  clampDelay,
  planDelay,
  isCapacityFailure,
  cancellableDelay,
};