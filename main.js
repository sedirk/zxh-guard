'use strict';

/**
 * PI-Desktop 插件入口：南航智小航专属本地守护网关。
 *
 * 启动顺序：
 *   1. 清掉进程内所有 *_proxy 环境变量（模块 1）
 *   2. 读 config.json，建隧道管理器（默认不启动进程，模块 2）
 *   3. 起 127.0.0.1 本地网关，把 6 个模块串成一条链路
 *   4. 不声明插件 provider；由用户用命令显示可编辑兼容服务配置
 */

const fs = require('node:fs');
const path = require('node:path');

const { loadConfig } = require('./lib/config');
const { scrubProxyEnv, detectSangforInterface } = require('./lib/net-isolate');
const { TunnelManager } = require('./lib/tunnel');
const { createGateway } = require('./lib/gateway');
const transport = require('./lib/transport');

const SERVICE_ID = 'zhixiaohang-gateway';
const COMMANDS = {
  status: 'zhixiaohang.status',
  probe: 'zhixiaohang.probe',
  providerConfig: 'zhixiaohang.provider-config',
  tunnelStop: 'zhixiaohang.tunnel-stop',
  vpnStart: 'zhixiaohang.campus-vpn-start',
  vpnStop: 'zhixiaohang.campus-vpn-stop',
};

let pi = null;
let packageRoot = __dirname;
let dataPath = '';
let config = null;
let tunnel = null;
let browseTunnel = null;
let gateway = null;
let log = () => {};
let proxyEnvRemoved = [];

function writeLogLine(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  try { console.log(`[zhixiaohang-guard] ${message}`); } catch { /* console 可能不可用 */ }
  if (!dataPath) return;
  try {
    fs.mkdirSync(dataPath, { recursive: true });
    fs.appendFileSync(path.join(dataPath, 'gateway.log'), `${line}\n`, 'utf8');
  } catch { /* 日志失败不影响主流程 */ }
}

function writeStatusFile() {
  if (!dataPath) return;
  try {
    fs.mkdirSync(dataPath, { recursive: true });
    const snapshot = gateway ? gateway.statusSnapshot() : { phase: 'not-started' };
    fs.writeFileSync(
      path.join(dataPath, 'status.json'),
      JSON.stringify({
        mountedAt: new Date().toISOString(),
        pid: process.pid,
        module: __filename,
        proxyEnvRemoved,
        configSource: config ? config.source : null,
        warnings: config ? config.warnings : [],
        snapshot,
      }, null, 2),
      'utf8',
    );
  } catch { /* ignore */ }
}

function reloadConfig() {
  config = loadConfig({ packageRoot, dataPath, logger: log });
  for (const warning of config.warnings) log(`config: ${warning}`);
  return config;
}

async function toast(message, kind = 'info') {
  try {
    if (pi && pi.ui && typeof pi.ui.showToast === 'function') {
      await pi.ui.showToast(message, kind);
      return;
    }
  } catch { /* fall through */ }
  log(message);
}


// --------------------------------------------------------------------------
// 服务生命周期
// --------------------------------------------------------------------------

/**
 * 浏览客户端使用独立端口，绝不能占用 campusClient.httpBind：
 * 那是独立托盘/校园客户端自己的隧道端口，冲突会导致两者互相判为 external。
 */
function browseSettings() {
  const cc = (config && config.campusClient) || {};
  const domains = Array.isArray(cc.domains) && cc.domains.length > 0 ? cc.domains : ['nuaa.edu.cn'];
  return {
    httpBind: '127.0.0.1:11091',
    socksBind: '127.0.0.1:11090',
    domains,
    probeHost: cc.probeHost || `www.${domains[0]}`,
    // 浏览模式保持 8 小时长闲置，不受校园客户端 20 分钟闲置设置影响。
    idleTimeoutMs: 8 * 3600 * 1000,
    startTimeoutMs: 30_000,
  };
}

function getBrowseTunnel() {
  if (browseTunnel) return browseTunnel;
  const b = browseSettings();
  browseTunnel = new TunnelManager({
    packageRoot,
    getConfig: () => config,
    log,
    probeHost: b.probeHost,
    overrides: {
      enabled: !(config && config.campusClient && config.campusClient.enabled === false),
      skipDomainResource: false,   // 浏览模式：让 nuaa.edu.cn 全站走 RVPN
      domains: b.domains,
      httpBind: b.httpBind,
      socksBind: b.socksBind,
      idleTimeoutMs: b.idleTimeoutMs,
      startTimeoutMs: b.startTimeoutMs,
    },
  });
  return browseTunnel;
}

