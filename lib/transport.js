'use strict';

/**
 * 出站传输层：完全不使用 fetch/undici（那才是会读环境代理的地方）。
 *  - createDirectAgent(): 直连，IPv4 固定 + 可绑定 localAddress（官方 EasyConnect 虚拟网卡）。
 *  - createTunnelAgent(): 走本地私有 HTTP 代理（zju-connect 的 127.0.0.1:11081），
 *    自己发 CONNECT 再套 TLS，因此不依赖任何第三方代理库。
 *  - probeEndpoint(): 直连探测，用来判断“在不在校园网里”。
 */

const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');

/** 直连 Agent：keepAlive + 强制 IPv4 + 可选本地地址绑定。 */
function createDirectAgent({ localAddress, maxSockets = 16, keepAlive = true } = {}) {
  const options = {
    keepAlive,
    maxSockets,
    family: 4,
    autoSelectFamily: false,
  };
  if (localAddress) options.localAddress = localAddress;
  return new https.Agent(options);
}

/**
 * 经本地私有 HTTP 代理（CONNECT）转发到目标 HTTPS 站点的 Agent。
 * https.Agent 会调用 createConnection(options, cb)，我们在这里完成
 * TCP -> CONNECT -> TLS 三步，返回一个已经握手的 TLSSocket。
 */
class ConnectTunnelAgent extends https.Agent {
  constructor({ proxy, connectTimeoutMs = 15000, maxSockets = 8 } = {}) {
    super({ keepAlive: true, maxSockets });
    this.proxy = { host: proxy.host, port: proxy.port };
    this.connectTimeoutMs = connectTimeoutMs;
  }

  createConnection(options, callback) {
    const targetHost = options.host;
    const targetPort = options.port || 443;
    const proxyHost = this.proxy.host;
    const proxyPort = this.proxy.port;
    let settled = false;
    const socket = net.connect({ host: proxyHost, port: proxyPort });

    const fail = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      callback(error);
    };

    socket.setTimeout(this.connectTimeoutMs);
    socket.once('timeout', () => fail(new Error(`CONNECT to ${proxyHost}:${proxyPort} timed out`)));
    socket.once('error', fail);

