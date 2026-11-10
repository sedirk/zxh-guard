'use strict';

/**
 * 配置面板的后端：把 config.json 读写、校验、脱敏收在一处，
 * 保证「面板保存」和「网关/托盘读取」用的是同一份文件、同一套默认值。
 *
 * 安全约定：
 *  - 面向面板的返回值永远不含 password / apiKey 明文，只给 hasPassword / hasApiKey。
 *  - 空字符串表示「不修改」，避免用户只想改端口却把密码清空。
 *  - 写入保留原有未知字段，只覆盖表单管理的键。
 */

const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, DEFAULTS, merge, parseConfigText } = require('./config');

const HOST_PORT = /^[^\s:]+:\d{1,5}$/;

/**
 * 配置只有一处：插件数据目录下的 config.json，且只由面板写入。
 * 插件根目录里的旧文件仅在首次迁移时读一次，之后不再参与。
 */
function configFile(options = {}) {
  if (options.dataPath) return path.join(options.dataPath, 'config.json');
  return path.join(options.packageRoot || '.', 'config.json');
}

function resolveTarget(options = {}) {
  const file = configFile(options);
  return { file, exists: fs.existsSync(file) };
}

/** 旧版本把 config.json 放在插件根目录：迁移一次到数据目录。 */
function migrateLegacy(options = {}) {
  const { dataPath, packageRoot } = options;
  if (!dataPath || !packageRoot) return null;
  const target = path.join(dataPath, 'config.json');
  const legacy = path.join(packageRoot, 'config.json');
  if (fs.existsSync(target) || !fs.existsSync(legacy)) return null;
  try {
    fs.mkdirSync(dataPath, { recursive: true });
    fs.copyFileSync(legacy, target);
    return target;
  } catch { return null; }
}

function readRaw(file) {
  if (!fs.existsSync(file)) return {};
  const raw = parseConfigText(fs.readFileSync(file, 'utf8'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('config.json 顶层必须是 JSON 对象');
  }
  return raw;
}

function blockedHost(hostBind) {
  const host = String(hostBind || '').split(':')[0];
  return host !== '127.0.0.1' && host !== 'localhost' && host !== '::1';
}

function toInt(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  const i = Math.round(n);
  return i < min || i > max ? undefined : i;
}

/** 校验并归一化面板提交的内容；返回 { patch, errors }。 */
function normalizePatch(input) {
  const patch = {};
  const errors = [];
  if (!input || typeof input !== 'object') return { patch, errors: ['没有收到任何配置字段'] };
  const src = input;

  if (src.studentId !== undefined) patch.studentId = String(src.studentId).trim();
  if (src.password !== undefined && String(src.password) !== '') patch.password = String(src.password);
  if (src.apiKey !== undefined && String(src.apiKey) !== '') patch.apiKey = String(src.apiKey).trim();

  if (src.baseUrl !== undefined) {
    const value = String(src.baseUrl).trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s]+$/i.test(value)) errors.push('接口地址必须是 http:// 或 https:// 开头的完整 URL');
    else patch.baseUrl = value;
  }

  if (src.gatewayPort !== undefined) {
    const port = toInt(src.gatewayPort, 1024, 65535);
    if (port === undefined) errors.push('网关端口必须是 1024–65535 的整数');
    else patch.gatewayPort = port;
  }

  if (src.rpm !== undefined) {
    const rpm = toInt(src.rpm, 1, 10000);
    if (rpm === undefined) errors.push('限流 RPM 必须是 1–10000 的整数');
    else patch.rateLimit = { rpm };
  }

  if (src.probeTimeoutMs !== undefined) {
    const ms = toInt(src.probeTimeoutMs, 1000, 60000);
    if (ms === undefined) errors.push('探测超时必须是 1000–60000 毫秒');
    else patch.probe = { timeoutMs: ms };
  }

  const tunnel = {};
  if (src.tunnelEnabled !== undefined) tunnel.enabled = src.tunnelEnabled === true || src.tunnelEnabled === 'true';
  if (src.httpBind !== undefined) {
    const value = String(src.httpBind).trim();
    if (!HOST_PORT.test(value)) errors.push('HTTP 代理绑定必须是 host:port');
    else if (blockedHost(value)) errors.push('HTTP 代理只能绑定回环地址（127.0.0.1）');
    else tunnel.httpBind = value;
  }
  if (src.socksBind !== undefined) {
    const value = String(src.socksBind).trim();
    if (!HOST_PORT.test(value)) errors.push('SOCKS 绑定必须是 host:port');
    else if (blockedHost(value)) errors.push('SOCKS 只能绑定回环地址（127.0.0.1）');
    else tunnel.socksBind = value;
  }
  if (src.proxyDomains !== undefined) {
    const list = Array.isArray(src.proxyDomains)
      ? src.proxyDomains
      : String(src.proxyDomains).split(/[\s,;]+/);
    tunnel.proxyDomains = list.map((d) => String(d).trim()).filter(Boolean);
  }
  if (src.idleMinutes !== undefined) {
    const minutes = toInt(src.idleMinutes, 1, 1440);
    if (minutes === undefined) errors.push('闲置关闭时间必须是 1–1440 分钟');
    else tunnel.idleTimeoutMs = minutes * 60000;
  }
  if (src.startSeconds !== undefined) {
    const seconds = toInt(src.startSeconds, 3, 180);
    if (seconds === undefined) errors.push('隧道启动超时必须是 3–180 秒');
    else tunnel.startTimeoutMs = seconds * 1000;
  }
  if (Object.keys(tunnel).length > 0) patch.tunnel = tunnel;

  return { patch, errors };
}