async function startCampusVpn() {
  const b = browseSettings();
  const manager = getBrowseTunnel();
  const ok = await manager.ensureReady('campus browse');
  const status = manager.status();
  if (ok) log(`campus vpn ready: http=${b.httpBind} socks=${b.socksBind} domains=${b.domains.join(',')}`);
  return {
    ok,
    http: b.httpBind,
    socks: b.socksBind,
    domains: b.domains,
    pid: status.pid,
    state: status.state,
    lastError: status.lastError,
  };
}

async function stopCampusVpn() {
  if (!browseTunnel) return { ok: true, state: 'stopped' };
  await browseTunnel.stop('user');
  return { ok: true, state: browseTunnel.status().state };
}

/**
 * PAC：校内域名走校园隧道。代理列表同时包含
 *   1) 独立托盘/校园客户端端口（campusClient.httpBind，默认 11081）
 *   2) 插件浏览客户端端口（11091）
 * 这样无论哪条隧道在跑，PAC 都能命中；此前只写 11091，浏览器会连到未监听的端口。
 */
function campusVpnPac() {
  const b = browseSettings();
  const cc = (config && config.campusClient) || {};
  const campusHttp = cc.httpBind || '127.0.0.1:11081';
  const campusSocks = cc.socksBind || '127.0.0.1:11080';
  const proxy = [
    `PROXY ${campusHttp}`,
    `PROXY ${b.httpBind}`,
    `SOCKS5 ${campusSocks}`,
    `SOCKS5 ${b.socksBind}`,
    `SOCKS ${campusSocks}`,
    `SOCKS ${b.socksBind}`,
  ].join('; ');
  const rules = b.domains
    .map((d) => `  if (host === "${d}" || dnsDomainIs(host, ".${d}")) return PROXY;`)
    .join('\n');
  return [
    '// generated by local.zhixiaohang-guard (campus VPN)',
    `var PROXY = "${proxy}";`,
    'function FindProxyForURL(url, host) {',
    '  if (isPlainHostName(host) || host === "127.0.0.1" || host === "localhost") return "DIRECT";',
    rules,
    // 校园网 IPv6 只能在隧道内访问；IPv6 字面量不能落 DIRECT，否则浏览器会直连 AAAA。
    '  if (host.indexOf(":") !== -1) return PROXY;',
    '  return "DIRECT";',
    '}',
    '',
  ].join('\n');
}

/** 只停插件自己那条「仅代理 API」的隧道，让校园客户端接管单一会话。 */
async function stopApiTunnel() {
  const before = tunnel ? tunnel.status().state : 'stopped';
  if (tunnel) await tunnel.stop('campus client takeover');
  log(`api tunnel stopped for takeover (was ${before})`);
  return { ok: true, state: tunnel ? tunnel.status().state : 'stopped' };
}

async function campusVpnStatus() {
  const b = browseSettings();
  const status = browseTunnel ? browseTunnel.status() : null;
  if (status) browseTunnel.touch();
  return {
    state: status ? status.state : 'stopped',
    pid: status ? status.pid : null,
    http: b.httpBind,
    socks: b.socksBind,
    domains: b.domains,
    idleTimeoutMs: b.idleTimeoutMs,
    lastError: status ? status.lastError : '',
  };
}

async function startService({ log: providedLog } = {}) {
  if (typeof providedLog === 'function') log = (message) => { providedLog(message); writeLogLine(message); };
  reloadConfig();

  tunnel = tunnel || new TunnelManager({
    packageRoot,
    getConfig: () => config,
    log,
  });

  gateway = createGateway({
    getConfig: () => config,
    log,
    tunnel,
    vpn: { start: startCampusVpn, stop: stopCampusVpn, status: campusVpnStatus, pac: campusVpnPac, stopApiTunnel },
  });

  const base = config.gatewayPort;
  const candidates = [base, base + 1, base + 2, base + 3, base + 4];
  const port = await gateway.listen(candidates);
  writeStatusFile();

  return { port };
}

function stopService() {
  if (browseTunnel) void browseTunnel.stop('plugin unload');
  if (tunnel) void tunnel.stop('plugin unload');
  if (gateway) gateway.close();
  gateway = null;
  tunnel = null;
  browseTunnel = null;
  writeStatusFile();
}

// --------------------------------------------------------------------------
// 命令
// --------------------------------------------------------------------------

