'use strict';

/**
 * PI-Desktop 插件入口：南航智小航专属本地守护网关。
 *
 * 启动顺序：
 *   1. 清掉进程内所有 *_proxy 环境变量（模块 1）
 *   2. 读 config.json，建隧道管理器（默认不启动进程，模块 2）
 *   3. 起 127.0.0.1 本地网关，把 6 个模块串成一条链路
 *   4. 后台同步上游模型目录，写回 manifest.json（PI-Desktop 的 provider 声明）
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
  catalog: 'zhixiaohang.catalog',
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
let hostReloadRequired = false;
let catalogSynced = false;

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
        hostReloadRequired,
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
// manifest 写回：模型目录 / 端口变化后让 provider 声明与运行状态一致
// --------------------------------------------------------------------------

function manifestPath() {
  return path.join(packageRoot, 'manifest.json');
}

function readManifest() {
  try { return JSON.parse(fs.readFileSync(manifestPath(), 'utf8')); } catch { return null; }
}

function providerOf(manifest) {
  const list = manifest && manifest.contributes && Array.isArray(manifest.contributes.providers)
    ? manifest.contributes.providers
    : [];
  return list.find((entry) => entry && entry.id === 'zhixiaohang') || null;
}

/** 只在真正变化时写盘，避免文件监听触发无限重载。 */
function syncDeclaration({ port, models } = {}) {
  const manifest = readManifest();
  const provider = providerOf(manifest);
  if (!manifest || !provider) return { changed: false, reason: 'manifest 里没有 zhixiaohang provider 声明' };
  let changed = false;

  if (port && typeof provider.baseUrl === 'string') {
    const next = `http://127.0.0.1:${port}/v1`;
    if (provider.baseUrl !== next) { provider.baseUrl = next; changed = true; }
  }
  if (Array.isArray(models) && models.length > 0) {
    const current = JSON.stringify(provider.models || []);
    const next = JSON.stringify(models);
    if (current !== next) { provider.models = models; changed = true; }
  }
  if (!changed) return { changed: false };

  try {
    fs.writeFileSync(manifestPath(), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    hostReloadRequired = true;
    log('manifest.json 已更新（需要重载插件让模型列表生效）');
    return { changed: true };
  } catch (error) {
    log(`manifest.json 写入失败：${error && error.message}`);
    return { changed: false, reason: 'write failed' };
  }
}

/**
 * 上游 /v1/models 的真实形状：上下文与多模态都嵌在 model_info 里
 *   { id, object, owned_by, model_info: { display_name, context_window, max_tokens, input_modalities } }
 * 只读顶层字段会全部落到兜底值（131072 / 8192）——之前就是这样把 1.02M 覆盖掉的。
 * 这里以 model_info 为准，同时兼容 OpenAI 官方风格的顶层字段。
 */
function modelsFromCatalog(payload) {
  const list = payload && Array.isArray(payload.data) ? payload.data : [];
  const seen = new Set();
  const models = [];
  const pick = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
  };
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const id = item.id || item.model || item.name;
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    const info = item.model_info && typeof item.model_info === 'object' ? item.model_info : {};
    const contextWindow = pick(info.context_window)
      || pick(item.context_length) || pick(item.context_window) || pick(item.contextWindow) || pick(item.context);
    const maxTokens = pick(info.max_tokens)
      || pick(item.max_completion_tokens) || pick(item.max_output_tokens) || pick(item.maxTokens);
    const modalities = Array.isArray(info.input_modalities)
      ? info.input_modalities
      : (Array.isArray(item.input_modalities) ? item.input_modalities : []);
    models.push({
      id,
      name: (typeof info.display_name === 'string' && info.display_name.length > 0) ? info.display_name : id,
      contextWindow: contextWindow || 131072,
      maxTokens: maxTokens || 8192,
      supportsImages: modalities.includes('image'),
    });
    if (models.length >= 64) break;
  }
  return models;
}

