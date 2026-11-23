/**
 * Host half of dsh-baota-panel.
 *
 * Two faces over one set of panel operations:
 *  - Agent tools (`ctx.tools`) so the model can inspect and change any configured panel.
 *  - A `baota` Host service exposed to the browser half through the typert
 *    Remote channel (`ctx.remote.baota.*`), which drives the sidebar panel.
 *
 * Multiple panels: `config.panels` is a list. Every tool and Remote method takes
 * an optional `panel` (id or name) and defaults to the active panel.
 *
 * Endpoint notes (verified against Baota Linux panel 13.2.0):
 *  - The API lives at the panel root; the security entrance is only needed as a
 *    Referer for a few session-guarded routes, never as a URL prefix.
 *  - Website/database/log lists come from `/data?action=getData&table=...`.
 *  - `/firewall` and `/logs` route handlers demand a browser login session on
 *    some builds; those tools report the panel's own message instead of hiding it.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { BaotaClient } from './bt-api.js'

export const name = 'dsh-baota-panel'
export const inject = ['tools']

const MAX_FILE_CHARS = 200000
const MAX_LOG_CHARS = 20000

/* ------------------------------------------------------------------ */
/* Remote contract — the browser half repeats these descriptors.       */
/* ------------------------------------------------------------------ */

const jsonCodec = (symbol) => ({
  mode: 'strict',
  typeSymbol: `dsh-baota-panel#${symbol}`,
  create: () => ({ parse: (value) => value }),
})

const optionalString = (value) => {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error('Expected a string')
  return value
}

const parseSettings = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a settings object')
  const out = {}
  if (Array.isArray(value.panels)) {
    out.panels = value.panels.map((panel) => {
      if (panel === null || typeof panel !== 'object') throw new Error('Expected panel objects')
      const next = {
        id: typeof panel.id === 'string' && panel.id !== '' ? panel.id : undefined,
        name: typeof panel.name === 'string' ? panel.name : '',
        panelUrl: typeof panel.panelUrl === 'string' ? panel.panelUrl.trim() : '',
        apiKey: typeof panel.apiKey === 'string' ? panel.apiKey.trim() : '',
        securityEntrance: typeof panel.securityEntrance === 'string' ? panel.securityEntrance.trim() : '',
        verifyTls: panel.verifyTls === true,
      }
      if (next.id === undefined) delete next.id
      return next
    })
  }
  if (typeof value.activePanel === 'string') out.activePanel = value.activePanel
  if (typeof value.showInSidebar === 'boolean') out.showInSidebar = value.showInSidebar
  return out
}

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

export const BAOTA_DESCRIPTORS = Object.freeze([
  remoteMethod('config'),
  remoteMethod('overview', [{ wire: 'panel', symbol: 'PanelRef' }]),
  remoteMethod('sites', [{ wire: 'panel', symbol: 'PanelRef' }]),
  remoteMethod('databases', [{ wire: 'panel', symbol: 'PanelRef' }]),
  remoteMethod('services', [{ wire: 'panel', symbol: 'PanelRef' }]),
  remoteMethod('refresh'),
  remoteMethod('saveSettings', [{ wire: 'settings', symbol: 'Settings' }]),
])

const BAOTA_REMOTE = Object.freeze({ package: 'dsh-baota-panel', descriptors: BAOTA_DESCRIPTORS })

/* ------------------------------------------------------------------ */
/* Normalisation helpers                                               */
/* ------------------------------------------------------------------ */

const num = (value) => {
  const parsed = typeof value === 'string' ? Number.parseFloat(value) : value
  return Number.isFinite(parsed) ? parsed : undefined
}

const percent = (used, total) => {
  const u = num(used)
  const t = num(total)
  if (u === undefined || t === undefined || t <= 0) return undefined
  return Math.round((u / t) * 1000) / 10
}

/** `page` is an HTML pagination fragment such as `…共4条…`; pull the total out. */
const pageTotal = (page) => {
  if (typeof page !== 'string') return undefined
  const match = /共\s*(\d+)\s*条/.exec(page)
  return match === null ? undefined : Number.parseInt(match[1], 10)
}

const rows = (payload) => (Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [])

function normalizeSites(payload) {
  return rows(payload).map((row) => ({
    id: row.id ?? undefined,
    name: row.name ?? '',
    path: row.path ?? '',
    status: String(row.status) === '1',
    ps: row.ps ?? '',
    addtime: row.addtime ?? '',
    projectType: row.project_type ?? '',
  }))
}

