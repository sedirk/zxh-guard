'use strict';

/**
 * 模块 1 + 模块 3 的网络隔离原语：
 *  - scrubProxyEnv(): 进程内彻底删除 *_proxy 环境变量，并关掉 Node 的 env-proxy 开关。
 *  - listIpv4Interfaces() / detectSangforInterface(): 识别官方 EasyConnect 虚拟网卡。
 *  - 所有出站请求都不经过 fetch/undici（那才会读环境代理），改为自建 https.Agent。
 */

const os = require('node:os');
const net = require('node:net');

/** 大小写两种写法都要删：Windows 不区分环境变量名大小写，Node 也不区分。 */
const PROXY_ENV_KEYS = [
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'ftp_proxy',
  'npm_config_proxy',
  'npm_config_https_proxy',
  'global_agent',
  'decompress',
  'node_use_env_proxy',
];

function scrubProxyEnv(env = process.env) {
  const removed = [];
  for (const key of Object.keys(env)) {
    const lower = key.toLowerCase();
    if (PROXY_ENV_KEYS.includes(lower)) {
      try { delete env[key]; } catch { /* 只读环境变量，忽略 */ }
      removed.push(key);
    }
  }
  // 即便将来有人把 fetch 用进插件，也让它别再读环境代理（Node 24 的开关）。
  try { env.NODE_USE_ENV_PROXY = '0'; } catch { /* ignore */ }
  try { env.NODE_OPTIONS = ''; } catch { /* ignore */ }
  return removed;
}

function ipv4ToInt(address) {
  const parts = String(address).split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const byte = Number(part);
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) return null;
    value = (value * 256) + byte;
  }
  return value >>> 0;
}

function cidrContains(cidr, address) {
  const [base, bitsRaw] = String(cidr).split('/');
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
  const baseInt = ipv4ToInt(base);
  const addrInt = ipv4ToInt(address);
  if (baseInt === null || addrInt === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (baseInt & mask) === (addrInt & mask);
}

/** family 在 Node 24 里是 'IPv4' 字符串，在旧版里是 4 —— 两种都要认。 */
function isIpv4(entry) {
  return entry && (entry.family === 'IPv4' || entry.family === 4);
}

function listIpv4Interfaces(interfaces = os.networkInterfaces()) {
  const out = [];
  for (const [name, entries] of Object.entries(interfaces || {})) {
    for (const entry of entries || []) {
      if (!isIpv4(entry)) continue;
      out.push({
        name,
        address: entry.address,
        netmask: entry.netmask,
        internal: entry.internal === true,
        mac: entry.mac,
      });
    }
  }
  return out;
}

/**
 * 官方 EasyConnect 虚拟网卡识别：
 *  1) 网卡名命中 namePattern（Sangfor / EasyConnect / SSL VPN / VNIC ...）
 *  2) 或者地址落在用户配置的校园网 VPN 内网段 cidrs 里
 * 命中的地址再校验一次是否真的在网卡上（防止已经断开的残留条目）。
 */
function detectSangforInterface(options = {}, interfaces) {
  const bindEnabled = options.bindEnabled !== false;
  if (!bindEnabled) return null;
  const explicit = typeof options.localAddress === 'string' ? options.localAddress.trim() : '';
  const candidates = listIpv4Interfaces(interfaces);
  if (explicit) {
    if (!net.isIPv4(explicit)) return null;
    const owner = candidates.find((entry) => entry.address === explicit);
    return {
      name: owner ? owner.name : '(config.localAddress)',
      address: explicit,
      reason: 'config.localAddress',
    };
  }
  const pattern = typeof options.namePattern === 'string' && options.namePattern.length > 0
    ? new RegExp(options.namePattern, 'i')
    : null;
  const cidrs = Array.isArray(options.cidrs) ? options.cidrs : [];

  for (const entry of candidates) {
    if (entry.internal) continue;
    if (pattern && pattern.test(entry.name)) {
      return { name: entry.name, address: entry.address, reason: 'name' };
    }
  }
  for (const entry of candidates) {
    if (entry.internal) continue;
    for (const cidr of cidrs) {
      if (cidrContains(cidr, entry.address)) {
        return { name: entry.name, address: entry.address, reason: `cidr:${cidr}` };
      }
    }
  }
  return null;
}

/** 给子进程用的干净环境：不带任何代理变量。 */
function cleanChildEnv(baseEnv = process.env) {
  const env = { ...baseEnv };
  scrubProxyEnv(env);
  return env;
}

module.exports = {
  PROXY_ENV_KEYS,
  scrubProxyEnv,
  cleanChildEnv,
  ipv4ToInt,
  cidrContains,
  isIpv4,
  listIpv4Interfaces,
  detectSangforInterface,
};
