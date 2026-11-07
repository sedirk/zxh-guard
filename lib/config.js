'use strict';

/**
 * 配置装载：plugin 目录下的 config.json（用户手填），可选 plugin 数据目录覆盖。
 * 全部字段都有默认值，缺字段不会抛错，只会在 diagnostics 里记一条。
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = Object.freeze({
  baseUrl: 'https://token.nuaa.edu.cn/v1',
  gatewayPort: 41900,
  upstreamTimeoutMs: 600_000,
  rateLimit: { rpm: 28, windowMs: 60_000 },
  tunnel: {
    enabled: true,
    exePath: 'bin/zju-connect.exe',
    server: 'v.nuaa.edu.cn',
    port: 443,
    protocol: 'easyconnect',
    httpBind: '127.0.0.1:11081',
    socksBind: '127.0.0.1:11080',
    bindInterface: '',
    proxyDomains: [],
    startTimeoutMs: 25_000,
    idleTimeoutMs: 20 * 60 * 1000,
    extraArgs: [],
  },
  vpnInterface: {
    bindEnabled: true,
    namePattern: 'sangfor|easyconnect|easy connect|ssl vpn|vnic',
    cidrs: [],
    localAddress: '',
  },
  probe: { timeoutMs: 6_000, cacheMs: 30_000 },
  retry: {
    maxRetries: 5,
    minDelayMs: 1_000,
    maxDelayMs: 300_000,
    emptyStreamRetries: 1,
    hintlessBackoff: false,
    hintlessBaseDelayMs: 5_000,
  },
  sanitize: {
    enabled: true,
    maxNoticeChars: 200,
    notice: '⚠️ 智小航：校园网隧道未就绪或认证失败，请检查学号密码或网络',
    reminderKeys: ['仅限校内访问', '校外访问', '校园网', '统一身份认证', '请先登录', '登录超时', '无权限访问'],
    weakReminderKeys: ['登录', '认证', 'VPN'],
  },
  campusClient: {
    enabled: true,
    httpBind: '127.0.0.1:11081',
    socksBind: '127.0.0.1:11080',
    domains: ['nuaa.edu.cn'],
    startTimeoutMs: 30_000,
    idleTimeoutMs: 20 * 60 * 1000,
  },
});

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function merge(base, override) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  if (!isPlainObject(override)) return out;
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(out[key])) out[key] = merge(out[key], value);
    else if (value !== undefined) out[key] = value;
  }
  return out;
}

function num(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function str(value, fallback) {
  return typeof value === 'string' ? value : fallback;
}

function readJsonFile(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return { value: JSON.parse(raw), error: null };
  } catch (error) {
    return { value: null, error };
  }
}

/** 允许 config.json 里出现 // 与 /* *\/ 注释（用户手写更友好）。 */
function stripJsonComments(text) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i += 1; out += '\n'; continue; }
    if (ch === '/' && text[i + 1] === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1; i += 1; out += ' '; continue; }
    out += ch;
  }
  return out;
}

function parseConfigText(text) {
  try { return JSON.parse(text); } catch { /* fall through to the comment-tolerant pass */ }
  return JSON.parse(stripJsonComments(text));
}

/**
 * @param {{ packageRoot: string, dataPath?: string, logger?: (m: string) => void }} options
 */