/** 读给面板看：不含任何明文凭据。 */
function readPanel(options = {}) {
  const { file, exists } = resolveTarget(options);
  const cfg = options.load ? options.load() : loadConfig({ packageRoot: options.packageRoot, dataPath: options.dataPath });
  const view = {
    file,
    exists,
    source: cfg.source,
    baseUrl: cfg.baseUrl,
    gatewayPort: cfg.gatewayPort,
    studentId: cfg.studentId,
    hasPassword: Boolean(cfg.password),
    hasApiKey: Boolean(cfg.apiKey),
    rpm: cfg.rateLimit.rpm,
    probeTimeoutMs: cfg.probe.timeoutMs,
    tunnelEnabled: cfg.tunnel.enabled,
    httpBind: cfg.tunnel.httpBind,
    socksBind: cfg.tunnel.socksBind,
    proxyDomains: cfg.tunnel.proxyDomains.join(', '),
    idleMinutes: Math.round(cfg.tunnel.idleTimeoutMs / 60000),
    startSeconds: Math.round(cfg.tunnel.startTimeoutMs / 1000),
    warnings: cfg.warnings || [],
  };
  return view;
}

function writeAtomic(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.copyFileSync(tmp, file);
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

/** 保存面板内容；返回 { file, changed, errors }。errors 非空时不落盘。 */
function savePanel(options = {}, input = {}) {
  const { file, exists } = resolveTarget(options);
  const { patch, errors } = normalizePatch(input);
  if (errors.length > 0) return { ok: false, file, errors, changed: [] };
  if (Object.keys(patch).length === 0) return { ok: true, file, exists, changed: [], note: '没有需要修改的字段' };

  let raw;
  try {
    raw = readRaw(file);
  } catch (error) {
    return { ok: false, file, errors: [`现有 config.json 解析失败，已拒绝覆盖：${error.message}`], changed: [] };
  }

  const next = merge(raw, patch);
  // merge() 只处理普通对象；顶层标量交给它即可，但数组/嵌套需要显式写回。
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      next[key] = { ...(raw[key] && typeof raw[key] === 'object' ? raw[key] : {}), ...value };
    } else {
      next[key] = value;
    }
  }

  writeAtomic(file, next);
  return { ok: true, file, exists, changed: Object.keys(patch) };
}

module.exports = {
  configFile,
  migrateLegacy,
  resolveTarget,
  readRaw,
  normalizePatch,
  readPanel,
  savePanel,
  DEFAULTS,
};