/** 通过当前判定出的路由取一次 /v1/models，用于同步模型目录。 */
async function syncCatalogFromUpstream({ quiet = false } = {}) {
  if (!config || !config.apiKey) return { ok: false, reason: 'apiKey 为空' };
  try {
    const route = await gateway.resolveRoute();
    const url = `${config.baseUrl}/models`;
    const { res } = await transport.sendUpstream({
      url,
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${config.apiKey}` },
      agent: route.agent,
      timeoutMs: config.probe.timeoutMs,
    });
    const { buffer } = await transport.readBody(res, 2 * 1024 * 1024);
    const text = buffer.toString('utf8');
    if (/^\s*</.test(text)) return { ok: false, reason: '上游返回 HTML（校外/未认证）' };
    const payload = JSON.parse(text);
    const models = modelsFromCatalog(payload);
    if (models.length === 0) return { ok: false, reason: '上游模型列表为空' };
    const result = syncDeclaration({ models });
    catalogSynced = true;
    if (result.changed) {
      log(`模型目录已同步：${models.map((m) => m.id).join(', ')}`);
      if (!quiet) await toast(`智小航: 已同步 ${models.length} 个模型，请在插件页重载一次生效`, 'info');
    }
    return { ok: true, models: models.map((m) => m.id), changed: Boolean(result.changed) };
  } catch (error) {
    const reason = (error && (error.code || error.message)) || 'unknown';
    log(`模型目录同步失败：${reason}`);
    return { ok: false, reason };
  }
}

// --------------------------------------------------------------------------
// 服务生命周期
// --------------------------------------------------------------------------

/** 双击客户端（浏览模式）的配置：独立端口、校园域名全站、超长闲置。 */
function browseSettings() {
  const cc = (config && config.campusClient) || {};
  return {
    httpBind: cc.httpBind || '127.0.0.1:11091',
    socksBind: cc.socksBind || '127.0.0.1:11090',
    domains: Array.isArray(cc.domains) && cc.domains.length > 0 ? cc.domains : ['nuaa.edu.cn'],
    probeHost: cc.probeHost || `www.${(Array.isArray(cc.domains) && cc.domains.length > 0 ? cc.domains[0] : 'nuaa.edu.cn')}`,
    idleTimeoutMs: Number.isFinite(Number(cc.idleTimeoutMs)) ? Number(cc.idleTimeoutMs) : 8 * 3600 * 1000,
    startTimeoutMs: Number(cc.startTimeoutMs) > 0 ? Number(cc.startTimeoutMs) : 30_000,
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

/** PAC：校内域名走浏览客户端，其余直连。 */
function campusVpnPac() {
  const b = browseSettings();
  const proxy = `PROXY ${b.httpBind}; SOCKS5 ${b.socksBind}; SOCKS ${b.socksBind}`;
  const rules = b.domains
    .map((d) => `  if (host === "${d}" || dnsDomainIs(host, ".${d}")) return "${proxy}";`)
    .join('\n');
  return [
    '// generated by local.zhixiaohang-guard (campus VPN)',
    `var PROXY = "${proxy}";`,
    'function FindProxyForURL(url, host) {',
    '  if (isPlainHostName(host) || host === "127.0.0.1" || host === "localhost") return "DIRECT";',
    rules,
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

  // 端口与声明不一致时更新 manifest（只有变化才写）
  syncDeclaration({ port });
  if (hostReloadRequired) {
    await toast(`智小航: 网关监听 127.0.0.1:${port}，provider 声明已更新，请重载一次插件`, 'warning');
  }
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
        + `代理环境变量已清除 ${proxyEnvRemoved.length} 个${snapshot.apiKeyPresent ? '' : ' · apiKey 未填写'}${hostReloadRequired ? ' · 需重载插件' : ''}`
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
    id: COMMANDS.catalog,
    title: '智小航: 同步模型目录',
    category: 'AI',
    keywords: ['zhixiaohang', '智小航', '模型', 'models'],
    run: async () => {
      const result = await syncCatalogFromUpstream({ quiet: true });
      if (!result.ok) { await toast(`智小航: 同步失败（${result.reason}）`, 'warning'); return; }
      await toast(
        `智小航: ${result.models.length} 个模型（${result.models.slice(0, 6).join(', ')}${result.models.length > 6 ? ' …' : ''}）`
        + `${result.changed ? '，请重载插件生效' : '，无需变更'}`,
        'info',
      );
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

    // 首轮模型目录同步放到后台，不阻塞 15s 的 onLoad 预算
    setTimeout(() => {
      if (catalogSynced) return;
      void syncCatalogFromUpstream({ quiet: false });
    }, 1500).unref?.();
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
    syncDeclaration,
    modelsFromCatalog,
    syncCatalogFromUpstream,
    startService,
    stopService,
    registerCommands,
    unregisterCommands,
    readManifest,
    providerOf,
  },
};