function normalizeDatabases(payload) {
  return rows(payload).map((row) => ({
    id: row.id ?? undefined,
    name: row.name ?? '',
    username: row.username ?? '',
    type: row.type ?? '',
    ps: row.ps ?? '',
  }))
}

function normalizeLogs(payload) {
  return rows(payload).map((row) => ({
    id: row.id ?? undefined,
    user: row.username ?? '',
    type: row.type ?? '',
    log: row.log ?? '',
    at: row.addtime ?? '',
  }))
}

/** Crontab rows carry ~40 columns; keep the ones an operator reads. */
function normalizeCrontab(payload) {
  return rows(payload).map((row) => ({
    id: row.id ?? undefined,
    name: row.name ?? '',
    type: row.type ?? '',
    cycle: row.cycle ?? row.type_zh ?? '',
    command: row.sBody ?? '',
    shellType: row.sType ?? '',
    status: Number(row.status) === 1,
    at: row.addtime ?? '',
  }))
}

/** The panel exposes installed software through GetConcifInfo; drop secrets. */
function normalizeServices(conf) {
  const list = []
  const web = conf?.web
  if (web && web.setup !== false) {
    list.push({ name: web.type ?? conf?.webserver ?? 'web', version: String(web.version ?? ''), running: web.status === true })
  }
  const mysql = conf?.mysql
  if (mysql && mysql.setup !== false) {
    list.push({ name: 'mysql', version: String(mysql.version ?? ''), running: mysql.status === true })
  }
  for (const php of Array.isArray(conf?.php) ? conf.php : []) {
    if (php?.setup === false) continue
    list.push({ name: `php-${php.version}`, version: String(php.version ?? ''), running: php.status === true })
  }
  return list
}

/* ------------------------------------------------------------------ */
/* Panel list                                                          */
/* ------------------------------------------------------------------ */

const slug = (value, fallback) => {
  const base = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return base === '' ? fallback : base.slice(0, 32)
}

/** Read the configured panels, accepting the single-panel shape older rows used. */
function readPanels(raw) {
  const normalize = (panel, index) => {
    const panelUrl = String(panel.panelUrl ?? '').trim().replace(/\/+$/, '')
    const name = String(panel.name ?? '').trim()
    return {
      id: String(panel.id ?? '').trim() || slug(name, `panel-${index + 1}`),
      name: name === '' ? panelUrl : name,
      panelUrl,
      apiKey: String(panel.apiKey ?? '').trim(),
      securityEntrance: String(panel.securityEntrance ?? '').trim(),
      verifyTls: panel.verifyTls === true,
    }
  }
  if (Array.isArray(raw.panels) && raw.panels.length > 0) return raw.panels.map(normalize)
  if (String(raw.panelUrl ?? '').trim() !== '') {
    return [normalize({ id: 'default', name: raw.name ?? '默认面板', panelUrl: raw.panelUrl, apiKey: raw.apiKey, securityEntrance: raw.securityEntrance, verifyTls: raw.verifyTls }, 0)]
  }
  return []
}

const describePanel = (panel) => ({
  id: panel.id,
  name: panel.name,
  panelUrl: panel.panelUrl,
  panelHost: (() => {
    try {
      return new URL(panel.panelUrl).host
    } catch {
      return ''
    }
  })(),
  hasApiKey: panel.apiKey !== '',
  apiKeyTail: panel.apiKey === '' ? '' : panel.apiKey.slice(-4),
  securityEntrance: panel.securityEntrance,
  verifyTls: panel.verifyTls,
  configured: panel.panelUrl !== '' && panel.apiKey !== '',
})

/* ------------------------------------------------------------------ */
/* Plugin                                                              */
/* ------------------------------------------------------------------ */

