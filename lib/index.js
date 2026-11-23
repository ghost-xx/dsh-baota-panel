/**
 * Host half of dsh-baota-panel.
 *
 * Two faces over one set of panel operations:
 *  - Agent tools (`ctx.tools`) so the model can inspect and change the panel.
 *  - A `baota` Host service exposed to the browser half through the typert
 *    Remote channel (`ctx.remote.baota.*`), which drives the sidebar panel.
 *
 * Endpoint notes (verified against Baota Linux panel 13.x):
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

const parseSettings = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a settings object')
  const out = {}
  if (typeof value.showInSidebar === 'boolean') out.showInSidebar = value.showInSidebar
  if (typeof value.verifyTls === 'boolean') out.verifyTls = value.verifyTls
  if (typeof value.panelUrl === 'string' && value.panelUrl.trim() !== '') out.panelUrl = value.panelUrl.trim()
  if (typeof value.apiKey === 'string' && value.apiKey.trim() !== '') out.apiKey = value.apiKey.trim()
  if (typeof value.securityEntrance === 'string') out.securityEntrance = value.securityEntrance.trim()
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
  remoteMethod('overview'),
  remoteMethod('sites'),
  remoteMethod('databases'),
  remoteMethod('services'),
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
/* Plugin                                                              */
/* ------------------------------------------------------------------ */

