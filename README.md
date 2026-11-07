# 南航智小航守护网关 / 校内 VPN 托盘

面向 Windows 的 PI-Desktop 插件与独立 VPN 托盘。将南航智小航 API 转为本机网关 `http://127.0.0.1:41900/v1`，支持按需 VPN、28 RPM 排队、429 重试与 HTML 拦截。

> **实验版本**：托盘/PAC、短时断线重连及插件与托盘的单会话协调仍有已知问题，尚未完成 Chrome 和持续流量稳定性验证。请勿用于无人值守的关键任务。本项目非学校官方客户端；仅供拥有合法校园账号和访问权限的用户使用。

## 下载与准备

- [下载源码 ZIP](https://github.com/sedirk/zxh-guard/archive/refs/heads/main.zip)，解压到固定目录；或 `git clone https://github.com/sedirk/zxh-guard.git`。
- [插件安装包 / Releases](https://github.com/sedirk/zxh-guard/releases)。发布资产分两种：
  - `*-slim.piplug`：不含第三方 VPN EXE，按下面的步骤下载安装引擎；公开包不包含账号、密码或 API Key。
  - `*-full.piplug`：内置未修改的 zju-connect v1.3.1、完整 AGPL-3.0 文本和 v1.3.1 对应源码包；约 15.7 MB。

PI-Desktop 更新会按包内容替换插件目录：slim 包会把旧 EXE 清掉，full 包会保留内置引擎。两种包都不包含真实 `config.json`。
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

#### PAC 与 IPv6

- PAC 只按**域名**匹配（`nuaa.edu.cn` 及其子域），不做 DNS 解析，因此不会因为 A/AAAA 结果不同而改走直连。
- PAC 返回的代理列表同时包含托盘端口 `11081/11080` 与插件浏览端口 `11091/11090`，哪条隧道在跑都能命中；旧版本只写 `11091`，浏览器会连到未监听的端口。
- `host` 为 IPv6 字面量（含 `:`）时同样走 `PROXY`：校园 IPv6 只能在隧道内访问，落 `DIRECT` 会直接连 AAAA 而失败。
- 托盘只在 PAC 真正可取到、且代理端口与本客户端一致时才写入 `AutoConfigURL`；不再回退到 Chrome 会忽略的 `file://` PAC。取不到时保持系统代理不变并弹窗提示。
- 托盘退出会停止 `41980` 服务；若此时仍启用 PAC，浏览器拿不到 PAC 就会全部直连。需要长期 PAC 时请保持托盘运行，或改用插件网关的 `http://127.0.0.1:41900/proxy.pac`。

#### 连接状态与按钮

| 状态 | 反馈与可用操作 |
| --- | --- |
| 未连接 | 可点击「连接」，托盘启动时不会根据旧代理模式自动登录 |
| 连接中 | 点击后立即禁用连接/重启，显示耗时；可「取消连接」 |
| 正在断开/取消 | 不接受重复操作；等待当前任务结束或超时，再串行清理 |
| 代理就绪 | 仅表示本机 HTTP/SOCKS 端口监听，可断开、重启或显式设置代理；不代表校园 HTTP/网站登录成功 |
| 等待重试 | 显示 15 秒倒计时和失败次数，可取消；连续失败 3 次停止自动重试 |
| 操作失败 | 「查看连接详情」保留最近错误；有残留的自有进程时先重试断开，否则可手动重试连接 |
| 外部代理占用 | 不重复登录、不终止未知/插件进程，也不假定其支持校园浏览；请到原客户端管理 |

重启严格按「停止完成 → 启动」执行；主动断开/取消不会触发重连。短暂就绪不会清空重试预算，持续就绪 60 秒才重置。退出也等待任务清理；停止失败且自有进程仍存在时保留托盘，供用户重试。默认启动超时 30 秒（`campusClient.startTimeoutMs`，3–180 秒），后台任务另有超时兜底。

托盘一次只派发一个后台任务；CLI 用命名互斥锁串行化，重复启动返回忙碌（退出码 75），而不是再次登录。只凭 PID 不会终止进程，还需匹配引擎路径和创建时间。每次启动保留独立的临时日志；「连接详情」显示最近错误。

**已知限制**：上述保护覆盖托盘/PowerShell CLI，**不等于与 Node 插件建立了统一跨进程锁**。PAC 重复切换、代理恢复和 Chrome 实际路由仍待完善；服务端主动关闭会话的根因尚未确认。不要同时发起插件、官方客户端与托盘的 VPN 登录；不要把端口就绪当成校园网站已验证。系统代理行读取当前 Windows 设置，不凭旧模式文件显示“已启用”。

### PI-Desktop 插件

1. 从 Releases 下载 `.piplug`，在 PI-Desktop 插件页面安装；或使用 PI-Desktop 的本地开发插件加载方式选择本目录。
2. 在**实际加载的插件目录**执行上面的 VPN 引擎安装步骤，并从 `config.example.json` 创建、填写 `config.json`。独立托盘优先读取其脚本所在插件目录的 `config.json`；更新后根目录配置缺失时，自动回退到 `plugins\data\<插件ID>\config.json`。
3. 启用插件并按提示授予 `background.service` 权限。从旧版升级时，请用 1.1.5 的 `.piplug` 走插件页安装/更新：安装器会更新版本登记；只覆盖插件目录文件不会更新登记。本版不申请剪贴板权限，所以不会再出现 `clipboard.write` 审批。
4. 插件不再声明只读模型。运行命令「智小航: 显示可编辑兼容服务配置」（能写剪贴板就复制，否则直接显示配置），按下一节的步骤在 PI-Desktop 中手动添加一次普通兼容服务。

插件优先读插件数据目录中的 `config.json`，其次读插件目录。若配置不生效，请检查是否存在旧的数据目录配置。只在自己的电脑上使用本地网关：它没有本地调用方认证，本机其他进程也可能消耗你的 API 配额。

#### 可编辑兼容服务

插件声明的 provider 会被 PI-Desktop 标记为“由插件提供”，设置页只能启用/停用和填写 API Key，不能修改上下文窗口或推理档位。因此本项目不再提供插件模型，改为由你添加普通兼容服务：

1. 设置 → AI 服务 → 添加服务 → 自定义端点。
2. 名称填 `智小航（可编辑）`。
3. Base URL 填 `http://127.0.0.1:41900/v1`。若网关因端口占用改到 41901–41904，以「智小航: 显示网关状态」为准；复制命令会自动使用实际端口。
4. API 风格选 `Chat Completions`；认证选无 API Key（留空/免密钥）。
5. 点击“获取模型列表”，选择需要的模型并保存。
6. 在该服务的模型“高级”里设置上下文窗口、最大输出、推理档位；需要时打开“发送 `reasoning_effort`”。

之后在输入框选择这个普通服务即可。它的上下文/推理设置由 PI-Desktop 保存，插件不再覆盖。旧版本安装可能仍保留只读的「南航智小航」provider；安装 1.1.5 后它不再被声明，若宿主仍显示旧行，请停用它。已有会话若绑定旧 provider，请在模型选择器切到新的普通服务。

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
powershell.exe -NoProfile -ExecutionPolicy Bypass -File test/run-vpn-tests.ps1
# git add 后检查暂存区，而不是仅检查工作目录
node scripts/check-publication.js
# full 包额外校验 AGPL 文本、固定哈希的 EXE 与源码包
node scripts/check-publication.js --directory .\dist\<full-package-dir> --full
```

测试主要使用模拟上游，不代表真实 Chrome/PAC 或 VPN 长稳验证。测试不再回写 manifest，建议在干净副本运行，完成后核对 `git diff`。
生命周期套件含 20 项离线测试：纯状态转换、隔离假引擎的并发启动/超时/进程归属清理，以及真实 WinForms 菜单和看门狗事件（模拟副作用）。它不使用真实凭据、不登录 VPN、不写系统代理，并核对测试前后代理设置一致。

`.gitignore` 排除了真实配置、环境文件、凭据/私钥、日志、临时状态、模型缓存、下载的 EXE 和 `dist/`；`third_party/zju-connect-v1.3.1-source.zip` 是固定哈希的例外，必须作为源码资产保留。**忽略规则不保护已跟踪文件，也不控制插件打包器。** 发布前必须检查 Git 暂存区，并只从经过审查的 Git 文件构建干净目录；不要对含 `config.json` 的工作目录直接运行 PluginPack。

PI-Desktop 的 `PluginCheck` 验证干净目录后，用 `PluginPack` 生成 `.piplug`，并再次检查包内无 `config.json`、日志、私钥和真实凭据。不能用普通 ZIP 工具替代 PluginPack（插件格式要求 store-only ZIP）。

## 许可与来源

本项目原创代码使用 [AGPL-3.0](LICENSE)。改编/参考项目中的 MIT 部分仍保留原 MIT 通知，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)：

- [dsh-zhixiaohang-guard](https://github.com/2277533612/dsh-zhixiaohang-guard)：净化、限流、空流识别（MIT）。
- [dsh-cooldown-retry](https://github.com/dboycht/dsh-cooldown-retry)：冷却提示解析与重试（MIT）。
- [opencode2pi-desktop](https://github.com/JasonYu0822/opencode2pi-desktop)：插件结构参考（MIT）。
- [zju-connect](https://github.com/Mythologyli/zju-connect/tree/v1.3.1)：独立 VPN 引擎（AGPL-3.0）。full 包内置未修改 EXE 与 v1.3.1 对应源码包；slim 包不含 EXE，由安装脚本从官方源下载并校验哈希。
