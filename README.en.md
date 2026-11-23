# dsh-baota-panel

Drive a [Baota (bt.cn)](https://www.bt.cn) Linux panel from DeepSeek Harness with **one API key**: a sidebar panel for host status, and a set of agent tools that manage the panel.

[中文](README.md) | English

## What it is

A DSH bundle with two halves:

| Half | Runs in | Does |
| --- | --- | --- |
| Host | DSH main process (Node) | Signs requests with `md5(request_time + md5(api_key))`, calls the Baota API, exposes 9 agent tools, and serves read-only data to the browser half through a typert Remote channel |
| Client | DSH Web page (React) | Sidebar panel entry, status dashboard, and `Settings → Baota panel` (address, key, security entrance, show-in-sidebar switch) |

The sidebar entry registers into `sidebar.panellist` (id `baota`), the dashboard into `main` (key `baota`), and the settings page into `settings.section` (id `baota`).

## Features

**Sidebar dashboard** — CPU, memory, load, live network throughput, disk usage, websites, databases, installed services (nginx / MySQL / PHP). One refresh button; a failing source reports its own error instead of blanking the page.

**Settings → Baota panel** — panel address, API key, optional security entrance, **show in sidebar** switch, certificate verification, and a save button that writes through DSH's `configEditor` (never by editing `cordis.patch.yml` by hand).

**Agent tools** — `bt_system`, `bt_site`, `bt_database`, `bt_file`, `bt_crontab`, `bt_firewall`, `bt_service`, `bt_logs`, `bt_config`, plus `bt_api` for any panel action not covered.

## Install

1. In DSH open **Plugins → Add plugin** and pick this directory.
2. Open **Settings → Baota panel**, enter the panel address and API key, save.
3. The sidebar shows the 宝塔面板 entry; turn **Show in sidebar** off to hide it without losing the tools.

## Configure

```yaml
- id: dsh-baota-panel
  name: dsh-baota-panel
  config:
    panelUrl: 'https://panel.example.com:4439'   # panel root with port, no security entrance
    apiKey: 'your-api-key'                        # 面板设置 → API 接口 → 接口密钥
    securityEntrance: ''                          # optional, e.g. ghostxx
    verifyTls: false                              # the panel is self-signed by default
    showInSidebar: true
    requestTimeoutMs: 20000
```

### Three things the panel must allow

1. **Enable the API** (面板设置 → API 接口) and copy the interface key.
2. **Whitelist this machine's public egress IP** in the same place (or `*`). Without it the panel answers `IP校验失败,您的访问IP为[x]` and this plugin surfaces that message unchanged.
3. **Expect a browser User-Agent**: the panel's `is_spider()` aborts non-browser UAs with 404, so the client always sends one.

## Known limits (measured on Baota Linux panel 13.2.0)

- The API lives at the **panel root** (`https://host:port/system?action=...`). Putting the security entrance into the URL produces 「安全入口校验失败」; the entrance is only checked as a Referer on a few routes (firewall, panel logs) — set `securityEntrance` for those.
- **`/firewall` and `/logs`** are session-guarded on some builds and answer with the panel's own 安全入口 page for API callers. `bt_firewall` reports that verbatim; `bt_logs` uses `/data?action=getData&table=logs` instead, which works.
- **Site/database/log lists** come from the generic `/data?action=getData&table=sites|databases|logs`; `/site?action=GetSiteList` returns 「指定参数无效」 on this build.
- **Service list** is derived from `GetConcifInfo` (webserver / mysql / php setup+status); the panel exposes no API-friendly systemd listing.
- **Secrets stay out**: `GetConcifInfo` returns `mysql_root`; the plugin keeps only the software-stack fields, so the password never reaches tool output or the UI.
- File reads are capped at 200k characters per call.
- Panel builds differ: tools try several action names for the same operation and return the panel's own error text when none works; `bt_api` is the escape hatch.

## Security

- The API key lives in the profile's plugin config, mirroring how the panel itself stores it in `api.json`. To avoid plaintext at rest, reset the key in the panel and paste the new one only in the settings page.
- The plugin never logs into the panel and never proxies its web UI; it only calls the API, so its reach is exactly what the panel API allows.
- `bt_site delete`, `bt_database delete`, `bt_file delete` and `bt_service restart` are writes — confirm the target first.

## Development

Same layout as the Chinese README: `lib/index.js` (Host), `lib/bt-api.js` (signed client), `lib/client.js` (browser half). The Remote contract `BAOTA_DESCRIPTORS` is duplicated in `lib/index.js` and `lib/client.js` because the browser half cannot import Host ESM files — keep them in sync.

## License

MIT