export function apply(ctx, rawConfig = {}) {
  const config = {
    panels: readPanels(rawConfig),
    activePanel: String(rawConfig.activePanel ?? ''),
    showInSidebar: rawConfig.showInSidebar !== false,
    requestTimeoutMs: Number.isFinite(rawConfig.requestTimeoutMs) ? rawConfig.requestTimeoutMs : 20000,
  }
  const clients = new Map()
  const overviewCaches = new Map()

  const activeOf = () => config.panels.find((panel) => panel.id === config.activePanel) ?? config.panels[0]

  const resolvePanel = (ref) => {
    if (config.panels.length === 0) {
      throw new Error('尚未配置宝塔面板：请在「设置 → 宝塔面板」添加，或调用 bt_config action=add')
    }
    if (ref === undefined || ref === null || ref === '') return activeOf()
    const wanted = String(ref).trim()
    const found =
      config.panels.find((panel) => panel.id === wanted) ??
      config.panels.find((panel) => panel.name === wanted) ??
      config.panels.find((panel) => panel.panelUrl === wanted) ??
      config.panels.find((panel) => panel.name.toLowerCase() === wanted.toLowerCase())
    if (found === undefined) {
      throw new Error(`未找到面板 ${wanted}；可用：${config.panels.map((panel) => `${panel.id}(${panel.name})`).join('、')}`)
    }
    return found
  }

  const clientFor = (panel) => {
    let client = clients.get(panel.id)
    if (client === undefined || client.panelUrl !== panel.panelUrl || client.apiKey !== panel.apiKey) {
      client = new BaotaClient({
        panelUrl: panel.panelUrl,
        apiKey: panel.apiKey,
        securityEntrance: panel.securityEntrance,
        verifyTls: panel.verifyTls,
        requestTimeoutMs: config.requestTimeoutMs,
      })
      clients.set(panel.id, client)
    }
    return client
  }

  const call = (panelRef, moduleName, action, params) => clientFor(resolvePanel(panelRef)).call(moduleName, action, params)

  const panelOps = (panelRef) => {
    const panel = resolvePanel(panelRef)
    const callOn = (moduleName, action, params) => clientFor(panel).call(moduleName, action, params)
    return {
      panel,
      system: () => callOn('system', 'GetSystemTotal'),
      load: () => callOn('system', 'GetLoadAverage'),
      disk: () => callOn('system', 'GetDiskInfo'),
      network: () => callOn('system', 'GetNetWork'),
      conf: () => callOn('system', 'GetConcifInfo'),
      async sites() {
        const payload = await callOn('data', 'getData', { table: 'sites', p: 1, limit: 200, type: -1, order: 'id desc' })
        return { items: normalizeSites(payload), total: pageTotal(payload?.page) ?? rows(payload).length }
      },
      async databases() {
        const payload = await callOn('data', 'getData', { table: 'databases', p: 1, limit: 200 })
        return { items: normalizeDatabases(payload), total: pageTotal(payload?.page) ?? rows(payload).length }
      },
      async logs(limit = 50) {
        const payload = await callOn('data', 'getData', { table: 'logs', p: 1, limit })
        return { items: normalizeLogs(payload), total: pageTotal(payload?.page) ?? rows(payload).length }
      },
      async services() {
        return normalizeServices(await callOn('system', 'GetConcifInfo'))
      },
      restartService: (serviceName) => callOn('system', 'ServiceAdmin', { name: serviceName, type: 'restart' }),
      siteAction: (action, params) => callOn('site', action, params),
      crontabList: async () => normalizeCrontab(await callOn('crontab', 'GetCrontab', { p: 1, limit: 200 })),
    }
  }

  /** Aggregated view for one panel; each source degrades on its own. */
  const overview = async (panelRef) => {
    const ops = panelOps(panelRef)
    const cacheKey = ops.panel.id
    const cached = overviewCaches.get(cacheKey)
    if (cached !== undefined && Date.now() - cached.at < 5000) return cached.value
    const settle = async (label, promise) => {
      try {
        return { ok: true, value: await promise }
      } catch (error) {
        return { ok: false, error: `${label}：${error instanceof Error ? error.message : String(error)}` }
      }
    }
    const [system, disk, sites, databases, services, load, network, conf] = await Promise.all([
      settle('系统状态', ops.system()),
      settle('磁盘', ops.disk()),
      settle('网站', ops.sites()),
      settle('数据库', ops.databases()),
      settle('服务', ops.services()),
      settle('负载', ops.load()),
      settle('网络', ops.network()),
      settle('面板信息', ops.conf()),
    ])
    const sys = system.ok ? system.value : undefined
    const disks = (disk.ok && Array.isArray(disk.value) ? disk.value : []).map((row) => {
      const size = Array.isArray(row.size) ? row.size : []
      return {
        path: row.path ?? '/',
        filesystem: row.filesystem ?? '',
        total: num(row.byte_size?.[0]) ?? 0,
        used: num(row.byte_size?.[1]) ?? 0,
        available: num(row.byte_size?.[2]) ?? 0,
        usedPercent: num(size[3]) ?? percent(row.byte_size?.[1], row.byte_size?.[0]) ?? 0,
        totalLabel: size[0] ?? '',
        usedLabel: size[1] ?? '',
      }
    })
    const eth = network.ok ? network.value?.network?.eth0 ?? Object.values(network.value?.network ?? {})[0] : undefined
    const value = {
      ok: system.ok || disk.ok || sites.ok,
      panel: { id: ops.panel.id, name: ops.panel.name, host: describePanel(ops.panel).panelHost },
      crawledAt: new Date().toISOString(),
      system: sys === undefined
        ? undefined
        : {
            cpuNum: num(sys.cpuNum),
            cpuUsedPercent: num(sys.cpuRealUsed),
            memTotal: num(sys.memTotal),
            memUsed: num(sys.memRealUsed),
            memUsedPercent: percent(sys.memRealUsed, sys.memTotal),
            memTotalLabel: sys.memNewTotal ?? '',
            memUsedLabel: sys.memNewRealUsed ?? '',
            system: sys.system ?? '',
            version: sys.version ?? '',
          },
      load: load.ok
        ? { one: num(load.value?.one), five: num(load.value?.five), fifteen: num(load.value?.fifteen), limit: num(load.value?.limit) }
        : undefined,
      network: eth === undefined ? undefined : { up: num(eth.up), down: num(eth.down), upTotal: num(eth.upTotal), downTotal: num(eth.downTotal) },
      stack: conf.ok
        ? { webserver: conf.value?.webserver ?? '', sitesPath: conf.value?.sites_path ?? '', backupPath: conf.value?.backup_path ?? '' }
        : undefined,
      disks,
      sites: sites.ok
        ? {
            total: sites.value.total,
            running: sites.value.items.filter((site) => site.status).length,
            items: sites.value.items.slice(0, 12),
          }
        : { error: sites.error, total: 0, running: 0, items: [] },
      databases: databases.ok
        ? { total: databases.value.total, items: databases.value.items.slice(0, 12) }
        : { error: databases.error, total: 0, items: [] },
      services: services.ok ? services.value : [],
      errors: [system, disk, sites, databases, services, load, network, conf]
        .filter((entry) => !entry.ok)
        .map((entry) => entry.error),
    }
    overviewCaches.set(cacheKey, { at: Date.now(), value })
    return value
  }

  /* ---------------- configuration writes ---------------- */

  const describeConfig = () => {
    const active = activeOf()
    return {
      panels: config.panels.map(describePanel),
      activePanel: active === undefined ? '' : active.id,
      showInSidebar: config.showInSidebar,
      configured: config.panels.some((panel) => describePanel(panel).configured),
    }
  }

  const writeRow = async (mutate) => {
    const editor = ctx.get('configEditor')
    const entry = ctx.fiber?.entry
    if (editor === undefined || entry === undefined) {
      return { ok: false, error: '当前 profile 不支持写入插件配置，请手动编辑 cordis.patch.yml' }
    }
    let written
    try {
      await editor.edit(entry, (current) => {
        written = mutate({ ...current })
        return written
      })
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Persist a new panel list; empty apiKey keeps the stored key of that panel. */
  const persistPanels = async (nextPanels, extra = {}) =>
    writeRow((current) => {
      const merged = nextPanels.map((panel) => {
        const previous = config.panels.find((candidate) => candidate.id === panel.id)
        const apiKey = panel.apiKey === '' && previous !== undefined ? previous.apiKey : panel.apiKey
        return {
          id: panel.id,
          name: panel.name === '' ? panel.panelUrl : panel.name,
          panelUrl: panel.panelUrl,
          apiKey,
          securityEntrance: panel.securityEntrance,
          verifyTls: panel.verifyTls,
        }
      })
      // Old rows carried a flat single-panel shape; drop those keys once a list exists.
      delete current.panelUrl
      delete current.apiKey
      delete current.securityEntrance
      delete current.verifyTls
      return { ...current, panels: merged, ...extra }
    })

  /* ---------------- Browser-facing Remote service ---------------- */

  ctx.inject(['typert'], (typertCtx) => {
    const service = {
      config: async () => describeConfig(),
      overview: async (panel) => overview(optionalString(panel)),
      sites: async (panel) => panelOps(optionalString(panel)).sites(),
      databases: async (panel) => panelOps(optionalString(panel)).databases(),
      services: async (panel) => ({ items: await panelOps(optionalString(panel)).services() }),
      refresh: async () => {
        overviewCaches.clear()
        return describeConfig()
      },
      saveSettings: async (settings) => {
        const patch = parseSettings(settings)
        if (Array.isArray(patch.panels)) {
          const result = await persistPanels(patch.panels, {
            ...(patch.activePanel === undefined ? {} : { activePanel: patch.activePanel }),
            ...(patch.showInSidebar === undefined ? {} : { showInSidebar: patch.showInSidebar }),
          })
          return result.ok ? { ...result, config: describeConfig() } : result
        }
        const result = await writeRow((current) => ({
          ...current,
          ...(patch.activePanel === undefined ? {} : { activePanel: patch.activePanel }),
          ...(patch.showInSidebar === undefined ? {} : { showInSidebar: patch.showInSidebar }),
        }))
        return result.ok ? { ...result, config: describeConfig() } : result
      },
    }
    // The Gateway resolves a Service through this visible binding; without it a
    // Remote call that is not claimed by a strict generated descriptor fails with
    // `Service "baota" has no visible typertRemote binding`.
    service.typertRemote = Object.freeze({ service, serviceKey: 'baota', namespace: 'baota' })
    typertCtx.provide('baota', service)
    typertCtx.typert.register({
      package: 'dsh-baota-panel',
      face: 'host',
      schemas: [],
      model: { services: [], events: [], objects: [] },
      invocations: BAOTA_DESCRIPTORS,
    })
  })

  /* ----------------------- Agent tools --------------------------- */

  const detail = (value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
  const asResult = () => ({ schema: { type: 'json' }, render: (_args, output) => detail(output) })
  const jsonSafe = (value) => JSON.parse(JSON.stringify(value ?? null))

  const tool = (options) =>
    ctx.tools.register(
      defineTool({
        ...options,
        async execute(args, exec) {
          return jsonSafe(await options.execute(args, exec))
        },
        output: asResult(),
      }),
    )

  const panelParam = { type: 'string', description: '面板 id 或名称；留空使用当前面板（bt_panels 可列出）。' }

  tool({
    name: 'bt_panels',
    description: 'List the Baota panels this plugin is configured for: id, name, host, and whether the address and API key are set.',
    parameters: {},
    async execute() {
      const active = activeOf()
      return { ok: true, activePanel: active === undefined ? '' : active.id, panels: config.panels.map(describePanel) }
    },
  })

  tool({
    name: 'bt_system',
    description:
      'Read one Baota panel host status: CPU/memory totals, disk usage, load average, network traffic, or the installed software stack. Call it before recommending any cleanup or restart.',
    parameters: {
      action: { type: 'string', required: true, description: 'overview (default summary), disk, load, network, panel (webserver, paths, installed software), or raw.' },
      panel: panelParam,
    },
    async execute(args) {
      const ops = panelOps(args.panel)
      switch (args.action) {
        case 'disk':
          return { ok: true, action: 'disk', panel: ops.panel.id, disk: await ops.disk() }
        case 'load':
          return { ok: true, action: 'load', panel: ops.panel.id, load: await ops.load() }
        case 'network':
          return { ok: true, action: 'network', panel: ops.panel.id, network: await ops.network() }
        case 'panel':
          return { ok: true, action: 'panel', panel: ops.panel.id, panelInfo: await ops.conf(), services: await ops.services() }
        case 'raw':
          return { ok: true, action: 'raw', panel: ops.panel.id, system: await ops.system() }
        default: {
          const summary = await overview(args.panel)
          return { ok: summary.ok, action: 'overview', panel: summary.panel, summary }
        }
      }
    },
  })

  tool({
    name: 'bt_site',
    description:
      'List, start, stop, delete websites on one Baota panel, or read one site\'s access log. `delete` removes the site record and its web server configuration; confirm the exact name with the user first.',
    parameters: {
      action: { type: 'string', required: true, description: 'list, start, stop, delete, or logs.' },
      id: { type: 'string', description: 'Site id from bt_site list (required for start/stop/delete).' },
      name: { type: 'string', description: 'Site name; used with id for delete, and alone for logs.' },
      limit: { type: 'integer', description: 'For logs: how many recent lines to return (default 200).' },
      panel: panelParam,
    },
    async execute(args) {
      const ops = panelOps(args.panel)
      if (args.action === 'list') return { ok: true, panel: ops.panel.id, ...(await ops.sites()) }
      if (args.action === 'logs') {
        if (!args.name) throw new Error('logs 需要站点名')
        const limit = Number.isFinite(args.limit) ? Math.min(Math.max(args.limit, 10), 2000) : 200
        const payload = await ops.siteAction('GetSiteLogs', { siteName: args.name, limit })
        const text = typeof payload?.msg === 'string' ? payload.msg : ''
        // The panel ignores `limit` and returns the whole log; keep the tail only.
        const lines = text.split(/\r?\n/).filter((line) => line !== '')
        const tail = lines.slice(-limit).join('\n')
        const clipped = tail.length > MAX_LOG_CHARS ? tail.slice(-MAX_LOG_CHARS) : tail
        return {
          ok: payload?.status !== false,
          panel: ops.panel.id,
          site: args.name,
          returnedLines: lines.slice(-limit).length,
          totalLines: lines.length,
          truncated: lines.length > limit || tail.length > MAX_LOG_CHARS,
          log: clipped,
        }
      }
      if (args.id === undefined || args.id === '') throw new Error(`${args.action} 需要站点 id，请先调用 bt_site list`)
      if (args.action === 'start' || args.action === 'stop') {
        const result = await ops.siteAction(args.action === 'start' ? 'SiteStart' : 'SiteStop', { id: args.id })
        return { ok: true, panel: ops.panel.id, result }
      }
      if (args.action === 'delete') {
        if (!args.name) throw new Error('delete 需要站点名（webname）')
        const result = await ops.siteAction('DeleteSite', { id: args.id, webname: args.name })
        return { ok: true, panel: ops.panel.id, result }
      }
      throw new Error(`未知操作 ${args.action}`)
    },
  })

  tool({
    name: 'bt_database',
    description: 'List or delete databases on one Baota panel. Deleting a database drops it; confirm with the user first.',
    parameters: {
      action: { type: 'string', required: true, description: 'list or delete.' },
      name: { type: 'string', description: 'Database name (required for delete).' },
      id: { type: 'string', description: 'Database id from bt_database list.' },
      panel: panelParam,
    },
    async execute(args) {
      const ops = panelOps(args.panel)
      if (args.action === 'list') return { ok: true, panel: ops.panel.id, ...(await ops.databases()) }
      if (args.action === 'delete') {
        if (!args.name) throw new Error('delete 需要数据库名')
        const result = await call(args.panel, 'database', 'DeleteDatabase', { name: args.name, id: args.id ?? '' })
        return { ok: true, panel: ops.panel.id, result }
      }
      throw new Error(`未知操作 ${args.action}`)
    },
  })

  tool({
    name: 'bt_file',
    description:
      'Browse and edit files on one panel server: list a directory, read a text file, write a text file, create a directory, or delete a path. Paths are absolute, for example /www/wwwroot/site/index.html.',
    parameters: {
      action: { type: 'string', required: true, description: 'list, read, write, mkdir, or delete.' },
      path: { type: 'string', required: true, description: 'Absolute path on the panel server.' },
      content: { type: 'string', description: 'File body for write.' },
      panel: panelParam,
    },
    async execute(args) {
      const panel = resolvePanel(args.panel)
      const onPanel = (moduleName, action, params) => clientFor(panel).call(moduleName, action, params)
      switch (args.action) {
        case 'list':
          return { ok: true, panel: panel.id, path: args.path, listing: await onPanel('files', 'GetDirNew', { path: args.path, p: 1, showRow: 200, limit: 200 }) }
        case 'read': {
          const payload = await onPanel('files', 'GetFileBody', { path: args.path })
          const text = typeof payload?.data === 'string' ? payload.data : ''
          const truncated = text.length > MAX_FILE_CHARS
          return {
            ok: true,
            panel: panel.id,
            path: args.path,
            size: payload?.size,
            encoding: payload?.encoding ?? 'utf-8',
            truncated,
            content: truncated ? text.slice(0, MAX_FILE_CHARS) : text,
          }
        }
        case 'write':
          return {
            ok: true,
            panel: panel.id,
            path: args.path,
            result: await onPanel('files', 'SaveFileBody', { path: args.path, data: args.content ?? '', encoding: 'utf-8' }),
          }
        case 'mkdir':
          return { ok: true, panel: panel.id, path: args.path, result: await onPanel('files', 'CreateDir', { path: args.path }) }
        case 'delete':
          return { ok: true, panel: panel.id, path: args.path, result: await onPanel('files', 'DeleteFile', { path: args.path }) }
        default:
          throw new Error(`未知操作 ${args.action}`)
      }
    },
  })

  tool({
    name: 'bt_crontab',
    description: 'List, add, or delete scheduled tasks (crontab) on one Baota panel.',
    parameters: {
      action: { type: 'string', required: true, description: 'list, add, or delete.' },
      id: { type: 'string', description: 'Task id from bt_crontab list (delete).' },
      name: { type: 'string', description: 'Task name (add).' },
      type: { type: 'string', description: 'Task type for add: day, hour, minute, week, or month (default day).' },
      where1: { type: 'string', description: 'Schedule expression, for example 3 for 03:00 in type=day.' },
      sBody: { type: 'string', description: 'Shell command or URL to run (add).' },
      sType: { type: 'string', description: 'Shell (default) or Url for add.' },
      panel: panelParam,
    },
    async execute(args) {
      const ops = panelOps(args.panel)
      if (args.action === 'list') return { ok: true, panel: ops.panel.id, crontab: await ops.crontabList() }
      if (args.action === 'delete') {
        if (!args.id) throw new Error('delete 需要任务 id')
        return { ok: true, panel: ops.panel.id, result: await call(args.panel, 'crontab', 'DelCrontab', { id: args.id }) }
      }
      if (args.action === 'add') {
        const result = await call(args.panel, 'crontab', 'AddCrontab', {
          name: args.name ?? 'dsh task',
          type: args.type ?? 'day',
          where1: args.where1 ?? '3',
          sType: args.sType ?? 'Shell',
          sBody: args.sBody ?? '',
          save: 1,
          backupTo: 'localhost',
        })
        return { ok: true, panel: ops.panel.id, result }
      }
      throw new Error(`未知操作 ${args.action}`)
    },
  })

  tool({
    name: 'bt_firewall',
    description:
      'Inspect or change firewall rules on one Baota panel: list current rules, open a TCP port, or close one. Some panel builds only serve these routes to a logged-in browser session; the panel message is returned unchanged in that case.',
    parameters: {
      action: { type: 'string', required: true, description: 'list, allow (open a port), or deny (close a port).' },
      port: { type: 'string', description: 'Port or range such as 8080 or 3000-3010.' },
      ps: { type: 'string', description: 'Rule remark.' },
      id: { type: 'string', description: 'Rule id from bt_firewall list (deny).' },
      panel: panelParam,
    },
    async execute(args) {
      const panel = resolvePanel(args.panel)
      if (args.action === 'list') {
        return { ok: true, panel: panel.id, rules: await clientFor(panel).call('firewall', 'GetList', { p: 1, limit: 200 }) }
      }
      if (args.action === 'allow') {
        if (!args.port) throw new Error('allow 需要端口号')
        return { ok: true, panel: panel.id, result: await clientFor(panel).call('firewall', 'AddAcceptPort', { port: args.port, ps: args.ps ?? 'dsh-baota-panel', type: 'accept' }) }
      }
      if (args.action === 'deny') {
        if (!args.port) throw new Error('deny 需要端口号')
        return { ok: true, panel: panel.id, result: await clientFor(panel).call('firewall', 'DelAcceptPort', { port: args.port, id: args.id ?? '', type: 'accept' }) }
      }
      throw new Error(`未知操作 ${args.action}`)
    },
  })

  tool({
    name: 'bt_service',
    description: 'List the installed software stack of one panel (web server, MySQL, PHP) and restart one of its services.',
    parameters: {
      action: { type: 'string', required: true, description: 'list or restart.' },
      name: { type: 'string', description: 'Service name, for example nginx, mysql, or php-82.' },
      panel: panelParam,
    },
    async execute(args) {
      const ops = panelOps(args.panel)
      if (args.action === 'list') return { ok: true, panel: ops.panel.id, services: await ops.services() }
      if (args.action === 'restart') {
        if (!args.name) throw new Error('restart 需要服务名')
        const name = String(args.name).startsWith('php-') ? 'php-fpm' : args.name
        return { ok: true, panel: ops.panel.id, service: name, result: await ops.restartService(name) }
      }
      throw new Error(`未知操作 ${args.action}`)
    },
  })

  tool({
    name: 'bt_logs',
    description: 'Read one panel\'s operation log (who did what, newest first) — useful for auditing recent changes.',
    parameters: {
      limit: { type: 'integer', description: 'How many entries to return; defaults to 30.' },
      panel: panelParam,
    },
    async execute(args) {
      const ops = panelOps(args.panel)
      const limit = Number.isFinite(args.limit) ? Math.min(Math.max(args.limit, 1), 200) : 30
      return { ok: true, panel: ops.panel.id, ...(await ops.logs(limit)) }
    },
  })

  tool({
    name: 'bt_config',
    description:
      'Manage the panels this plugin connects to and whether the sidebar entry shows. Actions: list, add, update, remove, activate, sidebar.',
    parameters: {
      action: { type: 'string', required: true, description: 'list, add, update, remove, activate, or sidebar.' },
      panel: { type: 'string', description: 'Panel id or name for update/remove/activate.' },
      name: { type: 'string', description: 'Display name for the panel.' },
      panelUrl: { type: 'string', description: 'Panel root address including the port, for example https://panel.example.com:4439' },
      apiKey: { type: 'string', description: '面板设置 → API 接口 → 接口密钥. Omit or leave empty to keep the stored key.' },
      securityEntrance: { type: 'string', description: 'Optional 安全入口, for example ghostxx' },
      verifyTls: { type: 'boolean', description: 'Verify the panel certificate; the panel is self-signed by default.' },
      showInSidebar: { type: 'boolean', description: 'Whether the 宝塔面板 entry appears in the sidebar panel list (sidebar action only).' },
    },
    async execute(args) {
      switch (args.action) {
        case 'list':
          return { ok: true, ...describeConfig() }
        case 'add': {
          if (!args.panelUrl) throw new Error('add 需要 panelUrl')
          const id = slug(args.name ?? '', `panel-${config.panels.length + 1}`)
          const next = [
            ...config.panels,
            {
              id,
              name: args.name ?? args.panelUrl,
              panelUrl: args.panelUrl.trim().replace(/\/+$/, ''),
              apiKey: args.apiKey ?? '',
              securityEntrance: args.securityEntrance ?? '',
              verifyTls: args.verifyTls === true,
            },
          ]
          const result = await persistPanels(next, config.activePanel === '' ? { activePanel: id } : {})
          return { ...result, panelId: id }
        }
        case 'update': {
          const target = resolvePanel(args.panel)
          const next = config.panels.map((current) =>
            current.id === target.id
              ? {
                  ...current,
                  name: args.name ?? current.name,
                  panelUrl: args.panelUrl === undefined ? current.panelUrl : args.panelUrl.trim().replace(/\/+$/, ''),
                  apiKey: args.apiKey ?? '',
                  securityEntrance: args.securityEntrance ?? current.securityEntrance,
                  verifyTls: args.verifyTls === undefined ? current.verifyTls : args.verifyTls === true,
                }
              : current,
          )
          return { ...(await persistPanels(next)), panelId: target.id }
        }
        case 'remove': {
          const target = resolvePanel(args.panel)
          const next = config.panels.filter((current) => current.id !== target.id)
          const extra = config.activePanel === target.id ? { activePanel: next[0]?.id ?? '' } : {}
          return { ...(await persistPanels(next, extra)), removed: target.id }
        }
        case 'activate': {
          const target = resolvePanel(args.panel)
          const result = await writeRow((current) => ({ ...current, activePanel: target.id }))
          return { ...result, activePanel: target.id }
        }
        case 'sidebar': {
          if (typeof args.showInSidebar !== 'boolean') throw new Error('sidebar 需要 showInSidebar 布尔值')
          const result = await writeRow((current) => ({ ...current, showInSidebar: args.showInSidebar }))
          return { ...result, showInSidebar: args.showInSidebar }
        }
        default:
          throw new Error(`未知操作 ${args.action}`)
      }
    },
  })

  tool({
    name: 'bt_api',
    description:
      'Call any Baota panel API action directly when no other bt_* tool covers it. Example: module "site", action "GetSiteDomains", params {"id":1}. Use bt_system/bt_site/... first.',
    parameters: {
      module: { type: 'string', required: true, description: 'Panel module, for example system, site, database, files, crontab, firewall, config, data.' },
      action: { type: 'string', required: true, description: 'Panel action name, for example GetSystemTotal.' },
      params: { type: 'json', description: 'Extra form parameters as an object.' },
      panel: panelParam,
    },
    async execute(args) {
      const params = args.params !== null && typeof args.params === 'object' ? args.params : {}
      const panel = resolvePanel(args.panel)
      const data = await clientFor(panel).call(String(args.module).replace(/^\/+/, ''), String(args.action), params)
      return { ok: true, panel: panel.id, module: args.module, action: args.action, data }
    },
  })

  ctx.effect(() => () => {
    overviewCaches.clear()
    clients.clear()
  }, 'dsh-baota-panel: cache reset')

  return { remote: BAOTA_REMOTE }
}
