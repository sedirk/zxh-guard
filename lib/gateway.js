'use strict';

/**
 * 本地守护网关：把 PI-Desktop 的 OpenAI 兼容请求转发到南航智小航，
 * 中间串起 6 个模块（去代理直连 / 私有隧道 / 网卡绑定 / 28RPM 限流 / 乱码净化 / 429 重试）。
 */

const http = require('node:http');
const { StringDecoder } = require('node:string_decoder');
const { createPacer } = require('./rate-limit');
const sanitize = require('./sanitize');
const retryLib = require('./retry');
const transport = require('./transport');
const { detectSangforInterface } = require('./net-isolate');

const MAX_BODY_BYTES = 32 * 1024 * 1024;
const STREAM_FLUSH_THRESHOLD = 96 * 1024;

function jsonError(code, message, extra = {}) {
  return JSON.stringify({
    error: {
      message,
      type: 'zhixiaohang_guard',
      code,
      ...extra,
    },
  });
}

function sendJson(res, status, body) {
  if (res.writableEnded) return false;
  const payload = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.length),
    'cache-control': 'no-store',
  });
  res.end(payload);
  return true;
}

function readRequestBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('request body too large'), { code: 'EBODYTOOLARGE' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** SSE 里是否已经出现“真正的正文”（用于空流检测）。 */
function hasContentPayload(text) {
  if (/"content"\s*:\s*"[^"\\]/.test(text)) return true;
  if (/"reasoning_content"\s*:\s*"[^"\\]/.test(text)) return true;
  if (/"tool_calls"\s*:\s*\[\s*\{/.test(text)) return true;
  if (/"function_call"\s*:\s*\{/.test(text)) return true;
  if (/"delta"\s*:\s*"[^"\\]/.test(text)) return true;
  if (/response\.(?:output_text|function_call_arguments|output_item)\.delta/.test(text)) return true;
  if (/"type"\s*:\s*"response\.(?:completed|output_item\.done)"/.test(text)) return true;
  return false;
}

function isEventStream(headers) {
  return /text\/event-stream/i.test(String(headers['content-type'] || ''));
}

function createGateway(options) {
  const getConfig = options.getConfig;
  const log = typeof options.log === 'function' ? options.log : () => {};
  const tunnel = options.tunnel;

  const stats = {
    started: false,
    port: null,
    requests: 0,
    paced: 0,
    sanitized: 0,
    retries429: 0,
    emptyStreamRetries: 0,
    routes: { direct: 0, nic: 0, tunnel: 0 },
    lastProbe: null,
    lastRoute: null,
    lastError: '',
  };

  let server = null;
  let pacer = null;
  let routeCache = { at: 0, route: null };
  const agentCache = new Map();

  const config = () => getConfig();

  function rateLimit() {
    const cfg = config().rateLimit;
    if (!pacer || pacer.rpm() !== cfg.rpm || pacer.windowMs() !== cfg.windowMs) {
      pacer = createPacer({ rpm: cfg.rpm, windowMs: cfg.windowMs, maxWaiters: cfg.maxWaiters || 512 });
    }
    return pacer;
  }

  /** 直连 Agent：官方 EasyConnect 虚拟网卡存在时绑定它的 IP（模块 3）。 */
  function directAgent(localAddress) {
    const key = `direct:${localAddress || '-'}`;
    if (!agentCache.has(key)) agentCache.set(key, transport.createDirectAgent({ localAddress }));
    return agentCache.get(key);
  }

  function tunnelAgent() {
    const cfg = config().tunnel;
    const bind = transport.parseBind(cfg.httpBind, '127.0.0.1');
    const key = `tunnel:${bind.host}:${bind.port}`;
    if (!agentCache.has(key)) {
      agentCache.set(key, transport.createTunnelAgent({
        proxy: { host: bind.host, port: bind.port },
        connectTimeoutMs: cfg.startTimeoutMs,
      }));
    }
    return agentCache.get(key);
  }

  function resetAgents() {
    agentCache.clear();
    routeCache = { at: 0, route: null };
  }

  function currentNic() {
    return detectSangforInterface(config().vpnInterface);
  }

  function directRoute(nic) {
    return {
      kind: nic ? 'nic' : 'direct',
      agent: directAgent(nic ? nic.address : null),
      localAddress: nic ? nic.address : null,
      nicName: nic ? nic.name : null,
    };
  }

  function tunnelRoute() {
    return { kind: 'tunnel', agent: tunnelAgent(), localAddress: null };
  }

  /**
   * 选路：先探测直连（有官方虚拟网卡就绑它），不在校园网才按需拉起私有隧道。
   * 结论缓存 probe.cacheMs，避免每个请求都探测一次。
   */
  async function resolveRoute({ forceTunnel = false } = {}) {
    const cfg = config();
    const nic = currentNic();

    if (forceTunnel) {
      const ok = await tunnel.ensureReady('forced by request');
      if (ok) {
        stats.routes.tunnel += 1;
        stats.lastRoute = 'tunnel(forced)';
        return tunnelRoute();
      }
      log(`forced tunnel unavailable: ${tunnel.status().lastError}`);
    }

    const fresh = routeCache.route && cfg.probe.cacheMs > 0 && (Date.now() - routeCache.at) < cfg.probe.cacheMs;
    if (fresh) {
      const cached = routeCache.route;
      if (cached.kind !== 'tunnel') {
        stats.routes[cached.kind] += 1;
        stats.lastRoute = cached.kind;
        return cached.kind === 'nic' ? directRoute(nic) : cached;
      }
      if (tunnel.ready()) {
        tunnel.touch();
        stats.routes.tunnel += 1;
        stats.lastRoute = 'tunnel';
        return cached;
      }
    }

    const probe = await transport.probeEndpoint({
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      timeoutMs: cfg.probe.timeoutMs,
      agent: directAgent(nic ? nic.address : null),
    });
    stats.lastProbe = { ...probe, at: new Date().toISOString(), localAddress: nic ? nic.address : null };

    if (probe.ok) {
      const route = directRoute(nic);
      routeCache = { at: Date.now(), route };
      stats.routes[route.kind] += 1;
      stats.lastRoute = route.kind;
      log(`probe: on-campus via ${route.kind}${route.localAddress ? ` (${route.localAddress})` : ''} — status ${probe.status}`);
      return route;
    }

    log(`probe: off-campus (${probe.kind}${probe.error ? `/${probe.error}` : ''}, status ${probe.status})`);

    if (cfg.tunnel.enabled) {
      const ok = await tunnel.ensureReady(`probe:${probe.kind}`);
      if (ok) {
        const route = tunnelRoute();
        routeCache = { at: Date.now(), route };
        stats.routes.tunnel += 1;
        stats.lastRoute = 'tunnel';
        return route;
      }
    }

    // 隧道也起不来：仍然直连（会被净化模块换成一句明确提示）
    const route = directRoute(nic);
    routeCache = { at: Date.now(), route };
    stats.lastRoute = `${route.kind}(off-campus)`;
    return route;
  }

  function buildUpstreamHeaders(req) {
    const cfg = config();
    const headers = transport.sanitizeRequestHeaders(req.headers);
    headers['accept-encoding'] = 'identity';
    headers.authorization = `Bearer ${cfg.apiKey}`;
    if (!headers['content-type']) headers['content-type'] = 'application/json';
    headers['user-agent'] = 'zhixiaohang-guard/1.0 (+PI-Desktop)';
    return headers;
  }

  function sanitizedResponse(res, { rawText = '', reason = 'off-campus' } = {}) {
    const cfg = config();
    const notice = cfg.sanitize.enabled
      ? sanitize.composeNotice(rawText, cfg.sanitize)
      : cfg.sanitize.notice;
    stats.sanitized += 1;
    log(`sanitized upstream garbage (${reason}) → notice (${notice.length} chars)`);
    return sendJson(res, 502, jsonError(
      'ZHIXIAOHANG_OFF_CAMPUS',
      notice,
      { reason, route: stats.lastRoute },
    ));
  }

  function forwardBuffered(res, status, headers, buffer) {
    if (res.writableEnded) return false;
    const outHeaders = {
      'content-type': headers['content-type'] || 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': String(buffer.length),
    };
    res.writeHead(status, outHeaders);
    res.end(buffer);
    return true;
  }

  /**
   * SSE 转发：在收到第一段“真正的正文”之前先缓冲，这样空流 / HTML 才能安全重试；
   * 一旦开始给客户端写字节就不再重试。
   * @returns {Promise<{ sent: boolean, empty: boolean, sample: string }>}
   */
  function pumpStream(upstreamRes, res, abort) {
    return new Promise((resolve) => {
      const decoder = new StringDecoder('utf8');
      let buffered = [];
      let bufferedBytes = 0;
      let text = '';
      let sent = false;
      let finished = false;

      const finish = (result) => {
        if (finished) return;
        finished = true;
        upstreamRes.removeListener('data', onData);
        upstreamRes.removeListener('end', onEnd);
        upstreamRes.removeListener('error', onError);
        resolve(result);
      };

      const flush = () => {
        if (sent || res.writableEnded) return;
        sent = true;
        res.writeHead(upstreamRes.statusCode || 200, {
          'content-type': upstreamRes.headers['content-type'] || 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-store',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        for (const chunk of buffered) res.write(chunk);
        buffered = [];
        bufferedBytes = 0;
      };

      function onData(chunk) {
        text += decoder.write(chunk);
        if (!sent) {
          buffered.push(chunk);
          bufferedBytes += chunk.length;
          if (hasContentPayload(text) || bufferedBytes >= STREAM_FLUSH_THRESHOLD) flush();
          return;
        }
        if (!res.writableEnded) res.write(chunk);
      }

      function onEnd() {
        text += decoder.end();
        if (!sent) {
          if (hasContentPayload(text)) {
            flush();
            if (!res.writableEnded) res.end();
            finish({ sent: true, empty: false, sample: text.slice(0, 400) });
            return;
          }
          finish({ sent: false, empty: true, sample: text.slice(0, 400) });
          return;
        }
        if (!res.writableEnded) res.end();
        finish({ sent: true, empty: false, sample: text.slice(0, 400) });
      }

      function onError(error) {
        if (!sent) {
          finish({ sent: false, empty: true, sample: `${text.slice(0, 200)} [${error && error.message}]` });
          return;
        }
        if (!res.writableEnded) res.destroy(error);
        finish({ sent: true, empty: false, sample: '' });
      }

      upstreamRes.on('data', onData);
      upstreamRes.on('end', onEnd);
      upstreamRes.on('error', onError);
      if (abort.signal.aborted) onError(new Error('aborted'));
    });
  }

  async function handleExchange(req, res) {
    const cfg = config();
    const url = req.url || '/';
    const parsed = new URL(url, 'http://127.0.0.1');
    const pathname = parsed.pathname;

    if (pathname === '/' || pathname === '/healthz' || pathname === '/status') {
      return sendJson(res, 200, statusSnapshot());
    }

    // 校内 VPN 浏览客户端：由插件持有进程，双击入口只是调这几个端点。
    // 注意：与 API 隧道(11080/11081)完全独立——这里起的是 11090/11091 的另一个 zju-connect。
    // PAC：只把校内域名指到浏览客户端，其余 DIRECT（不污染其它流量）
    if (pathname === '/proxy.pac') {
      const vpn = options.vpn;
      const body = vpn && typeof vpn.pac === 'function'
        ? await vpn.pac()
        : 'function FindProxyForURL(url, host) { return "DIRECT"; }';
      if (res.writableEnded) return false;
      res.writeHead(200, {
        'content-type': 'application/x-ns-proxy-autoconfig; charset=utf-8',
        'content-length': String(Buffer.byteLength(body)),
        'cache-control': 'no-store',
      });
      res.end(body);
      return true;
    }

    if (pathname === '/vpn/api-tunnel-stop') {
      const vpn = options.vpn;
      if (!vpn || typeof vpn.stopApiTunnel !== 'function') {
        return sendJson(res, 501, jsonError('vpn_unavailable', '当前插件版本不支持该操作'));
      }
      const result = await vpn.stopApiTunnel();
      return sendJson(res, 200, result);
    }

    if (pathname === '/vpn/status' || pathname === '/vpn/start' || pathname === '/vpn/stop') {
      const vpn = options.vpn;
      if (!vpn) return sendJson(res, 501, jsonError('vpn_unavailable', '当前插件版本不支持校内 VPN 客户端'));
      if (pathname === '/vpn/status') {
        const snapshot = await vpn.status();
        return sendJson(res, 200, { ok: true, ...snapshot });
      }
      if (pathname === '/vpn/start') {
        const started = await vpn.start();
        return sendJson(res, started.ok ? 200 : 502, started);
      }
      const stopped = await vpn.stop();
      return sendJson(res, 200, stopped);
    }
    if (!pathname.startsWith('/v1/')) {
      return sendJson(res, 404, jsonError('not_found', `智小航网关不处理 ${pathname}`));
    }
    if (!cfg.apiKey) {
      return sendJson(res, 401, jsonError('missing_api_key',
        '⚠️ 智小航：config.json 里 apiKey 为空，请填写智小航 API Key 后保存（插件会自动重载）'));
    }

    let body;
    try {
      body = await readRequestBody(req);
    } catch (error) {
      return sendJson(res, 413, jsonError('body_too_large', `请求体过大：${error && error.message}`));
    }

    const abort = new AbortController();
    res.on('close', () => { if (!res.writableEnded) abort.abort(); });

    const limiter = rateLimit();
    const waitStartedAt = Date.now();
    const admitted = await limiter.acquire(abort.signal);
    if (!admitted) return undefined;
    if (Date.now() - waitStartedAt > 50) stats.paced += 1;

    const suffix = pathname.slice(3); // '/v1' 之后的部分，例如 '/chat/completions'
    const targetUrl = `${cfg.baseUrl}${suffix}${parsed.search}`;
    const headers = buildUpstreamHeaders(req);

    let attempt429 = 0;
    let emptyRetries = 0;
    let tunnelForced = false;
    let networkRetried = false;

    for (;;) {
      if (abort.signal.aborted) return undefined;
      const route = await resolveRoute({ forceTunnel: tunnelForced });
      if (route.kind === 'tunnel') tunnel.touch();

      let upstream;
      try {
        upstream = await transport.sendUpstream({
          url: targetUrl,
          method: req.method,
          headers,
          body: body.length > 0 ? body : null,
          agent: route.agent,
          timeoutMs: cfg.upstreamTimeoutMs,
          signal: abort.signal,
        });
      } catch (error) {
        const code = (error && (error.code || error.message)) || 'unknown';
        const detail = (error && error.message) || '';
        stats.lastError = `upstream error via ${route.kind}: ${code}${detail && detail !== code ? ` — ${detail}` : ''}`;
        log(stats.lastError);
        if (abort.signal.aborted) return undefined;
        if (!networkRetried && route.kind !== 'tunnel' && cfg.tunnel.enabled) {
          networkRetried = true;
          tunnelForced = true;
          continue;
        }
        return sendJson(res, 502, jsonError('upstream_unreachable',
          `⚠️ 智小航：无法连接上游（${code}）。若在校外请检查 config.json 的学号/密码，让私有隧道能登录 EasyConnect`));
      }

      const upstreamRes = upstream.res;
      const status = upstreamRes.statusCode || 0;
      const contentType = String(upstreamRes.headers['content-type'] || '');

      // ---- 429 / 容量冷却：按服务端提示耐心等待后重发（模块 6） ----
      if (status === 429 || status === 503) {
        const { buffer } = await transport.readBody(upstreamRes, 128 * 1024);
        const bodyText = buffer.toString('utf8');
        const capacity = retryLib.isCapacityFailure({ status, bodyText });
        if (capacity) {
          const hintMs = retryLib.parseRetryAfterMs({ headers: upstreamRes.headers, bodyText });
          if (hintMs !== undefined || cfg.retry.hintlessBackoff) {
            if (attempt429 < cfg.retry.maxRetries) {
              attempt429 += 1;
              const plan = retryLib.planDelay(attempt429, hintMs, cfg.retry);
              stats.retries429 += 1;
              log(`429 cooldown (${plan.source}): waiting ${plan.delayMs}ms — attempt ${attempt429}/${cfg.retry.maxRetries}`);
              const slept = await retryLib.cancellableDelay(plan.delayMs, abort.signal);
              if (!slept) return undefined;
              continue;
            }
            log(`429 cooldown: retry budget exhausted (${attempt429}/${cfg.retry.maxRetries}) — returning upstream error`);
          }
        }
        return forwardBuffered(res, status, upstreamRes.headers, buffer);
      }

      // ---- 校外 HTML / 乱码拦截（模块 5） ----
      if (sanitize.isHtmlContentType(contentType)) {
        const { buffer } = await transport.readBody(upstreamRes, 512 * 1024);
        stats.lastError = 'upstream returned text/html';
        if (route.kind !== 'tunnel' && cfg.tunnel.enabled && !tunnelForced) {
          tunnelForced = true;
          networkRetried = true;
          continue;
        }
        return sanitizedResponse(res, { rawText: buffer.toString('utf8'), reason: 'html' });
      }

      // ---- SSE 流 ----
      if (isEventStream(upstreamRes.headers)) {
        const pump = await pumpStream(upstreamRes, res, abort);
        if (!pump.sent) {
          const looksHtml = sanitize.looksLikeHtml(pump.sample) || sanitize.looksOffCampus(pump.sample, cfg.sanitize);
          if (looksHtml) {
            if (route.kind !== 'tunnel' && cfg.tunnel.enabled && !tunnelForced) {
              tunnelForced = true;
              networkRetried = true;
              continue;
            }
            return sanitizedResponse(res, { rawText: pump.sample, reason: 'html-stream' });
          }
          if (pump.empty) {
            if (emptyRetries < cfg.retry.emptyStreamRetries) {
              emptyRetries += 1;
              stats.emptyStreamRetries += 1;
              log(`empty stream detected — retrying (${emptyRetries}/${cfg.retry.emptyStreamRetries})`);
              await retryLib.cancellableDelay(Math.min(3000, cfg.retry.minDelayMs), abort.signal);
              continue;
            }
            if (route.kind !== 'tunnel' && cfg.tunnel.enabled && !tunnelForced) {
              tunnelForced = true;
              networkRetried = true;
              continue;
            }
            return sendJson(res, 502, jsonError('empty_stream',
              '⚠️ 智小航：上游返回了空响应流（可能处于冷却或隧道异常），已重试仍为空，请稍后再试'));
          }
        }
        return undefined;
      }

      // ---- 普通 JSON / 文本：先读完再判断是否乱码 ----
      const { buffer } = await transport.readBody(upstreamRes);
      const text = buffer.toString('utf8');
      const garbage = sanitize.looksOffCampus(text, cfg.sanitize) || sanitize.looksLikeHtml(text);
      if (garbage) {
        stats.lastError = 'upstream returned garbage/login page';
        if (route.kind !== 'tunnel' && cfg.tunnel.enabled && !tunnelForced) {
          tunnelForced = true;
          networkRetried = true;
          continue;
        }
        return sanitizedResponse(res, { rawText: text, reason: 'garbage' });
      }
      return forwardBuffered(res, status, upstreamRes.headers, buffer);
    }
  }

  function statusSnapshot() {
    const cfg = config();
    const nic = currentNic();
    return {
      plugin: 'local.zhixiaohang-guard',
      listening: stats.started,
      port: stats.port,
      baseUrl: cfg.baseUrl,
      apiKeyPresent: Boolean(cfg.apiKey),
      credentialsPresent: Boolean(cfg.studentId && cfg.password),
      rateLimit: { rpm: cfg.rateLimit.rpm, windowMs: cfg.rateLimit.windowMs, admitted: pacer ? pacer.admitted() : 0, waiting: pacer ? pacer.waiting() : 0 },
      sanitize: { enabled: cfg.sanitize.enabled, notice: cfg.sanitize.notice },
      retry: cfg.retry,
      counters: {
        requests: stats.requests,
        paced: stats.paced,
        sanitized: stats.sanitized,
        retries429: stats.retries429,
        emptyStreamRetries: stats.emptyStreamRetries,
        routes: stats.routes,
      },
      vpnInterface: nic ? { name: nic.name, address: nic.address, reason: nic.reason } : null,
      tunnel: tunnel ? tunnel.status() : null,
      lastProbe: stats.lastProbe,
      lastRoute: stats.lastRoute,
      lastError: stats.lastError,
      configWarnings: cfg.warnings || [],
    };
  }

  function handle(req, res) {
    stats.requests += 1;
    void Promise.resolve()
      .then(() => handleExchange(req, res))
      .catch((error) => {
        stats.lastError = (error && error.message) || 'unknown error';
        log(`gateway handler failed: ${stats.lastError}`);
        try { sendJson(res, 500, jsonError('gateway_error', `智小航网关内部错误：${stats.lastError}`)); } catch { /* ignore */ }
      });
  }

  function listen(ports) {
    return new Promise((resolve, reject) => {
      const candidates = Array.isArray(ports) ? ports : [ports];
      const attempt = (index) => {
        if (index >= candidates.length) { reject(new Error('no candidate port could be bound')); return; }
        const local = http.createServer(handle);
        local.once('error', (error) => {
          if (error && error.code === 'EADDRINUSE') { attempt(index + 1); return; }
          reject(error);
        });
        local.listen(candidates[index], '127.0.0.1', () => {
          local.removeAllListeners('error');
          local.on('error', (error) => log(`gateway server error: ${error && error.message}`));
          server = local;
          stats.started = true;
          stats.port = local.address().port;
          log(`gateway listening on 127.0.0.1:${stats.port}`);
          resolve(stats.port);
        });
      };
      attempt(0);
    });
  }

  function close() {
    if (!server) return;
    try { server.close(); } catch { /* ignore */ }
    server = null;
    stats.started = false;
    resetAgents();
  }

  return {
    listen,
    close,
    statusSnapshot,
    handle,
    stats,
    resolveRoute,
    resetAgents,
    pacer: () => pacer,
    setRouteCache: (value) => { routeCache = value; },
  };
}

module.exports = { createGateway, jsonError, hasContentPayload, isEventStream };