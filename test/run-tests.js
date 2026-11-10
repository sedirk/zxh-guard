'use strict';

/**
 * 自测脚本：node test/run-tests.js
 * 覆盖 6 个模块 + PI-Desktop 插件加载/服务启停。
 */

const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const sanitize = require(path.join(root, 'lib/sanitize.js'));
const { createPacer } = require(path.join(root, 'lib/rate-limit.js'));
const retryLib = require(path.join(root, 'lib/retry.js'));
const netIsolate = require(path.join(root, 'lib/net-isolate.js'));
const { loadConfig } = require(path.join(root, 'lib/config.js'));
const transport = require(path.join(root, 'lib/transport.js'));
const { TunnelManager } = require(path.join(root, 'lib/tunnel.js'));
const { createGateway } = require(path.join(root, 'lib/gateway.js'));

const scratch = process.env.PI_SCRATCH_DIR || os.tmpdir();
const results = [];

async function suite(name, fn) {
  const startedAt = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - startedAt });
    console.log(`  PASS  ${name} (${Date.now() - startedAt}ms)`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`  FAIL  ${name}: ${error && error.message}`);
  }
}

function tempDir(prefix) {
  const dir = path.join(scratch, `zxh-test-${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// 假上游：一个 OpenAI 兼容的 http 服务，按路径返回不同场景
// ---------------------------------------------------------------------------
function createFakeUpstream() {
  const hits = new Map();
  const seenAuth = [];
  const loginHtml = '<!DOCTYPE html><html><head><title>统一身份认证</title></head><body>'
    + '<div>请先登录，本系统仅限校内访问</div>'
    + `<img src="data:image/png;base64,${'iVBORw0KGgo'.padEnd(400, 'A')}">`
    + '</body></html>';

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = req.url || '/';
      const key = url.split('?')[0];
      hits.set(key, (hits.get(key) || 0) + 1);
      seenAuth.push(req.headers.authorization || '');
      const n = hits.get(key);

      if (key === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'zhixiaohang-test-model', context_length: 65536 }] }));
        return;
      }
      const failure = /^\/v1\/upstream-(500|502|503|504)-(html|text-html|json-html|json|sse)$/.exec(key);
      if (failure) {
        const status = Number(failure[1]);
        const kind = failure[2];
        const page = `<html><head><title>${status} Bad Gateway</title></head><body>PRIVATE_PAGE_MARKER</body></html>`;
        const types = { html: 'text/html', 'text-html': 'text/plain', 'json-html': 'application/json', json: 'application/json', sse: 'text/event-stream' };
        res.writeHead(status, { 'content-type': types[kind] });
        res.end(kind === 'json' ? JSON.stringify({ error: { code: 'upstream_test', message: 'backend unavailable' } })
          : kind === 'json-html' ? JSON.stringify({ error: { message: page } }) : page);
        return;
      }
      if (key === '/v1/loginpage') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(loginHtml);
        return;
      }
      if (key === '/v1/loginpage-json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: loginHtml } }));
        return;
      }
      if (key === '/v1/busy' || key === '/v1/busy-503') {
        if (n === 1) {
          res.writeHead(key === '/v1/busy-503' ? 503 : 429, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            message: 'All upstream providers are cooling down. Please retry after 1 seconds.',
            type: 'upstream_capacity_exhausted',
            retry_after_seconds: 1,
          }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'ok', choices: [{ message: { role: 'assistant', content: 'after cooldown' } }] }));
        return;
      }
      if (key === '/v1/empty-stream') {
        if (n === 1) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end('data: {"id":"x","choices":[{"delta":{}}]}\n\ndata: [DONE]\n\n');
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: {"choices":[{"delta":{"content":"recovered"}}]}\n\ndata: [DONE]\n\n');
        return;
      }
      if (key === '/v1/stream' || key === '/v1/chat/completions' || key === '/v1/responses') {
        const streaming = /"stream"\s*:\s*true/.test(body);
        if (streaming) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'hello' })}\n\n`);
          res.end('data: [DONE]\n\n');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
          echo: { path: key, auth: req.headers.authorization || null },
        }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `unknown ${key}` } }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, hits, seenAuth, port: server.address().port, loginHtml }));
  });
}