function loadConfig(options) {
  const warnings = [];
  const logger = typeof options.logger === 'function' ? options.logger : () => {};
  const candidates = [path.join(options.packageRoot, 'config.json')];
  if (options.dataPath && path.resolve(options.dataPath) !== path.resolve(options.packageRoot)) {
    candidates.unshift(path.join(options.dataPath, 'config.json'));
  }
  let raw = {};
  let source = '(内置默认值)';
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      const text = fs.readFileSync(file, 'utf8');
      raw = parseConfigText(text);
      source = file;
      break;
    } catch (error) {
      warnings.push(`config.json 解析失败（${file}）：${error && error.message}`);
    }
  }
  if (source === '(内置默认值)') warnings.push('未找到 config.json，全部使用默认值（学号/密码/API Key 为空）');

  const merged = merge(DEFAULTS, raw);
  const cc = isPlainObject(merged.campusClient) ? merged.campusClient : DEFAULTS.campusClient;
  const config = {
    source,
    studentId: str(raw.studentId, '').trim(),
    password: str(raw.password, ''),
    apiKey: str(raw.apiKey, '').trim(),
    baseUrl: str(merged.baseUrl, DEFAULTS.baseUrl).replace(/\/+$/, ''),
    gatewayPort: Math.round(num(merged.gatewayPort, DEFAULTS.gatewayPort, { min: 1024, max: 65535 })),
    upstreamTimeoutMs: Math.round(num(merged.upstreamTimeoutMs, DEFAULTS.upstreamTimeoutMs, { min: 5_000, max: 3_600_000 })),
    rateLimit: {
      rpm: Math.round(num(merged.rateLimit.rpm, 28, { min: 1, max: 10_000 })),
      windowMs: Math.round(num(merged.rateLimit.windowMs, 60_000, { min: 1_000, max: 3_600_000 })),
      maxWaiters: Math.round(num(merged.rateLimit.maxWaiters, 512, { min: 1, max: 100_000 })),
    },
    tunnel: {
      enabled: bool(merged.tunnel.enabled, true),
      exePath: str(merged.tunnel.exePath, DEFAULTS.tunnel.exePath),
      server: str(merged.tunnel.server, DEFAULTS.tunnel.server),
      port: Math.round(num(merged.tunnel.port, 443, { min: 1, max: 65535 })),
      protocol: str(merged.tunnel.protocol, 'easyconnect'),
      httpBind: str(merged.tunnel.httpBind, DEFAULTS.tunnel.httpBind),
      socksBind: str(merged.tunnel.socksBind, DEFAULTS.tunnel.socksBind),
      bindInterface: str(merged.tunnel.bindInterface, ''),
      proxyDomains: Array.isArray(merged.tunnel.proxyDomains)
        ? merged.tunnel.proxyDomains.filter((d) => typeof d === 'string' && d.length > 0)
        : [],
      startTimeoutMs: Math.round(num(merged.tunnel.startTimeoutMs, 25_000, { min: 3_000, max: 180_000 })),
      idleTimeoutMs: Math.round(num(merged.tunnel.idleTimeoutMs, 1_200_000, { min: 60_000, max: 24 * 3_600_000 })),
      extraArgs: Array.isArray(merged.tunnel.extraArgs) ? merged.tunnel.extraArgs.filter((a) => typeof a === 'string') : [],
    },
    vpnInterface: {
      bindEnabled: bool(merged.vpnInterface.bindEnabled, true),
      namePattern: str(merged.vpnInterface.namePattern, DEFAULTS.vpnInterface.namePattern),
      cidrs: Array.isArray(merged.vpnInterface.cidrs) ? merged.vpnInterface.cidrs.filter((c) => typeof c === 'string') : [],
      localAddress: str(merged.vpnInterface.localAddress, '').trim(),
    },
    probe: {
      timeoutMs: Math.round(num(merged.probe.timeoutMs, 6_000, { min: 1_000, max: 60_000 })),
      cacheMs: Math.round(num(merged.probe.cacheMs, 30_000, { min: 0, max: 600_000 })),
    },
    retry: {
      maxRetries: Math.round(num(merged.retry.maxRetries, 5, { min: 0, max: 20 })),
      minDelayMs: Math.round(num(merged.retry.minDelayMs, 1_000, { min: 0, max: 60_000 })),
      maxDelayMs: Math.round(num(merged.retry.maxDelayMs, 300_000, { min: 1_000, max: 3_600_000 })),
      emptyStreamRetries: Math.round(num(merged.retry.emptyStreamRetries, 1, { min: 0, max: 5 })),
      hintlessBackoff: bool(merged.retry.hintlessBackoff, false),
      hintlessBaseDelayMs: Math.round(num(merged.retry.hintlessBaseDelayMs, 5_000, { min: 100, max: 300_000 })),
    },
    // 托盘与浏览客户端都读 campusClient；此前这里漏掉它，导致 PAC 退回到
    // 11091/11090（浏览隧道默认端口），而校园隧道实际在 11081/11080。
    campusClient: {
      enabled: bool(cc.enabled, true),
      httpBind: str(cc.httpBind, DEFAULTS.campusClient.httpBind),
      socksBind: str(cc.socksBind, DEFAULTS.campusClient.socksBind),
      domains: Array.isArray(cc.domains) && cc.domains.length > 0
        ? cc.domains.filter((d) => typeof d === 'string' && d.length > 0)
        : DEFAULTS.campusClient.domains.slice(),
      startTimeoutMs: Math.round(num(cc.startTimeoutMs, DEFAULTS.campusClient.startTimeoutMs, { min: 3_000, max: 180_000 })),
      idleTimeoutMs: Math.round(num(cc.idleTimeoutMs, DEFAULTS.campusClient.idleTimeoutMs, { min: 60_000, max: 24 * 3_600_000 })),
    },
    sanitize: {
      enabled: bool(merged.sanitize.enabled, true),
      maxNoticeChars: Math.round(num(merged.sanitize.maxNoticeChars, 200, { min: 20, max: 2_000 })),
      notice: str(merged.sanitize.notice, DEFAULTS.sanitize.notice),
      reminderKeys: (Array.isArray(merged.sanitize.reminderKeys) ? merged.sanitize.reminderKeys : DEFAULTS.sanitize.reminderKeys).filter((k) => typeof k === 'string'),
      weakReminderKeys: (Array.isArray(merged.sanitize.weakReminderKeys) ? merged.sanitize.weakReminderKeys : DEFAULTS.sanitize.weakReminderKeys).filter((k) => typeof k === 'string'),
      weakKeysRequireCorroboration: bool(merged.sanitize.weakKeysRequireCorroboration, true),
    },
    warnings,
  };

  if (!config.apiKey) warnings.push('config.json 里 apiKey 为空：上游会返回 401，请在 config.json 填写智小航 API Key');
  if (config.tunnel.enabled && (!config.studentId || !config.password)) {
    warnings.push('config.json 里 studentId/password 为空：校外无法自动拉起 EasyConnect 隧道');
  }
  if (typeof raw.apiKey === 'string' && raw.apiKey.length > 0) {
    logger('config.json 含明文凭据，请勿提交到版本库');
  }
  return config;
}

module.exports = { loadConfig, DEFAULTS, merge, parseConfigText };
