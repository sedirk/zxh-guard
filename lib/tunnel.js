'use strict';

/**
 * 模块 2：按需启停的私有 EasyConnect 隧道（zju-connect / EasierConnect 协议）。
 *
 * 设计要点：
 *  - 默认不启动任何进程；只有网关判定“不在校园网”时才 ensureReady()。
 *  - 只在 127.0.0.1 上开 SOCKS5(11080) / HTTP(11081)，不建虚拟网卡、不改系统路由表，
 *    因此不会污染日常流量。
 *  - 闲置 idleTimeoutMs（默认 20 分钟）无请求后自动 kill，平时完全不挂 VPN。
 */

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { cleanChildEnv } = require('./net-isolate');
const { waitForPort, parseBind } = require('./transport');

const STDERR_RING = 40;

function tail(lines) {
  return lines.filter(Boolean).slice(-STDERR_RING).join('\n');
}

/** 向本地 HTTP 代理发一个 CONNECT，判断 RVPN 是否真的能转发（端口 listening 不代表会话就绪）。 */
function connectProbe(proxyHost, proxyPort, targetHost, targetPort = 443, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: proxyHost, port: proxyPort });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('error', () => finish(false));
    socket.once('connect', () => {
      socket.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`);
    });
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) {
        if (buffer.length > 8192) finish(false);
        return;
      }
      const head = buffer.subarray(0, end).toString('latin1');
      const matched = /^HTTP\/1\.[01]\s+(\d{3})/i.exec(head.trim());
      finish(Boolean(matched) && Number(matched[1]) / 100 === 2);
    });
  });
}

class TunnelManager {
  /**
   * @param {object} options
   * @param {() => object} options.getConfig 返回最新 config（热重载后仍读新值）
   * @param {(message: string) => void} [options.log]
   * @param {object} [options.deps] 测试注入：{ spawn, waitForPort, now }
   */
  constructor(options) {
    this.getConfig = options.getConfig;
    this.log = typeof options.log === 'function' ? options.log : () => {};
    this.root = options.packageRoot;
    this.deps = options.deps || {};
    // 浏览客户端复用同一个管理器，但换端口/换域名策略（不 skip 域名资源，走 nuaa.edu.cn 全站）
    this.overrides = options.overrides || null;
    // 就绪探针用的主机：裸域（如 nuaa.edu.cn）常常没有 A 记录，会让 zju-connect 解析器 panic
    this.probeHost = options.probeHost || null;
    this.spawnImpl = this.deps.spawn || spawn;
    this.waitForPort = this.deps.waitForPort || waitForPort;
    this.connectProbeImpl = this.deps.connectProbe || connectProbe;
    this.now = this.deps.now || (() => Date.now());

    this.state = 'stopped'; // stopped | starting | ready | failed
    this.external = false;
    this.child = null;
    this.stderrLines = [];
    this.lastError = '';
    this.startedAt = 0;
    this.lastActivityAt = 0;
    this.startAttempts = 0;
    // 外部隧道探活的时间戳（undefined 表示还没探过，第一次会立刻探）
    this.lastExternalCheckAt = 0;
    this.startPromise = null;
    this.idleTimer = null;
  }

  config() {
    const base = this.getConfig().tunnel;
    if (!this.overrides) return base;
    return {
      ...base,
      ...this.overrides,
      proxyDomains: Array.isArray(this.overrides.domains) ? this.overrides.domains : base.proxyDomains,
    };
  }

  bindings() {
    const cfg = this.config();
    return {
      http: parseBind(cfg.httpBind, '127.0.0.1'),
      socks: parseBind(cfg.socksBind, '127.0.0.1'),
    };
  }

  exePath() {
    const cfg = this.config();
    const resolved = path.isAbsolute(cfg.exePath) ? cfg.exePath : path.join(this.root, cfg.exePath);
    return resolved;
  }


  status() {
    const bindings = this.bindings();
    return {
      state: this.state,
      external: this.external,
      pid: this.child ? this.child.pid : null,
      httpProxy: bindings.http,
      socksProxy: bindings.socks,
      startedAt: this.startedAt,
      lastActivityAt: this.lastActivityAt,
      idleTimeoutMs: this.config().idleTimeoutMs,
      mode: this.overrides ? 'browse' : 'api',
      domains: this.proxyDomains(),
      startAttempts: this.startAttempts,
      lastError: this.lastError,
      stderrTail: tail(this.stderrLines),
    };
  }

  /** 记录一次“本插件还要用隧道”的活动，重置闲置计时。 */
  touch() {
    this.lastActivityAt = this.now();
    if (this.state === 'ready') this.armIdleTimer();
  }

  ready() {
    return this.state === 'ready';
  }

  /** 用 CONNECT 探针确认隧道可用（默认 15s 内轮询）。 */
  async verifyTunnel(timeoutMs = 15000) {
    // 注意：不要用 CONNECT 去探目标域名。这个 zju-connect 构建的远端 DNS 解析器
    // 在解析某些名字（例如 API 主机）时会 panic，一崩就会连累正在浏览的会话。
    // 端口起来后再等一小段，让 VPN 会话就绪即可。
    if (typeof this.deps.connectProbe === 'function') {
      const domains = this.proxyDomains();
      if (domains.length === 0) return true;
      const { http } = this.bindings();
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const target = this.probeHost || domains[0];
        const ok = await this.deps.connectProbe(http.host, http.port, target, 443, 4000);
        if (ok) return true;
        if (Date.now() >= deadline) return false;
        await new Promise((resolve) => { const t = setTimeout(resolve, 700); if (t.unref) t.unref(); });
      }
    }
    await new Promise((resolve) => { const t = setTimeout(resolve, 1500); if (t.unref) t.unref(); });
    return true;
  }

  /** zju-connect 的 HTTP 代理默认会把目标域名判成 DIRECT（校外就连不上）；
   *  必须显式 -custom-proxy-domain 才能强制走 RVPN 隧道。默认取 baseUrl 的主机名。 */
  proxyDomains() {
    const cfg = this.config();
    if (Array.isArray(cfg.proxyDomains) && cfg.proxyDomains.length > 0) {
      return cfg.proxyDomains.filter((d) => typeof d === 'string' && d.length > 0);
    }
    try { return [new URL(this.getConfig().baseUrl).hostname]; } catch { return []; }
  }

  /** zju-connect 的命令行参数（顺序与官方 README 一致）。 */
  buildArgs() {
    const cfg = this.config();
    const args = [
      '-protocol', cfg.protocol,
      '-server', cfg.server,
      '-port', String(cfg.port),
      '-username', this.getConfig().studentId || '',
      '-password', this.getConfig().password || '',
      '-disable-zju-config',
      ...(cfg.skipDomainResource === false ? [] : ['-skip-domain-resource']),
      '-remote-dns-server', 'auto',
      '-http-bind', cfg.httpBind,
      '-socks-bind', cfg.socksBind,
    ];
    for (const domain of this.proxyDomains()) args.push('-custom-proxy-domain', domain);
    if (cfg.bindInterface) args.push('-bind-interface', cfg.bindInterface);
    if (Array.isArray(cfg.extraArgs)) args.push(...cfg.extraArgs);
    return args;
  }
  /** 闲置计时器：idleTimeoutMs 内没有任何隧道请求就自动关掉进程。 */
  armIdleTimer() {
    const idle = Math.max(60_000, Number(this.config().idleTimeoutMs) || 1_200_000);
    if (this.idleTimer) clearInterval(this.idleTimer);
    const interval = Math.max(5_000, Math.min(30_000, Math.floor(idle / 8)));
    this.idleTimer = setInterval(() => {
      if (this.state !== 'ready') return;
      const silentFor = this.now() - (this.lastActivityAt || this.startedAt || 0);
      if (silentFor >= idle) {
        this.log(`tunnel idle for ${Math.round(silentFor / 1000)}s — closing private tunnel`);
        void this.stop('idle');
      }
    }, interval);
    if (typeof this.idleTimer.unref === 'function') this.idleTimer.unref();
  }

  disposeIdleTimer() {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /**
   * 确保隧道可用（并发调用共享同一次启动）。
   *
   * 复用「用户自己的 zju-connect」（external=true）时没有子进程可监听 exit：
   * 一旦那个进程被关掉或掉线，state 会一直停在 ready，网关就会一直往死端口发包。
   * 所以外部隧道要按间隔探一次端口（默认 30s，见 tunnel.externalCheckMs），
   * 探不到就降级为「自己拉起」——start() 里的预检仍会优先复用刚恢复的外部隧道。
   * @returns {Promise<boolean>}
   */
  async ensureReady(reason = '') {
    if (this.state === 'ready') {
      this.touch();
      if (!this.external || await this.externalHealthy()) return true;
      this.log('external tunnel is gone — starting our own');
      this.external = false;
      this.state = 'stopped';
    }
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.start(reason).finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  /** 外部隧道的端口探活（带节流，避免每个请求都探）。 */
  async externalHealthy() {
    const cfg = this.config();
    const interval = Number(cfg.externalCheckMs) > 0 ? Number(cfg.externalCheckMs) : 30_000;
    if (this.lastExternalCheckAt && this.now() - this.lastExternalCheckAt < interval) return true;
    const { http } = this.bindings();
    const ok = await this.waitForPort(http.host, http.port, { timeoutMs: 800 });
    this.lastExternalCheckAt = this.now();
    return ok;
  }

  async start(reason = '') {
    const cfg = this.config();
    if (!cfg.enabled) {
      this.lastError = 'tunnel.enabled=false';
      return false;
    }
    const bindings = this.bindings();

    // 同一学号只允许一条 EasyConnect 会话：如果托盘的校园客户端正在登录，
    // 先等它把端口开出来，然后复用它，绝不抢先登录（否则两方互踢）。
    const marker = path.join(os.tmpdir(), 'nuaa-campus-vpn.starting');
    if (fs.existsSync(marker)) {
      const ageMs = Date.now() - fs.statSync(marker).mtimeMs;
      if (ageMs < 60_000) {
        this.log('campus client is logging in — waiting for its tunnel instead of a second login');
        await this.waitForPort(bindings.http.host, bindings.http.port, { timeoutMs: cfg.startTimeoutMs });
      }
    }

    // 端口已经有人监听：可能用户自己开了 zju-connect，直接复用，绝不重复拉起。
    const alreadyUp = await this.waitForPort(bindings.http.host, bindings.http.port, { timeoutMs: 800 });
    if (alreadyUp) {
      this.state = 'ready';
      this.external = true;
      this.startedAt = this.now();
      this.lastActivityAt = this.now();
      // 刚确认过端口在监听，节流从此刻算起
      this.lastExternalCheckAt = this.now();
      this.lastError = '';
      this.log(`tunnel already listening on ${bindings.http.host}:${bindings.http.port} — reusing it`);
      this.armIdleTimer();
      return true;
    }

    if (!this.getConfig().studentId || !this.getConfig().password) {
      this.state = 'failed';
      this.lastError = '缺少 studentId/password，无法登录 EasyConnect';
      this.log(this.lastError);
      return false;
    }

    const exe = this.exePath();
    if (!fs.existsSync(exe)) {
      this.state = 'failed';
      this.lastError = `找不到 zju-connect 可执行文件：${exe}`;
      this.log(this.lastError);
      return false;
    }

    this.state = 'starting';
    this.external = false;
    this.startAttempts += 1;
    this.stderrLines = [];
    const args = this.buildArgs();
    this.log(`starting zju-connect (${reason || 'on demand'}): ${path.basename(exe)} -server ${cfg.server} -http-bind ${cfg.httpBind}`);

    let child;
    try {
      child = this.spawnImpl(exe, args, {
        cwd: path.dirname(exe),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: cleanChildEnv(),
      });
    } catch (error) {
      this.state = 'failed';
      this.lastError = `无法启动 zju-connect：${error && error.message}`;
      this.log(this.lastError);
      return false;
    }
    this.child = child;
    this.startedAt = this.now();
    this.lastActivityAt = this.now();

    const collect = (chunk) => {
      const text = String(chunk);
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        this.stderrLines.push(trimmed);
        if (this.stderrLines.length > STDERR_RING) this.stderrLines.shift();
      }
    };
    if (child.stdout) child.stdout.on('data', collect);
    if (child.stderr) child.stderr.on('data', collect);
    const exitedEarly = new Promise((resolve) => {
      child.once('exit', () => resolve(false));
    });
    child.once('exit', (code, signal) => {
      const wasReady = this.state === 'ready' || this.state === 'starting';
      this.child = null;
      this.disposeIdleTimer();
      if (this.state !== 'stopped') {
        this.state = 'failed';
        this.lastError = `zju-connect 退出（code=${code} signal=${signal || ''}）${this.stderrLines.length ? `：${tail(this.stderrLines).slice(-400)}` : ''}`;
        if (wasReady) this.log(this.lastError);
      }
    });

    // 进程如果先自己退了（常见于密码错/服务端不可达），不必干等到 startTimeoutMs。
    const ready = await Promise.race([
      this.waitForPort(bindings.http.host, bindings.http.port, {
        timeoutMs: cfg.startTimeoutMs,
        intervalMs: 300,
      }),
      exitedEarly,
    ]);
    if (!ready) {
      this.lastError = `隧道未在 ${Math.round(cfg.startTimeoutMs / 1000)}s 内就绪`
        + (this.stderrLines.length ? `：${tail(this.stderrLines).slice(-400)}` : '');
      this.log(this.lastError);
      await this.stop('start-timeout');
      this.state = 'failed';
      return false;
    }

    // 端口 listening 只说明 HTTP 代理起来了；VPN 会话/域名路由还要几百毫秒。
    // 不补这一步，第一个真实请求常会撞上 ECONNRESET。
    const verified = await this.verifyTunnel(cfg.startTimeoutMs);
    if (!verified) {
      this.lastError = `隧道端口已起，但 ${Math.round(cfg.startTimeoutMs / 1000)}s 内无法通过它访问 ${this.probeHost || this.proxyDomains()[0] || '目标域名'}`
        + (this.stderrLines.length ? `：${tail(this.stderrLines).slice(-300)}` : '');
      this.log(this.lastError);
      await this.stop('verify-failed');
      this.state = 'failed';
      return false;
    }

    this.state = 'ready';
    this.lastError = '';
    this.lastActivityAt = this.now();
    this.armIdleTimer();
    this.log(`tunnel ready on ${bindings.http.host}:${bindings.http.port}`);
    return true;
  }

  /** 结束 zju-connect：Windows 用 taskkill /T /F 连子进程一起清掉。 */
  async stop(reason = 'manual') {
    this.disposeIdleTimer();
    const child = this.child;
    const wasExternal = this.external;
    this.child = null;
    this.external = false;
    if (child && child.pid) {
      this.log(`stopping zju-connect (${reason}) pid=${child.pid}`);
      try {
        if (process.platform === 'win32') {
          const killer = this.spawnImpl('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          });
          killer.on('error', () => { try { child.kill(); } catch { /* ignore */ } });
        } else {
          child.kill('SIGTERM');
        }
      } catch {
        try { child.kill(); } catch { /* ignore */ }
      }
    } else if (!wasExternal) {
      this.log(`stop requested (${reason}) but no tunnel process is owned by this plugin`);
    } else {
      this.log(`tunnel was external (not started by this plugin) — leaving it alone`);
    }
    if (this.state !== 'failed') this.state = 'stopped';
    return true;
  }
}

module.exports = { TunnelManager };