export function apply(ctx, rawConfig = {}) {
  const config = {
    panelUrl: String(rawConfig.panelUrl ?? ''),
    apiKey: String(rawConfig.apiKey ?? ''),
    securityEntrance: String(rawConfig.securityEntrance ?? ''),
    verifyTls: rawConfig.verifyTls === true,
    showInSidebar: rawConfig.showInSidebar !== false,
    requestTimeoutMs: Number.isFinite(rawConfig.requestTimeoutMs) ? rawConfig.requestTimeoutMs : 20000,
  }
  const client = new BaotaClient(config)
  let overviewCache = { at: 0, value: undefined }

  const call = (moduleName, action, params) => client.call(moduleName, action, params)

  const panel = {
    async system() {
      return call('system', 'GetSystemTotal')
    },
    async load() {
      return call('system', 'GetLoadAverage')
    },
    async disk() {
      return call('system', 'GetDiskInfo')
    },
    async network() {
      return call('system', 'GetNetWork')
    },
    async conf() {
      return call('system', 'GetConcifInfo')
    },
    async sites() {
      const payload = await call('data', 'getData', { table: 'sites', p: 1, limit: 200, type: -1, order: 'id desc' })
      return { items: normalizeSites(payload), total: pageTotal(payload?.page) ?? rows(payload).length }
    },
    async databases() {
      const payload = await call('data', 'getData', { table: 'databases', p: 1, limit: 200 })
      return { items: normalizeDatabases(payload), total: pageTotal(payload?.page) ?? rows(payload).length }
    },
    async logs(limit = 50) {
      const payload = await call('data', 'getData', { table: 'logs', p: 1, limit })
      return { items: normalizeLogs(payload), total: pageTotal(payload?.page) ?? rows(payload).length }
    },
    async services() {
      return normalizeServices(await panel.conf())
    },
    async restartService(serviceName) {
      return call('system', 'ServiceAdmin', { name: serviceName, type: 'restart' })
    },
    async siteAction(action, params) {
      return call('site', action, params)
    },
    async crontabList() {
      const payload = await call('crontab', 'GetCrontab', { p: 1, limit: 200 })
      return normalizeCrontab(payload)
    },
  }

  /** Aggregated view for the sidebar panel; each source degrades on its own. */
  const overview = async () => {
    if (overviewCache.value !== undefined && Date.now() - overviewCache.at < 5000) return overviewCache.value
    const settle = async (label, promise) => {
      try {
        return { ok: true, value: await promise }
      } catch (error) {
        return { ok: false, error: `${label}：${error instanceof Error ? error.message : String(error)}` }
      }
    }
    const [system, disk, sites, databases, services, load, network, conf] = await Promise.all([
      settle('系统状态', panel.system()),
      settle('磁盘', panel.disk()),
      settle('网站', panel.sites()),
      settle('数据库', panel.databases()),
      settle('服务', panel.services()),
      settle('负载', panel.load()),
      settle('网络', panel.network()),
      settle('面板信息', panel.conf()),
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
    const result = {
      ok: system.ok || disk.ok || sites.ok,
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
      panel: conf.ok
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
    overviewCache = { at: Date.now(), value: result }
    return result
  }

  const saveSettings = async (patch) => {
    const editor = ctx.get('configEditor')
    const entry = ctx.fiber?.entry
    if (editor === undefined || entry === undefined) {
      return { ok: false, error: '当前 profile 不支持写入插件配置，请手动编辑 cordis.patch.yml' }
    }
    try {
      await editor.edit(entry, (current) => ({ ...current, ...patch }))
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  const describeConfig = () => ({
    panelUrl: config.panelUrl,
    panelHost: (() => {
      try {
        return new URL(config.panelUrl).host
      } catch {
        return ''
      }
    })(),
    hasApiKey: config.apiKey !== '',
    apiKeyTail: config.apiKey === '' ? '' : config.apiKey.slice(-4),
    securityEntrance: config.securityEntrance,
    verifyTls: config.verifyTls,
    showInSidebar: config.showInSidebar,
    configured: client.configured,
  })

  /* ---------------- Browser-facing Remote service ---------------- */

  ctx.inject(['typert'], (typertCtx) => {
    const service = {
      config: async () => describeConfig(),
      overview,
      sites: async () => panel.sites(),
      databases: async () => panel.databases(),
      services: async () => ({ items: await panel.services() }),
      refresh: async () => {
        overviewCache = { at: 0, value: undefined }
        return describeConfig()
      },
      saveSettings: async (settings) => saveSettings(parseSettings(settings)),
    }
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

  /** Tool results must be lossless JSON: drop undefined and non-finite numbers. */
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

  tool({
    name: 'bt_system',
    description:
      'Read Baota panel host status: CPU/memory totals, disk usage, load average, network traffic, or the installed software stack. Call it before recommending any cleanup or restart.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        description: 'overview (default summary), disk, load, network, panel (webserver, paths, installed software), or raw.',
      },
    },
    async execute(args) {
      switch (args.action) {
        case 'disk':
          return { ok: true, action: 'disk', disk: await panel.disk() }
        case 'load':
          return { ok: true, action: 'load', load: await panel.load() }
        case 'network':
          return { ok: true, action: 'network', network: await panel.network() }
        case 'panel':
          return { ok: true, action: 'panel', panel: await panel.conf(), services: await panel.services() }
        case 'raw':
          return { ok: true, action: 'raw', system: await panel.system() }
        default: {
          const summary = await overview()
          return { ok: summary.ok, action: 'overview', summary }
        }
      }
    },
  })

  tool({
    name: 'bt_site',
    description:
      'List, start, stop, delete websites in the Baota panel, or read one site\'s access log. `delete` removes the site record and its web server configuration; confirm the exact name with the user first.',
    parameters: {
      action: { type: 'string', required: true, description: 'list, start, stop, delete, or logs.' },
      id: { type: 'string', description: 'Site id from bt_site list (required for start/stop/delete).' },
      name: { type: 'string', description: 'Site name; used with id for delete, and alone for logs.' },
      limit: { type: 'integer', description: 'For logs: how many recent lines to return (default 300).' },
    },
    async execute(args) {
      if (args.action === 'list') return { ok: true, ...(await panel.sites()) }
      if (args.action === 'logs') {
        if (!args.name) throw new Error('logs 需要站点名')
        const limit = Number.isFinite(args.limit) ? Math.min(Math.max(args.limit, 10), 2000) : 200
        const payload = await call('site', 'GetSiteLogs', { siteName: args.name, limit })
        const text = typeof payload?.msg === 'string' ? payload.msg : ''
        // The panel ignores `limit` and returns the whole log; keep the tail only.
        const lines = text.split(/\r?\n/).filter((line) => line !== '')
        const tail = lines.slice(-limit).join('\n')
        const clipped = tail.length > MAX_LOG_CHARS ? tail.slice(-MAX_LOG_CHARS) : tail
        return {
          ok: payload?.status !== false,
          site: args.name,
          returnedLines: lines.slice(-limit).length,
          totalLines: lines.length,
          truncated: lines.length > limit || tail.length > MAX_LOG_CHARS,
          log: clipped,
        }
      }
      if (args.id === undefined || args.id === '') throw new Error(`${args.action} 需要站点 id，请先调用 bt_site list`)
      if (args.action === 'start' || args.action === 'stop') {
        const result = await panel.siteAction(args.action === 'start' ? 'SiteStart' : 'SiteStop', { id: args.id })
        return { ok: true, result }
      }
      if (args.action === 'delete') {
        if (!args.name) throw new Error('delete 需要站点名（webname）')
        const result = await panel.siteAction('DeleteSite', { id: args.id, webname: args.name })
        return { ok: true, result }
      }
      throw new Error(`未知操作 ${args.action}`)
    },
  })

  tool({
    name: 'bt_database',
    description: 'List or delete databases managed by the Baota panel. Deleting a database drops it; confirm with the user first.',
    parameters: {
      action: { type: 'string', required: true, description: 'list or delete.' },
      name: { type: 'string', description: 'Database name (required for delete).' },
      id: { type: 'string', description: 'Database id from bt_database list.' },
    },
    async execute(args) {
      if (args.action === 'list') return { ok: true, ...(await panel.databases()) }
      if (args.action === 'delete') {
        if (!args.name) throw new Error('delete 需要数据库名')
        const result = await call('database', 'DeleteDatabase', { name: args.name, id: args.id ?? '' })
        return { ok: true, result }
      }
      throw new Error(`未知操作 ${args.action}`)
    },
  })

  tool({
    name: 'bt_file',
    description:
      'Browse and edit files on the panel server: list a directory, read a text file, write a text file, create a directory, or delete a path. Paths are absolute, for example /www/wwwroot/site/index.html.',
    parameters: {
      action: { type: 'string', required: true, description: 'list, read, write, mkdir, or delete.' },
      path: { type: 'string', required: true, description: 'Absolute path on the panel server.' },
      content: { type: 'string', description: 'File body for write.' },
    },
    async execute(args) {
      switch (args.action) {
        case 'list':
          return { ok: true, path: args.path, listing: await call('files', 'GetDirNew', { path: args.path, p: 1, showRow: 200, limit: 200 }) }
        case 'read': {
          const payload = await call('files', 'GetFileBody', { path: args.path })
          const text = typeof payload?.data === 'string' ? payload.data : ''
          const truncated = text.length > MAX_FILE_CHARS
          return {
            ok: true,
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
            path: args.path,
            result: await call('files', 'SaveFileBody', { path: args.path, data: args.content ?? '', encoding: 'utf-8' }),
          }
        case 'mkdir':
          return { ok: true, path: args.path, result: await call('files', 'CreateDir', { path: args.path }) }
        case 'delete':
          return { ok: true, path: args.path, result: await call('files', 'DeleteFile', { path: args.path }) }
        default:
          throw new Error(`未知操作 ${args.action}`)
      }
    },
  })

  tool({
    name: 'bt_crontab',
    description: 'List, add, or delete Baota panel scheduled tasks (crontab).',
    parameters: {
      action: { type: 'string', required: true, description: 'list, add, or delete.' },
      id: { type: 'string', description: 'Task id from bt_crontab list (delete).' },
      name: { type: 'string', description: 'Task name (add).' },
      type: { type: 'string', description: 'Task type for add: day, hour, minute, week, or month (default day).' },
      where1: { type: 'string', description: 'Schedule expression, for example 3 for 03:00 in type=day.' },
      sBody: { type: 'string', description: 'Shell command or URL to run (add).' },
      sType: { type: 'string', description: 'Shell (default) or Url for add.' },
    },
    async execute(args) {
      if (args.action === 'list') return { ok: true, crontab: await panel.crontabList() }
      if (args.action === 'delete') {
        if (!args.id) throw new Error('delete 需要任务 id')
        return { ok: true, result: await call('crontab', 'DelCrontab', { id: args.id }) }
      }
      if (args.action === 'add') {
        const result = await call('crontab', 'AddCrontab', {
          name: args.name ?? 'dsh task',
          type: args.type ?? 'day',
          where1: args.where1 ?? '3',
          sType: args.sType ?? 'Shell',
          sBody: args.sBody ?? '',
          save: 1,
          backupTo: 'localhost',
        })
        return { ok: true, result }
      }
      throw new Error(`未知操作 ${args.action}`)
    },
  })

  tool({
    name: 'bt_firewall',
    description:
      'Inspect or change Baota panel firewall rules: list current rules, open a TCP port, or close one. Some panel builds only serve these routes to a logged-in browser session; the panel message is returned unchanged in that case.',
    parameters: {
      action: { type: 'string', required: true, description: 'list, allow (open a port), or deny (close a port).' },
      port: { type: 'string', description: 'Port or range such as 8080 or 3000-3010.' },
      ps: { type: 'string', description: 'Rule remark.' },
      id: { type: 'string', description: 'Rule id from bt_firewall list (deny).' },
    },
    async execute(args) {
      if (args.action === 'list') return { ok: true, rules: await call('firewall', 'GetList', { p: 1, limit: 200 }) }
      if (args.action === 'allow') {
        if (!args.port) throw new Error('allow 需要端口号')
        return { ok: true, result: await call('firewall', 'AddAcceptPort', { port: args.port, ps: args.ps ?? 'dsh-baota-panel', type: 'accept' }) }
      }
      if (args.action === 'deny') {
        if (!args.port) throw new Error('deny 需要端口号')
        return { ok: true, result: await call('firewall', 'DelAcceptPort', { port: args.port, id: args.id ?? '', type: 'accept' }) }
      }
      throw new Error(`未知操作 ${args.action}`)
    },
  })

  tool({
    name: 'bt_service',
    description: 'List the installed software stack (web server, MySQL, PHP) and restart one of its services.',
    parameters: {
      action: { type: 'string', required: true, description: 'list or restart.' },
      name: { type: 'string', description: 'Service name, for example nginx, mysql, or php-82.' },
    },
    async execute(args) {
      if (args.action === 'list') return { ok: true, services: await panel.services() }
      if (args.action === 'restart') {
        if (!args.name) throw new Error('restart 需要服务名')
        const name = String(args.name).startsWith('php-') ? 'php-fpm' : args.name
        return { ok: true, service: name, result: await panel.restartService(name) }
      }
      throw new Error(`未知操作 ${args.action}`)
    },
  })

  tool({
    name: 'bt_logs',
    description: 'Read the panel operation log (who did what, newest first) — useful for auditing recent changes.',
    parameters: {
      limit: { type: 'integer', description: 'How many entries to return; defaults to 30.' },
    },
    async execute(args) {
      const limit = Number.isFinite(args.limit) ? Math.min(Math.max(args.limit, 1), 200) : 30
      return { ok: true, ...(await panel.logs(limit)) }
    },
  })

  tool({
    name: 'bt_config',
    description:
      'Read or change this plugin\'s Baota panel settings: action "show" reports the panel address, key state and sidebar switch; action "set" saves new values into the profile.',
    parameters: {
      action: { type: 'string', required: true, description: 'show or set.' },
      panelUrl: { type: 'string', description: 'Panel root address including the port, for example https://panel.example.com:4439' },
      apiKey: { type: 'string', description: '面板设置 → API 接口 → 接口密钥' },
      securityEntrance: { type: 'string', description: 'Optional 安全入口, for example ghostxx' },
      verifyTls: { type: 'boolean', description: 'Verify the panel certificate; the panel is self-signed by default.' },
      showInSidebar: { type: 'boolean', description: 'Whether the 宝塔面板 entry appears in the sidebar panel list.' },
    },
    async execute(args) {
      if (args.action === 'show') return { ok: true, config: describeConfig() }
      if (args.action === 'set') {
        const patch = parseSettings({
          panelUrl: args.panelUrl,
          apiKey: args.apiKey,
          securityEntrance: args.securityEntrance,
          verifyTls: args.verifyTls,
          showInSidebar: args.showInSidebar,
        })
        if (Object.keys(patch).length === 0) throw new Error('set 需要至少一个新值')
        const result = await saveSettings(patch)
        return { ok: result.ok === true, saved: patch, error: result.error }
      }
      throw new Error(`未知操作 ${args.action}`)
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
    },
    async execute(args) {
      const params = args.params !== null && typeof args.params === 'object' ? args.params : {}
      const data = await call(String(args.module).replace(/^\/+/, ''), String(args.action), params)
      return { ok: true, module: args.module, action: args.action, data }
    },
  })

  ctx.effect(() => () => {
    overviewCache = { at: 0, value: undefined }
  }, 'dsh-baota-panel: cache reset')

  return { remote: BAOTA_REMOTE }
}
