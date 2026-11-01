# 南航智小航守护网关 / 校内 VPN 托盘

面向 Windows 的 PI-Desktop 插件与独立 VPN 托盘。将南航智小航 API 转为本机网关 `http://127.0.0.1:41900/v1`，支持按需 VPN、28 RPM 排队、429 重试与 HTML 拦截。

> **实验版本**：托盘/PAC、短时断线重连及插件与托盘的单会话协调仍有已知问题，尚未完成 Chrome 和持续流量稳定性验证。请勿用于无人值守的关键任务。本项目非学校官方客户端；仅供拥有合法校园账号和访问权限的用户使用。

## 下载与准备

- [下载源码 ZIP](https://github.com/sedirk/zxh-guard/archive/refs/heads/main.zip)，解压到固定目录；或 `git clone https://github.com/sedirk/zxh-guard.git`。
- [插件安装包 / Releases](https://github.com/sedirk/zxh-guard/releases)。公开包不包含任何账号、密码或 API Key，也不内置第三方 VPN EXE。
- Windows 10/11 x64、Windows PowerShell 5.1。插件模式需要 PI-Desktop；独立托盘不需要 PI-Desktop 或 Node.js。开发测试需要 Node.js 22+。

### 1. 下载 VPN 引擎

在解压后的项目根目录打开 PowerShell：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\bin\install-zju-connect.ps1
```

脚本从 **Mythologyli/zju-connect 官方 GitHub Release v1.3.1** 下载 Windows amd64 版本，核对 EXE SHA-256 后放入 `bin/zju-connect.exe`。不需要管理员权限，也不会改系统代理或启动 VPN。网络必须能访问 GitHub；安装脚本使用系统默认网络设置。

手动下载：[官方 Release](https://github.com/Mythologyli/zju-connect/releases/tag/v1.3.1)。将 Windows amd64 ZIP 内的 `zju-connect.exe` 放到 `bin/`；校验值见安装脚本。该程序使用 **AGPL-3.0**，源码及许可见 [第三方说明](THIRD_PARTY_NOTICES.md)。

### 2. 填写自己的凭据

```powershell
# 仅在首次使用、尚无 config.json 时复制，避免覆盖已有凭据
if (-not (Test-Path .\config.json)) { Copy-Item .\config.example.json .\config.json }
notepad .\config.json
```

填写这三个字段，其余保持模板默认值：

```json
{
  "studentId": "你的南航学号",
  "password": "你的统一认证密码",
  "apiKey": "你的智小航 API Key"
}
```

仅使用 VPN 托盘时可留空 `apiKey`；智小航 API 需要自己的 Key。必须保留整个模板的其它字段，尤其是 `campusClient` 的端口设置。修改配置后重启插件/托盘以确保生效。

**`config.json` 是本机明文凭据文件，已被 `.gitignore` 排除。不要分享、截图、提交或连同整个工作目录打包。** 如凭据曾被公开，应立即修改密码/撤销 API Key；删除 Git 文件不能撤销泄露。

## 使用方式

### 独立托盘（无需 PI-Desktop 常驻）

双击 `bin/campus-vpn-tray.cmd`，在系统通知区域打开「校内 VPN」菜单。支持启动/停止/重启、PAC、系统代理与清除代理。快捷方式请自行创建到该 CMD，不含作者电脑的绝对路径。

模板端口：HTTP `127.0.0.1:11081`，SOCKS5 `127.0.0.1:11080`；托盘的 PAC 服务为 `http://127.0.0.1:41980/proxy.pac`。PAC 仅在托盘运行时可用。启用系统代理会影响其他应用，请勿与 v2rayN 等工具同时抢占系统代理设置。

**已知限制**：PAC 重复切换、外部隧道状态、并发启动和代理恢复尚待完善。端口已监听不代表校园 HTTP 请求成功；若浏览器报代理错误，先在托盘清除代理，并核对 Windows 的代理设置。不要同时启动官方 VPN、多个托盘或多个独立 VPN 登录。

### PI-Desktop 插件

1. 从 Releases 下载 `.piplug`，在 PI-Desktop 插件页面安装；或使用 PI-Desktop 的本地开发插件加载方式选择本目录。
2. 在**实际加载的插件目录**执行上面的 VPN 引擎安装步骤，并从 `config.example.json` 创建、填写 `config.json`。独立托盘读取其脚本所在插件目录的配置，不读取 PI-Desktop 数据目录。
3. 启用插件并按提示授予 `provider.register` / `background.service` 权限。重启插件后，本机网关默认监听 `127.0.0.1:41900`。
4. 使用「南航智小航」provider；也可在支持 OpenAI 兼容接口的客户端填入 `http://127.0.0.1:41900/v1`。

插件优先读插件数据目录中的 `config.json`，其次读插件目录。若配置不生效，请检查是否存在旧的数据目录配置。只在自己的电脑上使用本地网关：它没有本地调用方认证，本机其他进程也可能消耗你的 API 配额。

## 网关功能与配置

- 清理代理环境变量，用自建 Node HTTP/HTTPS Agent；不承诺绕过驱动层 TUN。
- 校外按需启动 zju-connect；API 私有隧道默认仅针对 `token.nuaa.edu.cn`，闲置 20 分钟关闭。
- 可检测并绑定已有 Sangfor/EasyConnect 网卡；本项目不安装/卸载驱动、不重置 Winsock。
- 默认 28 RPM / 60 秒滑动窗口，限额时排队。
- 拦截校园认证 HTML / base64 页面，避免污染模型上下文。
- 按服务端提示重试 429/冷却响应，支持空流重试、流式及非流式的 `/v1/chat/completions` 和 `/v1/responses`。
- 浏览功能必须显式启用。模板让托盘与 API 使用同组端口以减少重复登录，但**单会话协调并非完备**；插件的 `campusClient` 配置传递仍有待修复，不建议在托盘运行时再用插件命令启动浏览 VPN。

完整配置见 [config.example.json](config.example.json)。常用项：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `gatewayPort` | `41900` | 仅监听回环地址；占用时可能改用相邻端口 |
| `rateLimit.rpm` | `28` | 请求排队限额 |
| `tunnel.enabled` | `true` | 是否允许按需启动 API VPN |
| `tunnel.httpBind` / `socksBind` | `127.0.0.1:11081` / `127.0.0.1:11080` | 本机隧道端口 |
| `tunnel.idleTimeoutMs` | `1200000` | API 隧道闲置关闭时间 |
| `tunnel.bindInterface` | 空 | 可选物理接口绑定 |
| `campusClient.domains` | `["nuaa.edu.cn"]` | 独立浏览客户端的校园域名 |
| `retry.maxRetries` | `5` | 重试上限 |
| `retry.emptyStreamRetries` | `1` | 空流重试上限 |

## 开发、检查与安全发布

```powershell
node test/run-tests.js
# git add 后检查暂存区，而不是仅检查工作目录
node scripts/check-publication.js
```

测试主要使用模拟上游，不代表真实 Chrome/PAC 或 VPN 长稳验证。测试可能临时回写 manifest，建议在干净副本运行，完成后核对 `git diff`。

`.gitignore` 排除了真实配置、环境文件、凭据/私钥、日志、临时状态、模型缓存、下载的 EXE 和 `dist/`。**忽略规则不保护已跟踪文件，也不控制插件打包器。** 发布前必须检查 Git 暂存区，并只从经过审查的 Git 文件构建干净目录；不要对含 `config.json` 的工作目录直接运行 PluginPack。

PI-Desktop 的 `PluginCheck` 验证干净目录后，用 `PluginPack` 生成 `.piplug`，并再次检查包内无 `config.json`、日志、私钥和真实凭据。不能用普通 ZIP 工具替代 PluginPack（插件格式要求 store-only ZIP）。

## 许可与来源

本项目原创代码使用 [MIT License](LICENSE)。改编/参考项目的版权通知保留于 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)：

- [dsh-zhixiaohang-guard](https://github.com/2277533612/dsh-zhixiaohang-guard)：净化、限流、空流识别（MIT）。
- [dsh-cooldown-retry](https://github.com/dboycht/dsh-cooldown-retry)：冷却提示解析与重试（MIT）。
- [opencode2pi-desktop](https://github.com/JasonYu0822/opencode2pi-desktop)：插件结构参考（MIT）。
- [zju-connect](https://github.com/Mythologyli/zju-connect/tree/v1.3.1)：独立 VPN 引擎（AGPL-3.0），由用户从官方源下载，本仓库不再分发 EXE。