    let buffer = Buffer.alloc(0);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) {
        if (buffer.length > 32768) fail(new Error('proxy CONNECT response is too large'));
        return;
      }
      socket.removeListener('data', onData);
      socket.removeListener('error', fail);
      socket.setTimeout(0);

      const head = buffer.subarray(0, end).toString('latin1');
      const statusLine = head.split('\r\n')[0] || '';
      const matched = /^HTTP\/1\.[01]\s+(\d{3})/i.exec(statusLine.trim());
      if (!matched) { fail(new Error(`proxy CONNECT: malformed status line (${statusLine.slice(0, 80)})`)); return; }
      const status = Number(matched[1]);
      if (status < 200 || status >= 300) {
        const error = new Error(`proxy CONNECT rejected with HTTP ${status}`);
        error.code = 'ETUNNELSTATUS';
        error.status = status;
        fail(error);
        return;
      }

      const rest = buffer.subarray(end + 4);
      if (rest.length > 0) socket.unshift(rest);

      const tlsSocket = tls.connect({
        socket,
        servername: options.servername || targetHost,
        rejectUnauthorized: options.rejectUnauthorized !== false,
        ALPNProtocols: options.ALPNProtocols,
      });
      const onTlsError = (error) => {
        if (settled) return;
        settled = true;
        tlsSocket.destroy();
        callback(error);
      };
      tlsSocket.once('error', onTlsError);
      tlsSocket.once('secureConnect', () => {
        if (settled) return;
        settled = true;
        tlsSocket.removeListener('error', onTlsError);
        callback(null, tlsSocket);
      });
    };

    socket.on('data', onData);
    socket.once('connect', () => {
      socket.write(
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n`
        + `Host: ${targetHost}:${targetPort}\r\n`
        + 'User-Agent: zhixiaohang-guard\r\n'
        + 'Proxy-Connection: keep-alive\r\n\r\n',
      );
    });
  }
}

function createTunnelAgent({ proxy, connectTimeoutMs }) {
  return new ConnectTunnelAgent({ proxy, connectTimeoutMs });
}

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te',
  'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
]);

function sanitizeRequestHeaders(headers, { keepLength = false } = {}) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) {
      if (keepLength && lower === 'content-length') out[key] = value;
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * 发一次请求，拿到响应头即 resolve（响应体由调用方消费）。
 * @returns {Promise<{ req: import('node:http').ClientRequest, res: import('node:http').IncomingMessage }>}
 */
function sendUpstream({
  url,
  method = 'POST',
  headers = {},
  body = null,
  agent,
  timeoutMs = 600000,
  signal,
}) {
  return new Promise((resolve, reject) => {
    const target = typeof url === 'string' ? new URL(url) : url;
    const isHttps = target.protocol === 'https:';
    const mod = isHttps ? https : http;
    // Agent 与目标协议必须一致：https.Agent 交给 http.request 会抛 ERR_INVALID_PROTOCOL。
    // 生产环境上游固定 https；这里让 http 目标（自测 / 本地回环）也能走通。
    let clientAgent = agent;
    if (clientAgent && clientAgent.protocol && clientAgent.protocol !== target.protocol) clientAgent = undefined;
    const options = {
      method,
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      headers: sanitizeRequestHeaders(headers, { keepLength: body !== null }),
      agent: clientAgent,
    };
    if (isHttps) options.servername = target.hostname;
    if (body !== null && body !== undefined) options.headers['Content-Length'] = Buffer.byteLength(body);

    let settled = false;
    const req = mod.request(options, (res) => {
      if (settled) { res.destroy(); return; }
      settled = true;
      resolve({ req, res });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(Object.assign(new Error(`upstream timeout after ${timeoutMs}ms`), { code: 'ETIMEDOUT' }));
    });
    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    if (signal) {
      const onAbort = () => req.destroy(Object.assign(new Error('aborted by client'), { code: 'EABORTED' }));
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    if (body !== null && body !== undefined) req.write(body);
    req.end();
  });
}

/** 读取响应体，带字节上限（防止整页 base64 把内存吃满）。 */
function readBody(res, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let truncated = false;
    res.on('data', (chunk) => {
      if (truncated) return;
      size += chunk.length;
      if (size > limit) {
        truncated = true;
        chunks.push(chunk.subarray(0, Math.max(0, chunk.length - (size - limit))));
        res.destroy();
        return;
      }
      chunks.push(chunk);
    });
    res.on('end', () => resolve({ buffer: Buffer.concat(chunks), truncated }));
    res.on('close', () => resolve({ buffer: Buffer.concat(chunks), truncated }));
    res.on('error', (error) => {
      if (truncated) { resolve({ buffer: Buffer.concat(chunks), truncated }); return; }
      reject(error);
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => { const t = setTimeout(resolve, ms); if (t.unref) t.unref(); });
}

/** 探测本地 TCP 端口是否已经可用（zju-connect 就绪判定）。 */
function waitForPort(host, port, { timeoutMs = 25000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const socket = net.connect({ host, port });
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        socket.destroy();
        if (ok) resolve(true);
        else if (Date.now() >= deadline) resolve(false);
        else setTimeout(attempt, intervalMs).unref?.();
      };
      socket.setTimeout(1500, () => finish(false));
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
    };
    attempt();
  });
}

/** 把形如 127.0.0.1:11081 的绑定串拆开；兼容 ":11081"。 */
function parseBind(text, fallbackHost = '127.0.0.1') {
  const raw = String(text || '').trim();
  const index = raw.lastIndexOf(':');
  if (index < 0) return { host: fallbackHost, port: Number(raw) || 0 };
  const host = raw.slice(0, index) || fallbackHost;
  const port = Number(raw.slice(index + 1)) || 0;
  return { host: host === '0.0.0.0' ? fallbackHost : host, port };
}

/**
 * 直连探测：请求 /v1/models，只看“回了什么”。
 * 判定优先级：JSON -> 在校园网可达；HTML/登录页 -> 被拦截；超时/拒连 -> 不在校园网。
 */
async function probeEndpoint({
  baseUrl,
  apiKey = '',
  timeoutMs = 6000,
  agent,
  path = '/models',
} = {}) {
  const url = `${String(baseUrl).replace(/\/+$/, '')}${path}`;
  const headers = { accept: 'application/json', 'user-agent': 'zhixiaohang-guard-probe' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const startedAt = Date.now();
  try {
    const { req, res } = await sendUpstream({ url, method: 'GET', headers, agent, timeoutMs });
    const { buffer } = await readBody(res, 256 * 1024);
    const bodyText = buffer.toString('utf8');
    const contentType = String(res.headers['content-type'] || '');
    const sample = bodyText.slice(0, 300);
    let kind = 'text';
    if (/^\s*[[{]/.test(sample)) kind = 'json';
    else if (/<html|<!doctype|<head|<body/i.test(sample) || /text\/html/i.test(contentType)) kind = 'html';
    return {
      ok: kind === 'json',
      kind,
      status: res.statusCode,
      contentType,
      sample,
      elapsedMs: Date.now() - startedAt,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      kind: 'error',
      status: 0,
      contentType: '',
      sample: '',
      elapsedMs: Date.now() - startedAt,
      error: (error && (error.code || error.message)) || 'unknown error',
    };
  }
}

module.exports = {
  createDirectAgent,
  createTunnelAgent,
  ConnectTunnelAgent,
  sendUpstream,
  readBody,
  probeEndpoint,
  waitForPort,
  parseBind,
  sleep,
  sanitizeRequestHeaders,
};