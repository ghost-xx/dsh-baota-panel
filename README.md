# dsh-baota-panel

用**一个接口密钥**把宝塔（bt.cn）Linux 面板接管进 [DeepSeek Harness](https://github.com/deepseek-ai)：侧边栏一个面板看服务器状态，智能体用一组工具直接管面板。

English | [English](README.en.md)

![icon](icon.svg)

## 它是什么

一个 DSH 插件（bundle），两半：

| 半边 | 运行位置 | 做什么 |
| --- | --- | --- |
| Host | DSH 主进程（Node） | 用 `md5(request_time + md5(api_key))` 时间戳签名直连宝塔 API，对外提供 9 个智能体工具，并通过 typert Remote 把只读数据推给前端 |
| Client | DSH Web 页面（React） | 侧边栏面板入口 + 状态看板 + `设置 → 宝塔面板`（面板地址、密钥、安全入口、是否显示到侧边栏） |

侧边栏入口用 DSH 的 `sidebar.panellist` 插槽注册（id `baota`），中央面板用 `main` 插槽（key `baota`），设置页用 `settings.section`（id `baota`）。

## 功能

**多台面板**

- 面板列表：每台面板有自己的地址、接口密钥、安全入口和证书策略，可在设置页增删
- 任意一台设为「当前面板」，侧边栏看板顶部有切换下拉
- 所有工具都带可选 `panel` 参数（面板 id 或名称），留空用当前面板；`bt_panels` 列出全部

**侧边栏看板**

- CPU 使用率（含核数）、内存占用、系统负载、实时网络吞吐
- 磁盘分区占用（字节/百分比）
- 网站列表（id、名称、路径、运行状态、类型）
- 数据库列表、已安装服务（nginx / MySQL / PHP 版本与状态）
- 一键刷新；任一数据源失败时单独报错，不整页空白

**设置页（设置 → 宝塔面板）**

- 面板列表：添加、删除、选中编辑、「设为当前」
- 每台面板：显示名称、面板地址（含端口的根地址）、接口密钥（留空表示不改）、安全入口（可选）、校验证书
- **显示到侧边栏**开关
- 保存后通过 DSH 的 `configEditor` 写入 profile 的 `cordis.patch.yml`，不是自己改文件

**智能体工具**

| 工具 | 能力 |
| --- | --- |
| `bt_panels` | 列出已配置的面板（id、名称、主机、是否配齐） |
| `bt_system` | 概览 / 磁盘 / 负载 / 网络 / 面板软件栈 / 原始系统信息 |
| `bt_site` | 网站列表、启动、停止、删除、读站点访问日志 |
| `bt_database` | 数据库列表、删除 |
| `bt_file` | 目录浏览、读文件、写文件、建目录、删除 |
| `bt_crontab` | 计划任务列表、新增、删除 |
| `bt_firewall` | 防火墙规则列表、放行端口、关闭端口 |
| `bt_service` | 服务列表、重启 |
| `bt_logs` | 面板操作日志（谁在什么时候做了什么） |
| `bt_config` | 面板增删改、切换当前面板、侧边栏开关 |
| `bt_api` | 兜底：直接调用任意面板 API 动作 |

除 `bt_panels` / `bt_config` 外，每个工具都接受 `panel` 参数选中目标面板。

## 安装

1. 在 DSH 里打开 **插件 → 添加插件**，选择本仓库目录（或 `pnpm` 安装后选择包目录）。
2. 打开 **设置 → 宝塔面板**，点「添加面板」填地址与接口密钥，「设为当前」，保存。要多台面板就重复这一步。
3. 侧边栏出现「宝塔面板」入口，看板右上角可切换面板；不想显示时把「显示到侧边栏」关掉即可（入口消失，工具照常可用）。

也可以命令行安装：

```sh
git clone <this repo> dsh-baota-panel
# 然后在 DSH 插件页添加 C:\path\to\dsh-baota-panel
```

## 配置

```yaml
- id: dsh-baota-panel
  name: dsh-baota-panel
  config:
    panels:
      - id: main
        name: 主面板
        panelUrl: 'https://panel.example.com:4439'   # 根地址含端口，不带安全入口
        apiKey: '你的接口密钥'
        securityEntrance: ''                          # 可选，例如 ghostxx
        verifyTls: false                              # 面板一般自签证书
      - id: backup
        name: 备用面板
        panelUrl: 'https://203.0.113.10:8888'
        apiKey: '另一台的密钥'
        verifyTls: false
    activePanel: main
    showInSidebar: true
    requestTimeoutMs: 20000
```

### 面板侧必须做的三件事

1. **打开 API 接口**：面板 → 设置 → 面板设置 → API 接口 → 开启，复制接口密钥。
2. **登记 IP 白名单**：同一处「IP白名单」加入运行 DSH 这台机器的**公网出口 IP**（或填 `*` 放开）。未登记时面板返回 `IP校验失败,您的访问IP为[x]`，插件会把这条消息原文交给用户。
3. **别让面板把请求当爬虫**：面板的 `is_spider()` 会对非浏览器 UA 直接 `abort(404)`，本插件固定使用浏览器 UA。

## 已知边界（实测于宝塔 Linux 面板 13.2.0）

- **API 在根路径**：`https://host:port/system?action=...`。把安全入口拼进地址会触发「安全入口校验失败」；入口只在少数路由（防火墙、面板日志）里作为 Referer 校验，填到 `securityEntrance` 即可。
- **`/firewall` 与 `/logs`** 在部分版本里只服务已登录的浏览器会话，API 调用会返回面板自己的「安全入口校验失败」页面；`bt_firewall` 会原样报错，`bt_logs` 改用 `/data?action=getData&table=logs`，可用。
- **网站/数据库/日志列表**走通用数据接口 `/data?action=getData&table=sites|databases|logs`，不是 `/site?action=GetSiteList`（后者在本版本返回「指定参数无效」）。
- **服务列表**来自 `GetConcifInfo`（webserver / mysql / php 的 setup+status），面板没有暴露 API 可用的 systemd 列表。
- **`mysql_root` 等敏感字段不外传**：`GetConcifInfo` 会返回 MySQL root 密码，插件只取软件栈字段，密码不进入工具结果与前端。
- 读文件单次上限 20 万字符；更大的文件请用 `bt_api` 自行分段。
- 面板版本差异较大：工具内部对同类动作会依次尝试多个动作名，仍失败时把面板原文错误返回，可用 `bt_api` 指定。

## 安全

- 接口密钥保存在 profile 的插件配置里（与面板自身在 `api.json` 里存密钥的做法一致）。想避免明文落盘，可在面板里重置密钥后只在设置页填写，用完再重置。
- 插件不登录面板、不代理面板网页，只调用面板 API；能用什么完全取决于面板 API 的权限。
- `bt_site delete`、`bt_database delete`、`bt_file delete`、`bt_service restart` 是写操作，调用前请确认目标。

## 开发

```
dsh-baota-panel/
├── package.json          # dsh.bundle.patch + dsh.client（platform: web）
├── cordis.patch.yml      # 插入一行 id=dsh-baota-panel 的插件行
├── lib/
│   ├── index.js          # Host：工具注册 + typert Remote 服务 + 归一化
│   ├── bt-api.js         # 宝塔 API 客户端（签名、Cookie、TLS、错误翻译）
│   └── client.js         # Client：sidebar.panellist / main / settings.section
├── locale/{zh,en}.json   # 插件元数据（标题、描述、详情文档）
└── docs/DETAIL.md        # 插件详情页
```

Host 与 Client 之间的契约是 `BAOTA_DESCRIPTORS`（typert Remote）。客户端用 `remote.$mount(...)` 注册描述符，再用 `ctx.get('remote.baota')` 拿到命名空间；描述符在 `lib/index.js` 与 `lib/client.js` 各存一份（Client 半边是浏览器产物，不能 import Host 的 ESM 文件），改动时两处同步。

## License

MIT
