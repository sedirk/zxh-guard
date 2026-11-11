# 变更记录

## 1.3.1

- **复用外部 zju-connect 时不再死守 ready**：`external=true` 的隧道没有子进程可监听 `exit`，
  用户把自己的 zju-connect 关掉或掉线后，`state` 会一直停在 `ready`，网关持续往死端口发包。
  现在 `ensureReady()` 会按 `tunnel.externalCheckMs`（默认 30s，可校验范围 3s–10min）探一次端口，
  探不到就降级为自己拉起；`start()` 的预检仍会优先复用刚恢复的外部隧道。
- 新增测试「外部隧道消失后不再死守 ready，改为自己拉起」，覆盖复用、节流、降级三条路径（离线 30/30）。
- 配置面板改为分区卡片：**账号与凭据 / 服务与端点 / 校园网隧道** 三组，标题独占整行、卡片内两列、窄屏单列。

## 1.3.0

可观测性收口（网关行为不变）：

- `GET /health` 作为 `/healthz` / `/status` 的别名，快照里新增 `lastRequest`
- 最近一轮请求记录：`at` / `path` / `route` / `upstreamStatus` / `ms` / `aborted`
- 每次转发追加 `requests.jsonl`（数据目录，5MB 轮转），便于区分「隧道故障」与「上游故障」
- 新增本变更记录

## 1.2.0

- 配置面板成为唯一编辑入口：`config.json` 只在插件数据目录，旧根目录配置只迁移一次
- 面板支持保存并重启、掩码显示密码/API Key、端口与监控项校验

## 1.1.5

- 5xx 不再被误判为凭据问题：`ZHIXIAOHANG_UPSTREAM_ERROR` 带上游状态与 route，且不强制隧道重登录
- 校外/计费页/垃圾响应的清洗与短提示保持

## 1.1.4

- PAC 端口分离（API 11081/11080，浏览 11091/11090），PAC 内容校验，去掉 file URL 兜底

## 1.1.x 之前

- 网关骨架：忽略系统代理、按需私有隧道、28 RPM 节奏控制、HTML/base64 清洗、
  429 与空流重试、`/v1/chat/completions` 与 `/v1/responses`
- 独立托盘：无需 PI-Desktop 常驻即可启停隧道、切 PAC、与 v2rayN 共存