function request(port, { path: p, method = 'POST', body = null, headers = {} }) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port, path: p, method,
      headers: { 'content-type': 'application/json', ...(payload ? { 'content-length': payload.length } : {}), ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function baseConfig(overrides = {}) {
  const cfg = loadConfig({ packageRoot: root, logger: () => {} });
  return {
    ...cfg,
    apiKey: 'test-key',
    studentId: 'TEST123',
    password: 'secret',
    tunnel: { ...cfg.tunnel, enabled: false, exePath: 'bin/zju-connect.exe', idleTimeoutMs: 120000, startTimeoutMs: 3000 },
    probe: { timeoutMs: 3000, cacheMs: 0 },
    retry: { ...cfg.retry, minDelayMs: 200, maxDelayMs: 5000, emptyStreamRetries: 1, maxRetries: 2 },
    ...overrides,
  };
}

function stubTunnel(ready = false) {
  return {
    ready: () => ready,
    touch: () => {},
    ensureReady: async () => ready,
    stop: async () => true,
    status: () => ({ state: ready ? 'ready' : 'stopped', pid: null, idleTimeoutMs: 1200000, external: false, lastError: '' }),
  };
}

// ---------------------------------------------------------------------------
async function main() {
  console.log('智小航守护网关自测');

  await suite('sanitize: 校外登录页被换成短提示且不含 HTML', async () => {
    const fake = await createFakeUpstream();
    const cfg = baseConfig({ baseUrl: `http://127.0.0.1:${fake.port}/v1` });
    const gateway = createGateway({ getConfig: () => cfg, log: () => {}, tunnel: stubTunnel(false) });
    await gateway.listen([0]);
    const port = gateway.stats.port;
    const res = await request(port, { path: '/v1/loginpage', body: { model: 'm', messages: [] } });
    assert.strictEqual(res.status, 502);
    const payload = JSON.parse(res.text);
    assert.strictEqual(payload.error.code, 'ZHIXIAOHANG_OFF_CAMPUS');
    assert.strictEqual(payload.error.upstreamStatus, 200);
    assert.strictEqual(payload.error.route, 'direct');
    assert.ok(payload.error.message.includes('智小航'), '提示应含产品名');
    assert.ok(payload.error.message.length < 260, `提示应很短，实际 ${payload.error.message.length}`);
    assert.ok(!/<html|base64|iVBOR/i.test(res.text), '不得透传 HTML/base64');
    assert.ok(payload.error.message.includes('仅限校内访问'), '应抽出原文关键句');
    gateway.close();
    fake.server.close();
  });

  await suite('sanitize: JSON 里塞 HTML 同样被拦截', async () => {
    const fake = await createFakeUpstream();
    const cfg = baseConfig({ baseUrl: `http://127.0.0.1:${fake.port}/v1` });
    const gateway = createGateway({ getConfig: () => cfg, log: () => {}, tunnel: stubTunnel(false) });
    await gateway.listen([0]);
    const res = await request(gateway.stats.port, { path: '/v1/loginpage-json', body: {} });
    assert.strictEqual(res.status, 502);
    assert.ok(!/统一身份认证<\/|base64/.test(res.text));
    gateway.close();
    fake.server.close();
  });

  await suite('sanitize: 上游 5xx 页面不误报密码、不透传页面、不强制重登', async () => {
    const fake = await createFakeUpstream();
    try {
      for (const route of ['direct', 'tunnel']) {
        const cfg = baseConfig({ baseUrl: `http://127.0.0.1:${fake.port}/v1`, probe: { timeoutMs: 3000, cacheMs: 60000 } });
        cfg.tunnel.enabled = true;
        cfg.vpnInterface.bindEnabled = false;
        let starts = 0;
        const tunnel = { ...stubTunnel(true), ensureReady: async () => { starts += 1; return true; } };
        const logs = [];
        const gateway = createGateway({ getConfig: () => cfg, log: (line) => logs.push(line), tunnel });
        await gateway.listen([0]);
        gateway.setRouteCache({ at: Date.now(), route: { kind: route, agent: null } });
        try {
          for (const [status, kind] of [[502, 'html'], [503, 'html'], [504, 'text-html'], [500, 'json-html'], [503, 'json-html'], [502, 'sse']]) {
            const endpoint = `/v1/upstream-${status}-${kind}`;
            const before = fake.hits.get(endpoint) || 0;
            const response = await request(gateway.stats.port, { path: endpoint, body: {} });
            assert.strictEqual(response.status, status);
            const payload = JSON.parse(response.text);
            assert.strictEqual(payload.error.code, 'ZHIXIAOHANG_UPSTREAM_ERROR', `${route} ${endpoint}`);
            assert.strictEqual(payload.error.upstreamStatus, status);
            assert.strictEqual(payload.error.route, route);
            assert.strictEqual(payload.error.reason, 'upstream-http-error');
            assert.ok(payload.error.message.includes(`HTTP ${status}`));
            assert.ok(!/检查学号密码|PRIVATE_PAGE_MARKER|<html|base64/.test(response.text));
            assert.strictEqual(fake.hits.get(endpoint), before + 1, '5xx 页面不得触发重复请求');
            assert.ok(gateway.statusSnapshot().lastError.includes(`HTTP ${status} via ${route}`));
          }
          assert.strictEqual(starts, 0, '上游 5xx 不应触发重新登录 VPN');
          assert.ok(logs.every((line) => !line.includes('PRIVATE_PAGE_MARKER')));
        } finally { gateway.close(); }
      }
    } finally { fake.server.close(); }
  });

  await suite('转发: 上游 5xx JSON 错误保留原状', async () => {
    const fake = await createFakeUpstream();
    const cfg = baseConfig({ baseUrl: `http://127.0.0.1:${fake.port}/v1` });
    const gateway = createGateway({ getConfig: () => cfg, log: () => {}, tunnel: stubTunnel(false) });
    try {
      await gateway.listen([0]);
      for (const status of [500, 502, 503, 504]) {
        const response = await request(gateway.stats.port, { path: `/v1/upstream-${status}-json`, body: {} });
        assert.strictEqual(response.status, status);
        assert.deepStrictEqual(JSON.parse(response.text), { error: { code: 'upstream_test', message: 'backend unavailable' } });
      }
      assert.strictEqual(gateway.stats.sanitized, 0);
    } finally { gateway.close(); fake.server.close(); }
  });

  await suite('retry: 503 JSON 容量提示仍按提示重试', async () => {
    const fake = await createFakeUpstream();
    const cfg = baseConfig({ baseUrl: `http://127.0.0.1:${fake.port}/v1` });
    const gateway = createGateway({ getConfig: () => cfg, log: () => {}, tunnel: stubTunnel(false) });
    try {
      await gateway.listen([0]);
      const response = await request(gateway.stats.port, { path: '/v1/busy-503', body: {} });
      assert.strictEqual(response.status, 200);
      assert.strictEqual(fake.hits.get('/v1/busy-503'), 2);
      assert.strictEqual(gateway.stats.retries429, 1);
    } finally { gateway.close(); fake.server.close(); }
  });

  await suite('observability: /health 与 requests.jsonl 记录最近一轮', async () => {
    const fake = await createFakeUpstream();
    const cfg = baseConfig({ baseUrl: `http://127.0.0.1:${fake.port}/v1` });
    const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'zxh-health-'));
    const gateway = createGateway({ getConfig: () => cfg, log: () => {}, tunnel: stubTunnel(false), dataPath });
    await gateway.listen([0]);

    const before = JSON.parse((await request(gateway.stats.port, { path: '/health', method: 'GET' })).text);
    assert.strictEqual(before.lastRequest, null, '还没有请求时 lastRequest 应为 null');
    assert.strictEqual(before.plugin, 'local.zhixiaohang-guard');

    const ok = await request(gateway.stats.port, {
      path: '/v1/chat/completions',
      body: { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      headers: { authorization: `Bearer ${cfg.apiKey}` },
    });
    assert.strictEqual(ok.status, 200);

    const after = JSON.parse((await request(gateway.stats.port, { path: '/health', method: 'GET' })).text);
    assert.ok(after.lastRequest, '/health 应带 lastRequest');
    assert.strictEqual(after.lastRequest.route, 'direct');
    assert.strictEqual(after.lastRequest.upstreamStatus, 200);
    assert.ok(after.lastRequest.ms >= 0);
    assert.strictEqual(after.lastRequest.path, '/v1/chat/completions');

    const lines = fs.readFileSync(path.join(dataPath, 'requests.jsonl'), 'utf8').trim().split('\n');
    assert.strictEqual(lines.length, 1, '每次转发写一行');
    const record = JSON.parse(lines[0]);
    assert.strictEqual(record.upstreamStatus, 200);
    assert.strictEqual(record.route, 'direct');

    gateway.close();
    fake.server.close();
  });

  await suite('转发: chat/completions 与 responses 都通，且注入 Authorization', async () => {
    const fake = await createFakeUpstream();
    const cfg = baseConfig({ baseUrl: `http://127.0.0.1:${fake.port}/v1` });
    const gateway = createGateway({ getConfig: () => cfg, log: () => {}, tunnel: stubTunnel(false) });
    await gateway.listen([0]);
    const port = gateway.stats.port;
    const a = await request(port, { path: '/v1/chat/completions', body: { model: 'm', messages: [{ role: 'user', content: 'ping' }] } });
    assert.strictEqual(a.status, 200);
    const parsed = JSON.parse(a.text);
    assert.strictEqual(parsed.echo.path, '/v1/chat/completions');
    assert.strictEqual(parsed.echo.auth, 'Bearer test-key');
    const b = await request(port, { path: '/v1/responses', body: { model: 'm', input: 'ping' } });
    assert.strictEqual(b.status, 200);
    assert.strictEqual(JSON.parse(b.text).echo.path, '/v1/responses');
    gateway.close();
    fake.server.close();
  });

  await suite('模块6: 429 retry_after_seconds 自动倒计时重发', async () => {
    const fake = await createFakeUpstream();
    const cfg = baseConfig({ baseUrl: `http://127.0.0.1:${fake.port}/v1` });
    const gateway = createGateway({ getConfig: () => cfg, log: () => {}, tunnel: stubTunnel(false) });
    await gateway.listen([0]);
    const startedAt = Date.now();
    const res = await request(gateway.stats.port, { path: '/v1/busy', body: {} });
    const elapsed = Date.now() - startedAt;
    assert.strictEqual(res.status, 200);
    assert.ok(res.text.includes('after cooldown'));
    assert.strictEqual(gateway.stats.retries429, 1);
    assert.ok(elapsed >= 900, `应等满服务端要求的 1s，实际 ${elapsed}ms`);
    assert.strictEqual(fake.hits.get('/v1/busy'), 2);
    gateway.close();
    fake.server.close();
  });

  await suite('模块6: 空流自动重试后拿到正文', async () => {
    const fake = await createFakeUpstream();
    const cfg = baseConfig({ baseUrl: `http://127.0.0.1:${fake.port}/v1` });
    const gateway = createGateway({ getConfig: () => cfg, log: () => {}, tunnel: stubTunnel(false) });
    await gateway.listen([0]);
    const res = await request(gateway.stats.port, { path: '/v1/empty-stream', body: { stream: true } });
    assert.strictEqual(res.status, 200);
    assert.ok(res.text.includes('recovered'), `应拿到重试后的正文，实际：${res.text.slice(0, 200)}`);
    assert.strictEqual(gateway.stats.emptyStreamRetries, 1);
    assert.strictEqual(fake.hits.get('/v1/empty-stream'), 2);
    gateway.close();
    fake.server.close();
  });

  await suite('SSE 正常流不被缓冲破坏', async () => {
    const fake = await createFakeUpstream();
    const cfg = baseConfig({ baseUrl: `http://127.0.0.1:${fake.port}/v1` });
    const gateway = createGateway({ getConfig: () => cfg, log: () => {}, tunnel: stubTunnel(false) });
    await gateway.listen([0]);
    const res = await request(gateway.stats.port, { path: '/v1/stream', body: { stream: true } });
    assert.strictEqual(res.status, 200);
    assert.ok(res.text.includes('response.output_text.delta'));
    assert.ok(res.text.includes('[DONE]'));
    gateway.close();
    fake.server.close();
  });

  await suite('模块4: 28 RPM 滑动窗口排队而不是报错', async () => {
    const fake = await createFakeUpstream();
    const cfg = baseConfig({
      baseUrl: `http://127.0.0.1:${fake.port}/v1`,
      rateLimit: { rpm: 2, windowMs: 1000, maxWaiters: 64 },
    });
    const gateway = createGateway({ getConfig: () => cfg, log: () => {}, tunnel: stubTunnel(false) });
    await gateway.listen([0]);
    const port = gateway.stats.port;
    const startedAt = Date.now();
    const first = await request(port, { path: '/v1/chat/completions', body: {} });
    const second = await request(port, { path: '/v1/chat/completions', body: {} });
    const fastElapsed = Date.now() - startedAt;
    assert.strictEqual(first.status, 200);
    assert.strictEqual(second.status, 200);
    assert.ok(fastElapsed < 800, `前两个请求不该等待，实际 ${fastElapsed}ms`);
    const third = await request(port, { path: '/v1/chat/completions', body: {} });
    const totalElapsed = Date.now() - startedAt;
    assert.strictEqual(third.status, 200, '排队的请求也必须成功，不能报错');
    assert.ok(totalElapsed >= 900, `第三个请求应被排队到窗口滑动，实际 ${totalElapsed}ms`);
    gateway.close();
    fake.server.close();
  });

  await suite('模块4: 默认配置就是 28 RPM', async () => {
    const cfg = loadConfig({ packageRoot: root });
    assert.strictEqual(cfg.rateLimit.rpm, 28);
    assert.strictEqual(cfg.rateLimit.windowMs, 60000);
  });

  await suite('模块1: 代理环境变量被彻底清除', async () => {
    const env = { HTTPS_PROXY: 'http://127.0.0.1:7890', HTTP_PROXY: 'http://127.0.0.1:7890', ALL_PROXY: 'socks5://127.0.0.1:1080', PATH: 'C:\\Windows' };
    const removed = netIsolate.scrubProxyEnv(env);
    assert.deepStrictEqual(removed.sort(), ['ALL_PROXY', 'HTTPS_PROXY', 'HTTP_PROXY']);
    assert.strictEqual(env.HTTPS_PROXY, undefined);
    assert.strictEqual(env.PATH, 'C:\\Windows');
    assert.strictEqual(env.NODE_USE_ENV_PROXY, '0');
  });

  await suite('模块3: 识别官方 Sangfor 虚拟网卡（含 family 字符串形式）', async () => {
    const ifaces = {
      '以太网': [{ address: '192.168.30.230', family: 'IPv4', internal: false, netmask: '255.255.255.0', mac: 'x' }],
      'Sangfor SSL VPN CS Support System VNIC': [{ address: '10.66.12.7', family: 'IPv4', internal: false, netmask: '255.255.0.0', mac: 'y' }],
      'Loopback Pseudo-Interface 1': [{ address: '127.0.0.1', family: 'IPv4', internal: true, netmask: '255.0.0.0', mac: 'z' }],
    };
    const found = netIsolate.detectSangforInterface({ namePattern: 'sangfor|easyconnect|vnic', cidrs: [] }, ifaces);
    assert.strictEqual(found.address, '10.66.12.7');
    assert.strictEqual(found.reason, 'name');
    const byCidr = netIsolate.detectSangforInterface({ namePattern: 'nomatch', cidrs: ['10.66.0.0/16'] }, ifaces);
    assert.strictEqual(byCidr.address, '10.66.12.7');
    const none = netIsolate.detectSangforInterface({ namePattern: 'nomatch', cidrs: [] }, ifaces);
    assert.strictEqual(none, null);
    assert.strictEqual(netIsolate.cidrContains('10.66.0.0/16', '10.66.12.7'), true);
    assert.strictEqual(netIsolate.cidrContains('10.67.0.0/16', '10.66.12.7'), false);
  });

  await suite('模块6: retry_after / Retry-After / 无提示三条路径', async () => {
    assert.strictEqual(
      retryLib.parseRetryAfterMs({ bodyText: '{"retry_after_seconds": 28}' }), 28000);
    assert.strictEqual(
      retryLib.parseRetryAfterMs({ bodyText: '{"retry_after_ms": 1500}' }), 1500);
    assert.strictEqual(
      retryLib.parseRetryAfterMs({ headers: { 'retry-after': '7' } }), 7000);
    assert.strictEqual(
      retryLib.parseRetryAfterMs({ headers: { 'retry-after': '7' }, bodyText: 'retry after 9 seconds' }), 9000);
    assert.strictEqual(retryLib.parseRetryAfterMs({ bodyText: 'no hint here' }), undefined);
    const plan = retryLib.planDelay(2, undefined, { hintlessBaseDelayMs: 5000, minDelayMs: 1000, maxDelayMs: 300000 });
    assert.strictEqual(plan.delayMs, 10000);
    assert.strictEqual(plan.source, 'backoff');
    const hinted = retryLib.planDelay(3, 44000, { minDelayMs: 1000, maxDelayMs: 300000 });
    assert.strictEqual(hinted.delayMs, 44000);
    assert.strictEqual(retryLib.isCapacityFailure({ status: 429 }), true);
    assert.strictEqual(retryLib.isCapacityFailure({ status: 200, bodyText: '{"code":"circuit.upstream_capacity_exhausted"}' }), true);
    assert.strictEqual(retryLib.isCapacityFailure({ status: 400, bodyText: '{"error":"bad model"}' }), false);
  });

  await suite('sanitize: 干净 JSON 不会被误杀', async () => {
    const cfg = loadConfig({ packageRoot: root }).sanitize;
    const body = JSON.stringify({ choices: [{ message: { content: '正常回答，含 <code> 与 `x` 符号' } }] });
    assert.strictEqual(sanitize.looksOffCampus(body, cfg), false);
    assert.strictEqual(sanitize.looksLikeHtml(body), false);
    assert.strictEqual(sanitize.looksOffCampus('<html><body>请先登录</body></html>', cfg), true);
  });

  await suite('config: 允许注释、钳制 RPM、缺 key 给出警告', async () => {
    const dir = tempDir('cfg');
    fs.writeFileSync(path.join(dir, 'config.json'), `{
      // 学号
      "studentId": "S1",
      "password": "p",
      "apiKey": "k",
      "rateLimit": { "rpm": 999999 }
    }`, 'utf8');
    const cfg = loadConfig({ packageRoot: dir });
    assert.strictEqual(cfg.studentId, 'S1');
    assert.strictEqual(cfg.rateLimit.rpm, 10000);
    assert.strictEqual(cfg.warnings.length, 0);
    const dir2 = tempDir('cfg2');
    fs.writeFileSync(path.join(dir2, 'config.json'), '{"studentId":""}', 'utf8');
    const cfg2 = loadConfig({ packageRoot: dir2 });
    assert.ok(cfg2.warnings.some((w) => w.includes('apiKey')));
    assert.ok(cfg2.warnings.some((w) => w.includes('studentId')));
  });
  await suite('配置面板: 读值脱敏，保存保留未知字段且拒绝非法值', async () => {
    const admin = require(path.join(root, 'lib/config-admin.js'));
    const dir = tempDir('admin');
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify({
      studentId: 'S1',
      password: 'secret-pw',
      apiKey: 'secret-key',
      custom: { keep: true },
      unknownTop: 42,
    }, null, 2), 'utf8');

    const view = admin.readPanel({ packageRoot: dir });
    assert.strictEqual(view.file, file);
    assert.strictEqual(view.exists, true);
    assert.strictEqual(view.hasPassword, true);
    assert.strictEqual(view.hasApiKey, true);
    const text = JSON.stringify(view);
    assert.ok(!text.includes('secret-pw'), '面板返回值不得含密码明文');
    assert.ok(!text.includes('secret-key'), '面板返回值不得含 API Key 明文');

    const rejected = admin.savePanel({ packageRoot: dir }, { gatewayPort: 'abc', httpBind: '0.0.0.0:11081' });
    assert.strictEqual(rejected.ok, false);
    assert.strictEqual(rejected.errors.length, 2);
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).gatewayPort, undefined, '校验失败不得落盘');

    const saved = admin.savePanel({ packageRoot: dir }, { gatewayPort: '41999', password: '', apiKey: 'new-key', rpm: 12 });
    assert.strictEqual(saved.ok, true);
    assert.deepStrictEqual(saved.changed.sort(), ['apiKey', 'gatewayPort', 'rateLimit']);
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(after.gatewayPort, 41999);
    assert.strictEqual(after.apiKey, 'new-key');
    assert.strictEqual(after.password, 'secret-pw', '空白密码必须保持原值');
    assert.deepStrictEqual(after.custom, { keep: true }, '未知字段必须保留');
    assert.strictEqual(after.unknownTop, 42, '未知顶层字段必须保留');
    assert.strictEqual(after.rateLimit.rpm, 12);

    const dataDir = tempDir('admin-data');
    fs.writeFileSync(path.join(dataDir, 'config.json'), '{"studentId":"FROM_DATA"}', 'utf8');
    assert.strictEqual(admin.resolveTarget({ packageRoot: dir, dataPath: dataDir }).file, path.join(dataDir, 'config.json'), '数据目录优先');
    assert.strictEqual(admin.readPanel({ packageRoot: dir, dataPath: dataDir }).studentId, 'FROM_DATA');
  });

  await suite('配置面板: main.js 暴露 onPanelInvoke 且命令已注册', async () => {
    const plugin = require(path.join(root, 'main.js'));
    assert.strictEqual(typeof plugin.onPanelInvoke, 'function');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
    assert.ok(manifest.permissions.includes('ui.panel'));
    assert.strictEqual(manifest.ui.panel, 'renderer/config.html');
    assert.ok(fs.existsSync(path.join(root, 'renderer', 'config.html')));
  });

  await suite('配置面板: 只认数据目录一份配置，旧文件仅迁移一次', async () => {
    const admin = require(path.join(root, 'lib/config-admin.js'));
    const base = tempDir('single-root');
    const dataDir = tempDir('single-data');
    fs.writeFileSync(path.join(base, 'config.json'), JSON.stringify({ gatewayPort: 41000 }), 'utf8');
    assert.strictEqual(admin.migrateLegacy({ packageRoot: base, dataPath: dataDir }), path.join(dataDir, 'config.json'));
    assert.ok(fs.existsSync(path.join(dataDir, 'config.json')));
    assert.strictEqual(admin.readPanel({ packageRoot: base, dataPath: dataDir }).gatewayPort, 41000);
    fs.writeFileSync(path.join(base, 'config.json'), JSON.stringify({ gatewayPort: 49999 }), 'utf8');
    assert.strictEqual(admin.readPanel({ packageRoot: base, dataPath: dataDir }).gatewayPort, 41000, '迁移后根目录文件不再生效');
    const saved = admin.savePanel({ packageRoot: base, dataPath: dataDir }, { gatewayPort: '42001' });
    assert.strictEqual(saved.ok, true);
    assert.strictEqual(saved.file, path.join(dataDir, 'config.json'));
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')).gatewayPort, 42001);
  });


  await suite('兼容服务: 生成可编辑配置，端口正确且不泄露凭据', async () => {
    const plugin = require(path.join(root, 'main.js'));
    const text = plugin._internals.providerConfigText(41977);
    assert.match(text, /http:\/\/127\.0\.0\.1:41977\/v1/);
    assert.match(text, /Chat Completions/);
    assert.match(text, /无 API Key/);
    assert.ok(!/TEST123|secret|test-key|password/i.test(text), '不得包含凭据');
  });

  await suite('模块2: 隧道默认不启动，参数与闲置关闭正确', async () => {
    const cfg = baseConfig({
      tunnel: { ...baseConfig().tunnel, enabled: true, httpBind: '127.0.0.1:11999', socksBind: '127.0.0.1:11998', idleTimeoutMs: 60000 },
    });
    let spawnCount = 0;
    let portChecks = 0;
    const manager = new TunnelManager({
      packageRoot: root,
      getConfig: () => cfg,
      log: () => {},
      deps: {
        spawn: () => { spawnCount += 1; const { EventEmitter } = require('node:events'); const child = new EventEmitter(); child.pid = 4242; child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); return child; },
        // 第一次是“端口是否已被占用”的预检（必须 false，才会真的拉起进程），
        // 之后是启动就绪轮询（true）。
        waitForPort: async () => { portChecks += 1; return portChecks > 1; },
        connectProbe: async () => true,
        now: () => Date.now(),
      },
    });
    assert.strictEqual(manager.status().state, 'stopped');
    assert.strictEqual(spawnCount, 0, '默认不得启动隧道进程');
    const args = manager.buildArgs();
    assert.ok(args.includes('-protocol') && args.includes('easyconnect'));
    assert.ok(args.includes('-server') && args.includes('v.nuaa.edu.cn'));
    assert.ok(args.includes('-http-bind') && args.includes('127.0.0.1:11999'));
    assert.ok(args.includes('-socks-bind') && args.includes('127.0.0.1:11998'));
    assert.ok(args.includes('-disable-zju-config'));
    assert.ok(args.includes('-skip-domain-resource'));
    assert.ok(args.includes('-remote-dns-server') && args.includes('auto'));
    assert.ok(args.includes('-custom-proxy-domain'), '必须带 -custom-proxy-domain 才会走 RVPN 而非 DIRECT');
    assert.strictEqual(args[args.indexOf('-custom-proxy-domain') + 1], 'token.nuaa.edu.cn', '默认取 baseUrl 的主机名');
    assert.ok(args.includes('-username') && args.includes('TEST123'));
    const ready = await manager.ensureReady('test');
    assert.strictEqual(ready, true);
    assert.strictEqual(spawnCount, 1);
    assert.strictEqual(manager.status().state, 'ready');
    await manager.stop('test');
    assert.strictEqual(manager.status().state, 'stopped');
    manager.disposeIdleTimer();
  });

  await suite('模块2: 闲置超时自动杀进程', async () => {
    let killed = 0;
    let portChecks = 0;
    let nowMs = 1_000_000;
    const cfg = baseConfig({
      tunnel: { ...baseConfig().tunnel, enabled: true, httpBind: '127.0.0.1:11997', socksBind: '127.0.0.1:11996', idleTimeoutMs: 60000 },
    });
    const manager = new TunnelManager({
      packageRoot: root,
      getConfig: () => cfg,
      log: () => {},
      deps: {
        spawn: (cmd) => {
          const { EventEmitter } = require('node:events');
          const child = new EventEmitter();
          child.pid = 5555;
          child.stdout = new EventEmitter();
          child.stderr = new EventEmitter();
          child.kill = () => { killed += 1; };
          if (String(cmd).includes('taskkill')) killed += 1;
          return child;
        },
        waitForPort: async () => { portChecks += 1; return portChecks > 1; },
        connectProbe: async () => true,
        now: () => nowMs,
      },
    });
    manager.armIdleTimer = function patched(intervalMs = 50) {
      this.idleTimer = setInterval(() => {
        if (this.state !== 'ready') return;
        const silentFor = nowMs - (this.lastActivityAt || this.startedAt || 0);
        if (silentFor >= cfg.tunnel.idleTimeoutMs) void this.stop('idle');
      }, intervalMs);
    };
    await manager.ensureReady('idle test');
    assert.strictEqual(manager.status().state, 'ready');
    nowMs += 61_000; // 超过 60s 闲置
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.strictEqual(manager.status().state, 'stopped');
    assert.ok(killed >= 1, 'zju-connect 进程应被结束');
    manager.disposeIdleTimer();
  });

  await suite('浏览客户端: 参数走 nuaa.edu.cn 全站且不 skip 域名资源', async () => {
    const cfg = baseConfig({
      tunnel: { ...baseConfig().tunnel, enabled: true, httpBind: '127.0.0.1:11091', socksBind: '127.0.0.1:11090' },
    });
    const manager = new TunnelManager({
      packageRoot: root,
      getConfig: () => cfg,
      log: () => {},
      overrides: { skipDomainResource: false, domains: ['nuaa.edu.cn'], httpBind: '127.0.0.1:11091', socksBind: '127.0.0.1:11090' },
    });
    const args = manager.buildArgs();
    assert.ok(!args.includes('-skip-domain-resource'), '浏览模式必须关掉 -skip-domain-resource，否则校内其它域名会被判 DIRECT');
    assert.strictEqual(args[args.indexOf('-custom-proxy-domain') + 1], 'nuaa.edu.cn');
    assert.strictEqual(args[args.indexOf('-http-bind') + 1], '127.0.0.1:11091');
    assert.strictEqual(args[args.indexOf('-socks-bind') + 1], '127.0.0.1:11090');
    assert.strictEqual(manager.status().mode, 'browse');
    manager.disposeIdleTimer();

    // API 隧道仍然是旧行为
    const apiManager = new TunnelManager({ packageRoot: root, getConfig: () => cfg, log: () => {} });
    const apiArgs = apiManager.buildArgs();
    assert.ok(apiArgs.includes('-skip-domain-resource'), 'API 隧道必须保持只代理 baseUrl 域名');
    assert.strictEqual(apiArgs[apiArgs.indexOf('-http-bind') + 1], '127.0.0.1:11091');
    apiManager.disposeIdleTimer();
  });

  await suite('网关 /vpn/* 端点：start/status/stop 正确转发给插件', async () => {
    const fake = await createFakeUpstream();
    const calls = [];
    let state = 'stopped';
    const vpn = {
      start: async () => { calls.push('start'); state = 'ready'; return { ok: true, state, pid: 4242, http: '127.0.0.1:11091', socks: '127.0.0.1:11090', domains: ['nuaa.edu.cn'] }; },
      stop: async () => { calls.push('stop'); state = 'stopped'; return { ok: true, state }; },
      status: async () => { calls.push('status'); return { state, pid: state === 'ready' ? 4242 : null, http: '127.0.0.1:11091', socks: '127.0.0.1:11090', domains: ['nuaa.edu.cn'] }; },
    };
    const cfg = baseConfig({ baseUrl: `http://127.0.0.1:${fake.port}/v1` });
    const gateway = createGateway({ getConfig: () => cfg, log: () => {}, tunnel: stubTunnel(false), vpn });
    await gateway.listen([0]);
    const port = gateway.stats.port;

    const started = await request(port, { path: '/vpn/start', method: 'POST', body: {} });
    assert.strictEqual(started.status, 200);
    assert.strictEqual(JSON.parse(started.text).http, '127.0.0.1:11091');

    const status = await request(port, { path: '/vpn/status', method: 'GET' });
    assert.strictEqual(status.status, 200);
    assert.strictEqual(JSON.parse(status.text).state, 'ready');

    const stopped = await request(port, { path: '/vpn/stop', method: 'POST', body: {} });
    assert.strictEqual(stopped.status, 200);
    assert.deepStrictEqual(calls, ['start', 'status', 'stop']);

    gateway.close();
    fake.server.close();
  });

  await suite('模块2: 真实 zju-connect 可执行文件存在且能响应 -version', async () => {
    const exe = path.join(root, 'bin', 'zju-connect.exe');
    assert.ok(fs.existsSync(exe), '请先运行 bin/install-zju-connect.ps1 下载官方 VPN 引擎，再执行完整测试');
    const { execFileSync } = require('node:child_process');
    const out = execFileSync(exe, ['-version'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    assert.ok(/ZJU Connect v/i.test(out), `版本输出异常：${out}`);
  });

  await suite('模块2: 隧道不可用时 ensureReady 返回 false 且记录原因', async () => {
    const cfg = baseConfig({
      tunnel: { ...baseConfig().tunnel, enabled: true, httpBind: '127.0.0.1:11995', socksBind: '127.0.0.1:11994', exePath: 'bin/does-not-exist.exe' },
    });
    const manager = new TunnelManager({ packageRoot: root, getConfig: () => cfg, log: () => {}, deps: { waitForPort: async () => false } });
    const ok = await manager.ensureReady('missing exe');
    assert.strictEqual(ok, false);
    assert.strictEqual(manager.status().state, 'failed');
    assert.ok(manager.status().lastError.includes('找不到'));
    manager.disposeIdleTimer();
  });

  await suite('模块2+1: 自建 CONNECT 隧道 Agent 走本地代理访问真实上游', async () => {
    // 本地 CONNECT 代理：只做 TCP 转发到目标站，用来验证 CONNECT 握手 + TLS 这条链路
    const proxy = net.createServer((client) => {
      let buffer = Buffer.alloc(0);
      const onData = (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        client.removeListener('data', onData);
        const head = buffer.subarray(0, end).toString('latin1');
        const match = /^CONNECT\s+([^\s:]+):(\d+)/i.exec(head);
        if (!match) { client.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
        const upstream = net.connect({ host: match[1], port: Number(match[2]) }, () => {
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          const rest = buffer.subarray(end + 4);
          if (rest.length > 0) upstream.write(rest);
          client.pipe(upstream);
          upstream.pipe(client);
        });
        upstream.on('error', () => client.destroy());
      };
      client.on('data', onData);
      client.on('error', () => {});
    });
    const proxyPort = await new Promise((resolve) => proxy.listen(0, '127.0.0.1', () => resolve(proxy.address().port)));
    const agent = transport.createTunnelAgent({ proxy: { host: '127.0.0.1', port: proxyPort }, connectTimeoutMs: 10000 });
    let probe;
    try {
      probe = await transport.probeEndpoint({ baseUrl: 'https://token.nuaa.edu.cn/v1', apiKey: 'probe-only', timeoutMs: 12000, agent });
    } finally {
      agent.destroy();
      proxy.close();
    }
    if (probe.kind === 'error' && /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT/.test(probe.error || '')) {
      console.log(`        (跳过：当前网络到 token.nuaa.edu.cn 不可达 — ${probe.error})`);
      return;
    }
    // 链路（CONNECT + TLS + HTTP 往返）必须通；回来是 401 JSON（在校内）
    // 还是 483 登录页（在校外）取决于当前网络，两者都证明传输层没问题。
    assert.strictEqual(probe.error, null, `经 CONNECT 隧道应有 HTTP 响应，实际 ${probe.kind}/${probe.error}`);
    if (probe.ok) {
      assert.strictEqual(probe.status, 401, '校内应回 401 JSON');
    } else {
      assert.strictEqual(probe.kind, 'html', `校外应回 HTML 登录/拦截页，实际 ${probe.kind}`);
      console.log('        (当前不在校园网：经隧道拿到 483 拦截页，传输链路正常)');
    }
  });

  await suite('插件: main.js 能在 stub 宿主里加载、启动服务、写状态、卸载', async () => {
    const dataDir = tempDir('plugin');
    const manifestFile = path.join(root, 'manifest.json');
    const manifestBackup = fs.readFileSync(manifestFile, 'utf8');
    const fake = await createFakeUpstream();
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
      studentId: 'TEST123',
      password: 'secret',
      apiKey: 'test-key',
      baseUrl: `http://127.0.0.1:${fake.port}/v1`,
      gatewayPort: 41977,
      tunnel: { enabled: false },
      probe: { timeoutMs: 3000, cacheMs: 0 },
    }, null, 2), 'utf8');

    const registered = { commands: [], services: [] };
    const toasts = [];
    const copied = [];
    globalThis.pi = {
      plugin: { getDataPath: async () => dataDir, getSettings: async () => ({}) },
      commands: {
        register: async (cmd) => { registered.commands.push(cmd); },
        unregister: async (id) => { registered.commands = registered.commands.filter((x) => x.id !== id); },
      },
      services: { register: (service) => { registered.services.push(service); } },
      ui: { showToast: async (message) => { toasts.push(message); } },
      clipboard: { writeText: async (text) => { copied.push(text); } },
      net: { fetch: async () => { throw new Error('不应使用 pi.net.fetch'); } },
    };
    const previousEnv = { HTTPS_PROXY: 'http://127.0.0.1:7890', ALL_PROXY: 'socks5://127.0.0.1:1080' };
    for (const [k, v] of Object.entries(previousEnv)) process.env[k] = v;

    const plugin = require(path.join(root, 'main.js'));
    await plugin.onLoad();
    assert.strictEqual(registered.services.length, 1, '必须注册 background service');
    assert.strictEqual(registered.services[0].id, 'zhixiaohang-gateway');
    assert.deepStrictEqual(registered.commands.map((cmd) => cmd.id).sort(), ['zhixiaohang.campus-vpn-start', 'zhixiaohang.campus-vpn-stop', 'zhixiaohang.config', 'zhixiaohang.probe', 'zhixiaohang.provider-config', 'zhixiaohang.status', 'zhixiaohang.tunnel-stop']);
    assert.strictEqual(process.env.HTTPS_PROXY, undefined, 'onLoad 必须清掉代理变量');
    assert.strictEqual(process.env.ALL_PROXY, undefined);

    const started = await registered.services[0].start({ log: () => {} });
    assert.ok(started.port >= 41977 && started.port <= 41982, `端口应在候选段内，实际 ${started.port}`);

    const health = await request(started.port, { path: '/status', method: 'GET' });
    assert.strictEqual(health.status, 200);
    const snapshot = JSON.parse(health.text);
    assert.strictEqual(snapshot.listening, true);
    assert.strictEqual(snapshot.rateLimit.rpm, 28);
    assert.strictEqual(snapshot.apiKeyPresent, true);
    assert.strictEqual(snapshot.tunnel.state, 'stopped', '默认不得启动隧道');

    const chat = await request(started.port, { path: '/v1/chat/completions', body: { model: 'm', messages: [] } });
    assert.strictEqual(chat.status, 200);
    assert.ok(chat.text.includes('pong'), `应转发成功，实际 ${chat.text.slice(0, 160)}`);

    const statusFile = JSON.parse(fs.readFileSync(path.join(dataDir, 'status.json'), 'utf8'));
    assert.strictEqual(statusFile.snapshot.listening, true);
    assert.ok(Array.isArray(statusFile.proxyEnvRemoved));
    const manifestNow = JSON.parse(manifestBackup);
    assert.strictEqual(manifestNow.contributes.providers, undefined, 'manifest 不应再声明 provider');
    assert.ok(!manifestNow.permissions.includes('provider.register'), '不应再申请 provider.register');
    assert.ok(!manifestNow.permissions.includes('clipboard.write'), '不应要求剪贴板权限');
    assert.ok(manifestNow.permissions.includes('background.service'), '后台服务权限必须保留');

    // 插件不再声明 provider，也不应改写 manifest
    assert.strictEqual(fs.readFileSync(manifestFile, 'utf8'), manifestBackup, '插件不应再改写 manifest');

    const providerCommand = registered.commands.find((cmd) => cmd.id === 'zhixiaohang.provider-config');
    assert.ok(providerCommand, '缺少显示兼容服务配置命令');
    await providerCommand.run();
    assert.strictEqual(copied.length, 1, '有剪贴板权限时应写入一次');
    assert.ok(copied[0].includes(`http://127.0.0.1:${started.port}/v1`), `复制的地址不正确：${copied[0]}`);
    const savedClipboard = globalThis.pi.clipboard;
    delete globalThis.pi.clipboard;
    await providerCommand.run();
    assert.ok(
      toasts.some((message) => message.includes(`http://127.0.0.1:${started.port}/v1`)),
      '没有剪贴板权限时也应显示配置',
    );
    globalThis.pi.clipboard = savedClipboard;

    const status = registered.commands.length;
    assert.strictEqual(status, 7);

    await plugin.onUnload();
    assert.strictEqual(registered.commands.length, 0, '卸载后命令应被注销');
    fake.server.close();
    for (const k of Object.keys(previousEnv)) delete process.env[k];
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n结果: ${results.length - failed.length}/${results.length} 通过`);
  if (failed.length > 0) {
    for (const f of failed) console.log(` - ${f.name}: ${f.error && f.error.stack ? f.error.stack.split('\n').slice(0, 4).join('\n   ') : f.error}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('自测脚本崩溃：', error);
  process.exit(1);
});