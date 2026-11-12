'use strict';

const assert = require('node:assert');
const path = require('node:path');
const { createGateway } = require('../lib/gateway');

async function main() {
  console.log('zxh-guard CORS 与 413 回归自测');

  const gw = createGateway({
    config: () => ({
      baseUrl: 'http://127.0.0.1:18888',
      apiKey: 'test-key',
      rateLimit: { rpm: 28, windowMs: 60000 },
      sanitize: { enabled: true, notice: 'sanitized' },
      retry: { emptyStreamRetries: 0, minDelayMs: 10 },
      probe: { timeoutMs: 100 },
      tunnel: { enabled: false },
    }),
    log: () => {},
  });

  const port = await gw.listen([0]);
  console.log('Listening on port:', port);

  try {
    // 1. OPTIONS 预检请求测试
    const optRes = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'OPTIONS' });
    assert.strictEqual(optRes.status, 204, 'OPTIONS 应快速返回 204');
    assert.strictEqual(optRes.headers.get('access-control-allow-origin'), '*');
    assert.ok(optRes.headers.get('access-control-allow-methods').includes('POST'));
    console.log('PASS OPTIONS 预检请求');

    // 2. GET /health 带有 CORS
    const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
    assert.strictEqual(healthRes.status, 200);
    assert.strictEqual(healthRes.headers.get('access-control-allow-origin'), '*');
    console.log('PASS GET /health CORS 头');

    // 3. 超限请求 (> 32MB) 优雅返回 413
    const hugeBody = 'x'.repeat(32 * 1024 * 1024 + 1024);
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: hugeBody,
    });
    assert.strictEqual(res.status, 413, '超限请求必须返回 413');
    const json = await res.json();
    assert.strictEqual(json.error.code, 'payload_too_large');
    console.log('PASS 超限请求返回 HTTP 413');
  } finally {
    gw.close();
  }

  console.log('zxh-guard 新增功能测试全部通过！');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