function describeRoute() {
  if (!gateway) return '网关未启动';
  const snapshot = gateway.statusSnapshot();
  const route = snapshot.lastRoute || '未判定';
  const nic = snapshot.vpnInterface ? `官方网卡 ${snapshot.vpnInterface.name}/${snapshot.vpnInterface.address}` : '未检测到官方 EasyConnect 网卡';
  const probe = snapshot.lastProbe
    ? `探测 ${snapshot.lastProbe.ok ? '直连可达' : snapshot.lastProbe.kind}${snapshot.lastProbe.status ? ` (${snapshot.lastProbe.status})` : ''}`
    : '尚未探测';
  return `${route} · ${probe} · ${nic}`;
}
function providerConfigText(port) {
  let livePort = 0;
  try {
    if (gateway && typeof gateway.statusSnapshot === 'function') {
      livePort = Number(gateway.statusSnapshot().port) || 0;
    }
  } catch { /* 网关未启动时使用配置端口 */ }
  const explicit = Number(port) > 0 ? Number(port) : 0;
  const configured = config && Number(config.gatewayPort) > 0 ? Number(config.gatewayPort) : 41900;
  const chosen = explicit || livePort || configured;
  return [
    'PI-Desktop 可编辑兼容服务',
    '名称: 智小航（可编辑）',
    `Base URL: http://127.0.0.1:${chosen}/v1`,
    'API 风格: Chat Completions',
    '认证: 无 API Key（留空/免密钥）',
    '模型示例: deepseek-flash, deepseek-v4.1-flash, glm-5.3, kimi-k3',
    '',
    '设置 → AI 服务 → 添加服务 → 自定义端点；粘贴 Base URL，认证留空，然后获取模型列表。',
    '模型高级里可改上下文窗口、最大输出、推理档位和“发送 reasoning_effort”。',
    '插件不再提供只读模型；若仍看到旧的“南航智小航”，请停用它。',
  ].join('\n');
}

function registerCommands() {
  pi.commands.register({
    id: COMMANDS.status,
    title: '智小航: 显示网关状态',
    category: 'AI',
    keywords: ['zhixiaohang', '智小航', '状态', 'status'],
    run: async () => {
      if (!gateway) { await toast('智小航: 网关未启动', 'warning'); return; }
      const snapshot = gateway.statusSnapshot();
      const t = snapshot.tunnel || {};
      await toast(
        `智小航网关 127.0.0.1:${snapshot.port} · 限流 ${snapshot.rateLimit.rpm}RPM（排队 ${snapshot.rateLimit.waiting}）\n`
        + `隧道 ${t.state}${t.pid ? ` (pid ${t.pid})` : ''}${t.external ? ' [复用外部实例]' : ''} · 闲置 ${Math.round((t.idleTimeoutMs || 0) / 60000)} 分钟自动关闭\n`
        + `${describeRoute()}\n`
        + `请求 ${snapshot.counters.requests} · 净化 ${snapshot.counters.sanitized} · 429 重试 ${snapshot.counters.retries429} · 空流重试 ${snapshot.counters.emptyStreamRetries}\n`
        + `代理环境变量已清除 ${proxyEnvRemoved.length} 个${snapshot.apiKeyPresent ? '' : ' · apiKey 未填写'}`
        + `${snapshot.lastError ? `\n最近错误: ${String(snapshot.lastError).slice(0, 160)}` : ''}`,
        snapshot.apiKeyPresent ? 'info' : 'warning',
      );
    },
  });

  pi.commands.register({
    id: COMMANDS.probe,
    title: '智小航: 网络探测诊断',
    category: 'AI',
    keywords: ['zhixiaohang', '智小航', '探测', 'probe', '诊断'],
    run: async () => {
      if (!gateway) { await toast('智小航: 网关未启动', 'warning'); return; }
      gateway.resetAgents();
      const nic = detectSangforInterface(config.vpnInterface);
      const direct = await transport.probeEndpoint({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        timeoutMs: config.probe.timeoutMs,
        agent: transport.createDirectAgent({ localAddress: nic ? nic.address : null }),
      });
      let tunnelLine = '未启用';
      if (config.tunnel.enabled) {
        const ok = await tunnel.ensureReady('diagnostic command');
        tunnelLine = ok ? '已就绪' : `启动失败（${tunnel.status().lastError.slice(0, 120)}）`;
      }
      await toast(
        `智小航诊断\n`
        + `代理环境变量: 已清除 ${proxyEnvRemoved.length} 个${proxyEnvRemoved.length ? `（${proxyEnvRemoved.join(', ')}）` : ''}\n`
        + `直连探测: ${direct.ok ? 'JSON 可达' : direct.kind}${direct.error ? ` (${direct.error})` : ''} · ${direct.elapsedMs}ms\n`
        + `官方网卡: ${nic ? `${nic.name} → ${nic.address}` : '未检测到'}\n`
        + `私有隧道: ${tunnelLine}${config.tunnel.enabled ? '' : '（tunnel.enabled=false）'}`,
        direct.ok ? 'info' : 'warning',
      );
    },
  });

  pi.commands.register({
    id: COMMANDS.providerConfig,
    title: '智小航: 显示可编辑兼容服务配置',
    category: 'AI',
    keywords: ['zhixiaohang', '智小航', 'provider', '服务', '模型', '上下文', '推理'],
    run: async () => {
      const text = providerConfigText();
      try {
        if (!pi.clipboard || typeof pi.clipboard.writeText !== 'function') {
          throw new Error('clipboard unavailable');
        }
        await pi.clipboard.writeText(text);
        await toast(
          '智小航: 已复制兼容服务配置。请在 设置 → AI 服务 → 添加服务 → 自定义端点 中粘贴，认证留空。',
          'info',
        );
      } catch (error) {
        log(`显示兼容服务配置：剪贴板不可用（${(error && error.message) || 'unknown'}）`);
        await toast('智小航: 剪贴板不可用，配置如下。', 'warning');
        await toast(text.replace(/\n/g, ' | '), 'info');
      }
    },
  });

  pi.commands.register({
    id: COMMANDS.vpnStart,
    title: '智小航: 启动校内 VPN（浏览客户端）',
    category: 'AI',
    keywords: ['zhixiaohang', '智小航', 'vpn', '校内', '浏览', '代理'],
    run: async () => {
      const started = await startCampusVpn();
      if (!started.ok) {
        await toast(`智小航: 校内 VPN 启动失败（${String(started.lastError || '').slice(0, 120)}）`, 'warning');
        return;
      }
      await toast(
        `智小航: 校内 VPN 已就绪（独立进程 pid ${started.pid}）\n`
        + `HTTP 代理 ${started.http} · SOCKS5 ${started.socks}\n`
        + `覆盖 ${started.domains.join(', ')} 及其子域；API 隧道仍只代理 token.nuaa.edu.cn`,
        'info',
      );
    },
  });

  pi.commands.register({
    id: COMMANDS.vpnStop,
    title: '智小航: 关闭校内 VPN（浏览客户端）',
    category: 'AI',
    keywords: ['zhixiaohang', '智小航', 'vpn', '关闭', '代理'],
    run: async () => {
      await stopCampusVpn();
      await toast('智小航: 校内 VPN 浏览客户端已关闭（API 隧道不受影响）', 'info');
    },
  });

  pi.commands.register({
    id: COMMANDS.tunnelStop,
    title: '智小航: 立即关闭私有隧道',
    category: 'AI',
    keywords: ['zhixiaohang', '智小航', '隧道', 'tunnel'],
    run: async () => {
      if (!tunnel) { await toast('智小航: 隧道未初始化', 'warning'); return; }
      await tunnel.stop('manual command');
      await toast('智小航: 私有隧道已关闭（下一次校外请求会自动重新拉起）', 'info');
    },
  });
}

