/**
 * Browser half of dsh-baota-panel.
 *
 * Registers three things inside the DSH Web shell:
 *   1. `sidebar.panellist` — the 宝塔面板 icon, gated by the `showInSidebar` setting.
 *   2. `main` (key = baota) — the panel dashboard, with a switcher between panels.
 *   3. `settings.section` — 设置 → 宝塔面板, which owns the panel list and the switch.
 *
 * Data comes from the Host half through the typert Remote channel
 * (`ctx.remote.baota.*`), never by calling the Baota panel from the browser.
 */
window.__ModuleLoader__.load({
  id: 'dsh-baota-panel',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    /* ------------------------- Remote contract ------------------------- */

    const jsonCodec = (symbol) => ({
      mode: 'strict',
      typeSymbol: `dsh-baota-panel#${symbol}`,
      create: () => ({ parse: (value) => value }),
    })
    const remoteMethod = (method, parameters = []) => ({
      id: `dsh-baota-panel#baota/${method}`,
      service: 'baota',
      namespace: 'baota',
      method,
      invocation: { kind: 'direct' },
      result: jsonCodec('Result'),
      parameters: parameters.map((parameter) => ({
        name: parameter.wire,
        wire: parameter.wire,
        source: 'json',
        codec: jsonCodec(parameter.symbol),
      })),
    })
    const REMOTE = Object.freeze({
      package: 'dsh-baota-panel',
      descriptors: Object.freeze([
        remoteMethod('config'),
        remoteMethod('overview', [{ wire: 'panel', symbol: 'PanelRef' }]),
        remoteMethod('sites', [{ wire: 'panel', symbol: 'PanelRef' }]),
        remoteMethod('databases', [{ wire: 'panel', symbol: 'PanelRef' }]),
        remoteMethod('services', [{ wire: 'panel', symbol: 'PanelRef' }]),
        remoteMethod('refresh'),
        remoteMethod('addPanel', [{ wire: 'panel', symbol: 'PanelInput' }]),
        remoteMethod('updatePanel', [{ wire: 'request', symbol: 'PanelUpdate' }]),
        remoteMethod('removePanel', [{ wire: 'id', symbol: 'PanelId' }]),
        remoteMethod('activatePanel', [{ wire: 'id', symbol: 'PanelId' }]),
        remoteMethod('setShowInSidebar', [{ wire: 'value', symbol: 'Flag' }]),
        remoteMethod('trace', [{ wire: 'message', symbol: 'Text' }]),
      ]),
    })

    /* ---------------------------- Locale ------------------------------ */

    const DICT = {
      en: {
        'nav.title': 'Baota panel',
        'panel.title': 'Baota panel',
        'panel.refresh': 'Refresh',
        'panel.loading': 'Reading panel…',
        'panel.failed': 'Panel unreachable',
        'panel.hint': 'Check the panel address, the API IP whitelist and 设置 → 宝塔面板.',
        'panel.updated': 'Updated {time}',
        'panel.cpu': 'CPU',
        'panel.memory': 'Memory',
        'panel.load': 'Load',
        'panel.network': 'Network',
        'panel.cores': '{count} cores',
        'panel.disk': 'Disks',
        'panel.sites': 'Websites',
        'panel.databases': 'Databases',
        'panel.services': 'Services',
        'panel.empty': 'Nothing reported',
        'panel.running': 'Running',
        'panel.stopped': 'Stopped',
        'panel.sitesSummary': '{running} of {total} running',
        'panel.databasesSummary': '{total} databases',
        'panel.switch': 'Panel',
        'panel.noPanels': 'No panel configured yet. Add one in 设置 → 宝塔面板.',
        'settings.title': 'Baota panel',
        'settings.desc': 'Connect one or more Baota (bt.cn) Linux panels with their API keys.',
        'settings.panels': 'Panels',
        'settings.add': 'Add panel',
        'settings.remove': 'Remove',
        'settings.makeActive': 'Use as current',
        'settings.active': 'Current',
        'settings.name': 'Display name',
        'settings.address': 'Panel address',
        'settings.addressHint': 'Panel root URL with the port. Do not append the security entrance.',
        'settings.key': 'API key',
        'settings.keyHint': '面板设置 → API 接口 → 接口密钥. Leave empty to keep the stored key.',
        'settings.entrance': 'Security entrance',
        'settings.entranceHint': 'Optional. Only needed when the panel requires it for firewall or log routes.',
        'settings.tls': 'Verify the panel certificate',
        'settings.tlsHint': 'The panel serves a self-signed certificate by default; keep this off unless it has a trusted certificate.',
        'settings.sidebar': 'Show in sidebar',
        'settings.sidebarHint': 'Adds the 宝塔面板 icon to the sidebar panel list. A refresh may be needed after saving.',
        'settings.save': 'Save',
        'settings.saving': 'Saving…',
        'settings.autoSaved': 'Saved',
        'settings.newPanel': 'New panel',
        'settings.failed': 'Save failed: {error}',
        'settings.keySet': 'stored, ends with {tail}',
        'settings.empty': 'No panel yet — press “Add panel”.',
      },
      zh: {
        'nav.title': '宝塔面板',
        'panel.title': '宝塔面板',
        'panel.refresh': '刷新',
        'panel.loading': '正在读取面板…',
        'panel.failed': '面板无法访问',
        'panel.hint': '请检查面板地址、API 白名单 IP，以及「设置 → 宝塔面板」。',
        'panel.updated': '更新于 {time}',
        'panel.cpu': 'CPU',
        'panel.memory': '内存',
        'panel.load': '负载',
        'panel.network': '网络',
        'panel.cores': '{count} 核',
        'panel.disk': '磁盘',
        'panel.sites': '网站',
        'panel.databases': '数据库',
        'panel.services': '服务',
        'panel.empty': '暂无数据',
        'panel.running': '运行中',
        'panel.stopped': '已停止',
        'panel.sitesSummary': '{running}/{total} 个运行中',
        'panel.databasesSummary': '共 {total} 个数据库',
        'panel.switch': '面板',
        'panel.noPanels': '还没有配置面板，去「设置 → 宝塔面板」添加一个。',
        'settings.title': '宝塔面板',
        'settings.desc': '用一个接口密钥接管一台或多台宝塔 Linux 面板。',
        'settings.panels': '面板列表',
        'settings.add': '添加面板',
        'settings.remove': '删除',
        'settings.makeActive': '设为当前',
        'settings.active': '当前',
        'settings.name': '显示名称',
        'settings.address': '面板地址',
        'settings.addressHint': '含端口的根地址；不要把安全入口拼进去。',
        'settings.key': '接口密钥',
        'settings.keyHint': '面板设置 → API 接口 → 接口密钥；留空表示不修改已保存的密钥。',
        'settings.entrance': '安全入口',
        'settings.entranceHint': '可选。仅当面板对防火墙、日志这类路由校验入口时才需要填。',
        'settings.tls': '校验面板证书',
        'settings.tlsHint': '面板默认使用自签证书，没有受信任证书时请保持关闭。',
        'settings.sidebar': '显示到侧边栏',
        'settings.sidebarHint': '把「宝塔面板」入口加到侧边栏面板列表；保存后可能需要刷新页面。',
        'settings.save': '保存',
        'settings.saving': '保存中…',
        'settings.autoSaved': '已自动保存',
        'settings.newPanel': '新面板',
        'settings.failed': '保存失败：{error}',
        'settings.keySet': '已保存，尾号 {tail}',
        'settings.empty': '还没有面板 —— 点「添加面板」。',
      },
    }

    /* ----------------------------- Styles ----------------------------- */

    const CSS = `
.bp-root { height:100%; overflow:auto; padding:24px 28px 40px; box-sizing:border-box; color:var(--dsw-alias-label-primary); }
.bp-inner { max-width:1040px; margin:0 auto; display:flex; flex-direction:column; gap:18px; }
.bp-head { display:flex; align-items:flex-start; gap:12px; }
.bp-head h1 { margin:0; font-size:19px; font-weight:600; letter-spacing:.01em; }
.bp-sub { margin:4px 0 0; font-size:12.5px; color:var(--dsw-alias-label-secondary); }
.bp-head-actions { margin-left:auto; display:flex; gap:8px; align-items:center; }
.bp-btn { appearance:none; border:.5px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary);
  font:inherit; font-size:13px; line-height:1; padding:7px 12px; border-radius:8px; cursor:pointer; }
.bp-btn:hover:not(:disabled) { background:var(--dsw-alias-bg-layer-2); }
.bp-btn:disabled { opacity:.55; cursor:default; }
.bp-btn-primary { border-color:var(--dsw-alias-brand-primary); color:var(--dsw-alias-brand-primary); }
.bp-btn-danger { color:var(--dsw-alias-state-error-primary); }
.bp-select { font:inherit; font-size:13px; padding:6px 10px; border-radius:8px; color:var(--dsw-alias-label-primary);
  background:var(--dsw-alias-bg-layer-1); border:.5px solid var(--dsw-alias-border-l2); }
.bp-banner { border-radius:10px; padding:12px 14px; font-size:13px; line-height:1.6;
  border:.5px solid var(--dsw-alias-state-error-primary); color:var(--dsw-alias-state-error-primary); }
.bp-banner ul { margin:6px 0 0; padding-left:18px; }
.bp-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:12px; }
.bp-card { border:.5px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); border-radius:12px; padding:14px 16px; min-width:0; }
.bp-card h2 { margin:0 0 10px; font-size:13px; font-weight:600; color:var(--dsw-alias-label-secondary); letter-spacing:.02em; }
.bp-metric { font-size:24px; font-weight:600; line-height:1.2; }
.bp-metric small { font-size:12px; font-weight:400; color:var(--dsw-alias-label-secondary); margin-left:6px; }
.bp-bar { height:4px; border-radius:2px; background:var(--dsw-alias-bg-layer-2); margin-top:10px; overflow:hidden; }
.bp-bar > i { display:block; height:100%; background:var(--dsw-alias-brand-primary); border-radius:2px; }
.bp-list { display:flex; flex-direction:column; gap:8px; }
.bp-row { display:flex; align-items:center; gap:10px; font-size:13px; min-width:0; }
.bp-row .bp-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.bp-row .bp-tail { margin-left:auto; color:var(--dsw-alias-label-secondary); font-size:12px; flex:none; }
.bp-dot { width:7px; height:7px; border-radius:50%; flex:none; background:var(--dsw-alias-state-idle-primary); }
.bp-dot-on { background:var(--dsw-alias-state-success-primary); }
.bp-muted { color:var(--dsw-alias-label-secondary); font-size:12.5px; }
.bp-chips { display:flex; flex-wrap:wrap; gap:6px; }
.bp-chip { font-size:12px; padding:3px 8px; border-radius:999px; background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-secondary); }
.bp-chip-on { color:var(--dsw-alias-state-success-primary); }
.bp-settings { display:flex; flex-direction:column; gap:18px; max-width:640px; }
.bp-field { display:flex; flex-direction:column; gap:6px; }
.bp-field > label { font-size:13px; font-weight:600; }
.bp-input { font:inherit; font-size:13px; padding:8px 10px; border-radius:8px; color:var(--dsw-alias-label-primary);
  background:var(--dsw-alias-bg-layer-1); border:.5px solid var(--dsw-alias-border-l2); width:100%; box-sizing:border-box; }
.bp-toggle { display:flex; align-items:flex-start; gap:10px; }
.bp-switch { position:relative; width:34px; height:20px; border-radius:999px; border:.5px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-bg-layer-2); cursor:pointer; flex:none; padding:0; transition:background .15s ease; }
.bp-switch[aria-checked="true"] { background:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); }
.bp-switch > span { position:absolute; top:2px; left:2px; width:15px; height:15px; border-radius:50%; background:#fff;
  transition:transform .15s ease; }
.bp-switch[aria-checked="true"] > span { transform:translateX(14px); }
.bp-hint { font-size:12px; line-height:1.55; color:var(--dsw-alias-label-secondary); margin:0; }
.bp-save-row { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.bp-ok { color:var(--dsw-alias-state-success-primary); font-size:12.5px; }
.bp-err { color:var(--dsw-alias-state-error-primary); font-size:12.5px; }
.bp-panel-row { display:flex; align-items:center; gap:10px; padding:10px 12px; border-radius:10px; cursor:pointer;
  border:.5px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); }
.bp-panel-row[data-selected="true"] { border-color:var(--dsw-alias-brand-primary); }
.bp-panel-row .bp-host { color:var(--dsw-alias-label-secondary); font-size:12px; }
.bp-badge { font-size:11px; padding:2px 7px; border-radius:999px; background:var(--dsw-alias-bg-layer-2);
  color:var(--dsw-alias-label-secondary); }
.bp-badge-on { color:var(--dsw-alias-state-success-primary); }
`

    /* --------------------------- Components --------------------------- */

    const gb = (value) => {
      if (!Number.isFinite(value) || value <= 0) return '—'
      return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`
    }
    /** The panel reports live throughput in KB/s. */
    const kb = (value) => {
      if (!Number.isFinite(value)) return '—'
      if (value >= 1024) return `${(value / 1024).toFixed(1)} MB/s`
      return `${value.toFixed(1)} KB/s`
    }
    const pct = (value) => (Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0)

    /** Sidebar icon: a pagoda silhouette, tinted by the shell's current color. */
    function BaotaIcon({ size = 20 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('path', { d: 'M12 3l7 3.2H5L12 3z' }),
        h('path', { d: 'M12 6.2l5 2.6H7l5-2.6z' }),
        h('path', { d: 'M9.5 8.8v10.4M14.5 8.8v10.4' }),
        h('path', { d: 'M8.5 19.6h7' }),
        h('path', { d: 'M11 11.4h2v2.4h-2z' }),
      )
    }

    const apiHolder = { current: null }
    /** Shown in the page footer so the running bundle version is identifiable. */
    const PLUGIN_VERSION = '0.7.1'

    /**
     * The Remote carrier may hand a business result back inside `{ value }`.
     * Unwrap it so callers always see the value the Host method returned.
     */
    /** Fire-and-forget diagnostics: the Host writes these into the DSH log. */
    const note = (message) => {
      try {
        const api = apiHolder.current
        if (api !== null && typeof api.trace === 'function') api.trace(String(message)).catch(() => {})
      } catch {
        // diagnostics never break the page
      }
    }

    const unwrap = (result) => {
      let current = result
      for (let depth = 0; depth < 3; depth += 1) {
        if (current === null || typeof current !== 'object' || Array.isArray(current)) return current
        const keys = Object.keys(current)
        if (keys.length !== 1 || keys[0] !== 'value') return current
        current = current.value
      }
      return current
    }

    /**
     * A throwing component blanks its slot, which reads as "nothing happened".
     * Catch render errors here and show the message instead, so a broken panel
     * is diagnosable from the page itself.
     */
    class Guard extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      render() {
        const error = this.state.error
        if (error === null) return this.props.children
        const text = error && error.stack ? error.stack : String(error)
        return h(
          'div',
          { className: 'bp-root' },
          h(
            'div',
            { className: 'bp-inner' },
            h(
              'div',
              { className: 'bp-banner' },
              h('strong', null, '宝塔面板渲染出错 / panel render failed'),
              h('pre', { style: { whiteSpace: 'pre-wrap', margin: '8px 0 0', fontSize: 12 } }, text.slice(0, 2000)),
            ),
          ),
        )
      }
    }

    function Metric({ label, value, sub, ratio }) {
      return h(
        'div',
        { className: 'bp-card' },
        h('h2', null, label),
        h('div', { className: 'bp-metric' }, value, sub === undefined ? null : h('small', null, sub)),
        ratio === undefined ? null : h('div', { className: 'bp-bar' }, h('i', { style: { width: `${pct(ratio)}%` } })),
      )
    }

    function Section({ title, summary, children }) {
      return h(
        'div',
        { className: 'bp-card' },
        h(
          'h2',
          { style: { display: 'flex', gap: 8, alignItems: 'baseline' } },
          title,
          summary === undefined ? null : h('span', { style: { marginLeft: 'auto', fontWeight: 400 } }, summary),
        ),
        children,
      )
    }

    function MainPanel({ t }) {
      const [panels, setPanels] = useState([])
      const [panelId, setPanelId] = useState('')
      const [state, setState] = useState({ loading: true, data: undefined, error: undefined })

      const load = useCallback(
        async (id) => {
          const api = apiHolder.current
          if (api === null) {
            setState({ loading: false, data: undefined, error: 'remote-unavailable' })
            return
          }
          setState((current) => ({ ...current, loading: true }))
          try {
            const config = unwrap(await api.config())
            const list = Array.isArray(config?.panels) ? config.panels : []
            setPanels(list)
            const nextId = id ?? (config?.activePanel !== '' && list.some((panel) => panel.id === config.activePanel)
              ? config.activePanel
              : list[0]?.id ?? '')
            setPanelId(nextId)
            if (nextId === '') {
              setState({ loading: false, data: undefined, error: undefined })
              return
            }
            const data = unwrap(await api.overview(nextId))
            setState({ loading: false, data, error: undefined })
          } catch (error) {
            setState({ loading: false, data: undefined, error: error && error.message ? error.message : String(error) })
          }
        },
        [],
      )

      useEffect(() => {
        load()
      }, [load])

      const switchTo = (event) => {
        const next = event.target.value
        setPanelId(next)
        load(next)
      }

      const data = state.data
      const header = h(
        'div',
        { className: 'bp-head' },
        h(
          'div',
          null,
          h('h1', null, t('panel.title')),
          h(
            'p',
            { className: 'bp-sub' },
            data === undefined
              ? state.loading
                ? t('panel.loading')
                : ''
              : `${data.panel?.name ?? ''}${data.panel?.host ? ` · ${data.panel.host}` : ''} · ${t('panel.updated', {
                  time: new Date(data.crawledAt).toLocaleTimeString(),
                })}`,
          ),
        ),
        h(
          'div',
          { className: 'bp-head-actions' },
          panels.length > 1
            ? h(
                'select',
                { className: 'bp-select', value: panelId, onChange: switchTo, 'aria-label': t('panel.switch') },
                panels.map((panel) => h('option', { key: panel.id, value: panel.id }, panel.name)),
              )
            : null,
          h('button', { className: 'bp-btn', onClick: () => load(panelId), disabled: state.loading }, t('panel.refresh')),
        ),
      )

      if (panels.length === 0 && !state.loading) {
        return h('div', { className: 'bp-root' }, h('div', { className: 'bp-inner' }, header, h('p', { className: 'bp-muted' }, t('panel.noPanels'))))
      }

      if (state.error !== undefined) {
        return h(
          'div',
          { className: 'bp-root' },
          h(
            'div',
            { className: 'bp-inner' },
            header,
            h(
              'div',
              { className: 'bp-banner' },
              h('strong', null, t('panel.failed')),
              h('div', { style: { marginTop: 4 } }, state.error),
              h('div', { style: { marginTop: 6 } }, t('panel.hint')),
            ),
          ),
        )
      }

      if (data === undefined) {
        return h('div', { className: 'bp-root' }, h('div', { className: 'bp-inner' }, header))
      }

      const system = data.system || {}
      const load3 = data.load || {}
      const metrics = h(
        'div',
        { className: 'bp-grid' },
        h(Metric, {
          label: t('panel.cpu'),
          value: Number.isFinite(system.cpuUsedPercent) ? `${system.cpuUsedPercent}%` : '—',
          sub: Number.isFinite(system.cpuNum) ? t('panel.cores', { count: system.cpuNum }) : undefined,
          ratio: system.cpuUsedPercent,
        }),
        h(Metric, {
          label: t('panel.memory'),
          value: Number.isFinite(system.memUsedPercent) ? `${system.memUsedPercent}%` : '—',
          sub: Number.isFinite(system.memUsed) ? `${gb(system.memUsed * 1024 * 1024)} / ${gb(system.memTotal * 1024 * 1024)}` : undefined,
          ratio: system.memUsedPercent,
        }),
        h(Metric, {
          label: t('panel.load'),
          value: Number.isFinite(load3.one) ? String(load3.one) : '—',
          sub: Number.isFinite(load3.five) ? `${load3.five} / ${load3.fifteen}` : undefined,
        }),
        h(Metric, {
          label: t('panel.network'),
          value: data.network === undefined ? '—' : `↑ ${kb(data.network.up)}`,
          sub: data.network === undefined ? undefined : `↓ ${kb(data.network.down)}`,
        }),
      )

      const disks = (data.disks || []).length === 0
        ? h('p', { className: 'bp-muted' }, t('panel.empty'))
        : h(
            'div',
            { className: 'bp-list' },
            (data.disks || []).map((disk, index) =>
              h(
                'div',
                { key: index, className: 'bp-row' },
                h('span', { className: 'bp-name' }, disk.path),
                h('span', { className: 'bp-tail' }, `${disk.usedLabel} / ${disk.totalLabel} · ${disk.usedPercent}%`),
                h('div', { className: 'bp-bar', style: { width: 90, marginTop: 0 } }, h('i', { style: { width: `${pct(disk.usedPercent)}%` } })),
              ),
            ),
          )

      const sites = data.sites || { total: 0, running: 0, items: [] }
      const siteRows = (sites.items || []).length === 0
        ? h('p', { className: 'bp-muted' }, sites.error || t('panel.empty'))
        : h(
            'div',
            { className: 'bp-list' },
            (sites.items || []).map((site, index) =>
              h(
                'div',
                { key: site.id ?? index, className: 'bp-row' },
                h('span', { className: site.status ? 'bp-dot bp-dot-on' : 'bp-dot' }),
                h('span', { className: 'bp-name' }, site.name),
                h('span', { className: 'bp-tail' }, site.status ? t('panel.running') : t('panel.stopped')),
              ),
            ),
          )

      const databases = data.databases || { total: 0, items: [] }
      const databaseRows = (databases.items || []).length === 0
        ? h('p', { className: 'bp-muted' }, databases.error || t('panel.empty'))
        : h(
            'div',
            { className: 'bp-list' },
            (databases.items || []).map((database, index) =>
              h(
                'div',
                { key: index, className: 'bp-row' },
                h('span', { className: 'bp-name' }, database.name),
                h('span', { className: 'bp-tail' }, database.type || ''),
              ),
            ),
          )

      const services = (data.services || []).length === 0
        ? h('p', { className: 'bp-muted' }, t('panel.empty'))
        : h(
            'div',
            { className: 'bp-chips' },
            (data.services || []).map((service, index) =>
              h(
                'span',
                { key: index, className: service.running ? 'bp-chip bp-chip-on' : 'bp-chip' },
                service.version === '' || service.version === undefined ? service.name : `${service.name} ${service.version}`,
              ),
            ),
          )

      return h(
        'div',
        { className: 'bp-root' },
        h(
          'div',
          { className: 'bp-inner' },
          header,
          (data.errors || []).length === 0
            ? null
            : h(
                'div',
                { className: 'bp-banner' },
                h('strong', null, t('panel.failed')),
                h('ul', null, data.errors.map((message, index) => h('li', { key: index }, message))),
                h('div', { style: { marginTop: 6 } }, t('panel.hint')),
              ),
          metrics,
          h(Section, { title: t('panel.disk') }, disks),
          h(
            'div',
            { className: 'bp-grid' },
            h(
              Section,
              { title: t('panel.sites'), summary: t('panel.sitesSummary', { running: sites.running ?? 0, total: sites.total ?? 0 }) },
              siteRows,
            ),
            h(
              Section,
              { title: t('panel.databases'), summary: t('panel.databasesSummary', { total: databases.total ?? 0 }) },
              databaseRows,
            ),
          ),
          h(Section, { title: t('panel.services') }, services),
          h('p', { className: 'bp-hint', style: { opacity: 0.6 } }, `dsh-baota-panel v${PLUGIN_VERSION}`),
        ),
      )
    }

    function SettingsPage({ t }) {
      const [rows, setRows] = useState([])
      const [selected, setSelected] = useState('')
      const [activePanel, setActivePanel] = useState('')
      const [showInSidebar, setShowInSidebar] = useState(true)
      const [ready, setReady] = useState(false)
      const [state, setState] = useState({ saving: false, error: '', savedAt: 0 })
      const timer = useRef(null)
      const pending = useRef(new Map())
      const drafts = useRef(0)

      const applyConfig = useCallback((config) => {
        const list = (Array.isArray(config?.panels) ? config.panels : []).map((panel) => ({
          key: panel.id,
          id: panel.id,
          name: panel.name ?? '',
          panelUrl: panel.panelUrl ?? '',
          apiKey: '',
          keyTail: panel.apiKeyTail ?? '',
          hasApiKey: panel.hasApiKey === true,
          securityEntrance: panel.securityEntrance ?? '',
          verifyTls: panel.verifyTls === true,
        }))
        setRows(list)
        setActivePanel(config?.activePanel ?? '')
        setShowInSidebar(config?.showInSidebar !== false)
        setSelected((current) => (list.some((row) => row.key === current) ? current : list[0]?.key ?? ''))
      }, [])

      useEffect(() => {
        const api = apiHolder.current
        if (api === null) {
          setState({ saving: false, error: 'remote-unavailable', savedAt: 0 })
          setReady(true)
          return
        }
        api
          .config()
          .then((value) => {
            const plain = unwrap(value)
            note(`settings config keys=${plain === null || typeof plain !== 'object' ? String(plain) : Object.keys(plain).join('|')} panels=${Array.isArray(plain?.panels) ? plain.panels.length : 'none'}`)
            applyConfig(plain)
            setReady(true)
          })
          .catch((error) => {
            note(`settings config failed: ${error && error.message ? error.message : String(error)}`)
            setState({ saving: false, error: error && error.message ? error.message : String(error), savedAt: 0 })
            setReady(true)
          })
      }, [applyConfig])

      useEffect(
        () => () => {
          if (timer.current !== null) clearTimeout(timer.current)
        },
        [],
      )

      const run = useCallback(
        async (operation) => {
          const api = apiHolder.current
          if (api === null) return
          setState((current) => ({ ...current, saving: true, error: '' }))
          try {
            const result = unwrap(await operation(api))
            if (result && result.ok === false) throw new Error(result.error ?? '保存失败')
            // A write always ends with the authoritative list: trust the returned
            // config, and re-read when a build answers without one, so the editor
            // can never drift from what the Host actually stored.
            const next = result && result.config !== undefined ? result.config : unwrap(await api.config())
            applyConfig(next)
            note(`run ok rows=${Array.isArray(next?.panels) ? next.panels.length : 'none'}`)
            setState({ saving: false, error: '', savedAt: Date.now() })
          } catch (error) {
            let reason = error && error.message ? error.message : String(error)
            try {
              applyConfig(unwrap(await api.config()))
            } catch {
              // keep the original reason
            }
            note(`run failed: ${reason}`)
            setState({ saving: false, error: reason, savedAt: 0 })
          }
        },
        [applyConfig],
      )

      /** Field edits are coalesced per panel and flushed shortly after typing stops. */
      const queue = useCallback(
        (id, patch) => {
          setRows((list) => list.map((row) => (row.key === id ? { ...row, ...patch } : row)))
          const merged = { ...(pending.current.get(id) ?? {}), ...patch }
          pending.current.set(id, merged)
          if (timer.current !== null) clearTimeout(timer.current)
          timer.current = setTimeout(() => {
            timer.current = null
            const entries = [...pending.current]
            pending.current.clear()
            if (entries.length === 0) return
            run(async (api) => {
              let last
              for (const [panelId, panelPatch] of entries) {
                last = await api.updatePanel({ id: panelId, patch: panelPatch })
                if (last && last.ok === false) return last
              }
              return last
            })
          }, 450)
        },
        [run],
      )

      const flushNow = useCallback(() => {
        if (pending.current.size === 0) return
        if (timer.current !== null) clearTimeout(timer.current)
        timer.current = null
        const entries = [...pending.current]
        pending.current.clear()
        run(async (api) => {
          let last
          for (const [panelId, panelPatch] of entries) {
            last = await api.updatePanel({ id: panelId, patch: panelPatch })
            if (last && last.ok === false) return last
          }
          return last
        })
      }, [run])

      const current = rows.find((row) => row.key === selected)

      /** A new row is a local draft; it is stored once it has an address. */
      const addRow = () => {
        drafts.current += 1
        const key = `draft-${drafts.current}`
        setRows((list) => [
          ...list,
          {
            key,
            id: '',
            isDraft: true,
            name: t('settings.newPanel'),
            panelUrl: '',
            apiKey: '',
            keyTail: '',
            hasApiKey: false,
            securityEntrance: '',
            verifyTls: false,
          },
        ])
        setSelected(key)
      }

      const removeRow = () => {
        if (current === undefined) return
        if (current.isDraft === true) {
          const next = rows.filter((row) => row.key !== current.key)
          setRows(next)
          setSelected(next[0]?.key ?? '')
          return
        }
        run(async (api) => api.removePanel(current.id))
      }

      const makeActive = () => {
        if (current === undefined) return
        run(async (api) => api.activatePanel(current.id))
      }

      const toggleSidebar = () =>
        run(async (api) => api.setShowInSidebar(!showInSidebar))

      const patchRow = (patch) => {
        if (current === undefined) return
        const next = { ...current, ...patch }
        setRows((list) => list.map((row) => (row.key === current.key ? next : row)))
        if (current.isDraft === true) {
          if (String(next.panelUrl ?? '').trim() === '') return
          run(async (api) => {
            const result = unwrap(await api.addPanel({
              name: next.name,
              panelUrl: next.panelUrl,
              apiKey: next.apiKey,
              securityEntrance: next.securityEntrance,
              verifyTls: next.verifyTls,
            }))
            const wanted = String(next.panelUrl).trim().replace(/\/+$/, '')
            const created = (result?.config?.panels ?? []).find((panel) => panel.panelUrl === wanted)
            if (created !== undefined) setSelected(created.id)
            return result
          })
          return
        }
        queue(current.id, patch)
      }

      const switchRow = (label, hint, checked, onToggle) =>
        h(
          'div',
          { className: 'bp-field' },
          h(
            'div',
            { className: 'bp-toggle' },
            h(
              'button',
              { type: 'button', className: 'bp-switch', role: 'switch', 'aria-checked': checked ? 'true' : 'false', 'aria-label': label, onClick: onToggle },
              h('span'),
            ),
            h('div', null, h('label', { style: { display: 'block', marginBottom: 3 } }, label), h('p', { className: 'bp-hint' }, hint)),
          ),
        )

      const status = state.error !== ''
        ? h('span', { className: 'bp-err' }, t('settings.failed', { error: state.error }))
        : state.saving
          ? h('span', { className: 'bp-muted' }, t('settings.saving'))
          : state.savedAt > 0
            ? h('span', { className: 'bp-ok' }, t('settings.autoSaved'))
            : null

      return h(
        'div',
        { className: 'bp-settings' },
        h(
          'div',
          null,
          h('h2', { style: { margin: '0 0 6px', fontSize: 16 } }, t('settings.title')),
          h('p', { className: 'bp-hint' }, t('settings.desc')),
        ),
        h(
          'div',
          { className: 'bp-field' },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'baseline', gap: 10 } },
            h('label', null, t('settings.panels')),
            h('span', { style: { marginLeft: 'auto' } }, status),
          ),
          rows.length === 0
            ? h('p', { className: 'bp-hint' }, t('settings.empty'))
            : h(
                'div',
                { className: 'bp-list' },
                rows.map((row) =>
                  h(
                    'div',
                    {
                      key: row.key,
                      className: 'bp-panel-row',
                      'data-selected': row.key === selected ? 'true' : 'false',
                      onClick: () => {
                        flushNow()
                        setSelected(row.key)
                      },
                      role: 'button',
                      tabIndex: 0,
                    },
                    h('span', { className: row.panelUrl === '' ? 'bp-dot' : 'bp-dot bp-dot-on' }),
                    h(
                      'div',
                      { style: { minWidth: 0 } },
                      h('div', { className: 'bp-name' }, row.name.trim() === '' ? row.panelUrl || t('settings.newPanel') : row.name),
                      h('div', { className: 'bp-host' }, row.panelUrl || '—'),
                    ),
                    row.id === activePanel ? h('span', { className: 'bp-badge bp-badge-on' }, t('settings.active')) : null,
                  ),
                ),
              ),
          h(
            'div',
            { className: 'bp-save-row', style: { marginTop: 8 } },
            h('button', { className: 'bp-btn bp-btn-primary', onClick: addRow, disabled: !ready }, t('settings.add')),
            h('button', { className: 'bp-btn', onClick: makeActive, disabled: current === undefined }, t('settings.makeActive')),
            h('button', { className: 'bp-btn bp-btn-danger', onClick: removeRow, disabled: current === undefined }, t('settings.remove')),
          ),
        ),
        current === undefined
          ? null
          : h(
              React.Fragment,
              null,
              h(
                'div',
                { className: 'bp-field' },
                h('label', null, t('settings.name')),
                h('input', {
                  className: 'bp-input',
                  value: current.name,
                  onChange: (event) => patchRow({ name: event.target.value }),
                  onBlur: flushNow,
                }),
              ),
              h(
                'div',
                { className: 'bp-field' },
                h('label', null, t('settings.address')),
                h('input', {
                  className: 'bp-input',
                  value: current.panelUrl,
                  onChange: (event) => patchRow({ panelUrl: event.target.value }),
                  onBlur: flushNow,
                  placeholder: 'https://panel.example.com:4439',
                  spellCheck: false,
                }),
                h('p', { className: 'bp-hint' }, t('settings.addressHint')),
              ),
              h(
                'div',
                { className: 'bp-field' },
                h('label', null, t('settings.key')),
                h('input', {
                  className: 'bp-input',
                  type: 'password',
                  value: current.apiKey,
                  onChange: (event) => patchRow({ apiKey: event.target.value }),
                  onBlur: flushNow,
                  placeholder: current.hasApiKey ? t('settings.keySet', { tail: current.keyTail }) : '',
                  spellCheck: false,
                }),
                h('p', { className: 'bp-hint' }, t('settings.keyHint')),
              ),
              h(
                'div',
                { className: 'bp-field' },
                h('label', null, t('settings.entrance')),
                h('input', {
                  className: 'bp-input',
                  value: current.securityEntrance,
                  onChange: (event) => patchRow({ securityEntrance: event.target.value }),
                  onBlur: flushNow,
                  placeholder: 'ghostxx',
                  spellCheck: false,
                }),
                h('p', { className: 'bp-hint' }, t('settings.entranceHint')),
              ),
              switchRow(t('settings.tls'), t('settings.tlsHint'), current.verifyTls, () => patchRow({ verifyTls: !current.verifyTls })),
            ),
        switchRow(t('settings.sidebar'), t('settings.sidebarHint'), showInSidebar, toggleSidebar),
        h('p', { className: 'bp-hint', style: { opacity: 0.6 } }, `dsh-baota-panel v${PLUGIN_VERSION}`),
      )
    }

    /* ------------------------- Registration --------------------------- */

    async function apply(ctx) {
      ctx.effect(() => ctx.locale.register('dshBaota', { en: DICT.en, zh: DICT.zh }), 'dsh-baota-panel: locale')
      const bound = ctx.locale.bind('dshBaota')
      const t = (key, params) => {
        try {
          const value = bound(key, params)
          return typeof value === 'string' ? value : key
        } catch {
          return key
        }
      }

      ctx.effect(() => {
        const style = document.createElement('style')
        style.dataset.dshBaotaPanel = 'true'
        style.textContent = CSS
        document.head.append(style)
        return () => style.remove()
      }, 'dsh-baota-panel: styles')

      let config = { panels: [], showInSidebar: true, configured: false }
      try {
        const remote = ctx.get('remote')
        await remote.$mount(REMOTE)
        const api = ctx.get('remote.baota')
        if (api !== undefined && api !== null) {
          apiHolder.current = api
          config = { ...config, ...unwrap(await api.config()) }
        }
      } catch (error) {
        // A missing remote must not blank the shell: the settings page reports it.
        apiHolder.current = null
        console.warn('dsh-baota-panel: remote unavailable', error)
      }

      if (config.showInSidebar !== false) {
        ctx.effect(
          () =>
            ctx.slots.inject('sidebar.panellist', () =>
              ctx.slots.register(
                { name: 'sidebar.panellist', id: 'baota', order: 8, label: () => t('nav.title') },
                (props) => h(BaotaIcon, { size: props && Number.isFinite(props.size) ? props.size : 20 }),
              ),
            ),
          'dsh-baota-panel: sidebar entry',
        )
        ctx.effect(
          () =>
            ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'baota' }, () => h(Guard, null, h(MainPanel, { t })))),
          'dsh-baota-panel: main panel',
        )
      }

      ctx.effect(
        () =>
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              { name: 'settings.section', id: 'baota', order: 30, label: () => t('settings.title') },
              () => h(Guard, null, h(SettingsPage, { t })),
            ),
          ),
        'dsh-baota-panel: settings section',
      )
    }

    return { name: 'dsh-baota-panel', inject: ['slots', 'locale', 'remote'], apply }
  },
})