function unregisterCommands() {
  for (const id of Object.values(COMMANDS)) {
    try { pi.commands.unregister(id); } catch { /* 宿主可能已经清理 */ }
  }
}

// --------------------------------------------------------------------------
// 生命周期
// --------------------------------------------------------------------------

module.exports = {
  async onLoad() {
    pi = globalThis.pi;
    if (!pi) throw new Error('宿主 plugin API 不可用：onLoad 之前应当存在全局 pi');
    packageRoot = __dirname;
    log = writeLogLine;

    // 模块 1：进程内彻底清除代理环境变量
    proxyEnvRemoved = scrubProxyEnv();
    log(proxyEnvRemoved.length
      ? `已清除代理环境变量：${proxyEnvRemoved.join(', ')}（本插件流量不再经过系统代理）`
      : '进程环境里没有代理变量；出站请求仍固定自建 Agent，绝不读系统代理');

    try {
      if (pi.plugin && typeof pi.plugin.getDataPath === 'function') {
        dataPath = await pi.plugin.getDataPath();
        if (dataPath) fs.mkdirSync(dataPath, { recursive: true });
      }
    } catch { dataPath = ''; }

    reloadConfig();

    pi.services.register({
      id: SERVICE_ID,
      start: (context) => startService(context),
      stop: () => stopService(),
    });

    registerCommands();
    writeStatusFile();
    log(`loaded · config=${config.source} · gatewayPort=${config.gatewayPort} · rpm=${config.rateLimit.rpm} · tunnel=${config.tunnel.enabled ? 'on-demand' : 'off'}`);

    log('provider 声明已移除；用命令“显示可编辑兼容服务配置”在 PI-Desktop 中手动添加普通兼容服务');
  },

  async onUnload() {
    try { unregisterCommands(); } catch { /* ignore */ }
    stopService();
  },

  /** 测试钩子（不属于宿主契约）。 */
  _internals: {
    get config() { return config; },
    get gateway() { return gateway; },
    get tunnel() { return tunnel; },
    get proxyEnvRemoved() { return proxyEnvRemoved; },
    setGateway: (value) => { gateway = value; },
    setTunnel: (value) => { tunnel = value; },
    setConfig: (value) => { config = value; },
    setDataPath: (value) => { dataPath = value; },
    reloadConfig,
    providerConfigText,
    startService,
    stopService,
    registerCommands,
    unregisterCommands,
  },
};